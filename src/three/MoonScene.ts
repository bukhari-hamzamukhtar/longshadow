// The 3D Moon: a textured globe, LOLA terrain around the south pole with ray
// marched shadows, the Sun and Earth at their true positions, site markers.
// Scene units are km in the Moon ME frame (x through 0N 0E, z through the north pole).
import * as THREE from "three";
import { DATA } from "../lib/base";
import type { HeightGrid } from "../lib/terrain";
import { EARTH_FRAG, EARTH_VERT, GLOBE_FRAG, GLOBE_VERT, TERRAIN_FRAG, TERRAIN_VERT } from "./shaders";

const R = 1737.4;
const DEG = Math.PI / 180;

export interface Marker {
  id: string;
  name: string;
  lat: number;
  lon: number;
  elevKm: number;
  kind: string;
}

export interface SkyInput {
  sun: ArrayLike<number>; // km, Moon-centred ME
  earth: ArrayLike<number>;
  earthRot: ArrayLike<number> | null; // row-major 3x3, Earth-fixed -> ME
  starRot: ArrayLike<number> | null; // row-major 3x3, J2000 -> ME
}

type LevelName = "cap" | "core" | "patch";

function unit(lat: number, lon: number, out = new THREE.Vector3()) {
  const la = lat * DEG, lo = lon * DEG;
  return out.set(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
}

function maxMips(data: Float32Array, n: number, levels: number) {
  const out: { data: Float32Array; width: number; height: number }[] = [{ data, width: n, height: n }];
  let cur = data, w = n;
  for (let l = 1; l < levels; l++) {
    const m = Math.floor(w / 2);
    if (m < 2) break;
    const nx = new Float32Array(m * m);
    for (let r = 0; r < m; r++) {
      const o = 2 * r * w;
      for (let c = 0; c < m; c++) {
        const i = o + 2 * c;
        nx[r * m + c] = Math.max(cur[i], cur[i + 1], cur[i + w], cur[i + w + 1]);
      }
    }
    out.push({ data: nx, width: m, height: m });
    cur = nx;
    w = m;
  }
  return out;
}

function gridGeometry(n: number) {
  const pos = new Float32Array(n * n * 3);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const i = (r * n + c) * 3;
      pos[i] = c / (n - 1);
      pos[i + 1] = r / (n - 1);
    }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let r = 0; r < n - 1; r++)
    for (let c = 0; c < n - 1; c++) {
      const a = r * n + c, b = a + 1, d = a + n, e = d + 1;
      // counter-clockwise seen from outside the Moon (map x right, y up)
      idx[k++] = a; idx[k++] = d; idx[k++] = b;
      idx[k++] = b; idx[k++] = d; idx[k++] = e;
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

export class MoonScene {
  renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private bg = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 1, 1e4);
  private bgCamera = new THREE.PerspectiveCamera(32, 1, 1e3, 4e8);
  private shared: Record<string, THREE.IUniform>;
  private dummy: THREE.DataTexture;
  private levels: Partial<Record<LevelName, { grid: HeightGrid; tex: THREE.DataTexture; mesh: THREE.Mesh }>> = {};
  private globe: THREE.Mesh;
  private earth: THREE.Mesh;
  private sunMesh: THREE.Mesh;
  private glare: THREE.Sprite;
  private stars: THREE.Points | null = null;
  private sunLine: THREE.Line;
  private earthLine: THREE.Line;
  private floatLinear: boolean;
  private raf = 0;
  private dirty = true;
  private disposed = false;
  private w = 1;
  private h = 1;
  // camera state: orbit around a surface point
  private tgt = new THREE.Vector3(0, 0, -1);
  private ref = new THREE.Vector3(1, 0, 0); // tangent reference, parallel transported
  private tgtH = 0;
  dist = 9000;
  yaw = 0;
  pitch = 1.2;
  autoRotate = 0; // rad/s
  private anim: null | { t0: number; dur: number; from: any; to: any; done?: () => void } = null;
  private markers: Marker[] = [];
  private markerEls = new Map<string, HTMLElement>();
  private selected: string | null = null;
  private labelRoot: HTMLElement | null;
  private sunLabel: HTMLElement | null = null;
  private earthLabel: HTMLElement | null = null;
  private sky: SkyInput | null = null;
  private lastT = 0;
  onMarker: (id: string) => void = () => {};
  onPickSurface: (lat: number, lon: number) => void = () => {};
  onFrame: () => void = () => {};
  interactive = true;
  showMarkers = true;
  /** total pixels drawn while the view is moving, and when it rests */
  budgetFast = 260_000;
  budgetFull = 1_500_000;
  private fast = false;
  private lastMove = 0;
  private ratio = 1;

  constructor(canvas: HTMLCanvasElement, labelRoot: HTMLElement | null) {
    this.labelRoot = labelRoot;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.autoClear = false;
    this.floatLinear = !!this.renderer.extensions.get("OES_texture_float_linear");
    this.dummy = new THREE.DataTexture(new Float32Array([0]), 1, 1, THREE.RedFormat, THREE.FloatType);
    this.dummy.needsUpdate = true;
    this.shared = {
      uCap: { value: this.dummy }, uCapRect: { value: new THREE.Vector4(-1, 1, 2, 1) }, uCapHalf: { value: 0 },
      uCore: { value: this.dummy }, uCoreRect: { value: new THREE.Vector4(-1, 1, 2, 1) }, uCoreOn: { value: 0 },
      uPatch: { value: this.dummy }, uPatchRect: { value: new THREE.Vector4(-1, 1, 2, 1) }, uPatchOn: { value: 0 },
      uSun: { value: new THREE.Vector3(1, 0, 0) }, uSunRad: { value: 0.00465 },
      uEarth: { value: new THREE.Vector3(1, 0, 0) }, uEarthRad: { value: 0.0166 },
      uMode: { value: 0 }, uExposure: { value: 2 }, uAmbient: { value: 0.0011 }, uCam: { value: new THREE.Vector3() },
      uColor: { value: null }, uHasColor: { value: 0 }, uExag: { value: 1 }, uPixKm: { value: 1 }, uShadows: { value: 1 },
      uSteps: { value: 112 }, uGrow: { value: 0.075 },
    };
    // globe
    const gm = new THREE.ShaderMaterial({
      vertexShader: GLOBE_VERT, fragmentShader: GLOBE_FRAG,
      uniforms: { ...this.shared, uNormal: { value: null }, uHasNormal: { value: 0 } },
    });
    this.globe = new THREE.Mesh(new THREE.SphereGeometry(R, 384, 192), gm);
    this.globe.rotation.x = Math.PI / 2; // three's sphere has y up, the Moon frame has z up
    this.scene.add(this.globe);
    // background: Earth, Sun, stars
    const em = new THREE.ShaderMaterial({
      vertexShader: EARTH_VERT, fragmentShader: EARTH_FRAG,
      uniforms: { uMap: { value: null }, uHasMap: { value: 0 }, uSunDir: { value: new THREE.Vector3(1, 0, 0) }, uCamPos: { value: new THREE.Vector3() } },
    });
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(6378.137, 96, 48), em);
    this.earth.matrixAutoUpdate = false;
    this.bg.add(this.earth);
    this.sunMesh = new THREE.Mesh(new THREE.SphereGeometry(695700, 32, 16), new THREE.MeshBasicMaterial({ color: 0xfff6e0 }));
    this.bg.add(this.sunMesh);
    this.glare = new THREE.Sprite(new THREE.SpriteMaterial({ map: glareTexture(), blending: THREE.AdditiveBlending, depthTest: false, transparent: true, opacity: 0.9 }));
    this.bg.add(this.glare);
    // Sun / Earth direction lines at the selected site
    const mk = (color: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false }));
      l.frustumCulled = false;
      l.visible = false;
      l.renderOrder = 10;
      this.scene.add(l);
      return l;
    };
    this.sunLine = mk(0xffb224);
    this.earthLine = mk(0xb9cdf5);
    if (labelRoot) {
      this.sunLabel = this.mkLabel("dirlabel sun", "Sun");
      this.earthLabel = this.mkLabel("dirlabel earth", "Earth");
    }
    this.bindInput(canvas);
    const loop = (t: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      this.tick(t);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private mkLabel(cls: string, text: string) {
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;
    el.style.display = "none";
    this.labelRoot!.appendChild(el);
    return el;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
    this.markerEls.forEach((e) => e.remove());
    this.sunLabel?.remove();
    this.earthLabel?.remove();
  }

  invalidate() {
    this.dirty = true;
  }

  /** call when something is changing continuously (drag, zoom, playback) */
  private moving() {
    this.lastMove = performance.now();
    this.dirty = true;
  }

  private applyQuality(fast: boolean) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const budget = fast ? this.budgetFast : this.budgetFull;
    const r = Math.min(dpr, Math.sqrt(budget / Math.max(1, this.w * this.h)));
    if (Math.abs(r - this.ratio) > 0.01) {
      this.ratio = r;
      this.renderer.setPixelRatio(r);
      this.renderer.setSize(this.w, this.h, false);
    }
    this.shared.uSteps.value = fast ? 60 : 112;
    this.shared.uGrow.value = fast ? 0.12 : 0.075;
    this.fast = fast;
  }

  setSize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.ratio = -1;
    this.applyQuality(this.fast);
    this.camera.aspect = this.bgCamera.aspect = w / h;
    this.dirty = true;
  }

  // ------------------------------------------------------------- assets
  loadTextures(base = DATA) {
    const tl = new THREE.TextureLoader();
    tl.load(`${base}/tex/moon_color.jpg`, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      t.wrapS = THREE.RepeatWrapping;
      this.shared.uColor.value = t;
      this.shared.uHasColor.value = 1;
      this.dirty = true;
    });
    tl.load(`${base}/tex/moon_normal.jpg`, (t) => {
      t.colorSpace = THREE.NoColorSpace;
      t.anisotropy = 4;
      const u = (this.globe.material as THREE.ShaderMaterial).uniforms;
      u.uNormal.value = t;
      u.uHasNormal.value = 1;
      this.dirty = true;
    });
    tl.load(`${base}/tex/earth.jpg`, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      const u = (this.earth.material as THREE.ShaderMaterial).uniforms;
      u.uMap.value = t;
      u.uHasMap.value = 1;
      this.dirty = true;
    });
  }

  setStars(dirs: Float32Array, mags: Float32Array) {
    const n = mags.length;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = dirs[i * 3] * 1e8;
      pos[i * 3 + 1] = dirs[i * 3 + 1] * 1e8;
      pos[i * 3 + 2] = dirs[i * 3 + 2] * 1e8;
      const b = Math.min(1, Math.pow(10, -0.4 * (mags[i] - 1.5)) * 0.9 + 0.08);
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthTest: false, depthWrite: false }));
    this.stars.renderOrder = -10; // behind the Earth and the Sun
    this.stars.frustumCulled = false;
    this.stars.matrixAutoUpdate = false;
    this.bg.add(this.stars);
    this.dirty = true;
  }

  setLevel(name: LevelName, grid: HeightGrid | null) {
    const old = this.levels[name];
    if (old) {
      this.scene.remove(old.mesh);
      old.tex.dispose();
      (old.mesh.material as THREE.Material).dispose();
      delete this.levels[name];
    }
    const U = name === "cap" ? "uCap" : name === "core" ? "uCore" : "uPatch";
    if (!grid) {
      this.shared[U].value = this.dummy;
      if (name === "cap") this.shared.uCapHalf.value = 0;
      else this.shared[U + "On"].value = 0;
      this.dirty = true;
      return;
    }
    const mips = maxMips(grid.data, grid.n, 9);
    const tex = new THREE.DataTexture(grid.data, grid.n, grid.n, THREE.RedFormat, THREE.FloatType);
    tex.mipmaps = mips as any;
    tex.generateMipmaps = false;
    tex.minFilter = this.floatLinear ? THREE.LinearMipmapNearestFilter : THREE.NearestMipmapNearestFilter;
    tex.magFilter = this.floatLinear ? THREE.LinearFilter : THREE.NearestFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    const size = grid.n * grid.px;
    const left = grid.x0 - grid.px / 2, top = grid.y0 + grid.px / 2;
    this.shared[U].value = tex;
    (this.shared[U + "Rect"].value as THREE.Vector4).set(left, top, size, grid.px);
    if (name === "cap") this.shared.uCapHalf.value = size / 2;
    else this.shared[U + "On"].value = 1;
    const mat = new THREE.ShaderMaterial({
      vertexShader: TERRAIN_VERT, fragmentShader: TERRAIN_FRAG,
      uniforms: { ...this.shared, uMesh: { value: new THREE.Vector4(left, top, size, 0) }, uLevel: { value: name === "cap" ? 0 : name === "core" ? 1 : 2 } },
    });
    const mesh = new THREE.Mesh(gridGeometry(name === "cap" ? 641 : 513), mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.levels[name] = { grid, tex, mesh };
    this.dirty = true;
  }

  hasLevel(name: LevelName) {
    return !!this.levels[name];
  }

  // ---------------------------------------------------------------- state
  setSky(s: SkyInput) {
    this.sky = s;
    const sun = this.shared.uSun.value as THREE.Vector3;
    const sd = Math.hypot(s.sun[0], s.sun[1], s.sun[2]);
    sun.set(s.sun[0] / sd, s.sun[1] / sd, s.sun[2] / sd);
    this.shared.uSunRad.value = Math.asin(695700 / sd);
    const ed = Math.hypot(s.earth[0], s.earth[1], s.earth[2]);
    (this.shared.uEarth.value as THREE.Vector3).set(s.earth[0] / ed, s.earth[1] / ed, s.earth[2] / ed);
    this.shared.uEarthRad.value = Math.asin(6378.137 / ed);
    this.moving();
  }

  setMode(mode: "sun" | "earth") {
    this.shared.uMode.value = mode === "sun" ? 0 : 1;
    this.dirty = true;
  }
  setExaggeration(x: number) {
    this.shared.uExag.value = x;
    this.dirty = true;
  }
  setShadows(on: boolean) {
    this.shared.uShadows.value = on ? 1 : 0;
    this.dirty = true;
  }

  setMarkers(list: Marker[]) {
    this.markers = list;
    if (!this.labelRoot) return;
    const keep = new Set(list.map((m) => m.id));
    this.markerEls.forEach((el, id) => {
      if (!keep.has(id)) {
        el.remove();
        this.markerEls.delete(id);
      }
    });
    for (const m of list) {
      let el = this.markerEls.get(m.id);
      if (!el) {
        el = document.createElement("button");
        el.className = "mk";
        el.innerHTML = `<i></i><span></span>`;
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          this.onMarker(m.id);
        });
        this.labelRoot.appendChild(el);
        this.markerEls.set(m.id, el);
      }
      el.dataset.kind = m.kind;
      (el.lastChild as HTMLElement).textContent = m.name;
    }
    this.dirty = true;
  }

  setSelected(id: string | null) {
    this.selected = id;
    this.dirty = true;
  }

  // --------------------------------------------------------------- camera
  private frame(u: THREE.Vector3, ref: THREE.Vector3) {
    const a = ref.clone().addScaledVector(u, -ref.dot(u));
    if (a.lengthSq() < 1e-10) a.set(0, 1, 0).addScaledVector(u, -u.y);
    a.normalize();
    const b = new THREE.Vector3().crossVectors(u, a);
    return { a, b };
  }

  /** yaw that makes the camera look along a compass bearing at the target */
  private yawForBearing(u: THREE.Vector3, ref: THREE.Vector3, bearingDeg: number) {
    const east = new THREE.Vector3(-u.y, u.x, 0);
    if (east.lengthSq() < 1e-12) east.set(0, 1, 0);
    east.normalize();
    const north = new THREE.Vector3().crossVectors(u, east);
    const look = north.multiplyScalar(Math.cos(bearingDeg * DEG)).addScaledVector(east, Math.sin(bearingDeg * DEG));
    const { a, b } = this.frame(u, ref);
    // camera sits at -look from the target
    return Math.atan2(-look.dot(b), -look.dot(a));
  }

  jumpTo(lat: number, lon: number, hKm: number, dist: number, pitchDeg: number, bearingDeg = 0) {
    unit(lat, lon, this.tgt);
    this.ref.copy(this.frame(this.tgt, this.ref).a);
    this.tgtH = hKm;
    this.dist = dist;
    this.pitch = pitchDeg * DEG;
    this.yaw = this.yawForBearing(this.tgt, this.ref, bearingDeg);
    this.anim = null;
    this.dirty = true;
  }

  flyTo(lat: number, lon: number, hKm: number, dist: number, pitchDeg: number, bearingDeg: number | null = null, dur = 2200, done?: () => void) {
    const toU = unit(lat, lon);
    // transport the reference along the path so the final yaw is well defined
    const refEnd = this.frame(toU, this.ref).a;
    let yawEnd = bearingDeg === null ? this.yaw : this.yawForBearing(toU, refEnd, bearingDeg);
    let dy = yawEnd - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.anim = {
      t0: performance.now(), dur,
      from: { u: this.tgt.clone(), ref: this.ref.clone(), h: this.tgtH, dist: this.dist, yaw: this.yaw, pitch: this.pitch },
      to: { u: toU, h: hKm, dist, yaw: this.yaw + dy, pitch: pitchDeg * DEG },
      done,
    };
    this.dirty = true;
  }

  private stepAnim(now: number) {
    const an = this.anim;
    if (!an) return;
    let k = Math.min(1, (now - an.t0) / an.dur);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const ang = an.from.u.angleTo(an.to.u);
    if (ang > 1e-6) {
      const s = Math.sin(ang);
      this.tgt.copy(an.from.u).multiplyScalar(Math.sin((1 - e) * ang) / s).addScaledVector(an.to.u, Math.sin(e * ang) / s).normalize();
    } else this.tgt.copy(an.to.u);
    // always project the starting reference, so the end frame does not depend on the path
    this.ref.copy(this.frame(this.tgt, an.from.ref).a);
    this.tgtH = an.from.h + (an.to.h - an.from.h) * e;
    // zoom out in the middle of long hops
    const mid = Math.max(an.from.dist, an.to.dist, Math.min(9000, ang * R * 1.6));
    const ld = (1 - e) * Math.log(an.from.dist) + e * Math.log(an.to.dist);
    const bump = Math.sin(Math.PI * e) * Math.max(0, Math.log(mid) - Math.max(Math.log(an.from.dist), Math.log(an.to.dist)));
    this.dist = Math.exp(ld + bump);
    this.yaw = an.from.yaw + (an.to.yaw - an.from.yaw) * e;
    this.pitch = an.from.pitch + (an.to.pitch - an.from.pitch) * e;
    if (k >= 1) {
      this.anim = null;
      an.done?.();
    }
    this.dirty = true;
  }

  get animating() {
    return !!this.anim;
  }

  private updateCamera() {
    const u = this.tgt;
    const { a, b } = this.frame(u, this.ref);
    const P = u.clone().multiplyScalar(R + this.tgtH * (this.shared.uExag.value as number));
    const hx = Math.cos(this.yaw), hy = Math.sin(this.yaw);
    const horiz = a.clone().multiplyScalar(hx).addScaledVector(b, hy);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const pos = P.clone().addScaledVector(u, this.dist * sp).addScaledVector(horiz, this.dist * cp);
    const upv = u.clone().multiplyScalar(cp).addScaledVector(horiz, -sp);
    this.camera.position.copy(pos);
    this.camera.up.copy(upv);
    this.camera.lookAt(P);
    const alt = Math.max(0.2, pos.length() - R);
    this.camera.near = Math.max(0.02, Math.min(this.dist * 0.2, alt * 0.3));
    this.camera.far = this.dist + Math.sqrt(Math.max(0, pos.lengthSq() - R * R)) + 800;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    (this.shared.uCam.value as THREE.Vector3).copy(pos);
    this.shared.uPixKm.value = (2 * this.dist * Math.tan((this.camera.fov * DEG) / 2)) / Math.max(1, this.h);
    // auto exposure from the Sun's height at the target
    const sinEl = u.dot(this.shared.uSun.value as THREE.Vector3);
    const polar = THREE.MathUtils.clamp(0.62 / Math.max(sinEl + 0.05, 0.07), 1.5, 6.5);
    const far = THREE.MathUtils.smoothstep(this.dist, 500, 4000);
    this.shared.uExposure.value = THREE.MathUtils.lerp(polar, 1.9, far);
  }

  // ---------------------------------------------------------------- input
  private bindInput(el: HTMLCanvasElement) {
    let down: null | { x: number; y: number; yaw: number; pitch: number; moved: boolean; btn: number; shift: boolean } = null;
    const pts = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    el.addEventListener("pointerdown", (e) => {
      if (!this.interactive) return;
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      down = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch, moved: false, btn: e.button, shift: e.shiftKey };
      this.anim = null;
      this.autoRotate = 0;
      if (pts.size === 2) {
        const [p, q] = [...pts.values()];
        pinch = Math.hypot(p.x - q.x, p.y - q.y);
      }
    });
    el.addEventListener("pointermove", (e) => {
      if (!down || !this.interactive) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [p, q] = [...pts.values()];
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (pinch > 0) this.dist = THREE.MathUtils.clamp((this.dist * pinch) / d, 1.2, 40000);
        pinch = d;
        this.moving();
        return;
      }
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) down.moved = true;
      if (down.btn === 2 || down.shift) {
        // pan: slide the target over the surface
        const k = (this.dist * 0.0016) / R;
        const { a, b } = this.frame(this.tgt, this.ref);
        const hx = Math.cos(this.yaw), hy = Math.sin(this.yaw);
        const fwd = a.clone().multiplyScalar(-hx).addScaledVector(b, -hy);
        const right = new THREE.Vector3().crossVectors(fwd, this.tgt);
        this.tgt.addScaledVector(right, -e.movementX * k).addScaledVector(fwd, e.movementY * k).normalize();
        this.ref.copy(this.frame(this.tgt, this.ref).a);
        this.tgtH = this.heightAt(this.tgt);
      } else {
        this.yaw = down.yaw - dx * 0.006;
        this.pitch = THREE.MathUtils.clamp(down.pitch + dy * 0.005, 0.06, Math.PI / 2 - 0.01);
      }
      this.moving();
    });
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (down && !down.moved && this.interactive && e.button === 0) {
        const hit = this.pick(e.offsetX, e.offsetY);
        if (hit) this.onPickSurface(hit.lat, hit.lon);
      }
      if (pts.size === 0) down = null;
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("wheel", (e) => {
      if (!this.interactive) return;
      e.preventDefault();
      this.anim = null;
      this.autoRotate = 0;
      this.dist = THREE.MathUtils.clamp(this.dist * Math.exp(e.deltaY * 0.0012), 1.2, 40000);
      this.moving();
    }, { passive: false });
  }

  /** terrain height (km) under a unit vector, from the loaded grids */
  heightAt(u: THREE.Vector3): number {
    if (u.z > -0.9) return 0;
    const k = (2 * R) / (1 - u.z);
    const x = k * u.y, y = k * u.x;
    for (const name of ["patch", "core", "cap"] as LevelName[]) {
      const g = this.levels[name]?.grid;
      if (!g) continue;
      const fc = (x - g.x0) / g.px, fr = (g.y0 - y) / g.px;
      if (fc < 1 || fr < 1 || fc > g.n - 2 || fr > g.n - 2) continue;
      return g.data[Math.round(fr) * g.n + Math.round(fc)];
    }
    return 0;
  }

  pick(px: number, py: number): { lat: number; lon: number } | null {
    const ndc = new THREE.Vector2((px / this.w) * 2 - 1, -(py / this.h) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    let rad = R + this.tgtH;
    let hit: THREE.Vector3 | null = null;
    for (let it = 0; it < 4; it++) {
      const b = o.dot(d), c = o.lengthSq() - rad * rad;
      const disc = b * b - c;
      if (disc < 0) return null;
      const t = -b - Math.sqrt(disc);
      if (t < 0) return null;
      hit = o.clone().addScaledVector(d, t);
      rad = R + this.heightAt(hit.clone().normalize());
    }
    if (!hit) return null;
    hit.normalize();
    return { lat: Math.asin(hit.z) / DEG, lon: Math.atan2(hit.y, hit.x) / DEG };
  }

  // --------------------------------------------------------------- render
  private tick(now: number) {
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    if (this.anim) {
      this.stepAnim(now);
      this.lastMove = now;
    }
    if (this.autoRotate) {
      this.yaw += this.autoRotate * dt;
      this.moving();
    }
    // draw light while things move, then one full-quality frame once they stop
    const wantFast = now - this.lastMove < 220;
    if (!wantFast && this.fast) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    if (wantFast !== this.fast || this.ratio < 0) this.applyQuality(wantFast);
    this.updateCamera();
    const r = this.renderer;
    r.clear();
    // background pass: same view, camera-relative
    const cam = this.camera.position;
    this.bgCamera.quaternion.copy(this.camera.quaternion);
    this.bgCamera.position.set(0, 0, 0);
    this.bgCamera.fov = this.camera.fov;
    this.bgCamera.updateProjectionMatrix();
    this.bgCamera.updateMatrixWorld();
    if (this.sky) {
      const s = this.sky;
      const ex = s.earth[0] - cam.x, ey = s.earth[1] - cam.y, ez = s.earth[2] - cam.z;
      const m = new THREE.Matrix4();
      if (s.earthRot) {
        const e = s.earthRot;
        // Earth-fixed (x Greenwich, y 90E, z north) -> three sphere local (x, z, -y): columns below
        m.set(e[0], e[2], -e[1], ex, e[3], e[5], -e[4], ey, e[6], e[8], -e[7], ez, 0, 0, 0, 1);
      } else m.makeTranslation(ex, ey, ez);
      this.earth.matrix.copy(m);
      this.earth.matrixWorldNeedsUpdate = true;
      const eu = (this.earth.material as THREE.ShaderMaterial).uniforms;
      (eu.uSunDir.value as THREE.Vector3).set(s.sun[0] - s.earth[0], s.sun[1] - s.earth[1], s.sun[2] - s.earth[2]).normalize();
      (eu.uCamPos.value as THREE.Vector3).set(0, 0, 0);
      this.sunMesh.position.set(s.sun[0] - cam.x, s.sun[1] - cam.y, s.sun[2] - cam.z);
      this.glare.position.copy(this.sunMesh.position);
      const gd = this.sunMesh.position.length();
      this.glare.scale.setScalar(gd * 0.16);
      if (this.stars && s.starRot) {
        const q = s.starRot;
        this.stars.matrix.set(q[0], q[1], q[2], 0, q[3], q[4], q[5], 0, q[6], q[7], q[8], 0, 0, 0, 0, 1);
        this.stars.matrixWorldNeedsUpdate = true;
      }
    }
    r.render(this.bg, this.bgCamera);
    r.clearDepth();
    this.updateLines();
    r.render(this.scene, this.camera);
    this.updateMarkers();
    this.onFrame();
  }

  private project(p: THREE.Vector3): { x: number; y: number; ok: boolean } {
    const v = p.clone().project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.w, y: (-v.y * 0.5 + 0.5) * this.h, ok: v.z > -1 && v.z < 1 };
  }

  private visibleFromCamera(p: THREE.Vector3) {
    // a surface point is visible if the camera is above its local horizon (sphere test, small tolerance)
    const cam = this.camera.position;
    const u = p.clone().normalize();
    return cam.dot(u) > R * 0.999 + Math.min(0, p.length() - R);
  }

  private updateMarkers() {
    if (!this.labelRoot) return;
    const ex = this.shared.uExag.value as number;
    for (const m of this.markers) {
      const el = this.markerEls.get(m.id);
      if (!el) continue;
      const p = unit(m.lat, m.lon).multiplyScalar(R + m.elevKm * ex);
      const s = this.project(p);
      const vis = this.showMarkers && s.ok && this.visibleFromCamera(p) && s.x > -40 && s.x < this.w + 40 && s.y > -40 && s.y < this.h + 40;
      if (!vis) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "";
      el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
      const sel = m.id === this.selected;
      el.classList.toggle("sel", sel);
      // names only when there is room: selected, or zoomed in enough
      el.classList.toggle("named", sel || this.dist < 900);
    }
  }

  private updateLines() {
    const m = this.markers.find((k) => k.id === this.selected);
    const show = !!m && !!this.sky && this.dist < 6000;
    this.sunLine.visible = this.earthLine.visible = show;
    if (this.sunLabel) this.sunLabel.style.display = "none";
    if (this.earthLabel) this.earthLabel.style.display = "none";
    if (!show || !m || !this.sky) return;
    const ex = this.shared.uExag.value as number;
    const u = unit(m.lat, m.lon);
    const P = u.clone().multiplyScalar(R + m.elevKm * ex + this.dist * 0.004);
    const len = this.dist * 0.22;
    const put = (line: THREE.Line, v: ArrayLike<number>, label: HTMLElement | null) => {
      const d = new THREE.Vector3(v[0] - P.x, v[1] - P.y, v[2] - P.z).normalize();
      const flat = d.clone().addScaledVector(u, -d.dot(u)).normalize(); // direction along the ground
      const end = P.clone().addScaledVector(flat, len);
      const a = line.geometry.getAttribute("position") as THREE.BufferAttribute;
      a.setXYZ(0, P.x, P.y, P.z);
      a.setXYZ(1, end.x, end.y, end.z);
      a.needsUpdate = true;
      if (label) {
        const s = this.project(end);
        if (s.ok) {
          label.style.display = "";
          label.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
        }
      }
    };
    put(this.sunLine, this.sky.sun, this.sunLabel);
    put(this.earthLine, this.sky.earth, this.earthLabel);
  }
}

function glareTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, "rgba(255,246,224,1)");
  grd.addColorStop(0.03, "rgba(255,240,210,0.85)");
  grd.addColorStop(0.1, "rgba(255,225,170,0.22)");
  grd.addColorStop(0.35, "rgba(255,210,150,0.05)");
  grd.addColorStop(1, "rgba(255,200,140,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
