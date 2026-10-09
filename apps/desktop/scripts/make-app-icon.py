"""Generate shared Pier artwork. See docs/branding.md for regeneration commands."""

import io
import math
from pathlib import Path
import xml.etree.ElementTree as ET

import cairosvg
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "assets/brand/pier.svg"
MOBILE = ROOT / "apps/mobile/assets"
DESKTOP = ROOT / "apps/desktop"
SVG_NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NS)


def artwork(layer="all", monochrome=False):
    svg = ET.fromstring(SOURCE.read_bytes())
    for child in list(svg):
        if child.get("id") in {"background", "mark"}:
            if layer != "all" and child.get("id") != layer:
                svg.remove(child)
            elif layer == "mark":
                # Android's guaranteed safe area is a circle, not just a square.
                # Scale the entire mark while preserving its original forward lean.
                original_transform = child.get("transform", "")
                child.set("transform", f"translate(512 512) scale(.9) translate(-512 -512) {original_transform}".strip())
    if monochrome:
        for element in svg.iter():
            for attribute in ("fill", "stroke"):
                if element.get(attribute, "").startswith("url("):
                    element.set(attribute, "#ffffff")
    return ET.tostring(svg)


def render(svg, size):
    # Supersampling keeps rounded strokes clean in launcher and favicon sizes.
    png = cairosvg.svg2png(bytestring=svg, output_width=size * 2, output_height=size * 2)
    return Image.open(io.BytesIO(png)).convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)


def tile(image, size, inset=0):
    """Continuous corners; desktop uses Apple's 824px grid on a 1024px canvas."""
    scale = 4
    edge = (size - inset * 2) * scale
    radius = edge / 2
    points = []
    for i in range(4000):
        angle = 2 * math.pi * i / 4000
        cos, sin = math.cos(angle), math.sin(angle)
        points.append((
            radius + radius * math.copysign(abs(cos) ** (2 / 5), cos),
            radius + radius * math.copysign(abs(sin) ** (2 / 5), sin),
        ))
    mask = Image.new("L", (edge, edge), 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    image = image.resize((edge, edge), Image.Resampling.LANCZOS)
    image.putalpha(mask)
    canvas = Image.new("RGBA", (size * scale, size * scale))
    canvas.alpha_composite(image, (inset * scale, inset * scale))
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def main():
    full = artwork()
    mark = artwork("mark")
    background = artwork("background")
    mobile = render(full, 1024)
    # iOS owns the launcher mask; its full-bleed source must have no alpha channel.
    mobile.convert("RGB").save(MOBILE / "icon.png")
    render(background, 512).convert("RGB").save(MOBILE / "android-icon-background.png")
    # All mark pixels fit inside Android's central 66/108 safe zone.
    render(mark, 512).save(MOBILE / "android-icon-foreground.png")
    render(artwork("mark", monochrome=True), 432).save(MOBILE / "android-icon-monochrome.png")
    tile(mobile, 1024, inset=44).save(MOBILE / "splash-icon.png")
    tile(mobile, 48).save(MOBILE / "favicon.png")
    tile(mobile, 64).save(DESKTOP / "public/favicon.png")
    (DESKTOP / "public/logo.svg").write_bytes(SOURCE.read_bytes())
    tile(mobile, 1024, inset=100).save(DESKTOP / "src-tauri/app-icon.png")
    print("Generated desktop, mobile, adaptive, themed, splash, and web artwork from assets/brand/pier.svg")


if __name__ == "__main__":
    main()
