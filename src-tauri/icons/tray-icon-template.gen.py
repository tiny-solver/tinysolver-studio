"""Generate src-tauri/icons/tray-icon-template.png.

This is a macOS menu-bar template image: the system reads only the alpha
channel and tints the opaque pixels to match light/dark/highlighted menu
bar appearance. Re-run after editing the constants below:

    python3 src-tauri/icons/tray-icon-template.gen.py

Requires Pillow (pip install Pillow), or run it without installing anything:

    uv run --with Pillow src-tauri/icons/tray-icon-template.gen.py

The cutout is the mesh triangle from `icon.svg`, not upstream codeg's
bracket-and-dots: a menu bar showing both apps has to distinguish them by
silhouette alone, since a template image carries no colour.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageChops


# Width is elongated past height so the rounded rect can fit the
# triangle cutout without crowding.
W_LOGICAL, H_LOGICAL = 52, 44

# Render at 4x then downsample with Lanczos: PIL's drawing primitives
# are not anti-aliased, so supersampling is what produces smooth
# diagonals and round caps.
SCALE = 4
W, H = W_LOGICAL * SCALE, H_LOGICAL * SCALE

PAD = 3
CORNER = 7
STROKE = 4

# The mesh face: a closed triangle punched out of the rounded rect. Listed
# with the apex repeated so `_stroke_polyline` closes the loop and the round
# caps land on all three corners.
TRIANGLE = [(26, 11), (37, 31), (15, 31), (26, 11)]

# No vertex handles here, unlike `icon.svg`. At 52x44 the smallest dot that
# survives downsampling is wide enough to break the stroke it sits on, and a
# triangle with a notched apex reads as a damaged glyph rather than a mesh.
# The outline alone is already unmistakable against codeg's bracket mark.


def _scaled(p):
    return (int(round(p[0] * SCALE)), int(round(p[1] * SCALE)))


def _stroke_polyline(draw, pts, w):
    for i in range(len(pts) - 1):
        draw.line([_scaled(pts[i]), _scaled(pts[i + 1])], fill=255, width=w)
    r = w // 2
    for p in pts:
        x, y = _scaled(p)
        draw.ellipse((x - r, y - r, x + r, y + r), fill=255)


def main():
    bg = Image.new("L", (W, H), 0)
    ImageDraw.Draw(bg).rounded_rectangle(
        [
            (PAD * SCALE, PAD * SCALE),
            ((W_LOGICAL - PAD) * SCALE - 1, (H_LOGICAL - PAD) * SCALE - 1),
        ],
        radius=CORNER * SCALE,
        fill=255,
    )

    cut = Image.new("L", (W, H), 0)
    dc = ImageDraw.Draw(cut)
    _stroke_polyline(dc, TRIANGLE, STROKE * SCALE)

    # bg − cut: the rounded rect stays opaque except where the triangle
    # outline punches through to transparent.
    alpha = ImageChops.subtract(bg, cut)
    zero = Image.new("L", (W, H), 0)
    img = Image.merge("RGBA", (zero, zero, zero, alpha)).resize(
        (W_LOGICAL, H_LOGICAL), Image.LANCZOS
    )

    out = Path(__file__).parent / "tray-icon-template.png"
    img.save(out)
    print(f"wrote {out} {img.size}")


if __name__ == "__main__":
    main()
