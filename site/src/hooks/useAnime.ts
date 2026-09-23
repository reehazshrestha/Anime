import { useEffect, useState } from "react";
import { api, type AnimeDetailsResponse } from "../api.js";
import type {
  AnimeSearchResult,
  EpisodeInfo,
  HomeSection,
} from "../../shared/types.js";

/** Generic async state machine used by every hook below. */
interface Async<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> {
  const [state, setState] = useState<Async<T>>({ data: null, loading: true, error: null });
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn()
      .then((data) => alive && setState({ data, loading: false, error: null }))
      .catch((e: Error) => alive && setState({ data: null, loading: false, error: e.message }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export function useHome() {
  return useAsync<{ sections: HomeSection[] }>(() => api.home(), []);
}

export function useSearchResults(query: string) {
  return useAsync<{ results: AnimeSearchResult[] }>(
    () => api.search(query),
    [query],
  );
}

export function useGenreResults(genre: string, page: number, retryKey: number = 0) {
  return useAsync<{ results: AnimeSearchResult[]; page: number }>(
    () => api.browseGenre(genre, page),
    [genre, page, retryKey],
  );
}

export function useAnimeDetails(id: string) {
  return useAsync<AnimeDetailsResponse>(() => api.getAnime(id), [id]);
}

export function useEpisodes(id: string): Async<EpisodeInfo[]> {
  const res = useAsync<{ episodes: EpisodeInfo[] }>(
    () => api.getEpisodes(id),
    [id],
  );
  return {
    data: res.data?.episodes ?? null,
    loading: res.loading,
    error: res.error,
  };
}

/** Debounced search for the suggestion dropdown. */
export function useDebouncedSearch(query: string, delay = 250) {
  const [state, setState] = useState<Async<AnimeSearchResult[]>>({
    data: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      api
        .search(q)
        .then((r) => alive && setState({ data: r.results.slice(0, 6), loading: false, error: null }))
        .catch((e: Error) => alive && setState({ data: [], loading: false, error: e.message }));
    }, delay);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, delay]);

  return state;
}
