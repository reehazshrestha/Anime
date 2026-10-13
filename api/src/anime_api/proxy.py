"""HLS proxy: playlists, segments and subtitles flow through the API.

The upstream video CDN 403s without the embed site's Referer and sends no
CORS headers, so every stream URL is routed through ``/stream/<enc>?ref=``.
Playlists are rewritten in-flight so nested URLs keep flowing through the
proxy; segments/subtitles are piped with Range support and Referer fallback
(the CDN may demand any of several embed origins).
"""

from __future__ import annotations

import re
from typing import AsyncIterator
from urllib.parse import quote, unquote, urljoin

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from .http import USER_AGENT, Http

CHUNK = 64 * 1024


def decode_target(path: str) -> str | None:
    """Extract the upstream URL from ``/stream/<urlencoded>``."""
    raw = unquote(path.lstrip("/"))
    if not raw:
        return None
    return raw if raw.startswith(("http://", "https://")) else None


def referer_for(target: str, ref_query: str | None) -> str:
    if ref_query and ref_query.startswith("http"):
        return ref_query
    return target.split("//", 1)[0] + "//" + target.split("//", 1)[1].split("/", 1)[0] + "/"


def rewrite_m3u8(body: str, base_url: str, referer: str) -> str:
    """Rewrite every URI in an m3u8 so nested requests use /stream/ too."""
    ref_qs = f"?ref={quote(referer, safe='')}"

    def wrap(url: str) -> str:
        absolute = urljoin(base_url, url)
        return f"/stream/{quote(absolute, safe='')}{ref_qs}"

    out_lines: list[str] = []
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped:
            out_lines.append(line)
            continue
        if stripped.startswith("#"):
            # rewrite URI="..." attributes (EXT-X-KEY, EXT-X-MAP, ...)
            rewritten = re_uri(stripped, wrap)
            out_lines.append(rewritten)
        else:
            out_lines.append(wrap(stripped))
    return "\n".join(out_lines) + "\n"


def re_uri(line: str, wrap) -> str:
    return re.sub(r'URI="([^"]+)"', lambda m: f'URI="{wrap(m.group(1))}"', line)


