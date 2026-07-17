"""Backend "banana": Gemini 2.5 Flash Image ("nano banana") via the REST API.

We call the REST endpoint directly with httpx instead of the google-genai SDK to
keep the dependency footprint small. The exact response envelope has shifted
across doc revisions (camelCase inlineData vs snake_case inline_data), so parsing
below checks both.
"""

from __future__ import annotations

import base64
import os

import httpx

from . import postprocess, svgtools

MODEL = "gemini-2.5-flash-image"
API_URL = (
    f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
)

PROMPT_TEMPLATE = (
    "Black and white line art coloring page for young children. "
    "Subject: {subject}. Thick smooth black outlines (about 8px), large simple "
    "closed shapes, no shading, no hatching, no gray tones, no tiny details, "
    "pure white background, no frame or border around the image, the whole "
    "subject fits inside the picture with margins."
)


class BananaError(RuntimeError):
    pass


def _get_api_key() -> str:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise BananaError(
            "GEMINI_API_KEY is not set. Get an API key at "
            "https://aistudio.google.com/apikey and either export it as an "
            "environment variable or put it in generator/.env as "
            "GEMINI_API_KEY=... (see generator/.env.example)."
        )
    return api_key


def _extract_inline_png(response_json: dict) -> bytes:
    candidates = response_json.get("candidates") or []
    if not candidates:
        raise BananaError(
            f"Gemini response has no candidates: {response_json!r}"
        )
    content = candidates[0].get("content") or {}
    parts = content.get("parts") or []
    for part in parts:
        inline = part.get("inlineData") or part.get("inline_data")
        if inline and inline.get("data"):
            return base64.b64decode(inline["data"])
    # No image part found -- surface any text part to help debugging (e.g. a
    # safety refusal comes back as a text part, not inline data).
    text_parts = [p.get("text") for p in parts if p.get("text")]
    if text_parts:
        raise BananaError(
            f"Gemini did not return an image, it returned text instead: "
            f"{' '.join(text_parts)!r}"
        )
    raise BananaError(f"Gemini response has no image data: {response_json!r}")


def _request_image(parts: list[dict], *, timeout: float = 120.0) -> bytes:
    """POST a generateContent request with the given parts, return PNG bytes."""
    api_key = _get_api_key()
    body = {
        "contents": [{"parts": parts}],
        "generationConfig": {"responseModalities": ["IMAGE"]},
    }
    headers = {"x-goog-api-key": api_key, "Content-Type": "application/json"}

    try:
        resp = httpx.post(API_URL, json=body, headers=headers, timeout=timeout)
    except httpx.HTTPError as e:
        raise BananaError(f"request to Gemini API failed: {e}") from e

    if resp.status_code != 200:
        raise BananaError(
            f"Gemini API returned HTTP {resp.status_code}: {resp.text[:2000]}"
        )

    try:
        data = resp.json()
    except ValueError as e:
        raise BananaError(f"Gemini API returned non-JSON response: {e}") from e

    return _extract_inline_png(data)


def generate_image_png(subject: str, *, timeout: float = 120.0) -> bytes:
    """Text-to-image: return the raw PNG bytes of the generated image."""
    prompt = PROMPT_TEMPLATE.format(subject=subject)
    return _request_image([{"text": prompt}], timeout=timeout)


def edit_image_png(png_bytes: bytes, prompt: str, *, timeout: float = 120.0) -> bytes:
    """Image edit: send an input PNG plus an instruction, return the edited PNG."""
    parts = [
        {
            "inline_data": {
                "mime_type": "image/png",
                "data": base64.b64encode(png_bytes).decode("ascii"),
            }
        },
        {"text": prompt},
    ]
    return _request_image(parts, timeout=timeout)


def png_to_svg(png_bytes: bytes, *, png_cache_path=None) -> str:
    """Shared raster-to-SVG tail: threshold, vectorize, clean, optimize.

    If png_cache_path is given, the post-threshold black/white PNG is saved
    there (used later as the edit input for animation frames).
    """
    bw_image = postprocess.prepare_bw_image(png_bytes)
    if png_cache_path is not None:
        png_cache_path.parent.mkdir(parents=True, exist_ok=True)
        bw_image.save(png_cache_path)
    raw_svg = postprocess.vectorize(bw_image)
    clean_svg = svgtools.validate_and_clean(raw_svg, min_shapes=1)
    return svgtools.optimize(clean_svg)


def generate_svg(subject: str, *, png_cache_path=None) -> str:
    """Full banana pipeline: generate PNG, threshold, vectorize, clean, optimize."""
    png_bytes = generate_image_png(subject)
    return png_to_svg(png_bytes, png_cache_path=png_cache_path)
