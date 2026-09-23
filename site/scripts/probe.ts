import { resolveStream } from "../server/scraper.js";

const epId = process.argv[2] ?? "21419";
const mode = (process.argv[3] ?? "sub") as "sub" | "dub";

resolveStream(epId, mode)
  .then((r) => {
    console.log("OK variants:", r.variants.map((v) => v.quality).join(","), "| subs:", r.subtitles.length, "| ref:", r.referer);
    console.log("first variant:", r.variants[0]?.url);
    console.log("sub:", r.subtitles[0]?.src);
  })
  .catch((e) => {
    console.error("ERR:", e.message);
    process.exit(1);
  });
