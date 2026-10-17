import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { fetchAllElements, updateGlobalElement } from '../lib/api.js';

// Cake + sticker constants DUPLICATED from spattoo-core (constants.js) on purpose — the calibrator
// must seat the figure with the SAME math the designer uses so calibration == what customers see.
const STICKER_SIZE = 0.28;
const TIER_RADII = [1.2, 0.9, 0.65, 0.45];
const BOTTOM_H = 1.45, TIER_STEP = 0.08, BOARD_H = 0.1, BOARD_R = 1.6;
const DEG = Math.PI / 180;

let _loader = null;
function loader() {
  if (!_loader) _loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  return _loader;
}

// A single bottom-tier cake (calibration is tier-relative, so one tier is enough).
function CakeMesh() {
  const topY = BOARD_H + BOTTOM_H;
  return (
    <group>
      <mesh position={[0, BOARD_H / 2, 0]}>
        <cylinderGeometry args={[BOARD_R, BOARD_R, BOARD_H, 72]} />
        <meshStandardMaterial color="#d9b44a" metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[0, BOARD_H + BOTTOM_H / 2, 0]}>
        <cylinderGeometry args={[TIER_RADII[0], TIER_RADII[0], BOTTOM_H, 72]} />
        <meshStandardMaterial color="#f6d7e0" roughness={0.9} metalness={0} />
      </mesh>
      {/* a faint marker line at the front edge where the figure perches */}
      <mesh position={[0, topY + 0.001, TIER_RADII[0]]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.02, 0.04, 16]} />
        <meshBasicMaterial color="#888" transparent opacity={0.4} />
      </mesh>
    </group>
  );
}

// Perched figure — mirrors spattoo-core DraggableTopSticker(perch) + StickerModel:
// facing is baked as a Y-rotation; the model is normalised to STICKER_SIZE and centred; the group is
// placed at the front edge, centre AT the tier top (+ seat y_offset), tilted about X, scaled by r.
function PerchedFigure({ scene, facingDeg, tiltDeg, yOffset, edgeInset, size, anchor = 0.5 }) {
  const { faced, sc, center, halfH } = useMemo(() => {
    if (!scene) return { faced: null };
    const f = scene.clone(true);
    f.updateMatrixWorld(true);
    // bake facing (Y rotation) into geometry, like baseRotation in StickerModel
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0, facingDeg * DEG, 0));
    f.traverse(o => { if (o.isMesh && o.geometry) { o.geometry = o.geometry.clone(); o.geometry.applyMatrix4(o.matrixWorld.clone().premultiply(m)); o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1); o.updateMatrix(); } });
    const box = new THREE.Box3().setFromObject(f);
    const size3 = new THREE.Vector3(); box.getSize(size3);
    const ctr = new THREE.Vector3(); box.getCenter(ctr);
    const s = STICKER_SIZE / Math.max(size3.x, size3.y, size3.z, 0.01);
    // `halfH` is the model's own half-HEIGHT once normalised — core's `seatHalf`, same formula.
    // Half of STICKER_SIZE would only be right for a model whose height is its longest axis.
    return { faced: f, sc: s, center: ctr, halfH: (size3.y * s) / 2 };
  }, [scene, facingDeg]);

  if (!faced) return null;
  const topY = BOARD_H + BOTTOM_H;            // bottom tier top
  /* ⚠️ THE SAME LINE CORE USES, or this screen calibrates a pose nobody will see. A model of
     height 2·halfH touching the rim at fraction f of that height measured from the TOP sits with
     its centre at halfH·(2f − 1): −halfH at f=0 (top on the lip), 0 at f=0.5 (the middle — what
     this preview used to hardcode), +halfH at f=1 (standing on its base). */
  const py = topY + yOffset + halfH * (2 * anchor - 1) * size;
  const pz = TIER_RADII[0] - edgeInset;       // inset from the front rim
  return (
    <group position={[0, py, pz]} scale={size}>
      <group rotation={[-(tiltDeg * DEG), 0, 0]}>
        <group position={[-center.x * sc, -center.y * sc, -center.z * sc]}>
          <group scale={sc}><primitive object={faced} /></group>
        </group>
      </group>
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
  select: { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontSize: 13, fontFamily: 'Quicksand, sans-serif', background: '#fff', color: '#2C4433' },
  row: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 },
  rowLabel: { fontSize: 12, fontWeight: 700, color: '#3D5A44', minWidth: 78 },
  val: { fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 46, textAlign: 'right' },
  btn: { marginTop: 12, padding: '10px 14px', borderRadius: 8, border: 'none', background: '#3D5A44', color: '#fff', fontFamily: 'Quicksand, sans-serif', fontSize: 13, fontWeight: 700, cursor: 'pointer', width: '100%' },
  ghost: { marginTop: 8, padding: '8px 14px', borderRadius: 8, border: '1.5px solid #C5D4C8', background: '#fff', color: '#3D5A44', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, cursor: 'pointer', width: '100%' },
  hint: { fontSize: 11, color: '#9BB5A2', marginTop: 6, lineHeight: 1.5 },
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

