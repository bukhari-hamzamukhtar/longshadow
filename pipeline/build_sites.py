"""Build the curated site list and the terrain horizon of every site.

Three accuracy tiers
  lola5    PGDA 5 m/pix site DEM near the site, LOLA 20 m polar DEM beyond,
           LOLA 240 m DEM past 80S.  (Artemis III candidate regions)
  lola20   LOLA 20 m polar DEM, 240 m past 80S.   (other sites south of 80S)
  lola240  LOLA 240 m polar DEM.                  (sites between 60S and 80S)
  sphere   no terrain model, smooth-sphere horizon. (everything else)

For each Artemis III candidate region the site is not taken from a table. The
script searches the region's 5 m DEM for the best-lit spot with a gentle slope
(see find_best_site) and uses that point.

Usage: python build_sites.py <data_raw> <out_public_data>
"""
import json
import os
import sys
import time

import numpy as np
import spiceypy as sp
from scipy import ndimage as ndi

from common import (R_MOON, R_SUN_KM, R_EARTH_KM, Source, disk_fraction, horizon_profile, open_lola,
                    open_site_tif, topo_azel, xy_to_ll, ll_to_xy, heights)

MASTS = [2.0, 10.0]
AZ_N = 1440
FRAME = "MOON_ME_DE440_ME421"
KERNELS = ["naif0012.tls", "pck00011.tpc", "de440s.bsp", "moon_pa_de440_200625.bpc", "moon_de440_250416.tf"]

A3 = "Artemis III candidate regions"
REGIONS = [
    # tile, id, name, in the 2024 short list, note
    ("Site01", "connecting-ridge", "Connecting Ridge", False, "The ridge between Shackleton and de Gerlache. One of the best-lit places on the Moon."),
    ("Site04", "shackleton-rim", "Shackleton Rim", False, "The rim of Shackleton crater, right next to the south pole."),
    ("Site07", "peak-near-shackleton", "Peak near Shackleton", False, "An isolated peak on the far side of Shackleton."),
    ("Site11", "de-gerlache-rim-1", "de Gerlache Rim 1", False, "The rim of de Gerlache crater."),
    ("SL2", "de-gerlache-rim-2", "de Gerlache Rim 2", True, "A second spot on the de Gerlache rim."),
    ("SL3", "connecting-ridge-ext", "Connecting Ridge Extension", False, "The far end of the Connecting Ridge."),
    ("LM7", "faustini-rim-a", "Faustini Rim A", False, "The rim of Faustini crater."),
    ("Haworth", "haworth", "Haworth", True, "High ground next to Haworth crater."),
    ("Site23", "malapert-massif", "Malapert Massif", True, "A 5 km high mountain that always faces Earth."),
    ("Site20v2", "mons-mouton-plateau", "Mons Mouton Plateau", True, "The flat top of Mons Mouton (Leibnitz Beta), a 6 km high mountain."),
    ("Site06", "nobile-rim-1", "Nobile Rim 1", True, "The rim of Nobile crater."),
    ("DM2", "nobile-rim-2", "Nobile Rim 2", True, "A second spot on the Nobile rim."),
    ("DM1", "amundsen-rim", "Amundsen Rim", False, "The rim of Amundsen crater."),
    ("Site42", "de-gerlache-kocher", "de Gerlache-Kocher Massif", False, "A massif between de Gerlache and Kocher craters."),
]

