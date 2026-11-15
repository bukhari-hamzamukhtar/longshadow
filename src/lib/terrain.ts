// LOLA terrain in the browser: loading the height grids, and computing the
// horizon of any point live (used for custom sites).
import { R_MOON_KM } from "./ephem";
import { Profile } from "./sky";
import { BANDS_KM, N_LAYERS, makeProfile } from "./sites";

const DEG = Math.PI / 180;
const R = R_MOON_KM;

export interface GridMeta {
  file: string;
  n: number;
  pixel_m: number;
  x0_m: number;
  y0_m: number;
}
export interface TerrainIndex {
  unit_m: number;
  levels: { cap: GridMeta; core: GridMeta };
  patches: Record<string, GridMeta>;
}

/** Square height grid in south polar stereographic km. Row 0 is the top (largest y). */
export interface HeightGrid {
  n: number;
  px: number; // km per pixel
  x0: number; // centre of column 0
  y0: number; // centre of row 0
  data: Float32Array; // km above the 1737.4 km sphere
  pyramid?: HeightGrid[]; // max-pooled copies, built on demand
}

export function llToXY(lat: number, lon: number): [number, number] {
  const r = 2 * R * Math.tan(((90 + lat) * DEG) / 2);
  return [r * Math.sin(lon * DEG), r * Math.cos(lon * DEG)];
}
export function xyToLL(x: number, y: number): [number, number] {
  const r = Math.hypot(x, y);
  return [-90 + (2 * Math.atan(r / (2 * R))) / DEG, Math.atan2(x, y) / DEG];
}

export async function loadIndex(base = "/data"): Promise<TerrainIndex> {
  return fetch(`${base}/terrain/index.json`).then((r) => r.json());
}

async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return buf; // already inflated by the server
  const ds = new DecompressionStream("gzip");
  return new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
}

export async function loadGrid(meta: GridMeta, unitM: number, base = "/data"): Promise<HeightGrid> {
  const raw = await fetch(`${base}/${meta.file}`).then((r) => r.arrayBuffer());
  const d = new Int16Array(await gunzip(raw));
  const n = meta.n;
  const data = new Float32Array(n * n);
  const k = unitM / 1000;
  for (let r = 0; r < n; r++) {
    let acc = 0;
    const o = r * n;
    for (let c = 0; c < n; c++) {
      acc = ((acc + d[o + c]) << 16) >> 16; // rows are delta coded in int16
      data[o + c] = acc * k;
    }
  }
  return { n, px: meta.pixel_m / 1000, x0: meta.x0_m / 1000, y0: meta.y0_m / 1000, data };
}

export function inside(g: HeightGrid, x: number, y: number, marginPx = 1): boolean {
  const m = marginPx * g.px;
  return x > g.x0 + m && x < g.x0 + (g.n - 1) * g.px - m && y < g.y0 - m && y > g.y0 - (g.n - 1) * g.px + m;
}

export function bilinear(g: HeightGrid, x: number, y: number): number {
  const fc = (x - g.x0) / g.px, fr = (g.y0 - y) / g.px;
  let c0 = Math.floor(fc), r0 = Math.floor(fr);
  if (c0 < 0) c0 = 0;
  else if (c0 > g.n - 2) c0 = g.n - 2;
  if (r0 < 0) r0 = 0;
  else if (r0 > g.n - 2) r0 = g.n - 2;
  const tx = Math.min(1, Math.max(0, fc - c0)), ty = Math.min(1, Math.max(0, fr - r0));
  const o = r0 * g.n + c0, d = g.data;
  return (d[o] * (1 - tx) + d[o + 1] * tx) * (1 - ty) + (d[o + g.n] * (1 - tx) + d[o + g.n + 1] * tx) * ty;
}

function nearest(g: HeightGrid, x: number, y: number): number {
  let c = Math.round((x - g.x0) / g.px), r = Math.round((g.y0 - y) / g.px);
  if (c < 0) c = 0;
  else if (c > g.n - 1) c = g.n - 1;
  if (r < 0) r = 0;
  else if (r > g.n - 1) r = g.n - 1;
  return g.data[r * g.n + c];
}

/** 2x2 max pooling. Used for far rays so no peak inside a cell is missed. */
export function maxPool(g: HeightGrid): HeightGrid {
  const n = Math.floor(g.n / 2);
  const out = new Float32Array(n * n);
  const d = g.data, w = g.n;
  for (let r = 0; r < n; r++) {
    const o = 2 * r * w;
    for (let c = 0; c < n; c++) {
      const i = o + 2 * c;
      out[r * n + c] = Math.max(d[i], d[i + 1], d[i + w], d[i + w + 1]);
    }
  }
  return { n, px: g.px * 2, x0: g.x0 + g.px / 2, y0: g.y0 - g.px / 2, data: out };
}

