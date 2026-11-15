import { useEffect, useRef, useState } from "react";
import { earthFixedToME, newSky, quatToMat, skyAt } from "../lib/ephem";
import { instantAt } from "../lib/sky";
import { useApp } from "../store";
import { Marker, MoonScene } from "../three/MoonScene";

const KIND: Record<string, string> = {
  "Artemis III candidate regions": "artemis",
  "Polar landings and impacts": "landing",
  "Reference points": "ref",
  Apollo: "apollo",
  "Other landings": "landing",
  "Your sites": "custom",
};

/** The 3D Moon. `hero` turns it into a hands-off background for the landing page. */
export function MoonView({ hero = false, time }: { hero?: boolean; time?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const scene = useRef<MoonScene | null>(null);
  const sky = useRef(newSky());
  const [pin, setPin] = useState(false);
  const pinRef = useRef(false);
  pinRef.current = pin;
  const { sites, siteId, t: tStore, mode, terrain, mastIdx, customBusy } = useApp();
  const t = time ?? tStore;
  const site = sites.find((s) => s.id === siteId);

  useEffect(() => {
    const sc = new MoonScene(canvas.current!, hero ? null : labels.current);
    scene.current = sc;
    sc.loadTextures();
    sc.interactive = !hero;
    sc.jumpTo(hero ? -38 : -62, hero ? 12 : -20, 0, hero ? 7600 : 9500, hero ? 70 : 62, 0);
    sc.onMarker = (id) => useApp.getState().selectSite(id);
    sc.onPickSurface = (lat, lon) => {
      if (!pinRef.current) return;
      setPin(false);
      useApp.getState().addCustom(lat, lon);
    };
    const ro = new ResizeObserver(() => {
      const r = wrap.current!.getBoundingClientRect();
      sc.setSize(Math.max(2, r.width), Math.max(2, r.height));
    });
    ro.observe(wrap.current!);
    (window as any).__moon = sc;
    return () => {
      ro.disconnect();
      sc.dispose();
    };
  }, [hero]);

  useEffect(() => {
    const sc = scene.current;
    if (!sc) return;
    if (terrain.cap && !sc.hasLevel("cap")) {
      sc.setLevel("cap", terrain.cap);
      // landing page: drift from the whole Moon down to the pole, then keep turning slowly
      if (hero) sc.flyTo(-89.25, -50, 1.0, 235, 27, 205, 9000, () => (sc.autoRotate = 0.012));
    }
    if (terrain.core && !sc.hasLevel("core")) sc.setLevel("core", terrain.core);
  }, [terrain.cap, terrain.core]);

  useEffect(() => {
    const sc = scene.current;
    if (!sc) return;
    if (hero) return;
    const list: Marker[] = sites.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, elevKm: (s.elev_m ?? 0) / 1000, kind: KIND[s.group] ?? "landing" }));
    sc.setMarkers(list);
  }, [sites]);

  // sky follows the clock
  useEffect(() => {
    const sc = scene.current;
    if (!sc) return;
    const s = skyAt(t, sky.current);
    sc.setSky({ sun: s.sun, earth: s.earth, earthRot: earthFixedToME(t, s), starRot: quatToMat(s.q) });
  }, [t]);

  useEffect(() => {
    scene.current?.setMode(hero ? "sun" : mode);
  }, [mode, hero]);

  // fly to the selected site and bring in its 20 m terrain patch
  useEffect(() => {
    const sc = scene.current;
    if (!sc || !site || hero) return;
    sc.setSelected(site.id);
    const st = useApp.getState();
    const polar = site.lat < -79.9;
    const sun = instantAt(site, Math.min(mastIdx, site.masts.length - 1), st.t);
    const h = (site.elev_m ?? 0) / 1000;
    if (polar) sc.flyTo(site.lat, site.lon, h, 34, 34, sun.sunAz + 115, 2600);
    else sc.flyTo(site.lat, site.lon, h, site.lat < -60 ? 900 : 2600, 60, 0, 2600);
    let live = true;
    sc.setLevel("patch", null);
    if (polar && !site.custom)
      st.loadPatch(site.id).then((g) => {
        if (live && g && useApp.getState().siteId === site.id) sc.setLevel("patch", g);
      });
    return () => {
      live = false;
    };
  }, [siteId, terrain.index, hero]);

  const view = (kind: "moon" | "pole" | "site") => {
    const sc = scene.current;
    if (!sc) return;
    if (kind === "moon") sc.flyTo(-30, 0, 0, 9500, 80, 0, 2200);
    else if (kind === "pole") sc.flyTo(-89.5, 0, 0, 330, 62, 180, 2200);
    else if (site) sc.flyTo(site.lat, site.lon, (site.elev_m ?? 0) / 1000, site.lat < -79.9 ? 34 : 900, 34, null, 1800);
  };

  return (
    <div className={`moon ${pin ? "pinning" : ""}`} ref={wrap}>
      <canvas ref={canvas} />
      {!hero && <div className="moon-labels" ref={labels} />}
      {!hero && (
        <>
          <div className="moon-tools">
            <div className="seg">
              <button className={mode === "sun" ? "on" : ""} onClick={() => useApp.getState().set({ mode: "sun" })}>Sunlight</button>
              <button className={mode === "earth" ? "on" : ""} onClick={() => useApp.getState().set({ mode: "earth" })}>Earth in view</button>
            </div>
            <div className="seg">
              <button onClick={() => view("moon")}>Moon</button>
              <button onClick={() => view("pole")}>South pole</button>
              <button onClick={() => view("site")}>Site</button>
            </div>
            <button className={`btn ${pin ? "on" : ""}`} onClick={() => setPin(!pin)} disabled={!terrain.cap}>
              {customBusy ? "Computing horizon" : pin ? "Click the terrain" : "Drop a pin"}
            </button>
          </div>
          <div className="moon-foot">
            {mode === "sun" ? "Shadows cast live from LOLA terrain toward the true Sun position" : "Lit areas can see the centre of Earth over the terrain right now"}
            <span>Drag to orbit · scroll to zoom · shift-drag to pan</span>
          </div>
        </>
      )}
    </div>
  );
}
