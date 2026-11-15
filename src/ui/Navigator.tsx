import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { compass, deg, fmtDayTime, fmtDur, fmtHours, fmtUTC, fromInputValue, pct, toInputValue } from "../lib/format";
import { Site, instantAt } from "../lib/sky";
import { TIER_LABEL, fmtLat, fmtLon } from "../lib/sites";
import { DAY, SiteWindows, buildWindows, computeSeries, metricsFor, nextEdge, sunOn } from "../lib/windows";
import { useApp } from "../store";
import { MoonView } from "./MoonView";
import { Panorama } from "./Panorama";
import { Timeline, niceStep } from "./Timeline";

const SPEEDS: [string, number][] = [["1 h/s", 3600], ["6 h/s", 21600], ["1 d/s", 86400], ["5 d/s", 432000]];

function SiteList() {
  const { sites, siteId, compareIds } = useApp();
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const m = new Map<string, Site[]>();
    for (const s of sites) {
      if (q && !s.name.toLowerCase().includes(q.toLowerCase())) continue;
      if (!m.has(s.group)) m.set(s.group, []);
      m.get(s.group)!.push(s);
    }
    const order = ["Your sites", "Artemis III candidate regions", "Polar landings and impacts", "Reference points", "Apollo", "Other landings"];
    return order.filter((g) => m.has(g)).map((g) => [g, m.get(g)!] as const);
  }, [sites, q]);
  return (
    <aside className="sites">
      <input className="search" placeholder="Search sites" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="site-scroll">
        {groups.map(([g, list]) => (
          <section key={g}>
            <h4>{g}</h4>
            {list.map((s) => {
              const st = s.stats2027?.["2"];
              return (
                <div key={s.id} className={`site ${s.id === siteId ? "sel" : ""}`} onClick={() => useApp.getState().selectSite(s.id)}>
                  <div className="nm">
                    <span>{s.name}</span>
                    {s.artemis2024 && <em title="On NASA's 2024 short list of nine regions">2024 list</em>}
                  </div>
                  <div className="meta">
                    <span>{fmtLat(s.lat, 2)} {fmtLon(s.lon, 2)}</span>
                    {st && <span className="num"><b className="sun">{Math.round(st.sun_avg)}%</b><b className="earth">{Math.round(st.earth_up)}%</b></span>}
                  </div>
                  <button
                    className={`cmp ${compareIds.includes(s.id) ? "on" : ""}`}
                    title={compareIds.includes(s.id) ? "Remove from comparison" : "Add to comparison"}
                    onClick={(e) => {
                      e.stopPropagation();
                      useApp.getState().toggleCompare(s.id);
                    }}
                  >
                    {compareIds.includes(s.id) ? "−" : "+"}
                  </button>
                </div>
              );
            })}
          </section>
        ))}
      </div>
      <CustomForm />
    </aside>
  );
}

function CustomForm() {
  const [lat, setLat] = useState("-89.45");
  const [lon, setLon] = useState("-137.3");
  const busy = useApp((s) => s.customBusy);
  const add = () => {
    const la = parseFloat(lat), lo = parseFloat(lon);
    if (!isFinite(la) || !isFinite(lo) || Math.abs(la) > 90) return;
    useApp.getState().addCustom(Math.max(-89.9999, Math.min(89.9999, la)), ((lo + 540) % 360) - 180);
  };
  return (
    <div className="custom">
      <h4>Any point on the Moon</h4>
      <div className="row">
        <label>Lat<input value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" /></label>
        <label>Lon E<input value={lon} onChange={(e) => setLon(e.target.value)} inputMode="decimal" /></label>
        <button className="btn" onClick={add} disabled={busy}>{busy ? "…" : "Add"}</button>
      </div>
      <p>South of 80°S the horizon is computed live from LOLA terrain. You can also drop a pin on the 3D view.</p>
    </div>
  );
}

function Row({ k, v, sub }: { k: string; v: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="kv">
      <span>{k}</span>
      <b>{v}</b>
      {sub && <i>{sub}</i>}
    </div>
  );
}

