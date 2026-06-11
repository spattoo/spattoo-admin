import { useState, useRef, useEffect, useMemo, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { fetchElementTypes, getSignedUploadUrl, uploadToR2, createGlobalElement, removeBg } from '../lib/api.js';

import { ZONE_LIST as ZONES } from '../lib/constants.js';

// ── The script contract ───────────────────────────────────────────────────────
// The pasted script (from AI) MUST `return { build, parts }`:
//   build(THREE)  → returns a THREE.Object3D (Group). Each logical part is its
//                   OWN mesh with its OWN material instance, tagged via
//                   mesh.userData.part = '<id>'. Don't share one material across
//                   parts or recoloring one part bleeds into the others.
//   parts         → [{ id, label, default }] declaring the recolorable surface.
// We own the scene/camera/lights — the script only builds geometry.

const DEFAULT_SCRIPT = `// Multi-part model. Each part = its own mesh + its OWN material.
// Tag meshes with userData.part so each part recolors independently.
return {
  build(THREE) {
    const group = new THREE.Group();

    // — stem —
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.09, 1.4, 16),
      new THREE.MeshStandardMaterial({ color: '#3a7d44', roughness: 0.6 })
    );
    stem.position.y = -0.25;
    stem.userData.part = 'stem';
    group.add(stem);

    // — petals —
    const petalGeo = new THREE.SphereGeometry(0.28, 24, 24);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const petal = new THREE.Mesh(
        petalGeo,
        new THREE.MeshStandardMaterial({ color: '#ff7eb6', roughness: 0.4 })
      );
      petal.position.set(Math.cos(a) * 0.34, 0.55, Math.sin(a) * 0.34);
      petal.scale.set(1, 0.6, 1);
      petal.userData.part = 'petals';
      group.add(petal);
    }

    // — center —
    const center = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 24, 24),
      new THREE.MeshStandardMaterial({ color: '#ffd23f', roughness: 0.3 })
    );
    center.position.y = 0.55;
    center.userData.part = 'center';
    group.add(center);

    return group;
  },
  parts: [
    { id: 'petals', label: 'Petals', default: '#ff7eb6' },
    { id: 'center', label: 'Center', default: '#ffd23f' },
    { id: 'stem',   label: 'Stem',   default: '#3a7d44' },
  ],
};`;

// System prompt to hand an AI (Claude / GPT) so it emits scripts in this exact
// contract. Copied to the clipboard via the "Copy AI prompt" button.
const AI_PROMPT = `You generate JavaScript that builds a 3D cake-decoration model (topper, fondant figure, flower, etc.) using Three.js. Your output is executed verbatim as the body of new Function('THREE', <your code>) — so the ONLY thing in scope is THREE.

OUTPUT FORMAT — output ONLY raw JavaScript, no markdown fences, no prose, no imports. Your code MUST end by returning this exact shape:

  return {
    build(THREE) {
      const group = new THREE.Group();
      // ...build meshes, add them to group...
      return group;            // must return a THREE.Object3D
    },
    parts: [
      { id: 'petals', label: 'Petals', default: '#ff7eb6' },
      { id: 'center', label: 'Center', default: '#ffd23f' },
    ],
  };

HARD RULES
1. Use ONLY THREE — it is passed into build(THREE). Do NOT create a Scene, Camera, Renderer, lights, OrbitControls, or an animation loop. Do NOT use import/require, fetch, the DOM, textures, image/GLB loaders, or any external asset. Geometry only.
2. PARTS = the whole point. A "part" is a region the user can recolor on its own.
   • Every mesh MUST be tagged: mesh.userData.part = '<id>'.
   • Each part MUST have its OWN material instance. NEVER share one material across two parts (recoloring one would bleed into the other). If several meshes belong to the SAME part (e.g. 6 petals), they may share that part's single material.
   • Every userData.part id used on a mesh MUST appear in the parts array, and every id in parts MUST be used by at least one mesh.
3. Materials: use THREE.MeshStandardMaterial({ color, roughness, metalness }). default in the parts array must equal that part's starting color (hex string). Matte fondant ≈ roughness 0.6–0.9 metalness 0; glossy/candy ≈ roughness 0.2–0.4; gold/silver ≈ metalness 0.9 roughness 0.1–0.2.
4. SCALE & ORIENTATION (camera looks at the origin from [0, 1, 3.5], fov 40):
   • Center the model on X and Z. Keep its largest dimension roughly 1–2 units.
   • Up axis is +Y. The base/bottom should rest at or near y = 0, model extending upward. A topper on a stick: stick BELOW y = 0 (into the cake), body ABOVE y = 0.
5. Keep geometry efficient — sphere/cylinder segments ~24–48. Favor primitives (Sphere, Cylinder, Cone, Torus, Box) and THREE.Shape + ExtrudeGeometry / LatheGeometry for custom silhouettes. Call geometry.center() on extruded shapes, then reposition per rule 4.
6. Deterministic output — do not rely on Math.random().
7. Few, meaningful ids/labels (3–6 parts ideal). Prefer "Petals", "Stem", "Eyes" over "part1".

WORKED EXAMPLE (a daisy) — match this style exactly:

return {
  build(THREE) {
    const group = new THREE.Group();

    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.09, 1.4, 16),
      new THREE.MeshStandardMaterial({ color: '#3a7d44', roughness: 0.6 })
    );
    stem.position.y = -0.25;
    stem.userData.part = 'stem';
    group.add(stem);

    const petalMat = new THREE.MeshStandardMaterial({ color: '#ff7eb6', roughness: 0.4 });
    const petalGeo = new THREE.SphereGeometry(0.28, 24, 24);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const petal = new THREE.Mesh(petalGeo, petalMat);
      petal.position.set(Math.cos(a) * 0.34, 0.55, Math.sin(a) * 0.34);
      petal.scale.set(1, 0.6, 1);
      petal.userData.part = 'petals';
      group.add(petal);
    }

    const center = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 24, 24),
      new THREE.MeshStandardMaterial({ color: '#ffd23f', roughness: 0.3 })
    );
    center.position.y = 0.55;
    center.userData.part = 'center';
    group.add(center);

    return group;
  },
  parts: [
    { id: 'petals', label: 'Petals', default: '#ff7eb6' },
    { id: 'center', label: 'Center', default: '#ffd23f' },
    { id: 'stem',   label: 'Stem',   default: '#3a7d44' },
  ],
};

Now build the model the user describes, following every rule above.`;

// ── Script → model ────────────────────────────────────────────────────────────

// Run the pasted script in a constrained function (only THREE is injected) and
// return { root: Object3D, manifest: [{id,label,default}] }. Throws on bad input.
function runScript(code) {
  let mod;
  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function('THREE', `"use strict";\n${code}`);
    mod = factory(THREE);
  } catch (e) {
    throw new Error(`Script error: ${e.message}`);
  }
  if (!mod || typeof mod.build !== 'function') {
    throw new Error('Script must `return { build, parts }` where build is a function.');
  }
  const root = mod.build(THREE);
  if (!root || !root.isObject3D) {
    throw new Error('build(THREE) must return a THREE.Object3D (e.g. a THREE.Group).');
  }
  const manifest = Array.isArray(mod.parts) ? mod.parts : [];
  return { root, manifest };
}

