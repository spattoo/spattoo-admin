import { useState, useMemo, useEffect, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import { HexColorPicker } from 'react-colorful';
import * as THREE from 'three';
import { recolorRegion } from './recolor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Folded butterfly — ONE source image rendered as a two-plane "folded sticker".
//
// A real wafer/card butterfly is two flat wings hinged on the central spine. We
// take a single cutout, split it down the spine, map each half onto its own plane,
// and hinge them. `fold` = the dihedral between the wings:
//   fold = 0°  → wings coplanar → flat sticker lying on the cake top
//   fold = 30–60° → wings raised into a V → the standing folded butterflies
// Same image, no 3D model invented — physically how these decorations actually fold.
//
// This is a PROTOTYPE in admin. Once the look reads right we port the two-plane
// geometry into spattoo-core's StickerTexture, gated on `placement_config.fold`
// (config-driven, never on element type/slug — see INVARIANTS #1/#2).
// ─────────────────────────────────────────────────────────────────────────────

// ── Cake stage — mirrors CreamPenStudio / PipingCalibrator so the preview reads
// like the designer ──
const CAKE_RADIUS = 1.2;
const CAKE_HEIGHT = 1.45;
const Y_BASE      = 0.1;
const TOP_Y       = Y_BASE + CAKE_HEIGHT;   // the cake-top surface
const DEG         = Math.PI / 180;

// Canonical butterfly height in cake units at size = 1 (before the size multiplier).
const BUTTERFLY_H = 0.55;

const STANDARD_CAKE_COLOR = '#f5c6d0';
function CakeScene({ cakeColor = STANDARD_CAKE_COLOR }) {
  return (
    <>
      <mesh position={[0, 0.05, 0]} receiveShadow>
        <cylinderGeometry args={[CAKE_RADIUS + 0.6, CAKE_RADIUS + 0.6, 0.1, 64]} />
        <meshStandardMaterial color="#d4af37" roughness={0.15} metalness={0.75} />
      </mesh>
      <mesh position={[0, Y_BASE + CAKE_HEIGHT / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[CAKE_RADIUS, CAKE_RADIUS, CAKE_HEIGHT, 64]} />
        <meshStandardMaterial color={cakeColor} roughness={0.68} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[20, 20]} />
        <meshStandardMaterial color="#f0ebe5" roughness={0.9} />
      </mesh>
    </>
  );
}

// Recolour the violet wing fill → the picked hue (shading preserved). Butterfly's tintable region is
// identified by blue > green (lavender), which STRUCTURALLY excludes gold edges (green > blue) and white
// highlights (blue ≈ green) — cleaner than a hue band at the anti-aliased boundary. `guard` = the
// blue-over-green margin (higher protects the gold more). The luminance-preserving algorithm + colour
// helpers now live in ./recolor.js, shared with the relief-sticker studio.
function recolorWings(canvas, targetHex, guard) {
  recolorRegion(canvas, targetHex, (d, i) => d[i + 3] >= 8 && (d[i + 2] - d[i + 1]) >= guard);
}

function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

// ── Image processing (the part the Remove.bg pipeline replaces in prod) ─────────
// Flood-fill near-white from the four borders → transparent, so interior white
// highlights survive (a global threshold would punch holes in the wings). Then crop
// to the content bounds so the plane aspect = the butterfly, not the square margin.
function processImage(img, { removeBg, threshold, rotate }) {
  // Pre-rotate the source in-plane so a diagonal butterfly's body becomes vertical —
  // the fold hinges on the image's vertical centerline, so the body must sit upright.
  const rad = (rotate || 0) * DEG;
  const w0 = img.naturalWidth, h0 = img.naturalHeight;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const w = Math.ceil(w0 * cos + h0 * sin), h = Math.ceil(w0 * sin + h0 * cos);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (removeBg) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }  // white margin to flood-fill
  ctx.translate(w / 2, h / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, -w0 / 2, -h0 / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  if (!removeBg) return { canvas: c, aspect: w / h };

  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;
  const seen = new Uint8Array(w * h);
  const stack = [];
  const isWhite = p => d[p * 4] >= threshold && d[p * 4 + 1] >= threshold && d[p * 4 + 2] >= threshold;
  const push = (x, y) => { const p = y * w + x; if (!seen[p]) { seen[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const p = stack.pop();
    if (!isWhite(p)) continue;
    d[p * 4 + 3] = 0;                       // clear alpha on background
    const x = p % w, y = (p / w) | 0;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  ctx.putImageData(id, 0, 0);

  // Crop to opaque bounds.
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] > 8) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX) return { canvas: c, aspect: w / h };   // nothing left — bail
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  out.getContext('2d').drawImage(c, minX, minY, cw, ch, 0, 0, cw, ch);
  return { canvas: out, aspect: cw / ch };
}

function useProcessedTexture(imageUrl, removeBg, threshold, rotate, tint, tintColor, tintGuard) {
  // Heavy stage — load + background-removal + trim. Re-runs only when the SOURCE changes,
  // never on a colour-picker drag (the flood-fill is the expensive part).
  const [base, setBase] = useState(null);   // { canvas, aspect }
  useEffect(() => {
    if (!imageUrl) { setBase(null); return; }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { if (!cancelled) setBase(processImage(img, { removeBg, threshold, rotate })); };
    img.onerror = () => { if (!cancelled) setBase(null); };
    img.src = imageUrl;
    return () => { cancelled = true; };
  }, [imageUrl, removeBg, threshold, rotate]);

  // Light stage — recolour the wings + build the texture. Cheap; re-runs on colour change.
  const [state, setState] = useState({ tex: null, aspect: 1, canvas: null });
  useEffect(() => {
    if (!base) { setState({ tex: null, aspect: 1, canvas: null }); return; }
    const canvas = cloneCanvas(base.canvas);
    if (tint) recolorWings(canvas, tintColor, tintGuard);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    setState({ tex, aspect: base.aspect, canvas });
  }, [base, tint, tintColor, tintGuard]);
  return state;
}

// ── The folded mesh — TWO planes sharing a spine hinge, ONE image ───────────────
// `tex` is the trimmed cutout. We clone it twice and use offset/repeat to sample
// the left half [0, spine] and right half [spine, 1] — so it stays a single asset.
function FoldedButterflyMesh({ tex, aspect, fold, spine, size }) {
  const { texL, texR } = useMemo(() => {
    if (!tex) return {};
    const L = tex.clone(); L.needsUpdate = true; L.wrapS = THREE.ClampToEdgeWrapping;
    L.offset.set(0, 0); L.repeat.set(spine, 1);
    const R = tex.clone(); R.needsUpdate = true; R.wrapS = THREE.ClampToEdgeWrapping;
    R.offset.set(spine, 0); R.repeat.set(1 - spine, 1);
    return { texL: L, texR: R };
  }, [tex, spine]);

  if (!tex) return null;
  const H = BUTTERFLY_H * size;
  const W = H * aspect;
  const wL = W * spine, wR = W * (1 - spine);
  const foldR = fold * DEG;

  const mat = (map) => (
    <meshStandardMaterial map={map} transparent alphaTest={0.45}
      roughness={0.5} metalness={0} side={THREE.DoubleSide} />
  );

  // Canonical: XY plane, facing +Z, spine on the Y axis. Each wing pivots on x=0
  // and rotates back about Y by ±fold → the wings lift into a shallow V.
  return (
    <group>
      <group rotation={[0, foldR, 0]}>
        <mesh position={[-wL / 2, 0, 0]} castShadow>
          <planeGeometry args={[wL, H]} />
          {mat(texL)}
        </mesh>
      </group>
      <group rotation={[0, -foldR, 0]}>
        <mesh position={[wR / 2, 0, 0]} castShadow>
          <planeGeometry args={[wR, H]} />
          {mat(texR)}
        </mesh>
      </group>
    </group>
  );
}

// Place the canonical butterfly onto the cake. `mode` sets the BASE orientation —
// `lay` drops it flat onto the top, `stand` keeps it upright — and rotX/rotY/rotZ are
// the user's free rotation on top of that. Position is polar: `radius` (radial distance
// from the cake's central axis) + `angle` around it + `height` (Y of the centre).
function PlacedButterfly({ tex, aspect, cfg }) {
  const H = BUTTERFLY_H * cfg.size;
  const a = cfg.angle * DEG;
  // Auto-seat baseline per target: top-stand sits on its base, top-lay rests flat,
  // side rides mid-wall. `lift` nudges from there (on side: up/down the wall).
  const seatY = cfg.mode === 'lay' ? TOP_Y
    : cfg.mode === 'side' ? Y_BASE + CAKE_HEIGHT / 2
    : TOP_Y + H / 2;
  const position = [cfg.radius * Math.sin(a), seatY + cfg.lift, cfg.radius * Math.cos(a)];
  const rotation = [cfg.rotX * DEG, cfg.rotY * DEG, cfg.rotZ * DEG];
  // Base orientation: lay → flat on top; side → face radially outward (follows angle);
  // stand → upright. User rotX/Y/Z stack on top of this.
  const base = cfg.mode === 'lay' ? [-Math.PI / 2, 0, 0]
    : cfg.mode === 'side' ? [0, a, 0]
    : [0, 0, 0];
  return (
    <group position={position} rotation={rotation}>
      <group rotation={base}>
        <FoldedButterflyMesh tex={tex} aspect={aspect} fold={cfg.fold} spine={cfg.spine} size={cfg.size} />
      </group>
    </group>
  );
}

// A reference-style arrangement: a couple standing near the centre, the rest
// inserted around the rim, with varied fold/size so it reads like the real cake.
const SCATTER = [
  { mode: 'stand', r: 0.32, ang:  40, y: 0.0,  yaw:  20, tilt:  6, fold: 34, size: 0.95 },
  { mode: 'stand', r: 0.10, ang: 160, y: 0.0,  yaw: -25, tilt:  8, fold: 40, size: 1.05 },
  { mode: 'stand', r: 1.02, ang:  90, y: -0.5, yaw:   0, tilt: 10, fold: 22, size: 1.0  },
  { mode: 'stand', r: 1.04, ang: 215, y: -0.7, yaw:  18, tilt: 14, fold: 30, size: 1.1  },
  { mode: 'stand', r: 1.03, ang: 320, y: -0.3, yaw: -12, tilt:  8, fold: 26, size: 0.9  },
  { mode: 'lay',   r: 0.55, ang: 270, y: 0.0,  yaw:  60, tilt: 18, fold: 14, size: 0.85 },
];
function ScatterPreview({ tex, aspect }) {
  if (!tex) return null;
  return SCATTER.map((s, i) => {
    const onSide = s.mode === 'stand' && s.r > 0.6;   // rim-inserted vs top
    // Rim ones drop down the side wall; top ones nudge by s.y from the seat baseline.
    const lift = onSide ? (Y_BASE + CAKE_HEIGHT / 2) - TOP_Y + s.y : (s.mode === 'lay' ? 0.01 : s.y);
    const cfg = {
      mode: s.mode, size: s.size, fold: s.fold, spine: 0.5,
      radius: s.r, angle: s.ang, lift,
      rotX: s.tilt, rotY: onSide ? s.ang : s.yaw, rotZ: 0,  // rim ones face outward
    };
    return <PlacedButterfly key={i} tex={tex} aspect={aspect} cfg={cfg} />;
  });
}

// ── UI ──────────────────────────────────────────────────────────────────────────
// Flat preview of the processed cutout with the spine line drawn on it — so you can
// see whether the hinge lands on the body before judging the 3D fold.
function SpinePreview({ canvas, spine }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !canvas) return;
    const W = 150, scale = W / canvas.width, H = Math.round(canvas.height * scale);
    el.width = W; el.height = H;
    const ctx = el.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(canvas, 0, 0, W, H);
    ctx.strokeStyle = '#e0444e';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(spine * W, 0);
    ctx.lineTo(spine * W, H);
    ctx.stroke();
  }, [canvas, spine]);
  if (!canvas) return null;
  return (
    <canvas ref={ref}
      style={{ width: 150, display: 'block', margin: '8px auto 0', borderRadius: 8, border: '1px solid #E8EFE9', background: '#faf7f2' }} />
  );
}

