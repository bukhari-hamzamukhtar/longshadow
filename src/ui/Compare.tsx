// Compare sites and landing dates: which site still works if the date slips?
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtDay, fmtHours, pct } from "../lib/format";
import { Site } from "../lib/sky";
import { ensureHorizon } from "../lib/sites";
import { DAY, HOUR, Mission, Scan, SiteWindows, buildWindows, computeSeries, landingWindows, metricsFor, scanLandings } from "../lib/windows";
import { useApp } from "../store";

const YEAR = 365 * DAY;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function Strip({ scan, from, t, onPick }: { scan: Scan; from: number; t: number; onPick: (t: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(600);
  const [hov, setHov] = useState<number | null>(null);
  useEffect(() => {
    const ro = new ResizeObserver(() => setW(Math.max(120, Math.floor(ref.current!.parentElement!.getBoundingClientRect().width))));
    ro.observe(ref.current!.parentElement!);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const cv = ref.current!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const H = 26;
    cv.width = w * dpr;
    cv.height = H * dpr;
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, H);
    const n = Math.min(scan.n, Math.floor(YEAR / scan.step));
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor((x / w) * n), i1 = Math.max(i0 + 1, Math.floor(((x + 1) / w) * n));
      let ok = 0, sc = 0;
      for (let i = i0; i < i1 && i < n; i++) {
        ok += scan.ok[i];
        sc += scan.score[i];
      }
      const c = i1 - i0;
      if (ok * 2 >= c) ctx.fillStyle = "#eceae4";
      else {
        const v = Math.round(18 + (sc / c) * 46);
        ctx.fillStyle = `rgb(${v},${v + 1},${v + 4})`;
      }
      ctx.fillRect(x, 4, 1, H - 8);
    }
    const mark = (tt: number, color: string) => {
      if (tt < from || tt > from + YEAR) return;
      const x = Math.round(((tt - from) / YEAR) * w) + 0.5;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    };
    mark(t, "#ffb224");
    if (hov !== null) mark(hov, "rgba(255,255,255,0.6)");
  }, [scan, w, from, t, hov]);
  const at = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return from + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * YEAR;
  };
  return (
    <div className="strip" title="Click a date to test a landing on that day">
      <canvas ref={ref} style={{ width: w, height: 26 }} onMouseMove={(e) => setHov(at(e))} onMouseLeave={() => setHov(null)} onClick={(e) => onPick(Math.round(at(e) / HOUR) * HOUR)} />
    </div>
  );
}

function Axis({ from }: { from: number }) {
  const ticks: { x: number; label: string }[] = [];
  const d = new Date(from);
  for (let k = 0; k < 13; k++) {
    const tt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1);
    if (tt < from || tt > from + YEAR) continue;
    const m = new Date(tt);
    ticks.push({ x: (tt - from) / YEAR, label: `${MONTHS[m.getUTCMonth()]}${m.getUTCMonth() === 0 ? " " + m.getUTCFullYear() : ""}` });
  }
  return (
    <div className="axis">
      {ticks.map((k) => (
        <span key={k.label + k.x} style={{ left: `${k.x * 100}%` }}>{k.label}</span>
      ))}
    </div>
  );
}

function Choice<T extends number | boolean>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="choice">
      <span>{label}</span>
      <div className="seg">
        {options.map(([v, l]) => (
          <button key={l} className={v === value ? "on" : ""} onClick={() => onChange(v)}>{l}</button>
        ))}
      </div>
    </div>
  );
}

interface RowData {
  key: string;
  win: SiteWindows;
}

