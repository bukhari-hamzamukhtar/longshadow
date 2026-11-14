// Time series, power and comm windows, and landing-date scans for a site.
import { AU_KM, R_EARTH_KM, R_SUN_KM, SOLAR_CONSTANT, newSky, skyAt } from "./ephem";
import { AzEl, Site, SUN_LIMB_U, azel, diskFraction, horizonAt, instantAt, siteGeom } from "./sky";

const DEG = Math.PI / 180;
export const HOUR = 3600e3;
export const DAY = 86400e3;

export interface Series {
  siteId: string;
  mastIdx: number;
  t0: number; // ms
  dt: number; // ms
  n: number;
  sunAz: Float32Array;
  sunEl: Float32Array;
  sunFrac: Float32Array;
  flux: Float32Array; // W/m2 on a Sun-facing panel
  earthAz: Float32Array;
  earthEl: Float32Array;
  earthMargin: Float32Array; // Earth centre above the terrain horizon, deg
  earthFrac: Float32Array;
  analytic: boolean; // true if any sample came from the analytic fallback
}

export function computeSeries(site: Site, mastIdx: number, t0: number, t1: number, dt: number): Series {
  const n = Math.max(2, Math.floor((t1 - t0) / dt) + 1);
  const g = siteGeom(site, mastIdx);
  const p = site.profiles ? site.profiles[mastIdx] : null;
  const sky = newSky();
  const a: AzEl = { az: 0, el: 0, range: 0 };
  const s: Series = {
    siteId: site.id, mastIdx, t0, dt, n,
    sunAz: new Float32Array(n), sunEl: new Float32Array(n), sunFrac: new Float32Array(n), flux: new Float32Array(n),
    earthAz: new Float32Array(n), earthEl: new Float32Array(n), earthMargin: new Float32Array(n), earthFrac: new Float32Array(n),
    analytic: false,
  };
  for (let i = 0; i < n; i++) {
    skyAt(t0 + i * dt, sky);
    if (sky.src) s.analytic = true;
    azel(g, sky.sun, a);
    const sr = Math.asin(R_SUN_KM / a.range) / DEG;
    const f = diskFraction(a.el, a.az, sr, p, g.dip, SUN_LIMB_U);
    s.sunAz[i] = a.az;
    s.sunEl[i] = a.el;
    s.sunFrac[i] = f;
    const au = a.range / AU_KM;
    s.flux[i] = (SOLAR_CONSTANT / (au * au)) * f;
    azel(g, sky.earth, a);
    const er = Math.asin(R_EARTH_KM / a.range) / DEG;
    s.earthAz[i] = a.az;
    s.earthEl[i] = a.el;
    s.earthMargin[i] = a.el - horizonAt(p, g.dip, a.az);
    s.earthFrac[i] = diskFraction(a.el, a.az, er, p, g.dip, 0, 16);
  }
  return s;
}

export interface Interval {
  a: number; // ms
  b: number;
  openA?: boolean; // interval was already on at the start of the series
  openB?: boolean;
}

export interface Rules {
  sunMin: number; // visible share of solar flux needed to count as "power", 0..1
  commMargin: number; // Earth centre must clear the horizon by this many degrees
}

export const DEFAULT_RULES: Rules = { sunMin: 0.5, commMargin: 0 };

export function sunOn(v: number, r: Rules) {
  return v >= r.sunMin && v > 0;
}

/** Intervals where pred(value) holds, edges refined by bisection on exact(t). */
export function findIntervals(vals: Float32Array, t0: number, dt: number, pred: (v: number) => boolean, exact?: (t: number) => number): Interval[] {
  const out: Interval[] = [];
  const n = vals.length;
  const edge = (i: number, rising: boolean) => {
    // crossing lies between sample i and i + 1
    let lo = t0 + i * dt, hi = lo + dt;
    if (!exact) {
      return (lo + hi) / 2;
    }
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) / 2;
      if (pred(exact(mid)) === rising) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  };
  let on = pred(vals[0]);
  let start = t0, open = on;
  for (let i = 0; i < n - 1; i++) {
    const nx = pred(vals[i + 1]);
    if (nx !== on) {
      const tc = edge(i, nx);
      if (nx) {
        start = tc;
        open = false;
      } else out.push({ a: start, b: tc, openA: open });
      on = nx;
    }
  }
  if (on) out.push({ a: start, b: t0 + (n - 1) * dt, openA: open, openB: true });
  return out;
}

