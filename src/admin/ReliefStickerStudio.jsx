import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import * as THREE from 'three';
import { extractRegions, recolorRegions } from './recolor.js';
import { prepareElementImage } from '../lib/elementImage.js';
import { fetchGlobalElement } from '../lib/api.js';
// Solid-slab geometry — the SAME builder the designer renders for placement_config.relief.solid, so the
// studio preview is WYSIWYG (one builder in spattoo-core, no mirrored copy to drift). `corsUrl` is the
// designer's own R2 qualifier — a plain fetch of an element image can otherwise hit a non-CORS cache entry.
import { buildSolidReliefGeometry, dominantColorOfImage, buildSolidWallMaterial, corsUrl, SOLID_FINISHES, SOLID_FINISH_ORDER } from '@spattoo/designer';

// Draw an image onto a fresh canvas (capped at `max`px on the long edge) so the pixels can be recoloured.
function imgToCanvas(img, max = 1024) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const scale = Math.min(1, max / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale)), h = Math.max(1, Math.round(ih * scale));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c;
}

// Push chroma away from per-pixel luma by `mul` (>1 = more saturated) — mirrors core CakeCanvas `saturateRGB`
// so the studio's print_finish "Saturation" preview matches what the designer renders. In place; alpha kept.
function saturateCanvas(canvas, mul) {
  if (mul === 1) return canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height), d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2], y = 0.299 * r + 0.587 * g + 0.114 * b;
    d[i]     = Math.max(0, Math.min(255, y + (r - y) * mul));
    d[i + 1] = Math.max(0, Math.min(255, y + (g - y) * mul));
    d[i + 2] = Math.max(0, Math.min(255, y + (b - y) * mul));
  }
  ctx.putImageData(id, 0, 0);
  return canvas;
}

// ── Relief Sticker Studio (prototype) ───────────────────────────────────────────────────────────
// Raise a flat 2D image into a clean fondant cut-out WITHOUT a GLB. The trick that avoids the ugly
// grid "sawtooth": the cut-out edge is a ROUNDED, beveled shoulder (a smooth ramp from the wall up to
// the slab), never a vertical cliff — plus an MSAA (alphaToCoverage) silhouette so the outline is
// clean. Displacement gives real lift (+ shadow); the normal map carries surface detail. Lit on the
// real cake (same tier/board + SceneLights + apartment env + ACES as core). Sandbox; bakes into core.

const TIER_R = 1.2, TIER_H = 1.45, BOARD_BASE = 0.1, BOARD_R = 1.62;
const MID_Y = BOARD_BASE + TIER_H / 2, TOP_Y = BOARD_BASE + TIER_H;
const WORK = 1024;   // resolution the normal/displacement maps are computed at (crisper relief)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function boxBlur(src, w, h, radius, passes = 1) {
  let a = Float32Array.from(src), b = new Float32Array(w * h);
  const norm = 1 / (2 * radius + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const base = y * w; let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += a[base + clamp(k, 0, w - 1)];
      for (let x = 0; x < w; x++) { b[base + x] = sum * norm; sum += a[base + clamp(x + radius + 1, 0, w - 1)] - a[base + clamp(x - radius, 0, w - 1)]; }
    }
    [a, b] = [b, a];
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += a[clamp(k, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) { b[y * w + x] = sum * norm; sum += a[clamp(y + radius + 1, 0, h - 1) * w + x] - a[clamp(y - radius, 0, h - 1) * w + x]; }
    }
    [a, b] = [b, a];
  }
  return a;
}

// The field grid the maps are computed on (image capped to WORK on the long edge). Shared by imageToFields
// and the flat-mask canvas so the painted mask samples 1:1 onto the fields.
function fieldSize(img) {
  const scale = Math.min(1, WORK / Math.max(img.naturalWidth, img.naturalHeight));
  return { w: Math.max(1, Math.round(img.naturalWidth * scale)), h: Math.max(1, Math.round(img.naturalHeight * scale)) };
}

// Sample the author's grayscale flat-mask canvas onto the field grid → a Float array (0..1) where the RED
// channel is the RAISED factor (white 1 = raised, black 0 = flush). null when nothing painted, so the bake
// behaves exactly as before. Orientation matches imageToFields (no flip here; core flips both together).
function sampleFlatMask(maskCanvas, w, h, painted) {
  if (!maskCanvas || !painted) return null;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(maskCanvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = d[i * 4] / 255;
  return out;
}

// Downscale the mask to ~128px on the long edge and encode a PNG data-URI for placement_config.relief.flatMask.
function maskToDataURL(maskCanvas) {
  const scale = Math.min(1, 128 / Math.max(maskCanvas.width, maskCanvas.height));
  const w = Math.max(1, Math.round(maskCanvas.width * scale)), h = Math.max(1, Math.round(maskCanvas.height * scale));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(maskCanvas, 0, 0, w, h);
  return c.toDataURL('image/png');
}

function imageToFields(img) {
  const { w, h } = fieldSize(img);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const mask = new Float32Array(w * h), lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = d[i * 4 + 3] / 255; mask[i] = a;
    lum[i] = a * (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
  }
  return { w, h, mask, lum };
}

// Build the displacement height (macro form) + a normal-map height (form + fine detail). The macro
// height = coverage × (flat slab ↔ central dome). coverage is a SMOOTH ramp at the silhouette (rounded
// bevel, radius = edgeRound) → no vertical cliff → no sawtooth. dome is the normalized blurred
// silhouette (gentle central bulge); `puff` blends slab↔dome. detail (luminance high-pass) adds the
// spots/eye to the normal map only.
// flattenThin (0 = off) + flatMask (optional per-pixel 0..1) keep parts of the sticker FLUSH on the wall,
// both COLOUR-INDEPENDENT — MUST match core reliefMaps.js buildFields exactly. flattenThin erodes the
// silhouette so THIN protrusions (spikes) hug the wall; flatMask is an authored black=flush paint mask.
function buildFields(f, { puff, detail, blur, edgeRound, flipY, grain, flattenThin = 0, flatMask = null, flatTop = 0 }) {
  const { w, h, mask, lum } = f, N = w * h;
  const domeRaw = boxBlur(mask, w, h, Math.max(1, Math.round(blur)), 2);
  let dmx = 1e-4; for (let i = 0; i < N; i++) if (mask[i] > 0.5 && domeRaw[i] > dmx) dmx = domeRaw[i];
  const cov = boxBlur(mask, w, h, Math.max(1, Math.round(edgeRound)), 2);
  const lumBlur = boxBlur(lum, w, h, 2, 1);
  const thinR = flattenThin > 0 ? Math.max(2, Math.round(flattenThin * 55)) : 0;
  const thinCov = thinR ? boxBlur(mask, w, h, thinR, 2) : null;
  // Flat-top plaque (bake.flatTop, 0 = off): blend the domed form toward a UNIFORM plateau (whole silhouette
  // at one flat height, small rounded edge) — MUST match core reliefMaps.js buildFields exactly.
  const plateauCov = flatTop > 0 ? boxBlur(mask, w, h, Math.max(2, Math.round(edgeRound * 0.35)), 2) : null;
  // Fondant micro-grain: fine deterministic hash noise, lightly smoothed → a powdery satin surface.
  // Added to the NORMAL height only (not displacement) so it shades like grain without moving geometry.
  let grainF = null;
  if (grain > 0) {
    const raw = new Float32Array(N);
    for (let i = 0; i < N; i++) { const s = Math.sin((i % w) * 12.9898 + ((i / w) | 0) * 78.233) * 43758.5453; raw[i] = (s - Math.floor(s)) - 0.5; }
    grainF = boxBlur(raw, w, h, 1, 1);
  }
  const H = new Float32Array(N), Hn = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const coverage = smoothstep(0.30, 0.85, cov[i]);          // rounded shoulder 0..1
    const dome = clamp(domeRaw[i] / dmx, 0, 1);
    let form = coverage * ((1 - puff) + puff * dome);         // domed ↔ slab sculpted form
    if (plateauCov) form = form * (1 - flatTop) + smoothstep(0.35, 0.65, plateauCov[i]) * flatTop;  // → flat plaque
    const thin = thinCov ? smoothstep(0.50, 0.66, thinCov[i]) : 1;   // thin protrusion → 0 (flush on wall)
    const authored = flatMask ? flatMask[i] : 1;                     // painted mask: 0 = flush, 1 = raised
    const macro = form * thin * authored;
    H[i] = macro;
    // flatTop fades out the image-derived surface detail so a flat plaque reads truly flat (MUST match core).
    const detailN = 1 - flatTop;
    let hn = macro + (lum[i] - lumBlur[i]) * detail * coverage * detailN;
    if (grainF) hn += grainF[i] * grain * 0.09 * coverage;
    Hn[i] = clamp(hn, 0, 1.4);
  }
  return { H, Hn, w, h, flipY };
}

