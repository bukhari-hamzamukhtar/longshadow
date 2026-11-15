"""Compare the app's Sun and Earth angles with the JPL Horizons System.

For a set of sites and one year of epochs this script asks Horizons for the
apparent, airless azimuth and elevation of the Sun and Earth seen from the
site on the Moon, and compares them with what the web app computes: the
shipped ephemeris table (public/data/ephem.bin), the same 4-point cubic
interpolation, and the same local east/north/up frame.

Usage: python validate_horizons.py <public_data_dir> <out_json>
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))

import numpy as np

from common import topo_azel

API = "https://ssd.jpl.nasa.gov/api/horizons.api"
SITES = ["connecting-ridge", "shackleton-rim", "malapert-massif", "im2-athena", "chandrayaan-3", "apollo-11", "apollo-15", "change-4"]
START, STOP, STEP = "2026-11-15", "2027-11-15", "2 d"


def horizons(target, lon, lat, alt_km):
    q = {
        "format": "text", "COMMAND": f"'{target}'", "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'", "EPHEM_TYPE": "'OBSERVER'",
        "CENTER": "'coord@301'", "COORD_TYPE": "'GEODETIC'", "SITE_COORD": f"'{lon:.6f},{lat:.6f},{alt_km:.5f}'",
        "START_TIME": f"'{START}'", "STOP_TIME": f"'{STOP}'", "STEP_SIZE": f"'{STEP}'", "QUANTITIES": "'4'",
        "CSV_FORMAT": "'YES'", "ANG_FORMAT": "'DEG'", "APPARENT": "'AIRLESS'", "TIME_DIGITS": "'MINUTES'",
    }
    url = API + "?" + urllib.parse.urlencode(q)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "horizon-check"}), timeout=60) as r:
                txt = r.read().decode("utf8", "replace")
            if "$$SOE" in txt:
                break
        except Exception:  # noqa: BLE001
            txt = ""
        time.sleep(2 + attempt * 2)
    if "$$SOE" not in txt:
        raise RuntimeError("Horizons gave no table:\n" + txt[-800:])
    head = txt[:txt.index("$$SOE")]
    rows = []
    for line in txt[txt.index("$$SOE") + 5:txt.index("$$EOE")].strip().splitlines():
        f = [c.strip() for c in line.split(",")]
        t = datetime.strptime(f[0], "%Y-%b-%d %H:%M").replace(tzinfo=timezone.utc).timestamp()
        nums = [float(c) for c in f[1:] if c.replace(".", "", 1).replace("-", "", 1).isdigit()]
        rows.append((t, nums[0], nums[1]))
    frame = [ln.strip() for ln in head.splitlines() if "Center pole/equ" in ln or "Center radii" in ln or "Center geodetic" in ln]
    return np.array(rows), frame


class Table:
    def __init__(self, d):
        m = json.load(open(f"{d}/ephem.json"))
        self.t0, self.step = m["t0"], m["step"]
        self.tab = np.fromfile(f"{d}/ephem.bin", dtype="<f4").reshape(-1, 10).astype(np.float64)

    def at(self, t_unix):
        """Same 4-point cubic as src/lib/ephem.ts."""
        f = (np.asarray(t_unix) - self.t0) / self.step
        i = np.floor(f).astype(int)
        t = (f - i)[:, None]
        w0 = -t * (t - 1) * (t - 2) / 6
        w1 = (t + 1) * (t - 1) * (t - 2) / 2
        w2 = -(t + 1) * t * (t - 2) / 2
        w3 = (t + 1) * t * (t - 1) / 6
        v = w0 * self.tab[i - 1] + w1 * self.tab[i] + w2 * self.tab[i + 1] + w3 * self.tab[i + 2]
        return v[:, 0:3], v[:, 3:6]


def main():
    d, out = sys.argv[1], sys.argv[2]
    sites = {s["id"]: s for s in json.load(open(f"{d}/sites.json"))["sites"]}
    tab = Table(d)
    res = {"source": "JPL Horizons System API (ssd.jpl.nasa.gov), observer table, apparent airless azimuth and elevation",
           "span": [START, STOP, STEP], "sites": [], "frame_lines": None}
    worst = 0.0
    for sid in SITES:
        s = sites[sid]
        alt = (s["elev_m"] or 0.0) / 1000.0
        entry = {"id": sid, "name": s["name"], "lat": s["lat"], "lon": s["lon"], "alt_km": round(alt, 4)}
        for body, cmd, k in (("sun", "10", 0), ("earth", "399", 1)):
            rows, frame = horizons(cmd, s["lon"], s["lat"], alt)
            res["frame_lines"] = res["frame_lines"] or frame
            vec = tab.at(rows[:, 0])[k]
            az, el, _ = topo_azel(vec, s["lat"], s["lon"], alt * 1000.0)
            d_el = (el - rows[:, 2]) * 3600.0
            d_az = ((az - rows[:, 1] + 180.0) % 360.0 - 180.0) * np.cos(np.radians(rows[:, 2])) * 3600.0
            tot = np.hypot(d_el, d_az)
            entry[body] = {"n": int(len(rows)), "max_arcsec": round(float(tot.max()), 3), "rms_arcsec": round(float(np.sqrt((tot ** 2).mean())), 3),
                           "max_el_arcsec": round(float(np.abs(d_el).max()), 3), "max_az_arcsec": round(float(np.abs(d_az).max()), 3)}
            worst = max(worst, float(tot.max()))
            # a few raw Horizons rows, used by the browser engine's unit tests
            pick = np.linspace(0, len(rows) - 1, 6).astype(int)
            entry[body]["samples"] = [[int(rows[j, 0]), float(rows[j, 1]), float(rows[j, 2])] for j in pick]
            time.sleep(0.6)
        print(f"{s['name']:22s} Sun max {entry['sun']['max_arcsec']:7.3f}\" rms {entry['sun']['rms_arcsec']:6.3f}\"   "
              f"Earth max {entry['earth']['max_arcsec']:7.3f}\" rms {entry['earth']['rms_arcsec']:6.3f}\"  (n={entry['sun']['n']})", flush=True)
        res["sites"].append(entry)
    res["worst_arcsec"] = round(worst, 3)
    res["checked_utc"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    print("worst difference:", res["worst_arcsec"], "arcsec;", res["frame_lines"])
    json.dump(res, open(out, "w"), indent=1)


if __name__ == "__main__":
    main()
