import { useState, useEffect, useRef, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, useGLTF, Environment } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  fetchAdminElementTypes, fetchAllElements, fetchParentElements,
  getSignedUploadUrl, uploadToR2, updateGlobalElement, removeBg,
} from '../lib/api.js';

const CAKE_ZONES = [
  { value: 'top_surface', label: 'Top Surface' },
  { value: 'side',        label: 'Side' },
  { value: 'middle_tier', label: 'Middle Tier' },
  { value: 'board',       label: 'Board' },
];

// ── Styles ────────────────────────────────────────────────────────────────────
const s = {
  page: {
    minHeight: '100vh', background: '#EDEAE2',
    fontFamily: "'Quicksand', sans-serif", padding: '40px 32px',
  },
  title: { fontSize: 20, fontWeight: 800, color: '#2C4433', marginBottom: 28 },
  layout: { display: 'flex', gap: 24, alignItems: 'flex-start' },

  // Left list panel
  listPanel: {
    width: 260, flexShrink: 0,
    background: '#fff', borderRadius: 16,
    border: '1.5px solid #C5D4C8',
    overflow: 'hidden',
  },
  listSearch: {
    padding: '10px 12px',
    borderBottom: '1px solid #C5D4C8',
  },
  searchInput: {
    width: '100%', padding: '7px 10px',
    border: '1.5px solid #C5D4C8', borderRadius: 8,
    fontSize: 12, fontFamily: "'Quicksand', sans-serif",
    color: '#2C4433', outline: 'none', boxSizing: 'border-box',
  },
  listScroll: {
    maxHeight: 'calc(100vh - 180px)', overflowY: 'auto',
  },
  typeGroup: { borderBottom: '1px solid #EEF0EC' },
  typeHeader: {
    padding: '8px 14px 6px',
    fontSize: 9, fontWeight: 800, color: '#9BB5A2',
    letterSpacing: 1.5, textTransform: 'uppercase',
    background: '#F4F8F5',
  },
  elementRow: (active) => ({
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 14px', cursor: 'pointer',
    background: active ? '#E8EDE9' : '#fff',
    borderLeft: active ? '3px solid #3D5A44' : '3px solid transparent',
    transition: 'background 0.1s',
  }),
  elementThumb: {
    width: 36, height: 36, borderRadius: 6, objectFit: 'cover',
    background: 'transparent',
    flexShrink: 0,
  },
  elementName: {
    fontSize: 12, fontWeight: 700, color: '#2C4433',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  inactiveBadge: {
    fontSize: 9, fontWeight: 700, color: '#999',
    background: '#f0f0f0', borderRadius: 4, padding: '1px 5px',
  },

  // Right edit panel
  editPanel: {
    flex: 1, minWidth: 0,
    background: '#fff', borderRadius: 16,
    border: '1.5px solid #C5D4C8',
    padding: 32,
  },
  editHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 24,
  },
  editTitle: { fontSize: 16, fontWeight: 800, color: '#2C4433' },
  activeToggle: (active) => ({
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 12, fontWeight: 700,
    color: active ? '#3D5A44' : '#999', cursor: 'pointer',
  }),

  // Form fields (same as AddElement)
  field: { marginBottom: 20 },
  label: {
    display: 'block', fontSize: 11, fontWeight: 700,
    color: '#3D5A44', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6,
  },
  input: {
    width: '100%', padding: '9px 12px', border: '1.5px solid #C5D4C8', borderRadius: 8,
    fontSize: 13, fontFamily: "'Quicksand', sans-serif", color: '#2C4433',
    outline: 'none', boxSizing: 'border-box',
  },
  select: {
    width: '100%', padding: '8px 10px', border: '1.5px solid #C5D4C8', borderRadius: 8,
    fontSize: 13, fontFamily: "'Quicksand', sans-serif", color: '#2C4433',
    background: '#fff', outline: 'none', boxSizing: 'border-box',
  },
  checkRow:   { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' },
  checkbox:   { width: 18, height: 18, accentColor: '#3D5A44', cursor: 'pointer' },
  checkLabel: { fontSize: 13, fontWeight: 700, color: '#2C4433' },

  // Asset sections
  currentAsset: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '10px 12px', borderRadius: 10,
    background: '#F4F8F5', border: '1.5px solid #C5D4C8',
    marginBottom: 10,
  },
  currentThumb: {
    width: 56, height: 56, borderRadius: 8, objectFit: 'cover',
    background: 'repeating-conic-gradient(#d0d8d2 0% 25%, #f7f9f7 0% 50%) 0 0 / 8px 8px',
    flexShrink: 0, border: '1px solid #C5D4C8',
  },
  fileBox: {
    width: '100%', padding: '16px', border: '1.5px dashed #C5D4C8', borderRadius: 10,
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    background: '#f7f9f7', cursor: 'pointer', boxSizing: 'border-box', marginTop: 6,
  },
  previewBox: {
    width: '100%', height: 380, borderRadius: 10, overflow: 'hidden',
    border: '1.5px solid #C5D4C8', marginBottom: 8, background: '#f7f9f7',
  },
  thumbPreview: {
    width: '100%', height: 120, borderRadius: 10, overflow: 'hidden',
    border: '1.5px solid #C5D4C8', marginBottom: 8,
    background: 'repeating-conic-gradient(#d0d8d2 0% 25%, #f7f9f7 0% 50%) 0 0 / 16px 16px',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  spinner: {
    width: 22, height: 22, borderRadius: '50%',
    border: '3px solid #C5D4C8', borderTopColor: '#3D5A44',
    animation: 'spin 0.7s linear infinite',
  },
  smallBtn: {
    padding: '7px 14px', borderRadius: 8, cursor: 'pointer', border: 'none',
    fontSize: 12, fontWeight: 700, fontFamily: "'Quicksand', sans-serif",
    background: '#E8EDE9', color: '#3D5A44', marginBottom: 12,
  },
  btn: (variant = 'primary') => ({
    width: '100%', padding: '11px 0', borderRadius: 10,
    cursor: 'pointer', border: 'none', fontSize: 14, fontWeight: 700,
    fontFamily: "'Quicksand', sans-serif",
    background: variant === 'primary' ? '#3D5A44' : '#E8EDE9',
    color: variant === 'primary' ? '#fff' : '#3D5A44',
  }),
  msg: (ok) => ({
    fontSize: 13, fontWeight: 600, textAlign: 'center',
    color: ok ? '#3D5A44' : '#c00', marginTop: 12,
  }),
  empty: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: 300, color: '#9BB5A2', fontSize: 14, fontWeight: 600,
  },
};