function normalCanvas({ Hn, w, h, flipY }) {
  const out = new Uint8ClampedArray(w * h * 4);
  const at = (x, y) => Hn[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (at(x - 1, y) - at(x + 1, y)) * 4;
    let dy = (at(x, y - 1) - at(x, y + 1)) * 4; if (flipY) dy = -dy;
    let nx = dx, ny = dy, nz = 1; const len = Math.hypot(nx, ny, nz) || 1; nx /= len; ny /= len; nz /= len;
    const i = (y * w + x) * 4;
    out[i] = (nx * 0.5 + 0.5) * 255; out[i + 1] = (ny * 0.5 + 0.5) * 255; out[i + 2] = (nz * 0.5 + 0.5) * 255; out[i + 3] = 255;
  }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0); return c;
}

function dispCanvas({ H, w, h }) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { const g = clamp(H[i], 0, 1) * 255; out[i * 4] = g; out[i * 4 + 1] = g; out[i * 4 + 2] = g; out[i * 4 + 3] = 255; }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0); return c;
}

function buildDelitAlbedo(img, strength) {
  const scale = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const id = ctx.getImageData(0, 0, w, h); const d = id.data;
  const lum = new Float32Array(w * h), mask = new Float32Array(w * h);
  let sum = 0, cnt = 0;
  for (let i = 0; i < w * h; i++) {
    const a = d[i * 4 + 3] / 255; mask[i] = a;
    const l = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
    lum[i] = l * a; if (a > 0.5) { sum += l; cnt++; }
  }
  const mean = cnt ? sum / cnt : 0.5;
  const R = Math.max(8, Math.round(Math.max(w, h) / 8));
  const lumLow = boxBlur(lum, w, h, R, 2), maskLow = boxBlur(mask, w, h, R, 2);
  for (let i = 0; i < w * h; i++) {
    if (mask[i] < 0.01) continue;
    const local = lumLow[i] / Math.max(maskLow[i], 1e-3);
    let f = 1 + (mean / Math.max(local, 1e-3) - 1) * strength; f = clamp(f, 0.45, 2.2);
    d[i * 4] = clamp(d[i * 4] * f, 0, 255); d[i * 4 + 1] = clamp(d[i * 4 + 1] * f, 0, 255); d[i * 4 + 2] = clamp(d[i * 4 + 2] * f, 0, 255);
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

function curvedPlaneGeometry(w, h, radius, xs = 200, ys = 140) {
  const geo = new THREE.PlaneGeometry(w, h, xs, ys);
  const pos = geo.attributes.position, nrm = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const theta = pos.getX(i) / radius;
    pos.setXYZ(i, radius * Math.sin(theta), pos.getY(i), radius * Math.cos(theta));
    nrm.setXYZ(i, Math.sin(theta), 0, Math.cos(theta));
  }
  pos.needsUpdate = true; nrm.needsUpdate = true;
  return geo;
}

function placement(zone, mode, w, h) {
  if (zone === 'side' && mode === 'hug')
    return { geo: curvedPlaneGeometry(w, h, TIER_R + 0.004), pos: [0, MID_Y, 0], rot: [0, 0, 0] };
  if (zone === 'side')
    return { geo: new THREE.PlaneGeometry(w, h, 200, 200), pos: [0, MID_Y, TIER_R + 0.03], rot: [0, 0, 0] };
  if (zone === 'top' && mode === 'hug')
    return { geo: new THREE.PlaneGeometry(w, h, 200, 200), pos: [0, TOP_Y + 0.002, 0], rot: [-Math.PI / 2, 0, 0] };
  return { geo: new THREE.PlaneGeometry(w, h, 200, 200), pos: [0, TOP_Y + h / 2, 0], rot: [0, 0, 0] };
}

function Cake({ color }) {
  return (
    <group>
      <mesh position={[0, BOARD_BASE / 2, 0]} receiveShadow>
        <cylinderGeometry args={[BOARD_R, BOARD_R, BOARD_BASE, 72]} />
        <meshStandardMaterial color="#d4af37" roughness={0.15} metalness={0.75} />
      </mesh>
      <mesh position={[0, MID_Y, 0]} receiveShadow castShadow>
        <cylinderGeometry args={[TIER_R, TIER_R, TIER_H, 96]} />
        <meshPhysicalMaterial color={color} roughness={0.85} metalness={0} sheen={0.4} sheenColor={color} sheenRoughness={0.9} />
      </mesh>
    </group>
  );
}

// Module-scope so React keeps the SAME <input> across renders — defining it inside the component
// remounts the input on every value change, which drops an in-progress drag (the "have to click each
// time" bug). One stable Slider for the whole studio.
function Slider({ label, value, set, min, max, step = 0.01, fmt = v => v.toFixed(2) }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: '#6B8C74', width: 96 }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => set(+e.target.value)} style={{ flex: 1, accentColor: '#3D5A44' }} />
      <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44', width: 40, textAlign: 'right' }}>{fmt(value)}</span>
    </div>
  );
}

