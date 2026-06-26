import { useState, useMemo, useRef, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import * as THREE from 'three';
import { displaceByHeightField, normalTextureFromField, heightTextureFromField } from '@spattoo/designer';
import { loadStrokeStamp, paintStrokeTile, paletteWallTiling, blurTile, tintToColorField } from './paletteKnife.js';

// ── Palette-Knife Studio (M1 — nail the impasto texture) ───────────────────────
//
// Authors the buttercream "palette-knife impasto" cream finish. Direction (agreed): a REAL stroke photo
// (/palette-stroke.png) → extracted into a stamp (soft alpha + domed body + high-pass ridges, gloss
// discarded), PAINTED many times painter's-style (colour + relief coupled per stroke), rendered
// normal-map-dominant (crisp normal ridges + modest displacement). Built on core's exported helpers so
// core stays untouched until the look is approved (then ports to buildStyledWall + cake_textures, M2).
// Two user-changeable colours (base/cake + stroke), intermixed per stroke. Validate ONE stroke first.

const R = 1, H = 1.4;
const STROKE_URL = '/palette-stroke.png';

// Composition + material params (the stamp extraction params stay fixed for now). default = the look.
const FIELDS = [
  ['relief',    'Depth',          0,    0.16, 0.005, 0.07],
  ['tiles',     'Tiles around',   1,    8,    1,     3],
  ['count',     'Strokes / tile', 10,   160,  1,     64],
  ['angle',     'Direction °',  -180,   180,  5,     90],
  ['spread',    'Angle spread',   0,    3.14, 0.05,  1.0],
  ['scaleMin',  'Stroke min',     0.2,  1.0,  0.05,  0.5],
  ['scaleMax',  'Stroke max',     0.4,  1.4,  0.05,  0.95],
  ['accentMix', 'Stroke colour mix',0,  1,    0.05,  0.45],
  ['rise',      'Layer rise',     0,    0.8,  0.05,  0.3],
  ['dispBlur',  'Mound smoothing',0,    10,   1,     4],
  ['grain',     'Ridge strength', 0,    2.5,  0.1,   1.2],
  ['gloss',     'Gloss',          0,    1,    0.05,  0.35],
  ['roughness', 'Roughness',      0,    1,    0.05,  0.45],
];
const DEFAULTS = Object.fromEntries(FIELDS.map(([k, , , , , d]) => [k, d]));
const SWATCHES = ['#f7f3ee', '#e23b4e', '#3f7fd6', '#f4c542', '#7a4fc0', '#3fae8e', '#1b1b1b', '#e8a3c0'];
const hexToRgb = (hex) => { const n = parseInt(hex.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

// FULL WALL — paint the seamless impasto tile, derive normal (ridges) + modest displacement (mounds).
function WallMesh({ stamp, p, baseColor, strokeColor }) {
  const shape = useMemo(() => {
    const { around, up } = paletteWallTiling(R, H, p.tiles);
    const { height, tint, w, h } = paintStrokeTile(stamp, {
      size: 768, count: p.count, angle: p.angle * Math.PI / 180, spread: p.spread,
      scaleMin: p.scaleMin, scaleMax: p.scaleMax, accentMix: p.accentMix, rise: p.rise, seed: 7,
    });
    const disp = { height: blurTile(height, w, h, p.dispBlur), w, h };
    const radial = Math.min(512, Math.max(320, around * 130));
    const heightSeg = Math.min(512, Math.max(280, up * 220));
    const geo = displaceByHeightField(new THREE.CylinderGeometry(R, R, H, radial, heightSeg), disp,
      { repeatX: around, repeatY: up, relief: p.relief * R, rimFade: 0.08 });
    const nrm = normalTextureFromField({ height, w, h }, 1);
    nrm.wrapS = nrm.wrapT = THREE.RepeatWrapping; nrm.repeat.set(around, up); nrm.needsUpdate = true;
    return { geo, nrm, tint: { tint, w, h }, around, up };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, JSON.stringify(p)]);

  const colorMap = useMemo(() => {
    const { data, w, h } = tintToColorField(shape.tint, hexToRgb(baseColor), hexToRgb(strokeColor));
    const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(shape.around, shape.up); t.needsUpdate = true; return t;
  }, [shape, baseColor, strokeColor]);

  return (
    <group>
      <mesh castShadow receiveShadow>
        <primitive object={shape.geo} attach="geometry" />
        <meshPhysicalMaterial color="#ffffff" map={colorMap} roughness={p.roughness} metalness={0}
          normalMap={shape.nrm} normalScale={[p.grain, -p.grain]}
          sheen={0.6} sheenRoughness={0.5} sheenColor="#fff7ec"
          clearcoat={p.gloss} clearcoatRoughness={0.28} />
      </mesh>
      <mesh position={[0, H / 2, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[R, 96]} />
        <meshStandardMaterial color={baseColor} roughness={0.6} />
      </mesh>
    </group>
  );
}

// SINGLE STROKE — render the raw extracted stamp on a flat panel to judge the UNIT (relief + gloss +
// edge) before composing the cake. Colour = stroke colour where the stamp covers, base elsewhere.
function StrokeMesh({ stamp, p, baseColor, strokeColor }) {
  const maps = useMemo(() => {
    const nrm = normalTextureFromField({ height: stamp.height, w: stamp.w, h: stamp.h }, 1);
    const disp = heightTextureFromField({ height: blurTile(stamp.height, stamp.w, stamp.h, p.dispBlur), w: stamp.w, h: stamp.h });
    const { data } = tintToColorField({ tint: stamp.alpha, w: stamp.w, h: stamp.h }, hexToRgb(baseColor), hexToRgb(strokeColor));
    const col = new THREE.DataTexture(data, stamp.w, stamp.h, THREE.RGBAFormat);
    col.colorSpace = THREE.SRGBColorSpace; col.needsUpdate = true;
    return { nrm, disp, col };
  }, [stamp, baseColor, strokeColor, p.dispBlur]);

  const aspect = stamp.w / stamp.h;
  return (
    <mesh castShadow>
      <planeGeometry args={[2.2 * aspect, 2.2, 240, 240]} />
      <meshPhysicalMaterial color="#ffffff" map={maps.col} roughness={p.roughness} metalness={0}
        normalMap={maps.nrm} normalScale={[p.grain, -p.grain]}
        displacementMap={maps.disp} displacementScale={p.relief * 6}
        sheen={0.6} sheenRoughness={0.5} sheenColor="#fff7ec"
        clearcoat={p.gloss} clearcoatRoughness={0.28} side={THREE.DoubleSide} />
    </mesh>
  );
}

export default function PaletteKnifeStudio() {
  const [p, setP] = useState(DEFAULTS);
  const [baseColor, setBaseColor] = useState('#f7f3ee');
  const [strokeColor, setStrokeColor] = useState('#e23b4e');
  const [bg, setBg] = useState('#EDEAE2');
  const [mode, setMode] = useState('stroke');     // 'stroke' (validate unit) | 'wall'
  const [stamp, setStamp] = useState(null);
  const [msg, setMsg] = useState(null);
  const glRef = useRef(null);

  useEffect(() => { loadStrokeStamp(STROKE_URL).then(setStamp).catch(e => setMsg('Stroke load failed: ' + e.message)); }, []);
  const set = (k, v) => setP(prev => ({ ...prev, [k]: v }));

  async function saveSnapshot() {
    const gl = glRef.current; if (!gl) return;
    try { await fetch('/__snapshot', { method: 'POST', body: gl.domElement.toDataURL('image/png') }); setMsg('Snapshot saved to .snapshots/'); }
    catch (e) { setMsg('Snapshot failed: ' + e.message); }
  }

  return (
    <div style={s.wrap}>
      <div style={s.panel}>
        <div style={s.title}>Palette-Knife Studio</div>
        <div style={s.hint}>Real stroke → painted impasto. Validate one stroke, then the wall.</div>

        <div style={s.chipRow}>
          {['stroke', 'wall'].map(m => (
            <button key={m} onClick={() => setMode(m)}
              style={{ ...s.chip, ...(mode === m ? s.chipOn : {}) }}>
              {m === 'stroke' ? 'Single stroke' : 'Full wall'}
            </button>
          ))}
        </div>

        <label style={s.lbl}>Base (cake) colour</label>
        <div style={s.colorRow}>
          <input type="color" value={baseColor} onChange={e => setBaseColor(e.target.value)} style={s.colorPick} />
          <input style={{ ...s.input, flex: 1 }} value={baseColor} onChange={e => setBaseColor(e.target.value)} />
        </div>
        <div style={s.chipRow}>
          {SWATCHES.map(c => <button key={'b' + c} onClick={() => setBaseColor(c)} title={c}
            style={{ ...s.swatch, background: c, outline: baseColor.toLowerCase() === c ? '2px solid #3D5A44' : 'none' }} />)}
        </div>
        <label style={s.lbl}>Stroke colour</label>
        <div style={s.colorRow}>
          <input type="color" value={strokeColor} onChange={e => setStrokeColor(e.target.value)} style={s.colorPick} />
          <input style={{ ...s.input, flex: 1 }} value={strokeColor} onChange={e => setStrokeColor(e.target.value)} />
        </div>
        <div style={s.chipRow}>
          {SWATCHES.map(c => <button key={'s' + c} onClick={() => setStrokeColor(c)} title={c}
            style={{ ...s.swatch, background: c, outline: strokeColor.toLowerCase() === c ? '2px solid #3D5A44' : 'none' }} />)}
        </div>

        <div style={s.divider} />
        {FIELDS.map(([key, label, min, max, step]) => (
          <div key={key} style={s.row}>
            <div style={s.rowHead}>
              <span style={s.rowLbl}>{label}</span>
              <span style={s.val}>{Number.isInteger(step) ? Math.round(p[key]) : Number(p[key]).toFixed(3)}</span>
            </div>
            <input type="range" min={min} max={max} step={step} value={p[key]} style={s.slider}
              onChange={e => set(key, +e.target.value)} />
          </div>
        ))}

        <div style={s.divider} />
        <button style={s.snapBtn} onClick={() => setP(DEFAULTS)}>Reset to defaults</button>
        <button style={s.snapBtn} onClick={saveSnapshot}>Save snapshot (PNG)</button>
        <button style={s.snapBtn} onClick={() => setBg(bg === '#EDEAE2' ? '#22252b' : '#EDEAE2')}>Toggle backdrop</button>
        {msg && <div style={s.msg}>{msg}</div>}
      </div>

      <div style={{ ...s.preview, background: bg }}>
        <Canvas shadows camera={{ position: mode === 'wall' ? [0, 0.7, 3.4] : [0, 0, 3.2], fov: 42 }}
          gl={{ toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 0.95, preserveDrawingBuffer: true }}
          onCreated={({ gl }) => { glRef.current = gl; }}>
          <ambientLight intensity={0.7} />
          <directionalLight position={[6, 12, 8]} intensity={1.0} castShadow />
          {/* Raking side lights (low, from the sides) reveal the vertical knife ridges. */}
          <directionalLight position={[-9, 1, 4]} intensity={0.85} />
          <directionalLight position={[9, 0, 3]} intensity={0.5} />
          <Environment preset="apartment" />
          {stamp && (mode === 'wall'
            ? <WallMesh stamp={stamp} p={p} baseColor={baseColor} strokeColor={strokeColor} />
            : <StrokeMesh stamp={stamp} p={p} baseColor={baseColor} strokeColor={strokeColor} />)}
          <OrbitControls enablePan={false} minDistance={2} maxDistance={6} />
        </Canvas>
        {!stamp && <div style={s.loading}>Loading stroke…</div>}
      </div>
    </div>
  );
}

const s = {
  wrap: { display: 'flex', height: 'calc(100vh - 56px)', fontFamily: "'Quicksand', sans-serif" },
  panel: { width: 340, flexShrink: 0, overflowY: 'auto', padding: 20, background: '#fff', borderRight: '1.5px solid #C5D4C8' },
  preview: { flex: 1, minWidth: 0, position: 'relative' },
  title: { fontSize: 18, fontWeight: 700, color: '#3D5A44', marginBottom: 4 },
  hint: { fontSize: 12, color: '#999', marginBottom: 14 },
  lbl: { display: 'block', fontSize: 11, fontWeight: 700, color: '#6B8C74', letterSpacing: 1, textTransform: 'uppercase', margin: '12px 0 6px' },
  input: { padding: '8px 10px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' },
  colorRow: { display: 'flex', gap: 8, alignItems: 'center' },
  colorPick: { width: 44, height: 38, padding: 0, border: '1.5px solid #C5D4C8', borderRadius: 8, background: '#fff', cursor: 'pointer', flexShrink: 0 },
  chipRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 },
  chip: { padding: '6px 14px', borderRadius: 16, border: '1.5px solid #C5D4C8', background: '#fff', fontSize: 13, color: '#3D5A44', cursor: 'pointer', fontFamily: 'inherit' },
  chipOn: { background: '#3D5A44', color: '#fff', borderColor: '#3D5A44' },
  swatch: { width: 26, height: 26, borderRadius: '50%', border: '1.5px solid #C5D4C8', cursor: 'pointer', padding: 0, outlineOffset: 2 },
  divider: { height: 1, background: '#E2E8E3', margin: '16px 0' },
  row: { marginBottom: 10 },
  rowHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  rowLbl: { fontSize: 12, fontWeight: 600, color: '#3D5A44' },
  val: { fontSize: 12, fontWeight: 700, color: '#6B8C74' },
  slider: { width: '100%', accentColor: '#3D5A44' },
  snapBtn: { width: '100%', padding: '9px', borderRadius: 10, border: '1.5px solid #C5D4C8', background: '#fff', color: '#3D5A44', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginBottom: 8 },
  msg: { marginTop: 6, fontSize: 13, fontWeight: 600, color: '#3D5A44' },
  loading: { position: 'absolute', top: 16, left: 16, fontSize: 13, color: '#6B8C74', fontWeight: 600 },
};