export default function PerchCalibrator() {
  const [elements, setElements] = useState([]);
  const [elementId, setElementId] = useState('');
  const [scene, setScene] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const [facingDeg, setFacingDeg] = useState(180);
  const [tiltDeg, setTiltDeg] = useState(0);
  const [yOffset, setYOffset] = useState(0);
  const [edgeInset, setEdgeInset] = useState(0);
  /* Where ALONG the model the rim line touches it, as a fraction of its height from the TOP.
     0.5 (the middle) is what a perch has always done. ⚠️ A FIGURE'S CONTACT POINT IS NOT
     ALWAYS ITS FEET: the catalogue doll is modelled SITTING, so she belongs on the rim by her
     SEAT with her legs hanging down the outside, and her lowest geometry rests on nothing.
     A fraction says that and holds at every size, where a height nudge is right at one. */
  const [anchor, setAnchor] = useState(0.5);
  const [size, setSize] = useState(2.5);

  const selected = elements.find(e => e.id === elementId) ?? null;

  // Load GLB elements (figurines) the admin can perch.
  useEffect(() => {
    fetchAllElements()
      .then(all => setElements((all ?? []).filter(e => /\.(glb|gltf)(\?|$)/i.test(e.image_url ?? ''))))
      .catch(e => setMsg({ ok: false, text: `Could not load elements: ${e.message}` }));
  }, []);

  // When an element is picked, load its GLB and seed the controls from any existing perch config.
  useEffect(() => {
    if (!selected) { setScene(null); return; }
    const pc = selected.placement_config ?? {};
    const perch = pc.perch ?? {};
    setFacingDeg(Array.isArray(pc.rotation) ? (pc.rotation[1] ?? 180) : 180);
    setTiltDeg(perch.tilt_deg ?? 0);
    setYOffset(perch.y_offset ?? 0);
    setEdgeInset(perch.edge_inset ?? 0);
    setAnchor(perch.anchor ?? 0.5);
    setSize(pc.r ?? 2.5);
    setBusy(true); setMsg(null);
    loader().loadAsync(selected.image_url)
      .then(gltf => setScene(gltf.scene))
      .catch(e => setMsg({ ok: false, text: `GLB load failed: ${e.message}` }))
      .finally(() => setBusy(false));
  }, [elementId]);

  function buildPlacementConfig() {
    const existing = selected?.placement_config ?? {};
    return {
      ...existing,
      rim: 'perch',
      r: +size.toFixed(2),
      rotation: [0, Math.round(facingDeg), 0],
      rotation_unit: 'deg',
      /* ⚠️ SPREAD THE EXISTING PERCH, DO NOT REPLACE IT. This object used to be written from the
         three fields below and nothing else, so every other key on `perch` was destroyed by a save
         from this screen — `seat` (which decides whether a figure stands on the rim or straddles
         it) and `foot` (which decides whether it stands on its measured feet or on the centre of
         its bounding box) are both authored in Manage Elements, and both would vanish the next
         time anyone touched a slider here. The failure is silent and the screen looks right: the
         figure only moves later, on a cake. Same family as the verge read-back that rewrote an
         unknown seat to 'center' merely by opening the row. */
      perch: { ...(existing.perch ?? {}), anchor: +anchor.toFixed(2),
               tilt_deg: +tiltDeg.toFixed(1), y_offset: +yOffset.toFixed(2), edge_inset: +edgeInset.toFixed(2) },
    };
  }

  async function handleSave() {
    if (!selected) return;
    setBusy(true); setMsg(null);
    try {
      const allowed = Array.from(new Set([...(selected.allowed_zones ?? []), 'rim']));
      await updateGlobalElement(selected.id, { allowed_zones: allowed, placement_config: buildPlacementConfig() });
      setMsg({ ok: true, text: 'Saved perch calibration to the element.' });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  }

  return (
    <div style={S.page}>
      <div style={S.title}>Perch Calibrator</div>
      <div style={S.sub}>Seat a figurine on the cake edge, then save the pose to the element. Values are tier-relative, so it perches correctly on any tier's rim.</div>
      <div style={S.layout}>
        <div style={S.card}>
          <label style={S.label}>Element</label>
          <select style={S.select} value={elementId} onChange={e => setElementId(e.target.value)}>
            <option value="">Select a GLB element…</option>
            {elements.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>

          {selected && (
            <div style={{ marginTop: 18 }}>
              <Slider label="Facing"   value={facingDeg} min={-180} max={180} step={1}    onChange={setFacingDeg} fmt={v => `${v}°`} />
              <Slider label="Tilt"     value={tiltDeg}   min={-45}  max={45}  step={1}    onChange={setTiltDeg}   fmt={v => `${v}°`} />
              <Slider label="Height"   value={yOffset}   min={-1}   max={1}   step={0.01} onChange={setYOffset}   fmt={v => v.toFixed(2)} />
              <Slider label="Sits at"  value={anchor}    min={0}    max={1}   step={0.01} onChange={setAnchor}    fmt={v => v.toFixed(2)} />
              <Slider label="Edge in"  value={edgeInset} min={-0.3} max={0.8} step={0.01} onChange={setEdgeInset} fmt={v => v.toFixed(2)} />
              <Slider label="Size"     value={size}      min={0.5}  max={10}  step={0.1}  onChange={setSize}      fmt={v => v.toFixed(1)} />
              <div style={S.hint}>Facing turns it to look outward; <b>Sits at</b> is WHERE on the model the rim touches it — 0 is its top, 0.5 its middle, 1 its base — so a figure modelled sitting rests on its seat with its legs hanging below the lip; Height nudges it after that; Edge in tucks it back from the rim; Tilt leans it. ⚠️ Prefer “Sits at” over “Height”: a fraction is a statement about the model and holds at every size, while a nudge is a world distance that is right at one size and wrong at the rest.</div>
              <button style={S.btn} onClick={handleSave} disabled={busy}>{busy ? 'Working…' : 'Save to element'}</button>
              <button style={S.ghost} onClick={() => { navigator.clipboard?.writeText(JSON.stringify(buildPlacementConfig(), null, 2)); setMsg({ ok: true, text: 'placement_config copied.' }); }}>Copy JSON</button>
              {msg && <div style={{ ...S.hint, color: msg.ok ? '#2C7A3F' : '#C0392B', fontWeight: 700 }}>{msg.text}</div>}
            </div>
          )}
          {!selected && msg && <div style={{ ...S.hint, color: msg.ok ? '#2C7A3F' : '#C0392B', fontWeight: 700 }}>{msg.text}</div>}
        </div>

        <div style={{ ...S.card, padding: 0, overflow: 'hidden' }}>
          <div style={{ height: 560, background: '#E8EDE9' }}>
            <Canvas gl={{ preserveDrawingBuffer: true, alpha: true }} camera={{ position: [0, 1.6, 5], fov: 40 }}>
              <ambientLight intensity={0.55} />
              <directionalLight position={[3, 5, 4]} intensity={1.3} />
              <directionalLight position={[-4, 2, -3]} intensity={0.5} />
              <Environment preset="studio" />
              <CakeMesh />
              {scene && <PerchedFigure scene={scene} facingDeg={facingDeg} tiltDeg={tiltDeg} yOffset={yOffset} edgeInset={edgeInset} size={size} anchor={anchor} />}
              <OrbitControls target={[0, 1.4, 0]} makeDefault enablePan />
            </Canvas>
          </div>
        </div>
      </div>
    </div>
  );
}
