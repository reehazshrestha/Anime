"""anime-api — standalone anime streaming API (FastAPI).

Endpoints
---------
GET    /health                     liveness + cache stats
GET    /api/home                   catalog rails
GET    /api/search?q=              catalog search
GET    /api/anime/{id}             details + episodes + isFavorite + progress
GET    /api/anime/{id}/episodes    episode list only
GET    /api/sources                multi-server stream resolution + quality pick
GET    /api/progress               list watch progress
POST   /api/progress               save watch progress
DELETE /api/progress/{animeId}     clear progress for an anime
GET    /api/favorites              list favorites
POST   /api/favorites              add favorite
DELETE /api/favorites/{animeId}    remove favorite
GET    /stream/<enc>?ref=          HLS proxy (playlist rewrite + segment pipe)
GET    /img/<enc>                  cover-image proxy (host allowlist)
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException

from .http import Http, NotFoundError, ProviderError, UpstreamBlocked
from .models import (
    AudioMode,
    FavoriteEntry,
    ProgressEntry,
    ResolveResponse,
)
from .provider import Provider, is_valid_id
from .proxy import proxy_image, proxy_stream
from .resolver import NoStreamError, StreamResolver
from .store import UserDataStore, _poster_for

DESCRIPTION = """
Standalone anime streaming API with **multi-server resolution** and
**quality selection**.

* Stream resolution tries every available embed server (ZokoAnime first) and
  returns the first that works, with per-server errors for observability.
* Every quality variant (360p–1080p) is enumerated; `preferredUrl` serves the
  best quality by default and `?quality=` pins a quality ("best" by default,
  "1080", "720p", ... with closest-lower fallback).
* An HLS proxy rewrites playlists and propagates the Referer the upstream CDN
  demands, so players get playable URLs out of the box.
* Progress + favorites are stored in `server/data/store.json` — the same file
  the anime-site Node backend uses, so history survives backend switches.
"""


def build_state():
    """Construct the shared app-state objects (idempotent)."""
    http = Http()
    provider = Provider(http)
    resolver = StreamResolver(http, provider)
    store = UserDataStore()
    return http, provider, resolver, store


async def ensure_state(app: FastAPI) -> None:
    """Lazily initialize app.state on first request.

    Needed because some serverless runtimes (e.g. Vercel's Python runtime)
    do not execute FastAPI lifespan handlers; without this, app.state would
    be empty and every request would 500.
    """
    if not hasattr(app.state, "http"):
        http, provider, resolver, store = build_state()
        await store.init()
        app.state.http = http
        app.state.provider = provider
        app.state.resolver = resolver
        app.state.store = store


@asynccontextmanager
async def lifespan(app: FastAPI):
    await ensure_state(app)
    yield
    await app.state.http.aclose()


app = FastAPI(
    title="anime-api",
    description=DESCRIPTION,
    version="0.1.0",
    lifespan=lifespan,
)

# Cross-origin calls (e.g. a locally-served site or another frontend hitting
# the deployed API). Same-origin traffic is unaffected.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    """All 404/4xx responses speak the client's {error: ...} shape."""
    return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code)


async def state(request: Request):
    await ensure_state(request.app)
    return (
        request.app.state.http,
        request.app.state.provider,
        request.app.state.resolver,
        request.app.state.store,
    )


