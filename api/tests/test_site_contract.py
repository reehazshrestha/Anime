"""Tests for the anime-site contract: camelCase JSON + user-data store."""

from __future__ import annotations

import json

import pytest

from anime_api.models import (
    AnimeDetails,
    EpisodeInfo,
    FavoriteEntry,
    ProgressEntry,
    SourceVariant,
    StreamSources,
)
from anime_api.store import UserDataStore


def test_sources_payload_is_camel_case():
    """The site reads animeTitle/masterUrl/qualityPick/rawUrl — keys must be camelCase."""
    sources = StreamSources(
        anime_id="x-1",
        anime_title="T",
        episode=EpisodeInfo(id="9", number="1"),
        mode="sub",
        server="ZokoAnime",
        variants=[
            SourceVariant(quality="1080p", height=1080, url="/stream/a", raw_url="https://cdn/a")
        ],
        best=SourceVariant(quality="1080p", height=1080, url="/stream/a", raw_url="https://cdn/a"),
        master_url="/stream/m",
        preferred_url="/stream/a",
        quality_pick=__import__("anime_api.models", fromlist=["QualityPick"]).QualityPick(
            strategy="best", served="1080p"
        ),
    )
    keys = set(sources.model_dump().keys())
    assert {"animeId", "animeTitle", "masterUrl", "preferredUrl", "qualityPick"} <= keys
    assert keys.isdisjoint({"anime_id", "anime_title", "master_url", "quality_pick"})


def test_variant_raw_url_is_camel_case():
    v = SourceVariant(quality="720p", height=720, url="/stream/x", raw_url="https://cdn/x")
    assert set(v.model_dump().keys()) == {"quality", "height", "url", "rawUrl"}


def test_details_mal_id_is_camel_case():
    d = AnimeDetails(id="x-1", title="T", mal_id=42)
    assert "malId" in d.model_dump()
    assert "mal_id" not in d.model_dump()


def test_details_accepts_snake_and_camel_input():
    assert AnimeDetails.model_validate({"id": "x", "title": "T", "malId": 7}).mal_id == 7
    assert AnimeDetails.model_validate({"id": "x", "title": "T", "mal_id": 7}).mal_id == 7


def test_progress_entry_roundtrip_camel():
    payload = {
        "animeId": "a-1",
        "animeTitle": "A",
        "episodeNumber": "2",
        "positionSeconds": 30,
        "durationSeconds": 100,
        "mode": "dub",
    }
    entry = ProgressEntry.model_validate(payload)
    dumped = json.loads(entry.model_dump_json())
    assert dumped["animeId"] == "a-1"
    assert dumped["episodeNumber"] == "2"
    assert dumped["mode"] == "dub"
    assert "updatedAt" in dumped


def test_favorite_entry_camel():
    dumped = json.loads(FavoriteEntry(anime_id="a-1", anime_title="A").model_dump_json())
    assert dumped["animeId"] == "a-1" and dumped["addedAt"]


# ---------------- store ----------------


@pytest.fixture
def store(tmp_path):
    s = UserDataStore(str(tmp_path / "data" / "store.json"))

    import asyncio

    asyncio.run(s.init())
    return s


def test_store_progress_watched_tracking(store):
    entry = ProgressEntry(
        anime_id="a-1",
        anime_title="A",
        episode_number="1",
        position_seconds=95,
        duration_seconds=100,
        mode="sub",
    )
    store.save_progress(entry)
    got = store.get_progress("a-1")
    assert got is not None
    assert got.watched_episodes == ["1"]

    # below 90% -> not watched, but position updated
    store.save_progress(
        ProgressEntry(
            anime_id="a-1",
            anime_title="A",
            episode_number="2",
            position_seconds=50,
            duration_seconds=100,
            mode="sub",
        )
    )
    got = store.get_progress("a-1")
    assert got.watched_episodes == ["1"]
    assert got.episode_number == "2"


def test_store_favorites(store):
    store.add_favorite("a-1", "A")
    assert store.is_favorite("a-1")
    assert [f.anime_title for f in store.list_favorites()] == ["A"]
    store.remove_favorite("a-1")
    assert not store.is_favorite("a-1")


def test_store_persists_to_disk(store, tmp_path):
    import time

    store.add_favorite("a-2", "B")
    # persist is debounced/async — poll briefly for the write to land
    for _ in range(50):
        try:
            raw = json.loads((tmp_path / "data" / "store.json").read_text())
            if "a-2" in raw["favorites"]:
                break
        except (OSError, ValueError):
            pass
        time.sleep(0.05)
    raw = json.loads((tmp_path / "data" / "store.json").read_text())
    assert raw["favorites"]["a-2"]["animeTitle"] == "B"
