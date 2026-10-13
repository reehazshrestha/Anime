"""Stream resolver for the Miruro provider.

Miruro's catalog API (miruro.tv/api/v1) returns per-episode "play" data:
for the requested episode it lists providers (kickassanime, anikoto, ...),
each with embed servers, HLS master-playlist urls, required Referer headers
and subtitle tracks.

The resolver picks the track matching the wanted audio mode (sub/dub),
walks providers/servers until one yields a playable master playlist,
enumerates the quality variants from that playlist, and returns everything
routed through the local /stream proxy (with the server's Referer attached).
"""

from __future__ import annotations

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

MIRURO_REFERER = "https://www.miruro.tv/"


class NoStreamError(Exception):
    """No server could provide the requested audio mode."""


def _proxy_stream(raw: str, referer: str) -> str:
    from urllib.parse import quote

    return f"/stream/{quote(raw, safe='')}?ref={quote(referer, safe='')}"


def parse_height(quality: str) -> int:
    m = re.search(r"(\d+)", quality)
    return int(m.group(1)) if m else 0


def parse_master_playlist(
    body: str, master_url: str, referer: str
) -> list[SourceVariant]:
    """Parse #EXT-X-STREAM-INF variants from an HLS master playlist.

    Returns one SourceVariant per variant playlist, best (tallest) first.
    Every variant is routed through the local /stream proxy with the embed
    server's Referer so the CDN accepts the request.
    """
    variants: list[SourceVariant] = []
    resolution: dict[int, str] = {}  # bandwidth -> "WxH"
    pending: dict[str, Any] = {}
    uri: str | None = None

    for line in body.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#EXT-X-STREAM-INF"):
            attrs = stripped.split(":", 1)[1]
            res = re.search(r"RESOLUTION=(\d+)x(\d+)", attrs)
            bw = re.search(r"BANDWIDTH=(\d+)", attrs)
            pending = {
                "w": int(res.group(1)) if res else 0,
                "h": int(res.group(2)) if res else 0,
                "bw": int(bw.group(1)) if bw else 0,
            }
        elif not stripped.startswith("#") and pending:
            uri = stripped
            height = pending["h"] or 0
            width = pending["w"] or 0
            url = urljoin(master_url, uri)
            variants.append(
                SourceVariant(
                    quality=f"{height}p" if height else "auto",
                    height=height or None,
                    url=_proxy_stream(url, referer),
                    raw_url=url,
                )
            )
            pending = {}
            uri = None

    # sort best-first: by height, then bandwidth
    variants.sort(key=lambda v: (v.height or 0), reverse=True)
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


@dataclass
class _Candidate:
    """One playable stream candidate from the play data."""

    provider: str
    server: str
    url: str          # master m3u8 url
    referer: str      # CDN-required referer
    track: str        # sub / dub / ssub / es ...