export function powerIntervals(site: Site, s: Series, rules: Rules, refine = true): Interval[] {
  const g = siteGeom(site, s.mastIdx);
  return findIntervals(s.sunFrac, s.t0, s.dt, (v) => sunOn(v, rules), refine ? (t) => instantAt(site, s.mastIdx, t, g).sunFrac : undefined);
}

export function commIntervals(site: Site, s: Series, rules: Rules, refine = true): Interval[] {
  const g = siteGeom(site, s.mastIdx);
  return findIntervals(s.earthMargin, s.t0, s.dt, (v) => v >= rules.commMargin, refine ? (t) => instantAt(site, s.mastIdx, t, g).earthMargin : undefined);
}

export function gaps(on: Interval[], a: number, b: number): Interval[] {
  const out: Interval[] = [];
  let cur = a;
  for (const iv of on) {
    if (iv.b <= a || iv.a >= b) continue;
    if (iv.a > cur) out.push({ a: cur, b: Math.min(iv.a, b) });
    cur = Math.max(cur, iv.b);
  }
  if (cur < b) out.push({ a: cur, b });
  return out;
}

function longestIn(ivs: Interval[], a: number, b: number): number {
  let best = 0;
  for (const iv of ivs) {
    const d = Math.min(iv.b, b) - Math.max(iv.a, a);
    if (d > best) best = d;
  }
  return best;
}

function coverage(ivs: Interval[], a: number, b: number): number {
  let sum = 0;
  for (const iv of ivs) {
    const d = Math.min(iv.b, b) - Math.max(iv.a, a);
    if (d > 0) sum += d;
  }
  return sum / (b - a);
}

export interface Metrics {
  a: number;
  b: number;
  sunAvg: number; // mean visible share of solar flux
  powerPct: number; // share of time with power (per rules)
  litPct: number; // share of time with any Sun
  longestDarkH: number; // longest stretch without power
  longestLitH: number;
  energy: number; // kWh per m2 of Sun-facing panel
  commPct: number;
  longestOutageH: number;
  longestCommH: number;
  sunElMax: number;
  earthElMin: number;
  earthElMax: number;
}

export interface SiteWindows {
  series: Series;
  power: Interval[];
  comm: Interval[];
  dark: Interval[];
  outage: Interval[];
}

export function buildWindows(site: Site, series: Series, rules: Rules, refine = true): SiteWindows {
  const power = powerIntervals(site, series, rules, refine);
  const comm = commIntervals(site, series, rules, refine);
  const a = series.t0, b = series.t0 + (series.n - 1) * series.dt;
  return { series, power, comm, dark: gaps(power, a, b), outage: gaps(comm, a, b) };
}

export function metricsFor(w: SiteWindows, a: number, b: number): Metrics {
  const s = w.series;
  const i0 = Math.max(0, Math.ceil((a - s.t0) / s.dt));
  const i1 = Math.min(s.n - 1, Math.floor((b - s.t0) / s.dt));
  let sum = 0, lit = 0, e = 0, sunElMax = -90, eMin = 90, eMax = -90;
  for (let i = i0; i <= i1; i++) {
    const f = s.sunFrac[i];
    sum += f;
    if (f > 0) lit++;
    e += s.flux[i];
    if (s.sunEl[i] > sunElMax) sunElMax = s.sunEl[i];
    if (s.earthEl[i] < eMin) eMin = s.earthEl[i];
    if (s.earthEl[i] > eMax) eMax = s.earthEl[i];
  }
  const cnt = Math.max(1, i1 - i0 + 1);
  return {
    a, b,
    sunAvg: sum / cnt,
    powerPct: coverage(w.power, a, b),
    litPct: lit / cnt,
    longestDarkH: longestIn(w.dark, a, b) / HOUR,
    longestLitH: longestIn(w.power, a, b) / HOUR,
    energy: (e * (s.dt / HOUR)) / 1000,
    commPct: coverage(w.comm, a, b),
    longestOutageH: longestIn(w.outage, a, b) / HOUR,
    longestCommH: longestIn(w.comm, a, b) / HOUR,
    sunElMax, earthElMin: eMin, earthElMax: eMax,
  };
}

