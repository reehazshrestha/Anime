import { useEffect, useState } from "react";
import { navigate } from "../router.js";
import { api } from "../api.js";
import type { ProgressEntry } from "../../shared/types.js";

/**
 * Continue-watching hero: the most recent in-progress episode rendered as a
 * full-width banner. Poster art doubles as the backdrop (blurred + gradient
 * overlay); actions are resume / next episode / details / dismiss.
 */
export function ContinueWatchingHero({ entry }: { entry: ProgressEntry }) {
  const [poster, setPoster] = useState<string | null>(entry.poster ?? null);
  const [removing, setRemoving] = useState(false);

  // poster: use the one saved with the progress entry; fall back to a
  // (server-cached) details lookup only when missing
  useEffect(() => {
    if (entry.poster) return;
    let alive = true;
    api
      .getAnime(entry.animeId)
      .then((d) => alive && setPoster(d.poster ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [entry.animeId, entry.poster]);

  const pct =
    entry.durationSeconds > 0
      ? Math.min(100, (entry.positionSeconds / entry.durationSeconds) * 100)
      : 0;

  const goResume = () =>
    navigate(
      `/watch/${encodeURIComponent(entry.animeId)}?ep=${encodeURIComponent(entry.episodeNumber)}`,
    );

  const nextEp = (() => {
    const n = Number(entry.episodeNumber);
    return Number.isFinite(n) ? String(n + 1) : null;
  })();

  const remove = () => {
    setRemoving(true);
    api
      .deleteProgress(entry.animeId)
      .then(() => window.location.reload())
      .catch(() => setRemoving(false));
  };

  return (
    <div className="hero">
      {poster && (
        <div className="hero-backdrop" style={{ backgroundImage: `url(${poster})` }} />
      )}
      <div className="hero-content">
        <div className="hero-poster">
          {poster ? (
            <img src={poster} alt={entry.animeTitle} />
          ) : (
            <div className="detail-poster-fallback">
              {entry.animeTitle.slice(0, 1).toUpperCase()}
            </div>
          )}
        </div>
        <div className="hero-info">
          <span className="hero-kicker">Continue watching</span>
          <h2 className="hero-title">
            <a href={`#/anime/${encodeURIComponent(entry.animeId)}`}>{entry.animeTitle}</a>
          </h2>
          <div className="hero-meta">
            <span>
              Episode {entry.episodeNumber} · {entry.mode.toUpperCase()}
            </span>
            <span aria-hidden>·</span>
            <span>
              {formatTime(entry.positionSeconds)} / {formatTime(entry.durationSeconds)}
            </span>
          </div>
          <div className="hero-progress">
            <div className="bar">
              <div className="fill" style={{ width: `${Math.max(2, pct)}%` }} />
            </div>
            <div className="pct">{Math.floor(pct)}% watched</div>
          </div>
          <div className="hero-actions">
            <button className="btn btn-primary btn-hero" onClick={goResume}>
              ▶ Resume Ep {entry.episodeNumber}
            </button>
            {pct >= 85 && nextEp && (
              <button className="btn btn-hero" onClick={goResume}>
                Next episode →
              </button>
            )}
            <a className="btn btn-hero" href={`#/anime/${encodeURIComponent(entry.animeId)}`}>
              Details
            </a>
            <button
              className="btn btn-hero"
              onClick={remove}
              disabled={removing}
              aria-label="Remove from continue watching"
              title="Remove from continue watching"
            >
              ✕
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}
