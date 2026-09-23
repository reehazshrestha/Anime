import { useEffect, useState } from "react";
import { Info, Play, Plus, Check } from "lucide-react";
import { api } from "../api.js";
import { AnimeCard } from "./AnimeCard.js";
import { Rail } from "./Rail.js";
import { ContinueWatchingHero } from "./ContinueWatchingHero.js";
import { RailSkeleton } from "./ui/primitives.js";
import { navigate } from "../router.js";
import type { FavoriteEntry, HomeSection, ProgressEntry } from "../../shared/types.js";

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

const TRENDING_ID = "trending";

export function Home() {
  const [sections, setSections] = useState<HomeSection[]>([]);
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [favorites, setFavorites] = useState<FavoriteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.home(), api.listProgress(), api.listFavorites()])
      .then(([h, p, f]) => {
        if (!alive) return;
        setSections(h.sections);
        setProgress(p.items);
        setFavorites(f.items);
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="page">
        <div className="skeleton" style={{ height: "clamp(340px, 42vw, 520px)", borderRadius: 18, marginBottom: 40 }} />
        {[0, 1].map((i) => (
          <div className="section" key={i}>
            <div className="sk-line skeleton" style={{ width: 180, height: 20, marginBottom: 16 }} />
            <RailSkeleton />
          </div>
        ))}
      </div>
    );
  }

  const continueItems = progress.filter(
    (p) => p.durationSeconds === 0 || p.positionSeconds / p.durationSeconds < 0.9,
  );
  const heroItem = continueItems[0];
  const restContinue = continueItems.slice(1);
  const trending = sections.find((s) => s.id === TRENDING_ID);

  return (
    <div className="page">
      {error && (
        <div className="error-box">
          <strong>Could not load the catalog.</strong>
          <div className="muted" style={{ marginTop: 6 }}>
            {error}
          </div>
        </div>
      )}

      {/* 1) continue watching hero dominates if present, else featured anime */}
      {heroItem ? (
        <ContinueWatchingHero entry={heroItem} />
      ) : (
        trending && <FeaturedHero section={trending} inList={favorites.some((f) => f.animeId === trending.items[0]?.id)} />
      )}

      {/* 2) rest of continue watching */}
      {restContinue.length > 0 && (
        <div className="section">
          <div className="section-head">
            <h2>Keep watching</h2>
            <a className="see-all" href="#/continue">
              View all →
            </a>
          </div>
          <div className="grid">
            {restContinue.map((p) => (
              <AnimeCard
                key={p.animeId}
                id={p.animeId}
                title={p.animeTitle}
                sub={`Ep ${p.episodeNumber} · ${p.mode.toUpperCase()}`}
                progressPct={
                  p.durationSeconds > 0 ? (p.positionSeconds / p.durationSeconds) * 100 : 0
                }
              />
            ))}
          </div>
        </div>
      )}

      {/* 3+) catalog rails */}
      {sections.map((s) => (
        <Rail key={s.id} section={s} />
      ))}

      {/* genres */}
      <div className="section">
        <div className="section-head">
          <h2>Browse by genre</h2>
          <a className="see-all" href="#/genres">
            All genres →
          </a>
        </div>
        <div className="genre-grid">
          {GENRES.map((g) => (
            <a key={g} className="genre-tile" href={`#/genre/${encodeURIComponent(g)}`}>
              {g}
              <span aria-hidden>→</span>
            </a>
          ))}
        </div>
      </div>

      {!error && sections.length === 0 && (
        <div className="empty">
          <h3>Catalog unavailable</h3>
          <p>Nothing loaded from the provider right now — check back soon.</p>
        </div>
      )}

      <footer className="footer">
        <span>
          AniStream — data from <a href="https://hianime.at" target="_blank" rel="noreferrer">hianime.at</a>
        </span>
        <span>For personal use · respect the providers</span>
      </footer>
    </div>
  );
}

/* ---------------- featured hero (trending #1) ---------------- */

function FeaturedHero({ section, inList }: { section: HomeSection; inList: boolean }) {
  const item = section.items[0];
  const [poster, setPoster] = useState<string | null>(item?.poster ?? null);
  const [desc, setDesc] = useState<string | null>(null);
  const [added, setAdded] = useState(inList);
  const [pending, setPending] = useState(false);

  // details for description + backdrop (cached server-side)
  useEffect(() => {
    let alive = true;
    if (!item) return;
    api
      .getAnime(item.id)
      .then((d) => {
        if (!alive) return;
        setPoster(d.poster ?? item.poster ?? null);
        setDesc(d.description ?? null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [item]);

  if (!item) return null;

  const addToList = async () => {
    if (pending) return;
    setPending(true);
    try {
      if (added) {
        await api.removeFavorite(item.id);
        setAdded(false);
      } else {
        await api.addFavorite(item.id, item.title);
        setAdded(true);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="hero">
      {poster && <div className="hero-backdrop" style={{ backgroundImage: `url(${poster})` }} />}
      <div className="hero-content">
        <div className="hero-poster">
          {poster ? <img src={poster} alt={item.title} /> : item.title.slice(0, 1).toUpperCase()}
        </div>
        <div className="hero-info">
          <span className="hero-kicker">Trending #{1}</span>
          <h1 className="hero-title">
            <a href={`#/anime/${encodeURIComponent(item.id)}`}>{item.title}</a>
          </h1>
          {desc && <p className="hero-desc">{desc}</p>}
          <div className="hero-meta">
            {item.type && (
              <>
                <span>{item.type}</span>
                <span className="dot">•</span>
              </>
            )}
            {item.epCount ? (
              <>
                <span>{item.epCount} episodes</span>
                <span className="dot">•</span>
              </>
            ) : null}
            <span>{item.subCount ? `SUB ${item.subCount}` : ""}{item.dubCount ? ` · DUB ${item.dubCount}` : ""}</span>
          </div>
          <div className="hero-actions">
            <button
              className="btn btn-primary btn-hero"
              onClick={() => navigate(`/watch/${encodeURIComponent(item.id)}?ep=1`)}
            >
              <Play size={17} fill="currentColor" /> Watch now
            </button>
            <button className="btn btn-hero" onClick={addToList} disabled={pending}>
              {added ? <Check size={17} /> : <Plus size={17} />}
              {added ? "In My List" : "Add to List"}
            </button>
            <a className="btn btn-hero" href={`#/anime/${encodeURIComponent(item.id)}`}>
              <Info size={17} /> Details
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
