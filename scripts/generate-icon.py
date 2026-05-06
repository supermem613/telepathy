#!/usr/bin/env python3
"""
Generate the telepathy app icon — a stylized broadcast / radio-wave
mark on a dark rounded-square background, in the same cyan accent
(#38bdf8) used throughout the wall UI.

Outputs:
  assets/icon.png  — 1024x1024 master (used by Electron BrowserWindow)
  assets/icon.ico  — multi-resolution Windows ICO (used by the .lnk)

Run: `python scripts/generate-icon.py` from the repo root. Re-run
whenever the design changes; both files are committed so the build
pipeline doesn't depend on Python.
"""
from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw

BG = (10, 10, 10, 255)
ACCENT = (56, 189, 248, 255)
ACCENT_DIM = (56, 189, 248, 110)
NODE = (245, 245, 245, 255)

ICO_SIZES = [16, 32, 48, 64, 128, 256]
MASTER_SIZE = 1024


def render(size: int) -> Image.Image:
    scale = 4 if size <= 64 else 2
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    radius = int(s * 0.22)
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=radius, fill=BG)

    cx, cy = s // 2, s // 2

    arc_widths = max(2, int(s * 0.025))
    for i, frac in enumerate([0.32, 0.50, 0.68]):
        r = int(s * frac)
        alpha = int(255 * (1.0 - i * 0.18))
        col = (ACCENT[0], ACCENT[1], ACCENT[2], alpha)
        bbox = (cx - r, cy - r, cx + r, cy + r)
        d.arc(bbox, start=200, end=340, fill=col, width=arc_widths)

    node_r = int(s * 0.10)
    d.ellipse((cx - node_r, cy - node_r, cx + node_r, cy + node_r), fill=NODE)
    halo_r = int(s * 0.14)
    d.ellipse((cx - halo_r, cy - halo_r, cx + halo_r, cy + halo_r),
              outline=ACCENT, width=max(1, int(s * 0.012)))

    echo_r = int(s * 0.035)
    echo_offset = int(s * 0.30)
    for dx in (-echo_offset, echo_offset):
        d.ellipse(
            (cx + dx - echo_r, cy + int(s * 0.20) - echo_r,
             cx + dx + echo_r, cy + int(s * 0.20) + echo_r),
            fill=ACCENT_DIM,
        )

    return img.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    out_dir = repo_root / "assets"
    out_dir.mkdir(exist_ok=True)

    master = render(MASTER_SIZE)
    master.save(out_dir / "icon.png", "PNG", optimize=True)
    print(f"wrote {out_dir / 'icon.png'} ({MASTER_SIZE}x{MASTER_SIZE})")

    images = [render(s) for s in ICO_SIZES]
    images[0].save(
        out_dir / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in ICO_SIZES],
        append_images=images[1:],
    )
    print(f"wrote {out_dir / 'icon.ico'} (sizes: {ICO_SIZES})")


if __name__ == "__main__":
    main()
