// Curated landing sites and their terrain horizons.
import { Profile, Site } from "./sky";

export const N_LAYERS = 6;
export const BANDS_KM = [0, 0.3, 1.5, 6, 25, 90];

export function makeProfile(elev: Float32Array, dist: Float32Array, layers: Float32Array[]): Profile {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < elev.length; i++) {
    if (elev[i] < min) min = elev[i];
    if (elev[i] > max) max = elev[i];
  }
  return { azN: elev.length, elev, dist, layers, min, max };
}

/** Split a horizon file into one profile per mast height. */
export function parseHorizon(buf: ArrayBuffer, azN: number, nMasts: number): Profile[] {
  const f = new Float32Array(buf);
  const per = azN * (2 + N_LAYERS);
  const out: Profile[] = [];
  for (let m = 0; m < nMasts; m++) {
    const o = m * per;
    const elev = f.subarray(o, o + azN);
    const dist = f.subarray(o + azN, o + 2 * azN);
    const layers: Float32Array[] = [];
    for (let b = 0; b < N_LAYERS; b++) layers.push(f.subarray(o + (2 + b) * azN, o + (3 + b) * azN));
    out.push(makeProfile(elev, dist, layers));
  }
  return out;
}

interface RawSite {
  id: string; name: string; group: string; lat: number; lon: number; note: string; source: string; tier: Site["tier"];
  elev_m: number | null; masts?: number[]; az_n?: number; horizon?: string; artemis2024?: boolean; tile?: string;
  stats2027?: Record<string, Record<string, number>>;
}

export async function loadSites(base = "/data"): Promise<Site[]> {
  const j = await fetch(`${base}/sites.json`).then((r) => r.json());
  return (j.sites as RawSite[]).map((s) => ({
    id: s.id, name: s.name, group: s.group, lat: s.lat, lon: s.lon, note: s.note, source: s.source, tier: s.tier,
    elev_m: s.elev_m, masts: s.masts ?? [2, 10], profiles: null, artemis2024: s.artemis2024, tile: s.tile,
    horizonUrl: s.horizon ? `${base}/${s.horizon}` : undefined, stats2027: s.stats2027,
  }));
}

const pending = new Map<string, Promise<void>>();

/** Fetch the horizon of a site once. Sphere-tier sites have none. */
export function ensureHorizon(site: Site): Promise<void> {
  if (site.profiles || !site.horizonUrl) return Promise.resolve();
  let p = pending.get(site.id);
  if (!p) {
    p = fetch(site.horizonUrl)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        site.profiles = parseHorizon(buf, 1440, site.masts.length);
      });
    pending.set(site.id, p);
  }
  return p;
}

export const TIER_LABEL: Record<Site["tier"], string> = {
  lola5: "LOLA 5 m terrain",
  lola20: "LOLA 20 m terrain",
  lola240: "LOLA 240 m terrain",
  sphere: "Smooth sphere",
  custom: "LOLA terrain, computed live",
};

export function fmtLat(lat: number, digits = 3) {
  return `${Math.abs(lat).toFixed(digits)}°${lat < 0 ? "S" : "N"}`;
}
export function fmtLon(lon: number, digits = 3) {
  let l = ((lon + 180) % 360 + 360) % 360 - 180;
  return `${Math.abs(l).toFixed(digits)}°${l < 0 ? "W" : "E"}`;
}
