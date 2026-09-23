import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type AnimeDetailsResponse } from "../api.js";
import { getProgress, saveProgress as storeSaveProgress } from "../userStore.js";
import type { AudioMode, EpisodeSources } from "../../shared/types.js";
import { navigate } from "../router.js";
import { useEpisodeChunk, EpisodeTabs } from "./EpisodePager.js";

const MODE_KEY = "anistream.mode";

export function Watch({ animeId, epParam }: { animeId: string; epParam: string | null }) {
  const [details, setDetails] = useState<AnimeDetailsResponse | null>(null);
  const [mode, setMode] = useState<AudioMode>(
    () => (localStorage.getItem(MODE_KEY) as AudioMode | null) ?? "sub",
  );
  const [sources, setSources] = useState<EpisodeSources | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  // episode is derived from the URL (?ep=) with saved progress / first episode
  // as fallback — deriving keeps the player in sync when the URL changes
  const defaultEp = details?.progress?.episodeNumber ?? details?.episodes[0]?.number ?? null;
  const ep = epParam ?? defaultEp;
  const [loadingSources, setLoadingSources] = useState(false);
  const [quality, setQuality] = useState(-1); // -1 = Auto (adaptive), else index into variants
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const resumeAtRef = useRef<number>(0);

  // load details (episode list, title); saved progress comes from the
  // browser store and is layered on top of the API payload
  useEffect(() => {
    let alive = true;
    setDetails(null);
    api
      .getAnime(animeId)
      .then((d) => alive && setDetails({ ...d, progress: getProgress(animeId) }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [animeId]);

  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode);
  }, [mode]);

  const fetchSources = useCallback(() => {
    if (!ep) return;
    let alive = true;
    setLoadingSources(true);
    setSourcesError(null);
    setSources(null);
    api
      .getSources(animeId, ep, mode)
      .then((s) => {
        if (!alive) return;
        setSources(s);
        setQuality(-1); // Auto
      })
      .catch((e: Error) => alive && setSourcesError(e.message))
      .finally(() => alive && setLoadingSources(false));
    return () => {
      alive = false;
    };
  }, [animeId, ep, mode]);

  useEffect(() => {
    const cleanup = fetchSources();
    return cleanup;
  }, [fetchSources]);

  // attach player when sources load or a fixed quality is picked
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !sources) return;

    resumeAtRef.current = 0;
    const saved = details?.progress;
    if (saved && saved.episodeNumber === ep && saved.positionSeconds > 15) {
      resumeAtRef.current = saved.positionSeconds;
    }

    let hls: import("hls.js").default | null = null;
    let cancelled = false;

    const onLoaded = () => {
      if (resumeAtRef.current > 0 && resumeAtRef.current < video.duration - 20) {
        video.currentTime = resumeAtRef.current;
      }
    };
    video.addEventListener("loadedmetadata", onLoaded);

    // -1 = Auto: feed hls.js the master playlist so it can switch quality
    // mid-stream instead of stalling when bandwidth dips
    const useAdaptive = quality < 0 && !!sources.masterUrl;
    const url = useAdaptive
      ? sources.masterUrl!
      : (sources.variants[quality]?.url ??
          sources.variants[0]?.url ??
          sources.masterUrl ??
          "");
    if (!url) return;

    const recoveryCounters = { network: 0, media: 0 };

    if (video.canPlayType("application/vnd.apple.mpegurl") !== "") {
      // native HLS (Safari) — no library needed
      video.src = url;
    } else {
      // lazy-load hls.js only when the browser needs it
      void import("hls.js").then(({ default: HlsMod }) => {
        if (cancelled) return;
        if (!HlsMod.isSupported()) {
          setSourcesError("HLS is not supported in this browser");
          return;
        }
        hls = new HlsMod({
          // ~2 min of buffer ahead: ride out bandwidth dips without stalling
          maxBufferLength: 120,
          maxMaxBufferLength: 240,
          backBufferLength: 60,
          // ABR needs a real bandwidth estimate; default is pessimistic
          abrEwmaDefaultEstimate: 1_500_000,
        });
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(HlsMod.Events.ERROR, (_evt, data) => {
          if (!data.fatal) return;
          if (data.type === HlsMod.ErrorTypes.NETWORK_ERROR && recoveryCounters.network < 3) {
            recoveryCounters.network++;
            hls?.startLoad(); // retry — transient segment/playlist failures
            return;
          }
          if (data.type === HlsMod.ErrorTypes.MEDIA_ERROR && recoveryCounters.media < 2) {
            recoveryCounters.media++;
            hls?.recoverMediaError();
            return;
          }
          setSourcesError(`player error: ${data.details}`);
        });
      });
    }

    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", onLoaded);
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [sources, quality, ep, details]);

  // periodic progress saving
  useEffect(() => {
    if (!sources) return;
    const title = sources.animeTitle;
    const save = (final = false) => {
      const v = videoRef.current;
      if (!v || !v.duration || Number.isNaN(v.duration)) return;
      storeSaveProgress({
        animeId,
        animeTitle: title,
        episodeNumber: ep ?? "1",
        positionSeconds: final ? v.duration : v.currentTime,
        durationSeconds: v.duration,
        mode,
      });
    };
    const interval = setInterval(() => save(), 10_000);
    const onEnded = () => save(true);
    const onHide = () => {
      const v = videoRef.current;
      if (!v || !v.duration) return;
      storeSaveProgress({
        animeId,
        animeTitle: title,
        episodeNumber: ep ?? "1",
        positionSeconds: v.currentTime,
        durationSeconds: v.duration,
        mode,
      });
    };
    window.addEventListener("pagehide", onHide);
    videoRef.current?.addEventListener("ended", onEnded);
    return () => {
      clearInterval(interval);
      window.removeEventListener("pagehide", onHide);
      videoRef.current?.removeEventListener("ended", onEnded);
    };
  }, [sources, animeId, ep, mode]);

  const episodes = details?.episodes ?? [];
  const numbers = useMemo(() => episodes.map((e) => e.number), [episodes]);
  const { chunk, setChunk, chunkCount } = useEpisodeChunk(numbers, 50, ep ?? undefined);
  const visibleEps = episodes.slice(chunk * 50, (chunk + 1) * 50);
  const epIndex = episodes.findIndex((e) => e.number === ep);
  const prevEp = epIndex > 0 ? episodes[epIndex - 1] : null;
  const nextEp = epIndex >= 0 && epIndex < episodes.length - 1 ? episodes[epIndex + 1] : null;

  // Clean "audio not available" messaging (the API sends a distinct error for
  // missing sub/dub instead of raw resolver noise).
  const audioHint =
    sourcesError && /no (dub|sub) available/i.test(sourcesError)
      ? mode === "dub"
        ? "No DUB available for this episode"
        : "No SUB available for this episode"
      : null;
  const otherModeAvailable = audioHint !== null;

  if (!details) {
    return (
      <div className="page">
        <div className="skeleton" style={{ height: 0, paddingBottom: "56.25%", borderRadius: 14, marginBottom: 16 }} />
        <div className="sk-line skeleton" style={{ width: "40%" }} />
      </div>
    );
  }

  const goEp = (n: string) =>
    navigate(`/watch/${encodeURIComponent(animeId)}?ep=${encodeURIComponent(n)}`);

  return (
    <div className="page">
      <div className="page-head">
        <h1>
          {details.title} — Episode {ep ?? "?"}
        </h1>
        <p className="sub">
          <a href={`#/anime/${encodeURIComponent(animeId)}`}>← Back to details</a>
        </p>
      </div>

      <div className="watch-layout">
        <div>
          <div className="player-box">
            <video
              ref={videoRef}
              className="player-video"
              controls
              autoPlay
              playsInline
              crossOrigin="anonymous"
              webkit-playsinline="true"
              onError={() =>
                setSourcesError(
                  "Video failed to load — the stream may have expired. Try reloading it.",
                )
              }
            >
              {(sources?.subtitles ?? []).map((s) => (
                <track
                  key={s.src}
                  src={s.src}
                  kind="subtitles"
                  label={s.label}
                  srcLang={s.lang}
                  default={s.default}
                />
              ))}
            </video>
          </div>

          <div className="player-controls">
            <button className="btn" disabled={!prevEp} onClick={() => prevEp && goEp(prevEp.number)}>
              ← Prev
            </button>
            <button className="btn" disabled={!nextEp} onClick={() => nextEp && goEp(nextEp.number)}>
              Next →
            </button>

            <div style={{ display: "flex", gap: 6 }}>
              {(["sub", "dub"] as AudioMode[]).map((m) => (
                <button
                  key={m}
                  className={`btn${mode === m ? " btn-primary" : ""}`}
                  onClick={() => setMode(m)}
                >
                  {m.toUpperCase()}
                </button>
              ))}
            </div>

            {sources && sources.variants.length > 1 && (
              <select
                className="season-select"
                value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
              >
                {sources.masterUrl && <option value={-1}>Auto (adaptive)</option>}
                {sources.variants.map((v, i) => (
                  <option key={v.rawUrl} value={i}>
                    {v.quality}
                  </option>
                ))}
              </select>
            )}

            <button className="btn" onClick={() => fetchSources()}>
              Reload stream
            </button>
          </div>

          {loadingSources && (
            <div className="skeleton" style={{ height: 220, marginTop: 16, borderRadius: 14 }} />
          )}
          {sourcesError && (
            <div className="error-box" style={{ marginTop: 14 }}>
              {audioHint ? (
                <>
                  <strong>{audioHint}</strong>
                  <div className="muted" style={{ marginTop: 6 }}>
                    This episode isn't available in {mode.toUpperCase()} audio right now.
                  </div>
                  {otherModeAvailable && (
                    <button
                      className="btn btn-primary"
                      style={{ marginTop: 12 }}
                      onClick={() => setMode(mode === "sub" ? "dub" : "sub")}
                    >
                      Switch to {mode === "sub" ? "DUB" : "SUB"}
                    </button>
                  )}
                  <div style={{ marginTop: 10 }}>
                    <button className="btn" onClick={() => fetchSources()}>
                      Retry
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <strong>Could not start playback.</strong>
                  <div className="muted" style={{ marginTop: 6 }}>
                    {sourcesError}
                  </div>
                  <button className="btn" style={{ marginTop: 10 }} onClick={() => fetchSources()}>
                    Retry
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <aside className="watch-side">
          <h2>Episodes</h2>
          <EpisodeTabs
            chunkCount={chunkCount}
            chunk={chunk}
            onPick={setChunk}
            rangeLabel={
              episodes.length
                ? `${visibleEps[0]?.number}–${visibleEps[visibleEps.length - 1]?.number}`
                : undefined
            }
          />
          <div className="episode-list">
            {visibleEps.map((e) => (
              <button
                key={e.id}
                className={`episode-row${e.number === ep ? " current" : ""}`}
                onClick={() => goEp(e.number)}
              >
                <span>Episode {e.number}</span>
                {details.progress?.watchedEpisodes?.includes(e.number) && (
                  <span style={{ color: "var(--accent)" }}>✓</span>
                )}
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
