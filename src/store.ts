import { create } from "zustand";
import { BASE } from "./lib/base";
import { loadEphem } from "./lib/ephem";
import { Site } from "./lib/sky";
import { ensureHorizon, loadSites } from "./lib/sites";
import { HeightGrid, TerrainIndex, computeHorizon, inside, llToXY, loadGrid, loadIndex } from "./lib/terrain";
import { DAY, DEFAULT_MISSION, DEFAULT_RULES, Mission, Rules } from "./lib/windows";

export type Page = "home" | "app" | "compare" | "method";

interface State {
  ready: boolean;
  error: string | null;
  page: Page;
  sites: Site[];
  siteId: string;
  mastIdx: number;
  t: number;
  playing: boolean;
  speed: number; // simulated seconds per real second
  spanD: number; // timeline width in days
  mode: "sun" | "earth";
  rules: Rules;
  mission: Mission;
  compareIds: string[];
  terrain: { index: TerrainIndex | null; cap: HeightGrid | null; core: HeightGrid | null; patches: Record<string, HeightGrid> };
  horizonTick: number; // bumps when a horizon finishes loading
  customBusy: boolean;
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
  init: () => Promise<void>;
  go: (p: Page) => void;
  selectSite: (id: string) => void;
  setT: (t: number) => void;
  set: (p: Partial<State>) => void;
  toggleCompare: (id: string) => void;
  addCustom: (lat: number, lon: number) => Promise<string | null>;
  loadPatch: (id: string) => Promise<HeightGrid | null>;
}

const pageFromPath = (): Page => {
  let p = location.pathname;
  if (BASE && p.startsWith(BASE)) p = p.slice(BASE.length);
  p = p.replace(/\/+$/, "");
  if (p === "/app") return "app";
  if (p === "/compare") return "compare";
  if (p === "/method") return "method";
  return "home";
};

const DEFAULT_COMPARE = ["connecting-ridge", "shackleton-rim", "peak-near-shackleton", "de-gerlache-rim-1", "malapert-massif", "mons-mouton-plateau", "nobile-rim-1", "haworth"];

let started = false;

function initialTheme(): "dark" | "light" {
  if (typeof window === "undefined") return "dark";
  let t: string | null = null;
  try {
    t = localStorage.getItem("theme");
  } catch {}
  const theme = t === "dark" || t === "light" ? t : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  return theme;
}

export const useApp = create<State>((set, get) => ({
  ready: false,
  error: null,
  page: pageFromPath(),
  sites: [],
  siteId: "connecting-ridge",
  mastIdx: 0,
  t: Date.now(),
  playing: false,
  speed: 3600 * 6,
  spanD: 30,
  mode: "sun",
  rules: DEFAULT_RULES,
  mission: DEFAULT_MISSION,
  compareIds: DEFAULT_COMPARE,
  terrain: { index: null, cap: null, core: null, patches: {} },
  horizonTick: 0,
  customBusy: false,
  theme: initialTheme(),
  setTheme: (theme) => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("theme", theme);
    } catch {}
    set({ theme });
  },

  init: async () => {
    if (get().ready || started) return;
    started = true;
    try {
      const [, sites] = await Promise.all([loadEphem(), loadSites()]);
      const first = sites.find((s) => s.id === get().siteId) ?? sites[0];
      await ensureHorizon(first);
      set({ sites, siteId: first.id, ready: true });
      // terrain for the 3D view and for custom sites, after first paint
      loadIndex().then(async (index) => {
        set((s) => ({ terrain: { ...s.terrain, index } }));
        const cap = await loadGrid(index.levels.cap, index.unit_m);
        set((s) => ({ terrain: { ...s.terrain, cap } }));
        const core = await loadGrid(index.levels.core, index.unit_m);
        set((s) => ({ terrain: { ...s.terrain, core } }));
      }).catch(() => {});
      // the other horizons load quietly in the background
      (async () => {
        let k = 0;
        for (const s of sites) {
          await ensureHorizon(s).catch(() => {});
          if (++k % 6 === 0) set((st) => ({ horizonTick: st.horizonTick + 1 }));
        }
        set((st) => ({ horizonTick: st.horizonTick + 1 }));
      })();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  go: (page) => {
    const path = `${BASE}${page === "home" ? "/" : `/${page}`}`;
    if (location.pathname !== path) history.pushState({}, "", path);
    set({ page });
    window.scrollTo(0, 0);
  },

  selectSite: (id) => {
    const s = get().sites.find((k) => k.id === id);
    if (!s) return;
    set({ siteId: id, mastIdx: Math.min(get().mastIdx, s.masts.length - 1) });
    ensureHorizon(s).then(() => set((st) => ({ horizonTick: st.horizonTick + 1 })));
  },

  setT: (t) => set({ t }),
  set: (p) => set(p),

  toggleCompare: (id) => {
    const cur = get().compareIds;
    set({ compareIds: cur.includes(id) ? cur.filter((k) => k !== id) : [...cur, id] });
  },

  loadPatch: async (id) => {
    const { terrain } = get();
    if (terrain.patches[id]) return terrain.patches[id];
    const meta = terrain.index?.patches[id];
    if (!meta || !terrain.index) return null;
    const g = await loadGrid(meta, terrain.index.unit_m);
    set((s) => ({ terrain: { ...s.terrain, patches: { ...s.terrain.patches, [id]: g } } }));
    return g;
  },

  addCustom: async (lat, lon) => {
    const { terrain, sites } = get();
    const id = `custom-${Date.now().toString(36)}`;
    const name = `Custom ${sites.filter((s) => s.custom).length + 1}`;
    const base: Site = {
      id, name, group: "Your sites", lat, lon, note: "A point you picked.", source: "Custom coordinates",
      tier: "sphere", elev_m: 0, masts: [2, 10], profiles: null, custom: true,
    };
    if (terrain.cap && lat < -75) {
      set({ customBusy: true });
      await new Promise((r) => setTimeout(r, 30));
      const [x, y] = llToXY(lat, lon);
      const srcs: HeightGrid[] = [];
      for (const g of Object.values(terrain.patches)) if (inside(g, x, y, 8)) srcs.push(g);
      if (terrain.core) srcs.push(terrain.core);
      srcs.push(terrain.cap);
      const res = computeHorizon(lat, lon, base.masts, srcs);
      if (res) {
        base.tier = "custom";
        base.elev_m = res.groundKm * 1000;
        base.profiles = res.profiles;
        base.note = `Horizon computed in your browser from LOLA terrain (${Math.round(res.finestPx * 1000)} m grid under the site).`;
      }
      set({ customBusy: false });
    }
    set((s) => ({ sites: [...s.sites, base], siteId: id }));
    return id;
  },
}));

// playback clock
let last = 0;
function frame(now: number) {
  const s = useApp.getState();
  if (s.playing && last) {
    const dt = Math.min(0.1, (now - last) / 1000);
    s.setT(s.t + dt * s.speed * 1000);
  }
  last = now;
  requestAnimationFrame(frame);
}
if (typeof window !== "undefined") {
  requestAnimationFrame(frame);
  window.addEventListener("popstate", () => useApp.setState({ page: pageFromPath() }));
}

export const YEAR = 365 * DAY;

// handy in the console: __app.getState()
if (typeof window !== "undefined") (window as any).__app = useApp;
