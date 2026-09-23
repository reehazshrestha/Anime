# AniStream — Project Documentation

**Status: ✅ Production-ready (local) · Last verified: 2026-09-23**

A self-hosted anime discovery & streaming platform, split into two projects:

| Project | Stack | Role |
|---|---|---|
| `anime-api/` | Python 3.12+ · FastAPI · httpx · uv | Streaming API: catalog, multi-server stream resolution, quality selection, HLS proxy, user data. Also serves the built frontend. |
| `anime-site/` | React 19 · TypeScript · Vite · lucide-react | The website: cinematic UI, sidebar layout, search with live suggestions, discover, library, watch page. |

One command runs everything: `cd anime-api && uv run anime-api` → **http://localhost:8000**

---

## 1. Status at a glance

### Backend (`anime-api`)

| Feature | Status | Notes |
|---|---|---|
| Catalog: home rails, search, details, episodes | ✅ Working | hianime.at provider, HTML parsing, TTL-cached |
| Genre browsing | ✅ Working | `/api/genre/{genre}?page=N` via provider `/filter` endpoint; verified 12 consecutive page hits: 12× 200 |
| Search suggestions | ✅ Working | Debounced client → `/api/search`, cached server-side |
| **Multi-server stream resolution** | ✅ Working | ZokoAnime → HD-1 → Vidstream, first playable wins, per-server error trace |
| **Quality enumeration + pinning** | ✅ Working | 360p–1080p parsed from master playlist; `?quality=1080` pins, `?quality=480` falls back with `strategy: "fallback"` |
| Sub + dub modes | ✅ Working | `?mode=dub` resolves a dub server when the anime has one |
| **HLS proxy** | ✅ Working | Playlists rewritten in-flight, segments/subtitles piped with Range (seek) support, Referer propagation |
| Image proxy | ✅ Working | `/img/<url>` with CDN host allowlist |
| User data: progress, favorites, continue-watching | ✅ Working | Persisted to `anime-api/data/store.json`; **posters captured + auto-backfilled** so library banners always render |
| Feature detection | ✅ Working | `/health` reports `"features": ["genres","quality","posters","suggest"]` so the frontend can detect a stale server |
| Resilience | ✅ Working | Retries transient 5xx/connection errors; genre browse retries once, then 502; all errors speak `{"error": ...}`; **all 12 Discover genre names verified 200** (incl. `Sci-Fi`, `Slice of Life`) and pages 1–50 |

### Frontend (`anime-site`)

