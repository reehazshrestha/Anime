"""Multi-server stream resolver.

Chain (mirrors ani-cli v5.1.4 against hianime.at):

1. ``/api/theme/episode/servers?episodeId=`` → embed server list (sub/dub)
2. pick servers in preference order (ZokoAnime first, then the rest)
3. base64-decode the server hash → embed page URL
4. embed page ``window.__P`` blob → base64 + XOR ``otaku-embed-v1`` → JSON config
5. config → master m3u8 + subtitle tracks
6. master playlist → quality variants (360p…1080p), sorted best → worst

The first server that yields a playable master playlist wins; per-server
errors are surfaced in :class:`ResolverInfo` so clients can see why a server
was skipped. The resolver never gives up after a single failure while another
server might still work — that is what buys reliability *and* quality.
"""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

from .http import Http, ProviderError
from .models import (
    EpisodeInfo,
    QualityPick,
    ResolverInfo,
    SourceVariant,
    StreamSources,
    SubtitleTrack,
)
from .provider import Provider

XOR_KEY = b"otaku-embed-v1"

# Embed servers we know about, in preference order. Anything else advertised
# by the servers API is appended after these.
PREFERRED_SERVERS = ["zokoanime", "megaplay", "hd-1", "hd-2", "vidstream"]

# Referers the video CDN may require (tried in order by the stream proxy).
KNOWN_EMBED_ORIGINS = ["https://zokoanime.video/", "https://megaplay.buzz/"]


class NoStreamError(Exception):
    """No server could provide the requested audio mode."""


