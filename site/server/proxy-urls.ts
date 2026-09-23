/** Stream and image URL helpers shared by the provider and the proxy. */

/**
 * Wrap an upstream URL with our local HLS proxy. The upstream video CDN
 * (hls.1embed.buzz) 403s without the embed site's Referer, so callers pass
 * it via ?ref= and the proxy propagates it upstream.
 */
export function proxyStreamUrl(rawUrl: string, referer?: string): string {
  const enc = encodeURIComponent(rawUrl);
  return referer ? `/stream/${enc}?ref=${encodeURIComponent(referer)}` : `/stream/${enc}`;
}

/**
 * Wrap an upstream image URL with the local image proxy (/img). Cover hosts
 * send no CORS headers and sometimes check Referer, so the client loads
 * covers through us.
 */
export function proxyImageUrl(rawUrl: string): string {
  return `/img/${encodeURIComponent(rawUrl)}`;
}
