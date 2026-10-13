"""Shared HTTP client with browser headers, retries and TTL caching.

Two backends:
  - httpx-based Http for AniList GraphQL queries (public API, no Cloudflare).
  - curl_cffi-based pipe for the Miruro secure/pipe tunnel (Cloudflare-bot
    bypass via Chrome TLS fingerprint impersonation).

The provider (miruro.tv) sits behind Cloudflare on its pipe endpoint;
catalog data comes from the public AniList GraphQL API instead.
"""

from __future__ import annotations

import asyncio
import base64
import gzip
import json
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
from curl_cffi.requests import AsyncSession


# Miruro obfuscation key: catalog API responses are gzip-compressed JSON,
# XOR-encoded with this repeating key ("application/octet-stream").
MIRURO_OBF_KEY = b"miruro/catalog"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

MIRURO_BASE = "https://www.miruro.tv"
MIRURO_PIPE_URL = f"{MIRURO_BASE}/api/secure/pipe"
MIRURO_API_BASE = f"{MIRURO_BASE}/api/v1"
ANILIST_API = "https://graphql.anilist.co"

MIRURO_HEADERS = {
    "User-Agent": USER_AGENT,
    "Referer": f"{MIRURO_BASE}/",
    "Origin": MIRURO_BASE,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
}


class ProviderError(Exception):
    """Upstream failure (network, non-200, blocked)."""


class UpstreamBlocked(ProviderError):
    """Cloudflare challenge page detected — provider is refusing bots."""


class PipeError(ProviderError):
    """Miruro pipe tunnel failure."""


class NotFoundError(Exception):
    """The requested anime/episode does not exist upstream."""


