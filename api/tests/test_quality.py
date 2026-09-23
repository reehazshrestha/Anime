"""Tests for master-playlist parsing and quality picking (no network)."""

from __future__ import annotations

from anime_api.models import SourceVariant
from anime_api.resolver import parse_height, parse_master_playlist, pick_quality

MASTER = """#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=1280x720
720/index.m3u8
"""


def make_variants() -> list[SourceVariant]:
    return parse_master_playlist(MASTER, "https://cdn/master.m3u8", "https://embed.example/")


def test_parse_master_playlist_sorted_best_first():
    variants = make_variants()
    assert [v.quality for v in variants] == ["1080p", "720p", "360p"]
    assert all(v.url.startswith("/stream/") for v in variants)
    assert variants[0].raw_url == "https://cdn/1080/index.m3u8"
    assert "ref=" in variants[0].url


def test_parse_master_playlist_relative_urls_resolved():
    variants = make_variants()
    assert variants[-1].raw_url == "https://cdn/360/index.m3u8"


def test_parse_master_playlist_empty():
    assert parse_master_playlist("#EXTM3U\n", "https://cdn/x.m3u8", "https://e/") == []


def test_parse_height():
    assert parse_height("1080p") == 1080
    assert parse_height("720") == 720
    assert parse_height("auto") == 0


def test_pick_quality_best_default():
    variants = make_variants()
    chosen, pick = pick_quality(variants, None)
    assert chosen.quality == "1080p"
    assert pick.strategy == "best"


def test_pick_quality_explicit_exact():
    variants = make_variants()
    chosen, pick = pick_quality(variants, "720p")
    assert chosen.quality == "720p"
    assert pick.strategy == "explicit"
    assert pick.requested == "720p"


def test_pick_quality_fallback_down():
    """Requesting 480p when only 360/720/1080 exist serves 360p (closest below)."""
    variants = make_variants()
    chosen, pick = pick_quality(variants, "480")
    assert chosen.quality == "360p"
    assert pick.strategy == "fallback"


def test_pick_quality_unknown_string_serves_best():
    variants = make_variants()
    chosen, pick = pick_quality(variants, "ultra-hd")
    assert chosen.quality == "1080p"
    assert pick.strategy == "best"


def test_pick_quality_auto_equals_best():
    variants = make_variants()
    chosen, _ = pick_quality(variants, "auto")
    assert chosen.quality == "1080p"
