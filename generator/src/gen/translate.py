"""Keyword translation for multilingual search tags, via the local Gemma model.

Catalog `tags` are stored as an object keyed by 2-letter language code,
e.g. {"en": [...], "ru": [...], "de": [...]}. English tags are computed by the
generator; the other languages are translated here in one LocalAI call per
image. Translation is strictly best-effort: any failure (LocalAI down, bad
JSON, ...) degrades to an English-only object -- generation must never fail
because of translation.
"""

from __future__ import annotations

import json
import re
import sys

from . import gemma
from .svgtools import strip_markdown_fences

# Target languages for translated search tags (besides English).
TAG_LANGS = ["ru", "de"]

SYSTEM_PROMPT = (
    "You translate short English search keywords for a kids' coloring app "
    "into other languages. Output ONLY a strict JSON object, no markdown "
    "code fences, no comments, no explanations."
)


class TranslateError(RuntimeError):
    pass


def _build_user_prompt(en_tags: list[str], langs: list[str]) -> str:
    example = ", ".join(f'"{lang}": [...]' for lang in langs)
    return (
        f"Translate these English keywords into the languages "
        f"{', '.join(langs)}: {json.dumps(en_tags)}\n"
        f"Output a JSON object of the form {{{example}}}. Use lowercase, "
        f"natural single words or short phrases a parent would type into "
        f"search; you do not need the same count or order as the English list."
    )


def _clean_tag_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    out = []
    for v in value:
        if isinstance(v, str) and v.strip():
            out.append(v.strip().lower())
    return out


def _parse_response(raw: str, langs: list[str]) -> dict[str, list[str]]:
    """Parse the model output into {lang: [tags]} for the langs it delivered."""
    text = strip_markdown_fences(raw)
    # Be defensive: keep only the outermost {...} in case of stray prose.
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise TranslateError(f"no JSON object in translation response: {raw[:200]!r}")
    try:
        data = json.loads(text[start : end + 1])
    except ValueError as e:
        raise TranslateError(f"translation response is not valid JSON: {e}") from e
    if not isinstance(data, dict):
        raise TranslateError(f"translation response is not an object: {data!r}")

    result: dict[str, list[str]] = {}
    for lang in langs:
        tags = _clean_tag_list(data.get(lang))
        if tags:
            result[lang] = tags
    if not result:
        raise TranslateError(
            f"translation response contains none of the requested languages "
            f"{langs}: {data!r}"
        )
    return result


def translate_keywords(en_tags: list[str], langs: list[str]) -> dict[str, list[str]]:
    """Translate English keywords into the given languages via local Gemma.

    Returns {lang: [tags]} for the languages the model delivered (possibly a
    subset). Raises TranslateError/GemmaError on hard failure.
    """
    if not en_tags or not langs:
        return {}
    raw = gemma.chat(
        SYSTEM_PROMPT, _build_user_prompt(en_tags, langs), max_tokens=1500
    )
    return _parse_response(raw, langs)


def tags_object(en_tags: list[str], langs: list[str] | None = None) -> dict[str, list[str]]:
    """Build the catalog tags object {en: [...], ru: [...], ...}, best-effort.

    Never raises: on any translation failure a warning is logged and the
    English-only object is returned.
    """
    if langs is None:
        langs = TAG_LANGS
    result: dict[str, list[str]] = {"en": list(en_tags)}
    if not en_tags:
        return result
    try:
        result.update(translate_keywords(en_tags, langs))
    except (TranslateError, gemma.GemmaError) as e:
        print(
            f"warning: tag translation failed, writing English-only tags: {e}",
            file=sys.stderr,
        )
    return result


def normalize_tags(tags: object, title: str = "") -> dict[str, list[str]]:
    """Normalize any stored tags value (legacy array, object, missing) to object form."""
    if isinstance(tags, dict):
        return {
            lang: _clean_tag_list(v) for lang, v in tags.items() if _clean_tag_list(v)
        }
    if isinstance(tags, list):
        cleaned = _clean_tag_list(tags)
        return {"en": cleaned} if cleaned else {}
    if title:
        words = [w.lower() for w in re.findall(r"[A-Za-z0-9]+", title) if len(w) > 2]
        if words:
            return {"en": words}
    return {}