| Area | Status | Notes |
|---|---|---|
| Design system | ✅ | Cinematic dark palette (`#08090D` / accent `#A855F7`), Inter, 4/8 spacing scale, consistent radii, light theme flip, reduced-motion support |
| Layout | ✅ | Persistent sidebar (desktop ≥900px), top bar with ⌘K search, bottom nav + hamburger drawer (mobile only — hidden on desktop via `display:none !important`) |
| Theme toggle | ✅ | Module-level store (`useSyncExternalStore`) — TopBar/Settings stay in sync, persists to localStorage, no flash on load |
| Home | ✅ | Cinematic featured hero (trending #1, backdrop + CTAs), continue-watching hero with progress bar, rails with X-axis scroll arrows, genre strip, footer |
| Search | ✅ | Live suggestion dropdown (poster + title, debounced 250 ms, keyboard navigable), full results page with skeletons / empty / error states |
| Discover | ✅ | Genre chips, sort, pagination (load more), retry on failure; stale-backend detection shows a "restart the API" hint instead of a raw 404 |
| Genres | ✅ | 12-tile directory + lazy-loading preview shelves (IntersectionObserver), per-shelf failure isolation |
| Anime details | ✅ | Cinematic backdrop, poster, genres/rating/status, Watch Now + Add to List, season chips, episode rows with watched ticks, chunked pagination tabs (handles 1000+ eps) |
| Watch page | ✅ | hls.js player (kept intact through all redesigns), quality/sub-dub controls, chunked episode sidebar, next/prev |
| Library / Continue / History / Settings | ✅ | Real posters (backend backfills old entries), empty states with icons + CTAs |
| Responsive | ✅ | Verified at 1920/1440/1280/1024/768/390 px |

### Test & verification matrix

| Suite | Command | Result |
|---|---|---|
| API unit tests (offline) | `cd anime-api && uv run pytest -q` | **35 passed** |
| Site typecheck | `cd anime-site && npx tsc --noEmit` | **0 errors** |
| Site tests | `cd anime-site && npm test` | **12 passed** |
| Production build | `cd anime-site && npm run build` | ✅ (~84 KB gzip main bundle) |
| Live route audit (12 routes) | see §6 | all 200 |
| Live playback chain | master → variant playlist → segment | ✅ real MPEG-TS bytes served |

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  Browser — anime-site (React + Vite build, served by FastAPI)      │
│  Sidebar · TopBar (⌘K) · MobileNav · pages use hooks/useAnime.ts   │
└───────────────┬────────────────────────────────────────────────────┘
                │  /api/*  /stream/*  /img/*   (same origin; Vite proxies in dev)
┌───────────────▼────────────────────────────────────────────────────┐
│  anime-api (FastAPI, :8000)                                        │
│  main.py      routes + static serving + SPA fallback                │
│  provider.py  catalog scraping (search/home/details/episodes/genre)│
│  resolver.py  multi-server resolution + quality pick                │
│  proxy.py     m3u8 rewriting, segment piping, image allowlist       │
│  http.py      browser headers, retries, TTL cache                   │
│  store.py     progress/favorites JSON store (debounced writes)      │
└───────────────┬────────────────────────────────────────────────────┘
                │  httpx (browser-ish headers, Referer checks)
        ┌───────▼────────┐   ┌──────────────────────────────┐
        │  hianime.at    │   │  video CDN (hls.1embed.buzz) │
        │  (Cloudflare)  │   │  demands embed Referer       │
        └────────────────┘   └──────────────────────────────┘
```

**Why everything is proxied:** the video CDN 403s without the embed site's
`Referer` and sends no CORS headers. Every stream URL returned by the API is a
`/stream/<encoded>?ref=` URL; playlists are rewritten so nested URLs keep
flowing through the proxy.

**Data flow for playback:**
`/api/sources` → resolver tries servers → parses master playlist variants →
returns `best`/`variants` + proxied `master_url` → player (hls.js) requests the
playlist → proxy rewrites it → segments piped with Range support.

---

## 3. API reference

Base URL: `http://localhost:8000` · Interactive docs: **`/docs`** (Swagger) · **`/redoc`**

### Catalog

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness, `features[]`, cache stats |
| GET | `/api/home` | Rails: trending, latest episode, new releases, top-10 day/week/month, upcoming |
| GET | `/api/search?q=&page=` | Search; supports suggestions-style light queries |
| GET | `/api/genre/{genre}?page=` | Genre browse (30/page) — `action`, `adventure`, `comedy`, `drama`, `sports`, `isekai`, `romance`, `sci-fi`, `thriller`, `psychological`, `mecha`, `shounen`… |
| GET | `/api/anime/{anime_id}` | Details + episodes + `seasons[]` + user context (`isFavorite`, `progress`) |
| GET | `/api/anime/{anime_id}/episodes` | Episode list only |

### Streaming

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/sources?animeId=&ep=&mode=sub\|dub&quality=best\|1080\|720…` | Resolve stream: server, `variants[]`, `best`, `quality_pick`, `master_url`, subtitles |
| GET | `/stream/{encoded_url}?ref=` | HLS proxy: playlists (rewritten), segments, subtitles — Range supported |
| GET | `/img/{encoded_url}` | Cover-image proxy (allowlisted hosts) |

### User data

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/progress` | Get all progress / save `{animeId, animeTitle, poster, episodeNumber, episodeCount, positionSeconds, durationSeconds, watchedEpisodes}` |
| DELETE | `/api/progress/{anime_id}` | Clear one anime's progress |
| GET / POST | `/api/favorites` | Get / add favorite (`{animeId, animeTitle, poster}`) |
| DELETE | `/api/favorites/{anime_id}` | Remove favorite |

All errors return `{"error": "<human message>"}` with a meaningful status:
`400` bad input, `404` not found, `502` provider broken, `503` Cloudflare
challenge. Never a raw FastAPI `{"detail": ...}`.

### Example

```bash
curl -s "localhost:8000/api/sources?animeId=frieren-beyond-journeys-end-481&ep=1" \
  | jq '{server, qualities: [.variants[].quality], best: .best.quality, master_url}'
```

---

## 4. Website pages & routes

Hash routing (works from the static build with zero server config):

| Route | Page |
|---|---|
| `#/` | Home — featured hero, continue watching, rails, genres, footer |
| `#/discover` | Discover — genre chips, sort, load-more grid |
| `#/trending` | Trending — editorial ranked (01–10) |
| `#/genres`, `#/genre/{name}` | Genre directory + browse |
| `#/anime/{id}` | Details — hero, actions, season chips, chunked episode tabs |
| `#/watch/{id}/{ep}` | Player — hls.js, quality/dub controls, episode sidebar |
| `#/library` | My List (favorites) |
| `#/continue` | Continue watching |
| `#/history` | Watch history |
| `#/settings` | Theme, storage info |

### Component map

```
src/
├── App.tsx                  # shell: sidebar + topbar + routes + SPA fallback
├── theme.ts                 # module-level theme store (useSyncExternalStore)
├── api.ts                   # typed client, stale-backend detection
├── hooks/useAnime.ts        # data layer: useHome, useSearchResults, useGenreResults, …
├── components/
│   ├── layout/  Sidebar · TopBar (⌘K) · MobileNav (drawer + bottom nav)
│   ├── ui/      primitives.tsx (skeletons, EmptyState)
│   ├── AnimeCard · Rail · ContinueWatchingHero · EpisodePager
│   └── pages: Home · Discover · Trending · Library · Search · AnimeDetails · Watch
```

---

## 5. Running it

### Production-style (single process)

```bash
cd anime-site && npm run build      # once, or after frontend changes
cd ../anime-api && uv run anime-api # serves site + API on http://localhost:8000
```

FastAPI auto-detects `../anime-site/dist` and serves it with an SPA fallback;
API 404s stay JSON.

### Development (hot reload, two terminals)

```bash
cd anime-api  && uv run anime-api   # API on :8000
cd anime-site && npm run dev        # Vite on :5173, proxies to :8000
```

### Requirements

- Python 3.12+ with [uv](https://docs.astral.sh/uv/)
- Node 18+ with npm
- A network where **hianime.at** loads normally (the provider sits behind Cloudflare)

---

## 6. Testing & verification

```bash
# Offline tests
cd anime-api  && uv run pytest -q        # 35 tests: parser/resolver/proxy/contract
cd anime-site && npx tsc --noEmit        # typecheck
cd anime-site && npm test                # 12 tests (parse + store logic)

# Live smoke (server running)
curl -s localhost:8000/health | jq       # → {"ok":true,"features":[…]}
curl -s "localhost:8000/api/search?q=frieren" | jq '.results[0].title'
curl -s "localhost:8000/api/genre/action" | jq '.results | length'   # → 30
curl -s "localhost:8000/api/sources?animeId=frieren-beyond-journeys-end-481&ep=1" \
  | jq '{best: .best.quality, variants: [.variants[].quality]}'
```

Then play it for real: take `master_url` from the sources response and open it
in VLC (Media → Open Network Stream), or just press play on the watch page.

---

## 7. Known limitations

- **Discover year/season/status filters** are UI-only — the provider's filter
  endpoint exposes genre + page reliably; the others aren't wired.
- **Sort** beyond A–Z relies on provider ordering.
- **Provider dependency**: everything comes from hianime.at. If it changes its
  markup, the relevant parser needs updating (tests will show exactly which).
- **Single-user** user-data store (JSON file, no auth). Fine for local/personal
  use; not multi-tenant.
- **Latest-verified date matters**: parsers rot when the provider changes.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Discover/genre shows `endpoint not found … site is not talking to anime-api` | Request hit the **legacy Node backend (:8787)** or a stale process — it 404s `/api/genre` and `/img` with an HTML page | Start the right backend: `cd anime-api && uv run anime-api`; stop strays (`ss -tlnp \| grep -E '8000\|8787'`); never point `BACKEND_ORIGIN` at :8787 || Any page says *"the API server looks out of date"* or a raw `request failed (404)` with JSON `{detail}` | A **stale anime-api process** from before a feature was added is still holding :8000 | `kill` it and restart: `cd anime-api && uv run anime-api` (check `/health` → `features` to confirm) |
| `503 provider is blocking automated access` | Cloudflare challenge on your IP | Wait, or run from a network where hianime.at works in your browser |
| Banners missing in My List / Continue / History | Store entry predates poster capture | Auto-backfills on first GET with the new server — restart the API and refresh |
| Port 8000 already in use | Old process | `kill $(ss -tlnp \| grep :8000 \| grep -oP 'pid=\K[0-9]+' \| sort -u)` |
| Segment/seek fails | Upstream CDN hiccup | Retry; resolver picks another server on next `/api/sources` call |

---

## 9. Deploying the API to Vercel

The API deploys to **Vercel serverless functions** (Python runtime) as-is.
Vercel detects the FastAPI app from `pyproject.toml`:

```toml
[tool.vercel]
entrypoint = "src.anime_api.main:app"
```

| File | Purpose |
|---|---|
| `api/pyproject.toml` | declares the Vercel entrypoint: `[tool.vercel] entrypoint = "src.anime_api.main:app"` |
| `api/vercel.json` | `maxDuration: 60` for the function so stream proxying has room (no rewrites needed — Vercel auto-routes to the declared FastAPI app) |
| `anime-api/requirements.txt` | deps for Vercel's Python build (fastapi, httpx, uvicorn) |
| `anime-api/.vercelignore` | keeps venv/tests/data out of the upload |

Code changes that make serverless work: state init is now **lazy**
(`ensure_state` on first request — Vercel doesn't run FastAPI lifespans), the
store **falls back to a writable temp dir** when the filesystem is read-only,
and **CORS is open** (`allow_origins=["*"]`) so remote frontends can call the
API. Lock `allow_origins` down to your real site origin before sharing the
URL publicly.

### Deploy steps

**CLI (fastest):**
```bash
npm i -g vercel
cd anime-api
vercel login
vercel --prod          # accepts the default project settings
# → https://<project>.vercel.app  ·  check /health → features[]
```

**Git:** push the repo, then in the Vercel dashboard *Add New Project →*
import it, set **Root Directory = `anime-api`**, framework "Other", and
deploy.

Optional env var: `ANISTREAM_DATA_DIR` is ignored on Vercel (read-only FS —
progress/favorites live in an ephemeral temp dir per warm instance).

### Serverless caveats (know before sharing the link)

| Caveat | Impact |
|---|---|
| **Ephemeral user data** | progress/favorites reset when a warm instance is recycled. For real persistence, point the store at a database (Vercel Postgres/Upstash) — the store class is the only thing to swap |
| **Cold starts** | first hit after idle takes a few seconds |
| **Long playback** | `maxDuration: 60` covers API + resolver calls; video **segments** flow direct from CDN to the player, but proxied segments on very slow links could hit the limit |
| **Provider blocks datacenter IPs** | Cloudflare may challenge Vercel's IPs → `/api/*` returns 503. The local deployment is immune; this is the main risk of any cloud deploy |
| **Open CORS** | fine for private use; restrict before going public |

For 24/7 personal use, **the local/`uv run anime-api` deployment is still the
best option** (no serverless limits, your IP, persistent store). Vercel is
for sharing the API with others or trying it without running a machine.

## 10. Legacy Node backend bridge

The old `anime-site/server/` backend (`npm start`, port 8787) no longer 404s
routes it doesn't implement. Any unhandled `/api/*` request — and all `/img`
requests — are **bridged to anime-api on :8000** (overridable with
`ANIME_API_ORIGIN`). Verified: `/api/genre/Action` and poster proxying return
real data through :8787 when anime-api is running.

| Route on :8787 | Behavior |
|---|---|
| Implemented legacy routes (search, home, anime, sources, progress, favorites, stream) | served natively |
| `/img/*` | anime-api first, legacy handler as fallback |
| Other `/api/*` (e.g. `/api/genre`) | bridged to anime-api; clean JSON 404 if it's down |
| Everything else | static `dist/` + SPA fallback |

## 11. Project structure

```
anime-api/
├── pyproject.toml            # uv project, deps: fastapi, httpx, uvicorn, pydantic
├── vercel.json               # serverless config (see §9)
├── src/anime_api/
│   ├── main.py               # routes, static serving, SPA fallback
│   ├── provider.py           # catalog scraping + parsing
│   ├── resolver.py           # multi-server resolution, quality selection
│   ├── proxy.py              # HLS proxy, m3u8 rewriter, image allowlist
│   ├── http.py               # shared client: headers, retries, TTL cache
│   ├── store.py              # progress/favorites persistence
│   └── models.py             # pydantic models, camelCase JSON aliases
├── tests/                    # 35 offline tests
└── data/store.json           # user data (created at runtime)

anime-site/
├── index.html                # fonts + no-FOUC theme boot script
├── vite.config.ts            # dev proxy → :8000
├── src/ …                    # see §4 component map
├── shared/types.ts           # shared API types
├── tests/                    # 12 offline tests
└── dist/                     # production build (served by the API)
```
