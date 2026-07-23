import { defineConfig } from 'vitest/config';

/**
 * Deliberately separate from vite.config.ts (which drives the actual app
 * build/dev-server and is out of scope for this change) - this only needs to
 * run plain TS unit tests, no DOM/browser layer (jsdom, Playwright, etc.).
 * The matching logic under test (engine/floodfill.ts's matchFrameRegions) is
 * pure data-in/data-out and only needs `document.createElement('canvas')`
 * for the maskCanvas field, which tests never touch.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