// ── Geometry sphere preview (same as AddElement) ─────────────────────────────
function GeomSpherePreview({ color, roughness, metalness, envPreset, canvasRef, onCapture }) {
  return (
    <div style={s.previewBox} ref={canvasRef}>
      <Canvas flat gl={{ preserveDrawingBuffer: true }} camera={{ position: [0, 0, 2.5], fov: 45 }}
        onCreated={() => setTimeout(onCapture, 600)}>
        <ambientLight intensity={envPreset === 'none' ? 1.2 : 0.3} />
        <directionalLight position={[3, 3, 3]} intensity={envPreset === 'none' ? 1 : 0.3} />
        <directionalLight position={[-2, 1, -2]} intensity={0.4} />
        <mesh>
          <sphereGeometry args={[0.85, 64, 64]} />
          <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} />
        </mesh>
        {envPreset !== 'none' && <Environment preset={envPreset} />}
        <OrbitControls enablePan={false} />
      </Canvas>
    </div>
  );
}

// ── GLB components (same as AddElement) ──────────────────────────────────────
function GLBModel({ url, color, roughness, metalness, rotation, onLoad, onTextureDetected, onMaterialRead }) {
  const { scene } = useGLTF(url);
  const { camera, controls } = useThree();

  useEffect(() => {
    if (!scene) return;
    let hasAnyTexture = false;
    let firstMat = null;
    scene.traverse(obj => {
      if (!obj.isMesh) return;
      const mat = obj.material;
      if (!firstMat) firstMat = mat;
      if (mat && (mat.map || mat.normalMap || mat.roughnessMap)) hasAnyTexture = true;
    });
    onTextureDetected?.(hasAnyTexture);
    if (firstMat && onMaterialRead) {
      onMaterialRead({
        roughness: firstMat.roughness ?? 0.6,
        metalness: firstMat.metalness ?? 0,
        color: firstMat.color ? '#' + firstMat.color.getHexString() : null,
      });
    }
  }, [scene]);

  useEffect(() => {
    if (!scene) return;
    scene.traverse(obj => {
      if (!obj.isMesh) return;
      const mat = obj.material;
      if (color) {
        obj.material = new THREE.MeshStandardMaterial({ color, roughness, metalness });
      } else if (mat) {
        mat.roughness = roughness;
        mat.metalness = metalness;
        mat.needsUpdate = true;
      }
    });
  }, [scene, color, roughness, metalness]);

  useEffect(() => {
    if (!scene) return;
    const box    = new THREE.Box3().setFromObject(scene);
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist   = maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360)) * 1.6;
    camera.position.set(center.x, center.y, center.z + dist);
    camera.near = dist / 100;
    camera.far  = dist * 100;
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    if (controls) { controls.target.copy(center); controls.update(); }
    const t = setTimeout(onLoad, 800);
    return () => clearTimeout(t);
  }, [scene]);

  const DEG = Math.PI / 180;
  return (
    <group rotation={[(rotation?.[0] ?? 0) * DEG, (rotation?.[1] ?? 0) * DEG, (rotation?.[2] ?? 0) * DEG]}>
      <primitive object={scene} />
    </group>
  );
}

