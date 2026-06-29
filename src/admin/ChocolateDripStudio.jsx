import React, { useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import * as THREE from 'three';
// Import the drip generator from the shared package so the studio tunes against the SAME code the
// designer (spattoo-core CakeTier) renders — never a divergent copy.
import { buildDripGeometry, buildDripWeb, DRIP_DEFAULTS } from '@spattoo/designer';
import { getCreamGrainNormalMap } from '../lib/creamWaveTexture.js';
import { fetchElementTypes, createGlobalElement, uploadThumbnail } from '../lib/api.js';

// Scene constants mirror the designer's bottom tier (see PerchCalibrator) so the drip is tuned at the
// same scale customers see: radius 1.2, top at BOARD_H + BOTTOM_H.
const R = 1.2, BOTTOM_H = 1.45, BOARD_H = 0.1, BOARD_R = 1.6;
const TOP_Y = BOARD_H + BOTTOM_H;

// White buttercream wall, with the shared cream micro-grain so it reads as cream, not plastic.
function CakeMesh({ cakeColor }) {
  const grain = useMemo(() => {
    const t = getCreamGrainNormalMap();
    const c = t.clone(); c.wrapS = c.wrapT = THREE.RepeatWrapping; c.repeat.set(8, 8); c.needsUpdate = true;
    return c;
  }, []);
  return (
    <group>
      <mesh position={[0, BOARD_H / 2, 0]}>
        <cylinderGeometry args={[BOARD_R, BOARD_R, BOARD_H, 72]} />
        <meshStandardMaterial color="#d9b44a" metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[0, BOARD_H + BOTTOM_H / 2, 0]}>
        <cylinderGeometry args={[R, R, BOTTOM_H, 96, 1]} />
        <meshStandardMaterial color={cakeColor} roughness={0.9} metalness={0} normalMap={grain} normalScale={new THREE.Vector2(0.3, 0.3)} />
      </mesh>
    </group>
  );
}

// The chocolate pour: flood disc on top + rolled rim bead + the procedural drip tubes, all sharing
// ONE glossy ganache material so they read as a single connected pour.
function ChocolateDrip({ params, color, roughness, lipRadius, flood, web }) {
  // When the web is on, the drip's flared head overlaps well UP into the rounded shoulder (so its top
  // dome hides inside the web and the arches flow into it as one seamless pour).
  const startDrop = web ? Math.max(0, params.webDepth - 0.09) : 0;
  const dripsGeo = useMemo(
    () => buildDripGeometry({ R, topY: TOP_Y, startDrop, ...params }),
    [params.count, params.seed, params.length, params.lengthVar, params.width, params.widthVar, params.protrude, params.flat, params.meander, startDrop],
  );
  const webGeo = useMemo(
    () => buildDripWeb({ R, topY: TOP_Y, ...params }),
    [params.count, params.seed, params.length, params.lengthVar, params.width, params.widthVar, params.webDepth, params.archHeight],
  );
  // Wet ganache: dark-ish albedo, low roughness, clearcoat for the glassy sheen.
  const mat = useMemo(() => new THREE.MeshPhysicalMaterial({
    color, roughness, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.18, envMapIntensity: 1.1,
  }), []);
  // keep the live material in sync without rebuilding
  mat.color.set(color); mat.roughness = roughness;

  return (
    <group>
      {flood && (
        <mesh position={[0, TOP_Y + 0.012, 0]} material={mat}>
          <cylinderGeometry args={[R, R, 0.03, 96]} />
        </mesh>
      )}
      {/* rolled rim bead — torus lies in XY, rotate flat into XZ around the rim */}
      <mesh position={[0, TOP_Y, 0]} rotation={[Math.PI / 2, 0, 0]} material={mat}>
        <torusGeometry args={[R, lipRadius, 16, 96]} />
      </mesh>
      {web && <mesh geometry={webGeo} material={mat} />}
      <mesh geometry={dripsGeo} material={mat} />
    </group>
  );
}