export function Compare() {
  const { sites, compareIds, mastIdx, rules, mission, t, horizonTick } = useApp();
  const set = useApp.getState().set;
  const [from] = useState(() => Math.floor(Date.now() / DAY) * DAY);
  const [rows, setRows] = useState<Record<string, RowData>>({});
  const cache = useRef(new Map<string, SiteWindows>());
  const [sortBy, setSortBy] = useState<"open" | "list">("open");
  const [adding, setAdding] = useState(false);
  const list = useMemo(() => compareIds.map((id) => sites.find((s) => s.id === id)).filter(Boolean) as Site[], [compareIds, sites]);
  const keyOf = (s: Site) => `${s.id}|${Math.min(mastIdx, s.masts.length - 1)}|${from}|${rules.sunMin}|${rules.commMargin}`;

  useEffect(() => {
    let live = true;
    (async () => {
      for (const s of list) {
        const key = keyOf(s);
        if (!cache.current.has(key)) {
          await ensureHorizon(s).catch(() => {});
          await new Promise((r) => setTimeout(r, 0));
          if (!live) return;
          const series = computeSeries(s, Math.min(mastIdx, s.masts.length - 1), from, from + YEAR + 32 * DAY, 30 * 60e3);
          cache.current.set(key, buildWindows(s, series, rules, false));
        }
        if (!live) return;
        const win = cache.current.get(key)!;
        setRows((d) => (d[s.id]?.key === key ? d : { ...d, [s.id]: { key, win } }));
      }
    })();
    return () => {
      live = false;
    };
  }, [list, mastIdx, from, rules, horizonTick]);

  const tRef = Math.min(Math.max(t, from), from + YEAR);
  const table = useMemo(() => {
    const out = list.map((s) => {
      const r = rows[s.id];
      if (!r || r.key !== keyOf(s)) return { site: s, ready: false as const };
      const scan = scanLandings(r.win, mission, 2 * HOUR);
      const nYear = Math.min(scan.n, Math.floor(YEAR / scan.step));
      let open = 0;
      for (let i = 0; i < nYear; i++) open += scan.ok[i];
      const wins = landingWindows(scan);
      const next = wins.find((w) => w.b >= tRef) ?? null;
      const m = metricsFor(r.win, from, from + YEAR);
      const i = Math.min(scan.n - 1, Math.max(0, Math.round((tRef - scan.t0) / scan.step)));
      return {
        site: s, ready: true as const, scan, openDays: (open * scan.step) / DAY, openPct: open / Math.max(1, nYear), next, m,
        at: { ok: scan.ok[i] === 1, power: scan.powerPct[i], dark: scan.darkH[i], comm: scan.commPct[i], outage: scan.outageH[i] },
      };
    });
    if (sortBy === "open") out.sort((a, b) => (b.ready ? b.openDays : -1) - (a.ready ? a.openDays : -1));
    return out;
  }, [list, rows, mission, tRef, sortBy]);

  const setM = (p: Partial<Mission>) => set({ mission: { ...mission, ...p } });
  const others = sites.filter((s) => !compareIds.includes(s.id) && s.tier !== "sphere");
  const best = table.find((r) => r.ready && r.at.ok);

  return (
    <div className="cmp-page">
      <header className="cmp-head">
        <h1>Which site still works if the landing date slips?</h1>
        <p>
          Set what the mission needs. Each bar is one year of possible landing dates. A light stretch means a landing on that day meets every
          requirement for the whole stay.
        </p>
      </header>
      <div className="cmp-mission">
        <Choice label="Surface stay" value={mission.durationD} options={[[6, "6 d"], [10, "10 d"], [14, "14 d"], [30, "30 d"]]} onChange={(v) => setM({ durationD: v })} />
        <Choice label="Survives without power" value={mission.maxDarkH} options={[[6, "6 h"], [12, "12 h"], [24, "24 h"], [72, "3 d"], [150, "6 d"]]} onChange={(v) => setM({ maxDarkH: v })} />
        <Choice label="Power at least" value={mission.minPowerPct} options={[[0.5, "50%"], [0.7, "70%"], [0.8, "80%"], [0.9, "90%"]]} onChange={(v) => setM({ minPowerPct: v })} />
        <Choice label="Direct link to Earth" value={mission.needComm} options={[[true, "Needed"], [false, "Not needed"]]} onChange={(v) => setM({ needComm: v })} />
        {mission.needComm && (
          <>
            <Choice label="Link at least" value={mission.minCommPct} options={[[0.25, "25%"], [0.5, "50%"], [0.9, "90%"]]} onChange={(v) => setM({ minCommPct: v })} />
            <Choice label="Longest outage" value={mission.maxOutageH} options={[[12, "12 h"], [24, "24 h"], [72, "3 d"], [240, "10 d"]]} onChange={(v) => setM({ maxOutageH: v })} />
          </>
        )}
        <Choice label="Panel and antenna height" value={mastIdx} options={[[0, "2 m"], [1, "10 m"]]} onChange={(v) => set({ mastIdx: v })} />
      </div>
      <div className="cmp-verdict">
        <span className="num">{fmtDay(tRef, true)}</span>
        {best ? (
          <>A landing on this day works at <b>{table.filter((r) => r.ready && r.at.ok).length}</b> of {table.length} sites. Best open choice: <b>{best.site.name}</b>.</>
        ) : (
          <>No site in the list meets every requirement for a landing on this day. Click another date on any bar.</>
        )}
      </div>
      <div className="cmp-table">
        <div className="cmp-row head">
          <div className="c-site">
            <button className="link" onClick={() => setSortBy(sortBy === "open" ? "list" : "open")}>Site {sortBy === "open" ? "(most open days first)" : ""}</button>
          </div>
          <div className="c-cal"><Axis from={from} /></div>
          <div className="c-num">Open landing days</div>
          <div className="c-num">Next window</div>
          <div className="c-at">Stay from {fmtDay(tRef)}</div>
        </div>
        {table.map((r) => (
          <div className="cmp-row" key={r.site.id}>
            <div className="c-site">
              <button className="link name" onClick={() => { useApp.getState().selectSite(r.site.id); useApp.getState().go("app"); }} title="Open in the navigator">{r.site.name}</button>
              <span className="sub num">
                {r.ready ? <><b className="sun">{pct(r.m.sunAvg)}</b> sun · <b className="earth">{pct(r.m.commPct)}</b> link</> : "computing"}
              </span>
              <button className="x" title="Remove" onClick={() => useApp.getState().toggleCompare(r.site.id)}>×</button>
            </div>
            <div className="c-cal">{r.ready ? <Strip scan={r.scan} from={from} t={tRef} onPick={(tt) => set({ t: tt, playing: false })} /> : <div className="strip wait" />}</div>
            <div className="c-num num">{r.ready ? <><b>{Math.round(r.openDays)} d</b><i>{pct(r.openPct)}</i></> : ""}</div>
            <div className="c-num num">{r.ready ? (r.next ? <><b>{fmtDay(Math.max(r.next.a, tRef))}</b><i>to {fmtDay(r.next.b)}</i></> : <i>none this year</i>) : ""}</div>
            <div className="c-at num">
              {r.ready && (
                <>
                  <span className={`dot ${r.at.ok ? "" : "sphere"}`} />
                  <span>{pct(r.at.power)} power, gap {fmtHours(r.at.dark)}</span>
                  <i>{pct(r.at.comm)} link, gap {fmtHours(r.at.outage)}</i>
                </>
              )}
            </div>
          </div>
        ))}
        <div className="cmp-add">
          <button className="btn" onClick={() => setAdding(!adding)}>{adding ? "Done" : "Add a site"}</button>
          {adding && others.map((s) => (
            <button key={s.id} className="btn" onClick={() => useApp.getState().toggleCompare(s.id)}>{s.name}</button>
          ))}
        </div>
      </div>
      <p className="cmp-foot">
        Power counts when at least {rules.sunMin >= 0.99 ? "the full" : rules.sunMin <= 0.02 ? "any part of the" : "half of the"} solar disk clears the terrain.
        The link counts when the centre of Earth is at least {rules.commMargin}° above the skyline. Change both in the navigator.
        Terrain: NASA LOLA. Sun and Earth: JPL DE440.
      </p>
    </div>
  );
}
