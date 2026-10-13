import { useEffect } from "react";
import { api } from "../api.js";
import { savePosterIfMissing } from "../userStore.js";
import type { ProgressEntry } from "../../shared/types.js";

/**
 * Backfill cover art for progress entries that were saved before posters
 * were captured (older localStorage data). Fetches details lazily and
 * persists each poster once; `onChange` lets the caller re-read the store
 * so cards repaint with real art instead of letter fallbacks.
 */
export function useProgressPosterBackfill(
  entries: ProgressEntry[],
  onChange: () => void,
): void {
  useEffect(() => {
    let cancelled = false;
    const missing = entries.filter((e) => !e.poster).slice(0, 6);
    if (missing.length === 0) return;
    (async () => {
      for (const entry of missing) {
        if (cancelled) return;
        try {
          const details = await api.getAnime(entry.animeId);
          if (cancelled) return;
          if (details.poster && savePosterIfMissing(entry.animeId, details.poster)) {
            onChange();
          }
        } catch {
          // details unavailable — keep the letter fallback for this entry
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entries, onChange]);
}
