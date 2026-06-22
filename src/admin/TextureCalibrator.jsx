import { useState, useMemo, useEffect, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import * as THREE from 'three';
import { CREAM_STYLES, STYLE_ORDER, buildStyledWall, getRusticNormalMap, loadStrokeMaps, displaceByHeightField } from '@spattoo/designer';
import { fetchAdminTextures, createTexture, updateTexture } from '../lib/api.js';

// Surface-map generators (normal-map finishes like rustic) — keyed like the designer's registry.
const SURFACE_MAPS = { rustic: getRusticNormalMap };

// Local test asset: a real palette-knife reference, converted to a normal map in-browser. (Later this
// becomes a baker-uploaded R2 image; this proves the image→relief approach before we wire uploads.)
const LOCAL_REF_URL = '/rustic-ref.png';

// Texture calibrator — author the DB config for cream "style" finishes (wave/swirl/rustic). Previews
// with the SAME buildStyledWall the designer renders, so what you tune is what customers see. Saves
// config.params = [{ key, label, min, max, step, default, user }] to cake_textures (the placement_config
// analog for the cake base). The algorithm (displacement strategy) stays in code; this tunes its params.

const R = 1, H = 1.4;
const ALGORITHMS = STYLE_ORDER.filter(k => k !== 'smooth');   // textures with a displacement strategy

// A fresh working copy seeded from the in-code registry for a style. A style is EITHER a geometry
// `wall` (wave/swirl/ribbed) or a normal-map `surfaceMap` (rustic).
function seedFor(styleKey) {
  const def = CREAM_STYLES[styleKey] ?? {};
  return {
    id: null,
    key: styleKey,
    label: def.label ?? styleKey,
    wall: def.wall ?? 'smooth',
    surfaceMap: def.surfaceMap ?? null,
    params: (def.params ?? []).map(p => ({ ...p })),
  };
}

function tile(tex, rx, ry) {
  const t = tex.clone();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.needsUpdate = true;
  return t;
}

// Reproducible seeded RNG for decal layout.
function rng(seed) { let s = seed; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }

// Scattered palette-knife stroke DECALS on the cake wall (the real "coloured strokes on a smooth
// base" look from the reference). Each decal = a plane using the real stroke as an alpha mask (stroke
// opaque, background transparent), tinted `color`, with the stroke's normal map for relief, sat just
// proud of the wall at a jittered angle/height/rotation/size.
function StrokeDecals({ maps, color, depth, count, seed }) {
  const decals = useMemo(() => {
    const r = rng(seed);
    return Array.from({ length: count }, () => ({
      theta: r() * Math.PI * 2,
      y: (r() - 0.5) * H * 0.82,
      rot: (r() - 0.5) * 1.0,
      scale: 0.42 + r() * 0.36,
    }));
  }, [count, seed]);
  const ASPECT = 0.66;   // stroke width:height
  return decals.map((dcl, i) => (
    <group key={i} rotation={[0, dcl.theta, 0]}>
      <mesh position={[0, dcl.y, R + 0.012]} rotation={[0, 0, dcl.rot]} scale={[dcl.scale * ASPECT, dcl.scale, 1]} castShadow>
        <planeGeometry args={[1, 1, 100, 100]} />
        <meshPhysicalMaterial color={color} roughness={0.3} metalness={0}
          clearcoat={0.45} clearcoatRoughness={0.25}
          map={maps.valueMap}
          alphaMap={maps.coverageMap} alphaTest={0.5}
          displacementMap={maps.coverageMap} displacementScale={depth * 0.1} displacementBias={0}
          normalMap={maps.normalMap} normalScale={[depth * 0.6, -depth * 0.6]} side={THREE.DoubleSide} />
      </mesh>
    </group>
  ));
}

function PreviewMesh({ work, overrideMaps }) {
  const sig = work.params.map(p => p.default).join(',') + '|' + work.wall + '|' + work.surfaceMap;
  const defaults = useMemo(() => {
    const o = {}; for (const p of work.params) o[p.key] = p.default; return o;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  // Heavy geometry/normal for the wave/swirl/procedural cases (unused in the decal case).
  const built = useMemo(() => {
    const d = (defaults.scale ?? 9) / 9;
    const rx = Math.max(1, Math.round(7 * d)), ry = Math.max(1, Math.round(5 * d));
    if (work.surfaceMap && SURFACE_MAPS[work.surfaceMap]) return { nrm: tile(SURFACE_MAPS[work.surfaceMap](), rx, ry) };
    return { geo: buildStyledWall(work.wall, R, H, defaults) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // Image-derived rustic = real stroke decals scattered on a smooth base (matches Image #28).
  if (work.surfaceMap && overrideMaps?.displacementMap) {
    const count = Math.max(4, Math.round((defaults.scale ?? 9) * 1.6));
    return (
      <group>
        <mesh castShadow receiveShadow>
          <cylinderGeometry args={[R, R, H, 96, 1]} />
          <meshStandardMaterial color="#f3ece2" roughness={0.5} metalness={0} />
        </mesh>
        <StrokeDecals maps={overrideMaps} color="#d62828" depth={defaults.depth ?? 1} count={count} seed={12345} />
      </group>
    );
  }

  return (
    <mesh key={work.wall + (work.surfaceMap || '')} castShadow>
      {built.geo ? <primitive object={built.geo} attach="geometry" /> : <cylinderGeometry args={[R, R, H, 128, 1]} />}
      <meshPhysicalMaterial color="#f0cad6" roughness={0.55} metalness={0}
        sheen={0.5} sheenRoughness={0.6} sheenColor="#fff6e8" clearcoat={0.12} clearcoatRoughness={0.5}
        normalMap={built.nrm ?? null} normalScale={[defaults.depth ?? 0.5, defaults.depth ?? 0.5]} />
    </mesh>
  );
}

export default function TextureCalibrator() {
  const [rows, setRows] = useState([]);
  const [work, setWork] = useState(() => seedFor('wave'));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [useRefImage, setUseRefImage] = useState(false);
  const [refMaps, setRefMaps] = useState(null);
  const glRef = useRef(null);

  // Snapshot the live preview → POST to the dev server, which writes it to .snapshots/ in the project
  // (readable by tooling; ~/Downloads is blocked by macOS). Lets the texture be reviewed from the real
  // render, not guessed at.
  async function saveSnapshot() {
    const gl = glRef.current;
    if (!gl) return;
    try {
      const dataUrl = gl.domElement.toDataURL('image/png');
      await fetch('/__snapshot', { method: 'POST', body: dataUrl });
      setMsg({ ok: true, text: 'Snapshot saved to .snapshots/rustic-snapshot.png' });
    } catch (e) {
      setMsg({ ok: false, text: 'Snapshot failed: ' + e.message });
    }
  }

  // Preload the local reference → displacement + normal maps (once). Background flood-filled to flat;
  // stroke body domed (base) with glossy ridges raised.
  useEffect(() => {
    // Load the RAW single stroke (no stamping) — each decal IS one stroke, placed on the cake.
    // displacementMap doubles as the alpha mask (stroke = opaque, background = transparent).
    loadStrokeMaps(LOCAL_REF_URL, { strength: 1.6, blur: 0, bgMode: 'luminance' })
      .then(setRefMaps).catch(() => {});
  }, []);

  useEffect(() => { fetchAdminTextures().then(setRows).catch(() => {}); }, []);

  function loadRow(row) {
    setWork({
      id: row.id,
      key: row.key,
      label: row.label,
      wall: row.algorithm ?? 'smooth',
      surfaceMap: row.config?.surfaceMap ?? null,
      params: Array.isArray(row.config?.params) ? row.config.params.map(p => ({ ...p })) : [],
    });
    setMsg(null);
  }

  function setParam(i, patch) {
    setWork(w => ({ ...w, params: w.params.map((p, j) => j === i ? { ...p, ...patch } : p) }));
  }

  async function handleSave() {
    if (!work.key.trim() || !work.label.trim()) {
      setMsg({ ok: false, text: 'Key and label are required.' });
      return;
    }
    setSaving(true); setMsg(null);
    try {
      const payload = {
        key: work.key.trim(), label: work.label.trim(),
        algorithm: work.wall || 'smooth',
        config: { params: work.params, ...(work.surfaceMap ? { surfaceMap: work.surfaceMap } : {}) },
      };
      const saved = work.id ? await updateTexture(work.id, payload) : await createTexture(payload);
      setWork(w => ({ ...w, id: saved.id }));
      setRows(await fetchAdminTextures());
      setMsg({ ok: true, text: 'Saved.' });
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={s.wrap}>
      {/* ── Controls ── */}
      <div style={s.panel}>
        <div style={s.title}>Texture Calibrator</div>

        <div style={s.section}>
          <label style={s.lbl}>Edit existing</label>
          <select style={s.input} value={work.id ?? ''} onChange={e => {
            const row = rows.find(r => r.id === e.target.value);
            if (row) loadRow(row);
          }}>
            <option value="">— select a saved texture —</option>
            {rows.map(r => <option key={r.id} value={r.id}>{r.label} ({r.key})</option>)}
          </select>
        </div>

        <div style={s.section}>
          <label style={s.lbl}>New from algorithm</label>
          <div style={s.chipRow}>
            {ALGORITHMS.map(a => (
              <button key={a} style={{ ...s.chip, ...(!work.id && work.key === a ? s.chipOn : {}) }}
                onClick={() => { setWork(seedFor(a)); setMsg(null); }}>{a}</button>
            ))}
          </div>
        </div>

        <div style={s.section}>
          <label style={s.lbl}>Key</label>
          <input style={s.input} value={work.key} onChange={e => setWork(w => ({ ...w, key: e.target.value }))} />
          <label style={s.lbl}>Label</label>
          <input style={s.input} value={work.label} onChange={e => setWork(w => ({ ...w, label: e.target.value }))} />
          <label style={s.lbl}>Strategy (code)</label>
          <input style={{ ...s.input, color: '#888' }}
            value={work.surfaceMap ? `${work.surfaceMap} (normal map)` : work.wall} readOnly />
          {work.surfaceMap && (
            <label style={{ ...s.userToggle, marginTop: 10, marginLeft: 0 }}>
              <input type="checkbox" checked={useRefImage} onChange={e => setUseRefImage(e.target.checked)} />
              <span>Use reference image (local test){refMaps ? '' : ' — loading…'}</span>
            </label>
          )}
        </div>

        <div style={s.section}>
          <div style={s.lbl}>Parameters</div>
          {work.params.length === 0 && <div style={s.hint}>This algorithm has no tunable params.</div>}
          {work.params.map((p, i) => (
            <div key={p.key} style={s.paramCard}>
              <div style={s.paramHead}>
                <input style={s.paramLabel} value={p.label} onChange={e => setParam(i, { label: e.target.value })} />
                <span style={s.code}>{p.key}</span>
              </div>
              <div style={s.sliderRow}>
                <input type="range" min={p.min} max={p.max} step={p.step} value={p.default}
                  style={s.slider} onChange={e => setParam(i, { default: +e.target.value })} />
                <span style={s.val}>{Number.isInteger(p.step) ? Math.round(p.default) : Number(p.default).toFixed(3)}</span>
              </div>
              <div style={s.metaRow}>
                {['min', 'max', 'step'].map(k => (
                  <label key={k} style={s.metaField}>
                    <span style={s.metaLbl}>{k}</span>
                    <input type="number" step="any" value={p[k]} style={s.num}
                      onChange={e => setParam(i, { [k]: +e.target.value })} />
                  </label>
                ))}
                <label style={s.userToggle}>
                  <input type="checkbox" checked={!!p.user} onChange={e => setParam(i, { user: e.target.checked })} />
                  <span>customer</span>
                </label>
              </div>
            </div>
          ))}
        </div>

        <button style={s.saveBtn(saving)} onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : work.id ? 'Update texture' : 'Create texture'}
        </button>
        <button style={s.snapBtn} onClick={saveSnapshot}>Save snapshot (PNG)</button>
        {msg && <div style={{ ...s.msg, color: msg.ok ? '#3D5A44' : '#b23' }}>{msg.text}</div>}
      </div>

      {/* ── Live preview ── */}
      <div style={s.preview}>
        <Canvas shadows camera={{ position: [0, 1, 3.6], fov: 40 }}
          gl={{ toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 0.9, preserveDrawingBuffer: true }}
          onCreated={({ gl }) => { glRef.current = gl; }}>
          <ambientLight intensity={0.8} />
          <directionalLight position={[6, 14, 8]} intensity={1.5} castShadow />
          <directionalLight position={[-4, 4, -4]} intensity={0.4} />
          <Environment preset="apartment" />
          <PreviewMesh work={work} overrideMaps={useRefImage ? refMaps : null} />
          <OrbitControls enablePan={false} minDistance={2.4} maxDistance={6} />
        </Canvas>
      </div>
    </div>
  );
}

const s = {
  wrap: { display: 'flex', height: 'calc(100vh - 56px)', fontFamily: "'Quicksand', sans-serif" },
  panel: { width: 360, flexShrink: 0, overflowY: 'auto', padding: 20, background: '#fff', borderRight: '1.5px solid #C5D4C8' },
  preview: { flex: 1, minWidth: 0, background: '#EDEAE2' },
  title: { fontSize: 18, fontWeight: 700, color: '#3D5A44', marginBottom: 16 },
  section: { marginBottom: 18 },
  lbl: { display: 'block', fontSize: 11, fontWeight: 700, color: '#6B8C74', letterSpacing: 1, textTransform: 'uppercase', margin: '10px 0 6px' },
  input: { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' },
  hint: { fontSize: 12, color: '#999' },
  chipRow: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  chip: { padding: '5px 12px', borderRadius: 16, border: '1.5px solid #C5D4C8', background: '#fff', fontSize: 13, color: '#3D5A44', cursor: 'pointer', fontFamily: 'inherit' },
  chipOn: { background: '#3D5A44', color: '#fff', borderColor: '#3D5A44' },
  paramCard: { border: '1px solid #E2E8E3', borderRadius: 10, padding: 10, marginBottom: 8 },
  paramHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  paramLabel: { fontSize: 13, fontWeight: 600, color: '#3D5A44', border: 'none', borderBottom: '1px dashed #C5D4C8', background: 'transparent', fontFamily: 'inherit', flex: 1, marginRight: 8 },
  code: { fontSize: 11, color: '#999', fontFamily: 'monospace' },
  sliderRow: { display: 'flex', alignItems: 'center', gap: 8 },
  slider: { flex: 1, accentColor: '#3D5A44' },
  val: { fontSize: 12, fontWeight: 700, color: '#6B8C74', minWidth: 44, textAlign: 'right' },
  metaRow: { display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 8 },
  metaField: { display: 'flex', flexDirection: 'column', gap: 2 },
  metaLbl: { fontSize: 10, color: '#999' },
  num: { width: 56, padding: '4px 6px', borderRadius: 6, border: '1px solid #C5D4C8', fontSize: 12, fontFamily: 'inherit' },
  userToggle: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6B8C74', marginLeft: 'auto' },
  saveBtn: (saving) => ({ width: '100%', padding: '11px', borderRadius: 10, border: 'none', background: saving ? '#9bb3a1' : '#3D5A44', color: '#fff', fontSize: 15, fontWeight: 700, cursor: saving ? 'default' : 'pointer', fontFamily: 'inherit', marginTop: 8 }),
  snapBtn: { width: '100%', padding: '9px', borderRadius: 10, border: '1.5px solid #C5D4C8', background: '#fff', color: '#3D5A44', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 8 },
  msg: { marginTop: 10, fontSize: 13, fontWeight: 600 },
};
