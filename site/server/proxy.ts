/**
 * HLS proxy: streams upstream m3u8 playlists and segments through the server,
 * rewriting nested URLs so they keep flowing through the proxy. The upstream
 * video CDN 403s without the embed site's Referer, so callers pass it as
 * ?ref= and we propagate it upstream (falling back to the target origin and
 * then to known embed origins on 403).
 */
import type { Request, Response } from "express";
import { runtimeConfig } from "./config.js";

const UA = runtimeConfig.userAgent;

function upstreamUrl(req: Request): string | null {
  const raw = req.path.replace(/^\/+/, "");
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!/^https?:\/\//i.test(decoded)) return null;
  return decoded;
}

function refererFor(target: string, req: Request): string {
  const ref = req.query.ref;
  if (typeof ref === "string" && /^https?:\/\//i.test(ref)) return ref;
  return new URL(target).origin + "/";
}

/** Rewrite URLs inside an m3u8 so nested requests also go through /stream/. */
export function rewriteM3u8(body: string, baseUrl: string, referer: string): string {
  const refQs = `?ref=${encodeURIComponent(referer)}`;
  return body
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        // rewrite URI="..." attributes inside tags (e.g. EXT-X-KEY, EXT-X-MAP)
        return line.replace(/URI="([^"]+)"/g, (_full, uri: string) => {
          const abs = new URL(uri, baseUrl).toString();
          return `URI="/stream/${encodeURIComponent(abs)}${refQs}"`;
        });
      }
      const abs = new URL(trimmed, baseUrl).toString();
      return `/stream/${encodeURIComponent(abs)}${refQs}`;
    })
    .join("\n");
}

async function pumpUpstream(
  res: Response,
  target: string,
  referer: string,
  range: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  const upstream = await fetch(target, {
    headers: {
      "User-Agent": UA,
      Referer: referer,
      Origin: new URL(referer).origin,
      ...(range ? { Range: range } : {}),
    },
    signal,
    redirect: "follow",
  });
  if (!upstream.ok || upstream.body === null) {
    throw new Error(`upstream ${upstream.status}`);
  }
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType) res.setHeader("Content-Type", contentType);
  const contentLength = upstream.headers.get("content-length");
  const contentRange = upstream.headers.get("content-range");
  if (contentLength) res.setHeader("Content-Length", contentLength);
  if (contentRange) res.setHeader("Content-Range", contentRange);
  res.status(upstream.status === 206 ? 206 : 200);

  // Respect TCP backpressure so fast upstreams don't build a giant queue,
  // and stop pulling bytes as soon as the client disconnects (seek/close)
  // so the freed bandwidth goes to the segments actually being watched.
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || res.closed || res.destroyed) break;
      if (res.write(Buffer.from(value))) continue;
      await new Promise<void>((resolve) => {
        res.once("drain", resolve);
        res.once("close", resolve);
      });
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  if (!res.closed && !res.destroyed) res.end();
}

export async function streamHandler(req: Request, res: Response): Promise<void> {
  const target = upstreamUrl(req);
  if (!target) {
    res.status(400).json({ error: "invalid stream path" });
    return;
  }

  const targetPath = new URL(target).pathname;
  const isM3u8 = targetPath.endsWith(".m3u8");
  const isVtt = targetPath.endsWith(".vtt");
  const referer = refererFor(target, req);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), isM3u8 || isVtt ? 15_000 : 60_000);

  try {
    if (isM3u8) {
      const upstream = await fetch(target, {
        headers: { "User-Agent": UA, Referer: referer },
        signal: ctrl.signal,
        redirect: "follow",
      });
      if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
      const text = await upstream.text();
      res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-store");
      res.send(rewriteM3u8(text, target, referer));
      return;
    }

    // segments + subtitle files: passthrough (vtt needs no URL rewriting)
    const referers = [referer];
    const targetOrigin = new URL(target).origin + "/";
    if (!referers.includes(targetOrigin)) referers.push(targetOrigin);
    // known embed origins the CDN may require
    for (const extra of ["https://zokoanime.video/", "https://megaplay.buzz/"]) {
      if (!referers.includes(extra)) referers.push(extra);
    }

    let lastErr: Error | null = null;
    for (const ref of referers) {
      try {
        await pumpUpstream(res, target, ref, req.headers.range, ctrl.signal);
        return;
      } catch (err) {
        lastErr = err as Error;
        if (res.headersSent) break; // too late to retry
      }
    }
    throw lastErr ?? new Error("upstream failed");
  } catch (err) {
    if (!res.headersSent) {
      const status = /upstream 403/.test((err as Error).message) ? 403 : 502;
      res.status(status).json({ error: `proxy failure: ${(err as Error).message}` });
    } else {
      res.end();
    }
  } finally {
    clearTimeout(timer);
  }
}
