"""miruro.tv provider — AniList-backed catalog + miruro pipe for episodes & streams.

Search, discovery lists and details come from the public AniList GraphQL API
(banner/logo images get proxied through the local /img proxy). Episode lists
and stream data come from the Miruro secure/pipe tunnel which uses curl_cffi
to bypass Cloudflare.
"""

from __future__ import annotations

import re
from typing import Any

from .http import Http, NotFoundError, ProviderError
from .models import (
    AnimeDetails,
    AnimeMeta,
    AnimeSearchResult,
    EpisodeInfo,
    HomeItem,
    HomeSection,
    ServerEntry,
)

# AniList GraphQL fragment for list/search results
MEDIA_LIST_FIELDS = """
id
title { romaji english native }
coverImage { large extraLarge }
bannerImage
format
season
seasonYear
episodes
duration
status
averageScore
meanScore
popularity
favourites
genres
source
countryOfOrigin
isAdult
studios(isMain: true) { nodes { name isAnimationStudio } }
nextAiringEpisode { episode airingAt timeUntilAiring }
startDate { year month day }
endDate { year month day }
"""

# AniList GraphQL fragment for the anime details page
MEDIA_FULL_FIELDS = """
id
idMal
title { romaji english native }
description(asHtml: false)
coverImage { large extraLarge color }
bannerImage
format
season
seasonYear
episodes
duration
status
averageScore
meanScore
popularity
favourites
trending
genres
tags { name rank isMediaSpoiler }
source
countryOfOrigin
isAdult
synonyms
siteUrl
trailer { id site thumbnail }
studios { nodes { id name isAnimationStudio siteUrl } }
nextAiringEpisode { episode airingAt timeUntilAiring }
startDate { year month day }
endDate { year month day }
relations {
    edges {
        relationType(version: 2)
        node {
            id
            title { romaji english native }
            coverImage { large }
            format
            type
            status
            episodes
            meanScore
        }
    }
}
streamingEpisodes { title thumbnail url site }
"""


def _proxy_image(raw: str) -> str:
    from urllib.parse import quote
    # Anilist images are already full URLs; proxy them so the client
    # gets CORS-safe URLs through our proxy.
    if raw.startswith("https://s4.anilist.co") or raw.startswith("https://artworks.ani.zip"):
        return f"/img/{quote(raw, safe='')}"
    return raw


def _media_to_search_result(media: dict) -> AnimeSearchResult:
    """Convert an AniList media object to AnimeSearchResult."""
    title = media.get("title", {}) or {}
    english = title.get("english")
    romaji = title.get("romaji")
    best_title = english or romaji or "Unknown"

    poster = None
    cover = media.get("coverImage") or {}
    for key in ("extraLarge", "large"):
        if cover.get(key):
            poster = _proxy_image(cover[key])
            break

    return AnimeSearchResult(
        id=str(media["id"]),
        title=best_title,
        poster=poster,
    )


def _media_to_details(media: dict) -> AnimeDetails:
    """Convert a full AniList media object to AnimeDetails."""
    title_data = media.get("title", {}) or {}
    english = title_data.get("english")
    romaji = title_data.get("romaji")
    native = title_data.get("native")
    best_title = english or romaji or "Unknown"

    poster = None
    cover = media.get("coverImage") or {}
    for key in ("extraLarge", "large"):
        if cover.get(key):
            poster = _proxy_image(cover[key])
            break

    description = media.get("description") or None
    mal_id = media.get("idMal")

    # Build meta
    genres = [g for g in (media.get("genres") or []) if g]
    status = media.get("status", "")
    status_label = {
        "FINISHED": "Finished",
        "RELEASING": "Airing",
        "NOT_YET_RELEASED": "Not Yet Aired",
        "CANCELLED": "Cancelled",
        "HIATUS": "On Hiatus",
    }.get(status, status)

    # Format episode counts / year
    aired_str = ""
    sd = media.get("startDate") or {}
    ed = media.get("endDate") or {}
    if sd.get("year"):
        aired_str = f"{sd['year']}"
        if ed.get("year") and ed["year"] != sd["year"]:
            aired_str += f" – {ed['year']}"

    duration = media.get("duration")
    duration_str = f"{duration} min" if duration else None

    studios_list = (media.get("studios") or {}).get("nodes") or []
    studio_names = [s["name"] for s in studios_list if s.get("isAnimationStudio")]
    studios_str = ", ".join(studio_names) if studio_names else None

    ep_count = media.get("episodes")

    meta = AnimeMeta(
        japanese=native or None,
        status=status_label,
        aired=aired_str or None,
        duration=duration_str,
        mal_score=str(media.get("averageScore") or "") or None,
        studios=studios_str,
        genres=genres,
    )

    # Related seasons from the relations field
    related: list[AnimeSearchResult] = []
    relations_data = (media.get("relations") or {}).get("edges") or []
    for edge in relations_data:
        if edge.get("relationType") in ("SEQUEL", "PREQUEL", "SIDE_STORY", "SPIN_OFF", "ALTERNATIVE"):
            node = edge.get("node") or {}
            rel_id = str(node.get("id", ""))
            if rel_id:
                related.append(_media_to_search_result(node))

    return AnimeDetails(
        id=str(media["id"]),
        title=best_title,
        mal_id=mal_id,
        poster=poster,
        description=description,
        meta=meta if (meta.genres or meta.mal_score or meta.status) else None,
        seasons=related[:12],  # cap at 12
    )