function Slider({ label, value, min, max, step = 1, onChange, color = '#3D5A44', resetTo = 0 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color, minWidth: 96, fontFamily: "'Quicksand',sans-serif" }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))} style={{ flex: 1, accentColor: color }} />
      <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 46, textAlign: 'right', fontFamily: "'Quicksand',sans-serif" }}>
        {typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(2) : value}
      </span>
      <button onClick={() => onChange(resetTo)}
        style={{ fontSize: 10, padding: '2px 6px', border: '1px solid #C5D4C8', borderRadius: 4, background: '#fff', cursor: 'pointer', color: '#9BB5A2' }}>
        {resetTo}
      </button>
    </div>
  );
}

const DEFAULT_CFG = {
  mode:    'stand',   // base orientation: 'stand' (upright) | 'lay' (flat on the top)
  fold:    36,        // dihedral between the wings, degrees
  spine:   0.5,       // split fraction of the image width (the body centerline)
  size:    1.0,
  rotX:    0,         // free rotation on top of the base orientation, degrees
  rotY:    0,
  rotZ:    0,
  radius:  0,         // radial distance from the cake's central axis
  angle:   0,         // position around the cake, degrees
  lift:    0,         // raise (+) / drop (−) from the auto-seat-on-cake baseline
};

export default function ButterflyStudio() {
  const [cfg, setCfg] = useState(DEFAULT_CFG);
  const [imageUrl, setImageUrl] = useState('');
  const [urlField, setUrlField] = useState('');
  const [removeBg, setRemoveBg] = useState(true);
  const [threshold, setThreshold] = useState(235);
  const [imgRotate, setImgRotate] = useState(0);
  const [tint, setTint] = useState(false);
  const [tintColor, setTintColor] = useState('#f4a9c8');
  const [tintGuard, setTintGuard] = useState(12);
  const [scatter, setScatter] = useState(false);
  const [cakeColor, setCakeColor] = useState(STANDARD_CAKE_COLOR);
  const fileRef = useRef(null);
  const set = key => v => setCfg(p => ({ ...p, [key]: v }));
  // Switching target re-seats placement: side rides out at the wall radius, top sits centred.
  const setMode = m => setCfg(p => ({ ...p, mode: m, radius: m === 'side' ? CAKE_RADIUS + 0.04 : 0, lift: 0 }));

  const { tex, aspect, canvas } = useProcessedTexture(imageUrl, removeBg, threshold, imgRotate, tint, tintColor, tintGuard);

  const onFile = e => {
    const f = e.target.files?.[0];
    if (f) setImageUrl(URL.createObjectURL(f));
  };

  const cfgJson = useMemo(() => JSON.stringify({
    allowed_zones: ['top_surface', 'side'],
    placement_config: {
      top_surface: cfg.mode === 'lay' ? 'hug' : 'stand',
      side: 'stand',
      r: +cfg.size.toFixed(2),
      fold: Math.round(cfg.fold),        // NEW: dihedral degrees → two-plane folded sticker
      spine: +cfg.spine.toFixed(2),      // NEW: body centerline split (default 0.5)
      single_per_slot: false,            // scatter freely, like the reference cake
    },
  }, null, 2), [cfg]);

  const panel = { background: '#fff', border: '1.5px solid #E8EFE9', borderRadius: 12, padding: 16, marginBottom: 14 };
  const heading = { fontSize: 11, fontWeight: 800, color: '#9B5F72', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 };

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', fontFamily: "'Quicksand', sans-serif", background: '#EDEAE2' }}>
      {/* Controls */}
      <div style={{ width: 360, overflowY: 'auto', padding: 18, borderRight: '1px solid #DCE5DD' }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, color: '#2C4433', margin: '0 0 4px' }}>Folded Butterfly</h2>
        <p style={{ fontSize: 11, color: '#9BB5A2', margin: '0 0 16px', lineHeight: 1.5 }}>
          ONE image, split on the spine into two hinged wings. <b>Fold</b> lifts the wings
          into a V. Prototype — once it reads right we port the two-plane geometry into
          <b> spattoo-core</b> as a config-driven sticker (<code>placement_config.fold</code>).
        </p>

        <div style={panel}>
          <div style={heading}>Source image</div>
          <button onClick={() => fileRef.current?.click()}
            style={{ width: '100%', padding: '10px', fontSize: 13, fontWeight: 700, color: '#fff', background: '#3D5A44',
              border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: "'Quicksand',sans-serif" }}>
            Choose butterfly PNG…
          </button>
          <input ref={fileRef} type="file" accept="image/*" onChange={onFile} style={{ display: 'none' }} />
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input value={urlField} onChange={e => setUrlField(e.target.value)} placeholder="…or paste an image URL"
              style={{ flex: 1, boxSizing: 'border-box', padding: '8px 10px', fontSize: 12, color: '#2C4433',
                border: '1.5px solid #C5D4C8', borderRadius: 8, fontFamily: "'Quicksand',sans-serif", outline: 'none' }} />
            <button onClick={() => urlField && setImageUrl(urlField)}
              style={{ fontSize: 12, padding: '0 12px', fontWeight: 700, color: '#3D5A44', background: '#fff',
                border: '1.5px solid #C5D4C8', borderRadius: 8, cursor: 'pointer' }}>Load</button>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 12, fontWeight: 700, color: '#2C4433' }}>
            <input type="checkbox" checked={removeBg} onChange={e => setRemoveBg(e.target.checked)} />
            Remove white background (edge flood-fill)
          </label>
          {removeBg && (
            <Slider label="White cutoff" value={threshold} min={180} max={252} step={1} resetTo={235} onChange={setThreshold} color="#7ab0d6" />
          )}
          <Slider label="Straighten" value={imgRotate} min={-90} max={90} step={1} resetTo={0} onChange={setImgRotate} color="#c47ad6" />
          <p style={{ fontSize: 10, color: '#9BB5A2', margin: '6px 0 0', lineHeight: 1.5 }}>
            Prod uses the Remove.bg pipeline; this in-canvas flood-fill is for the prototype.
            <b> Straighten</b> the image so the body is <b>vertical</b>, then align the
            <b> Spine split</b> onto it — the wings hinge on that line.
          </p>
        </div>

        <div style={panel}>
          <div style={heading}>Fold</div>
          <Slider label="Fold angle" value={cfg.fold} min={0} max={75} step={1} resetTo={36} onChange={set('fold')} color="#c47ad6" />
          <Slider label="Spine split" value={cfg.spine} min={0.35} max={0.65} step={0.01} resetTo={0.5} onChange={set('spine')} color="#e0a052" />
          <p style={{ fontSize: 10, color: '#9BB5A2', margin: '2px 0 0', lineHeight: 1.5 }}>
            0° = flat sticker · 30–45° = the raised folded look. The dashed line is the
            hinge — line it up on the body with <b>Spine split</b> (and <b>Straighten</b> above).
          </p>
          <SpinePreview canvas={canvas} spine={cfg.spine} />
        </div>

        <div style={panel}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, ...heading, marginBottom: tint ? 10 : 0 }}>
            <input type="checkbox" checked={tint} onChange={e => setTint(e.target.checked)} />
            Recolour wings
          </label>
          {tint && (
            <>
              <HexColorPicker color={tintColor} onChange={setTintColor} style={{ width: '100%', height: 130 }} />
              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                {['#f4a9c8', '#d9a7e8', '#a7c4e8', '#a7e8c4', '#f4d58d', '#e89aa7'].map(c => (
                  <button key={c} onClick={() => setTintColor(c)}
                    style={{ width: 26, height: 26, borderRadius: '50%', background: c, cursor: 'pointer',
                      border: tintColor.toLowerCase() === c ? '2px solid #2C4433' : '1px solid #C5D4C8' }} />
                ))}
              </div>
              <div style={{ marginTop: 10 }}>
                <Slider label="Edge protect" value={tintGuard} min={0} max={50} step={1} resetTo={12} onChange={setTintGuard} color="#e0a052" />
              </div>
              <p style={{ fontSize: 10, color: '#9BB5A2', margin: '8px 0 0', lineHeight: 1.5 }}>
                Only the violet fill is recoloured — gold edges &amp; white highlights stay.
                Raise <b>Edge protect</b> if colour bleeds into the gold lines.
              </p>
            </>
          )}
        </div>

        <div style={panel}>
          <div style={heading}>Placement</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {[{ k: 'stand', l: 'Stand on top' }, { k: 'lay', l: 'Lay on top' }, { k: 'side', l: 'On side' }].map(s => (
              <button key={s.k} onClick={() => setMode(s.k)}
                style={{ flex: 1, fontSize: 11.5, padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontWeight: 700,
                  border: `2px solid ${cfg.mode === s.k ? '#3D5A44' : '#C5D4C8'}`,
                  background: cfg.mode === s.k ? '#3D5A44' : '#fff', color: cfg.mode === s.k ? '#fff' : '#6B8C74' }}>
                {s.l}
              </button>
            ))}
          </div>
          <Slider label="Size" value={cfg.size} min={0.4} max={2} step={0.05} resetTo={1} onChange={set('size')} color="#e0a052" />
          <div style={{ fontSize: 10, fontWeight: 800, color: '#9BB5A2', margin: '8px 0 4px', textTransform: 'uppercase', letterSpacing: 0.6 }}>Rotation</div>
          <Slider label="Rot X (pitch)" value={cfg.rotX} min={-180} max={180} step={1} onChange={set('rotX')} color="#e05252" />
          <Slider label="Rot Y (yaw)"   value={cfg.rotY} min={-180} max={180} step={1} onChange={set('rotY')} color="#52c452" />
          <Slider label="Rot Z (roll)"  value={cfg.rotZ} min={-180} max={180} step={1} onChange={set('rotZ')} color="#5252e0" />
          <div style={{ fontSize: 10, fontWeight: 800, color: '#9BB5A2', margin: '8px 0 4px', textTransform: 'uppercase', letterSpacing: 0.6 }}>Position</div>
          <Slider label="Radial dist." value={cfg.radius} min={0} max={1.4} step={0.02} onChange={set('radius')} color="#e0a052" />
          <Slider label="Angle" value={cfg.angle} min={-180} max={180} step={1} onChange={set('angle')} color="#c47ad6" />
          <Slider label="Lift / drop" value={cfg.lift} min={-1.4} max={1.4} step={0.02} resetTo={0} onChange={set('lift')} color="#7ab0d6" />
        </div>

        <div style={panel}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 800, color: '#9B5F72' }}>
            <input type="checkbox" checked={scatter} onChange={e => setScatter(e.target.checked)} />
            Scatter preview (reference arrangement)
          </label>
          <p style={{ fontSize: 10, color: '#9BB5A2', margin: '6px 0 0', lineHeight: 1.5 }}>
            Drops a handful with varied fold/size — top & rim — to compare against the real cake.
          </p>
        </div>

        <div style={panel}>
          <div style={heading}>placement_config</div>
          <pre style={{ fontSize: 11, color: '#2C4433', margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', lineHeight: 1.5 }}>{cfgJson}</pre>
        </div>
      </div>

      {/* Preview */}
      <div style={{ flex: 1, position: 'relative' }}>
        <Canvas shadows camera={{ position: [0, 4.6, 6.2], fov: 42 }}>
          <ambientLight intensity={0.7} />
          <directionalLight position={[5, 10, 5]} intensity={1.4} castShadow />
          <directionalLight position={[-3, 3, -3]} intensity={0.3} />
          <Environment preset="apartment" backgroundBlurriness={1} />
          <CakeScene cakeColor={cakeColor} />
          {scatter
            ? <ScatterPreview tex={tex} aspect={aspect} />
            : <PlacedButterfly tex={tex} aspect={aspect} cfg={cfg} />}
          <OrbitControls makeDefault target={[0, 1.6, 0]} />
        </Canvas>
        {!tex && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <div style={{ background: 'rgba(255,255,255,0.92)', padding: '14px 20px', borderRadius: 12, fontSize: 13, fontWeight: 700, color: '#6B8C74' }}>
              ← Choose a butterfly PNG to begin
            </div>
          </div>
        )}
        <div style={{ position: 'absolute', top: 14, right: 14, display: 'flex', alignItems: 'center', gap: 8,
          background: '#fff', padding: '6px 10px', borderRadius: 10, border: '1px solid #E8EFE9' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#6B8C74' }}>Cake</span>
          <input type="color" value={cakeColor} onChange={e => setCakeColor(e.target.value)}
            style={{ width: 28, height: 28, border: 'none', background: 'none', cursor: 'pointer' }} />
        </div>
      </div>
    </div>
  );
}
