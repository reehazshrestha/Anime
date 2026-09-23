import type {
  AnimeDetails,
  AnimeSearchResult,
  AudioMode,
  EpisodeInfo,
  EpisodeSources,
  FavoriteEntry,
  HomeSection,
  ProgressEntry,
} from "../shared/types.js";

// ---------------------------------------------------------------------
// API base resolution order —
//   1. runtime override: Settings page → "Streaming backend" (localStorage,
//      applied instantly via reload)
//   2. build-time:       VITE_API_BASE (site/.env.production bakes the
//      deployed Vercel API into production builds so the site works on any
//      device out of the box)
//   3. same-origin (local single-process serving)
// ---------------------------------------------------------------------
const API_BASE_KEY = "anistream.apiBase";

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function initialApiBase(): string {
  try {
    const stored = localStorage.getItem(API_BASE_KEY);
    if (stored !== null) return trimSlash(stored); // explicit user choice wins
  } catch {
    /* storage unavailable */
  }
  const env = (import.meta.env.VITE_API_BASE as string | undefined)?.trim();
  return env ? trimSlash(env) : "";
}

export const API_BASE = initialApiBase();

export function getApiBase(): string {
  return API_BASE;
}

/** Set the backend (empty string = same origin) and reload to apply. */
export function setApiBase(base: string): void {
  const b = trimSlash(base.trim());
  try {
    if (b) localStorage.setItem(API_BASE_KEY, b);
    else localStorage.removeItem(API_BASE_KEY);
  } catch {
    /* ignore */
  }
  window.location.reload();
}

/** Points "/img/…" and "/stream/…" URLs returned by the API at the right host. */
function absolutize(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("/img/") || value.startsWith("/stream/")) return API_BASE + value;
    return value;
  }
  if (Array.isArray(value)) return value.map(absolutize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, absolutize(v)]),
    );
  }
  return value;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + url, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-json */
  }
  if (!res.ok) {
    const err = body as { error?: string; detail?: string } | null;
    // FastAPI's native errors use {detail: ...} — that means the running
    // backend predates this frontend (e.g. missing /api/genre route).
    if (err?.detail && !err.error) {
      throw new Error(
        `${err.detail} — the API server looks out of date. Restart it: cd anime-api && uv run anime-api`,
      );
    }
    if (body === null && res.status === 404) {
      // Non-JSON 404 (HTML or empty): the request never reached anime-api.
      // Usually the legacy Node backend (:8787), which has no /api/genre
      // or /img routes — Express answers with its HTML error page.
      throw new Error(
        `endpoint not found (${url.split("?")[0]}) — the site is not talking to anime-api. ` +
          "Start it with: cd anime-api && uv run anime-api (dev proxy must target :8000)",
      );
    }
    throw new Error(err?.error ?? `request failed (${res.status})`);
  }
  return absolutize(body) as T;
}

export interface AnimeDetailsResponse extends AnimeDetails {
  episodes: EpisodeInfo[];
  isFavorite: boolean;
  progress: ProgressEntry | null;
}

export const api = {
  home(): Promise<{ sections: HomeSection[] }> {
    return request("/api/home");
  },

  search(q: string): Promise<{ results: AnimeSearchResult[] }> {
    return request(`/api/search?q=${encodeURIComponent(q)}`);
  },

  browseGenre(genre: string, page = 1): Promise<{ results: AnimeSearchResult[]; page: number }> {
    return request(
      `/api/genre/${encodeURIComponent(genre)}?page=${page}`,
    );
  },

  getAnime(id: string): Promise<AnimeDetailsResponse> {
    return request(`/api/anime/${encodeURIComponent(id)}`);
  },

  getEpisodes(id: string): Promise<{ episodes: EpisodeInfo[] }> {
    return request(`/api/anime/${encodeURIComponent(id)}/episodes`);
  },

  getSources(animeId: string, ep: string, mode: AudioMode): Promise<EpisodeSources> {
    const params = new URLSearchParams({ animeId, ep, mode });
    return request(`/api/sources?${params.toString()}`);
  },

  listProgress(): Promise<{ items: ProgressEntry[] }> {
    return request("/api/progress");
  },

  saveProgress(entry: {
    animeId: string;
    animeTitle: string;
    episodeNumber: string;
    positionSeconds: number;
    durationSeconds: number;
    mode: AudioMode;
  }): Promise<{ ok: boolean }> {
    return request("/api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
  },

  deleteProgress(animeId: string): Promise<{ ok: boolean }> {
    return request(`/api/progress/${encodeURIComponent(animeId)}`, { method: "DELETE" });
  },

  listFavorites(): Promise<{ items: FavoriteEntry[] }> {
    return request("/api/favorites");
  },

  addFavorite(animeId: string, animeTitle: string): Promise<{ ok: boolean }> {
    return request("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ animeId, animeTitle }),
    });
  },

  removeFavorite(animeId: string): Promise<{ ok: boolean }> {
    return request(`/api/favorites/${encodeURIComponent(animeId)}`, { method: "DELETE" });
  },
};

/** fire-and-forget progress save on page exit. fetch+keepalive works
 * cross-origin (CORS) — plain sendBeacon is flaky with preflighted JSON. */
export function saveBeacon(payload: unknown): void {
  try {
    void fetch(`${API_BASE}/api/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* page dying — best effort */
  }
}
