/**
 * Browser-backed user data store: watch progress + favorites.
 *
 * Everything lives in localStorage under "anistream.userData" — fully
 * private, per device, no backend required. Shapes mirror the API's
 * ProgressEntry / FavoriteEntry, so the UI code is storage-agnostic and a
 * future cloud-sync layer can slot in behind this module.
 */

import type { AudioMode, FavoriteEntry, ProgressEntry } from "../shared/types.js";

const KEY = "anistream.userData";

interface UserData {
  progress: Record<string, ProgressEntry>;
  favorites: Record<string, FavoriteEntry>;
}

function empty(): UserData {
  return { progress: {}, favorites: {} };
}

function load(): UserData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<UserData>;
    return {
      progress: parsed.progress ?? {},
      favorites: parsed.favorites ?? {},
    };
  } catch {
    return empty();
  }
}

function save(data: UserData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // storage full/blocked — drop the write rather than crash playback
  }
}

function nowMs(): number {
  return Date.now();
}

// ---------------- progress ----------------

export function listProgress(): ProgressEntry[] {
  return Object.values(load().progress).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getProgress(animeId: string): ProgressEntry | null {
  return load().progress[animeId] ?? null;
}

export function saveProgress(entry: {
  animeId: string;
  animeTitle: string;
  episodeNumber: string;
  positionSeconds: number;
  durationSeconds: number;
  mode: AudioMode;
}): void {
  const data = load();
  const existing = data.progress[entry.animeId];
  const watched = new Set(existing?.watchedEpisodes ?? []);
  if (
    entry.durationSeconds > 0 &&
    entry.positionSeconds / Math.max(1, entry.durationSeconds) >= 0.9
  ) {
    watched.add(entry.episodeNumber);
  }
  const next: ProgressEntry = {
    ...entry,
    positionSeconds: Math.max(0, Math.floor(entry.positionSeconds)),
    durationSeconds: Math.max(0, Math.floor(entry.durationSeconds)),
    updatedAt: nowMs(),
    mode: entry.mode === "dub" ? "dub" : "sub",
    watchedEpisodes: [...watched].sort((a, b) => (Number(a) || 0) - (Number(b) || 0)),
    // keep the saved poster if we have one
    poster: existing?.poster,
  };
  data.progress[entry.animeId] = next;
  save(data);
}

export function deleteProgress(animeId: string): void {
  const data = load();
  delete data.progress[animeId];
  save(data);
}

// ---------------- favorites ----------------

export function listFavorites(): FavoriteEntry[] {
  return Object.values(load().favorites).sort((a, b) => b.addedAt - a.addedAt);
}

export function isFavorite(animeId: string): boolean {
  return animeId in load().favorites;
}

export function addFavorite(animeId: string, animeTitle: string, poster?: string): void {
  const data = load();
  const existing = data.favorites[animeId];
  data.favorites[animeId] = {
    animeId,
    animeTitle: animeTitle || existing?.animeTitle || animeId,
    addedAt: existing?.addedAt ?? nowMs(),
    poster: poster ?? existing?.poster,
  };
  save(data);
}

export function removeFavorite(animeId: string): void {
  const data = load();
  delete data.favorites[animeId];
  save(data);
}

// ---------------- maintenance ----------------

export function clearAll(): void {
  save(empty());
}

export function storageEstimate(): number {
  try {
    return new Blob([localStorage.getItem(KEY) ?? ""]).size;
  } catch {
    return 0;
  }
}
