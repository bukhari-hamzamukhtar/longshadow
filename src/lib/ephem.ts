// Sun and Earth as seen from the Moon, in the Moon ME (LOLA) frame.
//
// Primary source: a table built with NAIF SPICE from JPL DE440 and the DE440
// lunar orientation (pipeline/build_ephemeris.py). It holds the apparent
// (light time + aberration) Sun and Earth vectors from the Moon's centre and
// the J2000 -> ME rotation every 6 hours. A 4-point cubic recovers any instant
// to better than 0.02 arcsec.
//
// Fallback outside the table: astronomy-engine positions plus the IAU/WGCCRE
// lunar rotation model. Good to a few hundredths of a degree.
import * as Astronomy from "astronomy-engine";
import { DATA } from "./base";

export const R_MOON_KM = 1737.4;
export const R_SUN_KM = 695700;
export const R_EARTH_KM = 6378.137;
export const AU_KM = 149597870.7;
export const SOLAR_CONSTANT = 1361; // W/m2 at 1 AU
const C_AU_PER_DAY = 173.1446326846693;
const DEG = Math.PI / 180;

export interface EphemTable {
  t0: number; // unix seconds of row 0
  step: number; // seconds
  n: number;
  data: Float32Array; // n x 10
  meta: Record<string, unknown>;
}

export interface Sky {
  sun: Float64Array; // km, Moon-centred, ME frame, apparent
  earth: Float64Array;
  q: Float64Array; // J2000 -> ME, scalar first
  src: 0 | 1; // 0 = DE440 table, 1 = analytic fallback
}

export function newSky(): Sky {
  return { sun: new Float64Array(3), earth: new Float64Array(3), q: new Float64Array(4), src: 0 };
}

let table: EphemTable | null = null;

export function setEphem(t: EphemTable | null) {
  table = t;
}
export function getEphem() {
  return table;
}

export async function loadEphem(base = DATA): Promise<EphemTable> {
  const [meta, buf] = await Promise.all([
    fetch(`${base}/ephem.json`).then((r) => r.json()),
    fetch(`${base}/ephem.bin`).then((r) => r.arrayBuffer()),
  ]);
  table = { t0: meta.t0, step: meta.step, n: meta.n, data: new Float32Array(buf), meta };
  return table;
}

/** Sky state at a UTC instant (milliseconds since the Unix epoch). */
export function skyAt(tMs: number, out: Sky = newSky()): Sky {
  const tab = table;
  if (tab) {
    const f = (tMs / 1000 - tab.t0) / tab.step;
    if (f >= 1 && f < tab.n - 2) {
      const i = Math.floor(f);
      const t = f - i;
      const w0 = (-t * (t - 1) * (t - 2)) / 6;
      const w1 = ((t + 1) * (t - 1) * (t - 2)) / 2;
      const w2 = (-(t + 1) * t * (t - 2)) / 2;
      const w3 = ((t + 1) * t * (t - 1)) / 6;
      const d = tab.data;
      const o = (i - 1) * 10;
      for (let k = 0; k < 3; k++) {
        out.sun[k] = w0 * d[o + k] + w1 * d[o + 10 + k] + w2 * d[o + 20 + k] + w3 * d[o + 30 + k];
        out.earth[k] = w0 * d[o + 3 + k] + w1 * d[o + 13 + k] + w2 * d[o + 23 + k] + w3 * d[o + 33 + k];
      }
      let n2 = 0;
      for (let k = 0; k < 4; k++) {
        const v = w0 * d[o + 6 + k] + w1 * d[o + 16 + k] + w2 * d[o + 26 + k] + w3 * d[o + 36 + k];
        out.q[k] = v;
        n2 += v * v;
      }
      const inv = 1 / Math.sqrt(n2);
      for (let k = 0; k < 4; k++) out.q[k] *= inv;
      out.src = 0;
      return out;
    }
  }
  return analyticSky(tMs, out);
}

/** True when the DE440 table covers this instant. */
export function inTable(tMs: number): boolean {
  if (!table) return false;
  const f = (tMs / 1000 - table.t0) / table.step;
  return f >= 1 && f < table.n - 2;
}

