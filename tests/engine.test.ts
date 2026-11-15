// The browser engine against three independent references:
//   1. raw JPL Horizons rows (Sun and Earth azimuth / elevation from lunar sites)
//   2. the Python + SPICE pipeline (one year of illumination per site)
//   3. the analytic fallback against the DE440 table
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { R_SUN_KM, analyticSky, newSky, setEphem, skyAt } from "../src/lib/ephem";
import { parseHorizon } from "../src/lib/sites";
import { AzEl, Profile, azel, diskFraction, horizonAt, makeGeom } from "../src/lib/sky";

const DATA = "public/data";
const DEG = Math.PI / 180;
const buf = (p: string) => {
  const b = readFileSync(`${DATA}/${p}`);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const json = (p: string) => JSON.parse(readFileSync(`${DATA}/${p}`, "utf8"));

beforeAll(() => {
  const meta = json("ephem.json");
  setEphem({ t0: meta.t0, step: meta.step, n: meta.n, data: new Float32Array(buf("ephem.bin")), meta });
});

describe("JPL Horizons", () => {
  const ref = json("validation/horizons.json");
  it("Sun and Earth az/el match Horizons to 0.2 arcsec at every sampled epoch", () => {
    const sky = newSky();
    const a: AzEl = { az: 0, el: 0, range: 0 };
    let worst = 0, n = 0;
    for (const s of ref.sites) {
      const g = makeGeom(s.lat, s.lon, s.alt_km * 1000, 0);
      for (const body of ["sun", "earth"] as const) {
        for (const [t, az, el] of s[body].samples as number[][]) {
          skyAt(t * 1000, sky);
          azel(g, body === "sun" ? sky.sun : sky.earth, a);
          const dEl = (a.el - el) * 3600;
          const dAz = ((((a.az - az + 540) % 360) - 180) * Math.cos(el * DEG)) * 3600;
          worst = Math.max(worst, Math.hypot(dEl, dAz));
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(60);
    expect(worst).toBeLessThan(0.2);
  });
});

describe("Python + SPICE pipeline", () => {
  const sites = json("sites.json").sites.filter((s: any) => s.horizon);
  it("one year of sunlight and Earth visibility matches the pipeline for every site with terrain", () => {
    const sky = newSky();
    const a: AzEl = { az: 0, el: 0, range: 0 };
    const t0 = Date.UTC(2027, 0, 1);
    for (const s of sites) {
      const profs: Profile[] = parseHorizon(buf(s.horizon), s.az_n, s.masts.length);
      for (let m = 0; m < s.masts.length; m++) {
        const g = makeGeom(s.lat, s.lon, s.elev_m, s.masts[m]);
        let sum = 0, up = 0;
        for (let i = 0; i < 8760; i++) {
          skyAt(t0 + i * 3600e3, sky);
          azel(g, sky.sun, a);
          sum += diskFraction(a.el, a.az, Math.asin(R_SUN_KM / a.range) / DEG, profs[m], g.dip, 0, 16);
          azel(g, sky.earth, a);
          if (a.el > horizonAt(profs[m], g.dip, a.az)) up++;
        }
        const st = s.stats2027[String(Math.round(s.masts[m]))];
        expect(Math.abs((sum / 8760) * 100 - st.sun_avg), `${s.id} sun ${s.masts[m]} m`).toBeLessThan(0.15);
        expect(Math.abs((up / 8760) * 100 - st.earth_up), `${s.id} earth ${s.masts[m]} m`).toBeLessThan(0.15);
      }
    }
  });
});

describe("analytic fallback", () => {
  it("stays within 0.03 degrees of DE440 for the Sun and Earth directions", () => {
    const tab = newSky(), an = newSky();
    const ang = (u: Float64Array, v: Float64Array) => {
      const d = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(u[0], u[1], u[2]) * Math.hypot(v[0], v[1], v[2]));
      return Math.acos(Math.min(1, d)) / DEG;
    };
    let ws = 0, we = 0;
    for (let k = 0; k < 400; k++) {
      const t = Date.UTC(2021, 0, 1) + k * 26.3 * 86400e3;
      skyAt(t, tab);
      analyticSky(t, an);
      expect(tab.src).toBe(0);
      ws = Math.max(ws, ang(tab.sun, an.sun));
      we = Math.max(we, ang(tab.earth, an.earth));
    }
    expect(ws).toBeLessThan(0.03);
    expect(we).toBeLessThan(0.03);
  });
});