const S = {
  page: { minHeight: '100vh', background: '#EDEAE2', fontFamily: 'Quicksand, sans-serif', padding: '28px 24px' },
  title: { fontSize: 22, fontWeight: 800, color: '#2C4433' },
  sub: { fontSize: 13, color: '#7A8F80', marginBottom: 18 },
  layout: { display: 'grid', gridTemplateColumns: '320px minmax(0,1fr)', gap: 20, maxWidth: 1300, alignItems: 'start' },
  card: { background: '#fff', borderRadius: 18, border: '1.5px solid #C5D4C8', padding: 22 },
  label: { fontSize: 11, fontWeight: 800, color: '#3D5A44', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6, display: 'block' },
  row: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 },
  rowLabel: { fontSize: 12, fontWeight: 700, color: '#3D5A44', minWidth: 86 },
  val: { fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 46, textAlign: 'right' },
  btn: { marginTop: 12, padding: '10px 14px', borderRadius: 8, border: 'none', background: '#3D5A44', color: '#fff', fontFamily: 'Quicksand, sans-serif', fontSize: 13, fontWeight: 700, cursor: 'pointer', width: '100%' },
  ghost: { marginTop: 8, padding: '8px 14px', borderRadius: 8, border: '1.5px solid #C5D4C8', background: '#fff', color: '#3D5A44', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, cursor: 'pointer', width: '100%' },
  hint: { fontSize: 11, color: '#9BB5A2', marginTop: 6, lineHeight: 1.5 },
  swatchRow: { display: 'flex', gap: 8, marginBottom: 8 },
  colorInput: { width: 44, height: 32, padding: 0, border: '1.5px solid #C5D4C8', borderRadius: 8, background: '#fff', cursor: 'pointer' },
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

const CHOC_PRESETS = ['#3a2117', '#5b3a21', '#1b1b1b', '#7a4a2b', '#d9c7a0'];

