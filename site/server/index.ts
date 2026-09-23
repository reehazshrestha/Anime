import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeConfig } from "./config.js";
import {
  initStore,
  listProgress,
  getProgress,
  saveProgress,
  deleteProgress,
  listFavorites,
  isFavorite,
  addFavorite,
  removeFavorite,
} from "./store.js";
import { TtlCache } from "./cache.js";
import {
  searchAnime,
  getAnimeDetails,
  getEpisodes,
  getHomeSections,
  resolveStream,
  ProvidersUnavailableError,
} from "./scraper.js";
import { resolveSources } from "./anicli.js";
import { streamHandler } from "./proxy.js";
import { imageHandler } from "./image-proxy.js";
import type {
  AudioMode,
  AnimeDetails,
  EpisodeInfo,
  EpisodeSources,
  HomeSection,
  ProgressEntry,
  SubtitleTrack,
} from "../shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await initStore();

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------- caches ----------
const searchCache = new TtlCache<AnimeSearchResults>(10 * 60_000);
const homeCache = new TtlCache<HomeSectionsPayload>(5 * 60_000);
const detailsCache = new TtlCache<AnimeDetails>(30 * 60_000);
const episodesCache = new TtlCache<EpisodeInfo[]>(30 * 60_000);
const sourcesCache = new TtlCache<EpisodeSources>(3 * 60_000);

interface AnimeSearchResults {
  results: { id: string; title: string }[];
}

interface HomeSectionsPayload {
  sections: HomeSection[];
}

// ---------- helpers ----------
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function requireId(raw: string): string {
  if (!/^[a-z0-9-]+-[0-9]+$/i.test(raw)) {
    throw httpError(400, "invalid anime id");
  }
  return raw;
}

function getEpisodeListCached(animeId: string): Promise<EpisodeInfo[]> {
  return episodesCache.wrap(`eps:${animeId}`, () => getEpisodes(animeId));
}

function getDetailsCached(animeId: string): Promise<AnimeDetails> {
  return detailsCache.wrap(`details:${animeId}`, () => getAnimeDetails(animeId));
}

/**
 * ani-cli resolves by search query; to pin the exact anime we search using the
 * anime title and find which 1-based result index corresponds to our anidb id.
 */
async function resolveSearchIndex(query: string, animeId: string): Promise<number> {
  const lowered = query.toLowerCase();
  const results = await searchCache.wrap(lowered, () =>
    searchAnime(query).then((r) => ({ results: r })),
  );
  const idx = results.results.findIndex((r) => r.id === animeId);
  if (idx === -1) {
    // not pinned: let ani-cli pick its first result rather than failing hard
    return 1;
  }
  return idx + 1;
}

function buildAniCliQuery(details: AnimeDetails, animeId: string): string {
  const exact = details.seasons.find((s) => s.id === animeId);
  const title = exact?.title ?? details.title;
  // strip things ani-cli's search may not match on
  return title
    .replaceAll(/\([^)]*\)/g, "")
    .replaceAll(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

// ---------- api routes ----------
const api = express.Router();

api.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) {
    res.status(400).json({ error: "missing q" });
    return;
  }
  try {
    const lowered = q.toLowerCase();
    const payload = await searchCache.wrap(lowered, () =>
      searchAnime(q).then((results) => ({ results })),
    );
    res.json(payload);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

api.get("/home", async (_req, res) => {
  try {
    const payload = await homeCache.wrap("home", async () => ({
      sections: await getHomeSections(),
    }));
    res.json(payload);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

api.get("/anime/:id", async (req, res) => {
  try {
    const id = requireId(req.params.id);
    const details = await getDetailsCached(id);
    const eps = await getEpisodeListCached(id);
    res.json({
      ...details,
      episodes: eps,
      isFavorite: isFavorite(id),
      progress: getProgress(id) ?? null,
    });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 502;
    res.status(status).json({ error: (err as Error).message });
  }
});

api.get("/anime/:id/episodes", async (req, res) => {
  try {
    const id = requireId(req.params.id);
    const eps = await getEpisodeListCached(id);
    res.json({ episodes: eps });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 502;
    res.status(status).json({ error: (err as Error).message });
  }
});

api.get("/sources", async (req, res) => {
  const animeId = String(req.query.animeId ?? "");
  const epNumber = String(req.query.ep ?? "");
  const mode: AudioMode = String(req.query.mode ?? "sub") === "dub" ? "dub" : "sub";
  if (!animeId || !epNumber) {
    res.status(400).json({ error: "animeId and ep are required" });
    return;
  }
  try {
    requireId(animeId);
    const key = `sources:${animeId}:${epNumber}:${mode}`;
    const payload = await sourcesCache.wrap(key, async () => {
      const details = await getDetailsCached(animeId);
      const eps = await getEpisodeListCached(animeId);
      const epInfo = eps.find((e) => e.number === epNumber);
      if (!epInfo) throw httpError(404, "episode not found");

      // 1) primary: hianime.at provider (TS port of ani-cli v5.1.4's flow)
      let via: "ani-cli" | "scraper" = "scraper";
      let variants;
      let subtitles: SubtitleTrack[] = [];
      let masterUrl: string | undefined;
      try {
        const r = await resolveStream(epInfo.id, mode);
        variants = r.variants;
        subtitles = r.subtitles;
        masterUrl = r.masterUrl;
      } catch (err) {
        if (err instanceof ProvidersUnavailableError) throw err;
        console.error(
          `[sources] provider failed for ${animeId} ep ${epNumber} (${mode}): ${(err as Error).message}`,
        );
        // 2) fallback: shell out to the installed ani-cli binary
        via = "ani-cli";
        const query = buildAniCliQuery(details, animeId);
        const searchIndex = await resolveSearchIndex(query, animeId);
        const r = await resolveSources({ query, searchIndex, episode: epNumber, mode });
        variants = r.variants;
      }

      if (!variants.length) throw new Error("no stream sources found");

      const payload: EpisodeSources = {
        animeId,
        animeTitle: details.title,
        episode: epInfo,
        mode,
        variants,
        masterUrl,
        subtitles,
        via,
      };
      return payload;
    });
    res.json(payload);
  } catch (err) {
    const status =
      err instanceof ProvidersUnavailableError
        ? 404
        : ((err as { status?: number }).status ?? 502);
    res.status(status).json({ error: (err as Error).message });
  }
});

// ---------- user data routes ----------
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

// ---------- mount api ----------
app.use("/api", api);

// ---------- anime-api bridge ----------
// This legacy backend predates some routes the current frontend uses
// (/api/genre, newer /img poster CDNs). Any /api/* route it does NOT handle
// is forwarded to the FastAPI anime-api so the site works against either
// server. If anime-api is unreachable, unhandled routes get a clean JSON 404
// (never Express's HTML 404, which the frontend can't parse).
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

// unhandled /api/* → bridge, else clean JSON 404
app.use("/api", (req, res, next) => {
  void bridgeToAnimeApi(req, res).then((ok) => {
    if (!ok) next();
  });
});
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "not found on this backend and anime-api is unreachable" });
});

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
app.get(/^\/(?!api|stream).*/, (_req, res) => {
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
});