FIXED = [
    # id, name, group, lat, lon, note, source
    ("south-pole", "Lunar South Pole", "Reference points", -89.9999, 0.0, "The pole itself. It sits on the inner wall of Shackleton crater.", "Geometric pole of the ME frame"),
    ("im2-athena", "IM-2 Athena", "Polar landings and impacts", -84.7906, 29.1957, "Intuitive Machines IM-2 lander, March 2025, on Mons Mouton.", "LROC landing site coordinates"),
    ("im1-odysseus", "IM-1 Odysseus", "Polar landings and impacts", -80.13, 1.44, "Intuitive Machines IM-1 lander, February 2024, near Malapert A.", "NASA / LROC landing site coordinates"),
    ("lcross", "LCROSS impact (Cabeus)", "Polar landings and impacts", -84.675, -48.725, "Where LCROSS hit a permanently shadowed crater in 2009 and found water.", "NASA LCROSS impact coordinates"),
    ("chandrayaan-3", "Chandrayaan-3", "Polar landings and impacts", -69.373, 32.319, "ISRO Vikram lander, August 2023 (Shiv Shakti point).", "ISRO landing coordinates"),
    ("apollo-11", "Apollo 11", "Apollo", 0.6742, 23.4731, "Tranquility Base, July 1969.", "LROC NAC coordinates (Wagner et al. 2017)"),
    ("apollo-12", "Apollo 12", "Apollo", -3.0128, -23.4219, "Ocean of Storms, November 1969.", "LROC NAC coordinates (Wagner et al. 2017)"),
    ("apollo-14", "Apollo 14", "Apollo", -3.6459, -17.4719, "Fra Mauro, February 1971.", "LROC NAC coordinates (Wagner et al. 2017)"),
    ("apollo-15", "Apollo 15", "Apollo", 26.1324, 3.6333, "Hadley Rille, July 1971.", "LROC NAC coordinates (Wagner et al. 2017)"),
    ("apollo-16", "Apollo 16", "Apollo", -8.9734, 15.5011, "Descartes Highlands, April 1972.", "LROC NAC coordinates (Wagner et al. 2017)"),
    ("apollo-17", "Apollo 17", "Apollo", 20.1911, 30.7655, "Taurus-Littrow valley, December 1972.", "LROC NAC coordinates (Wagner et al. 2017)"),
    ("blue-ghost-1", "Blue Ghost Mission 1", "Other landings", 18.5623, 61.8103, "Firefly CLPS lander, March 2025, Mare Crisium.", "NASA / LROC landing site coordinates"),
    ("slim", "SLIM", "Other landings", -13.3160, 25.2510, "JAXA precision lander, January 2024, near Shioli crater.", "JAXA landing coordinates"),
    ("change-4", "Chang'e 4", "Other landings", -45.4446, 177.5991, "First far side landing, January 2019, Von Karman crater.", "LROC landing site coordinates"),
    ("change-6", "Chang'e 6", "Other landings", -41.6385, -153.9852, "Far side sample return, June 2024, Apollo basin.", "CNSA landing coordinates"),
]


def spice_vectors(et0, n, step):
    sun = np.empty((n, 3))
    earth = np.empty((n, 3))
    for i in range(n):
        sun[i] = sp.spkpos("SUN", et0 + i * step, FRAME, "LT+S", "MOON")[0]
        earth[i] = sp.spkpos("EARTH", et0 + i * step, FRAME, "LT+S", "MOON")[0]
    return sun, earth


def sun_fraction(sun, lat, lon, h, horizon, strips=16):
    az, el, rng = topo_azel(sun, lat, lon, h)
    return disk_fraction(el, az, np.degrees(np.arcsin(R_SUN_KM / rng)), horizon, n_strips=strips)


def earth_up(earth, lat, lon, h, horizon):
    az, el, _ = topo_azel(earth, lat, lon, h)
    f = az / (360.0 / horizon.shape[0])
    i0 = np.floor(f).astype(int) % horizon.shape[0]
    t = f - np.floor(f)
    hz = horizon[i0] * (1 - t) + horizon[(i0 + 1) % horizon.shape[0]] * t
    return el > hz