async def proxy_stream(
    http: Http, request: Request, path: str, ref: str | None
) -> Response:
    """Handle one /stream request (playlist rewrite or segment pipe)."""
    target = decode_target(path)
    if target is None:
        return JSONResponse({"error": "invalid stream path"}, status_code=400)

    referer = referer_for(target, ref)
    named_playlist = ".m3u8" in target.split("?", 1)[0]

    if named_playlist:
        try:
            body = await http.text(target, referer=referer, use_cache=False)
        except Exception as exc:
            return JSONResponse(
                {"error": f"proxy failure: {exc}"}, status_code=502
            )
        return Response(
            content=rewrite_m3u8(body, target, referer),
            media_type="application/vnd.apple.mpegurl",
            headers={"Cache-Control": "no-store"},
        )

    # segments + subtitles: pipe through with Range support and Referer fallback
    client: httpx.AsyncClient = http._client
    range_header = request.headers.get("range")
    referers = [referer]
    target_origin = referer_for(target, None)
    if target_origin not in referers:
        referers.append(target_origin)
    # Miruro streams come from various CDN origins — try the target first,
    # then the Miruro base as a fallback
    miruro_origin = "https://www.miruro.tv/"
    if miruro_origin not in referers:
        referers.append(miruro_origin)

    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    if range_header:
        headers["Range"] = range_header

    last_error: Exception | None = None
    for ref_try in referers:
        headers["Referer"] = ref_try
        headers["Origin"] = ref_try.rstrip("/")
        try:
            upstream = await client.send(
                client.build_request("GET", target, headers=headers), stream=True
            )
            if upstream.status_code in (401, 403, 404):
                await upstream.aclose()
                last_error = Exception(f"upstream {upstream.status_code}")
                continue
            upstream.raise_for_status()
        except httpx.HTTPStatusError as exc:
            last_error = exc
            continue
        except httpx.HTTPError as exc:
            last_error = exc
            continue

        # Some HLS playlists are served WITHOUT an .m3u8 extension
        # (e.g. miruro's echovideo.to '/cdn/<hash>' urls) and can carry no
        # Range header — sniff the first chunk: a playlist gets buffered,
        # rewritten and returned; media/segments keep streaming unchanged.
        ctype = (upstream.headers.get("content-type") or "").lower()
        if not range_header and not named_playlist:
            first: bytes = b""
            it = upstream.aiter_bytes(CHUNK)
            try:
                first = await anext(it)
            except (StopAsyncIteration, httpx.HTTPError):
                first = b""
            if first.lstrip().startswith(b"#EXTM3U") or "mpegurl" in ctype:
                rest = bytearray()
                try:
                    async for chunk in it:
                        rest.extend(chunk)
                        if len(rest) > 2 * 1024 * 1024:
                            break
                finally:
                    await upstream.aclose()
                return Response(
                    content=rewrite_m3u8(
                        (first + bytes(rest)).decode("utf-8", "replace"),
                        target,
                        referer,
                    ),
                    media_type="application/vnd.apple.mpegurl",
                    headers={"Cache-Control": "no-store"},
                )

            # wrap the iterator so the buffered first chunk leads the stream
            async def sniffer():
                if first:
                    yield first
                try:
                    async for chunk in it:
                        yield chunk
                finally:
                    await upstream.aclose()

            resp_headers = {
                k: v
                for k, v in upstream.headers.items()
                if k.lower()
                in (
                    "content-type",
                    "content-length",
                    "content-range",
                    "accept-ranges",
                    "etag",
                    "last-modified",
                )
            }
            return StreamingResponse(
                sniffer(),
                status_code=upstream.status_code,
                headers=resp_headers,
                media_type=upstream.headers.get("content-type") or "application/octet-stream",
            )

        # stream it through
        resp_headers = {
            k: v
            for k, v in upstream.headers.items()
            if k.lower()
            in (
                "content-type",
                "content-length",
                "content-range",
                "accept-ranges",
                "etag",
                "last-modified",
            )
        }

        async def iter_bytes() -> AsyncIterator[bytes]:
            try:
                async for chunk in upstream.aiter_bytes(CHUNK):
                    yield chunk
            finally:
                await upstream.aclose()

        return StreamingResponse(
            iter_bytes(),
            status_code=upstream.status_code,
            headers=resp_headers,
            media_type=upstream.headers.get("content-type") or "application/octet-stream",
        )

    status = 403 if "upstream 403" in str(last_error) else 502
    return JSONResponse({"error": f"proxy failure: {last_error}"}, status_code=status)


# image proxy: cover hosts send no CORS headers and sometimes check Referer
IMAGE_HOST_ALLOWLIST = (
    "miruro.tv",
    "anilist.co",
    "ani.zip",
    "cdn.myanimelist.net",
    "img.anili.st",
    "media.kitsu.app",
    "wsrv.nl",
)


def image_allowed(url: str) -> bool:
    try:
        host = url.split("//", 1)[1].split("/", 1)[0].lower()
    except IndexError:
        return False
    return any(host == h or host.endswith("." + h) for h in IMAGE_HOST_ALLOWLIST)


async def proxy_image(http: Http, path: str) -> Response:
    """Handle one /img request with a host allowlist."""
    target = decode_target(path)
    if target is None or not image_allowed(target):
        return JSONResponse({"error": "invalid image path"}, status_code=400)

    try:
        upstream = await http._client.get(
            target,
            headers={"User-Agent": USER_AGENT, "Accept": "image/*", "Referer": "https://www.miruro.tv/"},
        )
        upstream.raise_for_status()
    except Exception as exc:
        return JSONResponse({"error": f"image fetch failed: {exc}"}, status_code=502)

    return Response(
        content=upstream.content,
        media_type=upstream.headers.get("content-type") or "image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )
