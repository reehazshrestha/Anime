import { useEffect, useRef, useState } from "react";
import { Menu, Moon, Search, Sun, X } from "lucide-react";
import { navigate } from "../../router.js";
import { useTheme } from "../../theme.js";
import { useDebouncedSearch } from "../../hooks/useAnime.js";

function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function Suggestions({
  query,
  onPick,
  onSeeAll,
}: {
  query: string;
  onPick: () => void;
  onSeeAll: () => void;
}) {
  const { data, loading, error } = useDebouncedSearch(query);
  const [hl, setHl] = useState(-1);
  useEffect(() => setHl(-1), [data]);

  if (loading && !data) {
    return (
      <div className="suggest">
        <div className="suggest-empty">Searching…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="suggest">
        <div className="suggest-empty">Something went wrong. Try again.</div>
      </div>
    );
  }
  if (!data || data.length === 0) {
    return (
      <div className="suggest">
        <div className="suggest-empty">No matches for “{query.trim()}”</div>
      </div>
    );
  }

  return (
    <div className="suggest" role="listbox">
      {data.map((it, i) => (
        <button
          key={it.id}
          role="option"
          aria-selected={hl === i}
          className={`suggest-item${hl === i ? " hl" : ""}`}
          onMouseEnter={() => setHl(i)}
          onClick={() => {
            onPick();
            navigate(`/anime/${encodeURIComponent(it.id)}`);
          }}
        >
          {it.poster ? (
            <img className="suggest-thumb" src={it.poster} alt="" loading="lazy" />
          ) : (
            <span
              className="suggest-thumb-fallback"
              style={{ background: `hsl(${hue(it.id)} 45% 38%)` }}
            >
              {it.title.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span style={{ minWidth: 0 }}>
            <span className="suggest-name">{it.title}</span>
            <div className="suggest-type">
              {it.id.replace(/-[0-9]+$/, "").replaceAll("-", " ")}
            </div>
          </span>
        </button>
      ))}
      <div
        className="suggest-foot"
        onMouseEnter={() => setHl(-1)}
        onClick={() => {
          onSeeAll();
          navigate(`/search?q=${encodeURIComponent(query.trim())}`);
        }}
      >
        See all results →
      </div>
    </div>
  );
}

export function TopBar({ onMenu }: { onMenu: () => void }) {
  const { theme, toggle } = useTheme();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // outside click closes suggestions
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // ⌘K / Ctrl+K focuses search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <div className="topbar">
      <button className="icon-btn mobile-menu-btn" onClick={onMenu} aria-label="Open navigation">
        <Menu size={19} />
      </button>

      <div className="searchbox" ref={wrapRef}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const query = q.trim();
            if (!query) return;
            setOpen(false);
            navigate(`/search?q=${encodeURIComponent(query)}`);
          }}
        >
          <Search size={17} style={{ color: "var(--text-3)", flexShrink: 0 }} />
          <input
            ref={inputRef}
            type="search"
            placeholder="Search anime, genres…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
            aria-label="Search anime"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
          />
          {q ? (
            <button
              type="button"
              className="search-clear"
              onClick={() => {
                setQ("");
                setOpen(false);
                inputRef.current?.focus();
              }}
              aria-label="Clear search"
            >
              <X size={16} />
            </button>
          ) : (
            <span className="kbd kbd-desktop">{isMac ? "⌘K" : "Ctrl K"}</span>
          )}
        </form>
        {open && (
          <Suggestions
            query={q}
            onPick={() => {
              setQ("");
              setOpen(false);
            }}
            onSeeAll={() => setOpen(false)}
          />
        )}
      </div>

      <button
        className="icon-btn"
        onClick={toggle}
        aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        title="Toggle theme"
      >
        {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
      </button>
    </div>
  );
}