def find_best_site(tile, sources, sun, n_cand=240, margin=1500.0, max_slope=12.0):
    """Best-lit gentle spot of a 5 m site DEM.

    1. Work on a 20 m copy of the tile. Keep local high points (topographic
       prominence against a 3 km mean) where the slope stays under max_slope.
    2. For the top candidates compute a coarse horizon (1 deg) and the mean
       visible fraction of the Sun over one year, 2 m above ground.
    3. Refine the winner on a 10 m grid with a finer horizon.
    """
    k = 4
    H = np.asarray(tile.a[::k, ::k], dtype=np.float64)
    s = tile.s * k
    Hf = np.where(np.isnan(H), np.nanmin(H), H)
    prom = Hf - ndi.uniform_filter(Hf, size=int(3000 / s) | 1, mode="nearest")
    gy, gx = np.gradient(Hf, s)
    slope = ndi.maximum_filter(np.degrees(np.arctan(np.hypot(gx, gy))), size=3)
    ok = (prom == ndi.maximum_filter(prom, size=7)) & (slope <= max_slope) & ~np.isnan(H)
    m = int(margin / s)
    ok[:m, :] = ok[-m:, :] = False
    ok[:, :m] = ok[:, -m:] = False
    rr, cc = np.nonzero(ok)
    order = np.argsort(-prom[rr, cc])[:n_cand]
    best = (-1.0, 0.0, 0.0)
    for r, c in zip(rr[order], cc[order]):
        x, y = tile.x0 + c * s, tile.y0 - r * s
        lat, lon = xy_to_ll(x, y)
        hp = horizon_profile(lat, lon, [2.0], sources, az_n=360, base_px=20.0, layers=False)
        f = sun_fraction(sun, lat, lon, hp["h0"] + 2.0, hp["elev"][0], strips=8).mean()
        if f > best[0]:
            best = (f, x, y)
    _, bx, by = best
    ref = (-1.0, bx, by)
    for dx in (-20, -10, 0, 10, 20):
        for dy in (-20, -10, 0, 10, 20):
            x, y = bx + dx, by + dy
            ri, ci = int(round((tile.y0 - y) / s)), int(round((x - tile.x0) / s))
            if slope[ri, ci] > max_slope:
                continue
            lat, lon = xy_to_ll(x, y)
            hp = horizon_profile(lat, lon, [2.0], sources, az_n=720, base_px=5.0, layers=False)
            f = sun_fraction(sun, lat, lon, hp["h0"] + 2.0, hp["elev"][0]).mean()
            if f > ref[0]:
                ref = (f, x, y)
    lat, lon = xy_to_ll(ref[1], ref[2])
    return float(lat), float(lon), len(order)


def longest_run_days(mask, step_h):
    best = cur = 0
    for v in mask:
        cur = cur + 1 if v else 0
        best = max(best, cur)
    return best * step_h / 24.0


