// GLSL for the Moon view.
//
// Terrain is drawn from LOLA height textures in south polar stereographic
// coordinates (km). Three nested levels: the whole cap (240 m), the core around
// the pole (60 m) and a patch around the selected site (20 m). Shadows are
// ray marched towards the true Sun direction through the same height
// textures, on the curved Moon, with a penumbra the size of the solar disk.

export const TERRAIN_COMMON = /* glsl */ `
precision highp float;
precision highp sampler2D;
const float R = 1737.4;
uniform sampler2D uCap;   uniform vec4 uCapRect;   // left, top, size, texel (km)
uniform sampler2D uCore;  uniform vec4 uCoreRect;  uniform float uCoreOn;
uniform sampler2D uPatch; uniform vec4 uPatchRect; uniform float uPatchOn;
uniform float uCapHalf;

vec2 rectUV(vec4 r, vec2 xy) { return vec2(xy.x - r.x, r.y - xy.y) / r.z; }
float edgeW(vec2 uv, float band) { vec2 d = min(uv, 1.0 - uv); return clamp(min(d.x, d.y) / band, 0.0, 1.0); }
float lodFor(float foot, float texel) { return foot > 0.0 ? max(0.0, log2(foot / texel)) : 0.0; }

// height (km) above the reference sphere. foot = sample footprint in km, 0 = finest.
// Deep inside a level only that level is read. Near its edge it is blended
// with the coarser level below so the meshes join without a step.
float heightAt(vec2 xy, float foot) {
  float hp = 0.0, wp = 0.0;
  if (uPatchOn > 0.5) {
    vec2 uv = rectUV(uPatchRect, xy);
    wp = edgeW(uv, 0.04);
    if (wp > 0.0) {
      hp = textureLod(uPatch, uv, lodFor(foot, uPatchRect.w)).r;
      if (wp >= 1.0) return hp;
    }
  }
  float hc = 0.0, wc = 0.0;
  if (uCoreOn > 0.5) {
    vec2 uv = rectUV(uCoreRect, xy);
    wc = edgeW(uv, 0.04);
    if (wc > 0.0) {
      hc = textureLod(uCore, uv, lodFor(foot, uCoreRect.w)).r;
      if (wc >= 1.0) return wp > 0.0 ? mix(hc, hp, wp) : hc;
    }
  }
  vec2 a = abs(xy);
  float fade = 1.0 - smoothstep(uCapHalf - 8.0, uCapHalf - 0.5, max(a.x, a.y));
  float h = textureLod(uCap, rectUV(uCapRect, xy), lodFor(foot, uCapRect.w)).r * fade;
  if (wc > 0.0) h = mix(h, hc, wc);
  if (wp > 0.0) h = mix(h, hp, wp);
  return h;
}

float finestTexel(vec2 xy) {
  if (uPatchOn > 0.5 && edgeW(rectUV(uPatchRect, xy), 0.04) > 0.0) return uPatchRect.w;
  if (uCoreOn > 0.5 && edgeW(rectUV(uCoreRect, xy), 0.04) > 0.0) return uCoreRect.w;
  return uCapRect.w;
}

vec3 upFromXY(vec2 xy) {
  float r2 = dot(xy, xy);
  float q = 4.0 * R * R;
  float k = 4.0 * R / (q + r2);
  return vec3(xy.y * k, xy.x * k, -(q - r2) / (q + r2));
}
`;

export const TERRAIN_VERT = /* glsl */ `
${TERRAIN_COMMON}
uniform vec4 uMesh; // left, top, size (km), unused
uniform float uExag;
varying vec2 vXY;
void main() {
  vec2 xy = vec2(uMesh.x + position.x * uMesh.z, uMesh.y - position.y * uMesh.z);
  vXY = xy;
  float h = heightAt(xy, 0.0);
  vec3 p = upFromXY(xy) * (R + h * uExag);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

export const SHADE_COMMON = /* glsl */ `
uniform vec3 uSun; uniform float uSunRad;
uniform vec3 uEarth; uniform float uEarthRad;
uniform float uMode;      // 0 = sunlight, 1 = Earth visibility
uniform float uExposure;
uniform float uAmbient;
uniform vec3 uCam;
uniform sampler2D uColor;
uniform float uHasColor;

