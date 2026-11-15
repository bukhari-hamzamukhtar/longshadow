// Power and comm windows over time, with a scrubber.
import { useEffect, useRef, useState } from "react";
import { fmtDay } from "../lib/format";
import { DAY, HOUR, Interval, Mission, SiteWindows } from "../lib/windows";

const SUN = "#ffb224";
const EARTH = "#b9cdf5";

export function Timeline({ win, t, mission, onScrub }: { win: SiteWindows | null; t: number; mission: Mission; onScrub: (t: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 150 });

  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const r = box.current!.getBoundingClientRect();
      setSize({ w: Math.max(200, Math.floor(r.width)), h: Math.max(100, Math.floor(r.height)) });
    });
    ro.observe(box.current!);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const cv = ref.current!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { w: W, h: H } = size;
    if (cv.width !== W * dpr || cv.height !== H * dpr) {
      cv.width = W * dpr;
      cv.height = H * dpr;
    }
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!win) return;
    const s = win.series;
    const a = s.t0, b = s.t0 + (s.n - 1) * s.dt;
    const L = 78, Rr = 12;
    const X = (tt: number) => L + ((tt - a) / (b - a)) * (W - L - Rr);
    ctx.font = '10px "Geist Mono", ui-monospace, monospace';
    ctx.textBaseline = "middle";

    // day grid
    const span = b - a;
    const tick = span > 200 * DAY ? 30 * DAY : span > 60 * DAY ? 7 * DAY : span > 20 * DAY ? 2 * DAY : DAY;
    const first = Math.ceil(a / DAY) * DAY;
    ctx.textAlign = "center";
    if (tick >= 30 * DAY) {
      const d = new Date(a);
      d.setUTCDate(1);
      d.setUTCHours(0, 0, 0, 0);
      for (let k = 0; k < 14; k++) {
        const tt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1);
        if (tt < a || tt > b) continue;
        const x = Math.round(X(tt)) + 0.5;
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.beginPath();
        ctx.moveTo(x, 16);
        ctx.lineTo(x, H);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.fillText(fmtDay(tt).slice(2), x + 16, 8);
      }
    } else {
      for (let tt = first; tt <= b; tt += DAY) {
        const major = Math.round(tt / DAY) % Math.round(tick / DAY) === 0;
        const x = Math.round(X(tt)) + 0.5;
        ctx.strokeStyle = major ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.03)";
        ctx.beginPath();
        ctx.moveTo(x, 16);
        ctx.lineTo(x, H);
        ctx.stroke();
        if (major) {
          ctx.fillStyle = "rgba(255,255,255,0.45)";
          ctx.fillText(fmtDay(tt), x, 8);
        }
      }
    }

    const laneH = (H - 22 - 26) / 2;
    const y1 = 22, y2 = 22 + laneH + 14;
    const label = (txt: string, sub: string, y: number, color: string) => {
      ctx.textAlign = "left";
      ctx.fillStyle = color;
      ctx.font = '500 11px "Geist", system-ui, sans-serif';
      ctx.fillText(txt, 0, y + 8);
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.font = '10px "Geist Mono", ui-monospace, monospace';
      ctx.fillText(sub, 0, y + 22);
    };
    label("Sun", "disk visible", y1, SUN);
    label("Earth", "above skyline", y2, EARTH);

    // Sun: share of the disk above the terrain
    const area = (vals: Float32Array, y: number, h: number, lo: number, hi: number, fill: string, stroke: string) => {
      ctx.beginPath();
      const zero = y + h - ((0 - lo) / (hi - lo)) * h;
      ctx.moveTo(X(a), zero);
      const stride = Math.max(1, Math.floor(s.n / (W * 1.5)));
      for (let i = 0; i < s.n; i += stride) {
        const vv = Math.min(hi, Math.max(lo, vals[i]));
        ctx.lineTo(X(a + i * s.dt), y + h - ((vv - lo) / (hi - lo)) * h);
      }
      ctx.lineTo(X(b), zero);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    };
    area(s.sunFrac, y1, laneH - 8, 0, 1, "rgba(255,178,36,0.20)", "rgba(255,178,36,0.75)");
    // Earth: centre height above the local skyline, clipped to a readable range
    const eLo = -4, eHi = 8;
    const zeroY = y2 + (laneH - 8) - ((0 - eLo) / (eHi - eLo)) * (laneH - 8);
    ctx.save();
    ctx.beginPath();
    ctx.rect(L, y2, W - L - Rr, zeroY - y2);
    ctx.clip();
    area(s.earthMargin, y2, laneH - 8, eLo, eHi, "rgba(185,205,245,0.18)", "rgba(185,205,245,0.75)");
    ctx.restore();
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.beginPath();
    ctx.moveTo(L, Math.round(zeroY) + 0.5);
    ctx.lineTo(W - Rr, Math.round(zeroY) + 0.5);
    ctx.stroke();

    // window bars
    const bars = (ivs: Interval[], y: number, color: string) => {
      ctx.fillStyle = color;
      for (const iv of ivs) {
        const x0 = X(Math.max(iv.a, a)), x1 = X(Math.min(iv.b, b));
        ctx.fillRect(x0, y, Math.max(1, x1 - x0), 4);
      }
    };
    bars(win.power, y1 + laneH - 4, SUN);
    bars(win.comm, y2 + laneH - 4, EARTH);

    // surface stay bracket and cursor
    if (t >= a && t <= b) {
      const x = Math.round(X(t)) + 0.5;
      const xe = Math.min(W - Rr, X(t + mission.durationD * DAY));
      ctx.fillStyle = "rgba(255,255,255,0.045)";
      ctx.fillRect(x, 16, xe - x, H - 16);
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(xe) + 0.5, 16);
      ctx.lineTo(Math.round(xe) + 0.5, H);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = "#fff";
      ctx.beginPath();
      ctx.moveTo(x, 12);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.moveTo(x - 4, 12);
      ctx.lineTo(x + 4, 12);
      ctx.lineTo(x, 18);
      ctx.closePath();
      ctx.fill();
    }
  }, [win, t, size, mission.durationD]);

  useEffect(() => {
    const cv = ref.current!;
    let down = false;
    const at = (e: PointerEvent) => {
      if (!win) return;
      const r = cv.getBoundingClientRect();
      const s = win.series;
      const a = s.t0, b = s.t0 + (s.n - 1) * s.dt;
      const f = Math.min(1, Math.max(0, (e.clientX - r.left - 78) / (r.width - 78 - 12)));
      onScrub(Math.round((a + f * (b - a)) / (5 * 60e3)) * 5 * 60e3);
    };
    const pd = (e: PointerEvent) => {
      down = true;
      cv.setPointerCapture(e.pointerId);
      at(e);
    };
    const pm = (e: PointerEvent) => down && at(e);
    const pu = () => (down = false);
    cv.addEventListener("pointerdown", pd);
    cv.addEventListener("pointermove", pm);
    cv.addEventListener("pointerup", pu);
    return () => {
      cv.removeEventListener("pointerdown", pd);
      cv.removeEventListener("pointermove", pm);
      cv.removeEventListener("pointerup", pu);
    };
  }, [win, onScrub]);

  return (
    <div className="tl" ref={box}>
      <canvas ref={ref} style={{ width: size.w, height: size.h }} />
    </div>
  );
}

export function niceStep(spanD: number): number {
  if (spanD <= 8) return 5 * 60e3;
  if (spanD <= 35) return 15 * 60e3;
  if (spanD <= 100) return 30 * 60e3;
  return 2 * HOUR;
}
