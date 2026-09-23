import { Flame } from "lucide-react";
import { useHome } from "../hooks/useAnime.js";
import { AnimeCard } from "./AnimeCard.js";
import { CardSkeletons, EmptyState } from "./ui/primitives.js";

export function Trending() {
  const { data, loading, error } = useHome();
  const trending = data?.sections.find((s) => s.id === "trending");

  return (
    <div className="page">
      <div className="page-head">
        <h1>Trending Now</h1>
        <p className="sub">What everyone is watching this moment.</p>
      </div>
      {loading && <CardSkeletons count={12} />}
      {error && (
        <div className="error-box">
          <strong>Could not load trending.</strong>
          <div className="muted" style={{ marginTop: 6 }}>
            {error}
          </div>
        </div>
      )}
      {!loading && !error && (!trending || trending.items.length === 0) && (
        <EmptyState icon={Flame} title="No trending data">
          The provider did not return a trending list right now. Check back soon.
        </EmptyState>
      )}
      {trending && trending.items.length > 0 && (
        <div className="grid">
          {trending.items.map((item, i) => (
            <AnimeCard
              key={item.id}
              id={item.id}
              title={item.title}
              poster={item.poster}
              rank={i + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