// Group meshes by userData.part (falling back to mesh name). Returns ordered
// part descriptors merged with the declared manifest, plus any warnings.
function analyzeModel(root, manifest) {
  const byPart = new Map();      // partId → mesh[]
  const matToParts = new Map();  // material → Set<partId>  (to catch shared materials)
  let meshCount = 0;

  root.traverse(o => {
    if (!o.isMesh) return;
    meshCount++;
    const part = (o.userData && o.userData.part) || o.name || 'model';
    if (!byPart.has(part)) byPart.set(part, []);
    byPart.get(part).push(o);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(m => {
      if (!m) return;
      if (!matToParts.has(m)) matToParts.set(m, new Set());
      matToParts.get(m).add(part);
    });
  });

  const declared = new Map(manifest.map(p => [p.id, p]));
  const order = [];
  // declared parts first (in author order), then any discovered extras
  manifest.forEach(p => { if (byPart.has(p.id)) order.push(p.id); });
  byPart.forEach((_, id) => { if (!declared.has(id)) order.push(id); });

  const parts = order.map(id => {
    const meshes = byPart.get(id);
    const decl = declared.get(id);
    const firstMat = Array.isArray(meshes[0].material) ? meshes[0].material[0] : meshes[0].material;
    const matColor = firstMat && firstMat.color ? `#${firstMat.color.getHexString()}` : '#cccccc';
    return {
      id,
      label: decl?.label || id,
      default: decl?.default || matColor,
      declared: !!decl,
    };
  });

  const warnings = [];
  if (meshCount === 0) warnings.push('No meshes found in the model.');
  manifest.forEach(p => {
    if (!byPart.has(p.id)) warnings.push(`Declared part "${p.id}" has no meshes tagged userData.part = "${p.id}".`);
  });
  byPart.forEach((_, id) => {
    if (!declared.has(id)) warnings.push(`Part "${id}" isn't in the parts manifest — using a fallback swatch.`);
  });
  matToParts.forEach((partIds, m) => {
    if (partIds.size > 1) warnings.push(`A single material is shared across parts: ${[...partIds].join(', ')} — recoloring one will affect all. Give each part its own material.`);
  });

  return { parts, warnings };
}

