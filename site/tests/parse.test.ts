import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDebugLinks } from "../server/anicli.js";
import { proxyStreamUrl } from "../server/proxy-urls.js";
import {
  deobfuscateBlob,
  findM3u8Src,
  findSubtitles,
  parseCatalogCard,
  parseMasterPlaylist,
} from "../server/scraper.js";
import { rewriteM3u8 } from "../server/proxy.js";
import { TtlCache } from "../server/cache.js";

test("parseDebugLinks parses ani-cli debug output", () => {
  const output = [
    "\x1b[2K\rChecking dependencies...",
    "All links:",
    "1080p > https://cdn.example.com/master.m3u8",
    "720p > https://cdn.example.com/720.m3u8",
    "360p > https://cdn.example.com/360.m3u8",
    "Selected link:",
    "https://cdn.example.com/master.m3u8",
  ].join("\n");
  const variants = parseDebugLinks(output);
  assert.equal(variants.length, 3);
  assert.equal(variants[0].quality, "1080p");
  assert.equal(variants[0].rawUrl, "https://cdn.example.com/master.m3u8");
  assert.ok(variants[0].url.startsWith("/stream/"));
});

test("parseDebugLinks tolerates ANSI noise and blank lines", () => {
  const output =
    "All links:\n\x1b[1;34m[info]\x1b[0m\n\n720p > https://x/y.m3u8\n\nSelected link:\nhttps://x/y.m3u8";
  const variants = parseDebugLinks(output);
  assert.equal(variants.length, 1);
  assert.equal(variants[0].quality, "720p");
});

test("parseDebugLinks returns empty for garbage", () => {
  assert.deepEqual(parseDebugLinks("no links here"), []);
});

test("proxyStreamUrl encodes target and appends referer", () => {
  const url = proxyStreamUrl("https://a.b/c.m3u8?x=1&y=2");
  assert.ok(url.startsWith("/stream/https%3A%2F%2Fa.b%2Fc.m3u8"));
  assert.ok(url.endsWith("x%3D1%26y%3D2"));

  const withRef = proxyStreamUrl("https://a.b/c.m3u8", "https://zokoanime.video/");
  assert.ok(withRef.includes("/stream/"));
  assert.ok(withRef.includes("ref=" + encodeURIComponent("https://zokoanime.video/")));
});

test("deobfuscateBlob decodes base64+XOR otaku-embed-v1", () => {
  // build a fixture: JSON XOR key, base64'd
  const payload = JSON.stringify({ source: "x" });
  const key = Buffer.from("otaku-embed-v1", "utf8");
  const raw = Buffer.from(payload, "utf8");
  const enc = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i++) enc[i] = raw[i] ^ key[i % key.length];
  const blob = enc.toString("base64");

  const decoded = deobfuscateBlob(blob) as { source: string };
  assert.equal(decoded.source, "x");
});

test("deobfuscateBlob throws on garbage", () => {
  assert.throws(() => deobfuscateBlob(Buffer.from("not json").toString("base64")));
});

test("findM3u8Src locates nested src", () => {
  const data = {
    sources: [{ file: "nope" }],
    stream: { src: "https://cdn.example.com/master.m3u8" },
  };
  assert.equal(findM3u8Src(data), "https://cdn.example.com/master.m3u8");
  assert.equal(findM3u8Src({ a: 1 }), null);
});

test("findSubtitles maps subtitle tracks", () => {
  const tracks = findSubtitles({
    subtitles: [{ src: "https://x/e.vtt", lang: "en" }],
  });
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].lang, "en");
  assert.equal(tracks[0].label, "EN");
  assert.ok(tracks[0].src.startsWith("/stream/"));
});

test("parseMasterPlaylist builds variants best->worst", () => {
  const body = [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360",
    "360/index.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=5000,RESOLUTION=1920x1080",
    "1080/index.m3u8",
    "#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI=\"iframe.m3u8\"",
  ].join("\n");
  const variants = parseMasterPlaylist(
    body,
    "https://hls.example.com/v/abc/master.m3u8",
    "https://zokoanime.video/",
  );
  assert.equal(variants.length, 2);
  assert.equal(variants[0].quality, "1080p");
  assert.equal(
    variants[0].rawUrl,
    "https://hls.example.com/v/abc/1080/index.m3u8",
  );
  assert.ok(variants[0].url.startsWith("/stream/"));
});

test("rewriteM3u8 rewrites nested playlist URLs through /stream/ with referer", () => {
  const body = [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080",
    "1080/index.m3u8",
    "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"",
    "seg-0.ts",
  ].join("\n");
  const ref = "https://zokoanime.video/";
  const out = rewriteM3u8(body, "https://cdn.example.com/master.m3u8", ref);
  const lines = out.split("\n");
  assert.equal(lines[0], "#EXTM3U");
  assert.ok(lines[2].startsWith("/stream/https%3A%2F%2Fcdn.example.com%2F1080%2Findex.m3u8"));
  assert.ok(lines[2].includes("ref=" + encodeURIComponent(ref)));
  assert.ok(lines[3].includes('URI="/stream/https%3A%2F%2Fcdn.example.com%2Fkey.bin'));
  assert.ok(lines[4].startsWith("/stream/https%3A"));
});

test("parseCatalogCard extracts id, title, poster and counts", () => {
  const block = [
    '<div class="film-poster">',
    '<div class="tick ltr">',
    '<div class="tick-item tick-sub"><i class="fas fa-closed-captioning mr-1"></i>12</div>',
    '<div class="tick-item tick-dub"><i class="fas fa-microphone mr-1"></i>8</div>',
    '<div class="tick-item tick-eps">12</div>',
    '</div>',
    '<img src="https://hianime.at/storage/a.webp" class="film-poster-img" alt="X">',
    '</div>',
    '<div class="film-detail">',
    '<h3 class="film-name"> <a href="https://hianime.at/some-anime-99" title="Some &amp; Anime">Some &amp; Anime</a> </h3>',
    '<div class="fd-infor"> <span class="fdi-item">TV</span>',
  ].join("\n");
  const card = parseCatalogCard(block);
  assert.ok(card);
  const { raw: _raw, ...rest } = card;
  assert.equal(rest.id, "some-anime-99");
  assert.equal(rest.title, "Some & Anime");
  assert.equal(rest.subCount, 12);
  assert.equal(rest.dubCount, 8);
  assert.equal(rest.epCount, 12);
  assert.equal(rest.type, "TV");
  assert.ok(rest.poster?.startsWith("/img/"));
});

test("TtlCache expires and evicts", async () => {
  const cache = new TtlCache<number>(10);
  cache.set("a", 1);
  assert.equal(cache.get("a"), 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cache.get("a"), undefined);

  const small = new TtlCache<number>(10_000, 2);
  small.set("1", 1);
  small.set("2", 2);
  small.set("3", 3); // evicts "1"
  assert.equal(small.get("1"), undefined);
  assert.equal(small.get("3"), 3);
});
