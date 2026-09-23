/**
 * hianime.at provider — mirrors ani-cli v5.1.4's scraping flow (verified live).
 * Chain: search HTML → episode list API → servers API (ZokoAnime embed, base64
 * hash) → embed page `window.__P` blob (base64 XOR "otaku-embed-v1") → master
 * m3u8 (+ subtitle tracks).
 */
import { runtimeConfig } from "./config.js";
import { proxyStreamUrl } from "./proxy-urls.js";
import { proxyImageUrl } from "./proxy-urls.js";
import type {
  AnimeDetails,
  AnimeMeta,
  AnimeSearchResult,
  AudioMode,
  EpisodeInfo,
  HomeItem,
  HomeSection,
  SourceVariant,
  SubtitleTrack,
} from "../shared/types.js";

const BASE = "https://hianime.at";
const UA = runtimeConfig.userAgent;
const XOR_KEY = "otaku-embed-v1";

export class ProviderError extends Error {}

/**
 * Thrown when the provider simply has no stream for the requested audio
 * mode (e.g. no dub yet). Distinct from ProviderError so the API can answer
 * with a clean 404-ish message instead of falling back to ani-cli noise.
 */
export class ProvidersUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvidersUnavailableError";
  }
}

function decodeEntities(s: string): string {
  return s
    .replaceAll("&#039;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

async function fetchText(url: string, referer?: string, timeoutMs = 15_000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Referer: referer ?? `${BASE}/`,
        Accept: "text/html,application/json,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new ProviderError(`upstream ${res.status} ${res.statusText} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** ani-cli id shape: watch/<slug>-<numeric-id>. */
function isAniCliId(id: string): boolean {
  return /^[a-z0-9-]+-[0-9]+$/i.test(id);
}

// ---------------- search ----------------

export async function searchAnime(query: string): Promise<AnimeSearchResult[]> {
  const q = encodeURIComponent(query.trim().replaceAll(/\s+/g, "+"));
  const page = await fetchText(`${BASE}/search?keyword=${q}`);
  if (/just a moment/i.test(page)) throw new ProviderError("Blocked by Cloudflare");
  // top-10 sidebar repeats result markup; cut it off before flattening
  const head = page.split('id="main-sidebar"')[0] ?? page;
  const results: AnimeSearchResult[] = [];
  const re = /<h3 class="film-name">\s*<a href="[^"]*\/([a-z0-9-]+)"\s+title="([^"]+)"/g;
  const blocks = extractGridBlocks(head);
  for (const m of head.matchAll(re)) {
    const card = blocks.find((b) => b.includes(`/${m[1]}`));
    const img = card
      ? /<img[^>]*class="film-poster-img"[^>]*src="([^"]+)"/.exec(card)?.[1] ??
        /<img[^>]*src="([^"]+)"[^>]*class="film-poster-img"/.exec(card)?.[1]
      : undefined;
    results.push({
      id: m[1],
      title: decodeEntities(m[2]),
      ...(img ? { poster: proxyImageUrl(img) } : {}),
    });
  }
  const seen = new Set<string>();
  return results.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

// ---------------- home sections ----------------

/** Common catalog-card markup (poster img + detail block). */
export function parseCatalogCard(block: string): (HomeItem & { raw: string }) | null {
  const raw = /<h3 class="film-name">[\s\S]*?<a href="[^"]*\/([a-z0-9-]+)"[^>]*title="([^"]+)"/.exec(
    block,
  );
  if (!raw) return null;
  const [, id, rawTitle] = raw;
  const img = imgSrc(/<img[^>]*class="film-poster-img"[^>]*>/.exec(block)?.[0] ?? "");
  const sub = /tick-sub"[^>]*>(?:<[^>]*>)*([0-9]+)/.exec(block)?.[1];
  const dub = /tick-dub"[^>]*>(?:<[^>]*>)*([0-9]+)/.exec(block)?.[1];
  const eps = /tick-eps"[^>]*>(?:<[^>]*>)*([0-9]+)/.exec(block)?.[1];
  const fdi = /fdi-item">([^<]+)</.exec(block)?.[1]?.trim();
  const item: HomeItem & { raw: string } = {
    raw: block,
    id,
    title: decodeEntities(rawTitle),
  };
  if (img) item.poster = proxyImageUrl(img);
  if (sub) item.subCount = Number(sub);
  if (dub) item.dubCount = Number(dub);
  if (eps) item.epCount = Number(eps);
  if (fdi && fdi.toUpperCase() !== "NEW") item.type = decodeEntities(fdi);
  return item;
}

function stripRaw<T extends { raw: string }>(item: T | null): Omit<T, "raw"> | null {
  if (!item) return null;
  const { raw: _raw, ...rest } = item;
  return rest;
}

/** Cut trailing sidebar/top-10 blocks that would duplicate main-grid cards. */
function cutAtSectionStart(html: string, anchor: string): string {
  const idx = html.indexOf(anchor);
  return idx > 0 ? html.slice(0, idx) : html;
}

function extractGridBlocks(html: string): string[] {
  // each element spans exactly one card (up to the next card); no inner
  // cutting — parsers take the first match, so trailing content of the last
  // block is harmless
  return html.split('<div class="flw-item').slice(1);
}

/** Pull src= out of an <img …> tag regardless of attribute order. */
function imgSrc(imgTag: string): string | undefined {
  return /src="([^"]+)"/.exec(imgTag)?.[1];
}

function extractTop10(html: string, sectionId: string, title: string): HomeSection {
  const items: HomeItem[] = [];
  const seen = new Set<string>();
  const section = html.split(`id="${sectionId}"`)[1] ?? "";
  for (const m of section.matchAll(
    /<div class="film-number">[\s\S]{0,150}?(<img[^>]*>)[\s\S]{0,400}?<a href="[^"]*\/([a-z0-9-]+)"[^>]*title="([^"]+)"/g,
  )) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    const src = imgSrc(m[1]);
    const item: HomeItem = {
      id: m[2],
      title: decodeEntities(m[3]),
      ...(src ? { poster: proxyImageUrl(src) } : {}),
    };
    const rest = m[0].slice(m[0].indexOf("film-poster-img"));
    const dub = /tick-dub"[^>]*>(?:<[^>]*>)*([0-9]+)/.exec(rest)?.[1];
    if (dub) item.dubCount = Number(dub);
    items.push(item);
  }
  return { id: sectionId.replace(/^top-viewed-/, "top10-"), title, items: items.slice(0, 10) };
}

/**
 * Scrape the provider home page into UI rails. Sections degrade to empty
 * arrays when the provider omits or reshapes them, so a single section change
 * never breaks the whole home screen.
 */
export async function getHomeSections(): Promise<HomeSection[]> {
  const page = await fetchText(`${BASE}/home`);
  if (/just a moment/i.test(page)) throw new ProviderError("Blocked by Cloudflare");

  const trendingItems: HomeItem[] = [];
  const trend = page.split('id="trending-home"')[1] ?? "";
  for (const m of trend.matchAll(
    /<div class="number">[\s\S]{0,200}?data-jname="([^"]+)"[\s\S]{0,300}?<a href="[^"]*\/([a-z0-9-]+)"[\s\S]{0,300}?(<img[^>]*>)/g,
  )) {
    const src = imgSrc(m[3]);
    trendingItems.push({
      id: m[2],
      title: decodeEntities(m[1]),
      ...(src ? { poster: proxyImageUrl(src) } : {}),
    });
  }

  // main grid: everything between "Latest Episode" and the Top 10 block
  const mainGrid = cutAtSectionStart(
    cutAtSectionStart(page, '>Top 10<'),
    '>Top Upcoming<',
  );
  const latestPart = mainGrid.split(">Latest Episode<")[1] ?? "";
  const newPart = latestPart.split(">New On HiAnime<")[1] ?? "";
  const latestItems = extractGridBlocks(newPart.length ? latestPart : mainGrid)
    .map((b) => stripRaw(parseCatalogCard(b)))
    .filter((i): i is HomeItem => i !== null)
    .filter((i) => (i.type ?? "").toUpperCase() !== "MOVIE");
  const newItems = newPart
    ? extractGridBlocks(newPart)
        .map((b) => stripRaw(parseCatalogCard(b)))
        .filter((i): i is HomeItem => i !== null)
    : [];

  const upcomingItems: HomeItem[] = [];
  const up = page.split(">Top Upcoming<")[1] ?? "";
  const upEnd = up.indexOf(">Genres<");
  const upcomingHtml = upEnd > 0 ? up.slice(0, upEnd) : up;
  for (const b of extractGridBlocks(upcomingHtml)) {
    const item = stripRaw(parseCatalogCard(b));
    if (item) upcomingItems.push(item);
  }

  const sections: HomeSection[] = [
    { id: "trending", title: "Trending", items: trendingItems.slice(0, 12) },
    {
      id: "latest-episodes",
      title: "Latest Episodes",
      items: latestItems.slice(0, 12),
    },
    { id: "new-releases", title: "New on AniStream", items: newItems.slice(0, 12) },
    {
      id: "top10-day",
      title: "Top 10 · Today",
      items: extractTop10(page, "top-viewed-day", "Top 10 · Today").items,
    },
    { id: "top10-week", title: "Top 10 · Week", items: extractTop10(page, "top-viewed-week", "Top 10 · Week").items },
    { id: "top10-month", title: "Top 10 · Month", items: extractTop10(page, "top-viewed-month", "Top 10 · Month").items },
    { id: "upcoming", title: "Top Upcoming", items: upcomingItems.slice(0, 12) },
  ];
  return sections.filter((s) => s.items.length > 0);
}

/** Pull the value of a labeled metadata item from the landing-page info block. */
function metaValue(html: string, label: string): string | undefined {
  // value sits in a nested tag: <span class="item-head">X:</span> <span class="name">Y</span>
  const re = new RegExp(
    `item-head">${label}:?</span>\\s*(?:<[^>]+>)*([^<]{1,200}?)(?:<\\/[^>]+>)*\\s*<\\/div>`,
  );
  const v = re.exec(html)?.[1]?.trim();
  return v || undefined;
}

// ---------------- details ----------------

export async function getAnimeDetails(animeId: string): Promise<AnimeDetails> {
  if (!isAniCliId(animeId)) throw new ProviderError("invalid anime id");
  const watch = await fetchText(`${BASE}/${animeId}`);
  const og = /property="og:title" content="([^"]*)"/.exec(watch)?.[1];
  // landing pages: "Watch One Piece | HiAnime"; watch pages: "… Episode 1 | HiAnime"
  const title = og
    ? decodeEntities(og)
        .replace(/\s*\|\s*HiAnime\s*$/i, "")
        .replace(/\s+Episode\s+[^|]*$/i, "")
        .replace(/^Watch\s+/i, "")
        .trim()
    : animeId;
  const malId = /\/mal\/([0-9]+)\//.exec(watch) ? Number(/\/mal\/([0-9]+)\//.exec(watch)![1]) : null;
  const ogImage =
    /property="og:image" content="([^"]+)"/.exec(watch)?.[1] ??
    /name="twitter:image" content="([^"]+)"/.exec(watch)?.[1];

  // metadata + synopsis (best-effort)
  const infoStart = watch.indexOf('class="anisc-info"');
  const infoBlock = infoStart > 0 ? watch.slice(infoStart, infoStart + 40_000) : "";
  const overview =
    /<span class="item-head">Overview:<\/span>\s*<div class="text">([\s\S]{1,4000}?)<\/div>/.exec(
      infoBlock || watch,
    )?.[1] ??
    /film-description[^>]*>\s*<div class="text">([\s\S]{1,4000}?)<\/div>/.exec(watch)?.[1];
  const description = overview
    ? decodeEntities(overview.replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " ")).trim()
    : undefined;
  const meta: AnimeMeta = { genres: [] };
  const jp = metaValue(infoBlock, "Japanese");
  if (jp) meta.japanese = decodeEntities(jp);
  const status = metaValue(infoBlock, "Status");
  if (status) meta.status = decodeEntities(status);
  const aired = metaValue(infoBlock, "Aired");
  if (aired) meta.aired = decodeEntities(aired);
  const duration = metaValue(infoBlock, "Duration");
  if (duration) meta.duration = decodeEntities(duration);
  const score = metaValue(infoBlock, "MAL Score");
  if (score) meta.malScore = decodeEntities(score);
  const studios = metaValue(infoBlock, "Studios");
  if (studios) meta.studios = decodeEntities(studios);
  const producers = metaValue(infoBlock, "Producers");
  if (producers) meta.producers = decodeEntities(producers);
  const genresBlock =
    /item-head">Genres:<\/span>([\s\S]{0,2000}?)<\/div>/.exec(infoBlock)?.[1] ?? "";
  meta.genres = [...genresBlock.matchAll(/title="([^"]+)"/g)].map((g) => decodeEntities(g[1]));

  // Seasons are separate catalog entries on hianime; surface them as related
  // Seasons are separate catalog entries on hianime; surface them as related
  // entries from search (best-effort, same franchise keyword = title prefix).
  let related: AnimeSearchResult[] = [];
  try {
    const all = await searchAnime(title);
    related = all.filter((r) => r.id !== animeId).slice(0, 12);
  } catch {
    /* related is best-effort */
  }
  return {
    id: animeId,
    title,
    malId,
    ...(ogImage ? { poster: proxyImageUrl(ogImage) } : {}),
    ...(description ? { description } : {}),
    ...(meta.genres.length || meta.malScore || meta.status ? { meta } : {}),
    seasons: related,
  };
}

