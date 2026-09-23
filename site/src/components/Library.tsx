import { Bookmark, Compass, History as HistoryIcon, PlayCircle, Settings as SettingsIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api, getApiBase, setApiBase } from "../api.js";
import {
  listProgress,
  listFavorites,
  clearAll,
  storageEstimate,
} from "../userStore.js";
import { navigate } from "../router.js";
import { useTheme } from "../theme.js";
import { AnimeCard } from "./AnimeCard.js";
import { CardSkeletons, EmptyState } from "./ui/primitives.js";
import type { FavoriteEntry, ProgressEntry } from "../../shared/types.js";

const CLOUD_API = "https://anime-api-rho-three.vercel.app";

/**
 * Backend picker: same-origin (local `uv run anime-api`) or the deployed
 * Vercel API. Choice persists in localStorage and applies on reload.
 */
function BackendSetting() {
  const current = getApiBase();
  const [custom, setCustom] = useState("");
  const [probe, setProbe] = useState<{ status: "idle" | "checking" | "ok" | "fail"; msg: string }>({
    status: "idle",
    msg: "",
  });

  const checkHealth = (base: string) => {
    setProbe({ status: "checking", msg: "Checking…" });
    const url = (base ? base : window.location.origin) + "/health";
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { features?: string[] }) =>
        setProbe({
          status: "ok",
          msg: `Connected · features: ${(d.features ?? []).join(", ") || "none"}`,
        }),
      )
      .catch((e: Error) => setProbe({ status: "fail", msg: `Unreachable (${e.message})` }));
  };

  const pick = (base: string) => {
    if (base === current) return;
    setApiBase(base);
  };

  return (
    <div className="setting-row backend-row">
      <div className="info">
        <h3>Streaming backend</h3>
        <p>
          Where the site gets anime data and video. “This site” uses the API
          serving this page (localhost:8000 locally); “Vercel cloud” uses the
          deployed API.
        </p>
        <div className="backend-options">
          <button
            className={`chip${current === "" ? " on" : ""}`}
            onClick={() => pick("")}
          >
            This site
          </button>
          <button
            className={`chip${current === CLOUD_API ? " on" : ""}`}
            onClick={() => pick(CLOUD_API)}
          >
            Vercel cloud
          </button>
        </div>
        <div className="backend-custom">
          <input
            type="url"
            placeholder="Custom API base URL…"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            aria-label="Custom API base URL"
          />
          <button className="btn" onClick={() => checkHealth(custom)} disabled={!custom.trim()}>
            Test
          </button>
          <button
            className="btn btn-primary"
            onClick={() => pick(custom.trim())}
            disabled={!custom.trim() || custom.trim() === current}
          >
            Use
          </button>
        </div>
        <div className="backend-status">
          <button className="btn" onClick={() => checkHealth(current)} disabled={probe.status === "checking"}>
            Check connection
          </button>
          {probe.msg && (
            <span className={probe.status === "fail" ? "backend-err" : "backend-ok"}>{probe.msg}</span>
          )}
        </div>
      </div>
    </div>
  );
}

const GENRES = [
  "Action",
  "Adventure",
  "Comedy",
  "Drama",
  "Fantasy",
  "Horror",
  "Mystery",
  "Romance",
  "Sci-Fi",
  "Slice of Life",
  "Sports",
  "Supernatural",
];

/* ---------------- My List ---------------- */