vec3 tone(vec3 c) {
  c = max(c, 0.0) * uExposure;
  c = c * (1.0 + c / 9.0) / (1.0 + c);   // soft shoulder: bright slopes keep their detail
  return pow(min(c, 1.0), vec3(1.0 / 2.2));
}
// lunar-like reflectance: a blend of Lambert and Lommel-Seeliger
float brdf(float ndl, float ndv) {
  if (ndl <= 0.0) return 0.0;
  return mix(ndl, 2.0 * ndl / (ndl + max(ndv, 0.05)), 0.45);
}
`;

export const TERRAIN_FRAG = /* glsl */ `
${TERRAIN_COMMON}
${SHADE_COMMON}
uniform float uLevel;   // 0 cap, 1 core, 2 patch
uniform float uExag;
uniform float uPixKm;   // km per screen pixel at the camera target
uniform float uShadows;
uniform float uSteps;   // march length, lower while the view is moving
uniform float uGrow;    // step growth per sample
varying vec2 vXY;
const int STEPS = 120;
const float MAXH = 8.2;

// Fraction of a disk of angular radius rad (centre direction s) that clears the
// terrain between the surface point and space. Marches along the true 3D ray.
float clearTo(vec3 up, float h, vec3 s, float rad, float texel) {
  float r0 = R + h;
  float sinEl = dot(up, s);
  vec3 P = up * r0;
  float minClear = 1e9;
  float base = max(texel, uPixKm * 0.7);   // no point marching finer than a screen pixel
  float t = base * 1.5;
  for (int i = 0; i < STEPS; i++) {
    if (float(i) >= uSteps) break;
    float b = 2.0 * t * r0 * sinEl + t * t;
    float rq = sqrt(r0 * r0 + b);
    float alt = h + b / (rq + r0);
    if (alt > MAXH) break;
    vec3 Q = (P + s * t) / rq;
    vec2 qxy = 2.0 * R * vec2(Q.y, Q.x) / (1.0 - Q.z);
    vec2 a = abs(qxy);
    if (max(a.x, a.y) > uCapHalf) break;
    float foot = max(base, t * uGrow);
    float th = heightAt(qxy, foot);
    minClear = min(minClear, (alt - th) / t);
    if (minClear < -rad) break;
    t += foot;
  }
  return smoothstep(-rad, rad, minClear);
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  vec2 xy = vXY;
  vec2 ab = abs(xy);
  if (max(ab.x, ab.y) > uCapHalf) discard;
  if (uLevel < 0.5) {
    if (uCoreOn > 0.5 && edgeW(rectUV(uCoreRect, xy), 0.04) >= 1.0) discard;
    if (uPatchOn > 0.5 && edgeW(rectUV(uPatchRect, xy), 0.04) >= 1.0) discard;
  } else if (uLevel < 1.5) {
    if (uPatchOn > 0.5 && edgeW(rectUV(uPatchRect, xy), 0.04) >= 1.0) discard;
  }
  vec3 up = upFromXY(xy);
  float texel = finestTexel(xy);
  float d = texel;
  float h = heightAt(xy, 0.0);
  float hx = (heightAt(xy + vec2(d, 0.0), 0.0) - heightAt(xy - vec2(d, 0.0), 0.0)) / (2.0 * d);
  float hy = (heightAt(xy + vec2(0.0, d), 0.0) - heightAt(xy - vec2(0.0, d), 0.0)) / (2.0 * d);
  float rr = length(xy);
  vec2 er = rr > 1e-5 ? xy / rr : vec2(0.0, 1.0);
  vec2 ee = vec2(er.y, -er.x);
  float ks = 1.0 + rr * rr / (4.0 * R * R);
  float hn = dot(vec2(hx, hy), er) * ks;
  float he = dot(vec2(hx, hy), ee) * ks;
  // at the outer edge the heights fade to the sphere. That slope is not real, so flatten it.
  float edge = 1.0 - smoothstep(uCapHalf - 9.0, uCapHalf - 1.5, max(ab.x, ab.y));
  hn *= edge;
  he *= edge;
  // fine relief below the data resolution, only when zoomed in past it
  float fine = clamp(texel / max(uPixKm, 1e-6) * 0.5 - 0.6, 0.0, 1.0) * 0.045;
  if (fine > 0.0) {
    vec2 q = xy / texel * 3.1;
    he += (vnoise(q) + 0.5 * vnoise(q * 2.3 + 7.1) - 0.75) * fine;
    hn += (vnoise(q + 31.7) + 0.5 * vnoise(q * 2.3 - 3.9) - 0.75) * fine;
  }
  vec3 east3 = vec3(-er.x, er.y, 0.0);
  vec3 north3 = cross(up, east3);
  float inv = inversesqrt(1.0 + he * he + hn * hn);
  vec3 n = (up - he * east3 - hn * north3) * inv;
  vec3 view = normalize(uCam - up * (R + h * uExag));
  float ndv = dot(n, view);

  float ndl = (dot(up, uSun) - he * dot(east3, uSun) - hn * dot(north3, uSun)) * inv;
  float vis = 0.0;
  if (ndl > 0.0) vis = uShadows > 0.5 ? clearTo(up, h, uSun, uSunRad, texel) : 1.0;

  vec3 alb = vec3(0.36);
  if (uHasColor > 0.5) {
    float lon = atan(up.y, up.x), lat = asin(clamp(up.z, -1.0, 1.0));
    alb = textureLod(uColor, vec2(lon / 6.2831853 + 0.5, lat / 3.14159265 + 0.5), 0.0).rgb;
    alb = mix(vec3(dot(alb, vec3(0.3333))), alb, 0.6) * 1.15;
  }
  float sunTerm = brdf(ndl, ndv) * vis;
  vec3 col;
  if (uMode < 0.5) {
    col = alb * (sunTerm + uAmbient);
  } else {
    float ndE = (dot(up, uEarth) - he * dot(east3, uEarth) - hn * dot(north3, uEarth)) * inv;
    float visE = ndE > -0.03 ? clearTo(up, h, uEarth, 0.0035, texel) : 0.0;
    float relief = 0.55 + 0.45 * clamp(n.x * 0.3 + n.y * 0.3 - n.z * 0.9, 0.0, 1.0);
    col = alb * (sunTerm * 0.25 + uAmbient * 2.0) + visE * vec3(0.62, 0.74, 1.0) * 0.16 * relief;
  }
  gl_FragColor = vec4(tone(col), 1.0);
}
`;

export const GLOBE_VERT = /* glsl */ `
varying vec3 vDir;
varying vec2 vUv;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vDir = normalize(w.xyz);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const GLOBE_FRAG = /* glsl */ `
precision highp float;
${SHADE_COMMON}
const float R = 1737.4;
uniform sampler2D uNormal;
uniform float uHasNormal;
uniform float uCapHalf;   // 0 = no terrain cap loaded
varying vec3 vDir;
varying vec2 vUv;
void main() {
  vec3 up = normalize(vDir);
  if (uCapHalf > 0.0 && up.z < 0.0) {
    vec2 xy = 2.0 * R * vec2(up.y, up.x) / (1.0 - up.z);
    vec2 a = abs(xy);
    if (max(a.x, a.y) < uCapHalf - 1.0) discard;
  }
  vec3 alb = uHasColor > 0.5 ? texture2D(uColor, vUv).rgb : vec3(0.36);
  alb = mix(vec3(dot(alb, vec3(0.3333))), alb, 0.6) * 1.15;
  vec3 n = up;
  if (uHasNormal > 0.5) {
    vec3 t = texture2D(uNormal, vUv).xyz * 2.0 - 1.0;
    vec3 east = normalize(vec3(-up.y, up.x, 0.0) + vec3(1e-6, 0.0, 0.0));
    vec3 north = cross(up, east);
    n = normalize(east * t.x * 1.6 + north * t.y * 1.6 + up * t.z);
  }
  vec3 view = normalize(uCam - up * R);
  float ndl = dot(n, uSun);
  float geo = smoothstep(-uSunRad, uSunRad, dot(up, uSun));   // the Sun is a disk, not a point
  float sunTerm = brdf(ndl, dot(n, view)) * geo;
  vec3 col;
  if (uMode < 0.5) col = alb * (sunTerm + uAmbient);
  else {
    float visE = smoothstep(-0.01, 0.01, dot(up, uEarth));
    col = alb * (sunTerm * 0.25 + uAmbient * 2.0) + visE * vec3(0.62, 0.74, 1.0) * 0.12;
  }
  gl_FragColor = vec4(tone(col), 1.0);
}
`;

export const EARTH_VERT = /* glsl */ `
varying vec3 vN;
varying vec2 vUv;
varying vec3 vW;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const EARTH_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform float uHasMap;
uniform vec3 uSunDir;   // from Earth towards the Sun
uniform vec3 uCamPos;
varying vec3 vN;
varying vec2 vUv;
varying vec3 vW;
void main() {
  vec3 n = normalize(vN);
  vec3 base = uHasMap > 0.5 ? texture2D(uMap, vUv).rgb : vec3(0.15, 0.3, 0.6);
  float ndl = dot(n, uSunDir);
  float day = smoothstep(-0.08, 0.25, ndl);
  vec3 v = normalize(uCamPos - vW);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 col = base * (0.02 + 1.25 * day * max(ndl, 0.0) + 0.25 * day);
  col += vec3(0.25, 0.45, 0.9) * rim * day * 0.55;
  col = 1.0 - exp(-col * 1.6);
  gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}
`;
