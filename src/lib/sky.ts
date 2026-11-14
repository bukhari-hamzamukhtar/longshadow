// Geometry of one landing site: where the Sun and Earth are in its sky and
// how much of each disk clears the terrain horizon.
import { AU_KM, R_EARTH_KM, R_MOON_KM, R_SUN_KM, SOLAR_CONSTANT, Sky, newSky, skyAt } from "./ephem";

const DEG = Math.PI / 180;
export const SUN_LIMB_U = 0.6; // linear limb darkening near 550 nm

export type Tier = "lola5" | "lola20" | "lola240" | "sphere" | "custom";

/** Terrain horizon seen from one height above the ground. */
export interface Profile {
  azN: number;
  elev: Float32Array; // deg, per azimuth bin (bin i is centred on i * 360 / azN)
  dist: Float32Array; // km to the terrain that makes the horizon
  layers: Float32Array[]; // horizon per distance band, near to far
  min: number;
  max: number;
}

export interface Site {
  id: string;
  name: string;
  group: string;
  lat: number;
  lon: number;
  note: string;
  source: string;
  tier: Tier;
  elev_m: number | null;
  masts: number[];
  profiles: Profile[] | null; // one per mast height, null = smooth sphere
  artemis2024?: boolean;
  tile?: string;
  custom?: boolean;
  horizonUrl?: string;
  stats2027?: Record<string, Record<string, number>>;
}

export interface SiteGeom {
  lat: number;
  lon: number;
  h: number; // metres above the 1737.4 km sphere, mast included
  pos: Float64Array; // km
  e: Float64Array;
  n: Float64Array;
  u: Float64Array;
  dip: number; // deg, smooth-sphere horizon for this height above ground
}

export function makeGeom(lat: number, lon: number, groundM: number, mastM: number): SiteGeom {
  const la = lat * DEG, lo = lon * DEG;
  const u = new Float64Array([Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]);
  const e = new Float64Array([-Math.sin(lo), Math.cos(lo), 0]);
  const n = new Float64Array([-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)]);
  const r = R_MOON_KM + (groundM + mastM) / 1000;
  const pos = new Float64Array([u[0] * r, u[1] * r, u[2] * r]);
  const dip = -Math.acos(R_MOON_KM / (R_MOON_KM + mastM / 1000)) / DEG;
  return { lat, lon, h: groundM + mastM, pos, e, n, u, dip };
}

export function siteGeom(site: Site, mastIdx: number): SiteGeom {
  return makeGeom(site.lat, site.lon, site.elev_m ?? 0, site.masts[mastIdx] ?? 2);
}

export interface AzEl {
  az: number;
  el: number;
  range: number;
}

/** Azimuth (clockwise from north) and elevation of a Moon-centred ME vector, in degrees. */
export function azel(g: SiteGeom, v: ArrayLike<number>, out: AzEl): AzEl {
  const x = v[0] - g.pos[0], y = v[1] - g.pos[1], z = v[2] - g.pos[2];
  const rng = Math.sqrt(x * x + y * y + z * z);
  const ee = x * g.e[0] + y * g.e[1] + z * g.e[2];
  const nn = x * g.n[0] + y * g.n[1] + z * g.n[2];
  const uu = x * g.u[0] + y * g.u[1] + z * g.u[2];
  out.el = Math.asin(uu / rng) / DEG;
  let az = Math.atan2(ee, nn) / DEG;
  if (az < 0) az += 360;
  out.az = az;
  out.range = rng;
  return out;
}

/** Terrain horizon elevation at an azimuth (linear between bins). */
export function horizonAt(p: Profile | null, dip: number, azDeg: number): number {
  if (!p) return dip;
  let f = (azDeg / 360) * p.azN;
  f -= Math.floor(f / p.azN) * p.azN;
  const i = Math.floor(f);
  const t = f - i;
  const a = p.elev[i], b = p.elev[i + 1 === p.azN ? 0 : i + 1];
  return a + (b - a) * t;
}

/**
 * Visible fraction of a disk above the horizon.
 * The disk is cut into vertical strips. Each strip is clipped by the horizon
 * at its own azimuth. limbU > 0 returns the visible share of the flux for
 * linear limb darkening, which is what a solar panel cares about.
 */
