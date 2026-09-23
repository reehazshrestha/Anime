"""Shared HTTP client with browser headers, retries and TTL caching.

The provider (hianime.at) sits behind Cloudflare and checks Referer on its
static APIs; every request goes through here so the browser-ish header set is
consistent, transient 5xx/connection errors are retried, and hot paths
(search, episode lists) hit an in-process TTL cache instead of the wire.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

BASE = "https://hianime.at"


class ProviderError(Exception):
    """Upstream failure (network, non-200, blocked)."""


class UpstreamBlocked(ProviderError):
    """Cloudflare challenge page detected — provider is refusing bots."""


class NotFoundError(Exception):
    """The requested anime/episode does not exist upstream."""


def browser_headers(referer: str | None = None) -> dict[str, str]:
    """Header set that mirrors a plain browser visit."""
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/json,*/*",
        "Accept-Language": "en-US,en;q=0.9",
    }
    headers["Referer"] = referer or f"{BASE}/"
    return headers


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
    """One async client per app; call :meth:`aclose` on shutdown."""

    def __init__(self, timeout: float = 15.0, retries: int = 2) -> None:
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=8.0),
            follow_redirects=True,
            headers=browser_headers(),
            http2=False,
        )
        self._retries = retries
        self.html_cache = TtlCache(ttl=600)
        self.json_cache = TtlCache(ttl=300)

    async def aclose(self) -> None:
        await self._client.aclose()

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
                    # 5xx is transient; 4xx (other than handled) is not
                    if exc.response.status_code >= 500:
                        last_exc = exc
                        continue
                    raise ProviderError(f"upstream {exc.response.status_code} for {url}") from exc
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
