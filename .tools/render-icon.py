"""Rasterise the plugin's SVG icon into the GitHub-hosted PNG the listing wants.

The awesome-dsh-plugin entries accept only a GitHub-hosted raster image for the
market card (SVG is refused), so `icon.svg` — the source of truth, drawn by hand
— is rendered here at 180 px and 96 px. Pillow cannot read SVG, so the shapes are
re-drawn from the same geometry the SVG declares. Keep the two in sync: if the
SVG changes, change this file too.
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

# Geometry lifted from icon.svg (viewBox 0 0 64 64).
WINDOW = (4, 10, 60, 54)      # x0, y0, x1, y1
CHROME = (4, 10, 60, 22)
RADIUS = 8
DOTS = [(13, 16, "#22c55e"), (21, 16, "#eab308"), (29, 16, "#ef4444")]
PROMPT = [(14, 32), (21, 39), (14, 46)]
BAR_LONG = (26, 42, 50, 45)
BAR_SHORT = (26, 34, 42, 37)


def render(size: int) -> Image.Image:
    scale = size / 64
    big = size * 4  # supersample, then downsample for clean edges
    s = big / 64
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    def box(values):
        x0, y0, x1, y1 = values
        return [x0 * s, y0 * s, x1 * s, y1 * s]

    # Rounded window body, then the darker title bar on top of it.
    draw.rounded_rectangle(box(WINDOW), radius=RADIUS * s, fill="#111827")
    draw.rounded_rectangle(box(CHROME), radius=RADIUS * s, fill="#1f2937")
    # Square off the bottom corners of the title bar so it reads as a bar.
    draw.rectangle(box((4, 16, 60, 22)), fill="#1f2937")

    for cx, cy, colour in DOTS:
        draw.ellipse(
            [cx * s - 2.4 * s, cy * s - 2.4 * s, cx * s + 2.4 * s, cy * s + 2.4 * s],
            fill=colour,
        )

    width = max(1, round(3 * s))
    points = [(x * s, y * s) for x, y in PROMPT]
    draw.line(points, fill="#22c55e", width=width, joint="curve")
    # Round the stroke ends the way stroke-linecap="round" would.
    for x, y in (points[0], points[-1]):
        draw.ellipse([x - width / 2, y - width / 2, x + width / 2, y + width / 2], fill="#22c55e")

    draw.rounded_rectangle(box(BAR_LONG), radius=1.5 * s, fill="#38bdf8")

    # The short bar is the same blue at 75 % opacity: draw it on its own layer.
    layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle(box(BAR_SHORT), radius=1.5 * s, fill="#38bdf8")
    layer.putalpha(layer.getchannel("A").point(lambda value: int(value * 0.75)))
    image = Image.alpha_composite(image, layer)

    return image.resize((size, size), Image.LANCZOS)


def main() -> int:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent
    target.mkdir(parents=True, exist_ok=True)
    for size, name in ((180, "icon-180.png"), (96, "icon-96.png")):
        path = target / name
        render(size).save(path, "PNG", optimize=True)
        print(f"wrote {path} ({path.stat().st_size} bytes, {size}x{size})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
