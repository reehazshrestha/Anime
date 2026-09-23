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
  const [seasonEpisodes, setSeasonEpisodes] = useState<AnimeDetailsResponse | null>(null);
  const [favPending, setFavPending] = useState(false);
  const [shared, setShared] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    setSeasonId(id);
    setSeasonEpisodes(null);
    api
      .getAnime(id)
      .then((d) => alive && setData({ ...d, progress: getProgress(id) }))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [id]);

  // when the selected season differs from the main entry, load its details+episodes
  useEffect(() => {
    if (!data || seasonId === id) return;
    let alive = true;
    api
      .getAnime(seasonId)
      .then((d) => alive && setSeasonEpisodes(d))
      .catch(() => alive && setSeasonEpisodes(null));
    return () => {
      alive = false;
    };
  }, [seasonId, id, data]);

  const active = seasonId === id ? data : seasonEpisodes;
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

  const watched = new Set(active?.progress?.watchedEpisodes ?? []);
  const poster = data.poster;

  const visible = episodes.slice(chunk * EPS_PER_CHUNK, (chunk + 1) * EPS_PER_CHUNK);
  const rangeLabel = episodes.length
    ? `Ep ${visible[0]?.number}–${visible[visible.length - 1]?.number} of ${episodes.length}`
    : "";

  async function toggleFavorite() {
    if (!data || favPending) return;
    setFavPending(true);
    try {
      if (isFavorite(data.id)) {
        removeFavorite(data.id);
      } else {
        addFavorite(data.id, data.title, data.poster ?? undefined);
      }
      setData({ ...data, isFavorite: !isFavorite(data.id) });
    } finally {
      setFavPending(false);
    }
  }

  const share = async () => {
    const url = `${location.origin}${location.pathname}#/anime/${encodeURIComponent(data.id)}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: data.title, url });
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
              <img src={poster} alt={data.title} />
            ) : (
              <div className="detail-poster-fallback">{data.title.slice(0, 1).toUpperCase()}</div>
            )}
          </div>
          <div className="detail-info">
            <h1>{data.title}</h1>
            {data.meta?.japanese && <p className="detail-jp">{data.meta.japanese}</p>}
            <div className="chip-row">
              {data.meta?.status && <span className="chip">{data.meta.status}</span>}
              {data.meta?.duration && <span className="chip">{data.meta.duration}</span>}
              {data.meta?.aired && <span className="chip">{data.meta.aired}</span>}
              {data.meta?.malScore && <span className="chip score">★ {data.meta.malScore}</span>}
            </div>
            {data.meta?.genres.length ? (
              <div className="genre-row">
                {data.meta.genres.map((g) => (
                  <span key={g} className="genre-pill">
                    {g}
                  </span>
                ))}
              </div>
            ) : null}
            {data.description ? <p className="detail-desc">{data.description}</p> : null}
            {(data.meta?.studios || data.meta?.producers) && (
              <p className="detail-studios">
                {[
                  data.meta?.studios ? `Studio: ${data.meta.studios}` : null,
                  data.meta?.producers ? `Producer: ${data.meta.producers}` : null,
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
                {data.isFavorite ? <Check size={17} /> : <Plus size={17} />}
                {data.isFavorite ? "In My List" : "Add to List"}
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
          </div>
          <div className="season-chips">
            <button
              className={`season-chip${seasonId === id ? " active" : ""}`}
              onClick={() => setSeasonId(id)}
            >
              {data.title}
            </button>
            {data.seasons.map((s) => (
              <button
                key={s.id}
                className={`season-chip${seasonId === s.id ? " active" : ""}`}
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
