"""Gemini Batch API: submit many image-generation requests as ONE async job.

Roughly 50% cheaper than the synchronous `generateContent` calls in banana.py,
in exchange for best-effort-fast-but-up-to-24h-SLA turnaround. Verified against
the model card for `gemini-3.1-flash-lite-image` (Batch API: Supported) and the
pricing page ($0.0336/image standard vs $0.0168/image batch) at
https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image and
https://ai.google.dev/gemini-api/docs/pricing, and confirmed end-to-end with a
real 2-item job (see generator/README.md's "Batch API" section for the numbers).

REST only (httpx), matching banana.py's style -- no google-genai SDK dependency.

One quirk worth flagging: the synchronous endpoint returns PNG, but the Batch
API returned JPEG (`image/jpeg`) inline data for the same model in testing.
This doesn't matter here: `banana.png_to_svg` opens the bytes with
`PIL.Image.open`, which sniffs the actual format from content, not from the
"png" in a variable name.
"""

from __future__ import annotations

import time
from typing import Callable

import httpx

from .banana import MODEL, PROMPT_TEMPLATE, _get_api_key, extract_inline_png

API_ROOT = "https://generativelanguage.googleapis.com/v1beta"
BATCH_CREATE_URL = f"{API_ROOT}/models/{MODEL}:batchGenerateContent"

# Batch job lifecycle, per https://ai.google.dev/gemini-api/docs/batch-api --
# confirmed for real against this account: a 2-item job went
# PENDING -> RUNNING -> SUCCEEDED in about 2 minutes.
TERMINAL_STATES = {
    "BATCH_STATE_SUCCEEDED",
    "BATCH_STATE_FAILED",
    "BATCH_STATE_CANCELLED",
    "BATCH_STATE_EXPIRED",
}


class BatchApiError(RuntimeError):
    pass


def submit_batch(items: list[tuple[str, str]], *, display_name: str = "coloriki-batch") -> str:
    """Submit one batch job of (key, subject) pairs; return its job name ('batches/...').

    Each key is echoed back alongside its result (see `extract_results`), so
    it should be something the caller can map back to an Item -- the image_id
    is the natural choice.
    """
    api_key = _get_api_key()
    requests = []
    for key, subject in items:
        prompt = PROMPT_TEMPLATE.format(subject=subject)
        requests.append(
            {
                "request": {
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {"responseModalities": ["IMAGE"]},
                },
                "metadata": {"key": key},
            }
        )
    body = {
        "batch": {
            "display_name": display_name,
            "input_config": {"requests": {"requests": requests}},
        }
    }
    headers = {"x-goog-api-key": api_key, "Content-Type": "application/json"}
    try:
        resp = httpx.post(BATCH_CREATE_URL, json=body, headers=headers, timeout=60.0)
    except httpx.HTTPError as e:
        raise BatchApiError(f"batch submission request failed: {e}") from e
    if resp.status_code != 200:
        raise BatchApiError(
            f"Gemini batch API returned HTTP {resp.status_code}: {resp.text[:2000]}"
        )
    try:
        data = resp.json()
    except ValueError as e:
        raise BatchApiError(f"Gemini batch API returned non-JSON response: {e}") from e
    name = data.get("name")
    if not name:
        raise BatchApiError(f"batch submission response has no job name: {data!r}")
    return name


def get_batch(job_name: str) -> dict:
    """GET the current batch job resource: {'name', 'metadata': {'state', ...}}."""
    api_key = _get_api_key()
    url = f"{API_ROOT}/{job_name}"
    try:
        resp = httpx.get(url, headers={"x-goog-api-key": api_key}, timeout=30.0)
    except httpx.HTTPError as e:
        raise BatchApiError(f"batch status request failed: {e}") from e
    if resp.status_code != 200:
        raise BatchApiError(
            f"Gemini batch API returned HTTP {resp.status_code}: {resp.text[:2000]}"
        )
    try:
        return resp.json()
    except ValueError as e:
        raise BatchApiError(f"Gemini batch API returned non-JSON response: {e}") from e


def cancel_batch(job_name: str) -> None:
    api_key = _get_api_key()
    url = f"{API_ROOT}/{job_name}:cancel"
    try:
        httpx.post(url, headers={"x-goog-api-key": api_key}, timeout=30.0)
    except httpx.HTTPError as e:
        raise BatchApiError(f"batch cancel request failed: {e}") from e


def delete_batch(job_name: str) -> None:
    api_key = _get_api_key()
    url = f"{API_ROOT}/{job_name}"
    try:
        httpx.delete(url, headers={"x-goog-api-key": api_key}, timeout=30.0)
    except httpx.HTTPError:
        pass  # best-effort tidy-up, not worth failing the run over


def batch_state(job: dict) -> str:
    return job.get("metadata", {}).get("state", "UNKNOWN")


def batch_stats(job: dict) -> dict:
    return job.get("metadata", {}).get("batchStats", {})


def is_done(state: str) -> bool:
    return state in TERMINAL_STATES


def poll_until_done(
    job_name: str,
    *,
    interval: float = 45.0,
    on_tick: Callable[[dict, str], None] | None = None,
) -> dict:
    """Block, GETting the job every `interval` seconds, until it reaches a terminal state.

    Raises `BatchApiError` on a transport/API error while polling. If the
    caller Ctrl-C's out (KeyboardInterrupt propagates, uncaught here), the job
    keeps running server-side -- callers should catch it and print the job
    name so the user can re-attach later via `gen batch-status --job-id`.
    """
    while True:
        job = get_batch(job_name)
        state = batch_state(job)
        if on_tick:
            on_tick(job, state)
        if is_done(state):
            return job
        time.sleep(interval)


def extract_results(job: dict) -> dict[str, bytes | BatchApiError]:
    """Map each submitted key to its raw image bytes, or a per-item BatchApiError.

    Only meaningful once the job has reached a terminal state; a job can
    SUCCEED overall while individual items still carry an 'error' entry
    instead of a 'response'.
    """
    output = job.get("metadata", {}).get("output", {})
    inlined = output.get("inlinedResponses", {}).get("inlinedResponses")
    if inlined is None:
        responses_file = output.get("responsesFile")
        if responses_file:
            raise BatchApiError(
                f"batch job returned file-based output ({responses_file}); "
                "this client only submits inline requests and expects inline results"
            )
        raise BatchApiError(f"batch job has no output to extract: {job!r}")

    results: dict[str, bytes | BatchApiError] = {}
    for entry in inlined:
        key = entry.get("metadata", {}).get("key")
        if key is None:
            continue
        if "error" in entry:
            results[key] = BatchApiError(f"item failed: {entry['error']!r}")
            continue
        try:
            results[key] = extract_inline_png(entry.get("response", {}))
        except Exception as e:  # noqa: BLE001 - surface as a per-item result, not a crash
            results[key] = BatchApiError(str(e))
    return results
