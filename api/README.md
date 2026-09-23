# anime-api

Standalone anime streaming API (Python 3.12+ / FastAPI / httpx) with
**multi-server stream resolution** and **quality selection**.

Verified working end-to-end (2026-09-23): search → details → episodes →
sources (1080p/720p/360p, sub + dub) → HLS proxy (playlists, segments,
subtitles) → cover-image proxy. **Now also serves the anime-site frontend**
(see *Serving the anime-site* below).

---

## Why this API

Most "anime API" projects return a single stream link and call it done. This
one treats **quality** and **reliability** as first-class:

- **Multi-server resolution** — the provider advertises several embed servers
  per episode (ZokoAnime, HD-1, Vidstream, …). The resolver tries them in
  preference order and returns the first that yields a playable master
  playlist, with a per-server error trace for observability. One dead server
  never breaks playback.
- **Full quality enumeration** — every `#EXT-X-STREAM-INF` variant
  (360p–1080p) is parsed, normalized (height + label) and sorted best → worst.
  The response contains `best`, `variants[]`, `preferred_url` and a
  `quality_pick` record showing exactly how the served quality was chosen.
- **Quality pinning** — `?quality=1080` (or `1080p`) serves that height; if
  unavailable it falls back to the closest lower variant and reports
  `strategy: "fallback"`. `?quality=best` (default) serves the top variant.
- **Adaptive playback** — the proxied `master_url` lets players (hls.js /
  Safari) switch quality mid-stream instead of stalling when bandwidth dips.

## Endpoints

See **[STATUS.md](../STATUS.md)** for the full project status page (feature
matrix, architecture diagram, troubleshooting) — this file stays focused on
the API itself.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness + cache stats |
| GET | `/api/home` | catalog rails (trending, latest, new, top-10 day/week/month, upcoming) |
| GET | `/api/search?q=` | catalog search |
| GET | `/api/anime/{id}` | details + episode list |
| GET | `/api/genre/{genre}?page=` | genre browse via the provider's `/filter` endpoint (accepts display names: `Sci-Fi`, `Slice of Life`, …) |
| GET | `/api/anime/{id}/episodes` | episode list only |
| GET | `/api/sources?animeId=&ep=&mode=sub\|dub&quality=` | **stream resolution** (see below) |
| GET | `/stream/<urlencoded-url>?ref=` | HLS proxy (playlist rewrite + segment pipe, Range-aware) |
| GET | `/img/<urlencoded-url>` | cover-image proxy (host allowlist) |

Interactive OpenAPI docs ship automatically at `/docs`.

## Quickstart

```bash
uv sync
uv run anime-api           # http://localhost:8000  ·  docs at /docs
```

or `uvicorn anime_api.main:app --port 8000`.

### Example session

```bash
# 1) search
curl -s 'localhost:8000/api/search?q=frieren' | jq '.results[0]'
# → {"id":"frieren-beyond-journeys-end-481","title":"Frieren: Beyond Journey's End", ...}

# 2) sources — best quality by default
curl -s 'localhost:8000/api/sources?animeId=frieren-beyond-journeys-end-481&ep=1&mode=sub' | jq '{
  server, mode,
  variants: [.variants[].quality],   # ["1080p","720p","360p"]
  best: .best.quality,               # "1080p"
  preferred_url,                     # play this
  master_url,                        # or this for adaptive (hls.js)
  quality_pick,                      # {strategy:"best", served:"1080p"}
  subtitles
}'

# 3) pin a quality
curl -s 'localhost:8000/api/sources?animeId=...&ep=1&quality=720' | jq '.quality_pick'
# → {"strategy":"explicit","requested":"720","served":"720p"}

# 4) play — preferred_url / master_url work in any HLS player as-is
# <video src="http://localhost:8000{master_url}"> with hls.js or Safari
```

### `quality` parameter

| Value | Behaviour |
|---|---|
| *(unset)* / `best` / `auto` | highest available variant |
| `1080`, `720p`, … | exact height, else **closest lower** (`strategy:"fallback"`) |
| anything unparseable | best (no error) |

`quality_pick` in every response records `strategy`, `requested` and `served`,
so clients can display "1080p not available — serving 720p" honestly.

### Resolver trace

Every `/api/sources` response carries `resolver`:

