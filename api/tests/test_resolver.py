"""Tests for the Miruro pipe resolver (no network)."""

from __future__ import annotations

from anime_api.resolver import parse_height, pick_quality
from anime_api.models import SourceVariant


def make_variants() -> list[SourceVariant]:
    return [
        SourceVariant(quality="1080p", height=1080, url="/stream/1080", raw_url="https://cdn/1080"),
        SourceVariant(quality="720p", height=720, url="/stream/720", raw_url="https://cdn/720"),
        SourceVariant(quality="360p", height=360, url="/stream/360", raw_url="https://cdn/360"),
    ]


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