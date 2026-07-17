"""Raster post-processing (Pillow) and vectorization (vtracer) for the banana backend."""

from __future__ import annotations

import io
import tempfile
from pathlib import Path

from PIL import Image, ImageFilter, ImageOps

THRESHOLD = 160
BORDER_MARGIN_FRAC = 0.04  # white margin added around the artwork, as a fraction of size


def prepare_bw_image(png_bytes: bytes) -> Image.Image:
    """Grayscale -> autocontrast -> hard threshold -> despeckle -> white margin."""
    img = Image.open(io.BytesIO(png_bytes)).convert("L")
    img = ImageOps.autocontrast(img)
    # Hard threshold to pure black/white.
    bw = img.point(lambda p: 255 if p >= THRESHOLD else 0, mode="L")
    # Remove small specks (isolated dark pixels) without eroding thick outlines.
    bw = bw.filter(ImageFilter.MedianFilter(size=3))
    bw = bw.convert("RGB")

    # Ensure a white border margin so vectorized shapes never touch the frame edge.
    w, h = bw.size
    margin = int(round(min(w, h) * BORDER_MARGIN_FRAC))
    if margin > 0:
        canvas = Image.new("RGB", (w, h), "white")
        inner = bw.resize((w - 2 * margin, h - 2 * margin), Image.LANCZOS)
        # Re-threshold after resizing (LANCZOS can reintroduce gray edges).
        inner_l = inner.convert("L").point(lambda p: 255 if p >= 128 else 0, mode="L")
        inner = inner_l.convert("RGB")
        canvas.paste(inner, (margin, margin))
        bw = canvas

    return bw


def vectorize(image: Image.Image) -> str:
    """Vectorize a black/white PIL image to SVG text using vtracer."""
    import vtracer

    with tempfile.TemporaryDirectory() as td:
        in_path = Path(td) / "in.png"
        out_path = Path(td) / "out.svg"
        image.save(in_path)
        vtracer.convert_image_to_svg_py(
            str(in_path),
            str(out_path),
            colormode="binary",
            mode="polygon",
            filter_speckle=6,
            color_precision=1,
            corner_threshold=60,
            path_precision=2,
        )
        return out_path.read_text(encoding="utf-8")