```json
{
  "servers_seen": ["ZokoAnime", "HD-1", "Vidstream-2"],
  "servers_tried": ["ZokoAnime"],
  "server_used": "ZokoAnime",
  "errors": { "HD-1": "embed config blob not found" }
}
```

`errors` maps skipped servers to the reason they were skipped — invaluable
when a provider changes their embed format.

## How it works

```
/api/sources?animeId&ep&mode
  1. episode list API      → numeric episode id
  2. servers API           → embed servers for sub|dub (ZokoAnime first)
  3. base64(hash)          → embed page URL
  4. window.__P blob       → base64 + XOR "otaku-embed-v1" → JSON config
  5. config                → master m3u8 + subtitle tracks
  6. master playlist       → variants[] sorted best → worst
  → first server with a playable master wins; errors recorded, next tried
```

The upstream video CDN (`hls.1embed.buzz`) **403s without the embed site's
Referer** and sends no CORS headers, so every stream URL is wrapped as
`/stream/<enc>?ref=<embed-origin>`. The proxy:

- rewrites every URI in playlists (variants, segments, `EXT-X-KEY`/`MAP`
  attributes) so nested requests keep flowing through it,
- propagates the Referer upstream, falling back through the target origin and
  known embed origins on 403,
- pipes segments with `Range`/`Accept-Ranges`/`Content-Range` support (seeking
  works) and proper `Content-Type`,
- sets `Cache-Control: no-store` on playlists (live-changing) while letting
  segments be cached upstream.

## Errors

| HTTP | Meaning |
|---|---|
| 400 | invalid anime id / bad proxy path |
| 404 | anime, episode, or audio mode not found (`No dub available…`); empty genre page |
| 502 | provider unreachable / resolver failure / genre blocked after retry |
| 503 | provider is blocking automated access (Cloudflare) |

Every error body is `{"error": "<human message>"}` — never FastAPI's native
`{"detail": ...}`, so clients can always surface a meaningful message.
`/health` reports `features` so the frontend can detect a stale server.

## Serving the anime-site

The API implements the anime-site backend contract (camelCase JSON,
`/api/progress`, `/api/favorites`, `isFavorite`/`progress` on the details
response), so it can replace the Node backend entirely:

```bash
# dev: vite on :5173 proxies /api + /stream + /img to :8000
cd ../anime-site && npm run dev
cd ../anime-api  && uv run anime-api   # both terminals

# production-style: one process serves site + API on :8000
cd ../anime-site && npm run build      # writes dist/
cd ../anime-api  && uv run anime-api   # auto-detects ../anime-site/dist
```

> **Run only ONE backend.** The legacy Node backend (`:8787`) has no
> `/api/genre` or `/img` routes — if the dev proxy or a stale process points
> the site at it, every genre/image request 404s. Check with
> `ss -tlnp | grep -E '8000|8787'`.

The dist directory is resolved from `ANIME_API_DIST_DIR` or the sibling
`anime-site/dist`. SPA routes fall back to `index.html`; `/api`, `/stream`
and `/img` keep JSON 404s.

Progress and favorites live in `server/data/store.json` (path shared with
the Node backend via `ANISTREAM_DATA_DIR`), so watch history survives
switching backends.

## Layout

```
src/anime_api/
  http.py       shared async client: browser headers, retries, TTL caches
  provider.py   hianime.at scraping: search, home, details, episodes, servers
  resolver.py   multi-server resolution, blob deobfuscation, quality picking
  proxy.py      HLS proxy (m3u8 rewrite + segment pipe) + image proxy
  models.py     Pydantic response models
  main.py       FastAPI app + routes
tests/          26 offline tests (parsers, quality logic, m3u8 rewriting)
```

## Tests

```bash
uv run pytest -q        # 26 passed — no network needed
```

## Notes

- One provider (hianime.at) is implemented; `Provider` and `StreamResolver`
  are separated so additional providers can be added behind the same models.
- Hot paths (search, home, details, episodes, master playlists) are cached
  in-process with short TTLs; server-specific pages are not cached.
- The `/img` proxy allowlists known cover hosts (hianime, anipixcdn, anilist,
  myanimelist, kitsu) — extend `IMAGE_HOST_ALLOWLIST` as needed.
