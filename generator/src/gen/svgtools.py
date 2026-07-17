"""Shared SVG validation, sanitization and optimization helpers.

Used by both the "banana" (vtracer output) and "gemma" (raw LLM-authored SVG)
backends before an SVG is written to disk.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET

SVG_NS = "http://www.w3.org/2000/svg"
FORBIDDEN_TAGS = {"script", "foreignObject", "text", "image", "iframe"}

# Elements that should be counted as "paintable shapes" for the minimum-shape check.
SHAPE_TAGS = {"path", "circle", "ellipse", "rect", "polygon", "polyline"}


class SvgValidationError(ValueError):
    pass


def strip_markdown_fences(text: str) -> str:
    """Strip ```xml / ```svg / ``` fences an LLM may wrap the SVG in."""
    text = text.strip()
    text = re.sub(r"^```[a-zA-Z]*\s*\n?", "", text)
    text = re.sub(r"\n?```\s*$", "", text)
    return text.strip()


def _local(tag: str) -> str:
    """Strip the XML namespace off an ElementTree tag like '{ns}svg' -> 'svg'."""
    return tag.rsplit("}", 1)[-1]


def _strip_ns(elem: ET.Element) -> None:
    """Remove XML namespaces in-place so tags compare as plain 'svg', 'path', etc."""
    for el in elem.iter():
        el.tag = _local(el.tag)
        # Drop namespaced attributes (e.g. xlink:href) that could carry scripts/links.
        for attr in list(el.attrib):
            if attr.startswith("{") or ":" in attr:
                del el.attrib[attr]


def parse_svg(svg_text: str) -> ET.Element:
    """Parse SVG text into an ElementTree root, raising SvgValidationError on failure."""
    try:
        root = ET.fromstring(svg_text)
    except ET.ParseError as e:
        raise SvgValidationError(f"SVG does not parse as XML: {e}") from e
    if _local(root.tag) != "svg":
        raise SvgValidationError(f"root element is not <svg>, got <{root.tag}>")
    return root


def sanitize(root: ET.Element) -> int:
    """Remove forbidden elements (script/foreignObject/text/...) in place.

    Returns the number of elements removed.
    """
    _strip_ns(root)
    removed = 0
    # ElementTree has no parent pointers, so walk with an explicit parent map.
    parent_map = {child: parent for parent in root.iter() for child in parent}
    for el in list(root.iter()):
        if _local(el.tag) in FORBIDDEN_TAGS:
            parent = parent_map.get(el)
            if parent is not None:
                parent.remove(el)
                removed += 1
    # Strip event handler attributes (onload, onclick, ...) and javascript: hrefs.
    for el in root.iter():
        for attr in list(el.attrib):
            if attr.lower().startswith("on"):
                del el.attrib[attr]
            elif el.attrib.get(attr, "").strip().lower().startswith("javascript:"):
                del el.attrib[attr]
    return removed


def count_shapes(root: ET.Element) -> int:
    return sum(1 for el in root.iter() if _local(el.tag) in SHAPE_TAGS)


def ensure_viewbox(root: ET.Element) -> None:
    """Ensure the root <svg> has a viewBox, deriving it from width/height if needed."""
    if root.get("viewBox"):
        # Still drop width/height so the app scales freely by viewBox.
        root.attrib.pop("width", None)
        root.attrib.pop("height", None)
        return

    width = root.get("width", "")
    height = root.get("height", "")
    w = re.sub(r"[^0-9.]", "", width) or "1024"
    h = re.sub(r"[^0-9.]", "", height) or "1024"
    root.set("viewBox", f"0 0 {w} {h}")
    root.attrib.pop("width", None)
    root.attrib.pop("height", None)


def validate_and_clean(svg_text: str, min_shapes: int = 1) -> str:
    """Parse, sanitize, verify shape count, ensure viewBox. Returns clean SVG text.

    Raises SvgValidationError if the SVG is malformed or has too few shapes.
    """
    root = parse_svg(svg_text)
    sanitize(root)
    n = count_shapes(root)
    if n < min_shapes:
        raise SvgValidationError(
            f"only {n} paintable shape(s) found, need at least {min_shapes}"
        )
    ensure_viewbox(root)
    ET.register_namespace("", SVG_NS)
    root.tag = f"{{{SVG_NS}}}svg"
    for el in root.iter():
        if not el.tag.startswith("{"):
            el.tag = f"{{{SVG_NS}}}{el.tag}"
    return ET.tostring(root, encoding="unicode")


def optimize(svg_text: str) -> str:
    """Run scour to strip metadata/comments and reduce numeric precision."""
    from scour import scour

    options = scour.parse_args([])
    options.remove_metadata = True
    options.remove_descriptive_elements = True
    options.strip_comments = True
    options.shorten_ids = True
    options.indent_type = "none"
    options.digits = 3
    options.newlines = False
    return scour.scourString(svg_text, options)