// Accepts either a File object or a URL string
function GLBPreview({ file, url, color, roughness, metalness, envPreset, rotation, canvasRef, onCapture, onTextureDetected, onMaterialRead }) {
  const [objectUrl, setObjectUrl] = useState(null);
  const [panMode, setPanMode]     = useState(false);

  useEffect(() => {
    if (!file) { setObjectUrl(null); return; }
    const u = URL.createObjectURL(file);
    setObjectUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const glbUrl = file ? objectUrl : url;
  if (!glbUrl) return null;

  const mouseButtons = panMode
    ? { LEFT: THREE.MOUSE.PAN,    RIGHT: THREE.MOUSE.ROTATE }
    : { LEFT: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };

  return (
    <div style={{ position: 'relative' }}>
      <div style={s.previewBox} ref={canvasRef}>
        <Canvas flat gl={{ preserveDrawingBuffer: true }} camera={{ position: [0, 1, 3], fov: 45 }}>
          <ambientLight intensity={envPreset === 'none' ? 1 : 0.3} />
          <directionalLight position={[2, 2, 2]}  intensity={envPreset === 'none' ? 0.6 : 0.2} />
          <directionalLight position={[-2, 1, -2]} intensity={envPreset === 'none' ? 0.4 : 0.1} />
          <Suspense fallback={null}>
            <GLBModel
              url={glbUrl}
              color={color}
              roughness={roughness}
              metalness={metalness}
              rotation={rotation}
              onLoad={onCapture}
              onTextureDetected={onTextureDetected}
              onMaterialRead={onMaterialRead}
            />
            {envPreset !== 'none' && <Environment preset={envPreset} />}
          </Suspense>
          <OrbitControls enablePan makeDefault mouseButtons={mouseButtons} />
        </Canvas>
      </div>
      <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 4 }}>
        {['Rotate', 'Pan'].map(mode => (
          <button key={mode} onClick={() => setPanMode(mode === 'Pan')}
            style={{
              padding: '4px 10px', borderRadius: 6, border: 'none', cursor: 'pointer',
              fontSize: 11, fontWeight: 700, fontFamily: "'Quicksand', sans-serif",
              background: (panMode ? 'Pan' : 'Rotate') === mode ? '#3D5A44' : '#E8EDE9',
              color:      (panMode ? 'Pan' : 'Rotate') === mode ? '#fff'    : '#3D5A44',
            }}>
            {mode}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ManageElements() {
  const [elementTypes, setElementTypes] = useState([]);
  const [elements,     setElements]     = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [query,        setQuery]        = useState('');
  const [selectedId,   setSelectedId]   = useState(null);

  // Derive selected element from list (auto-updates after reload)
  const selectedEl = elements.find(e => e.id === selectedId) ?? null;

  // Form state
  const [name,             setName]             = useState('');
  const [elementTypeId,    setElementTypeId]    = useState('');
  const [applicableZones,  setApplicableZones]  = useState([]);
  const [isParent,         setIsParent]         = useState(false);
  const [parentId,         setParentId]         = useState('');
  const [parentOptions,    setParentOptions]    = useState([]);
  const [capabilities,     setCapabilities]     = useState({ resize: true, duplicate: true, color: false, delete: true });
  const [defaultColor,     setDefaultColor]     = useState('#F0DEB8');
  const [isActive,         setIsActive]         = useState(true);

  // File replacements
  const [newAssetFile,     setNewAssetFile]     = useState(null);
  const [newThumbBlob,     setNewThumbBlob]     = useState(null);
  const [removingBg,       setRemovingBg]       = useState(false);
  const [glbColor,         setGlbColor]         = useState('#F0DEB8');
  const [userPickedColor,  setUserPickedColor]  = useState(false);
  const [glbRoughness,     setGlbRoughness]     = useState(0.6);
  const [glbMetalness,     setGlbMetalness]     = useState(0);
  const [glbEnvPreset,     setGlbEnvPreset]     = useState('none');

  const [placementConfig,  setPlacementConfig]  = useState('{}');
  const [description,      setDescription]      = useState('');
  const [glbRotation,      setGlbRotation]      = useState([0, 0, 0]);
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState(null);
  const canvasRef = useRef();

  useEffect(() => { loadAll(); }, []);

  useEffect(() => {
    if (!elementTypeId || isParent) { setParentOptions([]); return; }
    fetchParentElements(elementTypeId)
      .then(setParentOptions)
      .catch(() => setParentOptions([]));
  }, [elementTypeId, isParent]);

  async function loadAll() {
    setLoading(true);
    try {
      const [types, els] = await Promise.all([fetchAdminElementTypes(), fetchAllElements()]);
      setElementTypes(types);
      setElements(els);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function selectElement(el) {
    setSelectedId(el.id);
    setName(el.name);
    setElementTypeId(el.element_type_id);
    setApplicableZones(el.allowed_zones ?? []);
    setIsParent(!el.parent_id);
    setParentId(el.parent_id ?? '');
    setCapabilities(el.allowed_actions ?? { resize: true, duplicate: true, color: false, delete: true });
    setDefaultColor(el.default_color ?? '#F0DEB8');
    setIsActive(el.is_active ?? true);
    setNewAssetFile(null);
    setNewThumbBlob(null);
    setMsg(null);
    setUserPickedColor(false);
    setGlbColor('#F0DEB8');
    const pc = el.placement_config ?? {};
    setPlacementConfig(JSON.stringify(pc, null, 2));
    setGlbRoughness(pc.roughness ?? 0.6);
    setGlbMetalness(pc.metalness ?? 0.15);
    setGlbEnvPreset('none');
    setGlbRotation(pc.rotation ?? [0, 0, 0]);
    setDescription(el.description ?? '');
  }

  async function processRemoveBg(blob) {
    setRemovingBg(true);
    setNewThumbBlob(null);
    try {
      const processed = await removeBg(blob);
      setNewThumbBlob(processed);
    } catch {
      setNewThumbBlob(blob);
    } finally {
      setRemovingBg(false);
    }
  }

  function captureThumbnail() {
    const canvas = canvasRef.current?.querySelector('canvas');
    if (!canvas) return;
    canvas.toBlob(blob => processRemoveBg(blob), 'image/png');
  }

  async function handleSave() {
    if (!selectedEl || !name.trim()) {
      setMsg({ ok: false, text: 'Name is required.' });
      return;
    }
    setSaving(true);
    setMsg(null);

    try {
      let parsedConfig = {};
      try { parsedConfig = JSON.parse(placementConfig); } catch { /* keep empty */ }
      if (glbRotation.some(v => v !== 0)) parsedConfig.rotation = glbRotation;
      else delete parsedConfig.rotation;

      const updates = {
        name:             name.trim(),
        element_type_id:  elementTypeId,
        parent_id:        isParent ? null : (parentId || null),
        allowed_zones:    applicableZones,
        allowed_actions:  capabilities,
        default_color:    defaultColor || null,
        is_active:        isActive,
        placement_config: parsedConfig,
      };

      // Upload new asset file if provided → always a new R2 key
      if (newAssetFile) {
        const ext = newAssetFile.name.split('.').pop();
        const folder = /\.(glb|gltf)$/i.test(newAssetFile.name) ? 'elements/files/3D' : 'elements/files/2D';
        const filename = `${crypto.randomUUID()}.${ext}`;
        const contentType = newAssetFile.type || (folder.includes('3D') ? 'model/gltf-binary' : 'image/png');
        const { url, key } = await getSignedUploadUrl(folder, filename, contentType);
        await uploadToR2(url, newAssetFile);
        updates.image_url = key;
      }

      // Upload new thumbnail if provided → always a new R2 key
      if (newThumbBlob) {
        const filename = `${crypto.randomUUID()}.png`;
        const { url, key } = await getSignedUploadUrl('elements/thumbnails', filename, 'image/png');
        await uploadToR2(url, newThumbBlob);
        updates.thumbnail_url = key;
      }

      updates.description = description;
      await updateGlobalElement(selectedEl.id, updates);

      setMsg({ ok: true, text: 'Saved!' });
      setNewAssetFile(null);
      setNewThumbBlob(null);
      await loadAll();
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  }

  const isGlb  = selectedEl && (
    /\.(glb|gltf)(\?|$)/i.test(selectedEl.image_url ?? '') ||
    /\/3D\//i.test(selectedEl.image_url ?? '')
  );
  const isGeom = selectedEl && !selectedEl.image_url &&
    selectedEl.placement_config?.top_surface === 'faux_balls';

  // Filter + group elements
  const lowerQuery = query.toLowerCase();
  const grouped = elementTypes
    .map(et => ({
      type: et,
      items: elements.filter(el =>
        el.element_type_id === et.id &&
        (lowerQuery === '' || (el.name ?? '').toLowerCase().includes(lowerQuery))
      ),
    }))
    .filter(g => g.items.length > 0);

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Quicksand:wght@400;600;700;800&display=swap" rel="stylesheet" />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={s.page}>
        <div style={s.title}>Manage Elements</div>
        <div style={s.layout}>

          {/* ── Left: element list ── */}
          <div style={s.listPanel}>
            <div style={s.listSearch}>
              <input
                style={s.searchInput}
                placeholder="Search elements…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
            </div>
            <div style={s.listScroll}>
              {loading && (
                <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: '#9BB5A2' }}>Loading…</div>
              )}
              {!loading && grouped.length === 0 && (
                <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: '#9BB5A2' }}>No elements found</div>
              )}
              {grouped.map(({ type, items }) => (
                <div key={type.id} style={s.typeGroup}>
                  <div style={s.typeHeader}>{type.name}</div>
                  {items.map(el => (
                    <div key={el.id}
                      style={s.elementRow(el.id === selectedId)}
                      onClick={() => selectElement(el)}>
                      {el.thumbnail_url
                        ? <img src={el.thumbnail_url} alt="" style={s.elementThumb} />
                        : <div style={s.elementThumb} />
                      }
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={s.elementName}>{el.name}</div>
                        {!el.is_active && <span style={s.inactiveBadge}>Inactive</span>}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* ── Right: edit form ── */}
          <div style={s.editPanel}>
            {!selectedEl ? (
              <div style={s.empty}>Select an element to edit</div>
            ) : (
              <>
                <div style={s.editHeader}>
                  <div>
                    <div style={s.editTitle}>Editing: {selectedEl.name}</div>
                    <div
                      title="Click to copy"
                      onClick={() => navigator.clipboard?.writeText(selectedEl.id)}
                      style={{ fontSize: 11, color: '#9BB5A2', fontFamily: 'monospace', marginTop: 3, cursor: 'pointer' }}
                    >
                      {selectedEl.id}
                    </div>
                  </div>
                  <label style={s.activeToggle(isActive)}>
                    <input
                      type="checkbox"
                      checked={isActive}
                      onChange={e => setIsActive(e.target.checked)}
                      style={s.checkbox}
                    />
                    {isActive ? 'Active' : 'Inactive'}
                  </label>
                </div>

                {/* Name */}
                <div style={s.field}>
                  <label style={s.label}>Name</label>
                  <input style={s.input} value={name} onChange={e => setName(e.target.value)} />
                </div>

                {/* Description */}
                <div style={s.field}>
                  <label style={s.label}>Description</label>
                  <textarea
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    rows={2}
                    placeholder="e.g. colorful rainbow arc with fluffy white clouds, great for unicorn and birthday themes"
                    style={{ ...s.input, fontFamily: "'Quicksand', sans-serif", fontSize: 12, resize: 'vertical', lineHeight: 1.5 }}
                  />
                </div>

                {/* Element type */}
                <div style={s.field}>
                  <label style={s.label}>Element Type</label>
                  <select style={s.select} value={elementTypeId}
                    onChange={e => { setElementTypeId(e.target.value); setParentId(''); }}>
                    {elementTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>

                {/* Zones */}
                <div style={s.field}>
                  <label style={s.label}>Applicable Zones</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 20px', marginTop: 4 }}>
                    {CAKE_ZONES.map(z => (
                      <label key={z.value} style={s.checkRow}>
                        <input type="checkbox" style={s.checkbox}
                          checked={applicableZones.includes(z.value)}
                          onChange={() => setApplicableZones(prev =>
                            prev.includes(z.value) ? prev.filter(x => x !== z.value) : [...prev, z.value]
                          )} />
                        <span style={s.checkLabel}>{z.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Parent */}
                <div style={s.field}>
                  <label style={s.checkRow}>
                    <input type="checkbox" style={s.checkbox} checked={isParent}
                      onChange={() => { setIsParent(p => !p); setParentId(''); }} />
                    <span style={s.checkLabel}>Is Parent</span>
                  </label>
                </div>
                {!isParent && elementTypeId && (
                  <div style={s.field}>
                    <label style={s.label}>Parent Element</label>
                    <select style={s.select} value={parentId} onChange={e => setParentId(e.target.value)}>
                      <option value="">Select parent…</option>
                      {parentOptions.filter(p => p.id !== selectedId).map(p =>
                        <option key={p.id} value={p.id}>{p.name}</option>
                      )}
                    </select>
                  </div>
                )}

                {/* ── Asset file ── */}
                <div style={s.field}>
                  <label style={s.label}>Asset File</label>

                  {/* Current asset */}
                  {selectedEl.image_url && !newAssetFile && (
                    <div style={s.currentAsset}>
                      {isGlb
                        ? <span style={{ fontSize: 24 }}>📦</span>
                        : <img src={selectedEl.image_url} alt="" style={{ ...s.currentThumb, objectFit: 'cover' }} />
                      }
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#2C4433', marginBottom: 2 }}>
                          Current {isGlb ? 'GLB' : 'Image'}
                        </div>
                        <div style={{ fontSize: 10, color: '#6B8C74', wordBreak: 'break-all' }}>
                          {selectedEl.image_url.split('/').pop()}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 3D preview — existing or new file */}
                  {isGlb && (
                    <div style={{ marginBottom: 12 }}>
                      {/* Material controls */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <label style={{ ...s.label, marginBottom: 0, minWidth: 80 }}>Color</label>
                          <input type="color" value={glbColor}
                            onChange={e => { setGlbColor(e.target.value); setUserPickedColor(true); }}
                            style={{ width: 36, height: 28, border: '1.5px solid #C5D4C8', borderRadius: 6, cursor: 'pointer', padding: 2 }} />
                          <span style={{ fontSize: 12, color: '#6B8C74', fontWeight: 600 }}>
                            {userPickedColor ? glbColor : 'from GLB'}
                          </span>
                          {userPickedColor && (
                            <button onClick={() => setUserPickedColor(false)}
                              style={{ padding: '2px 8px', borderRadius: 6, border: '1.5px solid #C5D4C8', background: '#fff', color: '#6B8C74', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: "'Quicksand', sans-serif" }}>
                              Reset
                            </button>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <label style={{ ...s.label, marginBottom: 0, minWidth: 80 }}>Roughness</label>
                          <input type="range" min="0" max="1" step="0.01" value={glbRoughness}
                            onChange={e => setGlbRoughness(parseFloat(e.target.value))}
                            style={{ flex: 1, accentColor: '#3D5A44' }} />
                          <span style={{ fontSize: 12, color: '#6B8C74', fontWeight: 600, minWidth: 30 }}>{glbRoughness.toFixed(2)}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <label style={{ ...s.label, marginBottom: 0, minWidth: 80 }}>Metalness</label>
                          <input type="range" min="0" max="1" step="0.01" value={glbMetalness}
                            onChange={e => setGlbMetalness(parseFloat(e.target.value))}
                            style={{ flex: 1, accentColor: '#3D5A44' }} />
                          <span style={{ fontSize: 12, color: '#6B8C74', fontWeight: 600, minWidth: 30 }}>{glbMetalness.toFixed(2)}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <label style={{ ...s.label, marginBottom: 0, minWidth: 80 }}>Environment</label>
                          <select value={glbEnvPreset} onChange={e => setGlbEnvPreset(e.target.value)} style={{ ...s.select, flex: 1 }}>
                            {['none','studio','city','sunset','dawn','warehouse','forest','park','lobby'].map(p => (
                              <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <GLBPreview
                        file={newAssetFile ?? null}
                        url={!newAssetFile ? selectedEl.image_url : null}
                        color={userPickedColor ? glbColor : undefined}
                        roughness={glbRoughness}
                        metalness={glbMetalness}
                        envPreset={glbEnvPreset}
                        rotation={glbRotation}
                        canvasRef={canvasRef}
                        onCapture={captureThumbnail}
                        onTextureDetected={() => {}}
                        onMaterialRead={({ roughness, metalness, color }) => {
                          setGlbRoughness(roughness);
                          setGlbMetalness(metalness);
                          if (color && !userPickedColor) setGlbColor(color);
                        }}
                      />

                      {/* Orientation calibration */}
                      <div style={{ marginTop: 10, padding: '10px 12px', background: '#f5f8f5', borderRadius: 10, border: '1.5px solid #C5D4C8' }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44', marginBottom: 8, fontFamily: "'Quicksand',sans-serif" }}>
                          Orientation — rotate until front faces you and top faces up
                        </div>
                        {[['X', 0, '#e05252'], ['Y', 1, '#52c452'], ['Z', 2, '#5252e0']].map(([axis, idx, axisColor]) => (
                          <div key={axis} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: axisColor, width: 14, flexShrink: 0 }}>{axis}</span>
                            <input type="range" min="0" max="359" step="1"
                              value={glbRotation[idx]}
                              onChange={e => setGlbRotation(r => { const n = [...r]; n[idx] = parseInt(e.target.value); return n; })}
                              style={{ flex: 1, accentColor: axisColor }} />
                            <span style={{ fontSize: 11, color: '#6B8C74', fontWeight: 600, minWidth: 32, textAlign: 'right' }}>{glbRotation[idx]}°</span>
                          </div>
                        ))}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
                          <button onClick={() => setGlbRotation([0, 0, 0])}
                            style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, border: '1.5px solid #C5D4C8', background: '#fff', color: '#6B8C74', cursor: 'pointer', fontWeight: 700, fontFamily: "'Quicksand',sans-serif" }}>
                            Reset
                          </button>
                          <button onClick={captureThumbnail}
                            style={{ fontSize: 11, padding: '5px 12px', borderRadius: 6, border: 'none', background: '#3D5A44', color: '#fff', cursor: 'pointer', fontWeight: 700, fontFamily: "'Quicksand',sans-serif" }}>
                            ✓ This is the front — Set Thumbnail
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Replace file drop zone */}
                  <label style={s.fileBox}>
                    <input type="file"
                      accept={isGlb ? '.glb,.gltf' : 'image/*'}
                      style={{ display: 'none' }}
                      onChange={e => {
                        const f = e.target.files[0];
                        if (!f) return;
                        setNewAssetFile(f);
                        if (!isGlb) processRemoveBg(f);
                        setUserPickedColor(false);
                      }}
                    />
                    <span style={{ fontSize: 12, color: '#6B8C74', fontWeight: 600 }}>
                      {newAssetFile ? `New file: ${newAssetFile.name}` : `Replace ${isGlb ? 'GLB' : 'image'}…`}
                    </span>
                  </label>
                </div>

                {/* ── Thumbnail ── */}
                <div style={s.field}>
                  <label style={s.label}>Thumbnail</label>

                  {/* Show current thumbnail if no replacement yet */}
                  {selectedEl.thumbnail_url && !newThumbBlob && !removingBg && (
                    <div style={s.currentAsset}>
                      <img src={selectedEl.thumbnail_url} alt="" style={s.currentThumb} />
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#2C4433', marginBottom: 2 }}>Current Thumbnail</div>
                        <div style={{ fontSize: 10, color: '#6B8C74' }}>{selectedEl.thumbnail_url.split('/').pop()}</div>
                      </div>
                    </div>
                  )}

                  {/* New thumbnail preview */}
                  {(removingBg || newThumbBlob) && (
                    <div style={s.thumbPreview}>
                      {removingBg ? (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                          <div style={s.spinner} />
                          <span style={{ fontSize: 11, color: '#6B8C74', fontWeight: 600 }}>Removing background…</span>
                        </div>
                      ) : (
                        <img src={URL.createObjectURL(newThumbBlob)} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} alt="new thumbnail" />
                      )}
                    </div>
                  )}

                  {/* Replace thumbnail drop zone */}
                  <label style={{ ...s.fileBox, padding: '12px 16px', marginTop: 6 }}>
                    <input type="file" accept="image/*" style={{ display: 'none' }}
                      onChange={e => { if (e.target.files[0]) processRemoveBg(e.target.files[0]); }} />
                    <span style={{ fontSize: 12, color: '#6B8C74', fontWeight: 600 }}>
                      {newThumbBlob ? 'Replace thumbnail again…' : 'Replace thumbnail…'}
                    </span>
                  </label>
                </div>

                {/* ── Capabilities ── */}
                <div style={s.field}>
                  <label style={s.label}>Capabilities</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
                    {[
                      { key: 'resize',    label: 'Resizable',        hint: '+/− size buttons in edit strip' },
                      { key: 'duplicate', label: 'Duplicatable',     hint: 'Copy button creates another instance' },
                      { key: 'color',     label: 'Color changeable', hint: 'Color picker in designer (GLB only)' },
                      { key: 'delete',    label: 'Deletable',        hint: 'Remove button shown when selected' },
                    ].map(({ key, label, hint }) => (
                      <label key={key} style={{ ...s.checkRow, alignItems: 'flex-start', cursor: 'pointer' }}>
                        <input type="checkbox" style={{ ...s.checkbox, marginTop: 1 }}
                          checked={capabilities[key] ?? false}
                          onChange={e => setCapabilities(c => ({ ...c, [key]: e.target.checked }))} />
                        <div>
                          <div style={s.checkLabel}>{label}</div>
                          <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>{hint}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>

                {/* ── Default color ── */}
                <div style={s.field}>
                  <label style={s.label}>Default Color</label>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <input type="color" value={defaultColor}
                      onChange={e => setDefaultColor(e.target.value)}
                      style={{ width: 40, height: 32, border: '1.5px solid #C5D4C8', borderRadius: 6, cursor: 'pointer', padding: 2 }} />
                    <span style={{ fontSize: 12, color: '#6B8C74', fontWeight: 600 }}>{defaultColor}</span>
                    <button onClick={() => setDefaultColor('')}
                      style={{ padding: '4px 10px', borderRadius: 6, border: '1.5px solid #C5D4C8', background: '#fff', color: '#6B8C74', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: "'Quicksand', sans-serif" }}>
                      Clear
                    </button>
                  </div>
                </div>

                {/* ── 3D Geometry (faux ball) preview ── */}
                {isGeom && (
                  <div style={s.field}>
                    <label style={s.label}>Sphere Preview</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <label style={{ ...s.label, marginBottom: 0, minWidth: 80 }}>Roughness</label>
                        <input type="range" min="0" max="1" step="0.01" value={glbRoughness}
                          onChange={e => {
                            const v = parseFloat(e.target.value);
                            setGlbRoughness(v);
                            try {
                              const pc = JSON.parse(placementConfig);
                              setPlacementConfig(JSON.stringify({ ...pc, roughness: v }, null, 2));
                            } catch {}
                          }}
                          style={{ flex: 1, accentColor: '#3D5A44' }} />
                        <span style={{ fontSize: 12, color: '#6B8C74', fontWeight: 600, minWidth: 30 }}>{glbRoughness.toFixed(2)}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <label style={{ ...s.label, marginBottom: 0, minWidth: 80 }}>Metalness</label>
                        <input type="range" min="0" max="1" step="0.01" value={glbMetalness}
                          onChange={e => {
                            const v = parseFloat(e.target.value);
                            setGlbMetalness(v);
                            try {
                              const pc = JSON.parse(placementConfig);
                              setPlacementConfig(JSON.stringify({ ...pc, metalness: v }, null, 2));
                            } catch {}
                          }}
                          style={{ flex: 1, accentColor: '#3D5A44' }} />
                        <span style={{ fontSize: 12, color: '#6B8C74', fontWeight: 600, minWidth: 30 }}>{glbMetalness.toFixed(2)}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <label style={{ ...s.label, marginBottom: 0, minWidth: 80 }}>Environment</label>
                        <select value={glbEnvPreset} onChange={e => setGlbEnvPreset(e.target.value)} style={{ ...s.select, flex: 1 }}>
                          {['none','studio','city','sunset','dawn','warehouse','forest','park','lobby'].map(p => (
                            <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <GeomSpherePreview
                      color={defaultColor}
                      roughness={glbRoughness}
                      metalness={glbMetalness}
                      envPreset={glbEnvPreset}
                      canvasRef={canvasRef}
                      onCapture={captureThumbnail}
                    />
                    <button style={s.smallBtn} onClick={captureThumbnail}>Re-capture Thumbnail</button>
                  </div>
                )}

                {/* ── Placement Config ── */}
                <div style={s.field}>
                  <label style={s.label}>Placement Config (JSON)</label>
                  <textarea
                    value={placementConfig}
                    onChange={e => setPlacementConfig(e.target.value)}
                    rows={5}
                    style={{ ...s.input, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
                  />
                </div>

                <button
                  style={{ ...s.btn('primary'), opacity: (saving || removingBg) ? 0.6 : 1 }}
                  onClick={handleSave}
                  disabled={saving || removingBg}
                >
                  {saving ? 'Saving…' : removingBg ? 'Processing thumbnail…' : 'Save Changes'}
                </button>

                {msg && <div style={s.msg(msg.ok)}>{msg.text}</div>}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
