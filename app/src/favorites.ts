/**
 * Favorites ("hearts"): a tiny, independent concept from painted works
 * (see store.ts). Just a set of catalog image ids, persisted in
 * localStorage. Synchronous, unlike the IndexedDB-backed store.ts API.
 */

const STORAGE_KEY = 'coloriki.favorites';

function readIds(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v) => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

function writeIds(ids: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage full/unavailable (e.g. private mode) - silently ignore, favorites
    // just won't persist this session.
  }
}

/** Whether `imageId` is currently favorited. */
export function isFavorite(imageId: string): boolean {
  return readIds().has(imageId);
}

/** Flips the favorite state of `imageId`. Returns the new state. */
export function toggleFavorite(imageId: string): boolean {
  const ids = readIds();
  let nowFavorite: boolean;
  if (ids.has(imageId)) {
    ids.delete(imageId);
    nowFavorite = false;
  } else {
    ids.add(imageId);
    nowFavorite = true;
  }
  writeIds(ids);
  return nowFavorite;
}

/** All currently favorited image ids. */
export function getFavoriteIds(): Set<string> {
  return readIds();
}
