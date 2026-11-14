"""Build the terrain and texture assets the web app draws.

  terrain/cap240.demz    LOLA 240 m DEM, 80S to the pole (whole cap)
  terrain/core60.demz    LOLA 20 m DEM averaged to 60 m, 88S to the pole
  terrain/patch_<id>.demz  LOLA 20 m DEM, 20.5 km square around each polar site
  terrain/index.json       grid geometry of every file
  tex/moon_color.jpg       LROC WAC colour mosaic with LOLA-filled poles (NASA SVS CGI Moon Kit)
  tex/moon_normal.jpg      normal map from the LOLA 16 px/deg displacement map
  tex/earth.jpg            Blue Marble Next Generation (NASA Earth Observatory)

Height files: int16 little endian, 0.5 m per count, each row delta coded,
then gzip. The app undoes this with DecompressionStream and a running sum.

Usage: python build_terrain.py <data_raw> <out_public_data>
"""
import gzip
import json
import os
import sys

import numpy as np
from PIL import Image

from common import ll_to_xy, open_lola, R_MOON

Image.MAX_IMAGE_PIXELS = None


def pack(arr_i16, path):
    a = np.ascontiguousarray(arr_i16.astype("<i2"))
    d = a.copy()
    d[:, 1:] = a[:, 1:] - a[:, :-1]  # int16 wraparound is fine, the app adds it back the same way
    with gzip.open(path, "wb", compresslevel=9) as f:
        f.write(d.tobytes())
    return os.path.getsize(path)


def mean_pool(a, k):
    n = (a.shape[0] // k) * k
    out = np.empty((n // k, n // k), dtype=np.float32)
    rows = 1200 // k * k
    for r in range(0, n, rows):
        blk = np.asarray(a[r:r + rows, :n], dtype=np.float32)
        out[r // k:(r + blk.shape[0]) // k] = blk.reshape(blk.shape[0] // k, k, n // k, k).mean(axis=(1, 3))
    return out


def main():
    raw, out = sys.argv[1], sys.argv[2]
    os.makedirs(f"{out}/terrain", exist_ok=True)
    os.makedirs(f"{out}/tex", exist_ok=True)
    g20 = open_lola(f"{raw}/lola/ldem_80s_20m.img", 30400, 20.0)
    g240 = open_lola(f"{raw}/lola/ldem_60s_240m.img", 7760, 240.0)
    index = {"unit_m": 0.5, "levels": {}, "patches": {}}

    # whole cap at 240 m: crop of the 60S product
    half = int(np.ceil(304000.0 / 240.0))  # 80S is 304 km from the pole
    c = 7760 // 2
    cap = np.asarray(g240.a[c - half:c + half, c - half:c + half])
    size = pack(cap, f"{out}/terrain/cap240.demz")
    index["levels"]["cap"] = {"file": "terrain/cap240.demz", "n": int(cap.shape[0]), "pixel_m": 240.0,
                              "x0_m": -(half - 0.5) * 240.0, "y0_m": (half - 0.5) * 240.0}
    print("cap240", cap.shape, size // 1024, "KB")

    # inner core at 60 m (88S to the pole), mean of the 20 m DEM
    r88 = 2 * R_MOON * np.tan(np.radians(2.0) / 2)  # 60.66 km
    hp = int(np.ceil(r88 / 60.0)) * 3  # half width in 20 m pixels, multiple of 3
    c20 = 30400 // 2
    core = mean_pool(g20.a[c20 - hp:c20 + hp, c20 - hp:c20 + hp], 3)
    core_i = np.rint(core).astype(np.int16)
    size = pack(core_i, f"{out}/terrain/core60.demz")
    index["levels"]["core"] = {"file": "terrain/core60.demz", "n": int(core_i.shape[0]), "pixel_m": 60.0,
                               "x0_m": -(hp / 3 - 0.5) * 60.0, "y0_m": (hp / 3 - 0.5) * 60.0}
    print("core60", core_i.shape, size // 1024, "KB")

    # 20 m patches around the polar sites
    sites = json.load(open(f"{out}/sites.json"))["sites"]
    N = 1024
    total = 0
    for s in sites:
        if s["tier"] not in ("lola5", "lola20"):
            continue
        x, y = ll_to_xy(s["lat"], s["lon"])
        col = int(round(g20.nc / 2 - 0.5 + x / 20.0))
        row = int(round(g20.nr / 2 - 0.5 - y / 20.0))
        r0 = min(max(row - N // 2, 0), g20.nr - N)
        c0 = min(max(col - N // 2, 0), g20.nc - N)
        patch = np.asarray(g20.a[r0:r0 + N, c0:c0 + N])
        size = pack(patch, f"{out}/terrain/patch_{s["id"]}.demz")
        total += size
        index["patches"][s["id"]] = {"file": f"terrain/patch_{s["id"]}.demz", "n": N, "pixel_m": 20.0,
                                     "x0_m": g20.x0 + c0 * 20.0, "y0_m": g20.y0 - r0 * 20.0}
    print("patches", len(index["patches"]), total // 1024, "KB")
    json.dump(index, open(f"{out}/terrain/index.json", "w"), indent=1)

    # textures
    tex = f"{raw}/tex"
    if os.path.exists(f"{tex}/lroc_color_poles_4k.tif"):
        im = Image.open(f"{tex}/lroc_color_poles_4k.tif").convert("RGB")
        im.save(f"{out}/tex/moon_color.jpg", quality=88, optimize=True)
        print("moon_color", im.size, os.path.getsize(f"{out}/tex/moon_color.jpg") // 1024, "KB")
    if os.path.exists(f"{tex}/ldem_16_uint.tif"):
        d = np.asarray(Image.open(f"{tex}/ldem_16_uint.tif"), dtype=np.float32) * 0.5 / 1000.0  # half metres -> km
        h, w = d.shape
        lat = np.radians(90.0 - (np.arange(h) + 0.5) * 180.0 / h)[:, None]
        px_km = 2 * np.pi * 1737.4 / w
        dx = (np.roll(d, -1, axis=1) - np.roll(d, 1, axis=1)) / (2 * px_km * np.maximum(np.cos(lat), 0.05))
        dy = np.zeros_like(d)
        dy[1:-1] = (d[:-2] - d[2:]) / (2 * px_km)  # north is up
        k = 1.0  # true slopes
        nx, ny, nz = -dx * k, -dy * k, np.ones_like(d)
        ln = np.sqrt(nx * nx + ny * ny + nz * nz)
        rgb = np.stack([nx / ln, ny / ln, nz / ln], axis=-1) * 0.5 + 0.5
        im = Image.fromarray((rgb * 255).clip(0, 255).astype(np.uint8)).resize((4096, 2048), Image.LANCZOS)
        im.save(f"{out}/tex/moon_normal.jpg", quality=90, optimize=True)
        print("moon_normal", im.size, os.path.getsize(f"{out}/tex/moon_normal.jpg") // 1024, "KB")
    if os.path.exists(f"{tex}/earth_5400.jpg"):
        im = Image.open(f"{tex}/earth_5400.jpg").convert("RGB").resize((2048, 1024), Image.LANCZOS)
        im.save(f"{out}/tex/earth.jpg", quality=86, optimize=True)
        print("earth", im.size, os.path.getsize(f"{out}/tex/earth.jpg") // 1024, "KB")


if __name__ == "__main__":
    main()
