import { useEffect, useState } from "react";
import { useRoute } from "./router.js";
import { Sidebar } from "./components/layout/Sidebar.js";
import { TopBar } from "./components/layout/TopBar.js";
import { BottomNav, Drawer } from "./components/layout/MobileNav.js";
import { Home } from "./components/Home.js";
import { Search } from "./components/Search.js";
import { AnimeDetails } from "./components/AnimeDetails.js";
import { Watch } from "./components/Watch.js";
import { Discover } from "./components/Discover.js";
import { Trending } from "./components/Trending.js";
import { Continue, GenreBrowse, Genres, History, Library, Settings } from "./components/Library.js";

export function App() {
  const route = useRoute();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const segs = route.segments;

  // close the drawer on navigation
  useEffect(() => setDrawerOpen(false), [route]);

  let page: React.ReactNode;
  if (segs[0] === "anime" && segs[1]) {
    page = <AnimeDetails id={decodeURIComponent(segs[1])} />;
  } else if (segs[0] === "watch" && segs[1]) {
    page = (
      <Watch
        animeId={decodeURIComponent(segs[1])}
        epParam={route.query.get("ep")}
      />
    );
  } else if (segs[0] === "search") {
    page = <Search query={route.query.get("q") ?? ""} />;
  } else if (segs[0] === "discover") {
    page = <Discover />;
  } else if (segs[0] === "trending") {
    page = <Trending />;
  } else if (segs[0] === "genres") {
    page = <Genres />;
  } else if (segs[0] === "genre" && segs[1]) {
    page = <GenreBrowse genre={decodeURIComponent(segs[1])} />;
  } else if (segs[0] === "library") {
    page = <Library />;
  } else if (segs[0] === "continue") {
    page = <Continue />;
  } else if (segs[0] === "history") {
    page = <History />;
  } else if (segs[0] === "settings") {
    page = <Settings />;
  } else {
    page = <Home />;
  }

  return (
    <div className="shell">
      <Sidebar activeSegs={segs} />
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} activeSegs={segs} />
      <div className="main">
        <TopBar onMenu={() => setDrawerOpen(true)} />
        {page}
      </div>
      <BottomNav activeSegs={segs} />
    </div>
  );
}
