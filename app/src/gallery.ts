import { loadCatalog, imageUrl, imageFiles, allTags, CatalogImage } from './catalog';
import { getAllWorks, getWorksForImage, deleteWork, Work } from './store';
import { isFullyCached, downloadUrls, offlineDownloadsAvailable } from './offlineCache';
import { onInstallAvailabilityChange, promptInstall } from './installPrompt';
import { isFavorite, toggleFavorite, getFavoriteIds } from './favorites';
import { getTheme, toggleTheme } from './theme';
import { t } from './i18n';

type Filter = 'all' | 'mine' | 'favorites' | string;

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
        <button class="btn round" data-role="themeToggle"></button>
        <button class="btn round" data-role="installButton" hidden>📲</button>
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
  const themeToggle = el.querySelector('[data-role="themeToggle"]') as HTMLButtonElement;
  const installButton = el.querySelector('[data-role="installButton"]') as HTMLButtonElement;
  const grid = el.querySelector('[data-role="grid"]') as HTMLElement;

  searchInput.placeholder = t('searchPlaceholder');
  searchClose.title = t('closeSearch');
  searchToggle.title = t('search');
  installButton.title = t('installApp');

  /** Icon shows the CURRENT theme (☀️ = light is active, 🌙 = dark is active); tapping flips it. */
  function renderThemeToggle() {
    const active = getTheme();
    themeToggle.textContent = active === 'dark' ? '🌙' : '☀️';
    themeToggle.title = t(active === 'dark' ? 'themeToggleToLight' : 'themeToggleToDark');
  }
  renderThemeToggle();
  themeToggle.addEventListener('click', () => {
    toggleTheme();
    renderThemeToggle();
  });
  installButton.addEventListener('click', () => void promptInstall());
  const unsubscribeInstall = onInstallAvailabilityChange((available) => {
    installButton.hidden = !available;
  });

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

    if (urls && urls.length > 0 && offlineDownloadsAvailable()) {
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
    addChip('favorites', '❤️', null);
  }

  function trackObjectUrl(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    return url;
  }

  /**
   * A catalog card. When the image already has saved works, it shows the
   * latest work's colored thumbnail plus a 🖌️ badge, and tapping asks
   * whether to continue that work or start a fresh one. A ❤️/🤍 favorite
   * toggle sits in the opposite corner from the 🖌️ badge so they never collide.
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
      img.classList.add('card-img-blank');
    }
    img.alt = imgMeta.title;
    card.prepend(img);

    const fav = document.createElement('button');
    fav.className = 'card-favorite';
    const favState = isFavorite(imgMeta.id);
    fav.textContent = favState ? '❤️' : '🤍';
    fav.title = t(favState ? 'unfavorite' : 'favorite');
    fav.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleFavorite(imgMeta.id);
      void renderGrid();
    });
    card.appendChild(fav);

    card.addEventListener('click', () => {
      if (latestWork) void chooseWork(imgMeta);
      else navigate(imgMeta.id);
    });
    grid.appendChild(card);
  }

  /**
   * True if a saved work has no actual content worth offering as its own
   * "continue" option - i.e. neither frame has any paint operations at all
   * (fill/stroke/sticker). Ops are the source of truth now (see
   * `engine/ops.ts`), so this is a direct, synchronous check - no need to
   * decode a raster blob and scan it for non-transparent pixels anymore.
   */
  function isWorkBlank(work: Work): boolean {
    return (work.ops1?.length ?? 0) === 0 && (work.ops2?.length ?? 0) === 0;
  }

  /**
   * Shows every saved work for this picture as its own real preview, plus one
   * blank picture to start fresh - real thumbnails, not an icon language to
   * learn. Works that were saved but never actually painted (e.g. opened and
   * immediately backed out of) are left out entirely, since the blank option
   * already covers "start fresh" - no point piling up empty-looking previews.
   */
  async function chooseWork(imgMeta: CatalogImage) {
    const works = await getWorksForImage(imgMeta.id);
    const blankChecks = await Promise.all(works.map((w) => isWorkBlank(w)));
    const realWorks = works.filter((_, i) => !blankChecks[i]);

    if (realWorks.length === 0) {
      navigate(imgMeta.id);
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    const actions = document.createElement('div');
    actions.className = 'dialog-actions dialog-actions-scroll';
    dialog.appendChild(actions);
    overlay.appendChild(dialog);

    const urls: string[] = [];
    function addChoice(src: string, title: string, onPick: () => void, blank = false) {
      const btn = document.createElement('button');
      btn.className = 'btn choice';
      btn.title = title;
      const img = document.createElement('img');
      img.className = 'dialog-thumb';
      if (blank) img.classList.add('card-img-blank');
      img.alt = '';
      img.src = src;
      btn.appendChild(img);
      btn.addEventListener('click', () => {
        close();
        onPick();
      });
      actions.appendChild(btn);
    }

    for (const work of realWorks) {
      const url = URL.createObjectURL(work.thumbBlob);
      urls.push(url);
      addChoice(url, t('continueWork'), () => navigate(imgMeta.id, work.workId));
    }
    addChoice(imageUrl(imgMeta.file), t('newWork'), () => navigate(imgMeta.id), true);

    const close = () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
      overlay.remove();
    };
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) close(); // tap outside = cancel
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

    if (activeFilter === 'favorites') {
      const favoriteIds = getFavoriteIds();
      const images = catalog.images.filter((i) => favoriteIds.has(i.id));
      if (images.length === 0) {
        grid.innerHTML = '<div class="gallery-empty">🤍</div>';
        return;
      }
      renderCatalogCards(images, works);
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
    unsubscribeInstall();
  };
}
