/**
 * Explicit "download this category for offline" support, driven from the
 * page (not the service worker) so we can report per-file progress.
 *
 * IMPORTANT: this cache name must match IMAGES_CACHE in public/sw.js - the
 * service worker's cache-first handler for /images/** reads from the same
 * cache, so anything downloaded here is immediately served offline by the SW.
 */
export const IMAGES_CACHE_NAME = 'coloriki-v1-images';

function hasCacheApi(): boolean {
  return typeof caches !== 'undefined';
}

/** True if every url is already present in the images cache. */
export async function isFullyCached(urls: string[]): Promise<boolean> {
  if (!hasCacheApi() || urls.length === 0) return urls.length === 0;
  const cache = await caches.open(IMAGES_CACHE_NAME);
  for (const url of urls) {
    if (!(await cache.match(url))) return false;
  }
  return true;
}

/**
 * Fetches every url into the images cache (skipping ones already cached),
 * reporting progress after each file. Returns false if any file failed
 * (e.g. offline) so the caller can leave the download retryable.
 */
export async function downloadUrls(urls: string[], onProgress: (done: number, total: number) => void): Promise<boolean> {
  if (!hasCacheApi()) return false;
  const cache = await caches.open(IMAGES_CACHE_NAME);
  let ok = true;
  let done = 0;
  onProgress(0, urls.length);
  for (const url of urls) {
    try {
      if (!(await cache.match(url))) {
        const res = await fetch(url, { cache: 'no-cache' });
        if (res.ok) {
          await cache.put(url, res);
        } else {
          ok = false;
        }
      }
    } catch {
      ok = false; // offline or network error - leave this file for a retry later
    }
    done++;
    onProgress(done, urls.length);
  }
  return ok;
}
