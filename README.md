<div align="center">

# 🌌 AniStream

**A self-hosted anime discovery & streaming platform.**

FastAPI streaming API · React 19 cinematic UI · multi-server resolution · 360p–1080p quality selection · HLS proxy · sub & dub

</div>

---

## ✨ What is this?

AniStream is two projects in one repo:

| | Project | Stack | What it does |
|---|---|---|---|
| 🐍 | [`api/`](api) | Python 3.12+ · FastAPI · httpx | The streaming engine: catalog scraping, **multi-server stream resolution**, **quality enumeration & pinning**, an **HLS proxy** that makes playlists actually playable, plus watch-progress & favorites storage. Also serves the built website. |
| ⚛️ | [`site/`](site) | React 19 · TypeScript · Vite | The experience: cinematic dark UI, sidebar layout, ⌘K search with live suggestions, Discover, genre shelves, chunked episode tabs (survives 1000+ episode shows), hls.js player. |

One command runs everything locally:

```bash
cd api && uv run anime-api   # → http://localhost:8000
```

> 📄 Full status, endpoint reference, architecture and troubleshooting live in **[STATUS.md](STATUS.md)**.

---

## 🎬 Feature highlights

- **Multi-server resolution** — every embed server (ZokoAnime, HD-1, Vidstream…) is tried in order until one yields a playable stream; per-server error trace included.
- **Real quality control** — all HLS variants (360p–1080p) are enumerated and sorted. Pin a quality (`?quality=720`) or serve the best automatically; players can switch adaptively via the proxied master playlist.
- **HLS proxy** — the upstream CDN requires an embed `Referer` and sends no CORS headers, so every playlist is rewritten in-flight and segments are piped with Range (seek) support.
- **Sub & dub** — per-episode audio mode with graceful fallback messaging.
- **Progress & favorites** — resume where you left off, watched ticks, "continue watching" hero. Stored **privately in the visitor's browser** (localStorage) — no accounts, nothing leaves the device.
- **Search that feels instant** — debounced live suggestions with posters while you type.
- **Built to be tested** — 35 offline API tests, 12 site tests, strict TypeScript.

---

## 🚀 Quickstart

**Requirements:** Python 3.12+ with [uv](https://docs.astral.sh/uv/) · Node 18+ · a network where the provider is reachable.

### Run it (production-style, one process)

```bash
git clone https://github.com/reehazshrestha/Anime.git
cd Anime/api
uv sync
uv run anime-api          # site + API on http://localhost:8000
```

The API auto-detects `../site/dist` and serves the website. On first run, build the site once for the full experience:

```bash
cd ../site && npm install && npm run build
```

### Develop (hot reload, two terminals)

```bash
cd api  && uv run anime-api   # API on :8000
cd site && npm run dev        # Vite on :5173 (proxies to :8000)
```

### Deploy the API to Vercel

```bash
npm i -g vercel
cd api
vercel login && vercel --prod
```

See [STATUS.md §9](STATUS.md) for serverless caveats (ephemeral storage, provider IP blocking, cold starts).

---

## 🔌 API in one minute

Interactive docs ship at `/docs` (Swagger) and `/redoc`.

```bash
curl -s "localhost:8000/api/search?q=frieren" | jq '.results[0].title'
curl -s "localhost:8000/api/genre/action" | jq '.results | length'      # 30
curl -s "localhost:8000/api/sources?animeId=frieren-beyond-journeys-end-481&ep=1" \
  | jq '{server, qualities: [.variants[].quality], best: .best.quality}'
```

| Area | Endpoints |
|---|---|
| Catalog | `/api/home` · `/api/search?q=` · `/api/genre/{genre}?page=` · `/api/anime/{id}` · `/api/anime/{id}/episodes` |
| Streaming | `/api/sources?animeId=&ep=&mode=sub\|dub&quality=` · `/stream/<enc>?ref=` · `/img/<enc>` |
| User data | `/api/progress` (GET/POST/DELETE) · `/api/favorites` (GET/POST/DELETE) |
| Meta | `/health` (feature flags) · `/docs` · `/redoc` |

Every error speaks `{ "error": "<human message>" }` — never raw framework noise.

---

## 🧪 Tests & verification

```bash
cd api  && uv run pytest -q        # 35 offline tests (parsers, resolver, proxy, contracts)
cd site && npx tsc --noEmit        # strict typecheck
cd site && npm test                # 12 offline tests
```

---

## 📁 Repository layout

```
Anime/
├── api/            # FastAPI streaming backend (Vercel-ready)
│   ├── src/anime_api/    main · provider · resolver · proxy · http · store · models
│   └── tests/            # pytest suite
├── site/           # React + Vite frontend
│   └── src/              components · layout · hooks · ui primitives
└── STATUS.md       # full project status & operations doc
```

---

## ⚠️ Notes & limitations

- **Content source**: all catalog and stream data comes from a third-party provider (hianime.at) which sits behind Cloudflare. Parsers may need updates if its markup changes; cloud IPs are more likely to be challenged (→ `503`).
- **Personal use** — progress/favorites are stored in a local JSON file, no auth. This project streams from public sources; support the official releases of the anime you love.
- Year/season/status filters in Discover are UI-only (the provider exposes genre + page).

---

<div align="center">

Built with FastAPI · httpx · React 19 · Vite · hls.js · lucide-react

</div>
