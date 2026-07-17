"""Backend "gemma": free, local generation via LocalAI's OpenAI-compatible endpoint.

Good for simple/absurd shapes; not as clean as the banana (Gemini) backend.
Follows the LocalAI/Gemma stability kit from the project conventions:
reasoning_effort "none" always, fall back to reasoning_content if content is
empty, strip markdown fences, generous max_tokens, and a startup preflight.
"""

from __future__ import annotations

import httpx

from . import svgtools

BASE_URL = "http://127.0.0.1:1240/v1"
MODEL = "gemma-4-e4b-it-qat-q4_0"
MAX_ATTEMPTS = 3
MAX_TOKENS = 6000

SYSTEM_PROMPT = (
    "You are an SVG generator for a kids' coloring app. Output ONLY a single "
    "valid SVG document, nothing else: no explanations, no markdown code "
    "fences, no comments.\n"
    "Requirements:\n"
    '- Root: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">\n'
    '- At least 3 closed shapes (path/circle/ellipse/rect/polygon), each with '
    'fill="#fff" stroke="#000" stroke-width="10"\n'
    "- Shapes must be fully closed (paths end with Z) so they can be flood-filled\n"
    "- No text, no scripts, no gradients, no images, no external references\n"
    "- Keep the whole subject inside the 1024x1024 frame with margins"
)


class GemmaError(RuntimeError):
    pass


def preflight() -> None:
    """Verify LocalAI is reachable and the model is loaded before we start."""
    try:
        resp = httpx.get(f"{BASE_URL}/models", timeout=10.0)
        resp.raise_for_status()
    except httpx.HTTPError as e:
        raise GemmaError(
            f"could not reach LocalAI at {BASE_URL} (is it running on :1240?): {e}"
        ) from e
    models = [m.get("id") for m in resp.json().get("data", [])]
    if MODEL not in models:
        raise GemmaError(
            f"model '{MODEL}' is not loaded in LocalAI. Available models: {models}"
        )


def chat(
    system_prompt: str,
    user_prompt: str,
    *,
    max_tokens: int = MAX_TOKENS,
    timeout: float = 180.0,
    temperature: float | None = None,
) -> str:
    """One LocalAI chat call with the full Gemma stability kit applied.

    Pass temperature=0.0 for classification/verdict calls that must be
    deterministic across runs.
    """
    body = {
        "model": MODEL,
        "reasoning_effort": "none",
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    if temperature is not None:
        body["temperature"] = temperature
    try:
        resp = httpx.post(f"{BASE_URL}/chat/completions", json=body, timeout=timeout)
    except httpx.HTTPError as e:
        raise GemmaError(f"request to LocalAI failed: {e}") from e

    if resp.status_code != 200:
        raise GemmaError(f"LocalAI returned HTTP {resp.status_code}: {resp.text[:2000]}")

    data = resp.json()
    choices = data.get("choices") or []
    if not choices:
        raise GemmaError(f"LocalAI response has no choices: {data!r}")
    message = choices[0].get("message") or {}
    content = message.get("content") or ""
    if not content.strip():
        # Stability kit: some reasoning models put the actual answer here instead.
        content = message.get("reasoning_content") or ""
    if not content.strip():
        raise GemmaError("LocalAI returned empty content and empty reasoning_content")
    return content


def generate_svg(subject: str) -> str:
    """Ask gemma for an SVG, validating/retrying up to MAX_ATTEMPTS times."""
    preflight()

    last_error: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            raw = chat(SYSTEM_PROMPT, f"Subject: {subject}. Output the SVG now.")
            stripped = svgtools.strip_markdown_fences(raw)
            clean = svgtools.validate_and_clean(stripped, min_shapes=3)
            return svgtools.optimize(clean)
        except (GemmaError, svgtools.SvgValidationError) as e:
            last_error = e
            continue

    raise GemmaError(
        f"gemma failed to produce a valid SVG after {MAX_ATTEMPTS} attempts: "
        f"{last_error}"
    )