export function Library() {
  const [items, setItems] = useState<FavoriteEntry[] | null>(null);

  useEffect(() => {
    setItems(listFavorites());
  }, []);
  return (
    <div className="page">
      <div className="page-head">
        <h1>My List</h1>
        <p className="sub">Anime you bookmarked to watch later.</p>
      </div>
      {items === null && <CardSkeletons count={6} />}
      {items !== null && items.length === 0 && (
        <EmptyState
          icon={Bookmark}
          title="Your list is empty"
          action={
            <button className="btn btn-primary" onClick={() => navigate("/discover")}>
              <Compass size={16} /> Discover anime
            </button>
          }
        >
          Bookmark anime from any details page and they will show up here.
        </EmptyState>
      )}
      {items !== null && items.length > 0 && (
        <div className="grid">
          {items.map((f) => (
            <AnimeCard key={f.animeId} id={f.animeId} title={f.animeTitle} poster={f.poster} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Continue watching ---------------- */

export function Continue() {
  const [items, setItems] = useState<ProgressEntry[] | null>(null);

  useEffect(() => {
    setItems(listProgress().filter(inProgress));
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Continue Watching</h1>
        <p className="sub">Pick up exactly where you left off.</p>
      </div>
      {items === null && <CardSkeletons count={6} />}
      {items !== null && items.length === 0 && (
        <EmptyState icon={PlayCircle} title="Nothing in progress">
          Start any episode and it will appear here with your exact resume point.
        </EmptyState>
      )}
      {items !== null && items.length > 0 && (
        <div className="grid">
          {items.map((p) => (
            <AnimeCard
              key={p.animeId}
              id={p.animeId}
              title={p.animeTitle}
              poster={p.poster}
              sub={`Ep ${p.episodeNumber} · ${p.mode.toUpperCase()}`}
              progressPct={
                p.durationSeconds > 0 ? (p.positionSeconds / p.durationSeconds) * 100 : 0
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function inProgress(p: ProgressEntry): boolean {
  return p.durationSeconds === 0 || p.positionSeconds / p.durationSeconds < 0.9;
}

/* ---------------- History ---------------- */

export function History() {
  const [items, setItems] = useState<ProgressEntry[] | null>(null);

  useEffect(() => {
    setItems(listProgress());
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <h1>History</h1>
        <p className="sub">Everything you have watched on this device.</p>
      </div>
      {items === null && <CardSkeletons count={6} />}
      {items !== null && items.length === 0 && (
        <EmptyState icon={HistoryIcon} title="No history yet">
          Watch your first episode and it will be tracked here.
        </EmptyState>
      )}
      {items !== null && items.length > 0 && (
        <div className="grid">
          {items.map((p) => (
            <AnimeCard
              key={p.animeId}
              id={p.animeId}
              title={p.animeTitle}
              poster={p.poster}
              sub={`Ep ${p.episodeNumber}${p.watchedEpisodes?.length ? ` · ${p.watchedEpisodes.length} watched` : ""}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Genres ---------------- */

/** One genre shelf: lazy-loads 10 anime on first visibility. */
function GenrePreviewSection({ genre }: { genre: string }) {
  const [results, setResults] = useState<{ id: string; title: string; poster?: string }[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [ref, setRef] = useState<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  // lazy: only fetch when the section scrolls into view
  useEffect(() => {
    if (!ref || visible) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setVisible(true)),
      { rootMargin: "300px" },
    );
    io.observe(ref);
    return () => io.disconnect();
  }, [ref, visible]);

  useEffect(() => {
    if (!visible || results !== null) return;
    let alive = true;
    api
      .browseGenre(genre, 1)
      .then((r) => alive && setResults(r.results.slice(0, 10)))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [visible, genre, results]);

  return (
    <div className="section" ref={setRef}>
      <div className="section-head">
        <h2>{genre}</h2>
        <a className="see-all" href={`#/genre/${encodeURIComponent(genre)}`}>
          Browse all →
        </a>
      </div>
      {failed ? (
        <div className="muted" style={{ fontSize: 13 }}>
          Could not load this shelf right now — it will retry next visit.
        </div>
      ) : results === null ? (
        <div className="rail-track" aria-hidden>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="sk-card" style={{ flex: "0 0 150px" }}>
              <div className="sk-art skeleton" />
            </div>
          ))}
        </div>
      ) : results.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>No anime in this shelf yet.</div>
      ) : (
        <div className="rail-track">
          {results.map((r) => (
            <AnimeCard key={r.id} id={r.id} title={r.title} poster={r.poster} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Genres() {
  return (
    <div className="page">
      <div className="page-head">
        <h1>Genres</h1>
        <p className="sub">Every shelf in the library — with a taste of what's inside.</p>
      </div>
      <div className="genre-grid" style={{ marginBottom: 40 }}>
        {GENRES.map((g) => (
          <a key={g} className="genre-tile" href={`#/genre/${encodeURIComponent(g)}`}>
            {g}
            <span aria-hidden>→</span>
          </a>
        ))}
      </div>
      {GENRES.slice(0, 4).map((g) => (
        <GenrePreviewSection key={g} genre={g} />
      ))}
    </div>
  );
}

/* ---------------- Genre browse ---------------- */

export function GenreBrowse({ genre }: { genre: string }) {
  const [results, setResults] = useState<{ id: string; title: string; poster?: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .browseGenre(genre, 1)
      .then((r) => alive && setResults(r.results))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [genre, retryKey]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>{genre} Anime</h1>
        <p className="sub">Popular in the “{genre}” shelf.</p>
      </div>
      <div className="filter-bar">
        {GENRES.map((g) => (
          <a
            key={g}
            className={`chip${g.toLowerCase() === genre.toLowerCase() ? " on" : ""}`}
            href={`#/genre/${encodeURIComponent(g)}`}
          >
            {g}
          </a>
        ))}
      </div>
      {error && (
        <div className="error-box">
          <strong>Could not load “{genre}”.</strong>
          <div className="muted" style={{ marginTop: 6 }}>
            {error}
          </div>
          <button
            className="btn btn-primary"
            style={{ marginTop: 12 }}
            onClick={() => setRetryKey((k) => k + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {loading && !error && <CardSkeletons count={12} />}
      {!loading && !error && results !== null && results.length === 0 && (
        <EmptyState icon={Compass} title="Nothing here">
          The provider returned no anime for this genre.
        </EmptyState>
      )}
      {!loading && results !== null && results.length > 0 && (
        <div className="grid">
          {results.map((r) => (
            <AnimeCard key={r.id} id={r.id} title={r.title} poster={r.poster} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Settings ---------------- */

export function Settings() {
  const { theme, toggle } = useTheme();
  const [cleared, setCleared] = useState(false);
  const kb = (storageEstimate() / 1024).toFixed(1);
  return (
    <div className="page">
      <div className="page-head">
        <h1>Settings</h1>
        <p className="sub">Preferences are stored locally on this device.</p>
      </div>
      <div className="settings-list">
        <div className="setting-row">
          <div className="info">
            <h3>Light theme</h3>
            <p>Switch between the cinematic dark and a calm daylight palette.</p>
          </div>
          <button
            className={`switch${theme === "light" ? " on" : ""}`}
            onClick={toggle}
            role="switch"
            aria-checked={theme === "light"}
            aria-label="Toggle light theme"
          />
        </div>
        <BackendSetting />
        <div className="setting-row">
          <div className="info">
            <h3>Default quality</h3>
            <p>The player always starts at the best available quality; pin a height via the player menu.</p>
          </div>
          <SettingsIcon size={18} style={{ color: "var(--text-3)" }} />
        </div>
        <div className="setting-row">
          <div className="info">
            <h3>Your data</h3>
            <p>
              Watch history, continue-watching and My List live in this browser
              only ({kb} KB) — private, and never synced anywhere.
            </p>
          </div>
          <button
            className="btn"
            onClick={() => {
              clearAll();
              setCleared(true);
            }}
          >
            {cleared ? "Cleared ✓" : "Clear"}
          </button>
        </div>
      </div>
    </div>
  );
}