export function diskFraction(el: number, az: number, r: number, p: Profile | null, dip: number, limbU = 0, strips = 32): number {
  const hi = p ? p.max : dip, lo = p ? p.min : dip;
  if (el - r >= hi) return 1;
  if (el + r <= lo) return 0;
  const cosel = Math.max(Math.cos(el * DEG), 1e-6);
  let vis = 0, tot = 0;
  for (let k = 0; k < strips; k++) {
    const u = ((k + 0.5) / strips) * 2 - 1;
    const c = Math.sqrt(1 - u * u);
    const hz = horizonAt(p, dip, az + (u * r) / cosel);
    let yb = (hz - el) / r;
    if (yb < -c) yb = -c;
    else if (yb > c) yb = c;
    if (limbU === 0) {
      tot += 2 * c;
      vis += c - yb;
    } else {
      const c2 = c * c;
      const full = (1 - limbU) * 2 * c + limbU * 0.5 * Math.PI * c2;
      const s = Math.sqrt(Math.max(c2 - yb * yb, 0));
      const seg = 0.5 * (yb * s + c2 * Math.asin(Math.max(-1, Math.min(1, yb / c)))) + 0.25 * Math.PI * c2;
      tot += full;
      vis += full - ((1 - limbU) * (yb + c) + limbU * seg);
    }
  }
  return vis / tot;
}

/** Everything the UI shows for one site at one instant. */
export interface Instant {
  t: number;
  src: 0 | 1;
  sunAz: number;
  sunEl: number;
  sunR: number; // angular radius, deg
  sunFrac: number; // visible share of the solar flux, 0..1
  sunHorizon: number; // terrain horizon under the Sun, deg
  flux: number; // W/m2 on a Sun-facing panel
  earthAz: number;
  earthEl: number;
  earthR: number;
  earthFrac: number; // visible share of Earth's disk
  earthHorizon: number;
  earthMargin: number; // Earth centre above the horizon, deg
  sunRange: number;
  earthRange: number;
}

const _sky = newSky();
const _a: AzEl = { az: 0, el: 0, range: 0 };

export function instantAt(site: Site, mastIdx: number, tMs: number, g?: SiteGeom, sky?: Sky): Instant {
  const geom = g ?? siteGeom(site, mastIdx);
  const s = sky ?? skyAt(tMs, _sky);
  const p = site.profiles ? site.profiles[mastIdx] : null;
  azel(geom, s.sun, _a);
  const sunAz = _a.az, sunEl = _a.el, sunRange = _a.range;
  const sunR = Math.asin(R_SUN_KM / sunRange) / DEG;
  const sunFrac = diskFraction(sunEl, sunAz, sunR, p, geom.dip, SUN_LIMB_U);
  const sunHorizon = horizonAt(p, geom.dip, sunAz);
  azel(geom, s.earth, _a);
  const earthAz = _a.az, earthEl = _a.el, earthRange = _a.range;
  const earthR = Math.asin(R_EARTH_KM / earthRange) / DEG;
  const earthHorizon = horizonAt(p, geom.dip, earthAz);
  const earthFrac = diskFraction(earthEl, earthAz, earthR, p, geom.dip, 0, 24);
  const au = sunRange / AU_KM;
  return {
    t: tMs, src: s.src, sunAz, sunEl, sunR, sunFrac, sunHorizon, flux: (SOLAR_CONSTANT / (au * au)) * sunFrac,
    earthAz, earthEl, earthR, earthFrac, earthHorizon, earthMargin: earthEl - earthHorizon, sunRange, earthRange,
  };
}

/** Sub-solar and sub-Earth points on the Moon (deg). */
export function subPoints(sky: Sky) {
  const f = (v: Float64Array) => {
    const r = Math.hypot(v[0], v[1], v[2]);
    return { lat: Math.asin(v[2] / r) / DEG, lon: Math.atan2(v[1], v[0]) / DEG };
  };
  return { sun: f(sky.sun), earth: f(sky.earth) };
}