function pyramid(g: HeightGrid): HeightGrid[] {
  if (!g.pyramid) {
    const lv: HeightGrid[] = [];
    let cur = g;
    while (cur.n >= 8 && cur.px < 8) {
      cur = maxPool(cur);
      lv.push(cur);
    }
    g.pyramid = lv;
  }
  return g.pyramid;
}

function sample(sources: HeightGrid[], sReq: number, x: number, y: number): number {
  for (const g of sources) {
    if (!inside(g, x, y)) continue;
    if (sReq <= g.px * 1.01) return bilinear(g, x, y);
    const lv = pyramid(g);
    for (const p of lv) if (p.px >= sReq * 0.99) return nearest(p, x, y);
    return lv.length ? nearest(lv[lv.length - 1], x, y) : bilinear(g, x, y);
  }
  return NaN;
}

export interface LiveHorizon {
  groundKm: number;
  profiles: Profile[];
  finestPx: number; // km, resolution of the terrain under the site
}

/**
 * Terrain horizon of any point inside the loaded grids. Same method as the
 * Python pipeline: great-circle rays, cell size matched to ray spacing,
 * exact spherical elevation angles. sources go finest first.
 */
export function computeHorizon(lat: number, lon: number, mastsM: number[], sources: HeightGrid[], azN = 720, dMaxKm = 480): LiveHorizon | null {
  const [sx, sy] = llToXY(lat, lon);
  const g0 = sources.find((g) => inside(g, sx, sy));
  if (!g0) return null;
  const h0 = bilinear(g0, sx, sy);
  const la = lat * DEG, lo = lon * DEG;
  const up = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  const east = [-Math.sin(lo), Math.cos(lo), 0];
  const north = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
  const M = mastsM.length;
  const elev = mastsM.map(() => new Float32Array(azN).fill(-90));
  const dist = mastsM.map(() => new Float32Array(azN));
  const layers = mastsM.map(() => Array.from({ length: N_LAYERS }, () => new Float32Array(azN).fill(-90)));
  const ro = mastsM.map((m) => R + h0 + m / 1000);
  const daz = (2 * Math.PI) / azN;
  // distance schedule
  const ds: number[] = [], ss: number[] = [];
  let s = g0.px, dLo = s / 2, first = true;
  while (dLo < dMaxKm) {
    const dHi = Math.min(s / daz, dMaxKm);
    const step = first ? s / 2 : s;
    for (let d = dLo; d < dHi; d += step) {
      ds.push(d);
      ss.push(s);
    }
    dLo = dHi;
    s *= 2;
    first = false;
  }
  const nd = ds.length;
  const ct = new Float64Array(nd), st = new Float64Array(nd), band = new Uint8Array(nd);
  for (let j = 0; j < nd; j++) {
    ct[j] = Math.cos(ds[j] / R);
    st[j] = Math.sin(ds[j] / R);
    let b = 0;
    while (b < N_LAYERS - 1 && ds[j] >= BANDS_KM[b + 1]) b++;
    band[j] = b;
  }
  for (let i = 0; i < azN; i++) {
    const a = i * daz, ca = Math.cos(a), sa = Math.sin(a);
    const dx = ca * north[0] + sa * east[0], dy = ca * north[1] + sa * east[1], dz = ca * north[2] + sa * east[2];
    for (let j = 0; j < nd; j++) {
      const px = up[0] * ct[j] + dx * st[j], py = up[1] * ct[j] + dy * st[j], pz = up[2] * ct[j] + dz * st[j];
      const k = (2 * R) / (1 - pz);
      const h = sample(sources, ss[j], k * py, k * px);
      if (h !== h) continue; // outside the data
      const rad = R + h;
      for (let m = 0; m < M; m++) {
        const el = Math.atan2(rad * ct[j] - ro[m], rad * st[j]) / DEG;
        if (el > elev[m][i]) {
          elev[m][i] = el;
          dist[m][i] = ds[j];
        }
        const L = layers[m][band[j]];
        if (el > L[i]) L[i] = el;
      }
    }
  }
  return { groundKm: h0, profiles: mastsM.map((_, m) => makeProfile(elev[m], dist[m], layers[m])), finestPx: g0.px };
}