def deobfuscate_blob(blob: str) -> Any:
    """Decode the embed's config blob: base64 then XOR with the key."""
    raw = base64.b64decode(blob)
    out = bytes(b ^ XOR_KEY[i % len(XOR_KEY)] for i, b in enumerate(raw))
    try:
        return json.loads(out.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ProviderError("could not decode embed config") from exc


def find_m3u8_src(data: Any) -> str | None:
    """Find the first m3u8 src anywhere in the decoded config."""
    if isinstance(data, str):
        return None
    if isinstance(data, list):
        for v in data:
            found = find_m3u8_src(v)
            if found:
                return found
        return None
    if isinstance(data, dict):
        src = data.get("src")
        if isinstance(src, str) and ".m3u8" in src:
            return src
        for v in data.values():
            found = find_m3u8_src(v)
            if found:
                return found
    return None


def find_subtitles(data: Any, referer: str) -> list[SubtitleTrack]:
    tracks: list[SubtitleTrack] = []
    subs = data.get("subtitles") if isinstance(data, dict) else None
    if isinstance(subs, list):
        for s in subs:
            if not isinstance(s, dict):
                continue
            src = s.get("src")
            lang = s.get("lang") or s.get("label") or "en"
            if isinstance(src, str):
                tracks.append(
                    SubtitleTrack(
                        src=_proxy_stream(src, referer),
                        lang=lang if isinstance(lang, str) else "en",
                        label=(lang if isinstance(lang, str) else "en").upper(),
                        default=not tracks,
                    )
                )
    return tracks


def _proxy_stream(raw: str, referer: str) -> str:
    from urllib.parse import quote

    return f"/stream/{quote(raw, safe='')}?ref={quote(referer, safe='')}"


def parse_height(quality: str) -> int:
    m = re.search(r"(\d+)", quality)
    return int(m.group(1)) if m else 0


def parse_master_playlist(
    body: str, master_url: str, referer: str
) -> list[SourceVariant]:
    """Enumerate ``#EXT-X-STREAM-INF`` variants, sorted best → worst."""
    variants: list[SourceVariant] = []
    lines = body.splitlines()
    for i, line in enumerate(lines[:-1]):
        if not line.startswith("#EXT-X-STREAM-INF"):
            continue
        height = re.search(r"RESOLUTION=\d+x(\d+)", line)
        raw = lines[i + 1].strip() if i + 1 < len(lines) else ""
        if not raw or raw.startswith("#"):
            continue
        raw = urljoin(master_url, raw)
        quality = f"{height.group(1)}p" if height else "unknown"
        variants.append(
            SourceVariant(
                quality=quality,
                height=parse_height(quality),
                url=_proxy_stream(raw, referer),
                raw_url=raw,
            )
        )
    variants.sort(key=lambda v: v.height or 0, reverse=True)
    return variants


def pick_quality(
    variants: list[SourceVariant], requested: str | None
) -> tuple[SourceVariant, QualityPick]:
    """Resolve the requested quality against available variants.

    ``requested`` may be ``"best"``, ``"auto"``/``None`` (same as best), or a
    height like ``"1080"``/``"1080p"``. Unknown or unavailable heights fall
    back to the closest variant not larger than requested, then to best.
    """
    best = variants[0]
    if not requested or requested in ("best", "auto"):
        return best, QualityPick(strategy="best", served=best.quality)

    req_h = parse_height(requested)
    if req_h == 0:
        return best, QualityPick(strategy="best", served=best.quality)

    exact = next((v for v in variants if v.height == req_h), None)
    if exact:
        return exact, QualityPick(
            strategy="explicit", requested=requested, served=exact.quality
        )

    # closest variant not larger than the request, else the smallest
    smaller = [v for v in variants if (v.height or 0) <= req_h]
    fallback = smaller[0] if smaller else variants[-1]
    return fallback, QualityPick(
        strategy="fallback", requested=requested, served=fallback.quality
    )


@dataclass
class _ServerAttempt:
    server: str
    error: str | None = None


@dataclass
class _Resolution:
    sources: StreamSources
    info: ResolverInfo


class StreamResolver:
    """Resolves episodes → playable HLS sources across multiple servers."""

    def __init__(self, http: Http, provider: Provider) -> None:
        self.http = http
        self.provider = provider
        self.master_cache = http.json_cache  # reuse TTL machinery for masters

    async def _from_server(
        self, embed_url: str, server_name: str
    ) -> tuple[list[SourceVariant], list[SubtitleTrack], str, str]:
        """Resolve one embed URL to (variants, subtitles, referer, master_m3u8)."""
        scheme_sep = embed_url.find("//")
        origin = embed_url[: embed_url.find("/", scheme_sep + 2) + 1]

        page = await self.http.text(embed_url, referer=origin)
        blob_match = re.search(r'window\.__P="([^"]*)"', page)
        if not blob_match:
            raise ProviderError("embed config blob not found")
        data = deobfuscate_blob(blob_match.group(1))

        m3u8 = find_m3u8_src(data)
        if not m3u8:
            raise ProviderError("no m3u8 in embed config")
        subtitles = find_subtitles(data, origin)

        async def fetch_master() -> list[SourceVariant]:
            body = await self.http.text(m3u8, referer=origin, use_cache=False)
            variants = parse_master_playlist(body, m3u8, origin)
            if not variants:
                # single-variant master: treat the master itself as the variant
                variants = [
                    SourceVariant(
                        quality="auto",
                        height=0,
                        url=_proxy_stream(m3u8, origin),
                        raw_url=m3u8,
                    )
                ]
            return variants

        variants = await self.master_cache.wrap(f"master:{m3u8}", fetch_master)
        return variants, subtitles, origin, m3u8

    async def resolve(
        self,
        anime_id: str,
        episode: EpisodeInfo,
        mode: str = "sub",
        quality: str | None = None,
        anime_title: str | None = None,
    ) -> _Resolution:
        """Resolve stream sources trying multiple servers in order."""
        servers = await self.provider.servers(episode.id)
        wanted = "dub" if mode == "dub" else "sub"

        seen_names = list(dict.fromkeys(s.name for s in servers))
        candidates = [s for s in servers if s.type == wanted]
        if not candidates:
            has_other = any(s.type and s.type != wanted for s in servers)
            raise NoStreamError(
                f"No {wanted} available for this episode — "
                + (
                    f"try switching to {'SUB' if wanted == 'dub' else 'DUB'}."
                    if has_other
                    else "This episode has no streams."
                )
            )

        def rank(entry: Any) -> tuple[int, int]:
            name = (entry.name or "").lower()
            for i, pref in enumerate(PREFERRED_SERVERS):
                if pref in name:
                    return (0, i)
            return (1, 0)

        candidates.sort(key=rank)

        info = ResolverInfo(servers_seen=seen_names)
        last_error: Exception | None = None

        for entry in candidates:
            try:
                embed = base64.b64decode(entry.hash).decode("utf-8")
            except Exception:
                info.errors[entry.name or "?"] = "bad server hash"
                continue
            if not embed.startswith("http"):
                info.errors[entry.name or "?"] = "bad embed url"
                continue

            info.servers_tried.append(entry.name or "?")
            try:
                variants, subtitles, referer, master_m3u8 = await self._from_server(
                    embed, entry.name
                )
            except Exception as exc:  # noqa: BLE001 — try the next server
                info.errors[entry.name or "?"] = str(exc)
                last_error = exc
                continue

            if not variants:
                info.errors[entry.name or "?"] = "no variants"
                continue

            chosen, pick = pick_quality(variants, quality)
            info.server_used = entry.name or "?"
            sources = StreamSources(
                anime_id=anime_id,
                anime_title=anime_title or anime_id,
                episode=episode,
                mode=wanted,  # type: ignore[arg-type]
                server=entry.name or "?",
                variants=variants,
                best=variants[0],
                master_url=_proxy_stream(master_m3u8, referer),
                preferred_url=chosen.url,
                quality_pick=pick,
                subtitles=subtitles,
            )
            return _Resolution(sources=sources, info=info)

        if last_error:
            raise NoStreamError(f"all servers failed: {last_error}")
        raise NoStreamError("no stream sources found")
