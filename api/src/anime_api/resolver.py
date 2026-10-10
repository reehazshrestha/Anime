"""Stream resolver for the Miruro provider.

Miruro's pipe tunnel returns episode streams directly, so the resolver is
a thin wrapper: it encodes the watch path from a ServerEntry, calls the
pipe, then maps the response to our StreamSources model.

The Miruro pipe returns HLS master urls with quality information and
optional subtitle tracks — all the work the old resolver did (embed server
chain, XOR/AES decryption, master playlist parsing) is handled upstream
by the Miruro backend.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

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


class NoStreamError(Exception):
    """No server could provide the requested audio mode."""


def _proxy_stream(raw: str, referer: str) -> str:
    from urllib.parse import quote

    return f"/stream/{quote(raw, safe='')}?ref={quote(referer, safe='')}"


def parse_height(quality: str) -> int:
    m = re.search(r"(\d+)", quality)
    return int(m.group(1)) if m else 0


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
    """Resolves episodes → playable HLS sources via the Miruro pipe."""

    def __init__(self, http: Http, provider: Provider) -> None:
        self.http = http
        self.provider = provider
        self.master_cache = http.json_cache

    async def resolve(
        self,
        anime_id: str,
        episode: EpisodeInfo,
        mode: str = "sub",
        quality: str | None = None,
        anime_title: str | None = None,
    ) -> _Resolution:
        """Resolve stream sources for one episode via Miruro pipe."""
        servers = await self.provider.servers(episode.id)
        wanted = "dub" if mode == "dub" else "sub"

        seen_names = list(dict.fromkeys(s.name for s in servers))
        # Filter to the desired audio type, and prefer "all" (which covers
        # everything) over specific providers.
        candidates = [s for s in servers if s.type in (wanted, "all")]
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

        info = ResolverInfo(servers_seen=seen_names)
        last_error: Exception | None = None

        for entry in candidates:
            hash_str = entry.hash or ""
            # hash has format: "{anilistId}/{category}/{slug}"
            # For "all" provider we construct the path from the hash
            provider = entry.name or "?"
            parts = hash_str.split("/")
            if len(parts) >= 2:
                anilist_id = parts[0]
                category = parts[1] if len(parts) > 1 else "sub"
                slug = "/".join(parts[2:]) if len(parts) > 2 else episode.number
            else:
                anilist_id = anime_id
                category = wanted
                slug = episode.number

            # Build the watch path for the pipe
            watch_slug = f"{anilist_id}/{category}/{slug}" if provider == "all" else f"{provider}/{anilist_id}/{category}/{slug}"
            watch_path = f"watch/{watch_slug}"

            info.servers_tried.append(entry.name or "?")
            try:
                variants, subtitles, master_m3u8 = await self._from_pipe(
                    watch_path, anime_id
                )
            except Exception as exc:  # noqa: BLE001 — try the next server/provider
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
                via="miruro",
                variants=variants,
                best=variants[0],
                master_url=_proxy_stream(master_m3u8, "https://www.miruro.tv/") if master_m3u8 else None,
                preferred_url=chosen.url,
                quality_pick=pick,
                subtitles=subtitles,
            )
            return _Resolution(sources=sources, info=info)

        if last_error:
            raise NoStreamError(f"all providers failed: {last_error}")
        raise NoStreamError("no stream sources found")

    async def _from_pipe(
        self, watch_path: str, anime_id: str
    ) -> tuple[list[SourceVariant], list[SubtitleTrack], str]:
        """Call the Miruro pipe watch endpoint and parse the response."""
        data = await self.http.pipe(watch_path)

        # The pipe returns a dict with a "streams" list and optional "subtitles"
        streams: list[dict] = []
        if isinstance(data, dict):
            streams_raw = data.get("streams", [])
            if isinstance(streams_raw, list):
                streams = streams_raw
            elif isinstance(streams_raw, dict):
                streams = [streams_raw]

        if not streams:
            raise ProviderError("no streams in pipe response")

        variants: list[SourceVariant] = []
        master_m3u8: str | None = None

        for stream in streams:
            url = stream.get("url") or stream.get("proxiedUrl") or stream.get("file", "")
            if not url:
                continue
            quality = stream.get("quality", "auto")
            fmt = stream.get("format", "hls")
            if fmt != "hls" and not url.endswith(".m3u8"):
                # Non-HLS — skip (we proxy HLS only)
                continue

            # Track the best stream as the master
            if master_m3u8 is None:
                master_m3u8 = url

            height = stream.get("resolution", {})
            if isinstance(height, dict):
                h = height.get("height", 0) or 0
            else:
                h = parse_height(str(quality))

            variants.append(
                SourceVariant(
                    quality=str(quality),
                    height=int(h) if h else None,
                    url=_proxy_stream(url, "https://www.miruro.tv/"),
                    raw_url=url,
                )
            )

        if not variants and master_m3u8:
            # Single variant — treat the master itself as the variant
            variants = [
                SourceVariant(
                    quality="auto",
                    height=0,
                    url=_proxy_stream(master_m3u8, "https://www.miruro.tv/"),
                    raw_url=master_m3u8,
                )
            ]

        # Sort best first
        variants.sort(key=lambda v: v.height or 0, reverse=True)

        # Subtitle tracks
        subtitles: list[SubtitleTrack] = []
        subs_raw = data.get("subtitles", []) if isinstance(data, dict) else []
        if isinstance(subs_raw, list):
            for s in subs_raw:
                if not isinstance(s, dict):
                    continue
                src = s.get("file") or s.get("src", "")
                lang = s.get("lang") or s.get("label") or "en"
                if src:
                    subtitles.append(
                        SubtitleTrack(
                            src=_proxy_stream(src, "https://www.miruro.tv/"),
                            lang=lang,
                            label=str(s.get("label", lang)).upper(),
                            default=not subtitles,
                        )
                    )

        return variants, subtitles, master_m3u8 or ""