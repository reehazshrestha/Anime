import { useCallback, useEffect, useRef, useState } from "react";
import { AnimeCard } from "./AnimeCard.js";
import type { HomeSection } from "../../shared/types.js";

/**
 * Horizontal poster rail with hover-visible scroll arrows.
 * Arrows page by ~80% of the visible width; hidden on touch devices
 * (native swipe) and when there's nothing to scroll toward.
 */
export function Rail({ section }: { section: HomeSection }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    update();
    const el = trackRef.current;
    if (!el) return;
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [update, section.items.length]);

  const page = (dir: -1 | 1) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };

  const ranked = section.id.startsWith("top10-");

  return (
    <div className="section">
      <div className="section-head">
        <h2>{section.title}</h2>
      </div>
      <div className="rail">
        <button
          className={`rail-arrow left${canLeft ? " visible" : ""}`}
          onClick={() => page(-1)}
          aria-label={`Scroll ${section.title} left`}
          tabIndex={canLeft ? 0 : -1}
        >
          ‹
        </button>
        <div className="rail-track" ref={trackRef}>
          {section.items.map((item, i) => (
            <AnimeCard
              key={item.id}
              id={item.id}
              title={item.title}
              poster={item.poster}
              type={item.type}
              rank={ranked ? i + 1 : undefined}
              badges={{
                sub: item.subCount,
                dub: item.dubCount,
                eps: item.epCount,
              }}
            />
          ))}
        </div>
        <button
          className={`rail-arrow right${canRight ? " visible" : ""}`}
          onClick={() => page(1)}
          aria-label={`Scroll ${section.title} right`}
          tabIndex={canRight ? 0 : -1}
        >
          ›
        </button>
      </div>
    </div>
  );
}
