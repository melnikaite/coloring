"""Second-frame ("micro-movement") generation for existing coloring pages.

Takes frame 1 (the existing SVG, or its cached post-threshold PNG), asks
Gemini's image-edit mode for the same drawing with one tiny movement, and
writes it as `<category>/<id>.f2.svg`. The app cycles the frames over one
shared paint layer, so composition must stay aligned between frames.

SVG rasterization uses macOS `qlmanage` (this pipeline only runs on a Mac).
"""

from __future__ import annotations

import io
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

from . import banana

ANIMATE_PROMPT = (
    "Redraw this exact coloring page with one tiny natural movement, like a "
    "claymation animation frame: for example eyes blinking closed, a smile "
    "widening, a tail or arm shifted slightly. Keep the same framing, same "
    "position, same size, same thick black outlines and pure white "
    "background. Change only ONE small body part; every other line must "
    "stay identical."
)


class AnimateError(RuntimeError):
    pass


def flatten_to_white(png_bytes: bytes) -> bytes:
    """Composite a possibly-transparent PNG onto a white background."""
    img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    bg = Image.new("RGB", img.size, "white")
    bg.paste(img, mask=img.getchannel("A"))
    out = io.BytesIO()
    bg.save(out, format="PNG")
    return out.getvalue()


def rasterize_svg(svg_path: Path, size: int = 1024) -> bytes:
    """Rasterize an SVG to PNG via macOS qlmanage (output is <name>.svg.png)."""
    with tempfile.TemporaryDirectory() as td:
        try:
            result = subprocess.run(
                ["qlmanage", "-t", "-s", str(size), "-o", td, str(svg_path)],
                capture_output=True,
                text=True,
                timeout=60,
            )
        except FileNotFoundError as e:
            raise AnimateError(
                "qlmanage not found -- SVG rasterization requires macOS"
            ) from e
        out_path = Path(td) / f"{svg_path.name}.png"
        if result.returncode != 0 or not out_path.exists():
            raise AnimateError(
                f"qlmanage failed to rasterize {svg_path}: "
                f"{result.stderr.strip() or result.stdout.strip()}"
            )
        # Quick Look thumbnails are RGBA with a transparent background;
        # Gemini needs the pure-white background the prompt promises.
        return flatten_to_white(out_path.read_bytes())


def get_frame1_png(image_id: str, svg_path: Path, cache_dir: Path) -> bytes:
    """Frame-1 raster: the cached post-threshold PNG if present, else qlmanage."""
    cached = cache_dir / f"{image_id}.png"
    if cached.exists():
        return cached.read_bytes()
    if not svg_path.exists():
        raise AnimateError(f"frame-1 SVG not found: {svg_path}")
    return rasterize_svg(svg_path)


def generate_frame2_svg(image_id: str, svg_path: Path, cache_dir: Path) -> str:
    """Full second-frame pipeline: frame-1 raster -> Gemini edit -> SVG."""
    frame1_png = get_frame1_png(image_id, svg_path, cache_dir)
    frame2_png = banana.edit_image_png(frame1_png, ANIMATE_PROMPT)
    return banana.png_to_svg(frame2_png)
