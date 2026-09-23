import {
  Home,
  Compass,
  Flame,
  CalendarDays,
  LayoutGrid,
  Bookmark,
  History,
  PlayCircle,
  Settings,
  Clapperboard,
} from "lucide-react";
import { navigate } from "../../router.js";

export interface NavItem {
  label: string;
  href: string;
  icon: typeof Home;
  match: (segs: string[]) => boolean;
}

export const NAV_MAIN: NavItem[] = [
  { label: "Home", href: "/", icon: Home, match: (s) => s.length === 0 },
  { label: "Discover", href: "/discover", icon: Compass, match: (s) => s[0] === "discover" },
  { label: "Trending", href: "/trending", icon: Flame, match: (s) => s[0] === "trending" },
  { label: "Genres", href: "/genres", icon: LayoutGrid, match: (s) => s[0] === "genres" },
];

export const NAV_LIBRARY: NavItem[] = [
  { label: "My List", href: "/library", icon: Bookmark, match: (s) => s[0] === "library" },
  { label: "Continue", href: "/continue", icon: PlayCircle, match: (s) => s[0] === "continue" },
  { label: "History", href: "/history", icon: History, match: (s) => s[0] === "history" },
];

export const NAV_SYSTEM: NavItem[] = [
  { label: "Settings", href: "/settings", icon: Settings, match: (s) => s[0] === "settings" },
];

export function NavLinks({ activeSegs, onNavigate }: { activeSegs: string[]; onNavigate?: () => void }) {
  const groups: [string, NavItem[]][] = [
    ["Main", NAV_MAIN],
    ["Library", NAV_LIBRARY],
    ["System", NAV_SYSTEM],
  ];
  return (
    <>
      {groups.map(([title, items]) => (
        <div key={title}>
          <div className="side-group">{title}</div>
          {items.map((item) => {
            const active = item.match(activeSegs);
            return (
              <a
                key={item.href}
                href={`#${item.href}`}
                className={`side-link${active ? " active" : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={() => onNavigate?.()}
              >
                <item.icon size={18} strokeWidth={1.9} />
                {item.label}
              </a>
            );
          })}
        </div>
      ))}
    </>
  );
}

export function Sidebar({ activeSegs }: { activeSegs: string[] }) {
  return (
    <aside className="sidebar">
      <a className="side-brand" href="#/" onClick={() => navigate("/")}>
        <span className="mark">
          <Clapperboard size={16} />
        </span>
        Ani<span>Stream</span>
      </a>
      <NavLinks activeSegs={activeSegs} />
      <div className="side-spacer" />
      <div className="side-group">Now streaming</div>
      <div className="side-link" style={{ cursor: "default", opacity: 0.6 }}>
        <CalendarDays size={18} strokeWidth={1.9} />
        New episodes daily
      </div>
    </aside>
  );
}
