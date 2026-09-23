import { spawn } from "node:child_process";
import { runtimeConfig, findExecutable } from "./config.js";
import { proxyStreamUrl } from "./proxy-urls.js";
import type { AudioMode, SourceVariant } from "../shared/types.js";

export { proxyStreamUrl };

export interface ResolvedSources {
  variants: SourceVariant[]; // best -> worst
  via: "ani-cli" | "scraper";
}

export class SourcesError extends Error {}

function findAniCli(): string | null {
  const configured = runtimeConfig.aniCliBin;
  if (configured.includes("/")) return configured;
  return findExecutable(configured);
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run ani-cli in debug-player mode: it resolves the episode (search, quality
 * selection) and prints all candidate links instead of launching a player.
 * This reuses ani-cli's own scraping logic so provider fixes upstream
 * automatically benefit the site.
 */
function runAniCli(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const bin = findAniCli();
    if (!bin) {
      reject(new SourcesError("ani-cli binary not found in PATH"));
      return;
    }
    const child = spawn(bin, args, {
      env: {
        ...process.env,
        PATH: runtimeConfig.pathEnv,
        ANI_CLI_PLAYER: "debug",
        ANI_CLI_QUALITY: "best",
        TERM: process.env.TERM ?? "xterm",
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new SourcesError(`ani-cli timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      }
    });
  });
}

/** Parse the "All links:" block that debug mode prints. */
export function parseDebugLinks(output: string): SourceVariant[] {
  const allSection = output.split("All links:")[1]?.split("Selected link:")[0] ?? "";
  const variants: SourceVariant[] = [];
  for (const rawLine of allSection.split(/\r?\n/)) {
    const line = rawLine.trim();
    // ani-cli quality format: "<quality> > <url>"
    const m = /^(\S+)\s*>\s*(\S+)$/.exec(line);
    if (!m) continue;
    const quality = m[1].endsWith("p") ? m[1] : `${m[1]}p`;
    variants.push({ quality, url: proxyStreamUrl(m[2], refererFor(m[2])), rawUrl: m[2] });
  }
  return variants;
}

/** The video CDN requires the embed site as Referer; use known embed origins. */
function refererFor(rawUrl: string): string {
  const host = new URL(rawUrl).hostname;
  if (host.includes("zoko")) return "https://zokoanime.video/";
  if (host.includes("megaplay")) return "https://megaplay.buzz/";
  return new URL(rawUrl).origin + "/";
}

export interface ResolveOptions {
  query: string; // search terms for ani-cli
  searchIndex: number; // which search result to pick (1-based)
  episode: string; // episode number as listed by anidb
  mode: AudioMode;
}

export async function resolveSources(opts: ResolveOptions): Promise<ResolvedSources> {
  const args = [
    "-S",
    String(opts.searchIndex),
    "-e",
    String(opts.episode),
    "-q",
    "best",
  ];
  if (opts.mode === "dub") args.push("--dub");
  args.push(opts.query);

  const res = await runAniCli(args, 90_000);
  if (res.code !== 0) {
    const reason = (res.stderr || res.stdout || "unknown error").trim();
    throw new SourcesError(reason.split("\n").slice(-3).join("\n"));
  }
  const variants = parseDebugLinks(res.stdout);
  if (variants.length === 0) {
    throw new SourcesError("ani-cli returned no links");
  }
  return { variants, via: "ani-cli" };
}
