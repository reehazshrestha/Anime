"""Tests for m3u8 rewriting and proxy URL helpers (no network)."""

from __future__ import annotations

from anime_api.proxy import decode_target, image_allowed, rewrite_m3u8
from anime_api.resolver import _proxy_stream

MASTER = """#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080
1080/index.m3u8
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1
seg-0.ts
"""


def test_rewrite_m3u8_rewrites_all_urls():
    out = rewrite_m3u8(MASTER, "https://cdn/master.m3u8", "https://embed.example/")
    assert "/stream/https%3A%2F%2Fcdn%2F1080%2Findex.m3u8" in out
    assert "/stream/https%3A%2F%2Fcdn%2Fseg-0.ts" in out
    # key URI attribute inside a tag is rewritten too
    assert 'URI="/stream/https%3A%2F%2Fcdn%2Fkey.bin' in out
    # referer is propagated on every rewritten URL
    assert "ref=https%3A%2F%2Fembed.example%2F" in out
    # non-URI lines (EXTM3U, STREAM-INF, EXT-X-KEY header) are kept
    assert "#EXTM3U" in out
    assert "#EXT-X-STREAM-INF" in out


def test_rewrite_m3u8_handles_crlf():
    out = rewrite_m3u8("#EXTM3U\r\nseg.ts\r\n", "https://cdn/x.m3u8", "https://e.example/")
    assert "/stream/https%3A%2F%2Fcdn%2Fseg.ts" in out


def test_decode_target():
    assert decode_target("https%3A%2F%2Fcdn%2Fseg.ts") == "https://cdn/seg.ts"
    assert decode_target("not-a-url") is None
    assert decode_target("") is None


def test_proxy_stream_url_shape():
    url = _proxy_stream("https://cdn/master.m3u8", "https://embed.example/")
    assert url.startswith("/stream/https%3A%2F%2Fcdn%2Fmaster.m3u8")
    assert "ref=" in url


def test_image_allowlist():
    assert image_allowed("https://s4.anilist.co/file.jpg")
    assert image_allowed("https://hianime.at/x.jpg")
    assert image_allowed("https://cdn.myanimelist.net/x.jpg")
    assert not image_allowed("https://evil.example/x.jpg")
    assert not image_allowed("not-a-url")
