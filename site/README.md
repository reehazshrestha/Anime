# AniStream

A local anime discovery & streaming website — React 19 + TypeScript + Vite.

**Primary backend: [`anime-api`](../anime-api) (FastAPI, port 8000)** — multi-server
stream resolution, quality selection, genre browsing, HLS proxy and user-data
storage. It also serves this site's production build, so one process runs
everything.

> A legacy Node backend lives in this repo's `server/` (ani-cli port, port
> 8787). It still works for basic playback but **does not implement the newer
> routes** (`/api/genre`, `/img` backfill, `features` health) — running the
> site against it will 404 on Discover/genre and poster proxying.

## Pages

| Route | Page |
|---|---|
| `#/` | Home — featured hero, continue watching, rails with scroll arrows, genres |
| `#/discover` | Discover — genre chips, sort, load-more grid |
| `#/trending` | Trending — editorial ranked (01–10) |
| `#/genres` · `#/genre/{name}` | Genre directory + lazy preview shelves / browse |
| `#/anime/{id}` | Details — cinematic backdrop, season chips, chunked episode tabs |
| `#/watch/{id}/{ep}` | Player — hls.js, quality & sub/dub controls, episode sidebar |
| `#/library` · `#/continue` · `#/history` | Favorites, resume, watch history |
| `#/settings` | Theme + storage |

Dark/light themes with no flash on load (boot script in `index.html`); the
toggle lives in the top bar and Settings and stays in sync via a module-level
store. Mobile (≤900px) swaps the sidebar for a bottom nav + hamburger drawer.

## Requirements

- Node 18+
- `anime-api` running (see its README): `cd ../anime-api && uv run anime-api`

## Run (dev)

```bash
npm install
npm run dev          # site on :5173, proxies /api /stream /img → :8000
```

The proxy target is `http://127.0.0.1:8000` by default; override with
`BACKEND_ORIGIN=http://127.0.0.1:8787 npm run dev` only if you really want the
legacy backend.

## Run (production-style)

```bash
npm run build        # tsc --noEmit && vite build → dist/
cd ../anime-api && uv run anime-api    # serves dist/ + API on :8000
```

### Deploy the site itself (works on every device)

`site/` is also a Vercel project (static + SPA fallback). Production builds
bake the deployed API URL in via `.env.production` (`VITE_API_BASE`), so
once deployed, the site works on phones/laptops out of the box — no local
server needed:

```bash
npm i -g vercel
cd site
vercel --prod        # → https://<site-project>.vercel.app
```

Visitors can still point their browser at a different backend via
**Settings → Streaming backend** (localStorage), which overrides the baked
URL.

## Architecture

```
src/
├── App.tsx                  # shell: Sidebar + TopBar + routes + SPA fallback
├── theme.ts                 # module-level theme store (useSyncExternalStore)
├── api.ts                   # typed client + stale-backend detection
├── hooks/useAnime.ts        # data layer (useHome, useGenreResults, …)
├── components/
│   ├── layout/              # Sidebar · TopBar (⌘K search + suggestions) · MobileNav
│   ├── ui/primitives.tsx    # skeletons, EmptyState
│   ├── AnimeCard · Rail · ContinueWatchingHero · EpisodePager
│   └── pages: Home · Discover · Trending · Library · Search · AnimeDetails · Watch
├── shared/types.ts          # API response types
└── index.css                # design tokens (dark/light), layout, components
```

Guiding rules: UI never calls `fetch` directly (goes through `api.ts` +
hooks), every async page has loading/empty/error states, and the watch page's
hls.js player logic is kept independent of styling.

## Error messages that mean what they say

- `endpoint not found (/api/genre/...) — the site is not talking to anime-api`
  → a stale or wrong backend answered (usually the legacy :8787 one). Start
  the right one: `cd ../anime-api && uv run anime-api`.
- `... the API server looks out of date. Restart it` → FastAPI's native
  `{"detail": ...}` 404 body was seen, i.e. an old anime-api build without the
  route. Restart it and check `curl localhost:8000/health` shows `features`.
- `provider is blocking...` → Cloudflare challenge; retry later.
- Run **only one** backend per port; check with `ss -tlnp | grep -E '8000|8787'`.

## Env

| Var | Default | Purpose |
|---|---|---|
| `BACKEND_ORIGIN` | `http://127.0.0.1:8000` | dev-proxy target |
| `VITE_API_BASE` | `https://anime-api-rho-three.vercel.app` in production builds (`.env.production`), same origin otherwise | API the site talks to. Runtime override: **Settings → Streaming backend** (localStorage, wins over the baked value) |

## Tests

```bash
npx tsc --noEmit   # typecheck
npm test           # tsx --test (parse + store logic)
npm run build      # full gate: typecheck + production build
```
