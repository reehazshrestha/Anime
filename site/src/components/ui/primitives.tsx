import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** Poster-grid skeleton matching real card dimensions. */
export function CardSkeletons({ count = 12 }: { count?: number }) {
  return (
    <div className="sk-grid" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div className="sk-card" key={i}>
          <div className="sk-art skeleton" />
          <div className="sk-line skeleton" style={{ width: "88%" }} />
          <div className="sk-line skeleton" style={{ width: "55%", marginBottom: 0 }} />
        </div>
      ))}
    </div>
  );
}

/** Rail skeleton matching horizontal card dimensions. */
export function RailSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="rail-track" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div className="sk-card" key={i} style={{ flex: "0 0 158px" }}>
          <div className="sk-art skeleton" />
          <div className="sk-line skeleton" style={{ width: "88%" }} />
          <div className="sk-line skeleton" style={{ width: "55%", marginBottom: 0 }} />
        </div>
      ))}
    </div>
  );
}

/** Intentional empty state: icon + title + explanation (+ optional CTA). */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Icon size={36} strokeWidth={1.6} />
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
