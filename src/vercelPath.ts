/**
 * Recovers the original request path behind a Vercel catch-all rewrite.
 *
 * Every path has to reach one function, and the shape of `req.url` that a
 * function sees after a rewrite is not something to guess at -- getting it
 * wrong means every short code resolves to the same route and the whole
 * service 404s. So the path is passed explicitly:
 *
 *     "source": "/(.*)"  ->  "destination": "/api?__path=$1"
 *
 * Vercel preserves the caller's own query parameters alongside it, so this
 * pulls `__path` back out, drops it, and reassembles the URL Express expects.
 *
 * When `__path` is absent -- running the module directly, or locally under
 * `node` -- the URL is already correct and is returned untouched.
 */
export function normalizeRequestUrl(rawUrl: string): string {
  // The base is a throwaway: only the path and query are used.
  const url = new URL(rawUrl, "http://placeholder.invalid");
  const original = url.searchParams.get("__path");

  if (original === null) {
    return rawUrl;
  }

  url.searchParams.delete("__path");

  const path = original.startsWith("/") ? original : `/${original}`;
  const query = url.searchParams.toString();

  return query ? `${path}?${query}` : path;
}