class StreamResolver:
    """Resolves episodes → playable HLS sources via the Miruro catalog."""

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
        """Resolve stream sources for one episode via the Miruro catalog."""
        wanted = "dub" if mode == "dub" else "sub"

        try:
            play = await self.provider.miruro_play(anime_id, episode.number)
        except Exception as exc:  # provider-level failure (blocked / not found)
            raise NoStreamError(f"miruro play data unavailable: {exc}") from exc

        candidates = self._candidates(play, wanted)
        if not candidates:
            has_other = self._has_other_track(play, [wanted])
            raise NoStreamError(
                f"No {wanted} available for this episode — "
                + (
                    f"try switching to {'SUB' if wanted == 'dub' else 'DUB'}."
                    if has_other
                    else "This episode has no streams."
                )
            )

        info = ResolverInfo(
            servers_seen=[f"{c.provider}:{c.server}" for c in candidates]
        )
        last_error: Exception | None = None

        for cand in candidates:
            info.servers_tried.append(f"{cand.provider}:{cand.server}")
            try:
                variants = await self._variant_list(cand)
            except Exception as exc:  # noqa: BLE001 — try the next server
                info.errors[f"{cand.provider}:{cand.server}"] = str(exc)
                last_error = exc
                continue

            if not variants:
                info.errors[f"{cand.provider}:{cand.server}"] = "no variants"
                last_error = ProviderError("no variants")
                continue

            chosen, pick = pick_quality(variants, quality)
            info.server_used = f"{cand.provider}:{cand.server}"

            sources = StreamSources(
                anime_id=anime_id,
                anime_title=anime_title or anime_id,
                episode=episode,
                mode=wanted,  # type: ignore[arg-type]
                server=cand.server,
                via="miruro",
                variants=variants,
                best=variants[0],
                master_url=_proxy_stream(cand.url, cand.referer),
                preferred_url=chosen.url,
                quality_pick=pick,
                subtitles=self._subtitles(play, wanted),
            )
            return _Resolution(sources=sources, info=info)

        if last_error:
            raise NoStreamError(f"all providers failed: {last_error}")
        raise NoStreamError("no stream sources found")

    # ---------------- play-data mapping ----------------

    def _candidates(self, play: dict, wanted: str) -> list[_Candidate]:
        """Flatten play data into prioritized stream candidates.

        Preference: the exact audio track first (sub → "sub" then "ssub" and
        friends; dub → "dub"), kickassanime-style HLS providers before embed
        fallbacks.
        """
        out: list[_Candidate] = []
        tracks = play.get("tracks") if isinstance(play, dict) else None
        if not isinstance(tracks, list):
            return out

        wants = [wanted]
        if wanted == "sub":  # ssub = "soft sub" variant many providers use
            wants.append("ssub")
            wants.append("raw")
        elif wanted == "dub":
            wants.append("dsub")

        for track in tracks:
            if not isinstance(track, dict):
                continue
            track_name = str(track.get("track") or "").lower()
            if track_name not in wants:
                continue
            for provider in track.get("providers") or []:
                if not isinstance(provider, dict):
                    continue
                provider_name = str(provider.get("provider") or "?")
                for server in provider.get("servers") or []:
                    if not isinstance(server, dict):
                        continue
                    server_name = str(server.get("server") or "?")
                    headers = server.get("headers") or {}
                    referer = ""
                    if isinstance(headers, dict):
                        referer = str(headers.get("Referer") or headers.get("referer") or "")
                    for stream in server.get("streams") or []:
                        if not isinstance(stream, dict):
                            continue
                        url = stream.get("url") or ""
                        if not url or ".m3u8" not in url:
                            continue
                        out.append(
                            _Candidate(
                                provider=provider_name,
                                server=server_name,
                                url=url,
                                referer=referer or MIRURO_REFERER,
                                track=track_name,
                            )
                        )
        return out

    def _has_other_track(self, play: dict, exclude: list[str]) -> bool:
        tracks = play.get("tracks") if isinstance(play, dict) else None
        if not isinstance(tracks, list):
            return False
        for track in tracks:
            if isinstance(track, dict):
                name = str(track.get("track") or "").lower()
                if name and name not in exclude:
                    return True
        return False

    def _subtitles(self, play: dict, wanted: str) -> list[SubtitleTrack]:
        """Collect subtitle tracks from all providers of the wanted track."""
        subs: list[SubtitleTrack] = []
        tracks = play.get("tracks") if isinstance(play, dict) else None
        if not isinstance(tracks, list):
            return subs
        for track in tracks:
            if not isinstance(track, dict):
                continue
            name = str(track.get("track") or "").lower()
            if wanted == "sub" and name not in ("sub", "ssub"):
                if name and name not in ("", "raw"):
                    continue
            elif wanted == "dub" and name != "dub":
                continue
            for provider in track.get("providers") or []:
                if not isinstance(provider, dict):
                    continue
                # subtitle files usually ship from the same CDN family as
                # the provider's streams — reuse that server's Referer
                referer = MIRURO_REFERER
                for server in provider.get("servers") or []:
                    if isinstance(server, dict) and isinstance(server.get("headers"), dict):
                        got = str(
                            server["headers"].get("Referer")
                            or server["headers"].get("referer")
                            or ""
                        )
                        if got:
                            referer = got
                            break
                for s in provider.get("subtitles") or []:
                    if not isinstance(s, dict):
                        continue
                    src = s.get("file") or s.get("url") or ""
                    if not src:
                        continue
                    lang = str(s.get("language") or s.get("lang") or "en")
                    label = str(s.get("label") or lang)
                    subs.append(
                        SubtitleTrack(
                            src=_proxy_stream(str(src), referer),
                            lang=lang,
                            label=label,
                            default=not subs and bool(s.get("default")),
                        )
                    )
        return subs

    async def _variant_list(self, cand: _Candidate) -> list[SourceVariant]:
        """Fetch the master playlist and enumerate its quality variants."""
        body = await self.http.text(cand.url, referer=cand.referer, use_cache=False)
        variants = parse_master_playlist(body, cand.url, cand.referer)
        if not variants:
            # master that directly serves media (single-rendition HLS)
            variants = [
                SourceVariant(
                    quality="auto",
                    height=0,
                    url=_proxy_stream(cand.url, cand.referer),
                    raw_url=cand.url,
                )
            ]
        return variants
