import { useState, useRef, useEffect, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { fetchElementTypes, getSignedUploadUrl, uploadToR2, createGlobalElement, removeBg } from '../lib/api.js';
import { ZONE_LIST as ZONES } from '../lib/constants.js';
import { loader, buildWorkingGeo, deriveFaceData, kmeans, clusterConnected, floodFillFaces, brushFaces, boundaryEdges, buildTexturedScene } from './glbRecomposeCore.js';

// GLB Recompose — take a SINGLE fused mesh (e.g. a Meshy image-to-3D export:
// 1 mesh, 1 material, colour baked into a texture atlas) and carve it into
// separate recolourable PARTS. Per-face part assignment is driven by an auto
// colour-cluster pre-fill, click flood-fill (stops at creases / colour changes)
// and a brush. Export = one merged GLB whose meshes carry userData.part + a
// root part-map — the SAME convention GLB Studio uses, so it flows straight into
// the element library. This is the inverse of GLB Studio (which assembles
// already-separate pieces); the two are kept fully separate on purpose.

// three-mesh-bvh: accelerate face picking on heavy meshes.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const FINISHES = {
  matte:  { label: 'Matte',    rough: 0.85, metal: 0.0 },
  satin:  { label: 'Satin',    rough: 0.5,  metal: 0.0 },
  glossy: { label: 'Glossy',   rough: 0.25, metal: 0.0 },
  metal:  { label: 'Metallic', rough: 0.2,  metal: 0.9 },
};
const PALETTE = ['#e84a5f', '#ffb400', '#2ec4b6', '#3a86ff', '#8338ec', '#fb5607', '#06d6a0', '#ef476f'];

// Interactive mesh: in 'fill' mode a click flood-fills; in 'brush' mode a drag
// paints. Orbit is only live in 'orbit' mode so a click/drag never fights the
// camera. All tool state is read through refs to dodge stale closures.
function EditMesh({ geometry, toolRef, onFill, onBrushStart, onBrushMove, onBrushEnd }) {
  const painting = useRef(false);
  return (
    <mesh
      geometry={geometry}
      onPointerDown={e => {
        if (toolRef.current === 'fill') { e.stopPropagation(); onFill(e.faceIndex); }
        else if (toolRef.current === 'brush') {
          e.stopPropagation();
          painting.current = true;
          e.target.setPointerCapture?.(e.pointerId);
          onBrushStart(e.faceIndex, e.point);
        }
      }}
      onPointerMove={e => { if (painting.current && toolRef.current === 'brush') { e.stopPropagation(); onBrushMove(e.faceIndex, e.point); } }}
      onPointerUp={e => { if (painting.current) { painting.current = false; e.target.releasePointerCapture?.(e.pointerId); onBrushEnd(); } }}
    >
      <meshStandardMaterial vertexColors roughness={0.7} metalness={0} />
    </mesh>
  );
}

// Outline the selected part's boundary edges (lines that border non-selected
// faces) — a selection cue that doesn't touch the part's true colour.
function SelectionOutline({ positions }) {
  const geom = useMemo(() => {
    if (!positions) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return g;
  }, [positions]);
  useEffect(() => () => geom?.dispose(), [geom]);
  if (!geom) return null;
  return (
    <lineSegments geometry={geom} renderOrder={999}>
      <lineBasicMaterial color="#1e90ff" depthTest depthWrite={false} transparent opacity={0.9} />
    </lineSegments>
  );
}

function Scene({ geometry, originalObject, view, outline, toolRef, onFill, onBrushStart, onBrushMove, onBrushEnd, tool, controlsRef, ambientInt, keyInt, fillInt }) {
  return (
    <>
      <ambientLight intensity={ambientInt} />
      <directionalLight position={[3, 5, 4]} intensity={keyInt} />
      <directionalLight position={[-4, 2, -3]} intensity={fillInt} />
      <Environment preset="studio" />
      {/* Original view = the untouched textured GLB (full mesh + texture map, the
          faithful reference). Parts view = the editable vertex-colour segmentation. */}
      {view === 'original' && originalObject && <primitive object={originalObject} />}
      {view === 'parts' && geometry && (
        <EditMesh geometry={geometry} toolRef={toolRef}
          onFill={onFill} onBrushStart={onBrushStart} onBrushMove={onBrushMove} onBrushEnd={onBrushEnd} />
      )}
      {view === 'parts' && outline && <SelectionOutline positions={outline} />}
      <OrbitControls ref={controlsRef} enabled={tool === 'orbit'} makeDefault enablePan />
    </>
  );
}

