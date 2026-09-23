"""Tests for the deobfuscation + config parsing helpers (no network)."""

from __future__ import annotations

import base64

from anime_api.http import ProviderError
from anime_api.resolver import deobfuscate_blob, find_m3u8_src, find_subtitles


def encode(obj) -> str:
    raw = str(obj).encode()
    key = b"otaku-embed-v1"
    out = bytes(b ^ key[i % len(key)] for i, b in enumerate(raw))
    return base64.b64encode(out).decode()


def test_deobfuscate_blob_roundtrip():
    blob = encode('{"source":[{"file":"https://cdn/x.m3u8"}]}')
    data = deobfuscate_blob(blob)
    assert data["source"][0]["file"].endswith(".m3u8")


def test_deobfuscate_blob_garbage_raises():
    blob = base64.b64encode(b"not-xor-json").decode()
    try:
        deobfuscate_blob(blob)
    except ProviderError as exc:
        assert "could not decode" in str(exc)
    else:
        raise AssertionError("expected ProviderError")


def test_find_m3u8_src_nested():
    data = {"a": {"b": [{"src": "https://cdn/master.m3u8"}]}, "c": "x"}
    assert find_m3u8_src(data) == "https://cdn/master.m3u8"


def test_find_m3u8_src_missing():
    assert find_m3u8_src({"src": "https://cdn/file.mp4"}) is None
    assert find_m3u8_src("plain") is None


def test_find_subtitles():
    data = {
        "subtitles": [
            {"src": "https://cdn/en.vtt", "lang": "English"},
            {"src": "https://cdn/es.vtt", "lang": "Spanish"},
        ]
    }
    tracks = find_subtitles(data, "https://embed.example/")
    assert len(tracks) == 2
    assert tracks[0].lang == "English"
    assert tracks[0].label == "ENGLISH"
    assert tracks[0].default is True
    assert tracks[1].default is False
    assert tracks[0].src.startswith("/stream/")
    assert "ref=" in tracks[0].src