function Readout({ site, win }: { site: Site; win: SiteWindows | null }) {
  const { t, mastIdx, rules, mission } = useApp();
  const inst = useMemo(() => instantAt(site, mastIdx, t), [site, site.profiles, mastIdx, t]);
  const power = sunOn(inst.sunFrac, rules);
  const link = inst.earthMargin >= rules.commMargin;
  const pe = win ? nextEdge(win.power, t) : null;
  const ce = win ? nextEdge(win.comm, t) : null;
  const m = useMemo(() => (win ? metricsFor(win, t, Math.min(t + mission.durationD * DAY, win.series.t0 + (win.series.n - 1) * win.series.dt)) : null), [win, Math.floor(t / 600e3), mission.durationD]);
  const edge = (e: { on: boolean; at: number | null } | null, onTxt: string, offTxt: string) =>
    !e ? "" : e.at === null ? (e.on ? `${onTxt} past the end of the timeline` : `No ${offTxt} on this timeline`) : `${e.on ? onTxt : offTxt} in ${fmtDur(e.at - t)}`;
  const sunLine = inst.sunFrac >= 0.999 ? "The whole Sun is clear of the terrain." : inst.sunFrac > 0 ? `${pct(inst.sunFrac)} of the Sun shows above the terrain.` : inst.sunEl > inst.sunHorizon - 1 ? "The Sun is just behind the skyline." : "The Sun is down.";
  const earthLine = link ? "Earth is in view, so a direct radio link works." : inst.earthFrac > 0 ? "Earth is partly hidden. The link is marginal." : "Earth is hidden. No direct link right now.";
  return (
    <aside className="read">
      <header>
        <h2>{site.name}</h2>
        <div className="where">
          {fmtLat(site.lat)} {fmtLon(site.lon)}
          {site.elev_m !== null && site.tier !== "sphere" ? ` · ${Math.round(site.elev_m).toLocaleString()} m` : ""}
        </div>
        <div className="tier"><span className={`dot ${site.tier}`} />{TIER_LABEL[site.tier]}</div>
        <p className="note">{site.note}</p>
      </header>
      <div className="plain">
        <p>{sunLine}</p>
        <p>{earthLine}</p>
      </div>
      <section>
        <h4 className="sun">Sun <em>{power ? "Power" : "No power"}</em></h4>
        <Row k="Elevation" v={deg(inst.sunEl)} sub={`skyline ${deg(inst.sunHorizon)}`} />
        <Row k="Azimuth" v={deg(inst.sunAz, 1)} sub={compass(inst.sunAz)} />
        <Row k="Disk visible" v={pct(inst.sunFrac)} sub={`${Math.round(inst.flux).toLocaleString()} W/m²`} />
        <p className="edge">{edge(pe, "Power ends", "Power returns")}{pe?.at ? <span>{fmtDayTime(pe.at)}</span> : null}</p>
      </section>
      <section>
        <h4 className="earth">Earth <em>{link ? "Direct link" : "No link"}</em></h4>
        <Row k="Elevation" v={deg(inst.earthEl)} sub={`skyline ${deg(inst.earthHorizon)}`} />
        <Row k="Azimuth" v={deg(inst.earthAz, 1)} sub={compass(inst.earthAz)} />
        <Row k="Clearance" v={`${inst.earthMargin >= 0 ? "+" : ""}${inst.earthMargin.toFixed(2)}°`} sub={`${pct(inst.earthFrac)} of disk`} />
        <p className="edge">{edge(ce, "Link ends", "Link returns")}{ce?.at ? <span>{fmtDayTime(ce.at)}</span> : null}</p>
      </section>
      {m && (
        <section>
          <h4>A {mission.durationD}-day stay from this moment</h4>
          <Row k="Time with power" v={pct(m.powerPct)} sub={`longest gap ${fmtHours(m.longestDarkH)}`} />
          <Row k="Time with link" v={pct(m.commPct)} sub={`longest gap ${fmtHours(m.longestOutageH)}`} />
          <Row k="Solar energy" v={`${Math.round(m.energy).toLocaleString()} kWh/m²`} sub="Sun-facing panel" />
        </section>
      )}
      <footer>
        {inst.src === 0 ? "Sun and Earth from JPL DE440 (SPICE)." : "Outside 2020 to 2050: analytic model, good to a few hundredths of a degree."}
      </footer>
    </aside>
  );
}