export default function GlbRecompose() {
  const [geo, setGeo] = useState(null);           // non-indexed display geometry
  const [origScene, setOrigScene] = useState(null); // pristine textured GLB (Original view)
  const [parts, setParts] = useState([]);         // [{id,label,color,finish}]
  const [selectedId, setSelectedId] = useState(null);
  const [counts, setCounts] = useState({});       // partId -> face count
  const [tool, setTool] = useState('orbit');      // 'orbit' | 'fill' | 'brush'
  const [view, setView] = useState('original');   // 'original' (baked GLB colours) | 'parts'
  const [outline, setOutline] = useState(null);    // selected-part boundary line segments
  const [colorTol, setColorTol] = useState(18);   // ΔE flood-fill colour tolerance
  const [creaseDeg, setCreaseDeg] = useState(35); // flood-fill crease stop (deg)
  const [brushRadius, setBrushRadius] = useState(0.12);
  const [clusterK, setClusterK] = useState(5);
  const [importTris, setImportTris] = useState(60000);
  const [exportMode, setExportMode] = useState('parts'); // 'parts' (recolourable) | 'textured' (faithful)
  const [stats, setStats] = useState(null);       // {tris}
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // save-as-element form
  const [elementTypes, setElementTypes] = useState([]);
  const [elementTypeId, setElementTypeId] = useState('');
  const [name, setName] = useState('');
  const [zones, setZones] = useState(['top_surface']);
  const [placementConfig, setPlacementConfig] = useState({});
  const [capabilities, setCapabilities] = useState({ resize: true, duplicate: true, color: true, delete: true, move: false, tilt: false });
  const [saveMsg, setSaveMsg] = useState(null);
  const [topperSize, setTopperSize] = useState(1.0);

  const [ambientInt] = useState(0.5);
  const [keyInt] = useState(1.3);   // softer key so the texture's pinks don't blow out
  const [fillInt] = useState(0.55);

  const faceData = useRef(null);     // {triCount, adjacency, labs, normals, centroids}
  const faceParts = useRef(null);    // Int32Array(triCount) -> part id index
  const bakedColors = useRef(null);  // Float32Array(triCount*9) original baked colours
  const partsRef = useRef([]);
  const selectedRef = useRef(null);
  const toolRef = useRef('orbit');
  const viewRef = useRef('original');
  const previewRef = useRef(null);
  const controlsRef = useRef(null);
  const partSeq = useRef(0);

  useEffect(() => { fetchElementTypes().then(setElementTypes).catch(() => {}); }, []);
  useEffect(() => { partsRef.current = parts; }, [parts]);
  useEffect(() => { selectedRef.current = selectedId; computeOutline(); }, [selectedId]);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { viewRef.current = view; retint(); computeOutline(); }, [view]);

  // ----- tint: write each face's part colour into the display colour attribute.
  // faceParts holds the part's ARRAY INDEX; resolve it through partsRef. We show
  // the TRUE part colour (no selection tint) so what you pick is what you see;
  // the selected part is indicated in the parts panel instead.
  function partLinColor(idx) {
    const p = partsRef.current[idx];
    return new THREE.Color(p ? p.color : '#bbbbbb'); // hex → linear (ColorManagement)
  }
  function retint(faces) {
    if (!geo || !faceParts.current) return;
    const attr = geo.attributes.color;
    const arr = attr.array;
    // 'original' view = show the baked GLB colours (the segmentation reference);
    // 'parts' view = tint each face by its assigned part.
    if (viewRef.current === 'original') {
      if (bakedColors.current) arr.set(bakedColors.current);
      attr.needsUpdate = true;
      return;
    }
    const cache = {};
    const list = faces || range(faceData.current.triCount);
    for (const f of list) {
      const pid = faceParts.current[f];
      const c = cache[pid] || (cache[pid] = partLinColor(pid));
      for (let v = 0; v < 3; v++) {
        const o = (f * 3 + v) * 3;
        arr[o] = c.r; arr[o + 1] = c.g; arr[o + 2] = c.b;
      }
    }
    attr.needsUpdate = true;
  }
  function recount() {
    if (!faceParts.current) return;
    const c = {};
    for (let f = 0; f < faceParts.current.length; f++) c[faceParts.current[f]] = (c[faceParts.current[f]] || 0) + 1;
    setCounts(c);
  }

  // Boundary outline of the selected part: edges used by exactly one selected
  // face (i.e. where the part meets non-selected faces or the mesh edge). Welds by
  // quantised position so the trace is continuous across the non-indexed display.
  function computeOutline() {
    if (!geo || viewRef.current !== 'parts' || !faceParts.current || selectedRef.current == null) { setOutline(null); return; }
    const target = partsRef.current.findIndex(p => p.id === selectedRef.current);
    if (target < 0) { setOutline(null); return; }
    setOutline(boundaryEdges(geo.attributes.position.array, faceParts.current, target));
  }

  // ----- import
  async function importFile(file) {
    if (!file) return;
    setError(null); setBusy(true); setSaveMsg(null);
    try {
      const url = URL.createObjectURL(file);
      const gltf = await loader().loadAsync(url);
      URL.revokeObjectURL(url);
      // buildWorkingGeo is non-destructive (it clones geometries), so gltf.scene
      // keeps its full mesh + texture for the faithful Original view.
      const welded = await buildWorkingGeo(gltf.scene, importTris);
      const fd = deriveFaceData(welded);

      const display = welded.toNonIndexed();
      display.computeBoundsTree();
      bakedColors.current = Float32Array.from(display.attributes.color.array);

      // normalise the pristine scene the same way buildWorkingGeo normalised the
      // working geo (centre at origin, longest side → 2 units) so both views align.
      const obox = new THREE.Box3().setFromObject(gltf.scene);
      const oc = new THREE.Vector3(); obox.getCenter(oc);
      const osize = new THREE.Vector3(); obox.getSize(osize);
      gltf.scene.position.sub(oc);
      const ogrp = new THREE.Group();
      ogrp.add(gltf.scene);
      ogrp.scale.setScalar(2 / (Math.max(osize.x, osize.y, osize.z) || 1));
      setOrigScene(ogrp);

      faceData.current = fd;
      faceParts.current = new Int32Array(fd.triCount); // all → part 0

      partSeq.current = 0;
      const id = `p${partSeq.current++}`;
      const initParts = [{ id, label: 'Part 1', color: '#cccccc', finish: 'matte', group: '', editable: false }];
      partsRef.current = initParts;
      selectedRef.current = id;

      setGeo(display);
      setParts(initParts);
      setSelectedId(id);
      setStats({ tris: fd.triCount });
      setName(file.name.replace(/\.(glb|gltf)$/i, '').replace(/[-_]/g, ' ').trim());
      setTool('orbit');
      viewRef.current = 'original'; setView('original'); // show the real GLB colours
      retint();
      recount();
    } catch (e) {
      setError(`Import failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  // ----- segmentation ops
  // Replace the parts list from a {assign, colors} result; faceParts[f] = part's
  // array index (assign is built in part order).
  function applyClustering({ assign, colors }) {
    const newParts = colors.map((col, k) => ({ id: `p${partSeq.current++}`, label: `Part ${k + 1}`, color: col, finish: 'matte', group: '', editable: false }));
    const fp = faceParts.current;
    for (let f = 0; f < fp.length; f++) fp[f] = assign[f];
    partsRef.current = newParts;
    setParts(newParts);
    setSelectedId(newParts[0].id);
    selectedRef.current = newParts[0].id;
    viewRef.current = 'parts'; setView('parts'); // show the cluster result
    setTimeout(() => { retint(); recount(); computeOutline(); }, 0);
  }
  // split by colour only — same-coloured regions anywhere become ONE part.
  function autoCluster() {
    if (!faceData.current) return;
    applyClustering(kmeans(faceData.current.labs, faceData.current.triCount, clusterK));
  }
  // split by colour AND connectivity — same colour but separate regions (eyes vs
  // shoes) become distinct parts you can recolour independently.
  function autoClusterRegions() {
    if (!faceData.current) return;
    applyClustering(clusterConnected(faceData.current, clusterK));
  }

  // assign a list of faces to the selected part, then tint. Editing implies the
  // part view — flip to it (and full-retint) on the first edit from 'original'.
  function assignFaces(faces) {
    const sel = selectedRef.current;
    if (sel == null) return;
    const target = partsRef.current.findIndex(p => p.id === sel);
    if (target < 0) return;
    const fp = faceParts.current;
    for (const f of faces) fp[f] = target;
    if (viewRef.current !== 'parts') { viewRef.current = 'parts'; setView('parts'); retint(); }
    else retint(faces);
  }

  function floodFill(startFace) {
    if (startFace == null || !faceData.current) return;
    assignFaces(floodFillFaces(faceData.current, startFace, { colorTol, creaseDeg }));
    recount(); computeOutline();
  }

  function paintAt(faceIndex, point) {
    if (faceIndex == null || !faceData.current) return;
    assignFaces(brushFaces(faceData.current, faceIndex, point, brushRadius));
  }
  // brush stroke finished — refresh counts + the selection outline once (not per move).
  function endBrush() { recount(); computeOutline(); }

  // ----- parts panel
  function addPart() {
    const id = `p${partSeq.current++}`;
    const color = PALETTE[parts.length % PALETTE.length];
    setParts(prev => [...prev, { id, label: `Part ${prev.length + 1}`, color, finish: 'matte', group: '', editable: false }]);
    setSelectedId(id);
  }
  function updatePart(id, patch) {
    setParts(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p));
    setTimeout(retint, 0);
  }
  // Expose = whether the customer can recolour this in the designer. Parts sharing
  // a group name are one control, so toggling one propagates to its group-mates.
  function toggleExpose(id) {
    setParts(prev => {
      const part = prev.find(p => p.id === id);
      if (!part) return prev;
      const next = !part.editable;
      const grp = part.group?.trim();
      return prev.map(p => (p.id === id || (grp && p.group?.trim() === grp)) ? { ...p, editable: next } : p);
    });
  }
  function removePart(id) {
    if (parts.length <= 1) return;
    const idx = parts.findIndex(p => p.id === id);
    const next = parts.filter(p => p.id !== id);
    // reassign any faces on the removed part to part 0; shift indices above idx down.
    const fp = faceParts.current;
    for (let f = 0; f < fp.length; f++) {
      if (fp[f] === idx) fp[f] = 0;
      else if (fp[f] > idx) fp[f] -= 1;
    }
    partsRef.current = next;
    setParts(next);
    const sel = next[Math.max(0, idx - 1)].id;
    setSelectedId(sel); selectedRef.current = sel;
    setTimeout(() => { retint(); recount(); }, 0);
  }

  // ----- export / save
  // Recolourable-parts export: one flat-coloured mesh per part, each carrying
  // userData.part + a root part-map (same convention as GLB Studio).
  async function buildPartsBuffer() {
    const fp = faceParts.current;
    const pos = geo.attributes.position.array;
    const root = new THREE.Group();
    const metaParts = [];
    partsRef.current.forEach((part, idx) => {
      const tris = [];
      for (let f = 0; f < fp.length; f++) if (fp[f] === idx) tris.push(f);
      if (!tris.length) return;
      const positions = new Float32Array(tris.length * 9);
      for (let i = 0; i < tris.length; i++) {
        const f = tris[i];
        for (let k = 0; k < 9; k++) positions[i * 9 + k] = pos[f * 9 + k];
      }
      let g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      g = mergeVertices(g);
      g.computeVertexNormals();
      const fin = FINISHES[part.finish] || FINISHES.matte;
      const mat = new THREE.MeshStandardMaterial({ color: part.color, roughness: fin.rough, metalness: fin.metal });
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = part.label;
      mesh.userData.part = part.id;
      mesh.userData.group = part.group || '';
      mesh.userData.editable = !!part.editable;
      root.add(mesh);
      metaParts.push({ id: part.id, label: part.label, default: part.color, finish: part.finish, group: part.group || '', editable: !!part.editable });
    });
    root.userData.parts = metaParts;
    const buffer = await new Promise((res, rej) =>
      new GLTFExporter().parse(root, res, rej, { binary: true, includeCustomExtensions: true }));
    return { buffer, metaParts };
  }

  // Faithful export: the pristine textured GLB, UV-preserving simplified + textures
  // downscaled (see core.buildTexturedScene). No recolourable parts.
  async function buildTexturedBuffer() {
    if (!origScene) throw new Error('No model loaded');
    const root = await buildTexturedScene(origScene, importTris, 1024);
    const buffer = await new Promise((res, rej) =>
      new GLTFExporter().parse(root, res, rej, { binary: true }));
    return { buffer, metaParts: [] };
  }

  function buildGLBBuffer() {
    return exportMode === 'textured' ? buildTexturedBuffer() : buildPartsBuffer();
  }

  async function exportGLB() {
    if (!geo) return;
    setBusy(true); setError(null);
    try {
      const { buffer } = await buildGLBBuffer();
      const blob = new Blob([buffer], { type: 'model/gltf-binary' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (name.trim() ? name.trim().replace(/\s+/g, '-') : 'model') + '.glb';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setError(`Export failed: ${e.message}`); }
    finally { setBusy(false); }
  }

  function toggleZone(z) {
    setZones(prev => prev.includes(z) ? prev.filter(x => x !== z) : [...prev, z]);
    setPlacementConfig(pc => ({ ...pc, [z]: pc[z] ?? 'stand' }));
  }
  function setZonePlacement(z, m) { setPlacementConfig(prev => ({ ...prev, [z]: m })); }

  async function handleSaveElement() {
    if (!geo) return setSaveMsg({ ok: false, text: 'Import a GLB first' });
    if (!name.trim()) return setSaveMsg({ ok: false, text: 'Enter a name' });
    if (!elementTypeId) return setSaveMsg({ ok: false, text: 'Select an element type' });
    if (!zones.length) return setSaveMsg({ ok: false, text: 'Select at least one zone' });
    setBusy(true); setSaveMsg(null);
    try {
      const glCanvas = previewRef.current?.querySelector('canvas');
      if (!glCanvas) throw new Error('Preview not ready — try again');
      const rawThumb = await new Promise(r => glCanvas.toBlob(r, 'image/png'));
      let thumbBlob = rawThumb;
      try { thumbBlob = await removeBg(rawThumb); } catch (e) { console.warn('remove.bg failed:', e.message); }

      const { buffer, metaParts } = await buildGLBBuffer();
      const glbBlob = new Blob([buffer], { type: 'model/gltf-binary' });
      const { url: fu, key: fk } = await getSignedUploadUrl('elements/files/3D', `${crypto.randomUUID()}.glb`, 'model/gltf-binary');
      await uploadToR2(fu, glbBlob);
      const { url: tu, key: tk } = await getSignedUploadUrl('elements/thumbnails', `${crypto.randomUUID()}.png`, 'image/png');
      await uploadToR2(tu, thumbBlob);

      await createGlobalElement({
        name: name.trim(),
        element_type_id: elementTypeId,
        parent_id: null,
        image_url: fk,
        thumbnail_url: tk,
        allowed_zones: zones,
        placement_config: { ...placementConfig, r: topperSize, _model: { parts: metaParts, mode: exportMode, source: 'glb-recompose' } },
        allowed_actions: capabilities,
        default_color: exportMode === 'parts' ? (parts[0]?.color ?? null) : null,
        sort_order: 0,
      });
      setSaveMsg({ ok: true, text: 'Saved as element!' });
    } catch (e) { setSaveMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  }

  const activeParts = parts.filter(p => (counts[parts.indexOf(p)] || 0) > 0);
  const groupNames = [...new Set(parts.map(p => (p.group || '').trim()).filter(Boolean))];
  // customer-facing controls = distinct exposed groups (grouped parts collapse to
  // one control by group name; an exposed ungrouped part is its own control by label).
  const customerControls = [...new Set(parts.filter(p => p.editable).map(p => (p.group || '').trim() || p.label))];

  return (
    <div style={S.page}>
      <div style={S.title}>GLB Recompose</div>
      <div style={S.sub}>Split a fused mesh (e.g. Meshy) into recolourable parts — auto colour-cluster, click to fill, brush to fix.</div>

      <div style={S.layout}>
        {/* LEFT — import + tools */}
        <div style={S.colCard}>
          <div style={S.section}>
            <div style={S.sectionTitle}>Import</div>
            <label style={S.pickBtn}>
              {busy ? 'Working…' : 'Import fused GLB'}
              <input type="file" accept=".glb,.gltf" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; importFile(f); }} />
            </label>
            <div style={{ marginTop: 12 }}>
              <label style={S.elLabel}>Simplify on import — target {importTris.toLocaleString()} tris</label>
              <input type="range" min={8000} max={150000} step={2000} value={importTris}
                onChange={e => setImportTris(+e.target.value)} style={{ width: '100%' }} disabled={!!geo} />
              {geo && <div style={S.hint}>Re-import to change the budget.</div>}
            </div>
            {stats && <div style={S.hint}>Working mesh: {stats.tris.toLocaleString()} tris</div>}
            {error && <div style={S.err}>{error}</div>}
          </div>

          {geo && (
            <>
              <div style={S.section}>
                <div style={S.sectionTitle}>View</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[['original', 'Original'], ['parts', 'Parts']].map(([v, l]) => (
                    <button key={v} onClick={() => setView(v)} style={S.modeBtn(view === v)}>{l}</button>
                  ))}
                </div>
                <div style={S.hint}>Original shows the GLB's baked colours; Parts shows your segmentation.</div>
              </div>

              <div style={S.section}>
                <div style={S.sectionTitle}>Tool</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[['orbit', 'Orbit'], ['fill', 'Fill'], ['brush', 'Brush']].map(([t, l]) => (
                    <button key={t} onClick={() => setTool(t)} style={S.modeBtn(tool === t)}>{l}</button>
                  ))}
                </div>
                <div style={S.hint}>
                  {tool === 'orbit' && 'Drag to rotate the model.'}
                  {tool === 'fill' && 'Click a region — fills until colour or a crease changes.'}
                  {tool === 'brush' && 'Drag over the surface to paint the selected part.'}
                </div>
              </div>

              {tool === 'fill' && (
                <div style={S.section}>
                  <label style={S.elLabel}>Colour tolerance (ΔE {colorTol})</label>
                  <input type="range" min={2} max={60} value={colorTol} onChange={e => setColorTol(+e.target.value)} style={{ width: '100%' }} />
                  <label style={S.elLabel}>Crease stop ({creaseDeg}°)</label>
                  <input type="range" min={5} max={120} value={creaseDeg} onChange={e => setCreaseDeg(+e.target.value)} style={{ width: '100%' }} />
                </div>
              )}
              {tool === 'brush' && (
                <div style={S.section}>
                  <label style={S.elLabel}>Brush radius ({brushRadius.toFixed(2)})</label>
                  <input type="range" min={0.02} max={0.5} step={0.01} value={brushRadius} onChange={e => setBrushRadius(+e.target.value)} style={{ width: '100%' }} />
                </div>
              )}

              <div style={S.section}>
                <div style={S.sectionTitle}>Auto pre-fill</div>
                <label style={S.elLabel}>Colour clusters (K = {clusterK})</label>
                <input type="range" min={2} max={24} value={clusterK} onChange={e => setClusterK(+e.target.value)} style={{ width: '100%' }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                  <button style={S.addBtn} onClick={autoCluster} disabled={busy}>Cluster by colour</button>
                  <button style={S.addBtn} onClick={autoClusterRegions} disabled={busy}>Cluster + split regions</button>
                </div>
                <div style={S.hint}>
                  Cluster by colour: K colour groups (same colour anywhere = one part).
                  Cluster + split regions: also separates same-coloured but disconnected regions (eyes vs shoes) into their own parts.
                </div>
              </div>
            </>
          )}
        </div>

        {/* CENTER — viewport */}
        <div style={S.card}>
          <div ref={previewRef} style={{ height: 520, borderRadius: 12, overflow: 'hidden', background: '#E8EDE9', cursor: tool === 'orbit' ? 'grab' : 'crosshair' }}>
            <Canvas gl={{ preserveDrawingBuffer: true, alpha: true }} camera={{ position: [0, 0.6, 4], fov: 40 }}>
              <Scene geometry={geo} originalObject={origScene} view={view} outline={outline} toolRef={toolRef} tool={tool} controlsRef={controlsRef}
                ambientInt={ambientInt} keyInt={keyInt} fillInt={fillInt}
                onFill={floodFill} onBrushStart={paintAt} onBrushMove={paintAt} onBrushEnd={endBrush} />
            </Canvas>
          </div>
          {!geo && <div style={{ ...S.hint, textAlign: 'center' }}>Import a fused GLB to begin.</div>}
        </div>

        {/* RIGHT — parts + save */}
        <div style={S.colCard}>
          {geo && (
            <>
              <div style={S.section}>
                <div style={S.sectionTitle}>Parts</div>
                <datalist id="grp-names">{groupNames.map(g => <option key={g} value={g} />)}</datalist>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {parts.map((p, idx) => (
                    <div key={p.id} style={{ ...S.partCard, borderColor: selectedId === p.id ? '#3D5A44' : '#E2E8E4' }}
                      onClick={() => setSelectedId(p.id)}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input type="color" value={p.color} onClick={e => e.stopPropagation()}
                          onChange={e => updatePart(p.id, { color: e.target.value })} style={S.swatch} />
                        <input value={p.label} onClick={e => e.stopPropagation()}
                          onChange={e => updatePart(p.id, { label: e.target.value })} style={S.labelInput} />
                        <span style={{ fontSize: 11, color: '#9BB5A2', fontWeight: 700, minWidth: 30, textAlign: 'right' }}>{counts[idx] || 0}</span>
                        <button onClick={e => { e.stopPropagation(); removePart(p.id); }} style={S.delBtn} disabled={parts.length <= 1}>×</button>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                        <select value={p.finish} onClick={e => e.stopPropagation()}
                          onChange={e => updatePart(p.id, { finish: e.target.value })} style={S.miniSelect}>
                          {Object.entries(FINISHES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                        </select>
                        <input list="grp-names" value={p.group || ''} placeholder="Group (e.g. Dress)" onClick={e => e.stopPropagation()}
                          onChange={e => updatePart(p.id, { group: e.target.value })} style={S.groupInput} />
                        <label onClick={e => e.stopPropagation()} title="Let the customer recolour this in the designer"
                          style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: p.editable ? '#2C4433' : '#9BB5A2', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                          <input type="checkbox" checked={!!p.editable} onChange={() => toggleExpose(p.id)} /> Show
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
                <button style={S.addBtn} onClick={addPart}>Add part</button>
                <div style={S.hint}>
                  Select a part, then Fill/Brush assigns faces to it. Give parts the same Group name to recolour them together; tick Show to let the customer recolour that group in the designer.
                </div>
                {customerControls.length > 0 && (
                  <div style={{ marginTop: 10, padding: '8px 12px', background: '#E8EDE9', borderRadius: 8, fontSize: 12, fontWeight: 700, color: '#2C4433' }}>
                    Customer controls: {customerControls.join(', ')}
                  </div>
                )}
              </div>

              <div style={S.section}>
                <div style={S.sectionTitle}>Export mode</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[['parts', 'Recolourable parts'], ['textured', 'Textured (faithful)']].map(([m, l]) => (
                    <button key={m} onClick={() => setExportMode(m)} style={S.modeBtn(exportMode === m)}>{l}</button>
                  ))}
                </div>
                <div style={S.hint}>
                  {exportMode === 'parts'
                    ? 'Each part exports as a flat colour bakers can change. Loses fine texture detail.'
                    : 'Exports the original texture (lace, glitter) — faithful to the model, but not recolourable.'}
                </div>
                <button style={S.exportBtn(busy || !geo)} onClick={exportGLB} disabled={busy || !geo}>Export GLB</button>
              </div>

              <div style={{ ...S.section, marginBottom: 0 }}>
                <div style={S.sectionTitle}>Save as Element</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div>
                    <label style={S.elLabel}>Name</label>
                    <input style={S.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Unicorn Topper" />
                  </div>
                  <div>
                    <label style={S.elLabel}>Element Type</label>
                    <select style={S.input} value={elementTypeId} onChange={e => setElementTypeId(e.target.value)}>
                      <option value="">Select type…</option>
                      {elementTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <div style={S.elLabel}>Zones</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {ZONES.map(z => (
                        <button key={z} onClick={() => toggleZone(z)} style={S.zoneChip(zones.includes(z))}>{z.replace(/_/g, ' ')}</button>
                      ))}
                    </div>
                  </div>
                  {zones.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {zones.map(z => {
                        const cur = placementConfig[z] ?? 'stand';
                        return (
                          <div key={z} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#F4F8F5', borderRadius: 8, padding: '8px 12px' }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: '#2C4433' }}>{z.replace(/_/g, ' ')}</span>
                            <div style={{ display: 'flex', gap: 6 }}>
                              {['hug', 'stand'].map(m => (
                                <button key={m} onClick={() => setZonePlacement(z, m)} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, background: cur === m ? '#3D5A44' : '#E8EDE9', color: cur === m ? '#fff' : '#6B8C74' }}>{m === 'hug' ? 'Hug' : 'Stand'}</button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div>
                    <div style={S.elLabel}>Capabilities (designer edit controls)</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {[['resize', 'Resize'], ['duplicate', 'Duplicate'], ['color', 'Recolor'], ['delete', 'Delete'], ['move', 'Move'], ['tilt', 'Tilt']].map(([key, label]) => (
                        <button key={key} onClick={() => setCapabilities(c => ({ ...c, [key]: !c[key] }))} style={S.zoneChip(capabilities[key])}>{label}</button>
                      ))}
                    </div>
                  </div>
                  <button style={S.exportBtn(busy)} onClick={handleSaveElement} disabled={busy}>{busy ? 'Working…' : 'Save as Element'}</button>
                  {saveMsg && <div style={saveMsg.ok ? { ...S.err, background: '#E8F5E9', color: '#2E7D32' } : S.err}>{saveMsg.text}</div>}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function range(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = i; return a; }

const S = {
  page: { minHeight: '100vh', background: '#EDEAE2', fontFamily: 'Quicksand, sans-serif', padding: '32px 24px' },
  title: { fontSize: 22, fontWeight: 800, color: '#2C4433', marginBottom: 6 },
  sub: { fontSize: 13, color: '#6B8C74', fontWeight: 600, marginBottom: 24 },
  layout: { display: 'grid', gridTemplateColumns: '300px minmax(0, 1fr) 340px', gap: 20, maxWidth: 1560, margin: '0 auto', alignItems: 'start' },
  colCard: { background: '#fff', borderRadius: 18, border: '1.5px solid #C5D4C8', padding: 22 },
  card: { background: '#fff', borderRadius: 18, border: '1.5px solid #C5D4C8', padding: 22 },
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 11, fontWeight: 700, color: '#6B8C74', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 },
  pickBtn: { display: 'block', padding: '14px 18px', borderRadius: 12, border: '2px dashed #C5D4C8', background: '#F4F8F5', color: '#3D5A44', fontFamily: 'Quicksand, sans-serif', fontSize: 14, fontWeight: 700, cursor: 'pointer', textAlign: 'center' },
  err: { marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, background: '#FFF0F0', color: '#C0392B' },
  miniSelect: { padding: '4px 6px', borderRadius: 6, border: '1.5px solid #C5D4C8', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, color: '#2C4433', background: '#fff' },
  partRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', background: '#F4F8F5', borderRadius: 8 },
  partCard: { display: 'flex', flexDirection: 'column', padding: '8px 10px', background: '#F4F8F5', borderRadius: 8, border: '1.5px solid #E2E8E4', cursor: 'pointer' },
  groupInput: { flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 6, border: '1.5px solid #C5D4C8', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, color: '#2C4433', background: '#fff' },
  swatch: { width: 30, height: 30, borderRadius: 8, border: '1.5px solid #C5D4C8', cursor: 'pointer', padding: 2, background: '#fff', flexShrink: 0 },
  labelInput: { flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 6, border: '1.5px solid #C5D4C8', fontFamily: 'Quicksand, sans-serif', fontSize: 13, fontWeight: 700, color: '#2C4433', background: '#fff' },
  delBtn: { width: 24, height: 24, borderRadius: 6, border: 'none', background: '#F0E0E0', color: '#C0392B', cursor: 'pointer', fontWeight: 800, flexShrink: 0 },
  addBtn: { marginTop: 10, padding: '8px 14px', borderRadius: 8, border: '1.5px solid #C5D4C8', background: '#fff', color: '#3D5A44', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  modeBtn: (a) => ({ flex: 1, padding: '8px 6px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, background: a ? '#3D5A44' : '#E8EDE9', color: a ? '#fff' : '#6B8C74' }),
  input: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontFamily: 'Quicksand, sans-serif', fontSize: 14, fontWeight: 600, color: '#2C4433', background: '#fff', boxSizing: 'border-box', outline: 'none' },
  elLabel: { fontSize: 12, fontWeight: 700, color: '#6B8C74', display: 'block', marginBottom: 6, marginTop: 6 },
  zoneChip: (a) => ({ padding: '6px 12px', borderRadius: 20, border: `1.5px solid ${a ? '#3D5A44' : '#C5D4C8'}`, background: a ? '#E8EDE9' : '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: a ? '#2C4433' : '#6B8C74' }),
  exportBtn: (d) => ({ width: '100%', padding: '13px 0', borderRadius: 10, border: 'none', background: d ? '#9BB5A2' : '#3D5A44', color: '#fff', fontFamily: 'Quicksand, sans-serif', fontSize: 15, fontWeight: 800, cursor: d ? 'not-allowed' : 'pointer', marginTop: 12 }),
  hint: { fontSize: 11, color: '#9BB5A2', fontWeight: 600, marginTop: 8 },
};