export default function ReliefStickerStudio() {
  const [imgEl, setImgEl] = useState(null);
  const [normalizing, setNormalizing] = useState(false);
  const [normalizeError, setNormalizeError] = useState(null);
  const [aspect, setAspect] = useState(1);
  const [puff, setPuff] = useState(0.5);       // slab(0) ↔ dome(1)
  const [detail, setDetail] = useState(0.4);
  const [blur, setBlur] = useState(34);        // dome blur
  const [edgeRound, setEdgeRound] = useState(16); // bevel radius (px) — kills the sawtooth
  const [grain, setGrain] = useState(0.5);        // fondant micro-grain
  const [flipY, setFlipY] = useState(false);
  const [delit, setDelit] = useState(0);
  const [flattenThin, setFlattenThin] = useState(0);   // erode thin protrusions (spikes) so they hug the wall (0 = off), colour-independent
  const [flatTop, setFlatTop] = useState(0);   // blend toward a flat plaque (0 = sculpted / current, 1 = flat top)
  const [solid, setSolid] = useState(false);   // render as a real extruded SOLID slab (front+walls+back) vs a displaced shell
  const [solidEdge, setSolidEdge] = useState(0);   // 0..1 of depth → rounded fondant rim on the slab (0 = sharp edge)
  const [solidFinish, setSolidFinish] = useState('fondant');   // side-wall surface finish (fondant/chocolate/…), relief.solidFinish
  // Side-wall COLOUR (relief.solidColor). null = AUTO: sample the print's dominant hue at render time. An
  // explicit hex overrides it — but only for a NON-recolourable element: when `recolor` is on the customer
  // repaints the print and the walls must follow that hue, so the designer ignores an authored colour there
  // (see CakeCanvas solidMats). Exported only when set, so existing configs stay byte-identical.
  const [solidColor, setSolidColor] = useState(null);
  // Authored FLAT MASK — the author brushes the exact parts that should lie flush on the wall (black), the
  // rest stays raised (white), independent of colour & shape. Source of truth = an offscreen grayscale
  // canvas at field resolution (`maskRef`), default all-white. `maskVersion` bumps on stroke-commit/clear to
  // re-derive the 3D maps + export; `maskPainted` gates whether we export/apply it at all.
  const maskRef = useRef(null);            // offscreen field-res grayscale canvas (white = raised)
  const paintCanvasRef = useRef(null);     // the on-screen paint view (faint image + red flush overlay)
  const paintingRef = useRef(false);       // pointer-drag in progress
  const [maskVersion, setMaskVersion] = useState(0);
  const [maskPainted, setMaskPainted] = useState(false);
  const [brushSize, setBrushSize] = useState(22);   // brush radius in on-screen paint-view px
  const [maskErase, setMaskErase] = useState(false);
  const [lift, setLift] = useState(0.07);
  const [normalScale, setNormalScale] = useState(0.8);
  // MATTE and SHEENLESS, matching the designer's decal materials (spattoo-core CakeCanvas — both the flat
  // and the relief path). Fondant is matte. Both roughness and sheen add WHITE on top of the albedo, and
  // additive white desaturates a print. Measured in the designer on a real decal (texture saturation 0.907):
  //   roughness 0.7 + sheen 0.12 → 0.345   |   sheen 0 → 0.397   |   roughness 0.95 → 0.479
  //   neither → 0.607, which is what a plain flat decal renders at.
  // It is NOT the HDRI (envMapIntensity 0 changes nothing) — it is direct specular from the key lights.
  //
  // These sliders are the source of the values baked into placement_config, so their DEFAULTS decide what
  // the whole element library looks like. The old 0.7 / 0.12 are why every element authored here carries
  // an explicit roughness:0.7 and sheen:0.12 that override the designer's defaults — those need re-authoring.
  //
  // CAUTION: this studio previews the decal ~2x larger than the designer draws it. A specular that reads as
  // a highlight here reads as a grey film there. Author conservatively, and check on the real cake.
  const [roughness, setRoughness] = useState(0.95);
  const [sheen, setSheen] = useState(0);
  const [envIntensity, setEnvIntensity] = useState(0.4);
  const [toneMapped, setToneMapped] = useState(false);
  // PRINT FINISH — top-level placement_config.print_finish { saturation, emissive }, NOT nested under relief:
  // it applies to BOTH the flat and the relief 2D-sticker material paths in the designer. `emissive` is the
  // decal's self-illumination (brightens + re-saturates without touching the cake); `saturation` is an albedo
  // chroma pre-boost so the print survives the lit-render wash. Absent → the renderer's defaults (1.12 / 0.22).
  const [printEmissive, setPrintEmissive] = useState(0.22);
  const [printSaturation, setPrintSaturation] = useState(1.12);
  const [zone, setZone] = useState('side');
  const [mode, setMode] = useState('hug');
  const [size, setSize] = useState(0.95);
  const [posA, setPosA] = useState(0);   // side: around the wall (−1..1 → ±180°) · top: X
  const [posB, setPosB] = useState(0);   // side: height · top: Z
  const [cakeColor, setCakeColor] = useState('#f7d9e3');
  const [recolor, setRecolor] = useState(false);          // recolour the image's coloured regions
  const [recolorGuard, setRecolorGuard] = useState(0.18); // min saturation to count as coloured (protects whites/blacks)
  // The element's recolour METHOD (opaque / saturated / blue_gt_green / hue_regions). This studio only
  // PREVIEWS hue_regions, but it must never rewrite the method of an element it opened: `opaque` recolours
  // every pixel, `hue_regions` exposes one swatch per detected hue — silently swapping them on Copy config
  // would change how the designer paints the element. Hydrated from the element; new elements author hue_regions.
  const [recolorMethod, setRecolorMethod] = useState('hue_regions');
  const [targets, setTargets] = useState([]);             // per-region target hex, parallel to `regions`

  // Bake against the image the DESIGNER will actually load, never the raw file.
  //
  // `prepareElementImage` is the ONE 2D-image pipeline (AddElement + ManageElements both call it): it trims
  // to the alpha bbox, rescales the subject to 80% of a 1024 square, and encodes WebP. Its output IS the
  // element's `image_url`. Authoring against the raw file meant every pixel-denominated bake param —
  // `domeBlur`, `edgeRound`, and the normal map's per-texel slope — was measured in a frame the renderer
  // never sees. Same function here, so what you tune is what ships.
  //
  // removeBgEnabled:false — the studio takes an already-transparent PNG, and remove.bg costs credits. The
  // upload path runs bg-removal FIRST and then this same normalize, so the framing is identical either way.
  //
  // (Lesson: the raw Dinosaur PNG has its subject at 41% of the frame — 429px tall at bake resolution. The
  // normalized master puts it at 80% — 819px, 1.93x bigger. `domeBlur: 34px` is therefore 8.03% of the
  // subject in the raw frame and 4.15% in the real one: the dome collapsed from a puffy bevel into a flat
  // slab with a hard shoulder. Measured: the height field's flat plateau grew from 42.7% to 65.5%.)
  // The ONE image-ingest path — a picked file and an element loaded from R2 both land here, so both are
  // baked against the same normalized frame. An element's stored `image_url` is NOT reliably normalized
  // (ManageElements uploads the raw file when background-removal is off), so it must be normalized too.
  const loadNormalized = useCallback(async (blob) => {
    setNormalizing(true);
    setNormalizeError(null);
    setImgEl(null);
    try {
      const normalized = await prepareElementImage(blob, { removeBgEnabled: false });
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('decode failed'));
        img.src = URL.createObjectURL(normalized);   // blob: → same-origin, so canvas pixel reads stay untainted
      });
      setImgEl(img);
      setAspect((img.naturalWidth || 1) / (img.naturalHeight || 1));
    } catch (e) {
      // Never silently fall back to the raw file — that is the bug this function exists to prevent.
      console.error('[relief-studio] normalize failed; NOT falling back to the raw image', e);
      setNormalizeError(String(e?.message ?? e));
    } finally {
      setNormalizing(false);
    }
  }, []);

  function pickFile(f) { if (f) loadNormalized(f); }

  // ── Open against an existing element: /elements/relief-sticker?element=<id> ──────────────────────
  // Manage Elements links here so an already-authored sticker can be re-tuned instead of re-authored.
  // We hydrate EVERY control the element's placement_config carries, so what you land on is what the
  // designer renders today — an unset key keeps this studio's default, which IS the designer's default.
  // A key we don't hydrate would silently reset on the next Copy config, so add new keys here too.
  const elementId = useMemo(() => new URLSearchParams(window.location.search).get('element'), []);
  const [element, setElement] = useState(null);
  const [elementError, setElementError] = useState(null);
  // Start "loading" whenever the URL names an element, so the fetch is NEVER silent: without this the
  // studio renders untouched defaults while the request is in flight, which is indistinguishable from
  // "the link did nothing" (and from a route that doesn't exist yet).
  const [elementLoading, setElementLoading] = useState(() => !!new URLSearchParams(window.location.search).get('element'));
  // flatMask is a data-URI painted onto the mask canvas — but the canvas is (re)created all-white by an
  // effect keyed on `imgEl`, which lands AFTER this fetch. Park it here and apply once the image is in.
  const pendingMaskRef = useRef(null);

  function hydrateFromConfig(pc) {
    const set = (v, fn) => { if (v !== undefined && v !== null) fn(v); };
    const r = pc?.relief ?? {};
    const b = r.bake ?? {};
    set(r.lift, setLift);
    set(r.normalScale, setNormalScale);
    set(r.envIntensity, setEnvIntensity);
    set(r.toneMapped, setToneMapped);
    // roughness/sheen are no longer exported, but legacy rows carry them — show what's actually stored.
    set(r.roughness, setRoughness);
    set(r.sheen, setSheen);
    set(r.solid, setSolid);
    set(r.solidEdge, setSolidEdge);
    set(r.solidFinish, setSolidFinish);
    set(r.solidColor, setSolidColor);
    set(b.puff, setPuff);
    set(b.domeBlur, setBlur);
    set(b.edgeRound, setEdgeRound);
    set(b.detail, setDetail);
    set(b.grain, setGrain);
    set(b.delit, setDelit);
    set(b.flipY, setFlipY);
    set(b.flattenThin, setFlattenThin);
    set(b.flatTop, setFlatTop);
    set(pc?.print_finish?.saturation, setPrintSaturation);
    set(pc?.print_finish?.emissive, setPrintEmissive);
    // `recolor`'s PRESENCE is the toggle; its METHOD is authored on the element (AddElement /
    // ManageElements), so carry it through untouched rather than re-stamping this studio's default.
    if (pc?.recolor) { setRecolor(true); set(pc.recolor.method, setRecolorMethod); set(pc.recolor.sat, setRecolorGuard); }
    pendingMaskRef.current = r.flatMask ?? null;
  }

  useEffect(() => {
    if (!elementId) return;
    let alive = true;
    (async () => {
      try {
        const el = await fetchGlobalElement(elementId);
        if (!alive) return;
        setElement(el);
        hydrateFromConfig(el.placement_config ?? {});
        if (!el.image_url) throw new Error('element has no image');
        const res = await fetch(corsUrl(el.image_url), { mode: 'cors' });
        if (!res.ok) throw new Error(`image fetch failed (${res.status})`);
        const blob = await res.blob();
        if (!alive) return;
        await loadNormalized(blob);
      } catch (e) {
        console.error('[relief-studio] could not open element', elementId, e);
        if (alive) setElementError(String(e?.message ?? e));
      } finally {
        if (alive) setElementLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [elementId, loadNormalized]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Paint a hydrated flatMask onto the fresh mask canvas, once the image (and therefore the canvas) exists.
  // Runs after the all-white reset effect above; clears the pending ref so a later stroke can't re-apply it.
  useEffect(() => {
    const uri = pendingMaskRef.current;
    if (!uri || !imgEl || !maskRef.current) return;
    const m = maskRef.current;
    const img = new Image();
    img.onload = () => {
      if (maskRef.current !== m) return;   // a newer image landed — its own reset owns the canvas
      const ctx = m.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, m.width, m.height);
      ctx.drawImage(img, 0, 0, m.width, m.height);
      pendingMaskRef.current = null;
      setMaskPainted(true);
      setMaskVersion(v => v + 1);
    };
    img.src = uri;   // data: URI — same-origin by construction, no CORS
  }, [imgEl, maskVersion]);


  // The subject's pixel extent in the baked image. `domeBlur`/`edgeRound` are ABSOLUTE pixel radii, so this
  // is the frame they are measured against — show it, or the numbers are meaningless.
  const subjectPx = useMemo(() => {
    if (!imgEl) return null;
    const c = imgToCanvas(imgEl);
    const { width: w, height: h } = c;
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 127) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    return x1 < 0 ? null : { w: x1 - x0 + 1, h: y1 - y0 + 1, img: `${w}x${h}` };
  }, [imgEl]);

  // Distinct colour regions of the image (by hue), so each can be recoloured independently.
  const regions = useMemo(() => (recolor && imgEl ? extractRegions(imgToCanvas(imgEl), { minSat: recolorGuard }) : []), [recolor, imgEl, recolorGuard]);
  useEffect(() => { setTargets(regions.map(r => r.hex)); }, [regions]);

  // Albedo (colour) — de-light then recolour, both on a canvas. The relief maps below are built from the
  // ORIGINAL luminance, and recolour is luminance-preserving, so the 3D shape is unaffected either way.
  const albedoTex = useMemo(() => {
    if (!imgEl) return null;
    // Always build on a canvas so the print_finish "Saturation" boost (matching core) can be previewed.
    const canvas = delit > 0 ? buildDelitAlbedo(imgEl, delit) : imgToCanvas(imgEl);
    if (recolor && regions.length && targets.length === regions.length) {
      recolorRegions(canvas, regions.map(r => r.hue), targets, { minSat: recolorGuard });
    }
    saturateCanvas(canvas, printSaturation);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.needsUpdate = true; return t;
  }, [imgEl, delit, recolor, regions, targets, recolorGuard, printSaturation]);

  // (Re)create a fresh all-white (fully-raised) mask canvas at field resolution whenever a new image loads.
  useEffect(() => {
    if (!imgEl) { maskRef.current = null; return; }
    const { w, h } = fieldSize(imgEl);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    maskRef.current = c;
    setMaskPainted(false);
    setMaskVersion(v => v + 1);
  }, [imgEl]);

  // Repaint the on-screen view: the source image faintly, then a red tint over the FLUSH (black) regions.
  // Called imperatively during a drag (cheap) — the expensive 3D rebuild only fires on stroke-commit.
  function redrawPaintView() {
    const cv = paintCanvasRef.current, mask = maskRef.current;
    if (!cv || !mask || !imgEl) return;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.globalAlpha = 0.4; ctx.drawImage(imgEl, 0, 0, cv.width, cv.height); ctx.globalAlpha = 1;
    const mc = document.createElement('canvas'); mc.width = cv.width; mc.height = cv.height;
    const mctx = mc.getContext('2d', { willReadFrequently: true });
    mctx.drawImage(mask, 0, 0, cv.width, cv.height);
    const id = mctx.getImageData(0, 0, cv.width, cv.height), d = id.data;
    for (let i = 0; i < d.length; i += 4) { const flush = 255 - d[i]; d[i] = 224; d[i + 1] = 64; d[i + 2] = 96; d[i + 3] = Math.round(flush * 0.55); }
    mctx.putImageData(id, 0, 0);
    ctx.drawImage(mc, 0, 0);
  }
  // Keep the view in sync with the canvas size / a committed stroke / a new image.
  useEffect(() => { redrawPaintView(); }, [imgEl, maskVersion, aspect]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Paint (or erase) a brush dab onto the field-res mask at the pointer, then refresh the view live.
  function paintAt(clientX, clientY) {
    const cv = paintCanvasRef.current, mask = maskRef.current;
    if (!cv || !mask) return;
    const rect = cv.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width * mask.width;
    const y = (clientY - rect.top) / rect.height * mask.height;
    const r = Math.max(1, brushSize * (mask.width / rect.width));
    const ctx = mask.getContext('2d');
    ctx.fillStyle = maskErase ? '#fff' : '#000';   // black = flush, white = raised
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    redrawPaintView();
  }
  function onMaskDown(e) { e.currentTarget.setPointerCapture?.(e.pointerId); paintingRef.current = true; setMaskPainted(true); paintAt(e.clientX, e.clientY); }
  function onMaskMove(e) { if (paintingRef.current) paintAt(e.clientX, e.clientY); }
  function onMaskUp() { if (paintingRef.current) { paintingRef.current = false; setMaskVersion(v => v + 1); } }
  function clearMask() {
    const mask = maskRef.current; if (!mask) return;
    const ctx = mask.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, mask.width, mask.height);
    setMaskPainted(false); setMaskVersion(v => v + 1);
  }

  const maps = useMemo(() => {
    if (!imgEl) return null;
    const flds0 = imageToFields(imgEl);
    // Layer the authored flat-mask on top of flattenThin (null when unpainted → identical to before).
    const flatMask = sampleFlatMask(maskRef.current, flds0.w, flds0.h, maskPainted);
    const flds = buildFields(flds0, { puff, detail, blur, edgeRound, flipY, grain, flattenThin, flatMask, flatTop });
    const normal = new THREE.CanvasTexture(normalCanvas(flds));
    normal.colorSpace = THREE.NoColorSpace; normal.anisotropy = 8; normal.needsUpdate = true;
    const disp = new THREE.CanvasTexture(dispCanvas(flds));
    disp.colorSpace = THREE.NoColorSpace; disp.needsUpdate = true;
    return { normal, disp };
  }, [imgEl, puff, detail, blur, edgeRound, flipY, grain, flattenThin, flatTop, maskVersion, maskPainted]);

  const [copied, setCopied] = useState(false);
  // The relief recipe to drop into the element's placement_config (see core bake plan): runtime
  // material knobs + a `bake` block (the params the ingest step rebuilds the normal/displacement maps
  // from). Placement (zone/size/position) is set per-element in the designer, so it's not included.
  const reliefConfig = useMemo(() => ({
    // Recolour enabled → mark the element multi-colour recolourable in the designer (also set
    // allowed_actions.color:true on the element). The per-region colours are chosen per instance.
    // Preserve the element's authored method (see recolorMethod). `sat` only means anything to the
    // methods that threshold on saturation — `opaque` takes no param, so don't invent one for it.
    ...(recolor
      ? { recolor: { method: recolorMethod, ...(recolorMethod === 'opaque' ? {} : { sat: +recolorGuard.toFixed(2) }) } }
      : {}),
    relief: {
      lift: +lift.toFixed(3),
      normalScale: +normalScale.toFixed(2),
      // `roughness` and `sheen` are DELIBERATELY NOT EXPORTED. They are not a per-element artistic choice —
      // they are the shared "what does fondant look like" contract, and the flat decal and the relief decal
      // must agree on it. The designer owns the values (matte 0.95 / sheen 0, spattoo-core CakeCanvas); an
      // absent key inherits that default, so a future retune reaches every element instead of being frozen
      // in a thousand rows of JSON.
      //
      // They USED to be exported, which is how every element ended up carrying roughness:0.7 + sheen:0.12 —
      // this studio's old slider defaults, authored while previewing the decal ~2x larger than the designer
      // draws it. Both add WHITE over the albedo, and additive white desaturates a print: measured on a real
      // decal (texture saturation 0.907), 0.7 + 0.12 rendered at 0.345 — 62% of the colour gone. With neither,
      // 0.607, which is exactly what a plain flat decal renders at. The sliders below still drive THIS
      // preview so you can see what they do; they no longer leak into the element.
      envIntensity: +envIntensity.toFixed(2),
      toneMapped,
      // Solid slab (extruded silhouette) vs the displaced shell. Only written when on, so an unchecked
      // element stays exactly as before (absent = false = displaced shell).
      // `solidColor` only when the author picked one (Auto = absent = the designer samples the print's
      // dominant hue). A recolourable element ignores it at render — the walls follow the customer's recolour.
      ...(solid ? { solid: true, ...(solidEdge > 0 ? { solidEdge: +solidEdge.toFixed(2) } : {}), ...(solidFinish !== 'fondant' ? { solidFinish } : {}), ...(solidColor ? { solidColor } : {}) } : {}),
      bake: {
        puff: +puff.toFixed(2),
        domeBlur: blur,
        edgeRound,
        detail: +detail.toFixed(2),
        grain: +grain.toFixed(2),
        delit: +delit.toFixed(2),
        flipY,
        flattenThin: +flattenThin.toFixed(2),   // 0 = off; erodes thin protrusions so they stay flush on the wall
        flatTop: +flatTop.toFixed(2),   // 0 = sculpted; 1 = flat plaque (uniform raised height)
      },
      // Authored flat-mask — RELIEF-level sibling of `bake` (NOT inside it). Only written if the author
      // actually painted: a downscaled ~128px grayscale PNG data-URI, black = flush. Absent = fully raised.
      ...(maskPainted && maskRef.current ? { flatMask: maskToDataURL(maskRef.current) } : {}),
    },
    // Per-element print finish — TOP-LEVEL (applies to flat AND relief 2D stickers), not under `relief`.
    print_finish: {
      saturation: +printSaturation.toFixed(2),
      emissive: +printEmissive.toFixed(2),
    },
    // roughness/sheen intentionally absent from the deps — they no longer affect the exported config.
  }), [recolor, recolorMethod, recolorGuard, lift, normalScale, envIntensity, toneMapped, solid, solidEdge, solidFinish, solidColor, puff, blur, edgeRound, detail, grain, delit, flipY, flattenThin, flatTop, maskVersion, maskPainted, printSaturation, printEmissive]);
  const configText = useMemo(() => JSON.stringify(reliefConfig, null, 2), [reliefConfig]);
  function copyConfig() { navigator.clipboard?.writeText(configText); setCopied(true); setTimeout(() => setCopied(false), 1500); }

  const place = useMemo(() => placement(zone, mode, size * aspect, size), [zone, mode, size, aspect]);
  // SOLID slab (placement_config.relief.solid) — the extruded silhouette the designer builds, previewed
  // at this tier so authoring is WYSIWYG. Only side+hug bends round the wall (mirrors `placement`); every
  // other placement is a flat slab the mesh's rotation orients. thickness = lift × TIER_R (scale 1 here),
  // the SAME world lift the displaced preview raises to — so toggling Solid never changes the height.
  // Bend radius for the SOLID (side-hug only). The solid geometry is built at z≈0 (core's createCurvedPlane
  // convention: axis behind it) — but the studio's `curvedPlaneGeometry` bakes the wall at z≈radius, so the
  // solid mesh must be translated OUT by this radius (below) to sit on the wall instead of the cake's axis.
  const solidCurveR = useMemo(() => (zone === 'side' && mode === 'hug') ? TIER_R + 0.004 : null, [zone, mode]);
  const solidGeo = useMemo(() => {
    if (!solid || !imgEl) return null;
    try { return buildSolidReliefGeometry(imgEl, { size, thickness: lift * TIER_R, curveRadius: solidCurveR, scale: 1, edgeRadius: solidEdge }); }
    catch (_) { return null; }
  }, [solid, imgEl, size, lift, solidCurveR, solidEdge]);
  useEffect(() => () => solidGeo?.dispose?.(), [solidGeo]);
  const nScale = useMemo(() => new THREE.Vector2(normalScale, normalScale), [normalScale]);
  // The print's dominant hue — what the designer auto-samples when no colour is authored. Also seeds the
  // wall-colour picker below, so opening it starts from what you already see. null → greyscale/tainted image.
  const autoWallHex = useMemo(() => (albedoTex?.image ? dominantColorOfImage(albedoTex.image, { mul: 1.0 }) : null), [albedoTex]);
  // Solid-slab materials as an EXPLICIT array — NOT two `attach="material-N"` children: on a plain <mesh>
  // whose default `material` is a single Material, `attach="material-0"` writes index 0/1 onto that object
  // instead of building an array, so the mesh keeps its default white material and the albedo never lands
  // on the front cap. `material={[front, wall]}` sets the array directly (mirrors core CakeCanvas).
  const solidMats = useMemo(() => {
    if (!solid || !albedoTex || !maps) return null;
    const front = new THREE.MeshPhysicalMaterial({
      map: albedoTex, normalMap: maps.normal, normalScale: nScale,
      roughness, metalness: 0,
      sheen, sheenColor: new THREE.Color('#ffffff'), sheenRoughness: 0.85,
      envMapIntensity: envIntensity, toneMapped, side: THREE.DoubleSide,
      emissive: new THREE.Color('#ffffff'), emissiveMap: albedoTex, emissiveIntensity: printEmissive,
    });
    // Side/back walls, resolved EXACTLY as the designer does (CakeCanvas solidMats): a recolourable element
    // always auto-samples the final albedo so the walls track the customer's hue; otherwise the authored
    // `solidColor` wins, else the auto-sample, else a neutral fondant tone. Same shared helper, no drift.
    const wallHex = (recolor ? null : solidColor) || autoWallHex || '#efe6da';
    // Dominant colour + the author-chosen FINISH via the shared factory (identical to the designer). Its
    // cloned grain normal (if any) is disposed in the cleanup below.
    const wall = buildSolidWallMaterial(solidFinish, wallHex, printEmissive);
    return [front, wall];
  }, [solid, albedoTex, maps, nScale, roughness, sheen, envIntensity, toneMapped, printEmissive, solidFinish, solidColor, recolor, autoWallHex]);
  // Dispose the wall's CLONED fondant normal (index 1) — not the front's shared maps.normal.
  useEffect(() => () => { if (solidMats) { solidMats[1]?.normalMap?.dispose?.(); solidMats.forEach(m => m.dispose()); } }, [solidMats]);
  // Positioning group: side → orbit around the wall (Y rot) + slide vertically; top → slide across X/Z.
  const grp = useMemo(() => zone === 'side'
    ? { rotation: [0, posA * Math.PI, 0], position: [0, posB * (TIER_H / 2 - size * 0.5), 0] }
    : { rotation: [0, 0, 0], position: [posA * (TIER_R * 0.7), 0, posB * (TIER_R * 0.7)] },
    [zone, posA, posB, size]);

  useEffect(() => () => albedoTex?.dispose?.(), [albedoTex]);
  useEffect(() => () => { maps?.normal?.dispose?.(); maps?.disp?.dispose?.(); }, [maps]);
  useEffect(() => () => place?.geo?.dispose?.(), [place]);

  const S = {
    page: { minHeight: '100vh', background: '#EDEAE2', fontFamily: 'Quicksand, sans-serif', padding: '24px' },
    title: { fontSize: 22, fontWeight: 800, color: '#2C4433' },
    sub: { fontSize: 13, color: '#6B8C74', fontWeight: 600, marginBottom: 18 },
    layout: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 20, maxWidth: 1400, margin: '0 auto', alignItems: 'start' },
    card: { background: '#fff', borderRadius: 18, border: '1.5px solid #C5D4C8', padding: 18 },
    pick: { display: 'block', padding: '12px 16px', borderRadius: 12, border: '2px dashed #C5D4C8', background: '#F4F8F5', color: '#3D5A44', fontWeight: 700, cursor: 'pointer', textAlign: 'center', marginBottom: 14 },
    section: { fontSize: 11, fontWeight: 700, color: '#6B8C74', letterSpacing: 1, textTransform: 'uppercase', margin: '14px 0 8px' },
    row: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
    lbl: { fontSize: 12, fontWeight: 700, color: '#6B8C74', width: 96 },
    val: { fontSize: 11, fontWeight: 700, color: '#3D5A44', width: 40, textAlign: 'right' },
    swatch: { width: 40, height: 26, border: '1.5px solid #C5D4C8', borderRadius: 6, cursor: 'pointer', padding: 2, background: '#fff' },
    hint: { fontSize: 10.5, color: '#9BB5A2', fontWeight: 600, margin: '-2px 0 8px' },
    err: { fontSize: 11, lineHeight: 1.4, color: '#a11', background: '#fff0f0', border: '1px solid #f3b1b1', borderRadius: 6, padding: '6px 8px', margin: '4px 0' },
    banner: { fontSize: 11, lineHeight: 1.5, color: '#33502f', background: '#f2f8f3', border: '1px solid #cfe3d3', borderRadius: 6, padding: '6px 8px', margin: '4px 0' },
    seg: (a) => ({ flex: 1, padding: '6px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, background: a ? '#3D5A44' : '#E8EDE9', color: a ? '#fff' : '#6B8C74' }),
  };

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Quicksand:wght@400;600;700;800&display=swap" rel="stylesheet" />
      <div style={S.page}>
        <div style={{ maxWidth: 1400, margin: '0 auto' }}>
          <div style={S.title}>Relief Sticker Studio</div>
          <div style={S.sub}>Raised fondant cut-out from a 2D image — rounded beveled edge (no sawtooth) + real lift & shadow. Real cake & lights (= core).</div>
        </div>
        <div style={S.layout}>
          <div style={{ ...S.card, padding: 0, overflow: 'hidden' }}>
            <div style={{ height: 640, background: '#EFE7DC' }}>
              <Canvas shadows camera={{ position: [0, 1.0, 4.4], fov: 38 }} gl={{ preserveDrawingBuffer: true, antialias: true }}>
                <ambientLight intensity={0.45} />
                <directionalLight position={[6, 14, 8]} intensity={1.1} castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004}>
                  <orthographicCamera attach="shadow-camera" args={[-3, 3, 3, -3, 0.1, 40]} />
                </directionalLight>
                <directionalLight position={[-4, 4, -4]} intensity={0.4} />
                <Environment preset="apartment" />
                <Cake color={cakeColor} />
                {albedoTex && maps && (
                  <group rotation={grp.rotation} position={grp.position}>
                  {solid && solidGeo && solidMats ? (
                    /* SOLID slab preview — the SAME extruded geometry + two-material array the designer
                       renders: [0] printed albedo on the caps (no displacement — the geometry IS the lift),
                       [1] a matte fondant tone on the side walls. Reads solid from a grazing angle. */
                    <mesh geometry={solidGeo} material={solidMats} position={solidCurveR != null ? [place.pos[0], place.pos[1], place.pos[2] + solidCurveR] : place.pos} rotation={place.rot} castShadow receiveShadow />
                  ) : (
                  <mesh geometry={place.geo} position={place.pos} rotation={place.rot} castShadow receiveShadow>
                    {/* lift is a FRACTION of the wall radius (× TIER_R here), not an absolute world length —
                        so the same authored value renders identically in the designer on ANY cake size and
                        at ANY sticker scale (the designer applies lift × its live wall radius). Scaling off
                        the wall radius — not the sticker size — is what keeps a large sticker from poking
                        off the wall. Never store an absolute lift tuned to this fixed TIER_R. */}
                    <meshPhysicalMaterial
                      map={albedoTex} normalMap={maps.normal} normalScale={nScale}
                      displacementMap={maps.disp} displacementScale={lift * TIER_R}
                      alphaTest={0.5} alphaToCoverage roughness={roughness} metalness={0}
                      sheen={sheen} sheenColor={'#ffffff'} sheenRoughness={0.85}
                      envMapIntensity={envIntensity} toneMapped={toneMapped} side={THREE.DoubleSide}
                      // Preview the print_finish "Brightness" slider so authoring is WYSIWYG — same emissive
                      // lift core applies (emissiveMap = the albedo). Saturation is previewed in albedoTex.
                      emissive={'#ffffff'} emissiveMap={albedoTex} emissiveIntensity={printEmissive}
                    />
                  </mesh>
                  )}
                  </group>
                )}
                <OrbitControls enablePan={false} target={[0, 0.8, 0]} />
              </Canvas>
            </div>
          </div>

          <div style={S.card}>
            {/* Opened from Manage Elements with ?element=<id>: name the element being tuned, so a Copy
                config that lands on the wrong row is obvious before it's pasted. */}
            {element && (
              <div style={S.banner}>
                Editing <b>{element.name}</b> — controls are pre-filled from its saved <code>placement_config</code>.
                {' '}<a href={`/elements/manage?element=${element.id}`} style={{ color: '#3D5A44', fontWeight: 700 }}>Back to Manage Elements</a>
              </div>
            )}
            {elementLoading && (
              <div style={S.banner}>Loading element {elementId}…</div>
            )}
            {elementError && (
              <div style={S.err}>Couldn’t load that element — <b>nothing loaded</b>. <span style={{ opacity: 0.7 }}>{elementError}</span></div>
            )}

            <label style={S.pick}>{element ? '↺ Replace image (transparent PNG)' : '＋ Load 2D image (transparent PNG)'}
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => pickFile(e.target.files[0])} />
            </label>

            {normalizing && (
              <div style={{ fontSize: 11, color: '#3D5A44', padding: '6px 0' }}>Normalizing (trim → 80% of 1024 → WebP)…</div>
            )}
            {normalizeError && (
              <div style={S.err}>
                Normalize failed — <b>nothing loaded</b>. Fix the image rather than tuning against the raw file:
                the designer only ever renders the normalized master. <span style={{ opacity: 0.7 }}>{normalizeError}</span>
              </div>
            )}
            {subjectPx && (
              <div style={{ ...S.banner, fontFamily: 'ui-monospace, monospace' }}>
                Baking the <b>normalized master</b> ({subjectPx.img}) — the exact image the designer loads.<br />
                subject <b>{subjectPx.w}×{subjectPx.h}px</b> · Edge round / Dome blur are pixel radii measured against this.
              </div>
            )}

            <div style={S.section}>Placement</div>
            <div style={{ ...S.row, gap: 6 }}>
              <button style={S.seg(zone === 'side')} onClick={() => setZone('side')}>Side</button>
              <button style={S.seg(zone === 'top')} onClick={() => setZone('top')}>Top</button>
            </div>
            <div style={{ ...S.row, gap: 6 }}>
              <button style={S.seg(mode === 'hug')} onClick={() => setMode('hug')}>Hug</button>
              <button style={S.seg(mode === 'stand')} onClick={() => setMode('stand')}>Stand</button>
            </div>
            <Slider label="Size" value={size} set={setSize} min={0.3} max={2} />
            <Slider label={zone === 'side' ? 'Around' : 'X'} value={posA} set={setPosA} min={-1} max={1} />
            <Slider label={zone === 'side' ? 'Height' : 'Z'} value={posB} set={setPosB} min={-1} max={1} />
            <div style={S.row}>
              <span style={S.lbl}>Cake colour</span>
              <input type="color" value={cakeColor} onChange={e => setCakeColor(e.target.value)} style={S.swatch} />
              <span style={{ ...S.val, width: 'auto', color: '#9BB5A2', fontFamily: 'monospace' }}>{cakeColor}</span>
            </div>

            <div style={S.section}>Elevation (real 3D)</div>
            {/* Solid slab (placement_config.relief.solid): render as a REAL extruded solid (flat printed
                front + side walls + flat back, bent round the wall) instead of a single displaced shell, so
                it reads solid from a grazing angle. Thickness = Relief height. v1: outer silhouette only
                (interior holes not cut). Surface-detail sliders (dome/blur/flatten/flat-top) don't shape a
                solid slab; they still drive the normal-map shading on its front face. */}
            <div style={S.row}><span style={S.lbl}>Solid slab</span>
              <input type="checkbox" checked={solid} onChange={e => setSolid(e.target.checked)} style={{ accentColor: '#3D5A44', width: 16, height: 16 }} /></div>
            {/* Edge radius (relief.solidEdge): 0..1 of the slab depth → a bevel that rounds the sharp
                front/back rim into a soft fondant edge. Only affects the solid slab. */}
            {solid && <Slider label="Edge radius" value={solidEdge} set={setSolidEdge} min={0} max={1} step={0.01} fmt={v => (v === 0 ? 'sharp' : v.toFixed(2))} />}
            {/* Wall finish (relief.solidFinish): the element's material feel on the side walls. Colour stays
                the print's dominant hue; the finish only sets gloss/grain. Presets from the shared registry. */}
            {solid && (
              <div style={S.row}><span style={S.lbl}>Wall finish</span>
                <select value={solidFinish} onChange={e => setSolidFinish(e.target.value)}
                  style={{ background: '#fff', border: '1px solid #d8d8d8', borderRadius: 6, padding: '4px 6px', fontSize: 12, color: '#222' }}>
                  {SOLID_FINISH_ORDER.map(k => <option key={k} value={k}>{SOLID_FINISHES[k].label}</option>)}
                </select>
              </div>
            )}
            {/* Wall colour (relief.solidColor): defaults to AUTO = the print's dominant hue, which is what the
                designer samples when the key is absent. Pick a colour to pin the walls to it instead.
                Disabled for a recolourable element: there the customer repaints the print and the walls follow
                that hue, so an authored colour would be ignored at render — don't offer a control that lies. */}
            {solid && (
              <>
                <div style={S.row}><span style={S.lbl}>Wall colour</span>
                  <input type="color" value={solidColor || autoWallHex || '#efe6da'} disabled={recolor}
                    onChange={e => setSolidColor(e.target.value)}
                    style={{ ...S.swatch, ...(recolor ? { cursor: 'not-allowed', opacity: 0.5 } : null) }} />
                  <span style={{ ...S.val, width: 'auto', color: '#9BB5A2', fontFamily: 'monospace' }}>
                    {recolor ? 'auto' : (solidColor || `${autoWallHex ?? '#efe6da'} auto`)}
                  </span>
                  {!recolor && solidColor && (
                    <button onClick={() => setSolidColor(null)} style={{ ...S.seg(false), flex: 'none', padding: '5px 10px' }}>Auto</button>
                  )}
                </div>
                {recolor && <div style={S.hint}>Recolourable element — the walls follow the customer’s print colour.</div>}
              </>
            )}
            <Slider label="Relief height" value={lift} set={setLift} min={0} max={0.25} fmt={v => v.toFixed(3)} />
            <Slider label="Edge round" value={edgeRound} set={setEdgeRound} min={2} max={48} step={1} fmt={v => `${v}px`} />
            <Slider label="Dome ↔ slab" value={puff} set={setPuff} min={0} max={1} />
            {/* Flat top (bake.flatTop): 0 = sculpted per-pixel form; 1 = the whole silhouette lifts to ONE
                uniform flat height (a plaque), thin parts included — just a small rounded outer edge. */}
            <Slider label="Flat top" value={flatTop} set={setFlatTop} min={0} max={1} step={0.01} fmt={v => (v === 0 ? 'off' : v.toFixed(2))} />
            <Slider label="Dome blur" value={blur} set={setBlur} min={2} max={80} step={1} fmt={v => `${v}px`} />
            {/* Flatten artwork darker than this luma (0 = off) so dark ridges/spikes hug the wall instead of
                poking at a grazing angle — bakes into bake.flattenThin, read by core reliefMaps.js. Colour-
                INDEPENDENT: it erodes by SHAPE (feature width), never brightness. */}
            <Slider label="Flatten thin" value={flattenThin} set={setFlattenThin} min={0} max={1} step={0.01} fmt={v => (v === 0 ? 'off' : v.toFixed(2))} />

            {/* AUTHORED FLAT MASK — brush the exact parts that should lie flat on the cake (independent of
                colour & shape). Exported as placement_config.relief.flatMask (a ~128px black=flush data-URI),
                layered on top of bake.flattenThin. Only written if something is painted. */}
            {imgEl && (<>
              <div style={S.section}>Flat mask</div>
              <div style={{ fontSize: 10.5, color: '#9BB5A2', fontWeight: 600, marginBottom: 8 }}>
                Paint the parts that should lie flat on the cake (e.g. a dino&rsquo;s back spikes). Red = flush; unpainted stays raised.
              </div>
              <canvas
                ref={paintCanvasRef}
                width={288} height={Math.max(1, Math.round(288 / (aspect || 1)))}
                onPointerDown={onMaskDown} onPointerMove={onMaskMove} onPointerUp={onMaskUp} onPointerLeave={onMaskUp}
                style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 10, border: '1.5px solid #C5D4C8', background: '#F4F8F5', cursor: 'crosshair', touchAction: 'none', marginBottom: 8 }}
              />
              <div style={{ ...S.row, gap: 6 }}>
                <button style={S.seg(!maskErase)} onClick={() => setMaskErase(false)}>Paint</button>
                <button style={S.seg(maskErase)} onClick={() => setMaskErase(true)}>Erase</button>
                <button onClick={clearMask}
                  style={{ padding: '6px 12px', borderRadius: 8, border: '1.5px solid #C5D4C8', cursor: 'pointer', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, background: '#fff', color: '#6B8C74' }}>
                  Clear
                </button>
              </div>
              <Slider label="Brush size" value={brushSize} set={setBrushSize} min={4} max={80} step={1} fmt={v => `${v}px`} />
            </>)}

            <div style={S.section}>Surface</div>
            <Slider label="Fondant grain" value={grain} set={setGrain} min={0} max={1} />
            <Slider label="Surface detail" value={detail} set={setDetail} min={0} max={2} />
            <Slider label="Detail strength" value={normalScale} set={setNormalScale} min={0} max={3} />
            <div style={S.row}><span style={S.lbl}>Flip green</span>
              <input type="checkbox" checked={flipY} onChange={e => setFlipY(e.target.checked)} style={{ accentColor: '#3D5A44', width: 16, height: 16 }} /></div>

            <div style={S.section}>Recolour</div>
            <div style={S.row}><span style={S.lbl}>Recolour</span>
              <input type="checkbox" checked={recolor} onChange={e => setRecolor(e.target.checked)} style={{ accentColor: '#3D5A44', width: 16, height: 16 }} /></div>
            {/* This studio previews the ORIGINAL artwork and only simulates `hue_regions`. On an element
                authored with another method the designer's output differs — most starkly with `opaque`,
                which repaints EVERY pixel in the customer's colour. Say so, rather than let the green
                preview imply the cake shows green. (Method is preserved on Copy config, never rewritten.) */}
            {recolor && recolorMethod !== 'hue_regions' && (
              <div style={S.hint}>
                Method <code>{recolorMethod}</code> — preserved on Copy config, but <b>not previewed here</b>.
                {recolorMethod === 'opaque' && ' The designer repaints every pixel in the customer’s colour, so the cake will NOT show the artwork’s own colours.'}
              </div>
            )}
            {recolor && (<>
              <Slider label="Colour guard" value={recolorGuard} set={setRecolorGuard} min={0} max={0.5} step={0.01} />
              {regions.length === 0 && <div style={{ fontSize: 11, color: '#9BB5A2', fontWeight: 600, marginBottom: 6 }}>No colour regions found — load a coloured cut-out.</div>}
              {regions.map((r, i) => (
                <div key={i} style={S.row}>
                  <span style={{ width: 22, height: 22, borderRadius: 6, border: '1.5px solid #C5D4C8', background: r.hex, flexShrink: 0 }} title={`detected ${r.hex}`} />
                  <span style={{ color: '#9BB5A2', fontWeight: 700 }}>→</span>
                  <input type="color" value={targets[i] ?? r.hex} onChange={e => setTargets(t => t.map((c, j) => (j === i ? e.target.value : c)))} style={S.swatch} />
                  <span style={{ ...S.val, width: 'auto', color: '#9BB5A2', fontFamily: 'monospace' }}>{Math.round(r.share * 100)}%</span>
                </div>
              ))}
              <div style={{ fontSize: 10.5, color: '#9BB5A2', fontWeight: 600, marginBottom: 6 }}>Each detected colour recolours on its own; whites, blacks &amp; highlights stay, relief unchanged. (Clustered by hue — brown groups with orange.)</div>
            </>)}

            <div style={S.section}>Albedo / material</div>
            <Slider label="De-light" value={delit} set={setDelit} min={0} max={1} />
            <Slider label="Roughness" value={roughness} set={setRoughness} min={0} max={1} />
            <Slider label="Sheen (satin)" value={sheen} set={setSheen} min={0} max={1} />
            {/* The two sliders above drive this preview ONLY. They are not written into the element config —
                the designer owns the fondant material (matte 0.95 / sheen 0) so the flat and relief decals
                agree. Say so out loud: a control that silently fails to persist is exactly the class of bug
                that put 0.7/0.12 into every element in the first place. */}
            {(roughness !== 0.95 || sheen !== 0) && (
              <div style={{ ...S.row, display: 'block', fontSize: 11, lineHeight: 1.4, color: '#9a6a00', background: '#fff8e1',
                            border: '1px solid #ffe08a', borderRadius: 6, padding: '6px 8px', margin: '4px 0' }}>
                Preview only — <b>Roughness</b> and <b>Sheen</b> are not exported. The designer renders every
                fondant decal at <b>roughness 0.95 / sheen 0</b>. Reset to those to see the real cake.
              </div>
            )}
            <Slider label="Env intensity" value={envIntensity} set={setEnvIntensity} min={0} max={2} />
            <div style={S.row}><span style={S.lbl}>Tone-mapped</span>
              <input type="checkbox" checked={toneMapped} onChange={e => setToneMapped(e.target.checked)} style={{ accentColor: '#3D5A44', width: 16, height: 16 }} /></div>

            {/* PRINT FINISH — exported as top-level placement_config.print_finish (flat AND relief 2D stickers). */}
            <div style={S.section}>Print finish</div>
            <Slider label="Brightness" value={printEmissive} set={setPrintEmissive} min={0} max={0.5} step={0.01} />
            <Slider label="Saturation" value={printSaturation} set={setPrintSaturation} min={1} max={1.5} step={0.01} />
            <div style={{ fontSize: 10.5, color: '#9BB5A2', fontWeight: 600, marginBottom: 6 }}>Decal self-illumination + albedo chroma pre-boost so the print survives the cake&rsquo;s lit-render wash. Absent → designer defaults (1.12 / 0.22).</div>

            <div style={{ ...S.section, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Element config</span>
              <button onClick={copyConfig}
                style={{ padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontFamily: 'Quicksand, sans-serif', fontSize: 11, fontWeight: 700, background: copied ? '#2E7D32' : '#3D5A44', color: '#fff' }}>
                {copied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
            <div style={{ fontSize: 10.5, color: '#9BB5A2', fontWeight: 600, marginBottom: 6 }}>Paste the <code>relief</code> object into the element’s placement_config when adding it.</div>
            <pre style={{ margin: 0, padding: 10, borderRadius: 8, background: '#F4F8F5', border: '1.5px solid #C5D4C8', color: '#2C4433', fontSize: 11, lineHeight: 1.45, fontFamily: 'ui-monospace, Menlo, monospace', whiteSpace: 'pre', overflowX: 'auto' }}>{configText}</pre>
          </div>
        </div>
      </div>
    </>
  );
}
