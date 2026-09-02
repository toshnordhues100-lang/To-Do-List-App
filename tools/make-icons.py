#!/usr/bin/env python3
"""Generate the PNG app icons (no external dependencies).

Draws a dark rounded square with a white check mark, matching icons/icon.svg.
Run: python3 tools/make-icons.py
"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"
BG = (0x15, 0x18, 0x1D)
FG = (0xFF, 0xFF, 0xFF)
SS = 3  # supersampling factor for anti-aliasing


def seg_dist(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    t = max(0.0, min(1.0, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
    dx, dy = px - (ax + t * vx), py - (ay + t * vy)
    return math.hypot(dx, dy)


def inside_rounded_rect(x, y, size, radius):
    if x < 0 or y < 0 or x >= size or y >= size:
        return False
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    return math.hypot(x - cx, y - cy) <= radius


def render(size, maskable=False):
    # Geometry in 512 units, scaled to `size`.
    s = size / 512.0
    radius = (0 if maskable else 112) * s
    # Maskable icons keep content in the inner 80% safe zone.
    shrink = 0.8 if maskable else 1.0
    cx = size / 2.0

    def pt(x, y):
        return cx + (x - 256) * s * shrink, cx + (y - 256) * s * shrink

    a = pt(150, 268)
    b = pt(220, 338)
    c = pt(362, 188)
    stroke = 20 * s * shrink  # half of 40
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            cover_bg = 0
            cover_fg = 0
            for sy in range(SS):
                for sx in range(SS):
                    px = x + (sx + 0.5) / SS
                    py = y + (sy + 0.5) / SS
                    if inside_rounded_rect(px, py, size, radius):
                        cover_bg += 1
                        d = min(seg_dist(px, py, *a, *b), seg_dist(px, py, *b, *c))
                        if d <= stroke:
                            cover_fg += 1
            n = SS * SS
            alpha = cover_bg / n
            if cover_bg == 0:
                row += bytes([0, 0, 0, 0])
                continue
            f = cover_fg / cover_bg
            r = int(BG[0] * (1 - f) + FG[0] * f)
            g = int(BG[1] * (1 - f) + FG[1] * f)
            bl = int(BG[2] * (1 - f) + FG[2] * f)
            row += bytes([r, g, bl, int(255 * alpha)])
        rows.append(bytes(row))
    return b"".join(rows)


def png(size, data):
    def chunk(tag, body):
        c = struct.pack(">I", len(body)) + tag + body
        return c + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(data, 9)) + chunk(b"IEND", b"")


def main():
    OUT.mkdir(exist_ok=True)
    for name, size, maskable in [
        ("icon-192.png", 192, False),
        ("icon-180.png", 180, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
    ]:
        (OUT / name).write_bytes(png(size, render(size, maskable)))
        print("wrote", OUT / name)


if __name__ == "__main__":
    main()
