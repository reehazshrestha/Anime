import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeConfig } from "./config.js";
import {
  initStore,
  listProgress,
  saveProgress,
  deleteProgress,
  listFavorites,
  addFavorite,
  removeFavorite,
} from "./store.js";
import { streamHandler } from "./proxy.js";
import { imageHandler } from "./image-proxy.js";
import type { ProgressEntry } from "../shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await initStore();

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------- api routes ----------
const api = express.Router();

// ---------- content routes: served by the miruro.tv / AniList anime-api ----------
// The legacy scraper (hianime.at) is no longer used for catalog/search/details/
// episodes/sources/genre. Those routes are bridged to the FastAPI anime-api
// (same process or a separate one via ANIME_API_ORIGIN). This keeps the site
// server focused on user-data (progress/favorites), static serving and proxies.

// /api/home, /api/search, /api/anime/*, /api/sources, /api/genre/*
// → bridged to anime-api below (unhandled-route handler). Define them here only
// when we want to override or decorate a route locally (e.g. user-data below).

// ---------- user data routes (local, persisted in store.json) ----------
api.get("/progress", (_req, res) => {
  res.json({ items: listProgress() });
});

api.post("/progress", (req, res) => {
  const body = req.body as Partial<ProgressEntry>;
  if (!body?.animeId || typeof body.positionSeconds !== "number") {
    res.status(400).json({ error: "animeId and positionSeconds are required" });
    return;
  }
  const entry: ProgressEntry = {
    animeId: body.animeId,
    animeTitle: body.animeTitle ?? body.animeId,
    episodeNumber: body.episodeNumber ?? "1",
    positionSeconds: Math.max(0, Math.floor(body.positionSeconds)),
    durationSeconds: Math.max(0, Math.floor(body.durationSeconds ?? 0)),
    updatedAt: Date.now(),
    mode: body.mode === "dub" ? "dub" : "sub",
  };
  saveProgress(entry);
  res.json({ ok: true });
});

api.delete("/progress/:animeId", (req, res) => {
  deleteProgress(req.params.animeId);
  res.json({ ok: true });
});

api.get("/favorites", (_req, res) => {
  res.json({ items: listFavorites() });
});

api.post("/favorites", (req, res) => {
  const { animeId, animeTitle } = req.body as { animeId?: string; animeTitle?: string };
  if (!animeId) {
    res.status(400).json({ error: "animeId required" });
    return;
  }
  addFavorite(animeId, animeTitle ?? animeId);
  res.json({ ok: true });
});

api.delete("/favorites/:animeId", (req, res) => {
  removeFavorite(req.params.animeId);
  res.json({ ok: true });
});

// ---------- mount api ----------
app.use("/api", api);

// ---------- anime-api bridge ----------
// Content routes the site frontend uses are forwarded to the FastAPI anime-api
// (miruro.tv + AniList). If anime-api is unreachable, the bridge hands off to
// the next handler so Express can answer with a clean JSON 404 (never its HTML
// 404, which the frontend can't parse).
const ANIME_API_ORIGIN = process.env.ANIME_API_ORIGIN ?? "http://127.0.0.1:8000";

async function bridgeToAnimeApi(req: express.Request, res: express.Response): Promise<boolean> {
  try {
    const headers = new Headers();
    for (const h of ["range", "referer", "accept", "content-type"] as const) {
      const v = req.header(h);
      if (v) headers.set(h, v);
    }
    const init: RequestInit = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD") {
      // express.json() already consumed the body stream; re-serialize it.
      init.body = JSON.stringify(req.body ?? {});
    }
    const upstream = await fetch(`${ANIME_API_ORIGIN}${req.originalUrl}`, {
      ...init,
      redirect: "follow",
    });
    res.status(upstream.status);
    for (const k of ["content-type", "cache-control", "accept-ranges", "content-range"] as const) {
      const v = upstream.headers.get(k);
      if (v) res.setHeader(k, v);
    }
    if (!upstream.body) {
      res.end();
      return true;
    }
    const stream = upstream.body as unknown as AsyncIterable<Uint8Array>;
    for await (const chunk of stream) {
      res.write(Buffer.from(chunk));
    }
    res.end();
    return true;
  } catch {
    return false; // anime-api not running → caller decides fallback
  }
}

// /api/* not handled above → anime-api (content routes live there now).
app.use("/api", (req, res, next) => {
  void bridgeToAnimeApi(req, res).then((ok) => {
    if (!ok) next();
  });
});

// /api/* with no backend at all → clean JSON 404.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "not found on this backend and anime-api is unreachable" });
});

// ---------- cover image proxy ----------
// anime-api first (its allowlist covers the newer poster CDNs),
// legacy handler as fallback when anime-api is not running.
app.use(
  "/img",
  (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).json({ error: "method not allowed" });
      return;
    }
    next();
  },
  (req, res) => {
    void bridgeToAnimeApi(req, res).then((ok) => {
      if (!ok && !res.headersSent) void imageHandler(req, res);
    });
  },
);

// ---------- stream proxy ----------
app.use(
  "/stream",
  (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).json({ error: "method not allowed" });
      return;
    }
    next();
  },
  (req, res) => {
    void streamHandler(req, res);
  },
);

// ---------- static client ----------
const distDir = path.join(__dirname, "..", "dist");
app.use(express.static(distDir));
app.get(/^\/(?!api|stream|img).*/, (_req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

// json error fallback
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use(
  (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[server] unhandled:", err.message);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  },
);

app.listen(runtimeConfig.port, () => {
  console.log(`[anistream] API on http://localhost:${runtimeConfig.port}`);
  console.log("[anistream] client (dev): http://localhost:5173");
  console.log(`[anistream] content backend: ${ANIME_API_ORIGIN} (miruro.tv + AniList)`);
});

process.on("unhandledRejection", (r) => {
  console.error("[anistream] unhandledRejection:", r);
});
process.on("uncaughtException", (e) => {
  console.error("[anistream] uncaughtException:", e);
  process.exit(1);
});
process.on("exit", (code) => {
  console.error(`[anistream] exit code=${code}`);
});