/** What a mission needs from a site for the surface stay to work. */
export interface Mission {
  durationD: number; // surface stay, Earth days
  maxDarkH: number; // longest stretch without power the lander survives
  minPowerPct: number; // 0..1
  needComm: boolean;
  maxOutageH: number; // longest comm outage accepted
  minCommPct: number; // 0..1
}

export const DEFAULT_MISSION: Mission = { durationD: 10, maxDarkH: 12, minPowerPct: 0.8, needComm: true, maxOutageH: 24, minCommPct: 0.5 };

export interface Scan {
  t0: number;
  step: number;
  n: number;
  powerPct: Float32Array;
  darkH: Float32Array;
  commPct: Float32Array;
  outageH: Float32Array;
  ok: Uint8Array; // 1 = all requirements met for a landing at this time
  score: Float32Array; // 0..1 margin-style score for colouring
}

/** Score every possible landing time in the series for a mission. */
export function scanLandings(w: SiteWindows, m: Mission, step = HOUR * 2): Scan {
  const s = w.series;
  const dur = m.durationD * DAY;
  const end = s.t0 + (s.n - 1) * s.dt;
  const n = Math.max(0, Math.floor((end - dur - s.t0) / step) + 1);
  const sc: Scan = {
    t0: s.t0, step, n, powerPct: new Float32Array(n), darkH: new Float32Array(n), commPct: new Float32Array(n),
    outageH: new Float32Array(n), ok: new Uint8Array(n), score: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const a = s.t0 + i * step, b = a + dur;
    const pp = coverage(w.power, a, b);
    const dk = longestIn(w.dark, a, b) / HOUR;
    const cp = coverage(w.comm, a, b);
    const og = longestIn(w.outage, a, b) / HOUR;
    sc.powerPct[i] = pp;
    sc.darkH[i] = dk;
    sc.commPct[i] = cp;
    sc.outageH[i] = og;
    const okP = pp >= m.minPowerPct && dk <= m.maxDarkH;
    const okC = !m.needComm || (cp >= m.minCommPct && og <= m.maxOutageH);
    sc.ok[i] = okP && okC ? 1 : 0;
    // score: how far inside the requirement envelope the landing sits
    const sp = Math.min(1, pp / Math.max(m.minPowerPct, 1e-3)) * Math.min(1, m.maxDarkH / Math.max(dk, 1e-3));
    const scm = m.needComm ? Math.min(1, cp / Math.max(m.minCommPct, 1e-3)) * Math.min(1, m.maxOutageH / Math.max(og, 1e-3)) : 1;
    sc.score[i] = Math.max(0, Math.min(1, sp * scm));
  }
  return sc;
}

/** Runs of consecutive feasible landing times. */
export function landingWindows(sc: Scan): Interval[] {
  const out: Interval[] = [];
  let start = -1;
  for (let i = 0; i <= sc.n; i++) {
    const ok = i < sc.n && sc.ok[i] === 1;
    if (ok && start < 0) start = i;
    if (!ok && start >= 0) {
      out.push({ a: sc.t0 + start * sc.step, b: sc.t0 + (i - 1) * sc.step });
      start = -1;
    }
  }
  return out;
}

/** Next change of state after t: when power or comm switches. */
export function nextEdge(ivs: Interval[], t: number): { on: boolean; at: number | null } {
  for (const iv of ivs) {
    if (t < iv.a) return { on: false, at: iv.a };
    if (t < iv.b) return { on: true, at: iv.openB ? null : iv.b };
  }
  return { on: false, at: null };
}
