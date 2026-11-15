// The view from the lander: real skyline, Sun and Earth at true size.
import { useEffect, useMemo, useRef, useState } from "react";
import { newSky, skyAt } from "../lib/ephem";
import { compass, deg } from "../lib/format";
import { Instant, Profile, Site, azel, horizonAt, instantAt, siteGeom } from "../lib/sky";
import { DAY, HOUR } from "../lib/windows";

const SUN = "#ffb224";
const EARTH = "#b9cdf5";
const DEGR = Math.PI / 180;

type Follow = "sun" | "earth" | "free";

function wrap180(a: number) {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

interface Track {
  az: Float32Array;
  el: Float32Array;
  t: Float64Array;
}

function makeTrack(site: Site, mastIdx: number, t0: number, span: number, step: number, body: "sun" | "earth"): Track {
  const n = Math.floor(span / step) + 1;
  const g = siteGeom(site, mastIdx);
  const sky = newSky();
  const a = { az: 0, el: 0, range: 0 };
  const tr: Track = { az: new Float32Array(n), el: new Float32Array(n), t: new Float64Array(n) };
  for (let i = 0; i < n; i++) {
    const t = t0 + i * step;
    skyAt(t, sky);
    azel(g, body === "sun" ? sky.sun : sky.earth, a);
    tr.az[i] = a.az;
    tr.el[i] = a.el;
    tr.t[i] = t;
  }
  return tr;
}

export function Panorama({ site, mastIdx, t, story = false, face }: { site: Site; mastIdx: number; t: number; story?: boolean; face?: Follow }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState<Follow>(face ?? "sun");
  const [size, setSize] = useState({ w: 600, h: 260 });
  const view = useRef({ az: 0, span: 24, eff: 24, elMin: -3, elMax: 8, init: false });
  const hover = useRef<{ x: number; y: number } | null>(null);
  const [, force] = useState(0);
  const inst = useMemo(() => instantAt(site, mastIdx, t), [site, site.profiles, mastIdx, t]);
  const prof: Profile | null = site.profiles ? site.profiles[mastIdx] : null;

  useEffect(() => {
    if (face) setFollow(face);
  }, [face]);

  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const r = box.current!.getBoundingClientRect();
      setSize({ w: Math.max(200, Math.floor(r.width)), h: Math.max(140, Math.floor(r.height)) });
    });
    ro.observe(box.current!);
    return () => ro.disconnect();
  }, []);

  // paths for the hours ahead: where the Sun and Earth are going
  const bucket = Math.floor(t / (6 * HOUR));
  const tracks = useMemo(() => {
    const t0 = bucket * 6 * HOUR;
    const polar = Math.abs(site.lat) > 60;
    return {
      sun: makeTrack(site, mastIdx, t0, polar ? 30 * DAY : 15 * DAY, polar ? 3 * HOUR : HOUR, "sun"),
      earth: makeTrack(site, mastIdx, t0 - 14 * DAY, 28 * DAY, 4 * HOUR, "earth"),
    };
  }, [site, mastIdx, bucket]);

  useEffect(() => {
    view.current.init = false;
  }, [site.id]);

  useEffect(() => {
    const cv = ref.current!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = size.w, H = size.h;
    if (cv.width !== W * dpr || cv.height !== H * dpr) {
      cv.width = W * dpr;
      cv.height = H * dpr;
    }
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, W, H, site, mastIdx, prof, inst, tracks, view.current, follow, hover.current, story);
  });

  // pointer: drag to look around, wheel to zoom
  useEffect(() => {
    const cv = ref.current!;
    let drag: null | { x: number; az: number } = null;
    const down = (e: PointerEvent) => {
      cv.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, az: view.current.az };
    };
    const move = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      hover.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (drag) {
        const dx = e.clientX - drag.x;
        if (Math.abs(dx) > 2) setFollow("free");
        view.current.az = (((drag.az - (dx / r.width) * view.current.eff) % 360) + 360) % 360;
      }
      force((k) => k + 1);
    };
    const up = () => (drag = null);
    const leave = () => {
      hover.current = null;
      force((k) => k + 1);
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      view.current.span = Math.min(360, Math.max(4, view.current.eff * Math.exp(e.deltaY * 0.0015)));
      force((k) => k + 1);
    };
    if (!story) {
      cv.addEventListener("pointerdown", down);
      cv.addEventListener("pointermove", move);
      cv.addEventListener("pointerup", up);
      cv.addEventListener("pointerleave", leave);
      cv.addEventListener("wheel", wheel, { passive: false });
    }
    return () => {
      cv.removeEventListener("pointerdown", down);
      cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up);
      cv.removeEventListener("pointerleave", leave);
      cv.removeEventListener("wheel", wheel);
    };
  }, [story]);

  const zoom = (span: number) => {
    view.current.span = span;
    force((k) => k + 1);
  };

  return (
    <div className="pano" ref={box}>
      <canvas ref={ref} style={{ width: size.w, height: size.h }} />
      {!story && (
        <div className="pano-tools">
          <span className="cap">View from the lander</span>
          <div className="seg">
            <button className={follow === "sun" ? "on" : ""} onClick={() => setFollow("sun")}>Face the Sun</button>
            <button className={follow === "earth" ? "on" : ""} onClick={() => setFollow("earth")}>Face Earth</button>
            <button onClick={() => zoom(view.current.span > 200 ? 24 : 360)}>{view.current.span > 200 ? "Zoom in" : "Full 360°"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function draw(
  ctx: CanvasRenderingContext2D, W: number, H: number, site: Site, mastIdx: number, prof: Profile | null, inst: Instant,
  tracks: { sun: Track; earth: Track }, v: { az: number; span: number; eff: number; elMin: number; elMax: number; init: boolean },
  follow: Follow, hover: { x: number; y: number } | null, story: boolean,
) {
  const dip = siteGeom(site, mastIdx).dip;
  // where to look
  const targetAz = follow === "sun" ? inst.sunAz : follow === "earth" ? inst.earthAz : v.az;
  if (!v.init || follow !== "free") v.az = ((targetAz % 360) + 360) % 360;
  // skyline range in the window
  let hzMax = dip, hzMin = dip;
  if (prof) {
    hzMax = -90;
    hzMin = 90;
    for (let k = 0; k <= 80; k++) {
      const e = horizonAt(prof, dip, v.az - v.span / 2 + (k / 80) * v.span);
      if (e > hzMax) hzMax = e;
      if (e < hzMin) hzMin = e;
    }
  }
  // what has to fit above the skyline
  const inView = (az: number) => Math.abs(wrap180(az - v.az)) < v.span / 2 + 3;
  let need = hzMax + 0.6;
  if (follow === "sun" || (follow === "free" && inView(inst.sunAz))) need = Math.max(need, inst.sunEl + inst.sunR + 0.7);
  if (follow === "earth" || (follow === "free" && inView(inst.earthAz))) need = Math.max(need, inst.earthEl + inst.earthR + 0.9);
  let base = Math.min(hzMin, 0);
  // a body we are facing stays in frame even when it is below the skyline
  if (follow === "sun") base = Math.min(base, Math.max(-12, inst.sunEl - inst.sunR - 0.4));
  if (follow === "earth") base = Math.min(base, Math.max(-12, inst.earthEl - inst.earthR - 0.4));
  // Zoomed in, a degree is the same size both ways, so disks stay round and
  // slopes look right. If the body sits higher than the window, zoom out.
  let span = v.span, range: number;
  if (span <= 70) {
    range = (H * span) / W;
    const min = (need - base) / 0.84;
    if (range < min) {
      range = min;
      span = Math.min(360, (range * W) / H);
    }
  } else range = Math.max(13, (need - base) / 0.84);
  const elMinT = base - 0.16 * range, elMaxT = elMinT + range;
  v.elMax = elMaxT;
  v.elMin = elMinT;
  v.eff = span;
  v.init = true;
  const sp = v.eff;
  const X = (az: number) => W / 2 + (wrap180(az - v.az) / sp) * W;
  const Y = (el: number) => H - ((el - v.elMin) / (v.elMax - v.elMin)) * H;
  const ppdX = W / sp, ppdY = H / (v.elMax - v.elMin);

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  ctx.font = '10px "Geist Mono", ui-monospace, monospace';
  ctx.textBaseline = "middle";

  // elevation grid
  const er = v.elMax - v.elMin;
  const stepEl = er > 40 ? 10 : er > 16 ? 5 : er > 8 ? 2 : er > 3.5 ? 1 : 0.5;
  for (let e = Math.ceil(v.elMin / stepEl) * stepEl; e < v.elMax; e += stepEl) {
    const y = Math.round(Y(e)) + 0.5;
    ctx.strokeStyle = e === 0 ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.055)";
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.32)";
    ctx.textAlign = "left";
    ctx.fillText(`${stepEl < 1 ? e.toFixed(1) : e}°`, 6, y - 7);
  }

  // future paths
  const path = (tr: Track, color: string, dash: number[], tickEvery: number) => {
    ctx.strokeStyle = color;
    ctx.setLineDash(dash);
    ctx.lineWidth = 1;
    ctx.beginPath();
    let pen = false, px = 0;
    for (let i = 0; i < tr.az.length; i++) {
      const x = X(tr.az[i]), y = Y(tr.el[i]);
      if (!pen || Math.abs(x - px) > W * 0.5) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      pen = true;
      px = x;
    }
    ctx.stroke();
    ctx.setLineDash([]);
    if (tickEvery > 0) {
      ctx.fillStyle = color;
      for (let i = 0; i < tr.az.length; i++) {
        if (tr.t[i] <= inst.t || Math.round(tr.t[i] / HOUR) % tickEvery !== 0) continue;
        const x = X(tr.az[i]), y = Y(tr.el[i]);
        if (x < 0 || x > W) continue;
        ctx.fillRect(x - 1, y - 3, 2, 6);
        if (ppdX > 6) {
          ctx.textAlign = "center";
          ctx.fillText(`+${Math.round((tr.t[i] - inst.t) / DAY)} d`, x, y - 11);
        }
      }
    }
  };
  path(tracks.earth, "rgba(185,205,245,0.3)", [2, 4], 0);
  path(tracks.sun, "rgba(255,178,36,0.5)", [1, 5], 24);

  // Earth: phase from the real Sun direction
  {
    const cx = X(inst.earthAz), cy = Y(inst.earthEl);
    const cosel = Math.max(Math.cos(inst.earthEl * DEGR), 0.05);
    // angle between Earth and Sun in the sky, and the direction from Earth to the Sun
    const dAz = (inst.sunAz - inst.earthAz) * DEGR, e1 = inst.earthEl * DEGR, e2 = inst.sunEl * DEGR;
    const cosSep = Math.sin(e1) * Math.sin(e2) + Math.cos(e1) * Math.cos(e2) * Math.cos(dAz);
    const dx = Math.sin(dAz) * Math.cos(e2);
    const dy = Math.cos(e1) * Math.sin(e2) - Math.sin(e1) * Math.cos(e2) * Math.cos(dAz);
    // lit share of Earth's disk: Earth is "full" when the Sun is behind the observer
    const k = (1 - cosSep) / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(ppdX / cosel, -ppdY);
    const r = inst.earthR;
    ctx.fillStyle = "#101a2c";
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(Math.atan2(dy, dx));
    ctx.fillStyle = EARTH;
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
    ctx.ellipse(0, 0, Math.abs(2 * k - 1) * r, r, 0, Math.PI / 2, (3 * Math.PI) / 2, k < 0.5);
    ctx.fill();
    ctx.restore();
  }
  // Sun: true angular size
  {
    const cx = X(inst.sunAz), cy = Y(inst.sunEl);
    const cosel = Math.max(Math.cos(inst.sunEl * DEGR), 0.05);
    ctx.fillStyle = "#fff4d6";
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(1.5, (inst.sunR * ppdX) / cosel), Math.max(1.5, inst.sunR * ppdY), 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // terrain, far ridges first
  const step = 2;
  const poly = (val: (az: number) => number, fill: string, stroke: string | null) => {
    ctx.beginPath();
    ctx.moveTo(0, H + 2);
    for (let x = 0; x <= W + step; x += step) {
      const az = v.az + ((x - W / 2) / W) * sp;
      ctx.lineTo(x, Math.min(H + 2, Y(val(az))));
    }
    ctx.lineTo(W + step, H + 2);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.beginPath();
      for (let x = 0; x <= W + step; x += step) {
        const az = v.az + ((x - W / 2) / W) * sp;
        const y = Y(val(az));
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  };
  if (prof) {
    const shades = ["#101214", "#17191d", "#1f2227", "#282c32", "#32373e", "#3d434c"]; // near ... far
    const nL = prof.layers.length;
    // a far ridge only shows where it stands above everything nearer: draw far to near
    for (let b = nL - 1; b >= 0; b--) {
      const L = prof.layers[b];
      const f = (az: number) => {
        let q = (az / 360) * prof.azN;
        q -= Math.floor(q / prof.azN) * prof.azN;
        const i = Math.floor(q), tt = q - i;
        const a = L[i], c = L[i + 1 === prof.azN ? 0 : i + 1];
        const e = a + (c - a) * tt;
        return e < -60 ? -60 : e;
      };
      poly(f, shades[b], "rgba(255,255,255,0.13)");
    }
    // the skyline used for every number in the app
    ctx.beginPath();
    for (let x = 0; x <= W + step; x += step) {
      const az = v.az + ((x - W / 2) / W) * sp;
      const y = Y(horizonAt(prof, dip, az));
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 1;
    ctx.stroke();
  } else {
    poly(() => dip, "#1f2227", "rgba(255,255,255,0.7)");
  }

  // labels for the two bodies
  const tag = (az: number, el: number, r: number, label: string, color: string, hidden: boolean) => {
    const x = X(az), y = Y(el);
    if (x < -30 || x > W + 30) return;
    const cosel = Math.max(Math.cos(el * DEGR), 0.05);
    const yy = Math.min(H - 44, Math.max(14, y - r * ppdY - 12));
    ctx.textAlign = "center";
    ctx.fillStyle = color;
    ctx.font = '500 11px "Geist", system-ui, sans-serif';
    ctx.fillText(label, x, yy);
    ctx.font = '10px "Geist Mono", ui-monospace, monospace';
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText(hidden ? "behind terrain" : `${el.toFixed(2)}°`, x, yy + 12 > y - r * ppdY - 2 ? yy - 12 : yy + 12);
    void cosel;
  };
  tag(inst.sunAz, inst.sunEl, inst.sunR, "Sun", SUN, inst.sunFrac <= 0);
  tag(inst.earthAz, inst.earthEl, inst.earthR, "Earth", EARTH, inst.earthFrac <= 0);

  // compass along the bottom
  const stepAz = sp > 200 ? 45 : sp > 90 ? 15 : sp > 40 ? 10 : sp > 16 ? 5 : sp > 7 ? 2 : 1;
  ctx.textAlign = "center";
  for (let a = Math.ceil((v.az - sp / 2) / stepAz) * stepAz; a <= v.az + sp / 2; a += stepAz) {
    const x = Math.round(X(a)) + 0.5;
    const an = ((a % 360) + 360) % 360;
    const card = an % 90 === 0;
    ctx.strokeStyle = card ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.14)";
    ctx.beginPath();
    ctx.moveTo(x, H - (card ? 9 : 5));
    ctx.lineTo(x, H);
    ctx.stroke();
    ctx.fillStyle = card ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.36)";
    ctx.fillText(card ? ["N", "E", "S", "W"][an / 90] : `${an}°`, x, H - 17);
  }

  // hover read-out
  if (hover && !story) {
    const az = (((v.az + ((hover.x - W / 2) / W) * sp) % 360) + 360) % 360;
    const el = v.elMin + ((H - hover.y) / H) * (v.elMax - v.elMin);
    const hz = horizonAt(prof, dip, az);
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.beginPath();
    ctx.moveTo(Math.round(hover.x) + 0.5, 0);
    ctx.lineTo(Math.round(hover.x) + 0.5, H);
    ctx.stroke();
    let txt = `${compass(az)} ${az.toFixed(1)}°   ${deg(el)}   skyline ${deg(hz)}`;
    if (prof) {
      const i = Math.round((az / 360) * prof.azN) % prof.azN;
      const d = prof.dist[i];
      txt += d >= 1 ? `, set by terrain ${d.toFixed(d < 10 ? 1 : 0)} km away` : `, set by terrain ${Math.round(d * 1000)} m away`;
    }
    ctx.font = '10px "Geist Mono", ui-monospace, monospace';
    const tw = ctx.measureText(txt).width;
    const tx = Math.min(W - tw - 10, Math.max(8, hover.x + 10));
    ctx.fillStyle = "rgba(5,6,7,0.86)";
    ctx.fillRect(tx - 5, 30, tw + 10, 18);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.textAlign = "left";
    ctx.fillText(txt, tx, 39);
  }
}
