import { useEffect, useMemo, useState } from "react";

/**
 * Chunked episode pagination: numbered tabs (1, 2, 3…) where each tab holds a
 * chunk of `size` episodes, so a 1000-episode series never renders all at
 * once. Auto-selects the chunk containing `highlight` (current/resume ep) and
 * keeps following it when it changes (e.g. clicking "next episode").
 */
export function useEpisodeChunk(
  numbers: string[],
  size: number,
  highlight: string | undefined,
): { chunk: number; setChunk: (c: number) => void; chunkCount: number } {
  const chunkCount = Math.max(1, Math.ceil(numbers.length / size));

  const chunkOf = useMemo(() => {
    const index = new Map(numbers.map((n, i) => [n, i]));
    return (epNumber: string | undefined): number => {
      if (!epNumber) return 0;
      const idx = index.get(epNumber);
      if (idx !== undefined) return Math.min(chunkCount - 1, Math.floor(idx / size));
      const n = Number(epNumber);
      if (Number.isFinite(n) && n >= 1) {
        return Math.min(chunkCount - 1, Math.floor((n - 1) / size));
      }
      return 0;
    };
  }, [numbers, size, chunkCount]);

  const [chunk, setChunkRaw] = useState(() => chunkOf(highlight));

  // follow the highlighted episode across chunks
  useEffect(() => {
    setChunkRaw(chunkOf(highlight));
  }, [highlight, chunkOf]);

  const setChunk = (c: number) => setChunkRaw(Math.max(0, Math.min(chunkCount - 1, c)));

  return { chunk, setChunk, chunkCount };
}

/** The numbered tab strip. Hidden when everything fits in one chunk. */
export function EpisodeTabs({
  chunkCount,
  chunk,
  onPick,
  rangeLabel,
}: {
  chunkCount: number;
  chunk: number;
  onPick: (c: number) => void;
  rangeLabel?: string;
}) {
  if (chunkCount <= 1) return null;
  return (
    <div className="ep-tabs" role="tablist" aria-label="Episode pages">
      {Array.from({ length: chunkCount }, (_, c) => (
        <button
          key={c}
          role="tab"
          aria-selected={chunk === c}
          className={`ep-tab${chunk === c ? " active" : ""}`}
          onClick={() => onPick(c)}
        >
          {c + 1}
        </button>
      ))}
      {rangeLabel && <span className="ep-range-label">{rangeLabel}</span>}
    </div>
  );
}
