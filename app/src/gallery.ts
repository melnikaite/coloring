import { loadCatalog, imageUrl, imageFiles, allTags, CatalogImage } from './catalog';
import { getAllWorks, deleteWork } from './store';
import { isFullyCached, downloadUrls } from './offlineCache';
import { t } from './i18n';

type Filter = 'all' | 'mine' | string;

function matchesQuery(img: CatalogImage, query: string): boolean {
  // Tags from ALL languages are searched, so a Russian parent typing "кот"
  // matches even if the UI locale (or the entry's title) is English.
  const haystack = [img.title, img.id, img.category, ...allTags(img)].join(' ').toLowerCase();
  return haystack.includes(query.toLowerCase());
}

/** Mounts the gallery (home) screen. Returns a dispose function. */
export async function mountGallery(root: HTMLElement, navigate: (imageId: string) => void): Promise<() => void> {
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
    addChip('all', '⭐', downloadUrlsFor(catalog.images));
    catalog.categories.forEach((c) =>
      addChip(
        c.id,
        c.icon,
        downloadUrlsFor(catalog.images.filter((i) => i.category === c.id))
      )
    );
    addChip('mine', '🎨', null);
  }

  function renderCatalogCard(imgMeta: CatalogImage) {
    const card = document.createElement('div');
    card.className = 'card';
    const img = document.createElement('img');
    img.src = imageUrl(imgMeta.file);
    img.alt = imgMeta.title;
    img.loading = 'lazy';
    card.appendChild(img);
    card.addEventListener('click', () => navigate(imgMeta.id));
    grid.appendChild(card);
  }

  function confirmDelete(imageId: string) {
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
      void deleteWork(imageId).then(() => {
        overlay.remove();
        void renderGrid();
      });
    });
    el.appendChild(overlay);
  }

  async function renderGrid() {
    revokeObjectUrls();
    grid.innerHTML = '';

    const query = searchOpen ? searchQuery.trim() : '';
    if (query) {
      const results = catalog.images.filter((img) => matchesQuery(img, query));
      if (results.length === 0) {
        grid.innerHTML = '<div class="gallery-empty">🤷</div>';
        return;
      }
      results.forEach(renderCatalogCard);
      return;
    }

    if (activeFilter === 'mine') {
      const works = await getAllWorks();
      if (works.length === 0) {
        grid.innerHTML = '<div class="gallery-empty">🖼️</div>';
        return;
      }
      for (const work of works) {
        const card = document.createElement('div');
        card.className = 'card';
        const img = document.createElement('img');
        const url = URL.createObjectURL(work.thumbBlob);
        objectUrls.push(url);
        img.src = url;
        img.alt = t('myWorkAlt');
        card.appendChild(img);

        const del = document.createElement('button');
        del.className = 'card-delete';
        del.textContent = '✖';
        del.title = t('deleteWork');
        del.addEventListener('click', (ev) => {
          ev.stopPropagation();
          confirmDelete(work.imageId);
        });
        card.appendChild(del);

        card.addEventListener('click', () => navigate(work.imageId));
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
    images.forEach(renderCatalogCard);
  }

  renderChips();
  await renderGrid();

  return () => {
    revokeObjectUrls();
  };
}
