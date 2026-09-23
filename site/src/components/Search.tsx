import { SearchX } from "lucide-react";
import { useSearchResults } from "../hooks/useAnime.js";
import { AnimeCard } from "./AnimeCard.js";
import { CardSkeletons, EmptyState } from "./ui/primitives.js";

export function Search({ query }: { query: string }) {
  const { data, loading, error } = useSearchResults(query);
  const results = data?.results;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Results for “{query}”</h1>
        <p className="sub">
          {loading
            ? "Searching…"
            : error
              ? "—"
              : `${results?.length ?? 0} found`}
        </p>
      </div>

      {loading && <CardSkeletons count={12} />}

      {error && (
        <div className="error-box">
          <strong>Something went wrong. Try again.</strong>
          <div className="muted" style={{ marginTop: 6 }}>
            {error}
          </div>
        </div>
      )}

      {!loading && !error && results && results.length === 0 && (
        <EmptyState icon={SearchX} title="No anime found">
          Nothing matched “{query}”. Try a shorter or different spelling.
        </EmptyState>
      )}

      {!loading && results && results.length > 0 && (
        <div className="grid">
          {results.map((r) => (
            <AnimeCard key={r.id} id={r.id} title={r.title} poster={r.poster} />
          ))}
        </div>
      )}
    </div>
  );
}
