import React, { useMemo, useRef, useState, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment, Lightformer } from '@react-three/drei';
import * as THREE from 'three';

// ── Glaze Studio ─────────────────────────────────────────────────────────────────────────────────
// Tune a MIRROR GLAZE (poured chocolate / marble glaze) on a real cake BEFORE porting to core.
//
// A glaze is two separable things, tuned independently here:
//   1. MATERIAL — the wet, mirror sheen. These sliders map 1:1 onto the SAME MeshPhysicalMaterial
//      fields every FROSTINGS entry already speaks (roughness / clearcoat / clearcoatRoughness /
//      envMapIntensity), so the "Copy config" output IS a frostings.js material descriptor — no new
//      knobs invented, no translation layer. (Reuse decision, per DRY.)
//   2. MARBLE — a procedural poured-flow colour field baked to a CanvasTexture and bound as the
//      material `map` (exactly the seam makeParticleFinishMaps already uses on the cake wall). Single
//      colour = solid tinted glaze (no map); multi colour = the marble.
//
// PHASE 0 (this file): the marble generator lives here for fast hot-reload while we settle the look.
// PHASE 1: it moves to spattoo-core (src/designer/shared/textures/marbleTexture.js, built on the
// shared makeValueNoise), is exported, and the designer + a re-pointed studio share the ONE copy.
// Nothing is saved to the DB — a base finish is a frostingType in code, not a cake_element, so the
// output here is copyable config we bake into frostings.js.

const R = 1.2, BOTTOM_H = 1.45, BOARD_H = 0.1, BOARD_R = 1.6;
const TOP_Y = BOARD_H + BOTTOM_H;

