"""Duplicate-theme detection: catch re-generation of an existing subject
under a different id BEFORE any paid API call.

Two stages:
1. Cheap word overlap between the candidate (subject + tags + title) and each
   catalog entry (id + title + English tags). Entries above a threshold become
   duplicate candidates.
2. A local Gemma verdict on the top candidates (free). If LocalAI is down,
   stage 1 alone decides (overlap above threshold => duplicate), with a warning.
"""

from __future__ import annotations

import json
import re
import sys

from . import gemma, translate
from .svgtools import strip_markdown_fences

# Descriptor words that say nothing about the picture's subject.
STOPWORDS = {
    "a", "an", "the", "and", "or", "with", "of", "on", "in", "at", "to",
    "for", "its", "his", "her", "is", "are", "one", "two", "next",
    "cartoon", "cute", "happy", "little", "friendly", "big", "small",
    "simple", "style", "smiling", "cheerful",
}

STAGE1_THRESHOLD = 0.5  # overlap score to become a duplicate candidate
MIN_SHARED_WORDS = 2    # and at least this many shared content words
MAX_STAGE2_CANDIDATES = 5

SYSTEM_PROMPT = (
    "You judge whether two ideas for a kids' coloring page would produce "
    "essentially the same picture. Output ONLY a strict JSON object, no "
    "markdown code fences, no explanations."
)


def normalize_words(text: str) -> set[str]:
    """Lowercase, strip punctuation, drop stopwords and very short words."""
    words = set()
    for w in re.findall(r"[a-z0-9]+", text.lower()):
        if len(w) < 3 or w in STOPWORDS:
            continue
        # Crude plural folding so 'wings' matches 'wing' (applied to both sides).
        if w.endswith("s") and len(w) > 3:
            w = w[:-1]
        words.add(w)
    return words


def _entry_words(entry: dict) -> set[str]:
    en_tags = translate.normalize_tags(entry.get("tags"), entry.get("title", "")).get("en", [])
    text = " ".join(
        [entry.get("id", "").replace("-", " "), entry.get("title", ""), " ".join(en_tags)]
    )
    return normalize_words(text)


def stage1_candidates(
    candidate_words: set[str], catalog: dict, exclude_id: str | None = None
) -> list[tuple[float, dict]]:
    """Score every catalog entry by word overlap; return sorted candidates."""
    scored: list[tuple[float, dict]] = []
    if not candidate_words:
        return scored
    for entry in catalog.get("images", []):
        if exclude_id is not None and entry.get("id") == exclude_id:
            continue
        entry_words = _entry_words(entry)
        if not entry_words:
            continue
        shared = candidate_words & entry_words
        if len(shared) < MIN_SHARED_WORDS:
            continue
        score = len(shared) / min(len(candidate_words), len(entry_words))
        if score >= STAGE1_THRESHOLD:
            scored.append((score, entry))
    scored.sort(key=lambda t: (-t[0], t[1].get("id", "")))
    return scored


def _gemma_verdict(subject: str, candidates: list[dict]) -> str | None:
    """Ask local Gemma which candidate (if any) is essentially the same picture."""
    listing = "\n".join(
        f"{i}. {e.get('id')}: {e.get('title', '')}" for i, e in enumerate(candidates, 1)
    )
    user = (
        f"New coloring page idea: {subject!r}.\n"
        f"Existing pages:\n{listing}\n\n"
        f"Is the new idea essentially the same picture as one of these? "
        f'Answer strict JSON {{"duplicate_of": "<id or null>"}} '
        f"using the id string (the word before the colon), not the list number."
    )
    raw = gemma.chat(SYSTEM_PROMPT, user, max_tokens=500, temperature=0.0)
    text = strip_markdown_fences(raw)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise gemma.GemmaError(f"no JSON object in duplicate verdict: {raw[:200]!r}")
    try:
        data = json.loads(text[start : end + 1])
    except ValueError as e:
        raise gemma.GemmaError(f"duplicate verdict is not valid JSON: {e}") from e

    value = data.get("duplicate_of") if isinstance(data, dict) else None
    if not isinstance(value, str):
        return None
    value = value.strip()
    if value.lower() in ("", "null", "none"):
        return None
    valid_ids = {e.get("id") for e in candidates}
    if value in valid_ids:
        return value
    # The model sometimes answers with the list number instead of the id.
    if value.isdigit() and 1 <= int(value) <= len(candidates):
        return candidates[int(value) - 1].get("id")
    return None


def find_duplicate(item, catalog: dict) -> str | None:
    """Return the id of an existing catalog entry the item duplicates, or None.

    `item` needs .subject, .title, .tags (list of English keywords) and
    .image_id attributes (the cli.Item NamedTuple fits).
    """
    candidate_words = normalize_words(
        f"{item.subject} {item.title} {' '.join(item.tags)}"
    )
    scored = stage1_candidates(candidate_words, catalog, exclude_id=item.image_id)
    if not scored:
        return None

    top = [entry for _, entry in scored[:MAX_STAGE2_CANDIDATES]]
    try:
        return _gemma_verdict(item.subject, top)
    except gemma.GemmaError as e:
        print(
            f"warning: Gemma duplicate verdict unavailable ({e}); falling back "
            f"to word-overlap verdict: similar to '{top[0].get('id')}'",
            file=sys.stderr,
        )
        return top[0].get("id")
