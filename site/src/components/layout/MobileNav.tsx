import { useEffect } from "react";
import { Bookmark, Compass, History, Home, PlayCircle } from "lucide-react";
import { NavLinks } from "./Sidebar.js";

const BOTTOM_ITEMS = [
  { label: "Home", href: "/", icon: Home, match: (s: string[]) => s.length === 0 },
  { label: "Discover", href: "/discover", icon: Compass, match: (s: string[]) => s[0] === "discover" },
  { label: "Library", href: "/library", icon: Bookmark, match: (s: string[]) => s[0] === "library" },
  { label: "Continue", href: "/continue", icon: PlayCircle, match: (s: string[]) => s[0] === "continue" },
  { label: "History", href: "/history", icon: History, match: (s: string[]) => s[0] === "history" },
];

export function BottomNav({ activeSegs }: { activeSegs: string[] }) {
  return (
    <nav className="bottom-nav" aria-label="Mobile navigation">
      {BOTTOM_ITEMS.map((item) => {
        const active = item.match(activeSegs);
        return (
          <a
            key={item.href}
            href={`#${item.href}`}
            className={active ? "active" : ""}
            aria-current={active ? "page" : undefined}
          >
            <item.icon size={19} strokeWidth={1.9} />
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}

export function Drawer({
  open,
  onClose,
  activeSegs,
}: {
  open: boolean;
  onClose: () => void;
  activeSegs: string[];
}) {
  // lock body scroll + close on Escape while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="drawer-overlay" onClick={onClose} aria-hidden />
      <div className="drawer" role="dialog" aria-label="Navigation" aria-modal="true">
        <NavLinks activeSegs={activeSegs} onNavigate={onClose} />
      </div>
    </>
  );
}
