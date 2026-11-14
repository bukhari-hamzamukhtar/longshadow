"""Build the Sun / Earth ephemeris table used by the web app.

For every grid time we store, in the Moon ME frame (the LOLA frame):
  - apparent Sun position seen from the Moon's centre   (km, LT+S)
  - apparent Earth position seen from the Moon's centre (km, LT+S)
  - the J2000 -> ME rotation as a quaternion (scalar first)
Source: JPL DE440 + the DE440 lunar orientation (MOON_PA_DE440 rotated to
MOON_ME_DE440_ME421), evaluated with NAIF SPICE.

The app interpolates this table with a 4-point cubic. The script measures
the interpolation error against direct SPICE calls and prints it.

Usage: python build_ephemeris.py <kernel_dir> <out_dir> [start_year] [end_year] [step_hours]
"""
import json
import sys
import time

import numpy as np
import spiceypy as sp

KERNELS = ["naif0012.tls", "pck00011.tpc", "de440s.bsp", "moon_pa_de440_200625.bpc", "moon_de440_250416.tf"]
FRAME = "MOON_ME_DE440_ME421"


def sample(et):
    sun, _ = sp.spkpos("SUN", et, FRAME, "LT+S", "MOON")
    earth, _ = sp.spkpos("EARTH", et, FRAME, "LT+S", "MOON")
    q = sp.m2q(sp.pxform("J2000", FRAME, et))
    return np.concatenate([sun, earth, q])


def cubic(tab, f):
    """4-point Lagrange interpolation at fractional index f."""
    i = int(np.floor(f))
    t = f - i
    p0, p1, p2, p3 = tab[i - 1], tab[i], tab[i + 1], tab[i + 2]
    w0 = -t * (t - 1) * (t - 2) / 6
    w1 = (t + 1) * (t - 1) * (t - 2) / 2
    w2 = -(t + 1) * t * (t - 2) / 2
    w3 = (t + 1) * t * (t - 1) / 6
    return w0 * p0 + w1 * p1 + w2 * p2 + w3 * p3


def ang(a, b):
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    return np.degrees(np.arctan2(np.linalg.norm(np.cross(a, b)), np.dot(a, b))) * 3600.0


def main():
    kdir, out = sys.argv[1], sys.argv[2]
    y0 = int(sys.argv[3]) if len(sys.argv) > 3 else 2020
    y1 = int(sys.argv[4]) if len(sys.argv) > 4 else 2046
    step_h = float(sys.argv[5]) if len(sys.argv) > 5 else 4.0
    for k in KERNELS:
        sp.furnsh(f"{kdir}/{k}")
    step = step_h * 3600.0
    et0 = sp.str2et(f"{y0}-01-01T00:00:00")
    et1 = sp.str2et(f"{y1}-01-01T00:00:00")
    n = int(round((et1 - et0) / step)) + 1
    unix0 = int((np.datetime64(f"{y0}-01-01T00:00:00") - np.datetime64("1970-01-01T00:00:00")) / np.timedelta64(1, "s"))
    t_start = time.time()
    tab = np.empty((n, 10), dtype=np.float64)
    for i in range(n):
        tab[i] = sample(et0 + i * step)
        if i and np.dot(tab[i, 6:], tab[i - 1, 6:]) < 0:  # keep quaternion sign continuous
            tab[i, 6:] *= -1
    print(f"sampled {n} epochs in {time.time() - t_start:.1f}s")

    tab32 = tab.astype(np.float32)
    # interpolation error of the float32 table against direct SPICE
    rng = np.random.default_rng(7)
    worst = {"sun_arcsec": 0.0, "earth_arcsec": 0.0, "earth_km": 0.0, "rot_arcsec": 0.0}
    t64 = tab32.astype(np.float64)
    for f in rng.uniform(2, n - 3, 4000):
        truth = sample(et0 + f * step)
        v = cubic(t64, f)
        worst["sun_arcsec"] = max(worst["sun_arcsec"], ang(v[0:3], truth[0:3]))
        worst["earth_arcsec"] = max(worst["earth_arcsec"], ang(v[3:6], truth[3:6]))
        worst["earth_km"] = max(worst["earth_km"], float(np.linalg.norm(v[3:6] - truth[3:6])))
        q = v[6:] / np.linalg.norm(v[6:])
        qt = truth[6:] if np.dot(q, truth[6:]) > 0 else -truth[6:]
        worst["rot_arcsec"] = max(worst["rot_arcsec"], 2 * np.degrees(np.arccos(min(1.0, abs(np.dot(q, qt))))) * 3600)
    print("max interpolation error:", {k: round(v, 5) for k, v in worst.items()})

    tab32.tofile(f"{out}/ephem.bin")
    meta = {
        "t0": unix0,
        "step": step,
        "n": n,
        "columns": ["sun_x", "sun_y", "sun_z", "earth_x", "earth_y", "earth_z", "q0", "q1", "q2", "q3"],
        "units": "km, Moon-centred, apparent (LT+S); quaternion rotates J2000 to ME (scalar first)",
        "frame": FRAME,
        "kernels": KERNELS,
        "toolkit": sp.tkvrsn("TOOLKIT"),
        "interp_error": worst,
        "range_utc": [f"{y0}-01-01", f"{y1}-01-01"],
    }
    json.dump(meta, open(f"{out}/ephem.json", "w"), indent=1)
    print("wrote", f"{out}/ephem.bin", tab32.nbytes, "bytes")


if __name__ == "__main__":
    main()
