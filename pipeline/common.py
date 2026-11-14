"""Shared geometry and LOLA helpers for the Longshadow data pipeline.

Frames and conventions
- Body-fixed frame: Moon Mean Earth / Polar Axis (ME), the frame of the LOLA
  gridded products. X through (0N, 0E), Z through the north pole.
- LOLA polar grids: spherical polar stereographic, true scale at the pole,
  centre latitude -90, centre longitude 0, reference radius 1737.4 km.
  x = r sin(lon), y = r cos(lon), r = 2 R tan(colat / 2).
- Heights are metres above the 1737.4 km sphere.
- Azimuth is measured clockwise from local north, elevation from the local
  horizontal plane (perpendicular to the radius vector).
"""
from __future__ import annotations

import os
import numpy as np

R_MOON = 1737400.0  # m, LOLA reference sphere
R_SUN_KM = 695700.0
R_EARTH_KM = 6378.137


# ----------------------------------------------------------------- projection
def ll_to_xy(lat_deg, lon_deg):
    rr = 2.0 * R_MOON * np.tan(np.radians(90.0 + np.asarray(lat_deg, float)) / 2.0)
    lo = np.radians(lon_deg)
    return rr * np.sin(lo), rr * np.cos(lo)


def xy_to_ll(x, y):
    rr = np.hypot(x, y)
    lat = -90.0 + 2.0 * np.degrees(np.arctan(rr / (2.0 * R_MOON)))
    lon = np.degrees(np.arctan2(x, y))
    return lat, lon


def enu_basis(lat_deg, lon_deg):
    """East, north, up unit vectors of a site in the body-fixed frame."""
    la, lo = np.radians(lat_deg), np.radians(lon_deg)
    up = np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])
    east = np.array([-np.sin(lo), np.cos(lo), 0.0])
    north = np.array([-np.sin(la) * np.cos(lo), -np.sin(la) * np.sin(lo), np.cos(la)])
    return east, north, up


def unit_to_xy(px, py, pz):
    """Body-fixed unit vector -> south polar stereographic metres."""
    k = 2.0 * R_MOON / (1.0 - pz)
    return k * py, k * px


# ------------------------------------------------------------------ DEM grids
class Grid:
    """A north-up height grid in south polar stereographic metres.

    x0, y0 are the map coordinates of the centre of pixel (row 0, col 0).
    """

    def __init__(self, data, pixel_m, x0, y0, dn_scale=1.0):
        self.a = data
        self.nr, self.nc = data.shape
        self.s = float(pixel_m)
        self.x0 = float(x0)
        self.y0 = float(y0)
        self.k = dn_scale

    def inside(self, x, y, margin_px=1.0):
        m = margin_px * self.s
        return (x > self.x0 + m) & (x < self.x0 + (self.nc - 1) * self.s - m) & \
               (y < self.y0 - m) & (y > self.y0 - (self.nr - 1) * self.s + m)

    def nearest(self, x, y):
        col = np.clip(np.rint((x - self.x0) / self.s).astype(np.int64), 0, self.nc - 1)
        row = np.clip(np.rint((self.y0 - y) / self.s).astype(np.int64), 0, self.nr - 1)
        return self.a[row, col].astype(np.float64) * self.k

    def bilinear(self, x, y):
        fc = (x - self.x0) / self.s
        fr = (self.y0 - y) / self.s
        c0 = np.clip(np.floor(fc).astype(np.int64), 0, self.nc - 2)
        r0 = np.clip(np.floor(fr).astype(np.int64), 0, self.nr - 2)
        tx = np.clip(fc - c0, 0.0, 1.0)
        ty = np.clip(fr - r0, 0.0, 1.0)
        a = self.a
        h00 = a[r0, c0].astype(np.float64)
        h01 = a[r0, c0 + 1].astype(np.float64)
        h10 = a[r0 + 1, c0].astype(np.float64)
        h11 = a[r0 + 1, c0 + 1].astype(np.float64)
        return ((h00 * (1 - tx) + h01 * tx) * (1 - ty) + (h10 * (1 - tx) + h11 * tx) * ty) * self.k

    def pooled(self, data):
        """Grid for a 2x2 pooled copy of this grid."""
        return Grid(data, self.s * 2, self.x0 + self.s / 2, self.y0 - self.s / 2, self.k)


