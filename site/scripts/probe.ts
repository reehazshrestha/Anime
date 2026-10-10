const epId = process.argv[2] ?? "481";
const animeId = process.argv[3] ?? "frieren-beyond-journeys-end-481";
const mode = (process.argv[4] ?? "sub") as "sub" | "dub";

async function main() {
  const res = await fetch(
    `http://localhost:8787/api/sources?animeId=${encodeURIComponent(animeId)}&ep=${encodeURIComponent(epId)}&mode=${mode}`,
  );
  if (!res.ok) {
    console.error("ERR:", res.status, await res.text());
    process.exit(1);
  }
  const r = (await res.json()) as {
    variants: { quality: string; url: string }[];
    subtitles: { src: string; lang: string }[];
    masterUrl?: string;
  };
  console.log("OK variants:", r.variants.map((v) => v.quality).join(","), "| subs:", r.subtitles.length);
  console.log("first variant:", r.variants[0]?.url);
  if (r.subtitles[0]) console.log("sub:", r.subtitles[0].src, "lang:", r.subtitles[0].lang);
  if (r.masterUrl) console.log("master:", r.masterUrl);
}

main().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});