// ---------------- episodes ----------------

export async function getEpisodes(animeId: string): Promise<EpisodeInfo[]> {
  if (!isAniCliId(animeId)) throw new ProviderError("invalid anime id");
  const numericId = animeId.split("-").pop()!;
  const page = await fetchText(`${BASE}/api/theme/episode/list/${numericId}`);
  let html: string;
  try {
    html = (JSON.parse(page) as { html?: string }).html ?? "";
  } catch {
    html = page;
  }
  // ids from other providers share the shape; check the slug in the link too
  const slugPrefix = animeId; // e.g. cowboy-bebop-1281
  const eps: EpisodeInfo[] = [];
  const flat = html.replaceAll("\\", "");
  const re = new RegExp(
    `data-number="([^"]*)"[^>]*data-id="([0-9]+)"[^>]*href="[^"]*/watch/${slugPrefix}\\?ep=`,
    "g",
  );
  for (const m of flat.matchAll(re)) {
    eps.push({ number: m[1], id: m[2] });
  }
  if (eps.length === 0) throw new ProviderError("no episodes found");
  return eps;
}

// ---------------- stream resolution ----------------

function b64Decode(s: string): Buffer {
  return Buffer.from(s, "base64");
}

/** Deobfuscate the embed's config blob: base64 then XOR with "otaku-embed-v1". */
export function deobfuscateBlob(blob: string): unknown {
  const raw = b64Decode(blob);
  const key = Buffer.from(XOR_KEY, "utf8");
  const out = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] ^ key[i % key.length];
  try {
    return JSON.parse(out.toString("utf8"));
  } catch {
    throw new ProviderError("could not decode embed config");
  }
}

/** Find the first m3u8 src anywhere in the decoded config. */
export function findM3u8Src(data: unknown): string | null {
  if (typeof data === "string") return null;
  if (Array.isArray(data)) {
    for (const v of data) {
      const r = findM3u8Src(v);
      if (r) return r;
    }
    return null;
  }
  if (data && typeof data === "object") {
    const src = (data as { src?: unknown }).src;
    if (typeof src === "string" && src.includes(".m3u8")) return src;
    for (const v of Object.values(data)) {
      const r = findM3u8Src(v);
      if (r) return r;
    }
  }
  return null;
}

