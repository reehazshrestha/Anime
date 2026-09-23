import { promises as fs } from "node:fs";
import path from "node:path";
import type { FavoriteEntry, ProgressEntry } from "../shared/types.js";

interface StoreShape {
  progress: Record<string, ProgressEntry>; // key: animeId
  favorites: Record<string, FavoriteEntry>; // key: animeId
}

const DATA_DIR = process.env.ANISTREAM_DATA_DIR ?? path.join(process.cwd(), "server", "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");

let state: StoreShape = { progress: {}, favorites: {} };
let writeTimer: NodeJS.Timeout | null = null;

export async function initStore(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    state = {
      progress: parsed.progress ?? {},
      favorites: parsed.favorites ?? {},
    };
  } catch {
    state = { progress: {}, favorites: {} };
    await persistNow();
  }
}

function schedulePersist(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void persistNow();
  }, 400);
}

async function persistNow(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, DATA_FILE);
}

export function listProgress(): ProgressEntry[] {
  return Object.values(state.progress).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getProgress(animeId: string): ProgressEntry | undefined {
  return state.progress[animeId];
}

export function saveProgress(entry: ProgressEntry): void {
  const existing = state.progress[entry.animeId];
  const watched = new Set(existing?.watchedEpisodes ?? []);
  if (
    entry.durationSeconds > 0 &&
    entry.positionSeconds / Math.max(1, entry.durationSeconds) >= 0.9
  ) {
    watched.add(entry.episodeNumber);
  }
  state.progress[entry.animeId] = { ...entry, watchedEpisodes: [...watched] };
  schedulePersist();
}

export function deleteProgress(animeId: string): void {
  delete state.progress[animeId];
  schedulePersist();
}

export function listFavorites(): FavoriteEntry[] {
  return Object.values(state.favorites).sort((a, b) => b.addedAt - a.addedAt);
}

export function isFavorite(animeId: string): boolean {
  return animeId in state.favorites;
}

export function addFavorite(animeId: string, animeTitle: string): void {
  state.favorites[animeId] = { animeId, animeTitle, addedAt: Date.now() };
  schedulePersist();
}

export function removeFavorite(animeId: string): void {
  delete state.favorites[animeId];
  schedulePersist();
}