def _home_item_from_media(media: dict) -> HomeItem:
    """Convert AniList media to HomeItem for rails."""
    result = _media_to_search_result(media)
    # mirror the old HomeItem shape
    item = HomeItem(
        id=result.id,
        title=result.title,
        poster=result.poster,
    )
    # Add extra fields from AniList metadata
    media_format = media.get("format")
    if media_format:
        item.type = media_format
    if media.get("episodes"):
        item.ep_count = media["episodes"]
    return item


def _safe_int(val: Any) -> int | None:
    try:
        return int(val)
    except (ValueError, TypeError):
        return None


class Provider:
    """Catalog + episodes + streams backed by AniList + Miruro pipe."""

    def __init__(self, http: Http) -> None:
        self.http = http
        self.search_cache = http.html_cache
        self.home_cache = http.json_cache

    # ---------------- Home / rails ----------------

    async def home(self) -> list[HomeSection]:
        """Build home rails from AniList trending/popular/upcoming/recent."""

        async def fetch() -> list[HomeSection]:
            # Trending
            trending_data = await self.http.anilist_query(
                """query ($page: Int, $perPage: Int) {
                    Page(page: $page, perPage: $perPage) {
                        media(sort: TRENDING_DESC, type: ANIME) {
                            """ + MEDIA_LIST_FIELDS + """
                        }
                    }
                }""",
                {"page": 1, "perPage": 12},
            )
            trending = [
                _home_item_from_media(m)
                for m in ((trending_data.get("Page") or {}).get("media") or [])
                if not m.get("isAdult")
            ]

            # Latest/recently airing
            recent_data = await self.http.anilist_query(
                """query ($page: Int, $perPage: Int) {
                    Page(page: $page, perPage: $perPage) {
                        media(
                            sort: START_DATE_DESC,
                            type: ANIME,
                            status: RELEASING
                        ) {
                            """ + MEDIA_LIST_FIELDS + """
                        }
                    }
                }""",
                {"page": 1, "perPage": 12},
            )
            latest = [
                _home_item_from_media(m)
                for m in ((recent_data.get("Page") or {}).get("media") or [])
                if not m.get("isAdult")
            ]

            # Popular all-time
            popular_data = await self.http.anilist_query(
                """query ($page: Int, $perPage: Int) {
                    Page(page: $page, perPage: $perPage) {
                        media(sort: POPULARITY_DESC, type: ANIME) {
                            """ + MEDIA_LIST_FIELDS + """
                        }
                    }
                }""",
                {"page": 1, "perPage": 12},
            )
            popular = [
                _home_item_from_media(m)
                for m in ((popular_data.get("Page") or {}).get("media") or [])
                if not m.get("isAdult")
            ]

            # Upcoming
            upcoming_data = await self.http.anilist_query(
                """query ($page: Int, $perPage: Int) {
                    Page(page: $page, perPage: $perPage) {
                        media(
                            sort: POPULARITY_DESC,
                            type: ANIME,
                            status: NOT_YET_RELEASED
                        ) {
                            """ + MEDIA_LIST_FIELDS + """
                        }
                    }
                }""",
                {"page": 1, "perPage": 12},
            )
            upcoming = [
                _home_item_from_media(m)
                for m in ((upcoming_data.get("Page") or {}).get("media") or [])
                if not m.get("isAdult")
            ]

            sections = [
                HomeSection(id="trending", title="Trending", items=trending),
                HomeSection(id="latest-episodes", title="Currently Airing", items=latest),
                HomeSection(id="popular", title="Most Popular", items=popular),
                HomeSection(id="upcoming", title="Most Anticipated", items=upcoming),
            ]
            return [s for s in sections if s.items]

        return await self.http.json_cache.wrap("home", fetch)

    # ---------------- Search ----------------

    async def search(self, query: str) -> list[AnimeSearchResult]:
        q = query.strip()

        async def fetch() -> list[AnimeSearchResult]:
            data = await self.http.anilist_query(
                """query ($q: String, $page: Int, $perPage: Int) {
                    Page(page: $page, perPage: $perPage) {
                        media(search: $q, type: ANIME, sort: SEARCH_MATCH) {
                            """ + MEDIA_LIST_FIELDS + """
                        }
                    }
                }""",
                {"q": q, "page": 1, "perPage": 24},
            )
            results = [
                _media_to_search_result(m)
                for m in ((data.get("Page") or {}).get("media") or [])
                if not m.get("isAdult")
            ]
            if not results:
                raise NotFoundError(f"no results for '{q}'")
            return results

        return await self.http.json_cache.wrap(f"search:{q.lower()}", fetch)

    # ---------------- Genre browsing ----------------

    async def browse_genre(self, genre: str, page: int = 1) -> list[AnimeSearchResult]:
        slug = re.sub(r"[^a-z0-9-]", "", genre.lower().replace(" ", "-"))
        if not slug:
            raise NotFoundError("invalid genre")
        page = max(1, min(page, 50))

        # Capitalise genre names for AniList's enum values
        genre_caps = genre.strip().title()

        async def fetch() -> list[AnimeSearchResult]:
            data = await self.http.anilist_query(
                """query ($genre: String, $page: Int, $perPage: Int) {
                    Page(page: $page, perPage: $perPage) {
                        media(
                            genre: $genre,
                            type: ANIME,
                            sort: POPULARITY_DESC
                        ) {
                            """ + MEDIA_LIST_FIELDS + """
                        }
                    }
                }""",
                {"genre": genre_caps, "page": page, "perPage": 30},
            )
            results = [
                _media_to_search_result(m)
                for m in ((data.get("Page") or {}).get("media") or [])
                if not m.get("isAdult")
            ]
            if not results:
                raise NotFoundError(f"no results for genre '{genre}'")
            return results

        return await self.http.json_cache.wrap(f"genre:{slug}:{page}", fetch)

    # ---------------- Details ----------------

    async def details(self, anime_id: str) -> AnimeDetails:
        # Ensure numeric AniList ID
        if not anime_id.isdigit():
            raise NotFoundError("invalid anime id — expected numeric AniList id")

        anilist_id = int(anime_id)

        async def fetch() -> AnimeDetails:
            data = await self.http.anilist_query(
                """query ($id: Int) {
                    Media(id: $id, type: ANIME) {
                        """ + MEDIA_FULL_FIELDS + """
                    }
                }""",
                {"id": anilist_id},
            )
            media = data.get("Media")
            if not media:
                raise NotFoundError(f"anime {anime_id} not found")
            return _media_to_details(media)

        return await self.http.json_cache.wrap(f"details:{anime_id}", fetch)

    # ---------------- Episodes (via Miruro pipe) ----------------

    async def episodes(self, anime_id: str) -> list[EpisodeInfo]:
        if not anime_id.isdigit():
            raise NotFoundError("invalid anime id")

        async def fetch() -> list[EpisodeInfo]:
            anilist_id = int(anime_id)
            raw = await self.http.pipe("episodes", {"anilistId": anilist_id})

            # The pipe returns data with a "providers" dict.
            # Each provider has episodes under e.g. providers["kiwi"]["episodes"]["sub"].
            # We collect ALL episodes across ALL providers and categories,
            # deduplicate by number, and sort.
            providers = raw.get("providers", {})
            seen: set[str] = set()
            eps: list[EpisodeInfo] = []

            for provider_name, provider_data in providers.items():
                if not isinstance(provider_data, dict):
                    continue
                ep_categories = provider_data.get("episodes", {})
                if not isinstance(ep_categories, dict):
                    if isinstance(ep_categories, list):
                        ep_categories = {"sub": ep_categories}
                    else:
                        continue
                for category, ep_list in ep_categories.items():
                    if not isinstance(ep_list, list):
                        continue
                    for ep in ep_list:
                        if not isinstance(ep, dict):
                            continue
                        number = str(ep.get("number", ""))
                        if not number or number in seen:
                            continue
                        seen.add(number)
                        ep_id = ep.get("id") or ep.get("slug") or number
                        eps.append(EpisodeInfo(id=str(ep_id), number=number))

            if not eps:
                raise NotFoundError(f"no episodes found for anime {anime_id}")
            eps.sort(key=lambda e: _safe_int(e.number) or 0)
            return eps

        return await self.http.json_cache.wrap(f"eps:{anime_id}", fetch)

    # ---------------- Servers / streams ----------------
    # Miruro's pipe returns streams directly via the /watch endpoint.
    # We keep a servers()-compatible stub for the resolver to use.

    async def servers(self, episode_id: str) -> list[ServerEntry]:
        """Resolve an episode id to server entries.

        The episode id from episodes() is a Miruro watch path segment like
        "watch/kiwi/178005/sub/animepahe-1". We decode it into provider/anilistId/category/slug
        and return a synthetic ServerEntry that the resolver can work with.
        """
        # Parse the Miruro-style episode id
        # Example: "watch/kiwi/178005/sub/animepahe-1"
        parts = episode_id.split("/")
        if len(parts) >= 4 and parts[0] == "watch":
            provider = parts[1]
            anilist_id = parts[2]
            category = parts[3]  # sub / dub / ssub
            slug = "/".join(parts[4:]) if len(parts) > 4 else ""
            # Store the full watch path as the "hash"
            return [
                ServerEntry(
                    type=category,
                    name=provider,
                    hash=f"{anilist_id}/{category}/{slug}",
                )
            ]

        # Fallback: if it's a plain number, treat it as the episode number
        # and try generic "all" providers
        if episode_id.isdigit():
            return [
                ServerEntry(type="sub", name="all", hash=f"all/sub/{episode_id}"),
                ServerEntry(type="dub", name="all", hash=f"all/dub/{episode_id}"),
            ]

        raise NotFoundError(f"cannot parse episode id: {episode_id}")