export type AudioMode = "sub" | "dub";

export interface AnimeSearchResult {
  id: string; // anidb slug e.g. "cyberpunk-edgerunners-17742"
  title: string;
  /** Proxied cover/poster image URL (via /img). */
  poster?: string;
}

/** An item on a home-screen rail (trending, latest, new releases, …). */
export interface HomeItem extends AnimeSearchResult {
  /** Episode counts advertised by the provider. */
  subCount?: number;
  dubCount?: number;
  /** Total / latest episode count (tick-eps). */
  epCount?: number;
  /** Catalog type, e.g. "TV", "MOVIE", "OVA". */
  type?: string;
}

export interface HomeSection {
  id: string; // "trending" | "latest" | "new" | "top10" | "upcoming"
  title: string;
  items: HomeItem[];
}

/** Extra metadata shown on the anime detail page. */
export interface AnimeMeta {
  japanese?: string;
  status?: string;
  aired?: string;
  duration?: string;
  malScore?: string;
  studios?: string;
  producers?: string;
  genres: string[];
}

export interface AnimeDetails extends AnimeSearchResult {
  malId: number | null;
  seasons: AnimeSearchResult[];
  /** Long synopsis (provider overview). */
  description?: string;
  meta?: AnimeMeta;
}

export interface EpisodeInfo {
  id: string; // anidb numeric episode id
  number: string; // episode number as anidb lists it (can be e.g. "1", "S1")
}

export interface SourceVariant {
  quality: string; // e.g. "1080p"
  url: string; // proxied stream URL to feed the player
  rawUrl: string; // upstream m3u8 (proxied via /stream anyway)
}

export interface SubtitleTrack {
  src: string; // proxied vtt url
  lang: string;
  label: string;
  default: boolean;
}

export interface EpisodeSources {
  animeId: string;
  animeTitle: string;
  episode: EpisodeInfo;
  mode: AudioMode;
  variants: SourceVariant[]; // sorted best -> worst
  /** Proxied master playlist — lets the player adapt quality automatically. */
  masterUrl?: string;
  subtitles?: SubtitleTrack[];
  /** Which resolver produced the links. */
  via?: "ani-cli" | "scraper";
}

export interface ProgressEntry {
  animeId: string;
  animeTitle: string;
  episodeNumber: string;
  positionSeconds: number;
  durationSeconds: number;
  updatedAt: number; // epoch ms
  mode: AudioMode;
  /** Episode numbers confirmed watched (>=90% seen). */
  watchedEpisodes?: string[];
  /** Proxied poster URL captured when the entry was saved. */
  poster?: string;
}

export interface FavoriteEntry {
  animeId: string;
  animeTitle: string;
  addedAt: number;
  /** Proxied poster URL captured when the entry was saved. */
  poster?: string;
}
