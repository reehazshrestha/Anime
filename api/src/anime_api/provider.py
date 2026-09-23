"""hianime.at provider — catalog scraping (search, details, episodes, home).

Port of the flow the anime-site scraper uses, rebuilt around httpx:
search HTML parsing, watch-page metadata, episode list API and the servers
API used by the stream resolver.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote_plus

from .http import BASE, Http, NotFoundError, ProviderError, UpstreamBlocked
from .models import (
    AnimeDetails,
    AnimeMeta,
    AnimeSearchResult,
    EpisodeInfo,
    HomeItem,
    HomeSection,
    ServerEntry,
)

ANICLI_ID_RE = re.compile(r"^[a-z0-9-]+-[0-9]+$", re.IGNORECASE)


def is_valid_id(anime_id: str) -> bool:
    """ani-cli id shape: watch/<slug>-<numeric-id>."""
    return bool(ANICLI_ID_RE.match(anime_id))


def _decode_entities(s: str) -> str:
    # provider escapes some fields up to 3x (&amp;amp;#039;) — decode until stable
    for _ in range(4):
        decoded = (
            s.replace("&#039;", "'")
            .replace("&#39;", "'")
            .replace("&quot;", '"')
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
        )
        if decoded == s:
            break
        s = decoded
    return s


def _proxy_image(raw: str) -> str:
    return f"/img/{_quote(raw)}"


def _quote(raw: str) -> str:
    from urllib.parse import quote

    return quote(raw, safe="")


# ---------------- search ----------------

def parse_search(page: str) -> list[AnimeSearchResult]:
    """Parse the hianime.at search results page into catalog entries."""
    if "just a moment" in page.lower():
        raise UpstreamBlocked("blocked by cloudflare")

    # top-10 sidebar repeats result markup; cut it off before flattening
    head = page.split('id="main-sidebar"')[0]
    blocks = head.split('<div class="flw-item')[1:]
    results: list[AnimeSearchResult] = []
    seen: set[str] = set()
    for m in re.finditer(
        r'<h3 class="film-name">\s*<a href="[^"]*/([a-z0-9-]+)"\s+title="([^"]+)"', head
    ):
        anime_id, title = m.group(1), _decode_entities(m.group(2))
        if anime_id in seen:
            continue
        seen.add(anime_id)
        # poster lives in the card block containing this id
        card = next((b for b in blocks if f"/{anime_id}" in b), None)
        poster = None
        if card:
            img = re.search(r'<img[^>]*class="film-poster-img"[^>]*src="([^"]+)"', card) or re.search(
                r'<img[^>]*src="([^"]+)"[^>]*class="film-poster-img"', card
            )
            if img:
                poster = _proxy_image(img.group(1))
        result = AnimeSearchResult(id=anime_id, title=title)
        if poster:
            result.poster = poster
        results.append(result)
    return results


# ---------------- home ----------------

def _img_src(img_tag: str) -> str | None:
    m = re.search(r'src="([^"]+)"', img_tag)
    return m.group(1) if m else None


def parse_catalog_card(block: str) -> HomeItem | None:
    raw = re.search(
        r'<h3 class="film-name">[\s\S]*?<a href="[^"]*/([a-z0-9-]+)"[^>]*title="([^"]+)"', block
    )
    if not raw:
        return None
    anime_id, raw_title = raw.group(1), raw.group(2)
    img_tag = re.search(r'<img[^>]*class="film-poster-img"[^>]*>', block)
    src = _img_src(img_tag.group(0)) if img_tag else None
    sub = re.search(r'tick-sub"[^>]*>(?:<[^>]*>)*([0-9]+)', block)
    dub = re.search(r'tick-dub"[^>]*>(?:<[^>]*>)*([0-9]+)', block)
    eps = re.search(r'tick-eps"[^>]*>(?:<[^>]*>)*([0-9]+)', block)
    fdi = re.search(r'fdi-item">([^<]+)<', block)

    item = HomeItem(id=anime_id, title=_decode_entities(raw_title))
    if src:
        item.poster = _proxy_image(src)
    if sub:
        item.sub_count = int(sub.group(1))
    if dub:
        item.dub_count = int(dub.group(1))
    if eps:
        item.ep_count = int(eps.group(1))
    if fdi and fdi.group(1).strip().upper() != "NEW":
        item.type = _decode_entities(fdi.group(1).strip())
    return item


def _extract_top10(html: str, section_id: str, title: str) -> HomeSection:
    items: list[HomeItem] = []
    seen: set[str] = set()
    section = html.split(f'id="{section_id}"')[-1] if f'id="{section_id}"' in html else ""
    for m in re.finditer(
        r'<div class="film-number">[\s\S]{0,150}?(<img[^>]*>)[\s\S]{0,400}?'
        r'<a href="[^"]*/([a-z0-9-]+)"[^>]*title="([^"]+)"',
        section,
    ):
        if m.group(2) in seen:
            continue
        seen.add(m.group(2))
        src = _img_src(m.group(1))
        item = HomeItem(id=m.group(2), title=_decode_entities(m.group(3)))
        if src:
            item.poster = _proxy_image(src)
        items.append(item)
    return HomeSection(
        id=section_id.replace("top-viewed-", "top10-"), title=title, items=items[:10]
    )


def parse_home(page: str) -> list[HomeSection]:
    """Scrape the provider home page into UI rails (degrades gracefully)."""
    if "just a moment" in page.lower():
        raise UpstreamBlocked("blocked by cloudflare")

    trending: list[HomeItem] = []
    trend = page.split('id="trending-home"')[-1] if 'id="trending-home"' in page else ""
    for m in re.finditer(
        r'<div class="number">[\s\S]{0,200}?data-jname="([^"]+)"[\s\S]{0,300}?'
        r'<a href="[^"]*/([a-z0-9-]+)"[\s\S]{0,300}?(<img[^>]*>)',
        trend,
    ):
        src = _img_src(m.group(3))
        item = HomeItem(id=m.group(2), title=_decode_entities(m.group(1)))
        if src:
            item.poster = _proxy_image(src)
        trending.append(item)

    # main grid: everything before the Top 10 / Top Upcoming blocks
    main = page
    idx = main.find(">Top 10<")
    if idx > 0:
        main = main[:idx]
    idx = main.find(">Top Upcoming<")
    if idx > 0:
        main = main[:idx]

    latest_part = main.split(">Latest Episode<")[-1] if ">Latest Episode<" in main else main
    new_part = (
        latest_part.split(">New On HiAnime<")[-1]
        if ">New On HiAnime<" in latest_part
        else ""
    )
    blocks = latest_part.split('<div class="flw-item')[1:]

    def cards(blocks_: list[str]) -> list[HomeItem]:
        out: list[HomeItem] = []
        for b in blocks_:
            card = parse_catalog_card(b)
            if card:
                out.append(card)
        return out

    latest = [i for i in cards(blocks) if (i.type or "").upper() != "MOVIE"]
    new = cards(new_part.split('<div class="flw-item')[1:]) if new_part else []

    upcoming: list[HomeItem] = []
    up = page.split(">Top Upcoming<")[-1] if ">Top Upcoming<" in page else ""
    up_end = up.find(">Genres<")
    upcoming_html = up[:up_end] if up_end > 0 else up
    upcoming = cards(upcoming_html.split('<div class="flw-item')[1:])

    sections = [
        HomeSection(id="trending", title="Trending", items=trending[:12]),
        HomeSection(id="latest-episodes", title="Latest Episodes", items=latest[:12]),
        HomeSection(id="new-releases", title="New on AniStream", items=new[:12]),
        _extract_top10(page, "top-viewed-day", "Top 10 · Today"),
        _extract_top10(page, "top-viewed-week", "Top 10 · Week"),
        _extract_top10(page, "top-viewed-month", "Top 10 · Month"),
        HomeSection(id="upcoming", title="Top Upcoming", items=upcoming[:12]),
    ]
    return [s for s in sections if s.items]


# ---------------- details ----------------

def _meta_value(html: str, label: str) -> str | None:
    re_ = re.compile(
        r'item-head">' + label + r':?</span>\s*(?:<[^>]+>)*([^<]{1,200}?)(?:<\/[^>]+>)*\s*<\/div>'
    )
    v = re_.search(html)
    return v.group(1).strip() if v else None


def parse_details(watch_page: str, anime_id: str) -> AnimeDetails:
    og = re.search(r'property="og:title" content="([^"]*)"', watch_page)
    title = _decode_entities(og.group(1)) if og else anime_id
    if og:
        title = (
            title.replace("Watch ", "", 1)
            .split(" | HiAnime")[0]
            .strip()
        )
        # strip trailing " Episode X"
        title = re.sub(r"\s+Episode\s+[^|]*$", "", title).strip()

    mal_m = re.search(r"/mal/([0-9]+)/", watch_page)
    mal_id = int(mal_m.group(1)) if mal_m else None
    og_image = re.search(r'property="og:image" content="([^"]+)"', watch_page)
    tw_image = re.search(r'name="twitter:image" content="([^"]+)"', watch_page)
    poster_src = (og_image or tw_image).group(1) if (og_image or tw_image) else None

    info_start = watch_page.find('class="anisc-info"')
    info_block = watch_page[info_start : info_start + 40_000] if info_start > 0 else ""

    overview = re.search(
        r'<span class="item-head">Overview:</span>\s*<div class="text">([\s\S]{1,4000}?)</div>',
        info_block or watch_page,
    )
    description = None
    if overview:
        description = _decode_entities(re.sub(r"<[^>]+>", " ", overview.group(1)))
        description = re.sub(r"\s+", " ", description).strip()

    meta = AnimeMeta(genres=[])
    for label, attr in (
        ("Japanese", "japanese"),
        ("Status", "status"),
        ("Aired", "aired"),
        ("Duration", "duration"),
        ("MAL Score", "mal_score"),
        ("Studios", "studios"),
        ("Producers", "producers"),
    ):
        value = _meta_value(info_block, label)
        if value:
            setattr(meta, attr, _decode_entities(value))
    genres_block = re.search(r'item-head">Genres:</span>([\s\S]{0,2000}?)</div>', info_block)
    if genres_block:
        meta.genres = [_decode_entities(g) for g in re.findall(r'title="([^"]+)"', genres_block.group(1))]

    return AnimeDetails(
        id=anime_id,
        title=title,
        mal_id=mal_id,
        poster=_proxy_image(poster_src) if poster_src else None,
        description=description,
        meta=meta if (meta.genres or meta.mal_score or meta.status) else None,
        seasons=[],
    )


# ---------------- episodes ----------------

def parse_episode_list(payload: str, anime_id: str) -> list[EpisodeInfo]:
    """Parse the episode-list API response (HTML-in-JSON) for this anime."""
    try:
        html = (json.loads(payload)).get("html", "")
    except ValueError:
        html = payload
    flat = html.replace("\\", "")
    eps: list[EpisodeInfo] = []
    for m in re.finditer(
        r'data-number="([^"]*)"[^>]*data-id="([0-9]+)"[^>]*href="[^"]*/watch/'
        + re.escape(anime_id)
        + r"\?ep=",
        flat,
    ):
        eps.append(EpisodeInfo(id=m.group(2), number=m.group(1)))
    if not eps:
        raise NotFoundError("no episodes found")
    return eps


# ---------------- servers ----------------

def parse_servers(payload: str) -> list[ServerEntry]:
    """Parse the servers API response into embed server entries."""
    try:
        html = (json.loads(payload)).get("html", "")
    except ValueError:
        html = payload
    flat = html.replace('\\"', '"')
    entries: list[ServerEntry] = []
    for m in re.finditer(
        r'data-type="([^"]*)"\s+data-server-name="([^"]*)"\s+data-hash="([^"]*)"', flat
    ):
        entries.append(ServerEntry(type=m.group(1), name=m.group(2), hash=m.group(3)))
    return entries


class Provider:
    """Catalog API on top of :class:`Http` (all hot paths cached)."""

    def __init__(self, http: Http) -> None:
        self.http = http
        self.search_cache = http.html_cache
        self.home_cache = http.json_cache

    async def browse_genre(self, genre: str, page: int = 1) -> list[AnimeSearchResult]:
        """Browse the provider's /filter endpoint by genre (paginated).

        Transient upstream failures are retried and surfaced as 502-class
        errors — a flaky provider must not masquerade as "no such genre".
        Empty results for a *known-good* request are cached briefly to avoid
        hammering the provider, but still returned as 404.
        """
        slug = re.sub(r"[^a-z0-9-]", "", genre.lower().replace(" ", "-"))
        if not slug:
            raise NotFoundError("invalid genre")
        page = max(1, min(page, 50))

        async def fetch() -> list[AnimeSearchResult]:
            last_exc: Exception | None = None
            for attempt in range(2):  # one retry on transient failure
                try:
                    payload = await self.http.text(
                        f"{BASE}/filter?genre={slug}&page={page}", use_cache=False
                    )
                    results = parse_search(payload)
                    if results:
                        return results
                    last_exc = NotFoundError(f"no results for genre '{genre}'")
                except UpstreamBlocked as exc:
                    raise ProviderError(
                        f"provider is blocking genre requests right now ({exc})"
                    ) from exc
                except ProviderError as exc:
                    last_exc = exc
                if attempt == 0:
                    import asyncio

                    await asyncio.sleep(1.0)
            raise last_exc or ProviderError(f"genre '{genre}' unavailable")

        return await self.http.json_cache.wrap(f"genre:{slug}:{page}", fetch)

    async def search(self, query: str) -> list[AnimeSearchResult]:
        q = quote_plus(re.sub(r"\s+", "+", query.strip()))

        async def fetch() -> list[AnimeSearchResult]:
            page = await self.http.text(f"{BASE}/search?keyword={q}")
            return parse_search(page)

        return await self.http.json_cache.wrap(f"search:{q.lower()}", fetch)

    async def home(self) -> list[HomeSection]:
        async def fetch() -> list[HomeSection]:
            page = await self.http.text(f"{BASE}/home")
            return parse_home(page)

        return await self.http.json_cache.wrap("home", fetch)

    async def details(self, anime_id: str) -> AnimeDetails:
        if not is_valid_id(anime_id):
            raise NotFoundError("invalid anime id")

        async def fetch() -> AnimeDetails:
            page = await self.http.text(f"{BASE}/{anime_id}")
            return parse_details(page, anime_id)

        return await self.http.json_cache.wrap(f"details:{anime_id}", fetch)

    async def episodes(self, anime_id: str) -> list[EpisodeInfo]:
        if not is_valid_id(anime_id):
            raise NotFoundError("invalid anime id")
        numeric = anime_id.split("-")[-1]

        async def fetch() -> list[EpisodeInfo]:
            payload = await self.http.text(f"{BASE}/api/theme/episode/list/{numeric}")
            return parse_episode_list(payload, anime_id)

        return await self.http.json_cache.wrap(f"eps:{anime_id}", fetch)

    async def servers(self, episode_id: str) -> list[ServerEntry]:
        payload = await self.http.text(
            f"{BASE}/api/theme/episode/servers?episodeId={episode_id}", use_cache=False
        )
        return parse_servers(payload)