def error_response(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


def map_exception(exc: Exception) -> JSONResponse:
    if isinstance(exc, NotFoundError):
        return error_response(404, str(exc))
    if isinstance(exc, UpstreamBlocked):
        return error_response(503, "provider is blocking automated access — try again later")
    if isinstance(exc, NoStreamError):
        return error_response(404, str(exc))
    if isinstance(exc, (ProviderError, Exception)):
        return error_response(502, str(exc))
    return error_response(502, str(exc))


# ---------------- health ----------------


@app.get("/health")
async def health(request: Request) -> dict:
    http, _, _, store = await state(request)
    return {
        "ok": True,
        "version": app.version,
        "features": ["genres", "quality", "posters", "suggest"],
        "cached_html": len(http.html_cache._store),
        "cached_json": len(http.json_cache._store),
        "tracked_anime": len(store._data["progress"]),
    }


# ---------------- catalog ----------------


@app.get("/api/home")
async def home(request: Request):
    _, provider, _, _ = await state(request)
    try:
        sections = await provider.home()
    except Exception as exc:
        return map_exception(exc)
    return {"sections": [s.model_dump() for s in sections]}


@app.get("/api/search")
async def search(request: Request, q: str = Query(..., min_length=1)):
    _, provider, _, _ = await state(request)
    try:
        results = await provider.search(q)
    except Exception as exc:
        return map_exception(exc)
    return {"results": [r.model_dump() for r in results]}


async def _related_seasons(provider: Provider, anime_id: str, title: str):
    """Best-effort franchise entries from search (same as the site backend)."""
    try:
        all_results = await provider.search(title)
        return [r for r in all_results if r.id != anime_id][:12]
    except Exception:
        return []


@app.get("/api/genre/{genre}")
async def genre_browse(
    request: Request,
    genre: str,
    page: int = Query(1, ge=1, le=50, description="page number"),
):
    _, provider, _, _ = await state(request)
    try:
        results = await provider.browse_genre(genre, page)
    except Exception as exc:
        return map_exception(exc)
    return {
        "genre": genre,
        "page": page,
        "results": [r.model_dump() for r in results],
    }


@app.get("/api/anime/{anime_id}")
async def anime_details(request: Request, anime_id: str):
    http, provider, _, store = await state(request)
    if not is_valid_id(anime_id):
        return error_response(400, "invalid anime id")
    try:
        details = await provider.details(anime_id)
        episodes = await provider.episodes(anime_id)
    except Exception as exc:
        return map_exception(exc)

    # site contract: isFavorite + progress + seasons (franchise entries)
    related = await _related_seasons(provider, anime_id, details.title)
    progress = store.get_progress(anime_id)
    return {
        **details.model_dump(exclude={"seasons"}),
        "seasons": [r.model_dump() for r in related],
        "episodes": [e.model_dump() for e in episodes],
        "isFavorite": store.is_favorite(anime_id),
        "progress": progress.model_dump() if progress else None,
    }


@app.get("/api/anime/{anime_id}/episodes")
async def anime_episodes(request: Request, anime_id: str):
    _, provider, _, _ = await state(request)
    if not is_valid_id(anime_id):
        return error_response(400, "invalid anime id")
    try:
        episodes = await provider.episodes(anime_id)
    except Exception as exc:
        return map_exception(exc)
    return {"episodes": [e.model_dump() for e in episodes]}


# ---------------- streams ----------------


@app.get("/api/sources")
async def sources(
    request: Request,
    animeId: str = Query(..., description="anime slug id"),
    ep: str = Query(..., description="episode number as listed by /api/anime/{id}"),
    mode: AudioMode = Query("sub", description="sub or dub"),
    quality: str | None = Query(
        None,
        description='best | auto | "1080"/"720p" ... (default: best available)',
    ),
) -> ResolveResponse:
    _, provider, resolver, store = await state(request)
    if not is_valid_id(animeId):
        return error_response(400, "invalid anime id")

    try:
        episodes = await provider.episodes(animeId)
    except Exception as exc:
        return map_exception(exc)

    episode = next((e for e in episodes if e.number == ep), None)
    if episode is None:
        return error_response(404, "episode not found")

    try:
        details = await provider.details(animeId)
    except Exception:
        details = None

    try:
        resolution = await resolver.resolve(
            anime_id=animeId,
            episode=episode,
            mode=mode,
            quality=quality,
            anime_title=details.title if details else None,
        )
    except Exception as exc:
        return map_exception(exc)

    return ResolveResponse(**resolution.sources.model_dump(), resolver=resolution.info)


# ---------------- user data ----------------


@app.get("/api/progress")
async def progress_list(request: Request):
    http, provider, _, store = await state(request)
    items = store.list_progress()
    # backfill posters for entries saved before the poster field existed
    for e in items:
        if not e.poster:
            e.poster = await _poster_for(http, provider, e.anime_id)
            if e.poster:
                store.save_progress(e, e.poster)
    return {"items": [e.model_dump() for e in items]}


@app.post("/api/progress")
async def progress_save(request: Request):
    http, provider, _, store = await state(request)
    try:
        body = await request.json()
        entry = ProgressEntry.model_validate(body)
    except Exception:
        return error_response(400, "invalid progress payload")
    poster = entry.poster or await _poster_for(http, provider, entry.anime_id)
    store.save_progress(entry, poster)
    return {"ok": True}


@app.delete("/api/progress/{anime_id}")
async def progress_delete(request: Request, anime_id: str):
    _, _, _, store = await state(request)
    store.delete_progress(anime_id)
    return {"ok": True}


@app.get("/api/favorites")
async def favorites_list(request: Request):
    http, provider, _, store = await state(request)
    items = store.list_favorites()
    for e in items:
        if not e.poster:
            e.poster = await _poster_for(http, provider, e.anime_id)
            if e.poster:
                store.add_favorite(e.anime_id, e.anime_title, e.poster)
    return {"items": [e.model_dump() for e in items]}


@app.post("/api/favorites")
async def favorites_add(request: Request, body: dict):
    http, provider, _, store = await state(request)
    anime_id = body.get("animeId")
    if not anime_id:
        return error_response(400, "animeId required")
    poster = body.get("poster") or await _poster_for(http, provider, anime_id)
    store.add_favorite(anime_id, body.get("animeTitle") or anime_id, poster)
    return {"ok": True}


@app.delete("/api/favorites/{anime_id}")
async def favorites_remove(request: Request, anime_id: str):
    _, _, _, store = await state(request)
    store.remove_favorite(anime_id)
    return {"ok": True}


# ---------------- proxies ----------------


@app.get("/stream/{encoded_url:path}")
async def stream(request: Request, encoded_url: str, ref: str | None = Query(None)):
    http, _, _, _ = await state(request)
    return await proxy_stream(http, request, encoded_url, ref)


@app.get("/img/{encoded_url:path}")
async def img(request: Request, encoded_url: str):
    http, _, _, _ = await state(request)
    return await proxy_image(http, encoded_url)


# ---------------- static client (production-style) ----------------

# Serve the built anime-site (vite build output) if available: env override,
# then the sibling anime-site/dist, else a JSON root.
def _dist_dir() -> str | None:
    # src/anime_api/main.py -> src/anime_api -> src -> anime-api -> workspace
    workspace = os.path.dirname(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    )
    candidates = [
        os.environ.get("ANIME_API_DIST_DIR"),
        os.path.join(workspace, "anime-site", "dist"),
    ]
    for c in candidates:
        if c and os.path.isdir(c):
            return c
    return None


_DIST = _dist_dir()

if _DIST:

    class SPAStaticFiles(StaticFiles):
        """Serve static files, falling back to index.html (SPA)."""

        async def get_response(self, path: str, scope):
            try:
                response = await super().get_response(path, scope)
            except StarletteHTTPException as exc:
                if exc.status_code == 404 and not path.startswith(("api/", "stream/", "img/")):
                    return await super().get_response("index.html", scope)
                raise
            if response.status_code == 404 and not path.startswith(("api/", "stream/", "img/")):
                return await super().get_response("index.html", scope)
            return response

    app.mount("/", SPAStaticFiles(directory=_DIST, html=True), name="site")
else:
    @app.get("/")
    async def root():
        return {
            "service": "anime-api",
            "version": app.version,
            "docs": "/docs",
            "health": "/health",
        }


def main() -> None:
    import uvicorn

    uvicorn.run("anime_api.main:app", host="0.0.0.0", port=8000, reload=False)


if __name__ == "__main__":
    main()
