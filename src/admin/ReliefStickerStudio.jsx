import { useState, useMemo, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import * as THREE from 'three';
import { extractRegions, recolorRegions } from './recolor.js';

// Draw an image onto a fresh canvas (capped at `max`px on the long edge) so the pixels can be recoloured.
function imgToCanvas(img, max = 1024) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const scale = Math.min(1, max / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale)), h = Math.max(1, Math.round(ih * scale));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c;
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

function imageToFields(img) {
  const scale = Math.min(1, WORK / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
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
function buildFields(f, { puff, detail, blur, edgeRound, flipY, grain }) {
  const { w, h, mask, lum } = f, N = w * h;
  const domeRaw = boxBlur(mask, w, h, Math.max(1, Math.round(blur)), 2);
  let dmx = 1e-4; for (let i = 0; i < N; i++) if (mask[i] > 0.5 && domeRaw[i] > dmx) dmx = domeRaw[i];
  const cov = boxBlur(mask, w, h, Math.max(1, Math.round(edgeRound)), 2);
  const lumBlur = boxBlur(lum, w, h, 2, 1);
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
    const macro = coverage * ((1 - puff) + puff * dome);       // slab ↔ dome
    H[i] = macro;
    let hn = macro + (lum[i] - lumBlur[i]) * detail * coverage;
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
  const [aspect, setAspect] = useState(1);
  const [puff, setPuff] = useState(0.5);       // slab(0) ↔ dome(1)
  const [detail, setDetail] = useState(0.4);
  const [blur, setBlur] = useState(34);        // dome blur
  const [edgeRound, setEdgeRound] = useState(16); // bevel radius (px) — kills the sawtooth
  const [grain, setGrain] = useState(0.5);        // fondant micro-grain
  const [flipY, setFlipY] = useState(false);
  const [delit, setDelit] = useState(0);
  const [lift, setLift] = useState(0.07);
  const [normalScale, setNormalScale] = useState(0.8);
  const [roughness, setRoughness] = useState(0.7);
  const [sheen, setSheen] = useState(0.12);
  const [envIntensity, setEnvIntensity] = useState(0.4);
  const [toneMapped, setToneMapped] = useState(false);
  const [zone, setZone] = useState('side');
  const [mode, setMode] = useState('hug');
  const [size, setSize] = useState(0.95);
  const [posA, setPosA] = useState(0);   // side: around the wall (−1..1 → ±180°) · top: X
  const [posB, setPosB] = useState(0);   // side: height · top: Z
  const [cakeColor, setCakeColor] = useState('#f7d9e3');
  const [recolor, setRecolor] = useState(false);          // recolour the image's coloured regions
  const [recolorGuard, setRecolorGuard] = useState(0.18); // min saturation to count as coloured (protects whites/blacks)
  const [targets, setTargets] = useState([]);             // per-region target hex, parallel to `regions`

  function pickFile(f) {
    if (!f) return;
    const img = new Image();
    img.onload = () => { setImgEl(img); setAspect((img.naturalWidth || 1) / (img.naturalHeight || 1)); };
    img.src = URL.createObjectURL(f);
  }

  // Distinct colour regions of the image (by hue), so each can be recoloured independently.
  const regions = useMemo(() => (recolor && imgEl ? extractRegions(imgToCanvas(imgEl), { minSat: recolorGuard }) : []), [recolor, imgEl, recolorGuard]);
  useEffect(() => { setTargets(regions.map(r => r.hex)); }, [regions]);

  // Albedo (colour) — de-light then recolour, both on a canvas. The relief maps below are built from the
  // ORIGINAL luminance, and recolour is luminance-preserving, so the 3D shape is unaffected either way.
  const albedoTex = useMemo(() => {
    if (!imgEl) return null;
    let t;
    if (delit > 0 || recolor) {
      const canvas = delit > 0 ? buildDelitAlbedo(imgEl, delit) : imgToCanvas(imgEl);
      if (recolor && regions.length && targets.length === regions.length) {
        recolorRegions(canvas, regions.map(r => r.hue), targets, { minSat: recolorGuard });
      }
      t = new THREE.CanvasTexture(canvas);
    } else {
      t = new THREE.Texture(imgEl);
    }
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.needsUpdate = true; return t;
  }, [imgEl, delit, recolor, regions, targets, recolorGuard]);

  const maps = useMemo(() => {
    if (!imgEl) return null;
    const flds = buildFields(imageToFields(imgEl), { puff, detail, blur, edgeRound, flipY, grain });
    const normal = new THREE.CanvasTexture(normalCanvas(flds));
    normal.colorSpace = THREE.NoColorSpace; normal.anisotropy = 8; normal.needsUpdate = true;
    const disp = new THREE.CanvasTexture(dispCanvas(flds));
    disp.colorSpace = THREE.NoColorSpace; disp.needsUpdate = true;
    return { normal, disp };
  }, [imgEl, puff, detail, blur, edgeRound, flipY, grain]);

  const [copied, setCopied] = useState(false);
  // The relief recipe to drop into the element's placement_config (see core bake plan): runtime
  // material knobs + a `bake` block (the params the ingest step rebuilds the normal/displacement maps
  // from). Placement (zone/size/position) is set per-element in the designer, so it's not included.
  const reliefConfig = useMemo(() => ({
    relief: {
      lift: +lift.toFixed(3),
      normalScale: +normalScale.toFixed(2),
      roughness: +roughness.toFixed(2),
      sheen: +sheen.toFixed(2),
      envIntensity: +envIntensity.toFixed(2),
      toneMapped,
      bake: {
        puff: +puff.toFixed(2),
        domeBlur: blur,
        edgeRound,
        detail: +detail.toFixed(2),
        grain: +grain.toFixed(2),
        delit: +delit.toFixed(2),
        flipY,
      },
    },
  }), [lift, normalScale, roughness, sheen, envIntensity, toneMapped, puff, blur, edgeRound, detail, grain, delit, flipY]);
  const configText = useMemo(() => JSON.stringify(reliefConfig, null, 2), [reliefConfig]);
  function copyConfig() { navigator.clipboard?.writeText(configText); setCopied(true); setTimeout(() => setCopied(false), 1500); }

  const place = useMemo(() => placement(zone, mode, size * aspect, size), [zone, mode, size, aspect]);
  const nScale = useMemo(() => new THREE.Vector2(normalScale, normalScale), [normalScale]);
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
                  <mesh geometry={place.geo} position={place.pos} rotation={place.rot} castShadow receiveShadow>
                    <meshPhysicalMaterial
                      map={albedoTex} normalMap={maps.normal} normalScale={nScale}
                      displacementMap={maps.disp} displacementScale={lift}
                      alphaTest={0.5} alphaToCoverage roughness={roughness} metalness={0}
                      sheen={sheen} sheenColor={'#ffffff'} sheenRoughness={0.85}
                      envMapIntensity={envIntensity} toneMapped={toneMapped} side={THREE.DoubleSide}
                    />
                  </mesh>
                  </group>
                )}
                <OrbitControls enablePan={false} target={[0, 0.8, 0]} />
              </Canvas>
            </div>
          </div>

          <div style={S.card}>
            <label style={S.pick}>＋ Load 2D image (transparent PNG)
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => pickFile(e.target.files[0])} />
            </label>

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
              <input type="color" value={cakeColor} onChange={e => setCakeColor(e.target.value)}
                style={{ width: 40, height: 26, border: '1.5px solid #C5D4C8', borderRadius: 6, cursor: 'pointer', padding: 2, background: '#fff' }} />
              <span style={{ ...S.val, width: 'auto', color: '#9BB5A2', fontFamily: 'monospace' }}>{cakeColor}</span>
            </div>

            <div style={S.section}>Elevation (real 3D)</div>
            <Slider label="Lift off wall" value={lift} set={setLift} min={0} max={0.25} fmt={v => v.toFixed(3)} />
            <Slider label="Edge round" value={edgeRound} set={setEdgeRound} min={2} max={48} step={1} fmt={v => `${v}px`} />
            <Slider label="Dome ↔ slab" value={puff} set={setPuff} min={0} max={1} />
            <Slider label="Dome blur" value={blur} set={setBlur} min={2} max={80} step={1} fmt={v => `${v}px`} />

            <div style={S.section}>Surface</div>
            <Slider label="Fondant grain" value={grain} set={setGrain} min={0} max={1} />
            <Slider label="Surface detail" value={detail} set={setDetail} min={0} max={2} />
            <Slider label="Detail strength" value={normalScale} set={setNormalScale} min={0} max={3} />
            <div style={S.row}><span style={S.lbl}>Flip green</span>
              <input type="checkbox" checked={flipY} onChange={e => setFlipY(e.target.checked)} style={{ accentColor: '#3D5A44', width: 16, height: 16 }} /></div>

            <div style={S.section}>Recolour</div>
            <div style={S.row}><span style={S.lbl}>Recolour</span>
              <input type="checkbox" checked={recolor} onChange={e => setRecolor(e.target.checked)} style={{ accentColor: '#3D5A44', width: 16, height: 16 }} /></div>
            {recolor && (<>
              <Slider label="Colour guard" value={recolorGuard} set={setRecolorGuard} min={0} max={0.5} step={0.01} />
              {regions.length === 0 && <div style={{ fontSize: 11, color: '#9BB5A2', fontWeight: 600, marginBottom: 6 }}>No colour regions found — load a coloured cut-out.</div>}
              {regions.map((r, i) => (
                <div key={i} style={S.row}>
                  <span style={{ width: 22, height: 22, borderRadius: 6, border: '1.5px solid #C5D4C8', background: r.hex, flexShrink: 0 }} title={`detected ${r.hex}`} />
                  <span style={{ color: '#9BB5A2', fontWeight: 700 }}>→</span>
                  <input type="color" value={targets[i] ?? r.hex} onChange={e => setTargets(t => t.map((c, j) => (j === i ? e.target.value : c)))}
                    style={{ width: 40, height: 26, border: '1.5px solid #C5D4C8', borderRadius: 6, cursor: 'pointer', padding: 2, background: '#fff' }} />
                  <span style={{ ...S.val, width: 'auto', color: '#9BB5A2', fontFamily: 'monospace' }}>{Math.round(r.share * 100)}%</span>
                </div>
              ))}
              <div style={{ fontSize: 10.5, color: '#9BB5A2', fontWeight: 600, marginBottom: 6 }}>Each detected colour recolours on its own; whites, blacks &amp; highlights stay, relief unchanged. (Clustered by hue — brown groups with orange.)</div>
            </>)}

            <div style={S.section}>Albedo / material</div>
            <Slider label="De-light" value={delit} set={setDelit} min={0} max={1} />
            <Slider label="Roughness" value={roughness} set={setRoughness} min={0} max={1} />
            <Slider label="Sheen (satin)" value={sheen} set={setSheen} min={0} max={1} />
            <Slider label="Env intensity" value={envIntensity} set={setEnvIntensity} min={0} max={2} />
            <div style={S.row}><span style={S.lbl}>Tone-mapped</span>
              <input type="checkbox" checked={toneMapped} onChange={e => setToneMapped(e.target.checked)} style={{ accentColor: '#3D5A44', width: 16, height: 16 }} /></div>

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
