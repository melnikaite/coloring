import './style.css';
import { mountGallery } from './gallery';
import { mountEditor } from './editor';
import { initTheme } from './theme';

// Also applied synchronously by an inline script in index.html (before this
// module even loads) to avoid a flash of the wrong theme; this call covers
// dev-mode timing and keeps a single source of truth for the read logic.
initTheme();

const app = document.getElementById('app') as HTMLElement;
let disposeCurrent: (() => void) | null = null;
let routeToken = 0;

async function route() {
  const myToken = ++routeToken;
  const hash = location.hash || '#/';
  // #/paint/<imageId>            -> start a NEW work
  // #/paint/<imageId>?w=<workId> -> resume that specific work
  const paintMatch = hash.match(/^#\/paint\/([^?]+)(?:\?w=([^&]+))?$/);

  let dispose: () => void;
  if (paintMatch) {
    const imageId = decodeURIComponent(paintMatch[1]);
    const workId = paintMatch[2] ? decodeURIComponent(paintMatch[2]) : null;
    dispose = await mountEditor(app, imageId, workId, () => {
      location.hash = '#/';
    });
  } else {
    dispose = await mountGallery(app, (imageId, workId) => {
      const suffix = workId ? `?w=${encodeURIComponent(workId)}` : '';
      location.hash = `#/paint/${encodeURIComponent(imageId)}${suffix}`;
    });
  }

  if (myToken !== routeToken) {
    // A newer navigation started while this one was loading - discard our result.
    dispose();
    return;
  }
  disposeCurrent?.();
  disposeCurrent = dispose;
}

window.addEventListener('hashchange', () => {
  void route();
});
void route();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // offline-first app still works without a SW registered (e.g. first-ever load failure)
    });
  });
}

// Ask the browser not to evict saved artworks under storage pressure. Best
// effort only - not supported everywhere, and the browser may still refuse.
if (navigator.storage?.persist) {
  void navigator.storage.persist().catch(() => {});
}
