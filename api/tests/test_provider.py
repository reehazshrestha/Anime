"""Tests for HTML/JSON parsing helpers (no network)."""

from __future__ import annotations

import pytest

from anime_api.http import NotFoundError, UpstreamBlocked
from anime_api.provider import (
    parse_episode_list,
    parse_home,
    parse_search,
    parse_servers,
)

# ---------------- search ----------------

SEARCH_HTML = """
<div id="main-content">
  <div class="flw-item">
    <div class="film-poster">
      <img class="film-poster-img" src="https://img.example/a.jpg">
    </div>
    <h3 class="film-name"><a href="/watch/one-piece-100" title="One Piece">One Piece</a></h3>
  </div>
  <div class="flw-item">
    <h3 class="film-name"><a href="/watch/naruto-99" title="Naruto">Naruto</a></h3>
  </div>
</div>
<div id="main-sidebar">dupes live here <h3 class="film-name"><a href="/watch/one-piece-100" title="One Piece">One Piece</a></h3></div>
"""


def test_parse_search():
    results = parse_search(SEARCH_HTML)
    assert [r.id for r in results] == ["one-piece-100", "naruto-99"]
    assert results[0].title == "One Piece"
    assert results[0].poster is not None and results[0].poster.startswith("/img/")


def test_parse_search_blocked_page():
    with pytest.raises(UpstreamBlocked):
        parse_search("<html>Just a moment...</html>")


# ---------------- home ----------------

HOME_HTML = """
<div id="trending-home">
  <div class="number">1</div><div data-jname="Frieren"></div>
  <a href="/watch/frieren-1"><img src="https://img.example/f.jpg"></a>
</div>
<div>Main grid
  <div class="flw-item"><h3 class="film-name"><a href="/watch/latest-a-1" title="Latest A">Latest A</a></h3>
    <div class="tick-sub" data-count="8">8</div></div>
  <div class="flw-item"><h3 class="film-name"><a href="/watch/movie-b-2" title="Movie B">Movie B</a></h3>
    <div class="fdi-item">MOVIE</div></div>
</div>
>Top 10<
<div id="top-viewed-day">
  <div class="film-number">1</div><img src="https://img.example/t.jpg">
  <a href="/watch/top-c-3" title="Top C">Top C</a>
</div>
>Top Upcoming<
<div class="flw-item"><h3 class="film-name"><a href="/watch/upcoming-d-4" title="Upcoming D">Upcoming D</a></h3></div>
>Genres<
"""


def test_parse_home_sections():
    sections = parse_home(HOME_HTML)
    by_id = {s.id: s for s in sections}
    assert by_id["trending"].items[0].id == "frieren-1"
    # MOVIE entries are filtered out of "latest episodes"
    assert [i.id for i in by_id["latest-episodes"].items] == ["latest-a-1"]
    assert by_id["top10-day"].items[0].id == "top-c-3"
    assert by_id["upcoming"].items[0].id == "upcoming-d-4"


def test_parse_home_degrades_to_empty():
    assert parse_home("<html><body>nothing here</body></html>") == []


# ---------------- episodes ----------------

EPISODES_JSON = '{"html":"<div data-number=\\"1\\" data-id=\\"201\\" href=\\"/watch/one-piece-100?ep=201\\"></div>\\n<div data-number=\\"2\\" data-id=\\"202\\" href=\\"/watch/one-piece-100?ep=202\\"></div>"}'


def test_parse_episode_list():
    eps = parse_episode_list(EPISODES_JSON, "one-piece-100")
    assert [(e.number, e.id) for e in eps] == [("1", "201"), ("2", "202")]


def test_parse_episode_list_wrong_anime_filtered():
    # episodes pointing at a different anime slug are filtered out -> none found
    with pytest.raises(NotFoundError):
        parse_episode_list(EPISODES_JSON, "naruto-99")
    with pytest.raises(NotFoundError):
        parse_episode_list("{}", "one-piece-100")


# ---------------- servers ----------------

SERVERS_JSON = '{"html":"<div data-type=\\"sub\\" data-server-name=\\"ZokoAnime\\" data-hash=\\"aGF4\\"></div><div data-type=\\"dub\\" data-server-name=\\"Megaplay\\" data-hash=\\"aGF4Mg==\\"></div>"}'


def test_parse_servers():
    servers = parse_servers(SERVERS_JSON)
    assert len(servers) == 2
    assert servers[0].type == "sub" and servers[0].name == "ZokoAnime"
    assert servers[1].hash == "aGF4Mg=="
