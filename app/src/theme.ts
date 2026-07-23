/**
 * In-app light/dark theme toggle for the UI chrome (gallery/editor
 * backgrounds, buttons, cards) - NEVER the coloring canvas paper, which
 * stays white in every theme (see style.css's `color-scheme: only light`
 * comment for why).
 *
 * Two-state toggle (light/dark), not three-state (light/dark/system): the
 * user's explicit choice is persisted in localStorage and always wins over
 * the OS `prefers-color-scheme`, applied via a `data-theme` attribute on
 * `<html>` that CSS selectors in style.css override the `@media` block with.
 * Before any choice is ever made, no `data-theme` attribute is set at all,
 * so the app falls back to the existing OS-driven `@media` behavior - that's
 * the implicit third "use system" state, undone the instant the user taps
 * the toggle for the first time (which flips away from whatever the OS was
 * resolving to at that moment).
 */

const STORAGE_KEY = 'coloriki.theme';

export type Theme = 'light' | 'dark';

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStored(): Theme | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    return null;
  }
}

/** The theme currently in effect: the user's explicit choice, or the OS setting if none was ever made. */
export function getTheme(): Theme {
  return readStored() ?? systemTheme();
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * Applies the user's persisted theme choice, if any. Call this as early as
 * possible - before the gallery/editor render - to avoid a flash of the
 * wrong theme. (index.html also has an inline script doing the same thing
 * synchronously before any CSS/JS loads, to avoid a flash even earlier;
 * this covers dev-mode timing and keeps a single source of truth for the
 * reading logic.)
 *
 * Deliberately a no-op when nothing is stored: leaving the `data-theme`
 * attribute unset is what lets the `@media (prefers-color-scheme)` block in
 * style.css keep driving the theme live off the OS setting (the "system"
 * state) until the user ever taps the toggle. Setting the attribute here
 * unconditionally (e.g. to `getTheme()`'s resolved value) would freeze the
 * theme at whatever the OS happened to be on first load, and it would then
 * stop following OS changes - not what "no explicit choice yet" should mean.
 */
export function initTheme(): void {
  const stored = readStored();
  if (stored) applyTheme(stored);
}

/** Flips the persisted theme choice and applies it. Returns the new theme. */
export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage full/unavailable (e.g. private mode) - theme still applies for
    // this session, it just won't persist across reloads.
  }
  applyTheme(next);
  return next;
}
