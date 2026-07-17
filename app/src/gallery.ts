import { loadCatalog, imageUrl, imageFiles, allTags, CatalogImage } from './catalog';
import { getAllWorks, deleteWork, Work } from './store';
import { isFullyCached, downloadUrls } from './offlineCache';
import { t } from './i18n';

type Filter = 'all' | 'mine' | string;

/** Navigate to the editor: with a workId to resume that work, without to start a new one. */
export type NavigateFn = (imageId: string, workId?: string) => void;

function matchesQuery(img: CatalogImage, query: string): boolean {
  // Tags from ALL languages are searched, so a Russian parent typing "кот"
  // matches even if the UI locale (or the entry's title) is English.
  const haystack = [img.title, img.id, img.category, ...allTags(img)].join(' ').toLowerCase();
  return haystack.includes(query.toLowerCase());
}

/** Mounts the gallery (home) screen. Returns a dispose function. */
export async function mountGallery(root: HTMLElement, navigate: NavigateFn): Promise<() => void> {
  root.innerHTML = `
    <div class="gallery">
      <div class="gallery-topbar">
        <div class="gallery-chips" data-role="chips"></div>
        <div class="gallery-search-row" data-role="searchRow" hidden>
          <input class="search-input" type="search" data-role="searchInput" />
          <button class="btn round" data-role="searchClose">✖</button>
        </div>
        <button class="btn round" data-role="searchToggle">🔍</button>
      </div>
      <div class="gallery-grid" data-role="grid"></div>
    </div>
  `;
  const el = root.querySelector('.gallery') as HTMLElement;
  const chipsRow = el.querySelector('[data-role="chips"]') as HTMLElement;
  const searchRow = el.querySelector('[data-role="searchRow"]') as HTMLElement;
  const searchInput = el.querySelector('[data-role="searchInput"]') as HTMLInputElement;
  const searchToggle = el.querySelector('[data-role="searchToggle"]') as HTMLButtonElement;
  const searchClose = el.querySelector('[data-role="searchClose"]') as HTMLButtonElement;
  const grid = el.querySelector('[data-role="grid"]') as HTMLElement;

  searchInput.placeholder = t('searchPlaceholder');
  searchClose.title = t('closeSearch');
  searchToggle.title = t('search');

  const catalog = await loadCatalog();
  let activeFilter: Filter = 'all';
  let searchOpen = false;
  let searchQuery = '';
  let objectUrls: string[] = [];

  function revokeObjectUrls() {
    objectUrls.forEach((u) => URL.revokeObjectURL(u));
    objectUrls = [];
  }

  function openSearch() {
    searchOpen = true;
    chipsRow.hidden = true;
    searchRow.hidden = false;
    searchInput.focus();
  }
  function closeSearch() {
    searchOpen = false;
    searchQuery = '';
    searchInput.value = '';
    searchRow.hidden = true;
    chipsRow.hidden = false;
    void renderGrid();
  }
  searchToggle.addEventListener('click', () => {
    if (searchOpen) closeSearch();
    else openSearch();
  });
  searchClose.addEventListener('click', closeSearch);
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    void renderGrid();
  });

  function addChip(id: Filter, icon: string, urls: string[] | null) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (activeFilter === id ? ' active' : '');

    const iconSpan = document.createElement('span');
    iconSpan.className = 'chip-icon';
    iconSpan.textContent = icon;
    chip.appendChild(iconSpan);

    chip.addEventListener('click', () => {
      activeFilter = id;
      renderChips();
      void renderGrid();
    });
    chipsRow.appendChild(chip);

    if (urls && urls.length > 0) {
      const progress = document.createElement('span');
      progress.className = 'chip-progress';
      chip.appendChild(progress);

      const badge = document.createElement('span');
      badge.className = 'chip-dl';
      badge.textContent = '⬇️';
      badge.title = t('downloadCategory');
      chip.appendChild(badge);

      let busy = false;
      badge.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (busy) return;
        busy = true;
        badge.textContent = '⏳';
        void downloadUrls(urls, (done, total) => {
          progress.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : '0%';
        }).then((ok) => {
          busy = false;
          progress.style.width = '0%';
          badge.textContent = ok ? '✅' : '⬇️';
        });
      });

      void isFullyCached(urls).then((cached) => {
        if (cached) badge.textContent = '✅';
      });
    }
  }

  function downloadUrlsFor(images: CatalogImage[]): string[] {
    // Includes extra animation frames so multi-frame drawings work fully offline.
    return images.flatMap((i) => imageFiles(i).map(imageUrl));
  }

  function renderChips() {
    chipsRow.innerHTML = '';
    addChip('all', '🌈', downloadUrlsFor(catalog.images));
    catalog.categories.forEach((c) =>
      addChip(
        c.id,
        c.icon,
        downloadUrlsFor(catalog.images.filter((i) => i.category === c.id))
      )
    );
    addChip('mine', '🎨', null);
  }

  function trackObjectUrl(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    return url;
  }

  /**
   * A catalog card. When the image already has saved works, it shows the
   * latest work's colored thumbnail plus a 🖌️ badge, and tapping asks
   * whether to continue that work or start a fresh one.
   */
  function renderCatalogCard(imgMeta: CatalogImage, latestWork: Work | undefined) {
    const card = document.createElement('div');
    card.className = 'card';
    const img = document.createElement('img');
    if (latestWork) {
      img.src = trackObjectUrl(latestWork.thumbBlob);
      const badge = document.createElement('span');
      badge.className = 'card-colored-badge';
      badge.textContent = '🖌️';
      card.appendChild(badge);
    } else {
      img.src = imageUrl(imgMeta.file);
      img.loading = 'lazy';
    }
    img.alt = imgMeta.title;
    card.prepend(img);
    card.addEventListener('click', () => {
      if (latestWork) chooseContinueOrNew(imgMeta.id, latestWork);
      else navigate(imgMeta.id);
    });
    grid.appendChild(card);
  }

  /** ▶️ continue the latest work (thumbnail shown inside the button) or ✨ start fresh. */
  function chooseContinueOrNew(imageId: string, latestWork: Work) {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="dialog">
        <div class="dialog-actions">
          <button class="btn choice" data-a="continue" title="${t('continueWork')}">
            <img class="dialog-thumb" alt="" /><span class="choice-emoji">▶️</span>
          </button>
          <button class="btn choice" data-a="new" title="${t('newWork')}"><span class="choice-emoji">✨</span></button>
        </div>
      </div>
    `;
    const thumbUrl = URL.createObjectURL(latestWork.thumbBlob);
    (overlay.querySelector('.dialog-thumb') as HTMLImageElement).src = thumbUrl;
    const close = () => {
      URL.revokeObjectURL(thumbUrl);
      overlay.remove();
    };
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) close(); // tap outside = cancel
    });
    (overlay.querySelector('[data-a="continue"]') as HTMLButtonElement).addEventListener('click', () => {
      close();
      navigate(imageId, latestWork.workId);
    });
    (overlay.querySelector('[data-a="new"]') as HTMLButtonElement).addEventListener('click', () => {
      close();
      navigate(imageId);
    });
    el.appendChild(overlay);
  }

  function confirmDelete(workId: string) {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="dialog">
        <div class="dialog-emoji">🗑️❓</div>
        <div class="dialog-actions">
          <button class="btn round" data-a="no" title="${t('confirmNo')}">❌</button>
          <button class="btn round" data-a="yes" title="${t('confirmYes')}">✅</button>
        </div>
      </div>
    `;
    (overlay.querySelector('[data-a="no"]') as HTMLButtonElement).addEventListener('click', () => overlay.remove());
    (overlay.querySelector('[data-a="yes"]') as HTMLButtonElement).addEventListener('click', () => {
      void deleteWork(workId).then(() => {
        overlay.remove();
        void renderGrid();
      });
    });
    el.appendChild(overlay);
  }

  function renderCatalogCards(images: CatalogImage[], works: Work[]) {
    // getAllWorks is sorted newest-first, so the first hit per image is the latest.
    const latestByImage = new Map<string, Work>();
    for (const work of works) {
      if (!latestByImage.has(work.imageId)) latestByImage.set(work.imageId, work);
    }
    images.forEach((imgMeta) => renderCatalogCard(imgMeta, latestByImage.get(imgMeta.id)));
  }

  async function renderGrid() {
    revokeObjectUrls();
    grid.innerHTML = '';
    const works = await getAllWorks();

    const query = searchOpen ? searchQuery.trim() : '';
    if (query) {
      const results = catalog.images.filter((img) => matchesQuery(img, query));
      if (results.length === 0) {
        grid.innerHTML = '<div class="gallery-empty">🤷</div>';
        return;
      }
      renderCatalogCards(results, works);
      return;
    }

    if (activeFilter === 'mine') {
      if (works.length === 0) {
        grid.innerHTML = '<div class="gallery-empty">🖼️</div>';
        return;
      }
      for (const work of works) {
        const card = document.createElement('div');
        card.className = 'card';
        const img = document.createElement('img');
        img.src = trackObjectUrl(work.thumbBlob);
        img.alt = t('myWorkAlt');
        card.appendChild(img);

        const del = document.createElement('button');
        del.className = 'card-delete';
        del.textContent = '✖';
        del.title = t('deleteWork');
        del.addEventListener('click', (ev) => {
          ev.stopPropagation();
          confirmDelete(work.workId);
        });
        card.appendChild(del);

        card.addEventListener('click', () => navigate(work.imageId, work.workId));
        grid.appendChild(card);
      }
      return;
    }

    const images =
      activeFilter === 'all' ? catalog.images : catalog.images.filter((i) => i.category === activeFilter);
    if (images.length === 0) {
      grid.innerHTML = '<div class="gallery-empty">🤷</div>';
      return;
    }
    renderCatalogCards(images, works);
  }

  renderChips();
  await renderGrid();

  return () => {
    revokeObjectUrls();
  };
}