def main():
    raw, out = sys.argv[1], sys.argv[2]
    os.makedirs(f"{out}/horizons", exist_ok=True)
    for k in KERNELS:
        sp.furnsh(f"{raw}/kernels/{k}")
    g20 = open_lola(f"{raw}/lola/ldem_80s_20m.img", 30400, 20.0)
    g240 = open_lola(f"{raw}/lola/ldem_60s_240m.img", 7760, 240.0)
    S80 = Source(g20, 9, f"{raw}/cache/ldem80s")
    S60 = Source(g240, 5, f"{raw}/cache/ldem60s")

    # one year for the search (3 h) and for the summary stats (1 h)
    et27 = sp.str2et("2027-01-01T00:00:00")
    sun3, _ = spice_vectors(et27, 2920, 3 * 3600.0)
    sun1, earth1 = spice_vectors(et27, 8760, 3600.0)

    sites = []

    def add_site(sid, name, group, lat, lon, note, source, tier, sources, extra=None):
        t0 = time.time()
        entry = {"id": sid, "name": name, "group": group, "lat": round(lat, 5), "lon": round(((lon + 180) % 360) - 180, 5),
                 "note": note, "source": source, "tier": tier}
        if extra:
            entry.update(extra)
        if sources:
            hp = horizon_profile(lat, lon, MASTS, sources, az_n=AZ_N, base_px=5.0)
            entry["elev_m"] = round(hp["h0"], 1)
            entry["masts"] = MASTS
            entry["az_n"] = AZ_N
            entry["horizon"] = f"horizons/{sid}.bin"
            blob = []
            stats = {}
            for m, mast in enumerate(MASTS):
                blob += [hp["elev"][m], hp["dist_km"][m]] + [hp["layers"][m, b] for b in range(hp["layers"].shape[1])]
                f = sun_fraction(sun1, lat, lon, hp["h0"] + mast, hp["elev"][m])
                up = earth_up(earth1, lat, lon, hp["h0"] + mast, hp["elev"][m])
                stats[str(int(mast))] = {
                    "sun_avg": round(float(f.mean()) * 100, 1),
                    "sun_any": round(float((f > 0).mean()) * 100, 1),
                    "longest_dark_d": round(longest_run_days(f <= 0, 1.0), 1),
                    "longest_lit_d": round(longest_run_days(f > 0, 1.0), 1),
                    "earth_up": round(float(up.mean()) * 100, 1),
                }
            entry["stats2027"] = stats
            np.concatenate(blob).astype("<f4").tofile(f"{out}/horizons/{sid}.bin")
            s2 = stats["2"]
            print(f"{name:28s} {entry['lat']:9.4f} {entry['lon']:9.3f} h={hp['h0']:7.0f}  {tier:7s} "
                  f"sun {s2['sun_avg']:5.1f}%  dark {s2['longest_dark_d']:5.1f} d  earth {s2['earth_up']:5.1f}%  ({time.time() - t0:.1f}s)", flush=True)
        else:
            entry["elev_m"] = None
            print(f"{name:28s} {entry['lat']:9.4f} {entry['lon']:9.3f} sphere", flush=True)
        sites.append(entry)

    tiles = {}
    for tile_name, sid, name, short24, note in REGIONS:
        path = f"{raw}/site5m/{tile_name}.tif"
        if not os.path.exists(path):
            print("missing tile", tile_name)
            continue
        t0 = time.time()
        tile = open_site_tif(path)
        S5 = Source(tile, 5)
        tiles[tile_name] = S5
        lat, lon, ncand = find_best_site(tile, [S5, S80, S60], sun3)
        print(f"  search {tile_name}: {ncand} candidates, {time.time() - t0:.0f}s", flush=True)
        add_site(sid, name, A3, lat, lon, note, f"Best-lit gentle spot found by this project in the PGDA 5 m DEM tile {tile_name}",
                 "lola5", [S5, S80, S60], {"artemis2024": short24, "tile": tile_name})

    for sid, name, group, lat, lon, note, source in FIXED:
        x, y = ll_to_xy(lat, lon) if lat < -55 else (1e12, 1e12)
        srcs, tier = None, "sphere"
        if lat < -55:
            x, y = float(x), float(y)
            in5 = [s for s in tiles.values() if s.inside(np.array([x]), np.array([y]))[0]]
            if S80.inside(np.array([x]), np.array([y]))[0] and lat <= -80.0:
                srcs, tier = in5 + [S80, S60], ("lola5" if in5 else "lola20")
            elif S60.inside(np.array([x]), np.array([y]))[0] and lat <= -60.0:
                srcs, tier = [S60], "lola240"
        add_site(sid, name, group, lat, lon, note, source, tier, srcs)

    json.dump({"bands_km": [0.0, 0.3, 1.5, 6.0, 25.0, 90.0], "layout": "per mast: elev[az_n], dist_km[az_n], layers[6][az_n] (float32, degrees)",
               "sites": sites}, open(f"{out}/sites.json", "w"), indent=1)
    print("wrote", len(sites), "sites")


if __name__ == "__main__":
    main()