def open_lola(path, n, pixel_m):
    """Open a LOLA polar LDEM .IMG (int16, DN * 0.5 m)."""
    a = np.memmap(path, dtype="<i2", mode="r", shape=(n, n))
    c = (n - 1) / 2.0
    return Grid(a, pixel_m, -c * pixel_m, c * pixel_m, 0.5)


def open_site_tif(path):
    """Open a PGDA 5 m/pix site DEM GeoTIFF (float32 metres, polar stereographic)."""
    import tifffile

    with tifffile.TiffFile(path) as tif:
        page = tif.pages[0]
        arr = page.asarray()
        sx, sy, _ = page.tags["ModelPixelScaleTag"].value
        tp = page.tags["ModelTiepointTag"].value
    arr = np.where(np.isfinite(arr) & (arr > -1e5), arr, np.nan).astype(np.float32)
    return Grid(arr, sx, tp[3] + sx / 2.0, tp[4] - sy / 2.0, 1.0)


def pool2(a, mode):
    """2x2 max or mean pooling (odd edges are cropped)."""
    n = (a.shape[0] // 2) * 2
    m = (a.shape[1] // 2) * 2
    out = np.empty((n // 2, m // 2), dtype=a.dtype if mode == "max" else np.float32)
    step = 2048
    for r in range(0, n, step):
        blk = np.asarray(a[r:min(r + step, n), :m])
        b = blk.reshape(blk.shape[0] // 2, 2, m // 2, 2)
        if mode == "max":
            out[r // 2:(r + blk.shape[0]) // 2] = np.nanmax(b, axis=(1, 3)) if b.dtype.kind == "f" else b.max(axis=(1, 3))
        else:
            out[r // 2:(r + blk.shape[0]) // 2] = b.mean(axis=(1, 3), dtype=np.float64)
    return out


class Source:
    """A DEM plus a max-pooled pyramid. levels[0] is the true surface.

    Coarse levels hold the highest point of every cell, so a far ray that
    samples one cell cannot miss a peak inside it.
    """

    def __init__(self, base, levels, cache=None):
        self.levels = [base]
        cur = base
        for _ in range(levels):
            f = None if cache is None else f"{cache}_{int(cur.s * 2)}m.npy"
            if f and os.path.exists(f):
                nxt = np.load(f, mmap_mode="r")
            else:
                import warnings
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    nxt = pool2(cur.a, "max")
                if f:
                    os.makedirs(os.path.dirname(f), exist_ok=True)
                    np.save(f, nxt)
                    nxt = np.load(f, mmap_mode="r")
            cur = cur.pooled(nxt)
            self.levels.append(cur)

    def inside(self, x, y):
        return self.levels[0].inside(x, y)

    def sample(self, s_req, x, y):
        base = self.levels[0]
        if s_req <= base.s:
            return base.bilinear(x, y)
        for g in self.levels[1:]:
            if g.s >= s_req:
                return g.nearest(x, y)
        return self.levels[-1].nearest(x, y)


def heights(sources, s_req, x, y):
    """Height from the first source that covers each point (NaN if none)."""
    h = np.full(x.shape, np.nan)
    for src in sources:
        m = np.isnan(h) & src.inside(x, y)
        if m.any():
            h[m] = src.sample(s_req, x[m], y[m])
    return h


# ------------------------------------------------------------ horizon profile
BANDS_KM = [0.0, 0.3, 1.5, 6.0, 25.0, 90.0, 1e9]


def horizon_profile(lat, lon, masts, sources, az_n=1440, d_max=500e3, base_px=5.0, layers=True):
    """Terrain horizon seen from a site, for one or more heights above ground.

    Rays leave the site along great circles. The sample spacing grows with
    distance so that the DEM cell size always matches the gap between
    neighbouring rays. Elevation uses exact spherical geometry.

    Returns dict(h0, elev[M, A], dist_km[M, A], layers[M, B, A]).
    """
    east, north, up = enu_basis(lat, lon)
    az = np.arange(az_n) * (2.0 * np.pi / az_n)
    dirs = np.cos(az)[:, None] * north[None, :] + np.sin(az)[:, None] * east[None, :]
    sx, sy = ll_to_xy(lat, lon)
    h0 = float(heights(sources, 0.0, np.array([sx]), np.array([sy]))[0])
    if not np.isfinite(h0):
        raise ValueError("site is outside the terrain coverage")
    masts = np.asarray(masts, float)
    M = len(masts)
    ro = R_MOON + h0 + masts
    elev = np.full((M, az_n), -90.0)
    dist = np.zeros((M, az_n))
    nb = len(BANDS_KM) - 1
    lay = np.full((M, nb, az_n), -90.0)
    daz = 2.0 * np.pi / az_n
    s, d_lo, first = float(base_px), base_px / 2.0, True
    while d_lo < d_max:
        d_hi = min(s / daz, d_max)
        d = np.arange(d_lo, d_hi, s / 2.0 if first else s)
        th = d / R_MOON
        ct, st = np.cos(th), np.sin(th)
        px = up[0] * ct[None, :] + dirs[:, 0:1] * st[None, :]
        py = up[1] * ct[None, :] + dirs[:, 1:2] * st[None, :]
        pz = up[2] * ct[None, :] + dirs[:, 2:3] * st[None, :]
        x, y = unit_to_xy(px, py, pz)
        h = heights(sources, s, x, y)
        rad = R_MOON + h
        dkm = d / 1000.0
        for m in range(M):
            el = np.degrees(np.arctan2(rad * ct[None, :] - ro[m], rad * st[None, :]))
            el = np.where(np.isnan(el), -90.0, el)
            j = el.argmax(axis=1)
            best = el[np.arange(az_n), j]
            upd = best > elev[m]
            elev[m, upd] = best[upd]
            dist[m, upd] = dkm[j[upd]]
            if layers:
                for b in range(nb):
                    sel = (dkm >= BANDS_KM[b]) & (dkm < BANDS_KM[b + 1])
                    if sel.any():
                        lay[m, b] = np.maximum(lay[m, b], el[:, sel].max(axis=1))
        d_lo, s, first = d_hi, s * 2.0, False
    return {"h0": h0, "elev": elev, "dist_km": dist, "layers": lay}


# ------------------------------------------------------------------- sky math
def topo_azel(vec_km, lat, lon, h_m):
    """Azimuth / elevation (deg) and distance (km) of Moon-centred ME vectors
    seen from a surface site. vec_km has shape (N, 3)."""
    east, north, up = enu_basis(lat, lon)
    site = up * (R_MOON + h_m) / 1000.0
    t = np.asarray(vec_km, float) - site[None, :]
    rng = np.linalg.norm(t, axis=1)
    e, n, u = t @ east, t @ north, t @ up
    el = np.degrees(np.arcsin(u / rng))
    az = np.degrees(np.arctan2(e, n)) % 360.0
    return az, el, rng


def disk_fraction(el_c, az_c, radius, horizon_elev, limb_u=0.0, n_strips=32):
    """Visible fraction of a disk (Sun or Earth) above a terrain horizon.

    The disk is cut into vertical strips and each strip is clipped by the
    horizon at its own azimuth. With limb_u > 0 the result is the visible
    fraction of the flux for linear limb darkening I(mu) = 1 - u (1 - mu).
    All angles in degrees. el_c, az_c, radius broadcast over time.
    """
    A = horizon_elev.shape[-1]
    step = 360.0 / A
    el_c = np.asarray(el_c, float)[..., None]
    az_c = np.asarray(az_c, float)[..., None]
    r = np.asarray(radius, float)[..., None]
    u = (np.arange(n_strips) + 0.5) / n_strips * 2.0 - 1.0
    c = np.sqrt(1.0 - u * u)  # half chord in disk radii
    cosel = np.maximum(np.cos(np.radians(el_c)), 1e-6)
    f = ((az_c + (u * r) / cosel) % 360.0) / step
    i0 = np.floor(f).astype(np.int64) % A
    t = f - np.floor(f)
    hz = horizon_elev[i0] * (1 - t) + horizon_elev[(i0 + 1) % A] * t
    yb = np.clip((hz - el_c) / r, -c, c)  # lower limit of the visible part, disk radii

    def prim(yv):  # integral of intensity along the strip from -c to yv
        base = yv + c
        if limb_u == 0.0:
            return base
        s = np.sqrt(np.maximum(c * c - yv * yv, 0.0))
        seg = 0.5 * (yv * s + c * c * np.arcsin(np.clip(yv / c, -1.0, 1.0))) + 0.25 * np.pi * c * c
        return (1.0 - limb_u) * base + limb_u * seg

    tot = prim(c)
    vis = tot - prim(yb)
    return vis.sum(axis=-1) / tot.sum(axis=-1)
