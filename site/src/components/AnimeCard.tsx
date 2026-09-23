import { Play } from "lucide-react";
import { navigate } from "../router.js";

function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function AnimeCard({
  id,
  title,
  poster,
  type,
  badges,
  rank,
  sub,
  progressPct,
}: {
  id: string;
  title: string;
  poster?: string;
  type?: string;
  badges?: { sub?: number; dub?: number; eps?: number };
  rank?: number;
  sub?: string;
  progressPct?: number;
}) {
  const href = `#/anime/${encodeURIComponent(id)}`;
  const go = () => navigate(`/anime/${encodeURIComponent(id)}`);

  return (
    <a className="card" href={href} onClick={go} aria-label={title}>
      <div
        className="card-art"
        style={
          poster
            ? undefined
            : { background: `linear-gradient(135deg, hsl(${hue(id)} 40% 30%), var(--bg-4))` }
        }
      >
        {poster ? (
          <img className="card-img" src={poster} alt="" loading="lazy" />
        ) : (
          title.slice(0, 1).toUpperCase()
        )}

        <div className="card-overlay">
          <span className="card-play">
            <Play size={20} fill="currentColor" />
          </span>
        </div>

        {(badges?.sub || badges?.dub || badges?.eps) && (
          <div className="card-badges">
            {badges.sub ? <em className="badge badge-sub">SUB {badges.sub}</em> : null}
            {badges.dub ? <em className="badge badge-dub">DUB {badges.dub}</em> : null}
            {!badges.sub && !badges.dub && badges.eps ? (
              <em className="badge badge-eps">{badges.eps} EP</em>
            ) : null}
          </div>
        )}

        {rank !== undefined && <span className="card-rank">{String(rank).padStart(2, "0")}</span>}

        {typeof progressPct === "number" && (
          <div className="card-progress">
            <div className="fill" style={{ width: `${Math.min(100, Math.max(2, progressPct))}%` }} />
          </div>
        )}
      </div>

      <div className="card-meta">
        {type && <div className="card-type">{type}</div>}
        <div className="card-title">{title}</div>
        {sub && <div className="card-sub">{sub}</div>}
      </div>
    </a>
  );
}
