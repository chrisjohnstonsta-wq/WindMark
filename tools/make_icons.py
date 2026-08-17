#!/usr/bin/env python3
"""Generate WindMark's PNG icons with no third-party dependencies.

A royal-blue disc on black, a white downwind arrow (the direction the wind is
blowing toward), and a red baseline. 4x supersampled. Re-run after changing
anything here:  python3 tools/make_icons.py
"""
import os
import struct
import zlib

BG = (0, 0, 0)
DISC = (27, 78, 155)        # blue
ARROW = (255, 255, 255)     # white
LINE = (211, 32, 39)        # red


def point_in_poly(x, y, poly):
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y):
            xint = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < xint:
                inside = not inside
        j = i
    return inside


def render(size, pad):
    """pad = fraction of the tile kept clear on each side (maskable safe zone)."""
    s = 1.0 - 2 * pad

    def P(u, v):
        return (pad + u * s, pad + v * s)

    # Arrow pointing up = the way the wind is blowing (top of phone).
    arrow = [P(0.50, 0.08), P(0.82, 0.68), P(0.50, 0.54), P(0.18, 0.68)]
    # Red baseline, standing in for the logo's cross.
    bar = [P(0.28, 0.78), P(0.72, 0.78), P(0.72, 0.87), P(0.28, 0.87)]
    # Blue disc filling the safe area, like the logo's ring.
    cx = cy = pad + s / 2.0
    cr = s / 2.0

    ss = 4
    px = bytearray()
    for row in range(size):
        px.append(0)  # PNG filter type 0
        for col in range(size):
            acc = [0.0, 0.0, 0.0]
            for sy in range(ss):
                for sx in range(ss):
                    x = (col + (sx + 0.5) / ss) / size
                    y = (row + (sy + 0.5) / ss) / size
                    if point_in_poly(x, y, arrow):
                        c = ARROW
                    elif point_in_poly(x, y, bar):
                        c = LINE
                    elif (x - cx) ** 2 + (y - cy) ** 2 <= cr * cr:
                        c = DISC
                    else:
                        c = BG
                    acc[0] += c[0]
                    acc[1] += c[1]
                    acc[2] += c[2]
            n = ss * ss
            px.extend((int(acc[0] / n), int(acc[1] / n), int(acc[2] / n)))
    return bytes(px)


def chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data +
            struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, size, pad):
    raw = render(size, pad)
    hdr = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', hdr) +
           chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    print(path, size, len(png), 'bytes')


if __name__ == '__main__':
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(here, 'icons')
    os.makedirs(out, exist_ok=True)
    write_png(os.path.join(out, 'icon-192.png'), 192, 0.10)
    write_png(os.path.join(out, 'icon-512.png'), 512, 0.10)
    write_png(os.path.join(out, 'icon-512-maskable.png'), 512, 0.20)
    write_png(os.path.join(out, 'apple-touch-icon.png'), 180, 0.10)
