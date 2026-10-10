"""Tests for AniList media parsing helpers + Miruro pipe decoding (no network)."""

from __future__ import annotations

import pytest

from anime_api.http import NotFoundError, UpstreamBlocked
from anime_api.models import AnimeDetails
from anime_api.provider import (
    _media_to_search_result,
    _media_to_details,
    _home_item_from_media,
)


SAMPLE_MEDIA = {
    "id": 154587,
    "title": {
        "romaji": "Sousou no Frieren",
        "english": "Frieren: Beyond Journey's End",
        "native": "葬送のフリーレン",
    },
    "coverImage": {
        "large": "https://s4.anilist.co/file/cover.jpg",
        "extraLarge": "https://s4.anilist.co/file/cover_big.jpg",
    },
    "bannerImage": "https://s4.anilist.co/file/banner.jpg",
    "format": "TV",
    "season": "FALL",
    "seasonYear": 2023,
    "episodes": 28,
    "duration": 25,
    "status": "FINISHED",
    "averageScore": 87,
    "meanScore": 89,
    "popularity": 123456,
    "favourites": 5000,
    "genres": ["Action", "Adventure", "Drama", "Fantasy"],
    "source": "ORIGINAL",
    "countryOfOrigin": "JP",
    "isAdult": False,
}

SAMPLE_MEDIA_FULL = {
    **SAMPLE_MEDIA,
    "idMal": 52991,
    "description": "The adventure of Frieren the elf mage begins...",
    "synonyms": [],
    "siteUrl": "https://anilist.co/anime/154587",
    "studios": {"nodes": [{"id": 1, "name": "Madhouse", "isAnimationStudio": True}]},
    "nextAiringEpisode": None,
    "startDate": {"year": 2023, "month": 9, "day": 29},
    "endDate": {"year": 2024, "month": 3, "day": 22},
    "tags": [{"name": "Magic", "rank": 90, "isMediaSpoiler": False}],
    "trailer": {"id": "abc123", "site": "youtube", "thumbnail": "https://img.youtube.com/vi/abc123.jpg"},
    "relations": {
        "edges": [
            {
                "relationType": "SEQUEL",
                "node": {
                    "id": 176582,
                    "title": {"romaji": "Sousou no Frieren 2", "english": "Frieren Season 2"},
                    "coverImage": {"large": "https://s4.anilist.co/seq.jpg"},
                    "format": "TV",
                    "type": "ANIME",
                    "status": "RELEASING",
                    "episodes": None,
                    "meanScore": None,
                },
            }
        ]
    },
    "streamingEpisodes": [],
}


def test_media_to_search_result():
    result = _media_to_search_result(SAMPLE_MEDIA)
    assert result.id == "154587"
    assert result.title == "Frieren: Beyond Journey's End"
    assert result.poster is not None and "/img/" in result.poster


def test_media_to_search_result_no_english():
    result = _media_to_search_result({"id": 1, "title": {"romaji": "Test", "native": "テスト"}})
    assert result.title == "Test"
    assert result.poster is None


def test_media_to_details():
    details = _media_to_details(SAMPLE_MEDIA_FULL)
    assert isinstance(details, AnimeDetails)
    assert details.id == "154587"
    assert details.title == "Frieren: Beyond Journey's End"
    assert details.mal_id == 52991
    assert details.description == "The adventure of Frieren the elf mage begins..."
    assert details.meta is not None
    assert "Action" in details.meta.genres
    assert details.meta.status == "Finished"
    assert details.meta.mal_score == "87"
    assert details.meta.studios == "Madhouse"
    assert len(details.seasons) == 1
    assert details.seasons[0].id == "176582"


def test_media_to_details_no_relations():
    minimal = {**SAMPLE_MEDIA_FULL, "relations": {"edges": []}, "studios": {"nodes": []}}
    details = _media_to_details(minimal)
    assert details.seasons == []


def test_home_item_from_media():
    item = _home_item_from_media(SAMPLE_MEDIA)
    assert item.id == "154587"
    assert item.type == "TV"
    assert item.ep_count == 28
    assert item.poster is not None


def test_parse_search_blocked_page():
    with pytest.raises(UpstreamBlocked):
        from anime_api.provider import parse_search
        parse_search("<html>Just a moment...</html>")


# Legacy parse_search still exists but only for the blocked-page check
# The rest of the old parser is no longer used; these tests ensure we
# still detect Cloudflare blocks properly.