// ── Self-contained procedural marble field (Phase 0 — unify with core makeValueNoise in Phase 1) ──
const clamp01 = t => (t < 0 ? 0 : t > 1 ? 1 : t);
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
// Tileable 3D value noise (cell units). Sampling the marble on a CYLINDER — around → a circle in the
// x/y plane, height → z — makes the wall wrap with NO seam: u=0 and u=1 map to the same 3D point, so the
// texture's left and right columns are identical and the wrap is invisible.
function makeNoise3(lattice, seed) {
  const rnd = mulberry32(seed || 1);
  const L = lattice, g = new Float32Array(L * L * L);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  const w = n => ((n % L) + L) % L;
  const at = (x, y, z) => g[w(z) * L * L + w(y) * L + w(x)];
  const s = t => t * t * (3 - 2 * t);
  return (x, y, z) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
    const tx = s(x - x0), ty = s(y - y0), tz = s(z - z0);
    const c000 = at(x0, y0, z0), c100 = at(x0 + 1, y0, z0), c010 = at(x0, y0 + 1, z0), c110 = at(x0 + 1, y0 + 1, z0);
    const c001 = at(x0, y0, z0 + 1), c101 = at(x0 + 1, y0, z0 + 1), c011 = at(x0, y0 + 1, z0 + 1), c111 = at(x0 + 1, y0 + 1, z0 + 1);
    const a = c000 + (c100 - c000) * tx, b = c010 + (c110 - c010) * tx;
    const c = c001 + (c101 - c001) * tx, d = c011 + (c111 - c011) * tx;
    const e = a + (b - a) * ty, f = c + (d - c) * ty;
    return e + (f - e) * tz;
  };
}
function fbm3(noise, x, y, z, oct) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) { sum += amp * noise(x * freq, y * freq, z * freq); norm += amp; amp *= 0.5; freq *= 2; }
  return sum / norm;
}
function turb3(noise, x, y, z, oct) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) { sum += amp * Math.abs(noise(x * freq, y * freq, z * freq) - 0.5) * 2; norm += amp; amp *= 0.5; freq *= 2; }
  return sum / norm;
}
function paletteLerp(rgb, t) {
  if (rgb.length === 1) return rgb[0];
  const f = clamp01(t) * (rgb.length - 1);
  const i = Math.min(rgb.length - 2, Math.floor(f)), k = f - i;
  const a = rgb[i], b = rgb[i + 1];
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
// ── The marble as ONE continuous 3D field over object space (px,py,pz in cake units) ────────────────
// Sampled at the point's TRUE 3D position, so it is continuous across the WHOLE cake BY CONSTRUCTION:
// adjacent surface points (flat top ↔ rounded rim ↔ wall) are adjacent in 3D, so a vein is the SAME vein
// over top, rim and side — one poured skin of glaze, never three stitched patterns. No radius mapping, no
// top/wall branch, no "edge extrude" — the geometry itself carries the flow.
//
// The field is a DOMAIN-WARPED marble (organic sweeping veins like a real mirror glaze — NOT concentric
// rings), and it is SQUASHED VERTICALLY (Y scaled down): on the flat top (constant Y) that squash is
// invisible → 2D swirls; on the vertical wall (Y varies as you go down) every feature ELONGATES into a
// running DRIP. So the top-swirl that meets the rim keeps going as the drip directly below it. Returns a
// SMOOTH value in [0,1] the palette interpolates through — a mirror glaze is smooth, not hard-banded.
//   flow = vein frequency · warp = swirl/fold strength · contrast = vein sharpness · streak = fine veins
function makeMarbleField(params) {
  const seed = (params.seed | 0) || 1;
  const nW1 = makeNoise3(16, seed), nW2 = makeNoise3(16, seed + 17), nD = makeNoise3(16, seed + 41);
  const flow = params.flow ?? 2.6;
  const warp = params.warp ?? 1.1;
  const contrast = params.contrast ?? 3.2;
  const streak = params.streak ?? 0.12;
  const YS = 0.22;   // vertical squash → features run vertically (drips) on the wall, stay 2D on the top

  return (px, py, pz) => {
    const y = py * YS;
    // Domain warp: two 3D noise fields shove the sample point around → organic marble folds. Being 3D, the
    // warp carries continuously across the rim; the pre-squashed Y makes it drift slowly DOWN the wall so
    // drips wander gently like running glaze instead of ruler-straight bars.
    const wx = fbm3(nW1, px * 0.85, y * 0.85, pz * 0.85, 4) - 0.5;
    const wz = fbm3(nW2, px * 0.85 + 5.2, y * 0.85 + 2.1, pz * 0.85 + 9.3, 4) - 0.5;
    // Marble = a periodic function of a warped coordinate. A STRONG directional sweep keeps the veins as
    // flowing parallel-ish LINES (like a real poured glaze), while a moderate warp meanders them; too much
    // warp folds them into isotropic blobs instead of veins. Fine striations ride on top via `streak`.
    const coord = (px * 0.8 + pz * 1.0) + warp * 1.05 * (wx + wz)
                + (fbm3(nD, px * 2.4, y * 2.4, pz * 2.4, 3) - 0.5) * streak * 6;
    let t = 0.5 + 0.5 * Math.sin(coord * flow * 3.3);   // [0,1] — higher base frequency → finer veins
    // Vein sharpness: push toward 0/1 so veins read as defined ribbons, not a soft blur.
    const s = Math.max(0.5, contrast) * 0.5;
    t = 0.5 + Math.tanh((t - 0.5) * 2 * s) / (2 * Math.tanh(s));
    return t < 0 ? 0 : t > 1 ? 1 : t;
  };
}
// CHEAP: recolour a cached field ([0,1] marble value, at fieldRes) → CanvasTexture at `out`. The value is
// interpolated SMOOTHLY through the palette (paletteLerp) — a mirror glaze blends, it has no hard edges —
// and each ss×ss block is averaged for anti-aliasing (foreshortened rim + fine veins alias badly otherwise).
function paintField(field, fieldRes, out, colors, wrap) {
  const rgb = colors.map(hexToRgb);
  const ss = Math.max(1, Math.round(fieldRes / out));
  const cvs = document.createElement('canvas'); cvs.width = out; cvs.height = out;
  const ctx = cvs.getContext('2d');
  const img = ctx.createImageData(out, out);
  for (let oy = 0; oy < out; oy++) {
    for (let ox = 0; ox < out; ox++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) {
        const row = (oy * ss + sy) * fieldRes;
        for (let sx = 0; sx < ss; sx++) {
          const c = paletteLerp(rgb, field[row + ox * ss + sx]);   // smooth blend across the palette
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const k = ss * ss, j = (oy * out + ox) * 4;
      img.data[j] = r / k; img.data[j + 1] = g / k; img.data[j + 2] = b / k; img.data[j + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return texFrom(cvs, wrap);
}
function texFrom(cvs, wrap) {
  const tex = new THREE.CanvasTexture(cvs);
  tex.wrapS = tex.wrapT = wrap;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;   // the rounded rim is foreshortened at grazing angles — max anisotropy tames the moiré
  return tex;
}

// The reflected world the glaze mirrors. A glossy VERTICAL wall reflects the surround by ELEVATION
// (each wall row mirrors a different up/down band), so a surround that is uniform around but GRADED
// top→bottom gives the wall a smooth wet gradient — brightest where the pour crests the rim, fading
// down — with NO azimuthal features to band into vertical stripes. Same graded world lights the flat
// top, so top and wall read as ONE continuous wet coat instead of a bright lid on a dead body.
function makeGradientEnvTexture() {
  const H = 256, cvs = document.createElement('canvas'); cvs.width = 8; cvs.height = H;
  const ctx = cvs.getContext('2d');
  // v: 0 = straight up (sky) → 1 = straight down (floor). A bright band just above the horizon is what
  // a wet wall mirrors back as its sheen; the sky stays bright so the rim crest glows, the floor dims.
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0.00, '#eef3f7');   // sky — lifts the top + rim
  g.addColorStop(0.34, '#f7fafc');   // upper wall — bright, the "just poured" crest
  g.addColorStop(0.50, '#ffffff');   // horizon band — the wet highlight the wall mirrors
  g.addColorStop(0.66, '#dfe7ee');   // lower wall — sheen fading as the glaze runs down
  g.addColorStop(1.00, '#aeb9c2');   // floor — grounds the base of the pour
  ctx.fillStyle = g; ctx.fillRect(0, 0, 8, H);
  return texFrom(cvs, THREE.ClampToEdgeWrapping);
}
// Bake the raw FIELD over the WALL (rows = height, cols = angle around) into a Float array. Left/right
// columns are the same angle → seamless wrap. The straight wall sits at radius R; the rounded rim (top r
// of the height) is sampled at its TRUE tapering radius R→innerR along the quarter-round, so the cap's
// planar pattern flows continuously across the corner instead of freezing into a single-ring band.
function bakeFieldWall(sample, size, R, H, r) {
  const f = new Float32Array(size * size);
  const capBase = H - r;
  for (let y = 0; y < size; y++) {
    const h = (1 - y / size) * H;
    let rho = R;
    if (r > 1e-6 && h > capBase) {
      const t = Math.min(1, (h - capBase) / r);     // 0 at rim bottom → 1 at rim top
      rho = R - r * (1 - Math.sqrt(1 - t * t));      // quarter-round radius: R → (R - r) = innerR
    }
    for (let x = 0; x < size; x++) {
      const th = (x / size) * Math.PI * 2;
      f[y * size + x] = sample(rho * Math.cos(th), h, rho * Math.sin(th));
    }
  }
  return f;
}
// Bake the raw FIELD over the flat TOP disc — a planar slice at height H. Extent is innerR (the disc's
// own radius) so its CircleGeometry UV maps 1:1 onto marble radius, and the disc edge = marble(innerR) =
// the rim top → no jump where the flat top meets the rounded rim.
function bakeFieldTop(sample, size, innerR, H) {
  const f = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const pz = (y / size * 2 - 1) * innerR;
    for (let x = 0; x < size; x++) f[y * size + x] = sample((x / size * 2 - 1) * innerR, H, pz);
  }
  return f;
}

// Drip tendrils — the glaze that has run down the wall and hangs off the bottom edge as an irregular,
// rounded pendant fringe (the single biggest "poured glaze" cue in the reference photo). A per-angle depth
// = a gently wavy baseline (glaze sheets down all the way round) + a few Gaussian tendrils (where it ran
// heavier and hangs lower) is revolved into a thin skirt below the wall bottom. The Gaussian falloff gives
// each tendril a naturally ROUNDED tip. Returns the skirt geometry (top edge at local y=0 = the wall
// bottom, hanging to y=−depth) plus the peak depth so the caller can seat the board below the longest drip.
function makeDripGeometry(R, drip, seed) {
  const SEG = 320;
  const rnd = mulberry32(((seed | 0) || 1) * 131 + 7);
  const phase = rnd() * Math.PI * 2, phase2 = rnd() * Math.PI * 2;
  const base = drip * 0.62;                                  // baseline sheet depth (never bare)
  const peaks = [];
  const nT = 9 + Math.round(rnd() * 8);                      // a handful of longer tendrils
  for (let i = 0; i < nT; i++) peaks.push({ a: rnd() * Math.PI * 2, w: 0.025 + rnd() * 0.055, h: drip * (0.45 + rnd() * 0.7) });
  const depth = (th) => {
    let d = base * (0.8 + 0.2 * Math.sin(th * 9 + phase) + 0.1 * Math.sin(th * 21 + phase2));
    for (const p of peaks) {
      let da = ((th - p.a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;  // shortest angular gap
      d += p.h * Math.exp(-(da * da) / (2 * p.w * p.w));
    }
    return d;
  };
  const pos = [], idx = [];
  let maxD = 0;
  for (let i = 0; i <= SEG; i++) {
    const th = (i / SEG) * Math.PI * 2;
    const x = R * Math.cos(th), z = R * Math.sin(th), d = depth(th);
    if (d > maxD) maxD = d;
    pos.push(x, 0, z, x, -d, z);                             // top vertex (wall bottom), bottom vertex (drip tip)
  }
  for (let i = 0; i < SEG; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geo: g, maxDepth: maxD };
}

// Debounce a fast-changing value: the expensive marble bake should fire only after a slider settles, not
// on every intermediate tick of a drag (that is what froze the studio while scrubbing Flow).
function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => { const id = setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return v;
}

// The glazed cake: a LATHE of a profile whose top edge is ROUNDED by `rim` (0 = sharp), wearing the
// glaze material as ONE seamless surface (wall → rounded rim → top). Single colour → solid tint;
// multi colour → the marble map. Material is kept live-synced without a rebuild (like the drip studio).
function GlazedCake({ colors, marbleParams, material, rim, drip }) {
  const H = BOTTOM_H;
  const r = Math.max(0, Math.min(rim, R - 0.05, H - 0.05));
  const innerR = R - r;
  const SIZE = 640;      // output texture size
  const FR = SIZE;       // field bake resolution — no supersample: the SMOOTH field barely aliases (unlike
                         // the old hard bands), so we skip the 4× cost of SS=2 and lean on anisotropy.
  const isMarble = colors.length > 1;

  // EXPENSIVE — the 3D marble field. Recompute ONLY when the pattern params change (flow / warp / contrast
  // / streak / seed / rim), never on colours. Debounced so scrubbing a slider bakes once it SETTLES, not on
  // every intermediate tick — that repeated synchronous bake is what froze the studio.
  const fieldSig = useDebounced(`${marbleParams.flow}|${marbleParams.warp}|${marbleParams.contrast}|${marbleParams.streak}|${marbleParams.seed}|${r}`, 170);
  const fields = useMemo(() => {
    if (!isMarble) return null;
    const s = makeMarbleField(marbleParams);
    // The field is sampled at each surface point's TRUE 3D position; the bakers just feed real geometry
    // (wall at radius R, rim at its tapering radius, top on its plane) so the 3D field stays continuous.
    return { wall: bakeFieldWall(s, FR, R, H, r), top: bakeFieldTop(s, FR, innerR, H) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMarble, fieldSig]);

  // CHEAP — recolour + downsample the cached field when colours change (no marbling recompute).
  const wallTex = useMemo(() => (fields ? paintField(fields.wall, FR, SIZE, colors, THREE.RepeatWrapping) : null), [fields, colors.join(',')]);
  const topTex  = useMemo(() => (fields ? paintField(fields.top, FR, SIZE, colors, THREE.ClampToEdgeWrapping) : null), [fields, colors.join(',')]);

  // Two materials (wall + top) — same physics, different baked map. They share ONE 3D field so their
  // colours line up exactly at the rim.
  const wallMat = useMemo(() => new THREE.MeshPhysicalMaterial({ metalness: 0 }), []);
  const topMat  = useMemo(() => new THREE.MeshPhysicalMaterial({ metalness: 0 }), []);
  for (const [m, tex] of [[wallMat, wallTex], [topMat, topTex]]) {
    m.map = tex;
    m.color.set(tex ? '#ffffff' : colors[0]);
    m.roughness = material.roughness;
    m.clearcoat = material.clearcoat;
    m.clearcoatRoughness = material.clearcoatRoughness;
    m.envMapIntensity = material.envMapIntensity;
    m.needsUpdate = true;
  }

  // Drip fringe geometry (positions) — rebuilt only when the drip length or seed changes.
  const dripFringe = useMemo(() => (drip > 0.001 ? makeDripGeometry(R, drip, marbleParams.seed) : null), [drip, marbleParams.seed]);
  // Per-vertex marble colour for the fringe: sample the SAME field at each drip's angle (cake-local y=0 =
  // the wall bottom), so every tendril carries the colour of the streak directly above it — one flow.
  useMemo(() => {
    if (!dripFringe) return;
    const geo = dripFringe.geo, p = geo.getAttribute('position');
    const rgb = colors.map(hexToRgb);
    const s = isMarble ? makeMarbleField(marbleParams) : null;
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const c = s ? paletteLerp(rgb, s(p.getX(i), 0, p.getZ(i))) : rgb[0];
      col[i * 3] = c[0] / 255; col[i * 3 + 1] = c[1] / 255; col[i * 3 + 2] = c[2] / 255;
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  }, [dripFringe, isMarble, colors.join(','), marbleParams.flow, marbleParams.warp, marbleParams.contrast, marbleParams.streak, marbleParams.seed]);

  // Fringe wears the same wet glaze material; vertexColors carry the marble down each tendril.
  const dripMat = useMemo(() => new THREE.MeshPhysicalMaterial({ metalness: 0, vertexColors: true }), []);
  dripMat.vertexColors = true;
  dripMat.color.set('#ffffff');
  dripMat.roughness = material.roughness;
  dripMat.clearcoat = material.clearcoat;
  dripMat.clearcoatRoughness = material.clearcoatRoughness;
  dripMat.envMapIntensity = material.envMapIntensity;
  dripMat.side = THREE.DoubleSide;   // thin skirt — show both faces so a tendril never vanishes edge-on
  dripMat.needsUpdate = true;

  // Seat the board just below the LONGEST tendril so the drips read as hanging, not buried in the board.
  const boardTopY = BOARD_H - (dripFringe ? dripFringe.maxDepth + 0.03 : 0);

  // Wall + rounded rim, revolved, ending at the inner rim radius (OPEN top — the flat disc caps it, so
  // there is no converging lathe centre to pinwheel).
  const wallGeo = useMemo(() => {
    const pts = [new THREE.Vector2(R, 0), new THREE.Vector2(R, H - r)];
    if (r > 0.001) {
      const SEG = 14;
      for (let i = 1; i <= SEG; i++) { const a = (Math.PI / 2) * (i / SEG); pts.push(new THREE.Vector2(R - r * (1 - Math.cos(a)), (H - r) + r * Math.sin(a))); }
    } else {
      pts.push(new THREE.Vector2(R, H));
    }
    return new THREE.LatheGeometry(pts, 200);
  }, [r]);

  return (
    <group>
      <mesh position={[0, boardTopY - BOARD_H / 2, 0]}>
        <cylinderGeometry args={[BOARD_R, BOARD_R, BOARD_H, 72]} />
        <meshStandardMaterial color="#d9b44a" metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[0, BOARD_H, 0]} geometry={wallGeo} material={wallMat} />
      {dripFringe && <mesh position={[0, BOARD_H, 0]} geometry={dripFringe.geo} material={dripMat} />}
      <mesh position={[0, BOARD_H + H, 0]} rotation={[-Math.PI / 2, 0, 0]} material={topMat}>
        <circleGeometry args={[innerR, 128]} />
      </mesh>
    </group>
  );
}

const S = {
  page: { minHeight: '100vh', background: '#EDEAE2', fontFamily: 'Quicksand, sans-serif', padding: '28px 24px' },
  title: { fontSize: 22, fontWeight: 800, color: '#2C4433' },
  sub: { fontSize: 13, color: '#7A8F80', marginBottom: 14 },
  steps: { background: '#fff', borderRadius: 14, border: '1.5px solid #C5D4C8', padding: '14px 18px', marginBottom: 18, maxWidth: 1300 },
  stepsTitle: { fontSize: 12, fontWeight: 800, color: '#2C4433', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 },
  stepsList: { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 5 },
  stepItem: { fontSize: 12.5, color: '#3D5A44', fontWeight: 600, lineHeight: 1.5 },
  stepsNote: { fontSize: 11, color: '#9BB5A2', marginTop: 9, lineHeight: 1.5 },
  layout: { display: 'grid', gridTemplateColumns: '320px minmax(0,1fr)', gap: 20, maxWidth: 1300, alignItems: 'start' },
  card: { background: '#fff', borderRadius: 18, border: '1.5px solid #C5D4C8', padding: 22 },
  label: { fontSize: 11, fontWeight: 800, color: '#3D5A44', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6, marginTop: 14, display: 'block' },
  row: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 },
  rowLabel: { fontSize: 12, fontWeight: 700, color: '#3D5A44', minWidth: 96 },
  val: { fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 46, textAlign: 'right' },
  btn: { marginTop: 12, padding: '10px 14px', borderRadius: 8, border: 'none', background: '#3D5A44', color: '#fff', fontFamily: 'Quicksand, sans-serif', fontSize: 13, fontWeight: 700, cursor: 'pointer', width: '100%' },
  ghost: { marginTop: 8, padding: '8px 14px', borderRadius: 8, border: '1.5px solid #C5D4C8', background: '#fff', color: '#3D5A44', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, cursor: 'pointer', width: '100%' },
  hint: { fontSize: 11, color: '#9BB5A2', marginTop: 6, lineHeight: 1.5 },
  swatchRow: { display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' },
  colorInput: { width: 40, height: 32, padding: 0, border: '1.5px solid #C5D4C8', borderRadius: 8, background: '#fff', cursor: 'pointer' },
  pill: { padding: '4px 10px', borderRadius: 20, border: '1.5px solid #C5D4C8', background: '#fff', color: '#3D5A44', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
};

function Slider({ label, value, min, max, step, onChange, fmt = v => v }) {
  return (
    <div style={S.row}>
      <span style={S.rowLabel}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)} style={{ flex: 1, accentColor: '#3D5A44' }} />
      <span style={S.val}>{fmt(value)}</span>
    </div>
  );
}

// A near-black poured-chocolate glaze, and a colourful marble, as the two starting points.
const PRESET_COLORS = ['#141414', '#4a2c1a', '#c0392b', '#2e86c1', '#e8b71b'];

export default function GlazeStudio() {
  // Colours: 1 = solid glaze, 2..5 = marble. Start on a deep-chocolate two-tone (wet ganache look).
  const [colors, setColors] = useState(['#1a0f0a', '#3a2114']);

  // MATERIAL — the SAME MeshPhysicalMaterial fields frostings.js uses. Starting point ≈ a wet mirror.
  // Wet mirror glaze — glossy again. The bold marbling reads THROUGH it now, and the uniform-sphere env
  // means high gloss no longer bands into stripes, so we can be shiny AND colourful.
  const [roughness, setRoughness]   = useState(0.12);
  const [clearcoat, setClearcoat]   = useState(1.0);
  const [ccRough, setCcRough]       = useState(0.05);
  const [envIntensity, setEnvI]     = useState(1.4);
  // Shape — how much the top rim is rounded over (0 = sharp edge; glaze cakes read best slightly round).
  // A poured mirror glaze has only a SUBTLE rounded edge. A big rim foreshortens the pattern's outer
  // annulus into a busy strip that reads as a "separate" band — keep the default small so cap → wall flows.
  const [rim, setRim]               = useState(0.05);
  // Drip tendrils hanging off the bottom edge — 0 = clean, higher = longer drips. Kept to a SAFE range: a
  // long drip drops the board to stay under it, and too much reads as a floating cake. This is an authored
  // finish property, NOT a customer-facing knob in core.
  const [drip, setDrip]             = useState(0.18);

  // MARBLE — big organic rivers with defined edges. Contrast up so colours read as distinct (the
  // weak-marble fix); streak adds thin poured veins.
  const [flow, setFlow]         = useState(2.6);
  const [warp, setWarp]         = useState(1.1);
  const [contrast, setContrast] = useState(3.2);
  const [streak, setStreak]     = useState(0.12);
  const [seed, setSeed]         = useState(1);

  const material = { roughness, clearcoat, clearcoatRoughness: ccRough, envMapIntensity: envIntensity };
  const marbleParams = { flow, warp, contrast, streak, seed };
  // The graded surround the glaze mirrors — built once; same world lights top + wall (seamless sheen).
  const envTex = useMemo(() => makeGradientEnvTexture(), []);

  const setColorAt = (i, v) => setColors(cs => cs.map((c, j) => (j === i ? v : c)));
  const addColor = () => setColors(cs => (cs.length >= 5 ? cs : [...cs, PRESET_COLORS[cs.length] ?? '#888888']));
  const removeColor = () => setColors(cs => (cs.length <= 1 ? cs : cs.slice(0, -1)));

  function copyJson() {
    const json = {
      // paste under a new FROSTINGS entry's `material` in spattoo-core/src/designer/frostings.js
      material: {
        roughness: +roughness.toFixed(3), metalness: 0,
        clearcoat: +clearcoat.toFixed(2), clearcoatRoughness: +ccRough.toFixed(3),
        envMapIntensity: +envIntensity.toFixed(2), sheen: 0,
      },
      // the marble default the tier carries as styleParams-style config
      marble: {
        colors: [...colors],
        flow: +flow.toFixed(2), warp: +warp.toFixed(2), contrast: +contrast.toFixed(2), streak: +streak.toFixed(2),
      },
      // geometry hint for the glaze finish — how much to round the top rim
      shape: { rim: +rim.toFixed(2), drip: +drip.toFixed(2) },
    };
    navigator.clipboard?.writeText(JSON.stringify(json, null, 2));
  }

  return (
    <div style={S.page}>
      <div style={S.title}>Glaze Studio</div>
      <div style={S.sub}>Dial in a mirror glaze — wet sheen + poured marble — on a real cake before porting to core. Drag to orbit; reroll for a fresh pour.</div>

      <div style={S.steps}>
        <div style={S.stepsTitle}>How to tune this glaze</div>
        <ol style={S.stepsList}>
          <li style={S.stepItem}><b>Pick your colours.</b> One colour = a solid glaze; two to five = a marble. Use <b>+ colour / − colour</b>, and tap a swatch to change it. Left→right is the order they blend across the pour.</li>
          <li style={S.stepItem}><b>Set the wet sheen</b> (Material). <b>Gloss</b> — lower = more mirror. <b>Clearcoat</b> — the wet glass layer on top (keep near 1). <b>Coat roughness</b> — how sharp that sheen is. <b>Reflection</b> — how strongly it mirrors the room.</li>
          <li style={S.stepItem}><b>Shape the pour</b> (Marble). <b>Flow</b> — vein size. <b>Swirl</b> — how much they fold/pour. <b>Contrast</b> — vein sharpness. <b>Streak</b> — fine striations.</li>
          <li style={S.stepItem}><b>Reroll pour</b> for a fresh random pattern; <b>drag the cake</b> to orbit and judge it from every angle.</li>
          <li style={S.stepItem}>When it looks right, hit <b>Copy config JSON</b> and paste it back to me — I’ll bake it into the cake designer.</li>
        </ol>
        <div style={S.stepsNote}>Tip: for a <b>colourful marble that flows like liquid</b>, keep <b>Clearcoat ≈ 1</b> for the wet sheen but raise <b>Gloss to ~0.25–0.35</b> so the colour reads on the sides (near-0 turns it into a mirror that hides the marble). Then push <b>Flow</b> for more rivers, <b>Swirl</b> for wavier drips, and <b>Streak</b> for fine veins. For a <b>dark chocolate mirror</b> instead, drop Gloss near 0 with one deep colour.</div>
      </div>

      <div style={S.layout}>
        <div style={S.card}>
          <label style={{ ...S.label, marginTop: 0 }}>Colours <span style={{ fontWeight: 600, color: '#9BB5A2' }}>({colors.length === 1 ? 'solid' : 'marble'})</span></label>
          <div style={S.swatchRow}>
            {colors.map((c, i) => (
              <input key={i} type="color" value={c} onChange={e => setColorAt(i, e.target.value)} style={S.colorInput} />
            ))}
            <button style={S.pill} onClick={addColor} disabled={colors.length >= 5}>+ colour</button>
            {colors.length > 1 && <button style={S.pill} onClick={removeColor}>− colour</button>}
          </div>

          <label style={S.label}>Material — the wet mirror sheen</label>
          <Slider label="Gloss (roughness)" value={roughness}    min={0.01} max={0.5} step={0.005} onChange={setRoughness} fmt={v => v.toFixed(3)} />
          <Slider label="Clearcoat"         value={clearcoat}    min={0}    max={1}   step={0.02}  onChange={setClearcoat} fmt={v => v.toFixed(2)} />
          <Slider label="Coat roughness"    value={ccRough}      min={0}    max={0.3} step={0.005} onChange={setCcRough}   fmt={v => v.toFixed(3)} />
          <Slider label="Reflection (env)"  value={envIntensity} min={0}    max={3}   step={0.05}  onChange={setEnvI}      fmt={v => v.toFixed(2)} />

          <label style={S.label}>Shape</label>
          <Slider label="Rim round"        value={rim}      min={0}   max={0.35} step={0.01} onChange={setRim}      fmt={v => v.toFixed(2)} />
          <Slider label="Drip length"      value={drip}     min={0}   max={0.3}  step={0.01} onChange={setDrip}     fmt={v => v.toFixed(2)} />

          <label style={S.label}>Marble — the poured flow</label>
          <Slider label="Flow (band size)" value={flow}     min={0.5} max={6}   step={0.1}  onChange={setFlow}     fmt={v => v.toFixed(1)} />
          <Slider label="Swirl (pour)"     value={warp}     min={0}   max={1.2} step={0.02} onChange={setWarp}     fmt={v => v.toFixed(2)} />
          <Slider label="Contrast"         value={contrast} min={0.5} max={6}   step={0.05} onChange={setContrast} fmt={v => v.toFixed(2)} />
          <Slider label="Streak"           value={streak}   min={0}   max={0.5} step={0.02} onChange={setStreak}   fmt={v => v.toFixed(2)} />

          <button style={S.btn} onClick={() => setSeed(s => s + 1)}>Reroll pour</button>
          <button style={S.ghost} onClick={copyJson}>Copy config JSON</button>
          <div style={S.hint}>The material sliders map 1:1 onto the MeshPhysicalMaterial fields frostings.js already uses, so “Copy config” is a ready-to-paste FROSTINGS descriptor + marble default.</div>
        </div>

        <div style={{ ...S.card, padding: 0, overflow: 'hidden' }}>
          <div style={{ height: 600, background: '#E8EDE9' }}>
            <Canvas gl={{ preserveDrawingBuffer: true, alpha: true }} camera={{ position: [0, 4.2, 3.8], fov: 40 }}>
              {/* LIQUID look = a SHARP bright specular. A soft ambient env flattens the surface into
                  plastic, so keep ambient low and let bright reflected softboxes (Lightformers) create
                  the wet highlight the glaze mirrors back — the single biggest "wet chocolate" cue.
                  NOTE for Phase 1: core's cake scene must carry an equivalently bright reflector for the
                  glaze to read liquid there too (its lebombo HDRI helps, but a wet key light seals it). */}
              {/* SEAMLESS graded surround. A glossy cylinder reflects any distinct light as a bright bar
                  and the gap next to it as a dark bar → vertical "brushed-metal" stripes, so the surround
                  stays uniform AROUND (no gaps). But it is graded top→bottom: the vertical wall mirrors a
                  bright band near the rim fading downward — the wet "poured over the edge" gradient — while
                  the flat top mirrors the same bright sky. One world lights both, so the wall is no longer
                  a dead matte body under a shiny lid; top + side read as one continuous wet coat. A soft
                  overhead ring adds a crisp mirror highlight on the top. */}
              <ambientLight intensity={0.25} />
              <Environment resolution={256}>
                <mesh scale={60}>
                  <sphereGeometry args={[1, 32, 32]} />
                  <meshBasicMaterial map={envTex} side={THREE.BackSide} toneMapped={false} />
                </mesh>
                <Lightformer form="ring" intensity={2.2} position={[0, 10, 1]} rotation={[-Math.PI / 2, 0, 0]} scale={[16, 16, 1]} />
                {/* ONE broad soft vertical softbox — the "window" a wet wall mirrors as a single bright
                    streak running down it (the strongest wet-chocolate cue). Kept BROAD + SINGLE so it
                    reads as one soft highlight, not the many-gap brushed-metal striping the ring avoids.
                    It faces the origin (default target), so orbiting sweeps the streak around the wall. */}
                <Lightformer form="rect" intensity={2.4} position={[2.6, 4.2, 6]} scale={[2.6, 9, 1]} color="#ffffff" />
              </Environment>
              <GlazedCake colors={colors} marbleParams={marbleParams} material={material} rim={rim} drip={drip} />
              <OrbitControls target={[0, 1.1, 0]} makeDefault enablePan minPolarAngle={0.2} maxPolarAngle={Math.PI / 2.05} />
            </Canvas>
          </div>
        </div>
      </div>
    </div>
  );
}
