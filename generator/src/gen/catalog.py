"""Read/write app/public/images/catalog.json, matching the app's expected format."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# Fallback emoji per category id, used only when a new category is created.
CATEGORY_EMOJI: dict[str, str] = {
    "animals": "🐾",
    "nature": "🌿",
    "vehicles": "🚗",
    "characters": "🦸",
    "funny": "🤪",
    "food": "🍎",
    "space": "🚀",
    "events": "🎉",
    "professions": "👩‍🚒",
}
DEFAULT_EMOJI = "🖼️"


def load_catalog(out_dir: Path) -> dict[str, Any]:
    """Load catalog.json from out_dir, or return an empty skeleton if missing."""
    catalog_path = out_dir / "catalog.json"
    if not catalog_path.exists():
        return {"categories": [], "images": []}
    with catalog_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_catalog(out_dir: Path, catalog: dict[str, Any]) -> None:
    catalog_path = out_dir / "catalog.json"
    with catalog_path.open("w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)
        f.write("\n")


def ensure_category(catalog: dict[str, Any], category: str) -> None:
    """Add the category to catalog['categories'] if it isn't there yet."""
    categories = catalog.setdefault("categories", [])
    if any(c.get("id") == category for c in categories):
        return
    icon = CATEGORY_EMOJI.get(category, DEFAULT_EMOJI)
    categories.append({"id": category, "icon": icon})


def find_image(catalog: dict[str, Any], image_id: str) -> dict[str, Any] | None:
    for img in catalog.get("images", []):
        if img.get("id") == image_id:
            return img
    return None


def upsert_image(
    catalog: dict[str, Any],
    *,
    image_id: str,
    file: str,
    title: str,
    category: str,
    tags: dict[str, list[str]] | list[str] | None = None,
    force: bool,
) -> None:
    """Insert (or, with force=True, overwrite) an image entry.

    Raises ValueError if the id already exists and force is False.
    """
    images = catalog.setdefault("images", [])
    entry: dict[str, Any] = {
        "id": image_id,
        "file": file,
        "title": title,
        "category": category,
    }
    if tags:
        entry["tags"] = tags
    existing = find_image(catalog, image_id)
    if existing is not None:
        if not force:
            raise ValueError(
                f"image id '{image_id}' already exists in catalog.json "
                f"(use --force to overwrite)"
            )
        existing.pop("tags", None)  # drop stale tags when overwriting without new ones
        existing.update(entry)
        return
    images.append(entry)