export function findSubtitles(data: unknown, referer?: string): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = [];
  const subs = (data as { subtitles?: unknown })?.subtitles;
  if (Array.isArray(subs)) {
    for (const s of subs) {
      if (s && typeof s === "object") {
        const src = (s as { src?: unknown }).src;
        const lang = (s as { lang?: unknown }).lang ?? (s as { label?: unknown }).label;
        if (typeof src === "string") {
          tracks.push({
            src: proxyStreamUrl(src, referer),
            lang: typeof lang === "string" ? lang : "en",
            label: typeof lang === "string" ? lang.toUpperCase() : "EN",
            default: tracks.length === 0,
          });
        }
      }
    }
  }
  return tracks;
}

interface ServerEntry {
  type: string; // sub | dub
  name: string;
  hash: string; // base64 of embed url
}

function parseServers(html: string): ServerEntry[] {
  const entries: ServerEntry[] = [];
  const flat = html.replaceAll('\\"', '"');
  const re = /data-type="([^"]*)"\s+data-server-name="([^"]*)"\s+data-hash="([^"]*)"/g;
  for (const m of flat.matchAll(re)) {
    entries.push({ type: m[1], name: m[2], hash: m[3] });
  }
  return entries;
}

export function parseMasterPlaylist(
  body: string,
  masterUrl: string,
  referer: string,
): SourceVariant[] {
  const variants: SourceVariant[] = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const height = /RESOLUTION=\d+x(\d+)/.exec(line)?.[1];
    let url = lines[i + 1]?.trim();
    if (!url || url.startsWith("#")) continue;
    if (!/^https?:\/\//i.test(url)) {
      url = new URL(url, masterUrl).toString();
    }
    variants.push({
      quality: height ? `${height}p` : "unknown",
      url: proxyStreamUrl(url, referer),
      rawUrl: url,
    });
  }
  variants.sort((a, b) => parseInt(b.quality) - parseInt(a.quality));
  return variants;
}

export interface ResolvedStream {
  variants: SourceVariant[];
  subtitles: SubtitleTrack[];
  referer: string;
  /** Proxied master playlist for adaptive-bitrate playback. */
  masterUrl: string;
}

/** Resolve stream links for an episode (hianime episode id, e.g. 21418). */
export async function resolveStream(
  episodeId: string,
  mode: AudioMode,
): Promise<ResolvedStream> {
  const serversPage = await fetchText(`${BASE}/api/theme/episode/servers?episodeId=${episodeId}`);
  let servers: ServerEntry[];
  try {
    servers = parseServers((JSON.parse(serversPage) as { html?: string }).html ?? "");
  } catch {
    servers = parseServers(serversPage);
  }

  const wanted = mode === "dub" ? "dub" : "sub";
  const preferred =
    servers.find((s) => s.type === wanted && s.name === "ZokoAnime") ??
    servers.find((s) => s.type === wanted);
  if (!preferred) {
    const hasOther = servers.some((s) => s.type !== "" && s.type !== wanted);
    throw new ProvidersUnavailableError(
      hasOther
        ? mode === "dub"
          ? "No dub available for this episode yet — try switching to SUB."
          : "No sub available for this episode — try switching to DUB."
        : `This episode has no ${wanted} version available.`,
    );
  }

  const embed = b64Decode(preferred.hash).toString("utf8");
  if (!/^https?:\/\//i.test(embed)) throw new ProviderError("bad embed hash");
  const origin = new URL(embed).origin + "/";

  const embedPage = await fetchText(embed, origin);
  const blobMatch = /window\.__P="([^"]*)"/.exec(embedPage);
  if (!blobMatch) throw new ProviderError("embed config blob not found");
  const data = deobfuscateBlob(blobMatch[1]);

  const m3u8 = findM3u8Src(data);
  if (!m3u8) throw new ProviderError("no m3u8 in embed config");
  const subtitles = findSubtitles(data, origin);

  // fetch master playlist to enumerate qualities (needs embed referer)
  const masterBody = await fetchText(m3u8, origin);
  const variants = parseMasterPlaylist(masterBody, m3u8, origin);
  if (variants.length === 0) {
    // single-variant master: treat the master itself as the only variant
    variants.push({ quality: "auto", url: proxyStreamUrl(m3u8, origin), rawUrl: m3u8 });
  }

  return { variants, subtitles, referer: origin, masterUrl: proxyStreamUrl(m3u8, origin) };
}
