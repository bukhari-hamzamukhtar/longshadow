"""Check the horizon and illumination code against published NASA results.

Reference: Barker et al. (2021), "Improved LOLA elevation maps for south pole
landing sites: Error estimates and their impact on illumination conditions",
Planetary and Space Science 203. Table 2 lists, for seven regions of interest
(RoIs) on the Connecting Ridge (Site 1), the average illumination, the longest
continuous illumination period (LCIP) and the longest continuous shadow period
(LCSP) between 1 Jan 2024 and 1 Jan 2026, at 1 m and 5 m above the surface.

Their rows: (A) average over the RoI, (C) best pixel of the RoI at each hour.
Both are 1st / 99th percentiles over 100 perturbed DEMs. We evaluate one point,
the RoI centroid, on the nominal DEM, so our value should fall between A and C.

Usage: python validate_literature.py <data_raw> <out_json>
"""
import json
import sys

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))

import numpy as np
import spiceypy as sp

from common import R_SUN_KM, Source, disk_fraction, horizon_profile, open_lola, open_site_tif, topo_azel, xy_to_ll

FRAME = "MOON_ME_DE440_ME421"
KERNELS = ["naif0012.tls", "pck00011.tpc", "de440s.bsp", "moon_pa_de440_200625.bpc", "moon_de440_250416.tf"]

# Table 2 of Barker et al. (2021): centroid X, Y (km), then per height: avg-A, avg-C, LCIP-A, LCIP-C, LCSP-A, LCSP-C
ROIS = [
    (-11.5825, -12.4625, {1: (68.03, 85.84, 63.35, 205.38, 16.55, 10.46), 5: (89.26, 91.83, None, None, None, None)}),
    (-11.4875, -12.5575, {1: (70.32, 85.75, 113.80, 205.08, 17.84, 10.71), 5: (88.51, 91.24, None, None, None, None)}),
    (-11.3525, -12.5025, {1: (67.51, 77.31, 117.86, 176.80, 22.23, 15.79), 5: (84.53, 89.78, None, None, None, None)}),
    (-11.2875, -12.1675, {1: (69.61, 86.81, 136.49, 232.50, 13.27, 4.58), 5: (88.12, 91.11, None, None, None, None)}),
    (-11.1025, -11.9425, {1: (70.38, 84.47, 142.17, 193.40, 15.24, 4.96), 5: (85.71, 88.38, None, None, None, None)}),
    (-10.8025, -11.7375, {1: (71.15, 86.74, 81.01, 205.80, 12.74, 4.71), 5: (87.35, 89.05, None, None, None, None)}),
    (-10.2275, -11.5525, {1: (67.36, 83.44, 100.23, 117.71, 14.54, 5.04), 5: (82.79, 84.98, None, None, None, None)}),
]


def longest_days(mask):
    best = cur = 0
    for v in mask:
        cur = cur + 1 if v else 0
        best = max(best, cur)
    return best / 24.0


def main():
    raw, out = sys.argv[1], sys.argv[2]
    for k in KERNELS:
        sp.furnsh(f"{raw}/kernels/{k}")
    S5 = Source(open_site_tif(f"{raw}/site5m/Site01.tif"), 6)
    S80 = Source(open_lola(f"{raw}/lola/ldem_80s_20m.img", 30400, 20.0), 10, f"{raw}/cache/ldem80s")
    S60 = Source(open_lola(f"{raw}/lola/ldem_60s_240m.img", 7760, 240.0), 6, f"{raw}/cache/ldem60s")
    et0 = sp.str2et("2024-01-01T00:00:00")
    n = 731 * 24
    sun = np.array([sp.spkpos("SUN", et0 + i * 3600.0, FRAME, "LT+S", "MOON")[0] for i in range(n)])
    rows = []
    inside = total = 0
    for i, (xk, yk, ref) in enumerate(ROIS):
        lat, lon = xy_to_ll(xk * 1000.0, yk * 1000.0)
        hp = horizon_profile(lat, lon, [1.0, 5.0], [S5, S80, S60])
        row = {"roi": i + 1, "lat": round(float(lat), 4), "lon": round(float(lon) % 360, 3), "elev_m": round(hp["h0"], 1)}
        for m, z in enumerate([1, 5]):
            az, el, rng = topo_azel(sun, lat, lon, hp["h0"] + z)
            f = disk_fraction(el, az, np.degrees(np.arcsin(R_SUN_KM / rng)), hp["elev"][m])
            ours = {"avg": round(float(f.mean()) * 100, 2), "lcip_d": round(longest_days(f > 0), 1), "lcsp_d": round(longest_days(f <= 0), 1)}
            a, c = ref[z][0], ref[z][1]
            ours["barker_avg_A"], ours["barker_avg_C"] = a, c
            ours["within_A_C"] = bool(a - 0.5 <= ours["avg"] <= c + 0.5)
            if z == 1:
                ours["barker_lcip_A"], ours["barker_lcip_C"], ours["barker_lcsp_A"], ours["barker_lcsp_C"] = ref[z][2:]
            inside += ours["within_A_C"]
            total += 1
            row[f"z{z}m"] = ours
        rows.append(row)
        print(f"RoI {i + 1}: 1 m avg {row['z1m']['avg']:5.1f}% (Barker A {ref[1][0]} to C {ref[1][1]})  LCIP {row['z1m']['lcip_d']:5.1f} d (C {ref[1][3]})  "
              f"LCSP {row['z1m']['lcsp_d']:4.1f} d (A {ref[1][4]}, C {ref[1][5]}) | 5 m avg {row['z5m']['avg']:5.1f}% (A {ref[5][0]} to C {ref[5][1]})", flush=True)
    print(f"{inside} of {total} averages fall inside the published A to C range")
    json.dump({"reference": "Barker et al. 2021, Planet. Space Sci. 203, Table 2 (Site 1, 2024-01-01 to 2026-01-01, hourly)",
               "note": "Ours: one point (RoI centroid) on the nominal 5 m DEM. Barker A: RoI average, C: best pixel per hour, both 1st percentile of 100 DEM clones.",
               "inside": inside, "total": total, "rows": rows}, open(out, "w"), indent=1)


if __name__ == "__main__":
    main()
