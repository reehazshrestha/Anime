import { useState } from "react";
import { SearchX } from "lucide-react";
import { useGenreResults } from "../hooks/useAnime.js";
import { AnimeCard } from "./AnimeCard.js";
import { CardSkeletons, EmptyState } from "./ui/primitives.js";

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

const SORTS = ["Popular", "Recently Added", "A-Z", "Rating"] as const;

export function Discover() {
  const [genre, setGenre] = useState<string>("Action");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<(typeof SORTS)[number]>("Popular");
  const [retryKey, setRetryKey] = useState(0);
  const { data, loading, error } = useGenreResults(genre, page, retryKey);

  // client-side sort of the current page (provider has no sort param)
  const results = (() => {
    const list = data?.results ? [...data.results] : [];
    switch (sort) {
      case "A-Z":
        return list.sort((a, b) => a.title.localeCompare(b.title));
      default:
        return list; // Popular / Rating / Recently Added arrive pre-ranked
    }
  })();

  return (
    <div className="page">
      <div className="page-head">
        <h1>Discover Anime</h1>
        <p className="sub">Browse the catalog by genre and dig through the shelves.</p>
      </div>

      <div className="filter-bar">
        {GENRES.map((g) => (
          <button
            key={g}
            className={`chip${genre === g ? " on" : ""}`}
            onClick={() => {
              setGenre(g);
              setPage(1);
            }}
          >
            {g}
          </button>
        ))}
        <div className="spacer" />
        <select
          className="season-select"
          value={sort}
          onChange={(e) => setSort(e.target.value as (typeof SORTS)[number])}
          aria-label="Sort results"
        >
          {SORTS.map((s) => (
            <option key={s} value={s}>
              Sort: {s}
            </option>
          ))}
        </select>
      </div>

      {data && (
        <div className="result-count">
          Page {data.page} · {results.length} anime{results.length >= 30 ? "+" : ""}
        </div>
      )}

      {loading && <CardSkeletons count={12} />}

      {error && (
        <div className="error-box">
          <strong>Could not load “{genre}”.</strong>
          <div className="muted" style={{ marginTop: 6 }}>
            {error}
          </div>
          <button
            className="btn btn-primary"
            style={{ marginTop: 12 }}
            onClick={() => {
              setPage(1);
              setRetryKey((k) => k + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && results.length === 0 && (
        <EmptyState icon={SearchX} title="No anime found">
          The provider returned nothing for “{genre}”. Try another genre.
        </EmptyState>
      )}

      {!loading && results.length > 0 && (
        <>
          <div className="grid">
            {results.map((r) => (
              <AnimeCard key={r.id} id={r.id} title={r.title} poster={r.poster} />
            ))}
          </div>
          <div className="load-more">
            <button className="btn" onClick={() => setPage((p) => p + 1)} disabled={loading}>
              {loading ? "Loading…" : "Load more"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