/** Analytic model: astronomy-engine + IAU lunar rotation. */
export function analyticSky(tMs: number, out: Sky = newSky()): Sky {
  const time = Astronomy.MakeTime(new Date(tMs));
  const m = Astronomy.GeoMoonState(time); // geocentric, J2000 equator, AU and AU/day
  const e = Astronomy.HelioState(Astronomy.Body.Earth, time);
  // geometric vectors from the Moon's centre
  let sx = -(e.x + m.x), sy = -(e.y + m.y), sz = -(e.z + m.z);
  let ex = -m.x, ey = -m.y, ez = -m.z;
  // light time and aberration, first order: shift by tau * (observer velocity - target velocity)
  const ts = Math.hypot(sx, sy, sz) / C_AU_PER_DAY;
  sx += ts * (e.vx + m.vx);
  sy += ts * (e.vy + m.vy);
  sz += ts * (e.vz + m.vz);
  const te = Math.hypot(ex, ey, ez) / C_AU_PER_DAY;
  ex += te * m.vx;
  ey += te * m.vy;
  ez += te * m.vz;
  // IAU orientation of the Moon
  const ax = Astronomy.RotationAxis(Astronomy.Body.Moon, time);
  const a = ax.ra * 15 * DEG, d = ax.dec * DEG, w = ax.spin * DEG;
  const Z = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
  const N = [-Math.sin(a), Math.cos(a), 0];
  const M = [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)];
  const cw = Math.cos(w), sw = Math.sin(w);
  const X = [N[0] * cw + M[0] * sw, N[1] * cw + M[1] * sw, N[2] * cw + M[2] * sw];
  const Y = [-N[0] * sw + M[0] * cw, -N[1] * sw + M[1] * cw, -N[2] * sw + M[2] * cw];
  out.sun[0] = (sx * X[0] + sy * X[1] + sz * X[2]) * AU_KM;
  out.sun[1] = (sx * Y[0] + sy * Y[1] + sz * Y[2]) * AU_KM;
  out.sun[2] = (sx * Z[0] + sy * Z[1] + sz * Z[2]) * AU_KM;
  out.earth[0] = (ex * X[0] + ey * X[1] + ez * X[2]) * AU_KM;
  out.earth[1] = (ex * Y[0] + ey * Y[1] + ez * Y[2]) * AU_KM;
  out.earth[2] = (ex * Z[0] + ey * Z[1] + ez * Z[2]) * AU_KM;
  matToQuat([X[0], X[1], X[2], Y[0], Y[1], Y[2], Z[0], Z[1], Z[2]], out.q);
  out.src = 1;
  return out;
}

/** Row-major 3x3 rotation matrix -> quaternion (scalar first, SPICE m2q convention). */
export function matToQuat(m: ArrayLike<number>, q: Float64Array) {
  const tr = m[0] + m[4] + m[8];
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q[0] = s / 4;
    q[1] = (m[7] - m[5]) / s;
    q[2] = (m[2] - m[6]) / s;
    q[3] = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    q[0] = (m[7] - m[5]) / s;
    q[1] = s / 4;
    q[2] = (m[1] + m[3]) / s;
    q[3] = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    q[0] = (m[2] - m[6]) / s;
    q[1] = (m[1] + m[3]) / s;
    q[2] = s / 4;
    q[3] = (m[5] + m[7]) / s;
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    q[0] = (m[3] - m[1]) / s;
    q[1] = (m[2] + m[6]) / s;
    q[2] = (m[5] + m[7]) / s;
    q[3] = s / 4;
  }
}

/** Quaternion -> row-major 3x3 matrix that takes J2000 vectors to ME. */
export function quatToMat(q: ArrayLike<number>, m: Float64Array = new Float64Array(9)) {
  const q0 = q[0], q1 = q[1], q2 = q[2], q3 = q[3];
  m[0] = 1 - 2 * (q2 * q2 + q3 * q3);
  m[1] = 2 * (q1 * q2 - q0 * q3);
  m[2] = 2 * (q1 * q3 + q0 * q2);
  m[3] = 2 * (q1 * q2 + q0 * q3);
  m[4] = 1 - 2 * (q1 * q1 + q3 * q3);
  m[5] = 2 * (q2 * q3 - q0 * q1);
  m[6] = 2 * (q1 * q3 - q0 * q2);
  m[7] = 2 * (q2 * q3 + q0 * q1);
  m[8] = 1 - 2 * (q1 * q1 + q2 * q2);
  return m;
}

/**
 * Rotation from the Earth-fixed frame (ITRS, x through Greenwich) to the Moon
 * ME frame. Used to draw the right face of Earth and to place ground stations.
 */
export function earthFixedToME(tMs: number, sky: Sky, out: Float64Array = new Float64Array(9)) {
  const time = Astronomy.MakeTime(new Date(tMs));
  const r = Astronomy.Rotation_EQJ_EQD(time); // J2000 -> true equator of date
  const gast = Astronomy.SiderealTime(time) * 15 * DEG;
  const c = Math.cos(gast), s = Math.sin(gast);
  // rows of (J2000 -> Earth-fixed): Rz(gast) * R_eqj_eqd. astronomy-engine stores rot[col][row].
  const A = [
    [r.rot[0][0], r.rot[1][0], r.rot[2][0]],
    [r.rot[0][1], r.rot[1][1], r.rot[2][1]],
    [r.rot[0][2], r.rot[1][2], r.rot[2][2]],
  ];
  const F = [
    [c * A[0][0] + s * A[1][0], c * A[0][1] + s * A[1][1], c * A[0][2] + s * A[1][2]],
    [-s * A[0][0] + c * A[1][0], -s * A[0][1] + c * A[1][1], -s * A[0][2] + c * A[1][2]],
    [A[2][0], A[2][1], A[2][2]],
  ];
  const M = quatToMat(sky.q);
  // out = M * F^T  (Earth-fixed -> J2000 -> ME)
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) out[i * 3 + j] = M[i * 3] * F[j][0] + M[i * 3 + 1] * F[j][1] + M[i * 3 + 2] * F[j][2];
  return out;
}
