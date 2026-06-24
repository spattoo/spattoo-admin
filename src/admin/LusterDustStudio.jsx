import { useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import * as THREE from 'three';
import { makeLusterDustMaps, LUSTER_DUST_DEFAULTS, LUSTER_DUST_NEW_SPLASH } from '@spattoo/designer';

// Luster Dust Studio — develop the "edible gold powder" look: a fine METALLIC speckle (luster dust)
// FLICKED onto a matte cake wall, like the reference navy-and-gold cake. A real flick isn't an even
// all-over dust nor a circle — it has a dense impact point and sprays OUTWARD along the flick direction
// (a one-sided cone, dense head → thinning tail). And a cake usually has SEVERAL flicks (near the name,
// at the base…). So the look = a LIST of splash points, each {position, direction, spread}, composited
// into one fleck texture. Flecks are a different hue (gold) than the base (navy) — a normal map can't do
// that and a metallic frosting would gild the whole cake — so the fleck mask drives the wall material's
// albedo + metalness + roughness + emissive: shiny metal specks on a matte base. Look-dev tuner (no DB);
// port the generator to spattoo-core once dialled, where each tier carries `dusting.splashes[]` placed
// from the Decorations popup (tap to add a point) — this studio validates that multi-splash model.

const R = 1.0, H = 2.2;                 // tall tier like the reference

const DUST_PRESETS = [
  { label: 'Gold',      color: '#e0b94a' },
  { label: 'Silver',    color: '#cdd2d8' },
  { label: 'Bronze',    color: '#b08d57' },
  { label: 'Rose gold', color: '#e0a899' },
];
const BASE_PRESETS = ['#1c2336', '#15161a', '#3a1c2c', '#1d2e25', '#f0cad6', '#f3efe8'];

function DustCake({ app, splashes, onPlace }) {
  const sig = JSON.stringify({ app, splashes });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const maps = useMemo(() => makeLusterDustMaps({ radius: R, height: H, ...app, splashes }), [sig]);
  return (
    <mesh castShadow receiveShadow key={sig}
      onClick={e => { e.stopPropagation(); if (e.uv) onPlace(e.uv.x, e.uv.y); }}>
      <cylinderGeometry args={[R, R, H, 180, 1]} />
      <meshPhysicalMaterial
        color="#ffffff" map={maps.map}
        metalness={app.metalness} metalnessMap={maps.metalnessMap}
        roughness={1} roughnessMap={maps.roughnessMap}
        normalMap={maps.normalMap} normalScale={[app.glitter, app.glitter]}
        emissive={new THREE.Color(app.dustColor)} emissiveMap={maps.emissiveMap} emissiveIntensity={app.glow}
        clearcoat={app.clearcoat} clearcoatRoughness={0.18}
        envMapIntensity={app.env} />
    </mesh>
  );
}

// The look + material defaults are the single source of truth in core (LUSTER_DUST_DEFAULTS); the
// studio just adds a preview base colour + env (the designer's env comes from its own scene).
const DEFAULT_APP = { baseColor: '#1c2336', env: 0.0, ...LUSTER_DUST_DEFAULTS };
const NEW_SPLASH = { u: 0.25, v: 0.42, ...LUSTER_DUST_NEW_SPLASH };

// Per-splash controls (edit the SELECTED point); global controls (the whole dust appearance).
const SPLASH_SLIDERS = [
  { key: 'dir',    label: 'Flick direction °', min: 0,    max: 360, step: 5 },
  { key: 'spread', label: 'Spread',            min: 0.15, max: 2,   step: 0.05 },
];
const GLOBAL_SLIDERS = [
  { key: 'directionality', label: 'Directionality',  min: 0,    max: 1,   step: 0.05 },
  { key: 'falloff',        label: 'Core tightness',  min: 0.6,  max: 3,   step: 0.1 },
  { key: 'scatter',        label: 'Stray droplets',  min: 0,    max: 0.6, step: 0.02 },
  { key: 'density',        label: 'Density / splash', min: 1,   max: 25,  step: 1 },
  { key: 'fleckSize',      label: 'Fleck size',      min: 1,    max: 6,   step: 0.2 },
  { key: 'sizeVar',        label: 'Size variation',  min: 0,    max: 1,   step: 0.05 },
  { key: 'metalness',      label: 'Metallic',        min: 0,    max: 1,   step: 0.05 },
  { key: 'sparkle',        label: 'Fleck shine',     min: 0.02, max: 0.6, step: 0.01 },
  { key: 'glitter',        label: 'Glitter (twinkle)', min: 0,  max: 1,   step: 0.05 },
  { key: 'glow',           label: 'Luster glow',     min: 0,    max: 0.6, step: 0.02 },
  { key: 'env',            label: 'Reflection',      min: 0,    max: 2.5, step: 0.1 },
  { key: 'clearcoat',      label: 'Clearcoat',       min: 0,    max: 1,   step: 0.05 },
];

function Slider({ sl, value, onChange }) {
  return (
    <div style={s.sliderCard}>
      <div style={s.sliderHead}><span>{sl.label}</span><span style={s.val}>{Number(value).toFixed(sl.step < 1 ? 2 : 0)}</span></div>
      <input type="range" min={sl.min} max={sl.max} step={sl.step} value={value} style={s.slider}
        onChange={e => onChange(+e.target.value)} />
    </div>
  );
}

export default function LusterDustStudio() {
  const [app, setApp] = useState(DEFAULT_APP);
  const [splashes, setSplashes] = useState([{ ...NEW_SPLASH }]);
  const [sel, setSel] = useState(0);
  const glRef = useRef(null);
  const setA = (k, v) => setApp(prev => ({ ...prev, [k]: v }));
  const setSplash = (i, patch) => setSplashes(prev => prev.map((sp, j) => j === i ? { ...sp, ...patch } : sp));

  const addSplash = (u, v) => {
    const base = splashes[sel] ?? NEW_SPLASH;                   // inherit aim/spread of the current point
    setSplashes(prev => { const next = [...prev, { u, v, dir: base.dir, spread: base.spread }]; setSel(next.length - 1); return next; });
  };
  const removeSplash = (i) => setSplashes(prev => { const next = prev.filter((_, j) => j !== i); setSel(s => Math.max(0, Math.min(s, next.length - 1))); return next; });

  const cur = splashes[sel];

  return (
    <div style={s.wrap}>
      <div style={s.panel}>
        <div style={s.title}>Luster Dust Studio</div>

        <div style={s.section}>
          <label style={s.lbl}>Cake colour</label>
          <div style={s.colorRow}>
            <input type="color" value={app.baseColor} onChange={e => setA('baseColor', e.target.value)} style={s.colorPick} />
            <input style={{ ...s.input, flex: 1 }} value={app.baseColor} onChange={e => setA('baseColor', e.target.value)} />
          </div>
          <div style={{ ...s.chipRow, marginTop: 8 }}>
            {BASE_PRESETS.map(c => <button key={c} onClick={() => setA('baseColor', c)} title={c}
              style={{ ...s.swatch, background: c, outline: app.baseColor.toLowerCase() === c ? '2px solid #3D5A44' : 'none' }} />)}
          </div>
        </div>

        <div style={s.section}>
          <label style={s.lbl}>Dust colour</label>
          <div style={s.colorRow}>
            <input type="color" value={app.dustColor} onChange={e => setA('dustColor', e.target.value)} style={s.colorPick} />
            <input style={{ ...s.input, flex: 1 }} value={app.dustColor} onChange={e => setA('dustColor', e.target.value)} />
          </div>
          <div style={{ ...s.chipRow, marginTop: 8 }}>
            {DUST_PRESETS.map(d => <button key={d.color} onClick={() => setA('dustColor', d.color)}
              style={{ ...s.chip, ...(app.dustColor.toLowerCase() === d.color ? s.chipOn : {}) }}>{d.label}</button>)}
          </div>
        </div>

        <div style={s.section}>
          <label style={s.lbl}>Splash points</label>
          <div style={s.hint}>Click the cake to add a splash. Select one to aim it. Direction 90° = upward flick.</div>
          <div style={s.chipRow}>
            {splashes.map((sp, i) => (
              <span key={i} style={{ ...s.splashChip, ...(sel === i ? s.chipOn : {}) }}>
                <button onClick={() => setSel(i)} style={s.splashChipBtn}>Splash {i + 1}</button>
                <button onClick={() => removeSplash(i)} style={s.splashChipX} title="Remove">×</button>
              </span>
            ))}
            {splashes.length === 0 && <span style={s.hint}>No splashes — click the cake to add one.</span>}
          </div>
        </div>

        {cur && (
          <div style={s.section}>
            <div style={s.lbl}>Aim — Splash {sel + 1}</div>
            {SPLASH_SLIDERS.map(sl => <Slider key={sl.key} sl={sl} value={cur[sl.key]} onChange={v => setSplash(sel, { [sl.key]: v })} />)}
          </div>
        )}

        <div style={s.section}>
          <div style={s.lbl}>Dust appearance</div>
          {GLOBAL_SLIDERS.map(sl => <Slider key={sl.key} sl={sl} value={app[sl.key]} onChange={v => setA(sl.key, v)} />)}
        </div>

        <button style={s.resetBtn} onClick={() => { setApp(DEFAULT_APP); setSplashes([{ ...NEW_SPLASH }]); setSel(0); }}>Reset</button>
      </div>

      <div style={s.preview}>
        <Canvas shadows camera={{ position: [0, 0.4, 4.2], fov: 38 }}
          gl={{ toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 0.9, preserveDrawingBuffer: true }}
          onCreated={({ gl }) => { glRef.current = gl; }}>
          <ambientLight intensity={1.2} />
          <directionalLight position={[5, 9, 6]} intensity={0.25} castShadow />
          <directionalLight position={[-5, 3, -3]} intensity={0.15} />
          <Environment preset="studio" />
          <DustCake app={app} splashes={splashes} onPlace={addSplash} />
          <OrbitControls enablePan={false} minDistance={2.6} maxDistance={7} />
        </Canvas>
      </div>
    </div>
  );
}

const s = {
  wrap: { display: 'flex', height: 'calc(100vh - 56px)', fontFamily: "'Quicksand', sans-serif" },
  panel: { width: 340, flexShrink: 0, overflowY: 'auto', padding: 20, background: '#fff', borderRight: '1.5px solid #C5D4C8' },
  preview: { flex: 1, minWidth: 0, background: '#EDEAE2' },
  title: { fontSize: 18, fontWeight: 700, color: '#3D5A44', marginBottom: 16 },
  section: { marginBottom: 18 },
  lbl: { display: 'block', fontSize: 11, fontWeight: 700, color: '#6B8C74', letterSpacing: 1, textTransform: 'uppercase', margin: '10px 0 6px' },
  hint: { fontSize: 12, color: '#8a9a8e', marginBottom: 8, lineHeight: 1.4 },
  input: { padding: '8px 10px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' },
  colorRow: { display: 'flex', gap: 8, alignItems: 'center' },
  colorPick: { width: 44, height: 38, padding: 0, border: '1.5px solid #C5D4C8', borderRadius: 8, background: '#fff', cursor: 'pointer', flexShrink: 0 },
  chipRow: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
  chip: { padding: '5px 12px', borderRadius: 16, border: '1.5px solid #C5D4C8', background: '#fff', fontSize: 13, color: '#3D5A44', cursor: 'pointer', fontFamily: 'inherit' },
  chipOn: { background: '#3D5A44', color: '#fff', borderColor: '#3D5A44' },
  splashChip: { display: 'inline-flex', alignItems: 'center', borderRadius: 16, border: '1.5px solid #C5D4C8', overflow: 'hidden' },
  splashChipBtn: { padding: '5px 8px 5px 12px', border: 'none', background: 'transparent', color: 'inherit', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' },
  splashChipX: { padding: '5px 9px', border: 'none', background: 'transparent', color: 'inherit', fontSize: 15, cursor: 'pointer', fontFamily: 'inherit' },
  swatch: { width: 26, height: 26, borderRadius: '50%', border: '1.5px solid #C5D4C8', cursor: 'pointer', padding: 0, outlineOffset: 2 },
  sliderCard: { border: '1px solid #E2E8E3', borderRadius: 10, padding: '8px 10px', marginBottom: 8 },
  sliderHead: { display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 600, color: '#3D5A44', marginBottom: 4 },
  val: { color: '#6B8C74', fontWeight: 700 },
  slider: { width: '100%', accentColor: '#3D5A44' },
  resetBtn: { width: '100%', padding: '9px', borderRadius: 10, border: '1.5px solid #C5D4C8', background: '#fff', color: '#3D5A44', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
};
