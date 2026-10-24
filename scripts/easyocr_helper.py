#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""easyocr_helper.py — OCR helper invoked by scripts/khu_crawler.ts

Reads text from notice images using easyocr (ko + en).
Usage:
    python3 easyocr_helper.py <image_path> [image_path ...]

Prints a single JSON document to stdout:
    { "result": [ { "file": "<basename>", "text": "...", "count": N }, ... ] }

easyocr model weights are cached on first run (~/.EasyOCR) so the first call is slow.

Large images (e.g. 3000x4600 notice posters) are downscaled to MAX_DIM before OCR:
easyocr on CPU gets extremely slow (effectively hangs) on huge inputs, and this
keeps runtime bounded while preserving enough detail for Korean text detection.
"""
import io
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")

# Max size of a single tile before slicing. Keep each tile under this so
# easyocr stays fast/bounded, but preserve full-resolution text by slicing
# large images into tiles instead of shrinking the whole thing (which destroys
# small text).
TILE_DIM = 1600
# Vertical overlap between consecutive tiles (px) to avoid cutting text rows.
TILE_OVERLAP = 64


def _flatten_alpha(im):
    """Flatten RGBA/LA/palette-transparency onto a white background."""
    from PIL import Image

    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[-1] if im.mode in ("RGBA", "LA") else None)
        return bg
    if im.mode != "RGB":
        return im.convert("RGB")
    return im


def prepare_tiles(raw: bytes) -> list:
    """Decode, flatten alpha, slice into bounded tiles, re-encode to PNG bytes.

    Returns a list of PNG byte strings. Large/tall images are cut into
    overlapping tiles (each <= TILE_DIM on its longest edge) rather than being
    downscaled, so Korean text stays at full resolution and OCR accuracy is
    preserved. Small images are returned as a single tile unchanged.
    """
    from PIL import Image

    im = _flatten_alpha(Image.open(io.BytesIO(raw)))
    w, h = im.size
    longest = max(w, h)

    # Nothing to slice: return the image as a single tile.
    if longest <= TILE_DIM:
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        return [buf.getvalue()]

    tiles: list = []

    # Slice primarily along the longest axis.
    if h > w:
        # Tall image: cut vertically, overlapping a little so text isn't split.
        y = 0
        while y < h:
            y2 = min(y + TILE_DIM, h)
            tile = im.crop((0, y, w, y2))
            buf = io.BytesIO()
            tile.save(buf, format="PNG")
            tiles.append(buf.getvalue())
            if y2 >= h:
                break
            y = y2 - TILE_OVERLAP
    else:
        # Wide (or square) image: cut horizontally.
        x = 0
        while x < w:
            x2 = min(x + TILE_DIM, w)
            tile = im.crop((x, 0, x2, h))
            buf = io.BytesIO()
            tile.save(buf, format="PNG")
            tiles.append(buf.getvalue())
            if x2 >= w:
                break
            x = x2 - TILE_OVERLAP

    return tiles


def main() -> None:
    # Force UTF-8 on stdout. On Windows, Python writes the console code page
    # (e.g. cp949) by default, which corrupts Hangul when the Node.js caller
    # decodes stdout as UTF-8 (it turns into '\ufffd' + Cyrillic garbage).
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    paths = [p for p in sys.argv[1:] if os.path.exists(p)]
    if not paths:
        print(json.dumps({"result": []}, ensure_ascii=False))
        return

    import easyocr

    # ko + en; CPU only to avoid GPU dependency issues on mac homebrew builds.
    reader = easyocr.Reader(["ko", "en"], gpu=False, verbose=False)

    result: list = []
    for p in paths:
        try:
            with open(p, "rb") as fh:
                raw = fh.read()
            data = prepare_tiles(raw)
            # OCR each tile at full resolution, then merge (dedupe is left to the
            # overlapping-line tolerance; simple concatenation is good enough).
            all_lines: list = []
            for tile in data:
                try:
                    # paragraph=True groups fragment lines; detail=0 returns plain text lines.
                    tile_lines = reader.readtext(tile, detail=0, paragraph=True)
                    all_lines.extend(str(x) for x in tile_lines if str(x).strip())
                except Exception as tile_exc:
                    all_lines.append(f"[tile OCR error: {tile_exc}]")
            text = "\n".join(all_lines)
        except Exception as exc:  # per-file errors must not kill the whole batch
            text = f"[OCR error: {exc}]"
        result.append(
            {
                "file": os.path.basename(p),
                "text": text,
                "count": len([l for l in text.splitlines() if l.strip()]),
            }
        )

    print(json.dumps({"result": result}, ensure_ascii=False))

if __name__ == "__main__":
    main()
