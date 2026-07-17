import './style.css';
import { mountGallery } from './gallery';
import { mountEditor } from './editor';

const app = document.getElementById('app') as HTMLElement;
let disposeCurrent: (() => void) | null = null;
let routeToken = 0;

async function route() {
  const myToken = ++routeToken;
  const hash = location.hash || '#/';
  const paintMatch = hash.match(/^#\/paint\/(.+)$/);

  let dispose: () => void;
  if (paintMatch) {
    const imageId = decodeURIComponent(paintMatch[1]);
    dispose = await mountEditor(app, imageId, () => {
      location.hash = '#/';
    });
  } else {
    dispose = await mountGallery(app, (imageId) => {
      location.hash = `#/paint/${encodeURIComponent(imageId)}`;
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