// Apply chosen colors to the live model (mutates each part's own material).
function applyColors(root, colors) {
  root.traverse(o => {
    if (!o.isMesh) return;
    const part = (o.userData && o.userData.part) || o.name || 'model';
    const hex = colors[part];
    if (!hex) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(m => { if (m && m.color) { m.color.set(hex); m.needsUpdate = true; } });
  });
}

async function exportGLB(root) {
  const scene = new THREE.Scene();
  scene.add(root);
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(scene, result => resolve(result), reject, { binary: true });
  });
}

// ── Preview ───────────────────────────────────────────────────────────────────

function ModelView({ root, ambientInt, keyInt, fillInt, envPreset, containerRef }) {
  return (
    <div ref={containerRef} style={{ height: 300, borderRadius: 12, overflow: 'hidden', background: '#E8EDE9' }}>
      <Canvas gl={{ preserveDrawingBuffer: true, alpha: true }} camera={{ position: [0, 1, 3.5], fov: 40 }}>
        <ambientLight intensity={ambientInt} />
        <directionalLight position={[4, 6, 4]} intensity={keyInt} />
        <directionalLight position={[-3, 2, -2]} intensity={fillInt} />
        {envPreset !== 'none' && <Environment preset={envPreset} />}
        <Suspense fallback={null}>
          {root && <primitive object={root} />}
        </Suspense>
        <OrbitControls enablePan={false} />
      </Canvas>
    </div>
  );
}

// ── Main screen ────────────────────────────────────────────────────────────────

