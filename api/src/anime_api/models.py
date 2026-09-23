"""Pydantic models for the anime streaming API (request/response shapes).

JSON is emitted in camelCase to match the anime-site frontend contract
(shared/types.ts); Python code uses snake_case attribute names and both are
accepted on input (populate_by_name).
"""

from __future__ import annotations

import time
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

AudioMode = Literal["sub", "dub"]


def _now_ms() -> int:
    return int(time.time() * 1000)


class ApiModel(BaseModel):
    """Base model: camelCase JSON out, snake_case Python attributes in."""

    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    def model_dump(self, **kwargs):
        # always serialize with camelCase aliases (site contract)
        kwargs["by_alias"] = True
        return super().model_dump(**kwargs)

    def model_dump_json(self, **kwargs):
        kwargs["by_alias"] = True
        return super().model_dump_json(**kwargs)


class AnimeSearchResult(ApiModel):
    id: str = Field(description="ani-cli style slug id, e.g. cyberpunk-edgerunners-17742")
    title: str
    poster: Optional[str] = Field(default=None, description="proxied cover image URL")


class HomeItem(AnimeSearchResult):
    sub_count: Optional[int] = None
    dub_count: Optional[int] = None
    ep_count: Optional[int] = None
    type: Optional[str] = None


class HomeSection(ApiModel):
    id: str
    title: str
    items: list[HomeItem]


class AnimeMeta(ApiModel):
    japanese: Optional[str] = None
    status: Optional[str] = None
    aired: Optional[str] = None
    duration: Optional[str] = None
    mal_score: Optional[str] = None
    studios: Optional[str] = None
    producers: Optional[str] = None
    genres: list[str] = []


class AnimeDetails(AnimeSearchResult):
    mal_id: Optional[int] = None
    description: Optional[str] = None
    meta: Optional[AnimeMeta] = None
    seasons: list["AnimeSearchResult"] = []


class EpisodeInfo(ApiModel):
    id: str = Field(description="numeric provider episode id used for stream resolution")
    number: str


class ServerEntry(ApiModel):
    """An embed server advertised by the provider's servers API."""

    type: str = Field(description="sub or dub")
    name: str
    hash: str = Field(description="base64-encoded embed page URL")


class SourceVariant(ApiModel):
    quality: str = Field(description="e.g. 1080p")
    height: Optional[int] = Field(default=None, description="parsed pixel height for sorting")
    url: str = Field(description="playable URL (already routed through the local /stream proxy)")
    raw_url: str = Field(description="upstream m3u8 URL")


class SubtitleTrack(ApiModel):
    src: str
    lang: str = "en"
    label: str = "EN"
    default: bool = False


class QualityPick(ApiModel):
    """How the resolver picked the default stream."""

    strategy: str = Field(description="best | explicit | fallback")
    requested: Optional[str] = Field(default=None, description="quality the client asked for")
    served: str = Field(description="quality actually served")


class StreamSources(ApiModel):
    anime_id: str
    anime_title: str
    episode: EpisodeInfo
    mode: AudioMode
    server: str = Field(description="embed server the stream was resolved from")
    via: str = Field(default="hianime", description="resolver that produced the links")
    variants: list[SourceVariant] = Field(description="sorted best -> worst")
    best: SourceVariant = Field(description="highest-quality variant")
    master_url: Optional[str] = Field(
        default=None, description="proxied master playlist for adaptive playback"
    )
    preferred_url: str = Field(
        description="URL to play for the requested quality (best unless ?quality=)"
    )
    quality_pick: QualityPick
    subtitles: list[SubtitleTrack] = []


class ResolverInfo(ApiModel):
    """Multi-server resolution trace (which servers were tried / used)."""

    servers_seen: list[str] = Field(default_factory=list)
    servers_tried: list[str] = Field(default_factory=list)
    server_used: Optional[str] = None
    errors: dict[str, str] = {}


class ResolveResponse(StreamSources):
    resolver: ResolverInfo


# ---------------- user data (progress / favorites) ----------------


class ProgressEntry(ApiModel):
    anime_id: str
    anime_title: str
    episode_number: str
    position_seconds: float
    duration_seconds: float
    updated_at: int = Field(default_factory=_now_ms)
    mode: AudioMode = "sub"
    watched_episodes: list[str] = Field(default_factory=list)
    poster: Optional[str] = None


class FavoriteEntry(ApiModel):
    anime_id: str
    anime_title: str
    added_at: int = Field(default_factory=_now_ms)
    poster: Optional[str] = None
