import { useEffect, useState } from "react";

export interface Route {
  path: string; // e.g. "/anime/x-123" (no query)
  segments: string[];
  query: URLSearchParams;
}

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [pathPart, queryPart] = raw.split("?");
  const path = pathPart || "/";
  return {
    path,
    segments: path.split("/").filter(Boolean),
    query: new URLSearchParams(queryPart ?? ""),
  };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function navigate(to: string): void {
  window.location.hash = to;
}