export default function ChocolateDripStudio() {
  const [count, setCount]         = useState(DRIP_DEFAULTS.count);
  const [length, setLength]       = useState(DRIP_DEFAULTS.length);
  const [lengthVar, setLengthVar] = useState(DRIP_DEFAULTS.lengthVar);
  const [width, setWidth]         = useState(DRIP_DEFAULTS.width);
  const [widthVar, setWidthVar]   = useState(DRIP_DEFAULTS.widthVar);
  const [protrude, setProtrude]   = useState(DRIP_DEFAULTS.protrude);
  const [flat, setFlat]           = useState(DRIP_DEFAULTS.flat);
  const [meander, setMeander]     = useState(DRIP_DEFAULTS.meander);
  const [webDepth, setWebDepth]   = useState(DRIP_DEFAULTS.webDepth);
  const [archHeight, setArch]     = useState(DRIP_DEFAULTS.archHeight);
  const [seed, setSeed]           = useState(DRIP_DEFAULTS.seed);

  const [color, setColor]         = useState('#3a2117');
  const [roughness, setRoughness] = useState(0.2);
  const [lipRadius, setLipRadius] = useState(0.05);
  const [flood, setFlood]         = useState(true);
  const [web, setWeb]             = useState(true);
  const [cakeColor, setCakeColor] = useState('#f4efe9');

  const params = { count, seed, length, lengthVar, width, widthVar, protrude, flat, meander, webDepth, archHeight };

  const [saveName, setSaveName] = useState('Chocolate Drip');
  const [busy, setBusy]         = useState(false);
  const [msg, setMsg]           = useState(null);
  const canvasWrapRef           = useRef(null);

  function copyJson() {
    const json = { drip: { ...params, color, roughness: +roughness.toFixed(2), lip_radius: +lipRadius.toFixed(3), flood } };
    navigator.clipboard?.writeText(JSON.stringify(json, null, 2));
  }

  // The studio's "Gloss" slider is a raw roughness (0.05 wet … 0.6 matte). The designer's chocolate
  // material takes gloss 0..1 (1 = wettest), so invert it for the saved default.
  const studioGloss = Math.max(0, Math.min(1, (0.5 - roughness) / 0.42));

  // The authored geometry bundle the designer reads from placement_config.top_drip_config. `length`
  // here is the BASE run; the customer's Length dial multiplies it. Material/colour are NOT geometry.
  function dripConfigBundle() {
    return {
      count, width, widthVar, length, lengthVar, protrude, flat, meander,
      webDepth, archHeight, lipRadius, seed,
    };
  }

  async function captureThumbnail() {
    const cnv = canvasWrapRef.current?.querySelector('canvas');
    if (!cnv) return null;
    const blob = await new Promise(res => cnv.toBlob(res, 'image/png'));
    if (!blob) return null;
    return uploadThumbnail('elements/thumbnails', blob);
  }

  // Author the drip as a file-less master-data element (cake_elements) under the "Drip" type, with the
  // tuned geometry in placement_config. The designer picks it up via seed-in-code defaults + this row.
  async function saveAsElement() {
    if (!saveName.trim()) { setMsg({ ok: false, text: 'Give the element a name.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const types = await fetchElementTypes();
      const dripType = (types ?? []).find(t => t.slug === 'drip' || (t.name ?? '').trim().toLowerCase() === 'drip');
      if (!dripType) throw new Error('No "Drip" element type found — create it first.');
      let thumbnail_url = null;
      try { thumbnail_url = await captureThumbnail(); } catch { /* thumbnail is best-effort */ }
      const placement_config = {
        top_drip: true,
        top_arrangements_allowed: ['ring'],
        top_drip_gloss:  +studioGloss.toFixed(2),
        top_drip_length: 1,
        top_drip_flood:  flood,
        top_drip_config: dripConfigBundle(),
      };
      await createGlobalElement({
        name: saveName.trim(),
        element_type_id: dripType.id,
        allowed_zones: ['rim'],
        default_color: color,
        image_url: null,
        thumbnail_url,
        placement_config,
      });
      setMsg({ ok: true, text: `Saved "${saveName.trim()}" — pick it from Decorations in the designer.` });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally { setBusy(false); }
  }

  return (
    <div style={S.page}>
      <div style={S.title}>Chocolate Drip Studio</div>
      <div style={S.sub}>Dial in a glossy ganache drip on a real cake before porting to core. Drag to orbit; reroll for a fresh drip pattern.</div>
      <div style={S.layout}>
        <div style={S.card}>
          <label style={S.label}>Chocolate colour</label>
          <div style={S.swatchRow}>
            <input type="color" value={color} onChange={e => setColor(e.target.value)} style={S.colorInput} />
            {CHOC_PRESETS.map(c => (
              <button key={c} onClick={() => setColor(c)} title={c}
                style={{ width: 28, height: 32, border: color === c ? '2px solid #3D5A44' : '1.5px solid #C5D4C8', borderRadius: 8, background: c, cursor: 'pointer' }} />
            ))}
          </div>

          <div style={{ marginTop: 14 }}>
            <Slider label="Drips"      value={count}     min={6}    max={48}   step={1}     onChange={setCount}     fmt={v => v} />
            <Slider label="Width"      value={width}     min={0.02} max={0.12} step={0.005} onChange={setWidth}     fmt={v => v.toFixed(3)} />
            <Slider label="Width var"  value={widthVar}  min={0}    max={1}    step={0.05}  onChange={setWidthVar}  fmt={v => v.toFixed(2)} />
            <Slider label="Length"     value={length}    min={0.15} max={1.1}  step={0.01}  onChange={setLength}    fmt={v => v.toFixed(2)} />
            <Slider label="Length var" value={lengthVar} min={0}    max={1}    step={0.05}  onChange={setLengthVar} fmt={v => v.toFixed(2)} />
            <Slider label="Meander"    value={meander}   min={0}    max={0.4}  step={0.01}  onChange={setMeander}   fmt={v => v.toFixed(2)} />
            <Slider label="Protrude"   value={protrude}  min={0}    max={0.05} step={0.002} onChange={setProtrude}  fmt={v => v.toFixed(3)} />
            <Slider label="Flatten"    value={flat}      min={0.3}  max={1}    step={0.05}  onChange={setFlat}      fmt={v => v.toFixed(2)} />
            <Slider label="Rim bead"   value={lipRadius} min={0.02} max={0.12} step={0.005} onChange={setLipRadius} fmt={v => v.toFixed(3)} />
            <Slider label="Web depth"  value={webDepth}  min={0.04} max={0.3}  step={0.005} onChange={setWebDepth}  fmt={v => v.toFixed(3)} />
            <Slider label="Arch"       value={archHeight} min={0}   max={0.28} step={0.005} onChange={setArch}      fmt={v => v.toFixed(3)} />
            <Slider label="Gloss"      value={roughness} min={0.05} max={0.6}  step={0.01}  onChange={setRoughness} fmt={v => v.toFixed(2)} />
          </div>

          <div style={S.row}>
            <span style={{ ...S.rowLabel, minWidth: 0 }}>Flood top</span>
            <input type="checkbox" checked={flood} onChange={e => setFlood(e.target.checked)} style={{ accentColor: '#3D5A44', width: 18, height: 18 }} />
            <span style={{ ...S.rowLabel, minWidth: 0, marginLeft: 8 }}>Web</span>
            <input type="checkbox" checked={web} onChange={e => setWeb(e.target.checked)} style={{ accentColor: '#3D5A44', width: 18, height: 18 }} />
            <div style={{ flex: 1 }} />
            <span style={{ ...S.rowLabel, minWidth: 0 }}>Cake</span>
            <input type="color" value={cakeColor} onChange={e => setCakeColor(e.target.value)} style={{ ...S.colorInput, width: 32 }} />
          </div>

          <button style={S.btn} onClick={() => setSeed(s => s + 1)}>Reroll drip pattern</button>
          <button style={S.ghost} onClick={copyJson}>Copy JSON</button>

          <div style={{ marginTop: 14, borderTop: '1px solid #E3EAE5', paddingTop: 12 }}>
            <label style={S.label}>Save as Drip element</label>
            <input value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="Element name"
              style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontSize: 13, fontFamily: 'Quicksand, sans-serif', color: '#2C4433', boxSizing: 'border-box' }} />
            <button style={{ ...S.btn, opacity: busy ? 0.6 : 1 }} onClick={saveAsElement} disabled={busy}>
              {busy ? 'Saving…' : 'Save to library'}
            </button>
            {msg && <div style={{ ...S.hint, color: msg.ok ? '#2C7A3F' : '#C0392B', fontWeight: 700 }}>{msg.text}</div>}
            <div style={S.hint}>Saves the tuned drip as a file-less element under the “Drip” type (rim only). Customers control colour, length and gloss; the rest is baked here.</div>
          </div>
        </div>

        <div style={{ ...S.card, padding: 0, overflow: 'hidden' }} ref={canvasWrapRef}>
          <div style={{ height: 600, background: '#E8EDE9' }}>
            <Canvas gl={{ preserveDrawingBuffer: true, alpha: true }} camera={{ position: [0, 1.9, 5], fov: 40 }}>
              <ambientLight intensity={0.5} />
              <directionalLight position={[3, 5, 4]} intensity={1.3} />
              <directionalLight position={[-4, 2, -3]} intensity={0.5} />
              <Environment preset="studio" />
              <CakeMesh cakeColor={cakeColor} />
              <ChocolateDrip params={params} color={color} roughness={roughness} lipRadius={lipRadius} flood={flood} web={web} />
              <OrbitControls target={[0, 1.2, 0]} makeDefault enablePan />
            </Canvas>
          </div>
        </div>
      </div>
    </div>
  );
}