def browser_headers(referer: str | None = None) -> dict[str, str]:
    """Header set that mirrors a plain browser visit."""
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/json,*/*",
        "Accept-Language": "en-US,en;q=0.9",
    }
    headers["Referer"] = referer or f"{MIRURO_BASE}/"
    return headers


def _encode_pipe_request(payload: dict) -> str:
    """Base64-url-encode a pipe request payload (no padding)."""
    return base64.urlsafe_b64encode(
        json.dumps(payload).encode()
    ).decode().rstrip("=")


def _decode_pipe_response(encoded: str) -> dict:
    """Decode a Miruro pipe response: base64url → gzip → json."""
    try:
        # restore padding
        pad = 4 - len(encoded) % 4
        if pad != 4:
            encoded += "=" * pad
        compressed = base64.urlsafe_b64decode(encoded)
        return json.loads(gzip.decompress(compressed).decode("utf-8"))
    except Exception as exc:
        raise PipeError(f"failed to decode pipe response: {exc}") from exc


def looks_blocked(body: str) -> bool:
    """Detect Cloudflare 'Just a moment...' challenge pages."""
    return "just a moment" in body.lower()


@dataclass
class _Entry:
    value: Any
    expires_at: float


@dataclass
class TtlCache:
    """Tiny LRU-ish TTL cache (insertion-order eviction)."""

    ttl: float
    max_entries: int = 256
    _store: dict[str, _Entry] = field(default_factory=dict)

    def get(self, key: str) -> Any | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        if time.monotonic() > entry.expires_at:
            del self._store[key]
            return None
        return entry.value

    def set(self, key: str, value: Any) -> None:
        if len(self._store) >= self.max_entries:
            oldest = next(iter(self._store))
            del self._store[oldest]
        self._store[key] = _Entry(value=value, expires_at=time.monotonic() + self.ttl)

    async def wrap(self, key: str, fn):
        cached = self.get(key)
        if cached is not None:
            return cached
        value = await fn()
        self.set(key, value)
        return value


class Http:
    """One async client per app; call :meth:`aclose` on shutdown.

    Uses httpx for AniList GraphQL and curl_cffi for the Miruro pipe.
    """

    def __init__(self, timeout: float = 15.0, retries: int = 2) -> None:
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=8.0),
            follow_redirects=True,
            headers=browser_headers(),
            http2=False,
        )
        # curl_cffi session for the Cloudflare-protected pipe endpoint
        self._cf_session: AsyncSession | None = None
        self._retries = retries
        self.html_cache = TtlCache(ttl=600)
        self.json_cache = TtlCache(ttl=300)

    async def _ensure_cf_session(self) -> AsyncSession:
        if self._cf_session is None:
            self._cf_session = AsyncSession(impersonate="chrome124")
        return self._cf_session

    async def aclose(self) -> None:
        await self._client.aclose()
        if self._cf_session is not None:
            await self._cf_session.close()

    async def text(
        self,
        url: str,
        *,
        referer: str | None = None,
        use_cache: bool = True,
    ) -> str:
        """GET a URL, return the body as text. Retries transient failures."""

        async def fetch() -> str:
            last_exc: Exception | None = None
            for attempt in range(self._retries + 1):
                if attempt:
                    await asyncio.sleep(0.6 * attempt)
                try:
                    resp = await self._client.get(
                        url, headers=browser_headers(referer)
                    )
                    if resp.status_code in (404, 410):
                        raise NotFoundError(f"upstream 404 for {url}")
                    if resp.status_code == 403:
                        raise UpstreamBlocked(f"upstream 403 for {url}")
                    resp.raise_for_status()
                    body = resp.text
                    if looks_blocked(body):
                        raise UpstreamBlocked(f"cloudflare challenge for {url}")
                    return body
                except (httpx.TimeoutException, httpx.TransportError) as exc:
                    last_exc = exc
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code >= 500:
                        last_exc = exc
                        continue
                    raise ProviderError(
                        f"upstream {exc.response.status_code} for {url}"
                    ) from exc
            raise ProviderError(f"upstream unreachable for {url}: {last_exc}")

        if use_cache:
            return await self.html_cache.wrap(f"text:{url}", fetch)
        return await fetch()

    async def json(
        self,
        url: str,
        *,
        referer: str | None = None,
        use_cache: bool = True,
    ) -> Any:
        """GET a URL and parse the body as JSON."""

        async def fetch() -> Any:
            body = await self.text(url, referer=referer, use_cache=False)
            try:
                return json.loads(body)
            except ValueError as exc:
                raise ProviderError(f"non-JSON response from {url}") from exc

        if use_cache:
            return await self.json_cache.wrap(f"json:{url}", fetch)
        return await fetch()

    async def anilist_query(self, query: str, variables: dict | None = None) -> dict:
        """Run a GraphQL query against the public AniList API."""
        body: dict[str, Any] = {"query": query}
        if variables:
            body["variables"] = variables
        resp = await self._client.post(
            ANILIST_API,
            json=body,
            headers={
                "User-Agent": USER_AGENT,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        if resp.status_code != 200:
            raise ProviderError(f"AniList query failed: {resp.status_code}")
        data = resp.json().get("data", {})
        if not data:
            raise NotFoundError("AniList returned no data")
        return data

    async def pipe(self, path: str, query: dict | None = None) -> dict:
        """Call the Miruro secure/pipe tunnel with a GET request.

        Parameters
        ----------
        path : str
            The pipe path, e.g. ``"episodes"`` or ``"watch/kiwi/178005/sub/..."``.
        query : dict or None
            Query parameters for the pipe (e.g. ``{"anilistId": 178005}``).
        """
        session = await self._ensure_cf_session()
        payload = {
            "path": path,
            "method": "GET",
            "query": query or {},
            "body": None,
            "version": "0.1.0",
        }
        encoded_req = _encode_pipe_request(payload)
        try:
            resp = await session.get(
                f"{MIRURO_PIPE_URL}?e={encoded_req}",
                headers=MIRURO_HEADERS,
            )
        except Exception as exc:
            raise PipeError(f"pipe request failed: {exc}") from exc

        if resp.status_code != 200:
            raise PipeError(
                f"pipe returned {resp.status_code}"
            )
        return _decode_pipe_response(resp.text.strip())

    async def miruro_api(
        self,
        path: str,
        query: dict | None = None,
        *,
        use_cache: bool = True,
    ) -> Any:
        """Call the Miruro catalog API (``/api/v1/...``) and decode the body.

        Miruro's catalog endpoints return ``application/octet-stream``: the
        JSON body is gzip-compressed and then XOR-encoded with the repeating
        key ``"miruro/catalog"``. Some responses skip the gzip step, so the
        decoder falls back to plain-JSON when gzip fails.
        """
        import urllib.parse

        qs = ""
        if query:
            clean = {k: v for k, v in query.items() if v is not None}
            if clean:
                qs = "?" + urllib.parse.urlencode(clean)
        url = f"{MIRURO_API_BASE}/{path.lstrip('/')}{qs}"

        async def fetch() -> Any:
            session = await self._ensure_cf_session()
            try:
                resp = await session.get(url, headers=MIRURO_HEADERS)
            except Exception as exc:
                raise PipeError(f"miruro api request failed: {exc}") from exc
            if resp.status_code == 404:
                raise NotFoundError(f"miruro has no entry for {url}")
            if resp.status_code != 200:
                raise PipeError(
                    f"miruro api returned {resp.status_code} for {url}"
                )
            try:
                xored = bytes(
                    b ^ MIRURO_OBF_KEY[i % len(MIRURO_OBF_KEY)]
                    for i, b in enumerate(resp.content)
                )
                try:
                    return json.loads(gzip.decompress(xored).decode("utf-8"))
                except (OSError, ValueError):
                    # not gzipped — the body is plain XOR-encoded JSON
                    return json.loads(xored.decode("utf-8"))
            except ValueError as exc:
                raise PipeError(f"failed to decode miruro api response: {exc}") from exc

        if use_cache:
            return await self.json_cache.wrap(f"miruro:{url}", fetch)
        return await fetch()