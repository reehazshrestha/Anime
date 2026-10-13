import { useEffect, useMemo, useState } from "react";
import { Check, Play, Plus, Share2 } from "lucide-react";
import { api, type AnimeDetailsResponse } from "../api.js";
import { getProgress, isFavorite, addFavorite, removeFavorite } from "../userStore.js";
import { navigate } from "../router.js";
import { useEpisodeChunk, EpisodeTabs } from "./EpisodePager.js";

const EPS_PER_CHUNK = 100;

export function AnimeDetails({ id }: { id: string }) {
  const [data, setData] = useState<AnimeDetailsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seasonId, setSeasonId] = useState<string>(id);
  // cache of loaded entries (base anime + each visited season), keyed by id
  const [entryMap, setEntryMap] = useState<Record<string, AnimeDetailsResponse | null>>({});
  const [favPending, setFavPending] = useState(false);
  const [shared, setShared] = useState(false);

  useEffect(() => {
    let alive = true;
    setError(null);
    setSeasonId(id);
    setEntryMap({});
    api
      .getAnime(id)
      .then((d) =>
        alive &&
        setEntryMap((m) => ({ ...m, [id]: { ...d, progress: getProgress(id) } })),
      )
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    if (!data || seasonId === id || entryMap[seasonId] !== undefined) return;
    let alive = true;
    // null = loading (keeps the hero on the previous entry until it lands)
    setEntryMap((m) => ({ ...m, [seasonId]: null }));
    api
      .getAnime(seasonId)
      .then((d) =>
        alive &&
        setEntryMap((m) => ({
          ...m,
          [seasonId]: { ...d, progress: d.progress ?? getProgress(seasonId) },
        })),
      )
      .catch(() => alive && setEntryMap((m) => ({ ...m, [seasonId]: null })));
    return () => {
      alive = false;
    };
  }, [seasonId, id, data, entryMap]);

  const active = seasonId === id ? data : entryMap[seasonId] ?? data;
  const activeId = seasonId === id ? id : seasonId;
  const episodes = active?.episodes ?? [];
  const numbers = useMemo(() => episodes.map((e) => e.number), [episodes]);
  const resumeEp = active?.progress?.episodeNumber;
  const { chunk, setChunk, chunkCount } = useEpisodeChunk(numbers, EPS_PER_CHUNK, resumeEp);

  if (error) {
    return (
      <div className="page">
        <div className="error-box">
          <strong>Could not load this anime.</strong>
          <div className="muted" style={{ marginTop: 6 }}>
            {error}
          </div>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page">
        <div className="skeleton" style={{ height: 380, borderRadius: 18, marginBottom: 30 }} />
        <div className="sk-grid">
          {Array.from({ length: 12 }, (_, i) => (
            <div className="sk-card" key={i}>
              <div className="sk-art skeleton" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // non-null from here: falls back to the base entry while a season loads
  const entry = active ?? data;

  const watched = new Set(entry?.progress?.watchedEpisodes ?? []);
  const poster = entry?.poster;
  const visible = episodes.slice(chunk * EPS_PER_CHUNK, (chunk + 1) * EPS_PER_CHUNK);
  const rangeLabel = episodes.length
    ? `Ep ${visible[0]?.number}–${visible[visible.length - 1]?.number} of ${episodes.length}`
    : "";

  async function toggleFavorite() {
    if (!entry || favPending) return;
    setFavPending(true);
    try {
      if (isFavorite(entry.id)) {
        removeFavorite(entry.id);
      } else {
        addFavorite(entry.id, entry.title, entry.poster ?? undefined);
      }
      const updated = { ...entry, isFavorite: !isFavorite(entry.id) };
      setEntryMap((m) => ({ ...m, [activeId]: updated }));
      if (activeId === id) setData(updated);
    } finally {
      setFavPending(false);
    }
  }

  const share = async () => {
    const url = `${location.origin}${location.pathname}#/anime/${encodeURIComponent(entry.id)}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: entry.title, url });
      } else {
        await navigator.clipboard.writeText(url);
        setShared(true);
        setTimeout(() => setShared(false), 1600);
      }
    } catch {
      /* user cancelled */
    }
  };

  return (
    <div className="page">
      <div className="detail-hero">
        {poster && <div className="detail-backdrop" style={{ backgroundImage: `url(${poster})` }} />}
        <div className="detail-inner">
          <div className="detail-poster">
            {poster ? (
              <img src={poster} alt={entry.title} />
            ) : (
              <div className="detail-poster-fallback">{entry.title.slice(0, 1).toUpperCase()}</div>
            )}
          </div>
          <div className="detail-info">
            <h1>{entry.title}</h1>
            {entry.meta?.japanese && <p className="detail-jp">{entry.meta.japanese}</p>}
            <div className="chip-row">
              {entry.meta?.status && <span className="chip">{entry.meta.status}</span>}
              {entry.meta?.duration && <span className="chip">{entry.meta.duration}</span>}
              {entry.meta?.aired && <span className="chip">{entry.meta.aired}</span>}
              {entry.meta?.malScore && <span className="chip score">★ {entry.meta.malScore}</span>}
            </div>
            {entry.meta?.genres.length ? (
              <div className="genre-row">
                {entry.meta.genres.map((g) => (
                  <span key={g} className="genre-pill">
                    {g}
                  </span>
                ))}
              </div>
            ) : null}
            {entry.description ? <p className="detail-desc">{entry.description}</p> : null}
            {(entry.meta?.studios || entry.meta?.producers) && (
              <p className="detail-studios">
                {[
                  entry.meta?.studios ? `Studio: ${entry.meta.studios}` : null,
                  entry.meta?.producers ? `Producer: ${entry.meta.producers}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
            <div className="detail-actions">
              <button
                className="btn btn-primary btn-hero"
                onClick={() =>
                  navigate(
                    `/watch/${encodeURIComponent(activeId)}?ep=${encodeURIComponent(
                      resumeEp ?? episodes[0]?.number ?? "1",
                    )}`,
                  )
                }
                disabled={episodes.length === 0}
              >
                <Play size={17} fill="currentColor" />
                {resumeEp ? `Resume Ep ${resumeEp}` : "Watch Now"}
              </button>
              <button className="btn btn-hero" onClick={toggleFavorite} disabled={favPending}>
                {entry.isFavorite ? <Check size={17} /> : <Plus size={17} />}
                {entry.isFavorite ? "In My List" : "Add to List"}
              </button>
              <button className="btn btn-hero" onClick={share}>
                <Share2 size={16} />
                {shared ? "Copied!" : "Share"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {data.seasons.length > 0 && (
        <div className="section">
          <div className="section-head">
            <h2>Seasons & related</h2>
            {seasonId !== id && entry && (
              <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>
                Now viewing: {entry.title}
              </span>
            )}
          </div>
          <div className="season-chips">
            <button
              className={`season-chip${seasonId === id ? " active" : ""}`}
              aria-current={seasonId === id || undefined}
              onClick={() => setSeasonId(id)}
            >
              {data.title}
            </button>
            {data.seasons.map((s) => (
              <button
                key={s.id}
                className={`season-chip${seasonId === s.id ? " active" : ""}`}
                aria-current={seasonId === s.id || undefined}
                onClick={() => setSeasonId(s.id)}
              >
                {s.title}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-head">
          <h2>
            Episodes{" "}
            <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>
              ({episodes.length})
            </span>
          </h2>
        </div>
        <EpisodeTabs
          chunkCount={chunkCount}
          chunk={chunk}
          onPick={setChunk}
          rangeLabel={rangeLabel}
        />
        {episodes.length === 0 ? (
          <div className="empty">
            <h3>No episodes listed</h3>
            <p>This season has no episodes on the provider yet.</p>
          </div>
        ) : (
          <div className="ep-grid">
            {visible.map((ep) => (
              <button
                key={ep.id}
                className={`ep-btn${
                  ep.number === resumeEp ? " current" : watched.has(ep.number) ? " watched" : ""
                }`}
                title={`Episode ${ep.number}`}
                onClick={() =>
                  navigate(
                    `/watch/${encodeURIComponent(activeId)}?ep=${encodeURIComponent(ep.number)}`,
                  )
                }
              >
                {ep.number}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
