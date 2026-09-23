/**
 * Cover-image proxy: anime poster hosts send no CORS headers (and sometimes
 * check Referer), so the client loads every cover through us. Only an
 * allowlist of provider image hosts is fetched — everything else 403s.
 */
import type { Request, Response } from "express";
import { runtimeConfig } from "./config.js";

const UA = runtimeConfig.userAgent;

const ALLOWED_HOSTS = new Set([
  "hianime.at",
  "cdn.anipixcdn.co",
  "cdn.noip.ca",
  "img.zokuweb.xyz",
]);

function upstreamImageUrl(req: Request): string | null {
  const raw = req.path.replace(/^\/+/, "");
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!/^https?:\/\//i.test(decoded)) return null;
  let host: string;
  try {
    host = new URL(decoded).hostname;
  } catch {
    return null;
  }
  if (!ALLOWED_HOSTS.has(host)) return null;
  return decoded;
}

export async function imageHandler(req: Request, res: Response): Promise<void> {
  const target = upstreamImageUrl(req);
  if (!target) {
    res.status(403).json({ error: "image host not allowed" });
    return;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const upstream = await fetch(target, {
      headers: { "User-Agent": UA, Referer: `${new URL(target).origin}/` },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!upstream.ok || upstream.body === null) {
      res.status(404).json({ error: `image upstream ${upstream.status}` });
      return;
    }
    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      res.status(404).json({ error: "not an image" });
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: `image proxy failure: ${(err as Error).message}` });
    } else {
      res.end();
    }
  } finally {
    clearTimeout(timer);
  }
}