export function Navigator() {
  const { sites, siteId, mastIdx, t, playing, speed, spanD, rules, mission, horizonTick } = useApp();
  const site = sites.find((s) => s.id === siteId) ?? sites[0];
  const set = useApp.getState().set;
  const [w0, setW0] = useState(() => Math.floor((Date.now() - 2 * DAY) / DAY) * DAY);
  const span = spanD * DAY;

  // keep the cursor inside the timeline window
  useEffect(() => {
    if (t < w0 + span * 0.02 || t > w0 + span * 0.98) setW0(Math.floor((t - span * 0.15) / DAY) * DAY);
  }, [t, span, w0]);

  const win = useMemo(() => {
    if (!site) return null;
    const series = computeSeries(site, Math.min(mastIdx, site.masts.length - 1), w0, w0 + span, niceStep(spanD));
    return buildWindows(site, series, rules);
  }, [site, site?.profiles, mastIdx, w0, span, rules, horizonTick]);

  const onScrub = useCallback((tt: number) => useApp.getState().set({ t: tt, playing: false }), []);

  // space bar plays and pauses
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        useApp.getState().set({ playing: !useApp.getState().playing });
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  if (!site) return null;
  const mi = Math.min(mastIdx, site.masts.length - 1);
  return (
    <div className="nav">
      <details className="sitesbox">
        <summary><span className="burger">☰</span><b>{site.name}</b><i>Tap to choose a site or add your own point</i></summary>
        <SiteList />
      </details>
      <main className="stage">
        <MoonView />
        <div className="controls">
          <button className="btn play" onClick={() => set({ playing: !playing })}>{playing ? "❚❚ Pause" : "▶ Play"}</button>
          <details className="more left">
            <summary>Speed {SPEEDS.find((x) => x[1] === speed)?.[0]}</summary>
            <div className="more-body one">
          <div className="seg">
            {SPEEDS.map(([l, v]) => (
              <button key={l} className={speed === v ? "on" : ""} onClick={() => set({ speed: v })}>{l}</button>
            ))}
          </div>
            </div>
          </details>
          <details className="more left">
            <summary>{new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC</summary>
            <div className="more-body one">
          <input className="dt" type="datetime-local" value={toInputValue(t)} onChange={(e) => { const v = fromInputValue(e.target.value); if (isFinite(v)) set({ t: v, playing: false }); }} />
          <span className="utc">UTC</span>
          <button className="btn" onClick={() => set({ t: Date.now(), playing: false })}>Now</button>
            </div>
          </details>
          <span className="sp" />
          <details className="more">
            <summary>Timeline {spanD === 365 ? "1 yr" : spanD + " d"}</summary>
            <div className="more-body one">
          <div className="seg">
            {[7, 30, 90, 365].map((d) => (
              <button key={d} className={spanD === d ? "on" : ""} onClick={() => set({ spanD: d })}>{d === 365 ? "1 yr" : `${d} d`}</button>
            ))}
          </div>
            </div>
          </details>
          <details className="more">
            <summary>⚙ Settings</summary>
            <div className="more-body">
          <label className="lbl">Mast height</label>
          <div className="seg">
            {site.masts.map((m, i) => (
              <button key={m} className={mi === i ? "on" : ""} onClick={() => set({ mastIdx: i })}>{m} m</button>
            ))}
          </div>
          <label className="lbl">Power needs</label>
          <div className="seg">
            {[[0.01, "any Sun"], [0.5, "half disk"], [0.99, "full disk"]].map(([v, l]) => (
              <button key={l} className={rules.sunMin === v ? "on" : ""} onClick={() => set({ rules: { ...rules, sunMin: v as number } })}>{l}</button>
            ))}
          </div>
          <label className="lbl">Link margin</label>
          <div className="seg">
            {[0, 1, 2, 5].map((v) => (
              <button key={v} className={rules.commMargin === v ? "on" : ""} onClick={() => set({ rules: { ...rules, commMargin: v } })}>{v}°</button>
            ))}
          </div>
          <label className="lbl">Stay</label>
          <div className="seg">
            {[6, 10, 14, 30].map((v) => (
              <button key={v} className={mission.durationD === v ? "on" : ""} onClick={() => set({ mission: { ...mission, durationD: v } })}>{v} d</button>
            ))}
          </div>
            </div>
          </details>
        </div>
        <Panorama site={site} mastIdx={mi} t={t} />
      </main>
      <Readout site={site} win={win} />
      <div className="bar">
        <Timeline win={win} t={t} mission={mission} onScrub={onScrub} />
      </div>
    </div>
  );
}