export default function GenerateModel() {
  const [script, setScript]   = useState(DEFAULT_SCRIPT);
  const [root, setRoot]       = useState(null);     // live THREE.Object3D
  const [parts, setParts]     = useState([]);       // [{id,label,default,declared}]
  const [colors, setColors]   = useState({});       // partId → hex
  const [warnings, setWarnings] = useState([]);
  const [scriptError, setScriptError] = useState(null);
  const [promptCopied, setPromptCopied] = useState(false);

  // Lighting
  const [ambientInt, setAmbientInt] = useState(0.4);
  const [keyInt, setKeyInt]         = useState(2.5);
  const [fillInt, setFillInt]       = useState(1.0);
  const [envPreset, setEnvPreset]   = useState('none');

  // Element metadata
  const [elementTypes, setElementTypes]   = useState([]);
  const [elementTypeId, setElementTypeId] = useState('');
  const [name, setName]                   = useState('');
  const [zones, setZones]                 = useState(['top_surface', 'side', 'middle_tier']);
  const [placementConfig, setPlacementConfig] = useState({});
  const [capabilities, setCapabilities]   = useState({ resize: true, duplicate: true, color: true, delete: true, move: false, tilt: false });
  const [saving, setSaving]               = useState(false);
  const [msg, setMsg]                     = useState(null);

  const previewRef = useRef(null);

  useEffect(() => {
    fetchElementTypes().then(types => {
      setElementTypes(types);
      if (types.length > 0) setElementTypeId(types[0].id);
    }).catch(() => {});
  }, []);

  // Compile the default script once on mount so the preview is live immediately.
  useEffect(() => { render(); /* eslint-disable-next-line */ }, []);

  function render() {
    try {
      const { root: r, manifest } = runScript(script);
      const { parts: p, warnings: w } = analyzeModel(r, manifest);
      const initColors = {};
      p.forEach(part => { initColors[part.id] = part.default; });
      applyColors(r, initColors);
      setRoot(r);
      setParts(p);
      setColors(initColors);
      setWarnings(w);
      setScriptError(null);
    } catch (e) {
      setScriptError(e.message);
      setRoot(null);
      setParts([]);
      setWarnings([]);
    }
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(AI_PROMPT);
    } catch {
      // Fallback for non-secure contexts
      const ta = document.createElement('textarea');
      ta.value = AI_PROMPT;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setPromptCopied(true);
    setTimeout(() => setPromptCopied(false), 1800);
  }

  function setPartColor(partId, hex) {
    setColors(prev => {
      const next = { ...prev, [partId]: hex };
      if (root) applyColors(root, next);
      return next;
    });
  }

  function resetColors() {
    const reset = {};
    parts.forEach(p => { reset[p.id] = p.default; });
    if (root) applyColors(root, reset);
    setColors(reset);
  }

  // Seed per-zone placement modes from the element type's rules
  useEffect(() => {
    const type = elementTypes.find(t => t.id === elementTypeId);
    const rules = type?.placement_rules ?? {};
    setPlacementConfig(prev => {
      const next = {};
      zones.forEach(z => { next[z] = prev[z] ?? rules.placement?.[z] ?? 'stand'; });
      return next;
    });
    // eslint-disable-next-line
  }, [elementTypeId, elementTypes]);

  function toggleZone(z) {
    setZones(prev => {
      if (!prev.includes(z)) {
        const type = elementTypes.find(t => t.id === elementTypeId);
        const defaultMode = type?.placement_rules?.placement?.[z] ?? 'stand';
        setPlacementConfig(pc => ({ ...pc, [z]: defaultMode }));
        return [...prev, z];
      }
      return prev.filter(x => x !== z);
    });
  }

  function setZonePlacement(z, mode) {
    setPlacementConfig(prev => ({ ...prev, [z]: mode }));
  }

  async function handleSave() {
    if (!root)           return setMsg({ ok: false, text: 'Render a valid model first' });
    if (!name.trim())    return setMsg({ ok: false, text: 'Enter a name' });
    if (!elementTypeId)  return setMsg({ ok: false, text: 'Select an element type' });
    if (!zones.length)   return setMsg({ ok: false, text: 'Select at least one zone' });

    setSaving(true);
    setMsg(null);
    try {
      // thumbnail from the live WebGL canvas
      const glCanvas = previewRef.current?.querySelector('canvas');
      if (!glCanvas) throw new Error('3D preview not ready — try again');
      const rawThumb = await new Promise(resolve => glCanvas.toBlob(resolve, 'image/png'));
      let thumbBlob = rawThumb;
      try { thumbBlob = await removeBg(rawThumb); } catch (e) { console.warn('remove.bg failed:', e.message); }

      // export GLB (re-run the script so we don't detach the live preview's root)
      const { root: exportRoot, manifest } = runScript(script);
      applyColors(exportRoot, colors);
      const glbBuffer = await exportGLB(exportRoot);
      const glbBlob = new Blob([glbBuffer], { type: 'model/gltf-binary' });

      const { url: fu, key: fk } = await getSignedUploadUrl('elements/files/3D', `${crypto.randomUUID()}.glb`, 'model/gltf-binary');
      await uploadToR2(fu, glbBlob);
      const { url: tu, key: tk } = await getSignedUploadUrl('elements/thumbnails', `${crypto.randomUUID()}.png`, 'image/png');
      await uploadToR2(tu, thumbBlob);

      // Stash the part-map + source script alongside placement (jsonb) so the
      // model stays re-editable and parts can drive per-part color later.
      const partsMeta = parts.map(p => ({ id: p.id, label: p.label, default: colors[p.id] ?? p.default }));
      const placement = { ...placementConfig, _model: { script, parts: partsMeta } };

      await createGlobalElement({
        name: name.trim(),
        element_type_id: elementTypeId,
        parent_id: null,
        image_url: fk,
        thumbnail_url: tk,
        allowed_zones: zones,
        placement_config: placement,
        allowed_actions: capabilities,
        default_color: parts[0] ? (colors[parts[0].id] ?? parts[0].default) : null,
        sort_order: 0,
      });

      setMsg({ ok: true, text: 'Model saved as element!' });
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  }

  const s = useMemo(() => ({
    page: { minHeight: '100vh', background: '#EDEAE2', fontFamily: 'Quicksand, sans-serif', padding: '32px 24px' },
    title: { fontSize: 22, fontWeight: 800, color: '#2C4433', marginBottom: 6 },
    sub: { fontSize: 13, color: '#6B8C74', fontWeight: 600, marginBottom: 24 },
    layout: { display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24, maxWidth: 1100, margin: '0 auto', alignItems: 'start' },
    card: { background: '#fff', borderRadius: 18, border: '1.5px solid #C5D4C8', padding: 28 },
    section: { marginBottom: 24 },
    sectionTitle: { fontSize: 11, fontWeight: 700, color: '#6B8C74', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 },
    textarea: { width: '100%', height: 300, padding: '12px 14px', borderRadius: 10, border: '1.5px solid #C5D4C8', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, lineHeight: 1.5, color: '#2C4433', background: '#FAFCFA', boxSizing: 'border-box', outline: 'none', resize: 'vertical', whiteSpace: 'pre', overflowWrap: 'normal', overflowX: 'auto' },
    renderBtn: { marginTop: 12, padding: '11px 22px', borderRadius: 10, border: 'none', background: '#3D5A44', color: '#fff', fontFamily: 'Quicksand, sans-serif', fontSize: 14, fontWeight: 800, cursor: 'pointer' },
    copyPromptBtn: { padding: '6px 12px', borderRadius: 8, border: '1.5px solid #C5D4C8', background: '#F4F8F5', color: '#3D5A44', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' },
    err: { marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, background: '#FFF0F0', color: '#C0392B', whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace' },
    warn: { marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, background: '#FFF8E6', color: '#8a6d1a', display: 'flex', flexDirection: 'column', gap: 4 },
    label: { fontSize: 12, fontWeight: 700, color: '#6B8C74', display: 'block', marginBottom: 6 },
    input: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontFamily: 'Quicksand, sans-serif', fontSize: 14, fontWeight: 600, color: '#2C4433', background: '#fff', boxSizing: 'border-box', outline: 'none' },
    select: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontFamily: 'Quicksand, sans-serif', fontSize: 14, fontWeight: 600, color: '#2C4433', background: '#fff', boxSizing: 'border-box' },
    zonesRow: { display: 'flex', flexWrap: 'wrap', gap: 8 },
    zoneChip: (active) => ({ padding: '6px 12px', borderRadius: 20, border: `1.5px solid ${active ? '#3D5A44' : '#C5D4C8'}`, background: active ? '#E8EDE9' : '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: active ? '#2C4433' : '#6B8C74' }),
    partRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#F4F8F5', borderRadius: 8 },
    swatch: { width: 34, height: 34, borderRadius: 8, border: '1.5px solid #C5D4C8', cursor: 'pointer', padding: 2, background: '#fff' },
    saveBtn: (disabled) => ({ width: '100%', padding: '13px 0', borderRadius: 10, border: 'none', background: disabled ? '#9BB5A2' : '#3D5A44', color: '#fff', fontFamily: 'Quicksand, sans-serif', fontSize: 15, fontWeight: 800, cursor: disabled ? 'not-allowed' : 'pointer' }),
    msg: (ok) => ({ marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: ok ? '#E8F5E9' : '#FFF0F0', color: ok ? '#2E7D32' : '#C0392B' }),
  }), []);

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Quicksand:wght@400;600;700;800&display=swap" rel="stylesheet" />
      <div style={s.page}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={s.title}>Generate 3D Model</div>
          <div style={s.sub}>Paste an AI-generated builder script, preview it, recolor each part, and save it as a library element.</div>
        </div>

        <div style={s.layout}>
          {/* ── Left: script + metadata ── */}
          <div style={s.card}>
            <div style={s.section}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ ...s.sectionTitle, marginBottom: 0 }}>Model Script</div>
                <button onClick={copyPrompt} style={s.copyPromptBtn} title="Copy the AI system prompt to your clipboard, paste it into Claude/GPT, then paste the script it returns here">
                  {promptCopied ? '✓ Copied prompt' : '📋 Copy AI prompt'}
                </button>
              </div>
              <textarea
                style={s.textarea}
                value={script}
                onChange={e => setScript(e.target.value)}
                spellCheck={false}
                placeholder={'return {\n  build(THREE) { /* return a THREE.Group; tag meshes with userData.part */ },\n  parts: [{ id, label, default }],\n};'}
              />
              <button style={s.renderBtn} onClick={render}>Render Model</button>
              {scriptError && <div style={s.err}>{scriptError}</div>}
              {warnings.length > 0 && (
                <div style={s.warn}>
                  {warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
                </div>
              )}
            </div>

            {/* Per-part colors */}
            {parts.length > 0 && (
              <div style={s.section}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div style={{ ...s.sectionTitle, marginBottom: 0 }}>Parts ({parts.length})</div>
                  <button onClick={resetColors} style={{ background: 'none', border: 'none', color: '#6B8C74', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Reset colors</button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {parts.map(p => (
                    <div key={p.id} style={s.partRow}>
                      <input type="color" value={colors[p.id] ?? p.default} onChange={e => setPartColor(p.id, e.target.value)} style={s.swatch} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#2C4433' }}>{p.label}</div>
                        <div style={{ fontSize: 11, color: '#9BB5A2', fontWeight: 600 }}>
                          {p.id}{!p.declared && ' · undeclared'}
                        </div>
                      </div>
                      <span style={{ fontSize: 12, color: '#6B8C74', fontWeight: 600 }}>{colors[p.id] ?? p.default}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Name */}
            <div style={s.section}>
              <label style={s.label}>Element Name</label>
              <input style={s.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Daisy Topper" />
            </div>

            {/* Type */}
            <div style={s.section}>
              <label style={s.label}>Element Type</label>
              <select style={s.select} value={elementTypeId} onChange={e => setElementTypeId(e.target.value)}>
                <option value="">Select type…</option>
                {elementTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>

            {/* Zones */}
            <div style={s.section}>
              <div style={s.sectionTitle}>Zones</div>
              <div style={s.zonesRow}>
                {ZONES.map(z => (
                  <button key={z} style={s.zoneChip(zones.includes(z))} onClick={() => toggleZone(z)}>
                    {z.replace(/_/g, ' ')}
                  </button>
                ))}
              </div>
            </div>

            {/* Placement per zone */}
            {zones.length > 0 && (
              <div style={s.section}>
                <div style={s.sectionTitle}>Placement per Zone</div>
                <p style={{ fontSize: 12, color: '#9BB5A2', fontWeight: 600, margin: '0 0 10px' }}>
                  Hug = aligns flat to surface · Stand = stays upright
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {zones.map(z => {
                    const current = placementConfig[z] ?? 'stand';
                    return (
                      <div key={z} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#F4F8F5', borderRadius: 8, padding: '10px 12px' }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#2C4433' }}>{z.replace(/_/g, ' ')}</span>
                        <div style={{ display: 'flex', gap: 6 }}>
                          {['hug', 'stand'].map(mode => (
                            <button
                              key={mode}
                              onClick={() => setZonePlacement(z, mode)}
                              style={{
                                padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
                                fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700,
                                background: current === mode ? '#3D5A44' : '#E8EDE9',
                                color: current === mode ? '#fff' : '#6B8C74',
                              }}
                            >
                              {mode === 'hug' ? 'Hug' : 'Stand'}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Capabilities */}
            <div style={s.section}>
              <div style={s.sectionTitle}>Capabilities</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[
                  { key: 'resize',    label: 'Resizable',        hint: '＋/− size buttons in edit strip' },
                  { key: 'duplicate', label: 'Duplicatable',     hint: 'Copy button creates another instance' },
                  { key: 'color',     label: 'Color changeable', hint: 'Color picker in designer' },
                  { key: 'delete',    label: 'Deletable',        hint: 'Remove button shown when selected' },
                  { key: 'move',      label: 'Movable',          hint: 'Nudge ◀▶▲▼ position on the cake' },
                  { key: 'tilt',      label: 'Tiltable',         hint: 'Lean / rotate slightly in the designer' },
                ].map(({ key, label, hint }) => (
                  <label key={key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      style={{ width: 18, height: 18, accentColor: '#3D5A44', cursor: 'pointer', marginTop: 1, flexShrink: 0 }}
                      checked={capabilities[key]}
                      onChange={e => setCapabilities(c => ({ ...c, [key]: e.target.checked }))}
                    />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#2C4433' }}>{label}</div>
                      <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>{hint}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* ── Right: preview + lighting + save ── */}
          <div style={s.card}>
            <div style={s.sectionTitle}>Preview</div>
            <ModelView
              root={root}
              ambientInt={ambientInt}
              keyInt={keyInt}
              fillInt={fillInt}
              envPreset={envPreset}
              containerRef={previewRef}
            />
            <p style={{ fontSize: 11, color: '#9BB5A2', fontWeight: 600, marginTop: 8, textAlign: 'center' }}>
              Drag to rotate · scroll to zoom
            </p>

            {/* Lighting */}
            <div style={{ marginTop: 16, padding: '14px 16px', background: '#F4F8F5', borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#6B8C74', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 2 }}>Lighting</div>
              {[
                { label: 'Ambient', value: ambientInt, set: setAmbientInt, max: 3 },
                { label: 'Key',     value: keyInt,     set: setKeyInt,     max: 6 },
                { label: 'Fill',    value: fillInt,    set: setFillInt,    max: 4 },
              ].map(({ label, value, set, max }) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#6B8C74', width: 46 }}>{label}</span>
                  <input type="range" min={0} max={max} step={0.05} value={value} onChange={e => set(+e.target.value)} style={{ flex: 1, accentColor: '#3D5A44' }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44', minWidth: 28, textAlign: 'right' }}>{value.toFixed(1)}</span>
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#6B8C74', width: 46 }}>Env</span>
                <select value={envPreset} onChange={e => setEnvPreset(e.target.value)}
                  style={{ flex: 1, padding: '4px 8px', borderRadius: 6, border: '1.5px solid #C5D4C8', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 600, color: '#2C4433', background: '#fff' }}>
                  {['none','studio','city','sunset','dawn','warehouse','forest','park','lobby'].map(p => (
                    <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                  ))}
                </select>
              </div>
            </div>

            <button style={{ ...s.saveBtn(saving || !root), marginTop: 20 }} onClick={handleSave} disabled={saving || !root}>
              {saving ? 'Saving…' : 'Save as Element'}
            </button>
            {msg && <div style={s.msg(msg.ok)}>{msg.text}</div>}
          </div>
        </div>
      </div>
    </>
  );
}
