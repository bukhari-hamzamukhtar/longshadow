// The story page: why the lunar south pole is hard, shown with the real data.
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtDay } from "../lib/format";
import { Site } from "../lib/sky";
import { DAY, HOUR, buildWindows, computeSeries, DEFAULT_RULES } from "../lib/windows";
import { useApp } from "../store";
import { MoonView } from "./MoonView";
import { Panorama } from "./Panorama";

/** true once the element has been on screen; `now` while it is on screen */
function useSeen<T extends HTMLElement>(margin = "-15% 0px") {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  const [now, setNow] = useState(false);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => {
      setNow(e.isIntersecting);
      if (e.isIntersecting) setSeen(true);
    }, { rootMargin: margin });
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, [margin]);
  return { ref, seen, now };
}

/** a clock that runs only while `on` is true */
function useClock(on: boolean, start: number, rate: number, loop: number) {
  const [t, setT] = useState(start);
  useEffect(() => {
    if (!on) return;
    let raf = 0, last = performance.now();
    const f = (n: number) => {
      const dt = Math.min(0.1, (n - last) / 1000);
      last = n;
      setT((v) => (v + dt * rate * 1000 > start + loop ? start : v + dt * rate * 1000));
      raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, [on, start, rate, loop]);
  return t;
}

function Story({ kicker, title, children, visual, flip = false }: { kicker: string; title: string; children: React.ReactNode; visual: (on: boolean) => React.ReactNode; flip?: boolean }) {
  const { ref, seen, now } = useSeen<HTMLElement>();
  return (
    <section ref={ref} className={`story ${seen ? "in" : ""} ${flip ? "flip" : ""}`}>
      <div className="story-text">
        <span className="kicker">{kicker}</span>
        <h2>{title}</h2>
        {children}
      </div>
      <div className="story-visual">{visual(now)}</div>
    </section>
  );
}

function SunStory({ site, on }: { site: Site; on: boolean }) {
  const start = useMemo(() => Math.floor(Date.now() / DAY) * DAY, []);
  const t = useClock(on, start, 9 * 3600, 29.5 * DAY);
  const win = useMemo(() => (site.profiles ? buildWindows(site, computeSeries(site, 0, start, start + 30 * DAY, HOUR), DEFAULT_RULES, false) : null), [site, site.profiles, start]);
  const lit = win ? win.power.some((iv) => t >= iv.a && t <= iv.b) : false;
  return (
    <div className="story-frame">
      <Panorama site={site} mastIdx={0} t={t} story face="sun" />
      <div className="story-cap">
        <span>{site.name}</span>
        <span className="num">{fmtDay(t)}</span>
        <span className={lit ? "sun" : ""}>{lit ? "Power" : "No power"}</span>
      </div>
    </div>
  );
}

function EarthStory({ site, on }: { site: Site; on: boolean }) {
  const start = useMemo(() => Math.floor(Date.now() / DAY) * DAY, []);
  const t = useClock(on, start, 14 * 3600, 27.3 * DAY);
  const win = useMemo(() => (site.profiles ? buildWindows(site, computeSeries(site, 0, start, start + 28 * DAY, HOUR), DEFAULT_RULES, false) : null), [site, site.profiles, start]);
  const link = win ? win.comm.some((iv) => t >= iv.a && t <= iv.b) : false;
  return (
    <div className="story-frame">
      <Panorama site={site} mastIdx={0} t={t} story face="earth" />
      <div className="story-cap">
        <span>{site.name}</span>
        <span className="num">{fmtDay(t)}</span>
        <span className={link ? "earth" : ""}>{link ? "Direct link to Earth" : "No link"}</span>
      </div>
    </div>
  );
}

function Bars({ rows }: { rows: { label: string; sub: string; v: number }[] }) {
  return (
    <div className="bars">
      {rows.map((r) => (
        <div key={r.label + r.sub} className="bar-row">
          <div className="bl"><b>{r.label}</b><i>{r.sub}</i></div>
          <div className="bt"><span style={{ width: `${Math.max(0.5, r.v)}%` }} /></div>
          <div className="bv num">{r.v.toFixed(0)}%</div>
        </div>
      ))}
    </div>
  );
}

export function Landing() {
  const { sites, ready, horizonTick } = useApp();
  const go = useApp.getState().go;
  const [val, setVal] = useState<{ worst?: number; inside?: number; total?: number }>({});
  const heroStart = useMemo(() => Math.floor(Date.now() / DAY) * DAY, []);
  const hero = useSeen<HTMLElement>("0px");
  const tHero = useClock(hero.now, heroStart, 5 * 3600, 60 * DAY);
  useEffect(() => {
    Promise.all([fetch("/data/validation/horizons.json").then((r) => r.json()), fetch("/data/validation/barker2021.json").then((r) => r.json())])
      .then(([h, b]) => setVal({ worst: h.worst_arcsec, inside: b.inside, total: b.total }))
      .catch(() => {});
  }, []);
  const by = (id: string) => sites.find((s) => s.id === id);
  const sunSite = by("im2-athena"), earthSite = by("shackleton-rim");
  const ridge = by("connecting-ridge"), rim = by("shackleton-rim"), pole = by("south-pole"), cabeus = by("lcross");
  void horizonTick;
  const bars = [ridge, rim, pole, cabeus].filter((s): s is Site => !!s && !!s.stats2027).map((s) => ({ label: s.name, sub: "2 m above ground", v: s.stats2027!["2"].sun_avg }));
  const mast = ridge?.stats2027 ? [
    { label: "Panels 2 m up", sub: `longest dark spell ${ridge.stats2027["2"].longest_dark_d} days`, v: ridge.stats2027["2"].sun_avg },
    { label: "Panels 10 m up", sub: `longest dark spell ${ridge.stats2027["10"].longest_dark_d} days`, v: ridge.stats2027["10"].sun_avg },
  ] : [];

  return (
    <div className="home">
      <section className="hero" ref={hero.ref}>
        <div className="hero-bg">{hero.now && <MoonView hero time={tHero} />}</div>
        <div className="hero-shade" />
        <div className="hero-text">
          <span className="kicker">NASA Space Apps Challenge 2026 · Lunar Landing Site Navigator</span>
          <h1>Longshadow</h1>
          <p>See where the Sun and Earth sit above the real horizon, at any landing site on the Moon, on any date.</p>
          <div className="cta">
            <button className="btn big" onClick={() => go("app")}>Open the navigator</button>
            <button className="btn big ghost" onClick={() => go("compare")}>Compare sites and dates</button>
          </div>
        </div>
        <div className="hero-facts">
          <div><b className="num">{val.worst !== undefined ? `${val.worst}″` : "…"}</b><span>largest gap to JPL Horizons, Sun and Earth angles</span></div>
          <div><b className="num">5 m</b><span>NASA LOLA terrain around the Artemis III candidate regions</span></div>
          <div><b className="num">{sites.length || 29}</b><span>sites ready, plus any point you pick, 2020 to 2050</span></div>
        </div>
        <div className="hero-note">Live render: LOLA terrain, shadows cast toward the true Sun position, {fmtDay(tHero, true)}</div>
      </section>

      <Story kicker="The problem" title="At the south pole the Sun circles the horizon all year." visual={(on) => (ready && sunSite ? <SunStory site={sunSite} on={on} /> : <div className="story-frame wait" />)}>
        <p>The Moon is tilted by only 1.5 degrees. So near the poles the Sun stays right on the horizon and slides along it once a month.</p>
        <p>Every hill on the skyline can block it. Solar power comes and goes with the terrain. This is the real skyline at the IM-2 landing site, drawn from NASA laser altimeter data.</p>
      </Story>

      <Story flip kicker="The other problem" title="Earth sits low too, and it drifts." visual={(on) => (ready && earthSite ? <EarthStory site={earthSite} on={on} /> : <div className="story-frame wait" />)}>
        <p>From the Moon, Earth hangs in almost the same spot of the sky. But it wobbles up and down by about 6 degrees every month.</p>
        <p>Near the pole that is enough to drop it behind the hills. When Earth is hidden there is no direct radio link, and a lander is on its own.</p>
      </Story>

      <Story kicker="Why site choice is hard" title="A short walk changes everything." visual={() => (<div className="story-frame pad"><Bars rows={bars} /><div className="bars-gap" /><Bars rows={mast} /><div className="story-cap"><span>Share of the year 2027 with sunlight</span><span>Connecting Ridge, two panel heights</span></div></div>)}>
        <p>Two spots a few kilometres apart can get very different light. The rim of Shackleton crater is lit most of the year. The pole itself, on the crater wall next to it, is mostly dark. The LCROSS impact site never sees the Sun at all.</p>
        <p>Height matters as well. Lifting the panels from 2 m to 10 m at the same spot removes most of the dark spells.</p>
      </Story>

      <section className="how">
        <span className="kicker">How it works</span>
        <h2>Four steps, all from open NASA data.</h2>
        <div className="steps">
          <div><i>1</i><h3>Sun and Earth</h3><p>Positions come from JPL's DE440 ephemeris through NASA's SPICE toolkit, in the same Moon frame as the terrain maps. Light travel time and aberration are included.</p></div>
          <div><i>2</i><h3>Terrain</h3><p>LOLA elevation maps from the Lunar Reconnaissance Orbiter: 5 m per pixel around the candidate regions, 20 m down to 80°S, 240 m beyond.</p></div>
          <div><i>3</i><h3>Skyline</h3><p>From each site we send out 1,440 rays, up to 500 km long, over the curved Moon. The highest terrain along each ray sets the skyline in that direction.</p></div>
          <div><i>4</i><h3>Windows</h3><p>We clip the Sun and Earth disks with that skyline every few minutes. That gives the exact times when power and the radio link start and stop.</p></div>
        </div>
        <div className="checks">
          <div><b className="num">{val.worst !== undefined ? `${val.worst}″` : "…"}</b><span>worst difference to JPL Horizons over 8 sites and one year. That is 0.00003 degrees.</span></div>
          <div><b className="num">{val.inside !== undefined ? `${val.inside} of ${val.total}` : "…"}</b><span>of our sunlight averages fall inside the range published by NASA Goddard for the Connecting Ridge (Barker et al. 2021).</span></div>
          <button className="btn" onClick={() => go("method")}>See the method and all checks</button>
        </div>
      </section>

      <section className="end">
        <h2>Pick a site. Pick a date. See what the lander sees.</h2>
        <div className="cta">
          <button className="btn big" onClick={() => go("app")}>Open the navigator</button>
          <button className="btn big ghost" onClick={() => go("compare")}>Compare sites and dates</button>
        </div>
        <p className="credits">
          Data: NASA LRO LOLA (PDS Geosciences Node and NASA PGDA), JPL DE440 and SPICE (NAIF), JPL Horizons, NASA SVS CGI Moon Kit, NASA Blue Marble.
          Built for the NASA Space Apps Challenge 2026. This is a student project and is not endorsed by NASA.
        </p>
      </section>
    </div>
  );
}
