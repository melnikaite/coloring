export interface CatalogCategory {
  id: string;
  icon: string;
}

export interface CatalogImage {
  id: string;
  file: string;
  title: string;
  category: string;
  /**
   * Optional search keywords. Either the legacy flat form (treated as
   * English) or a per-language map, e.g. `{en: ["cat"], ru: ["кот"]}`.
   * Search matches against ALL languages regardless of the UI locale.
   */
  tags?: string[] | Record<string, string[]>;
  /**
   * Optional multi-frame line art: alternate line-art frames of the same
   * drawing with one micro-movement (a blink, a shifted paw). Frame 0 is
   * `file` itself (which is also what the gallery grid shows); the extra
   * frames are used only for the celebrate animation and GIF export -
   * painting always works against frame 0.
   */
  frames?: string[];
}

/** All image URLs an entry needs offline: the main file plus any extra animation frames. */
export function imageFiles(img: CatalogImage): string[] {
  const files = [img.file, ...(img.frames ?? [])];
  return [...new Set(files)];
}

/** Flattens `tags` (legacy array or per-language map) into one keyword list across all languages. */
export function allTags(img: CatalogImage): string[] {
  if (!img.tags) return [];
  return Array.isArray(img.tags) ? img.tags : Object.values(img.tags).flat();
}

export interface Catalog {
  categories: CatalogCategory[];
  images: CatalogImage[];
}

let cached: Catalog | null = null;

/** Fetch (and cache in memory) the image catalog. Works offline once the SW has cached it. */
export async function loadCatalog(): Promise<Catalog> {
  if (cached) return cached;
  const res = await fetch('/images/catalog.json');
  cached = (await res.json()) as Catalog;
  return cached;
}

export function imageUrl(file: string): string {
  return `/images/${file}`;
}
