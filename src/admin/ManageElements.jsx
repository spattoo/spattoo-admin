import { useState, useEffect, useRef, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, useGLTF, Environment } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  fetchAdminElementTypes, fetchAllElements, fetchParentElements,
  getSignedUploadUrl, uploadToR2, updateGlobalElement, removeBg, deleteR2Object,
} from '../lib/api.js';
import { PatternCakeThumb } from './PipingCalibrator.jsx';
import CraftGuideEditor from './CraftGuideEditor.jsx';
import { normalizeThumbnail } from '../lib/thumbnail.js';

const CAKE_ZONES = [
  { value: 'top_surface', label: 'Top Surface' },
  { value: 'side',        label: 'Side' },
  { value: 'middle_tier', label: 'Middle Tier' },
  { value: 'rim',         label: 'Rim' },
  { value: 'board',       label: 'Board' },
];

const PLACEMENT_MODES = [
  { value: '',                 label: 'hug (default)' },
  { value: 'stand',            label: 'stand' },
  { value: 'faux_ball_single', label: 'faux ball single' },
  { value: 'faux_balls',       label: 'faux balls' },
];

// Default placement_config for cream_piping elements. When an element has no
// placement_config stored in the DB, we seed this full template instead of {}
// so the Piping Calibrator paste has a complete base to merge its values into.
// Defaults mirror the designer (pipingPlacementFromConfig in spattoo-core):
// top_flip defaults false, bottom_flip defaults true; *_adjustable gate UI controls.
const DEFAULT_PIPING_PLACEMENT_CONFIG = {
  top_flip:               false,
  top_rotation:           null,
  top_radial_offset:      null,
  top_y_offset:           null,
  bottom_flip:            true,
  bottom_rotation:        null,
  bottom_radial_offset:   null,
  bottom_y_offset:        null,
  bottom_flip_adjustable: false,
  bottom_y_adjustable:    false,
  // Shell spacing multiplier per ring (1 = touching/default; >1 = wider gaps, fewer
  // shells; <1 = tighter). Lets the rim match the board's gap independently.
  top_spacing:            1,
  bottom_spacing:         1,
  // Swag/drape: 0 count = flat ring. Set via the Piping Calibrator's Swag controls.
  top_swag_count:         0,
  top_swag_depth:         0,
  top_swag_tilt:          0.5,
  bottom_swag_count:      0,
  bottom_swag_depth:      0,
  bottom_swag_tilt:       0.5,
  // Arrangement: which layouts each zone supports + the default when both are allowed.
  // New piping elements are flexible out of the box (ring + single). The designer shows
  // a Ring/Single toggle only when a zone allows both; the user can duplicate single
  // pieces and rotate each around the cake (single_angle = first piece, single_max = cap).
  top_arrangements_allowed:    ['ring', 'single'],
  bottom_arrangements_allowed: ['ring', 'single'],
  top_arrangement:             'ring',
  bottom_arrangement:          'ring',
  // single_angle omitted on purpose → the designer seeds the first piece at the cake
  // front. Set top_single_angle / bottom_single_angle (radians) here only to override.
  top_single_max:              12,
  bottom_single_max:           12,
  // Alternating A/B pattern: off by default. alt_glb_url is set by the "Alternate shape"
  // upload; pattern is the repeating cycle string (e.g. "AAB"). See the Piping Calibrator.
  top_alt_enabled:             false,
  bottom_alt_enabled:          false,
  top_pattern:                 'AB',
  bottom_pattern:              'AB',
};

// Human-readable byte size in KB/MB only. Returns '' for null (procedural elements).
function formatBytes(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// Size above which an asset is flagged as worth optimizing. GLBs are heavier by
// nature, so they get a more generous ceiling than flat 2D images.
function isOversized(bytes, isGlb) {
  if (bytes == null) return false;
  return bytes > (isGlb ? 5 * 1024 * 1024 : 1 * 1024 * 1024);
}

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
function CameraCapture({ camRef }) {
  const { camera, controls } = useThree();
  useEffect(() => { camRef.current = { camera, controls }; }, [camera, controls]);
  return null;
}

function cameraToModelRotation({ camera, controls }, preTransformEuler = null) {
  const target = controls?.target ?? new THREE.Vector3(0, 0, 0);
  const rel    = camera.position.clone().sub(target);
  const phi    = Math.atan2(rel.x, rel.z);
  const theta  = Math.atan2(rel.y, Math.sqrt(rel.x ** 2 + rel.z ** 2));
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-theta, -phi, 0, 'XYZ'));
  if (preTransformEuler) {
    // Designer applies preTransform BEFORE placement_config.rotation, so we store
    // R' = R × inverse(preTransform) so that preTransform × R' == intended view.
    const qPre = new THREE.Quaternion().setFromEuler(new THREE.Euler(...preTransformEuler, 'XYZ'));
    q.multiply(qPre.invert());
  }
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  const toDeg = r => ((r * 180 / Math.PI) % 360 + 360) % 360;
  return [toDeg(e.x), toDeg(e.y), toDeg(e.z)];
}

function GLBModel({ url, color, roughness, metalness, onLoad, onTextureDetected, onMaterialRead }) {
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

  return <primitive object={scene} />;
}

// Accepts either a File object or a URL string
function GLBPreview({ file, url, color, roughness, metalness, envPreset, camRef, canvasRef, onCapture, onTextureDetected, onMaterialRead }) {
  const [objectUrl, setObjectUrl] = useState(null);

  useEffect(() => {
    if (!file) { setObjectUrl(null); return; }
    const u = URL.createObjectURL(file);
    setObjectUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const glbUrl = file ? objectUrl : url;
  if (!glbUrl) return null;

  return (
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
            onLoad={onCapture}
            onTextureDetected={onTextureDetected}
            onMaterialRead={onMaterialRead}
          />
          {envPreset !== 'none' && <Environment preset={envPreset} />}
        </Suspense>
        <OrbitControls makeDefault enablePan />
        <CameraCapture camRef={camRef} />
      </Canvas>
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
  const [capabilities,     setCapabilities]     = useState({ resize: true, duplicate: true, color: false, delete: true, move: false, tilt: false });
  const [defaultColor,     setDefaultColor]     = useState('#F0DEB8');
  const [isActive,         setIsActive]         = useState(true);

  // Pattern thumbnail regeneration (piping_pattern elements have no GLB to capture from —
  // we re-render their referenced block in the stored A/B pattern and snapshot that).
  // overlap/shellCount only shape the thumbnail image (not saved to placement_config).
  const [regenerating,     setRegenerating]     = useState(false);
  const [previewColor,     setPreviewColor]     = useState('#f5e6c8');   // piping cream
  const [previewCakeColor, setPreviewCakeColor] = useState('#F6C6A8');   // peach cake
  const [previewBoardColor,setPreviewBoardColor]= useState('#D4AF37');   // gold board
  const [previewEnv,       setPreviewEnv]       = useState('apartment');
  const patternCaptureRef = useRef(null);

  // File replacements
  const [newAssetFile,     setNewAssetFile]     = useState(null);
  const [altAssetFile,     setAltAssetFile]     = useState(null);   // alternate piping shape (version B)
  const [newThumbBlob,     setNewThumbBlob]     = useState(null);
  const [removingBg,       setRemovingBg]       = useState(false);
  const [glbColor,         setGlbColor]         = useState('#F0DEB8');
  const [userPickedColor,  setUserPickedColor]  = useState(false);
  const [glbRoughness,     setGlbRoughness]     = useState(0.6);
  const [glbMetalness,     setGlbMetalness]     = useState(0);
  const [glbEnvPreset,     setGlbEnvPreset]     = useState('none');

  const [placementConfig,    setPlacementConfig]    = useState('{}');
  const [placementZoneConfig, setPlacementZoneConfig] = useState({});
  const [placementScale,      setPlacementScale]      = useState('');
  const [description,      setDescription]      = useState('');
  const [glbRotation,        setGlbRotation]        = useState([0, 0, 0]);
  const [frontConfirmed,     setFrontConfirmed]     = useState(false);
  const [rotationDirty,      setRotationDirty]      = useState(false);
  const [calibratorJson, setCalibratorJson] = useState('');
  const camRef = useRef(null);
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
    setCapabilities(el.allowed_actions ?? { resize: true, duplicate: true, color: false, delete: true, move: false, tilt: false });
    setDefaultColor(el.default_color ?? '#F0DEB8');
    setPreviewColor(el.default_color ?? '#f5e6c8');   // seed pattern-thumbnail cream from default
    setIsActive(el.is_active ?? true);
    setNewAssetFile(null);
    setNewThumbBlob(null);
    setMsg(null);
    setUserPickedColor(false);
    setGlbColor('#F0DEB8');
    const elSlug = elementTypes.find(t => t.id === el.element_type_id)?.slug;
    const elIsPiping = elSlug === 'cream_piping' || elSlug === 'piping_pattern';
    const pc = el.placement_config ?? (elIsPiping ? { ...DEFAULT_PIPING_PLACEMENT_CONFIG } : {});
    setPlacementConfig(JSON.stringify(pc, null, 2));
    setGlbRoughness(pc.roughness ?? 0.6);
    setGlbMetalness(pc.metalness ?? 0.15);
    const zoneConf = {};
    (el.allowed_zones ?? []).forEach(z => { if (pc[z]) zoneConf[z] = pc[z]; });
    setPlacementZoneConfig(zoneConf);
    setPlacementScale(pc.r != null ? String(pc.r) : '');
    setGlbEnvPreset('none');
    setGlbRotation(pc.rotation ?? [0, 0, 0]);
    setCalibratorJson('');
    setFrontConfirmed(false);
    setRotationDirty(false);
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

  function confirmFrontView() {
    if (camRef.current) {
      // For piping elements, compensate for the designer's extractGeo+flipBottom pre-transform
      // so the stored rotation works correctly in the designer's coordinate frame.
      let pc = {}; try { pc = JSON.parse(placementConfig); } catch {}
      const preTransform = isPipingType
        ? ((pc.bottom_flip ?? true) ? [-Math.PI / 2, 0, 0] : [Math.PI / 2, 0, 0])
        : null;
      setGlbRotation(cameraToModelRotation(camRef.current, preTransform));
      setRotationDirty(true);
    }
    setFrontConfirmed(true);
    captureThumbnail();
  }

  async function handleSave(withThumbnail = false) {
    if (!selectedEl || !name.trim()) {
      setMsg({ ok: false, text: 'Name is required.' });
      return;
    }
    // Front-view confirmation only matters when we're (re)capturing the thumbnail.
    if (withThumbnail && isGlb && rotationDirty && !frontConfirmed) {
      setMsg({ ok: false, text: 'Rotation was changed — click "Set front view" to confirm the orientation before saving.' });
      return;
    }
    // Replacing an existing asset deletes the old R2 object. Confirm up front; the
    // delete itself happens only after the new upload + DB update succeed (below).
    const replacingAsset = !!(newAssetFile && selectedEl.image_url);
    const oldAssetUrl = replacingAsset ? selectedEl.image_url : null;
    if (replacingAsset) {
      const ok = window.confirm(
        `Replace the ${isGlb ? 'GLB' : 'image'} for "${selectedEl.name}"?\n\n` +
        `The new file is uploaded first. Only after it saves successfully is the ` +
        `previous file permanently deleted from storage. This cannot be undone.`
      );
      if (!ok) return;
    }
    setSaving(true);
    setMsg(null);

    try {
      let parsedConfig = {};
      try { parsedConfig = JSON.parse(placementConfig); } catch { /* keep empty */ }
      // Merge zone config
      applicableZones.forEach(z => {
        if (placementZoneConfig[z]) parsedConfig[z] = placementZoneConfig[z];
        else delete parsedConfig[z];
      });
      if (placementScale !== '') parsedConfig.r = parseFloat(placementScale);
      else delete parsedConfig.r;
      if (glbRotation.some(v => v !== 0)) parsedConfig.rotation = glbRotation;
      else delete parsedConfig.rotation;
      // piping fields live directly in the placement_config JSON — no extra merge needed

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
        // Keep the stored size in sync with the new file.
        updates.file_size = newAssetFile.size ?? null;
      }

      // Upload the alternate piping shape (version B) → store its key in placement_config
      // for both zones (each zone uses it only when its *_alt_enabled is true).
      if (altAssetFile) {
        const ext = altAssetFile.name.split('.').pop();
        const filename = `${crypto.randomUUID()}.${ext}`;
        const { url, key } = await getSignedUploadUrl('elements/files/3D', filename, altAssetFile.type || 'model/gltf-binary');
        await uploadToR2(url, altAssetFile);
        parsedConfig.bottom_alt_glb_url = key;
        parsedConfig.top_alt_glb_url    = key;
        updates.placement_config = parsedConfig;
      }

      // Upload a NEW thumbnail whenever one has been staged — captured from the canvas OR
      // uploaded manually. Either is an explicit change, so both Save buttons persist it (the
      // remove.bg credit, if any, was already spent at capture time, not here). Without a staged
      // blob the existing thumbnail_url is left untouched, so routine data edits keep their image.
      if (newThumbBlob) {
        const filename = `${crypto.randomUUID()}.png`;
        const { url, key } = await getSignedUploadUrl('elements/thumbnails', filename, 'image/png');
        await uploadToR2(url, newThumbBlob);
        updates.thumbnail_url = key;
      }

      updates.description = description;
      await updateGlobalElement(selectedEl.id, updates);

      // New file is uploaded and the DB now points at it — safe to delete the old object.
      let savedText = 'Saved!';
      if (replacingAsset && updates.image_url) {
        try {
          await deleteR2Object(oldAssetUrl);
          savedText = 'Saved! Old file removed from storage.';
        } catch (e) {
          savedText = 'Saved! (Couldn’t delete the old file — remove it manually.)';
          console.warn('Old asset delete failed:', e);
        }
      }

      setMsg({ ok: true, text: savedText });
      setNewAssetFile(null);
      setAltAssetFile(null);
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
  const selectedSlug = elementTypes.find(t => t.id === elementTypeId)?.slug;
  // cream_piping = a building-block GLB; piping_pattern = a fileless element referencing
  // blocks via placement_config.parts. Block-only tooling (GLB upload, orientation, alt
  // shape, thumbnail recapture) stays gated on isPipingType; the shared placement-config
  // editing surfaces (calibrator paste, arrangement/toggles, defaults) use isPipingConfig.
  const isPipingType    = selectedSlug === 'cream_piping';
  const isPipingPattern = selectedSlug === 'piping_pattern';
  const isPipingConfig  = isPipingType || isPipingPattern;

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

  // Resolve everything needed to re-render a pattern's thumbnail: the referenced building
  // block's GLB url (part A, and part B if different) plus a calibrator-shaped cfg rebuilt
  // from the element's stored top_*/bottom_* placement_config. Uses the live editor JSON so
  // a just-pasted calibrator tweak is reflected. Returns null when not a pattern or the
  // referenced block can't be resolved (e.g. block deleted) — the button is then hidden.
  const patternThumb = (() => {
    if (!isPipingPattern || !selectedEl) return null;
    let pc = {};
    try { pc = JSON.parse(placementConfig); } catch { return null; }
    const parts = Array.isArray(pc.parts) ? pc.parts : [];
    const block = parts[0]?.element_id ? elements.find(e => e.id === parts[0].element_id) : null;
    if (!block?.image_url) return null;
    const altBlock = parts[1]?.element_id ? elements.find(e => e.id === parts[1].element_id) : null;
    const altGlbUrl = altBlock?.image_url && altBlock.id !== block.id ? altBlock.image_url : null;
    // Capture the zone the pattern actually uses (prefer board); its *_* fields drive the ring.
    const onBoard = (selectedEl.allowed_zones ?? applicableZones ?? []).includes('board');
    const prefix = onBoard ? 'bottom' : 'top';
    const rot    = Array.isArray(pc[`${prefix}_rotation`])     ? pc[`${prefix}_rotation`]     : [0, 0, 0];
    const altRot = Array.isArray(pc[`${prefix}_alt_rotation`]) ? pc[`${prefix}_alt_rotation`] : [0, 0, 0];
    const patStr = pc[`${prefix}_pattern`] || 'AB';
    const cfg = {
      flipBottom: pc[`${prefix}_flip`] ?? true,
      rx: rot[0] || 0, ry: rot[1] || 0, rz: rot[2] || 0,
      altFlip: pc[`${prefix}_alt_flip`] ?? false,
      altRx: altRot[0] || 0, altRy: altRot[1] || 0, altRz: altRot[2] || 0,
      patternA: Math.max(1, (patStr.match(/A/g) || []).length),
      patternB: Math.max(1, (patStr.match(/B/g) || []).length),
      radialOffset:    pc[`${prefix}_radial_offset`]     ?? 0,
      yOffset:         pc[`${prefix}_y_offset`]          ?? 0,
      spacing:         pc[`${prefix}_spacing`]           ?? 1,
      altRadialOffset: pc[`${prefix}_alt_radial_offset`] ?? 0,
      altYOffset:      pc[`${prefix}_alt_y_offset`]      ?? 0,
    };
    return { glbUrl: block.image_url, altGlbUrl, cfg, zone: onBoard ? 'board' : 'rim' };
  })();

  // Capture the live preview canvas as-is → normalize → upload → point the element at the new
  // thumbnail key (in place: same element id). Best-effort delete of the old one.
  async function capturePatternThumbnail() {
    const canvas = patternCaptureRef.current?.querySelector('canvas');
    if (!canvas) { setMsg({ ok: false, text: 'Pattern preview not ready yet — wait a moment and retry.' }); return; }
    setRegenerating(true); setMsg(null);
    try {
      const raw = await new Promise(r => canvas.toBlob(r, 'image/png'));
      if (!raw) throw new Error('Could not capture the pattern preview.');
      const thumb = await normalizeThumbnail(raw);
      const filename = `${crypto.randomUUID()}.png`;
      const { url, key } = await getSignedUploadUrl('elements/thumbnails', filename, 'image/png');
      await uploadToR2(url, thumb);
      const oldThumb = selectedEl.thumbnail_url;
      await updateGlobalElement(selectedEl.id, { thumbnail_url: key });
      if (oldThumb) deleteR2Object(oldThumb).catch(e => console.warn('Old thumbnail delete failed:', e));
      setMsg({ ok: true, text: 'Thumbnail captured.' });
      await loadAll();
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setRegenerating(false);
    }
  }

  // Shared piping placement controls (flip, user-adjustable toggles, per-zone arrangement,
  // alternate shape). Used for both cream_piping blocks and piping_pattern elements. Pattern
  // elements hide block-only bits: the "pattern-only" visibility flag and the alternate-shape
  // GLB upload (a pattern self-alternates via placement_config.parts, not an uploaded file).
  const renderPipingConfig = ({ isPattern }) => {
    let pc = {};
    try { pc = JSON.parse(placementConfig); } catch {}
    const flip = pc.bottom_flip ?? true;
    const toggles = [
      { key: 'bottom_y_adjustable',    label: 'User can adjust height' },
      { key: 'bottom_flip_adjustable', label: 'User can flip orientation' },
      ...(isPattern ? [] : [{ key: 'pattern_only', label: 'Pattern-only (hide as individual)' }]),
    ];
    const updatePc = (patch) => {
      try { const cur = JSON.parse(placementConfig); setPlacementConfig(JSON.stringify({ ...cur, ...patch }, null, 2)); } catch {}
    };
    return (
      <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #e2ebe3' }}>
        {/* Flip toggle */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, color: '#3D5A44', fontWeight: 600, fontFamily: "'Quicksand',sans-serif" }}>Flip for bottom placement</span>
          <button onClick={() => updatePc({ bottom_flip: !flip })}
            style={{ fontSize: 11, padding: '5px 12px', borderRadius: 6, border: `2px solid ${flip ? '#3D5A44' : '#C5D4C8'}`, background: flip ? '#3D5A44' : '#fff', color: flip ? '#fff' : '#6B8C74', cursor: 'pointer', fontWeight: 700, fontFamily: "'Quicksand',sans-serif" }}>
            {flip ? '↕ Flip: On' : '↕ Flip: Off'}
          </button>
        </div>
        {/* User-adjustable toggles (+ pattern-only visibility flag for blocks) */}
        {toggles.map(({ key, label }) => {
          const val = !!pc[key];
          return (
            <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
              <span style={{ fontSize: 11, color: '#3D5A44', fontWeight: 600, fontFamily: "'Quicksand',sans-serif" }}>{label}</span>
              <button onClick={() => updatePc({ [key]: !val })}
                style={{ fontSize: 11, padding: '5px 12px', borderRadius: 6, border: `2px solid ${val ? '#3D5A44' : '#C5D4C8'}`, background: val ? '#3D5A44' : '#fff', color: val ? '#fff' : '#6B8C74', cursor: 'pointer', fontWeight: 700, fontFamily: "'Quicksand',sans-serif" }}>
                {val ? 'ON' : 'OFF'}
              </button>
            </div>
          );
        })}

        {/* ── Arrangement: allowed layouts + default, per zone ── */}
        {[
          { zone: 'rim',   prefix: 'top',    label: 'Rim' },
          { zone: 'board', prefix: 'bottom', label: 'Board' },
        ].filter(({ zone }) => (applicableZones.length ? applicableZones.includes(zone) : true)).map(({ prefix, label }) => {
          const allowedKey = `${prefix}_arrangements_allowed`;
          const allowed = Array.isArray(pc[allowedKey]) && pc[allowedKey].length ? pc[allowedKey] : ['ring'];
          const def = allowed.includes(pc[`${prefix}_arrangement`]) ? pc[`${prefix}_arrangement`] : allowed[0];
          const toggleMode = (mode) => {
            const has = allowed.includes(mode);
            let next = has ? allowed.filter(m => m !== mode) : [...allowed, mode];
            next = ['ring', 'single'].filter(m => next.includes(m));   // canonical order
            if (!next.length) next = [mode];                           // never empty
            const patch = { [allowedKey]: next };
            if (!next.includes(pc[`${prefix}_arrangement`])) patch[`${prefix}_arrangement`] = next[0];
            updatePc(patch);
          };
          return (
            <div key={prefix} style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed #e2ebe3' }}>
              <div style={{ fontSize: 11, color: '#3D5A44', fontWeight: 700, fontFamily: "'Quicksand',sans-serif", marginBottom: 6 }}>{label} arrangement</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {['ring', 'single'].map(mode => {
                  const on = allowed.includes(mode);
                  return (
                    <button key={mode} onClick={() => toggleMode(mode)}
                      style={{ fontSize: 11, padding: '5px 12px', borderRadius: 6, border: `2px solid ${on ? '#3D5A44' : '#C5D4C8'}`, background: on ? '#3D5A44' : '#fff', color: on ? '#fff' : '#6B8C74', cursor: 'pointer', fontWeight: 700, fontFamily: "'Quicksand',sans-serif", textTransform: 'capitalize' }}>
                      {on ? `✓ ${mode}` : mode}
                    </button>
                  );
                })}
              </div>
              {/* Default only matters when the user can switch (both allowed) */}
              {allowed.length > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                  <span style={{ fontSize: 11, color: '#6B8C74', fontWeight: 600, fontFamily: "'Quicksand',sans-serif" }}>Default</span>
                  {allowed.map(mode => {
                    const on = def === mode;
                    return (
                      <button key={mode} onClick={() => updatePc({ [`${prefix}_arrangement`]: mode })}
                        style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: `2px solid ${on ? '#3D5A44' : '#C5D4C8'}`, background: on ? '#eef3ef' : '#fff', color: '#3D5A44', cursor: 'pointer', fontWeight: 700, fontFamily: "'Quicksand',sans-serif", textTransform: 'capitalize' }}>
                        {on ? `● ${mode}` : `○ ${mode}`}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* ── Alternate shape (block-only: pattern B comes from a referenced block) ── */}
        {!isPattern && (() => {
          const curAltKey = pc.bottom_alt_glb_url || pc.top_alt_glb_url || null;
          return (
            <div style={{ marginTop: 12, paddingTop: 8, borderTop: '1px dashed #e2ebe3' }}>
              <div style={{ fontSize: 11, color: '#3D5A44', fontWeight: 700, fontFamily: "'Quicksand',sans-serif", marginBottom: 4 }}>Alternate shape (GLB)</div>
              <div style={{ fontSize: 10, color: '#6B8C74', marginBottom: 6, lineHeight: 1.4 }}>
                Used as version “B” when an alternating pattern is enabled (set the pattern + B’s
                transform in the Piping Calibrator). Leave empty to alternate the same shape flipped.
              </div>
              <label style={{ display: 'block' }}>
                <div style={{ border: '2px dashed #C5D4C8', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', background: '#F4F8F5', fontSize: 11, color: '#6B8C74', textAlign: 'center' }}>
                  {altAssetFile ? `New: ${altAssetFile.name}` : (curAltKey ? `Current: ${String(curAltKey).split('/').pop()} — replace…` : 'Click to pick alternate .glb')}
                  <input type="file" accept=".glb,.gltf" style={{ display: 'none' }}
                    onChange={e => { if (e.target.files[0]) setAltAssetFile(e.target.files[0]); }} />
                </div>
              </label>
            </div>
          );
        })()}
      </div>
    );
  };

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
                      title="Click to copy element id"
                      onClick={() => navigator.clipboard?.writeText(selectedEl.id)}
                      style={{ fontSize: 11, color: '#9BB5A2', fontFamily: 'monospace', marginTop: 3, cursor: 'pointer' }}
                    >
                      {selectedEl.id}
                    </div>
                    {selectedEl.image_url && (
                      <div style={{ fontSize: 11, fontFamily: 'monospace', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span
                          title="Click to copy R2 key"
                          onClick={() => navigator.clipboard?.writeText(selectedEl.image_url)}
                          style={{ color: '#9BB5A2', cursor: 'pointer', wordBreak: 'break-all' }}
                        >
                          {selectedEl.image_url.split('/').pop()}
                        </span>
                        {selectedEl.file_size != null && (
                          <span style={{ fontWeight: 700, color: isOversized(selectedEl.file_size, isGlb) ? '#c0392b' : '#6B8C74' }}>
                            · {formatBytes(selectedEl.file_size)}
                            {isOversized(selectedEl.file_size, isGlb) && ' · optimize'}
                          </span>
                        )}
                      </div>
                    )}
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
                        camRef={camRef}
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
                          Orbit with mouse to find the front view, then confirm below
                        </div>
                        {[['X', 0, '#e05252'], ['Y', 1, '#52c452'], ['Z', 2, '#5252e0']].map(([axis, idx, axisColor]) => (
                          <div key={axis} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: axisColor, width: 14, flexShrink: 0 }}>{axis}</span>
                            <div style={{ flex: 1, height: 4, background: '#e8ede9', borderRadius: 2, position: 'relative' }}>
                              <div style={{ width: `${(glbRotation[idx] / 359) * 100}%`, height: '100%', background: axisColor, borderRadius: 2 }} />
                            </div>
                            <span style={{ fontSize: 11, color: '#6B8C74', fontWeight: 600, minWidth: 32, textAlign: 'right' }}>{Math.round(glbRotation[idx])}°</span>
                          </div>
                        ))}
                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                          <button onClick={confirmFrontView}
                            style={{ fontSize: 11, padding: '5px 12px', borderRadius: 6, border: `2px solid ${frontConfirmed ? '#3D5A44' : '#e05252'}`, background: frontConfirmed ? '#3D5A44' : '#fff', color: frontConfirmed ? '#fff' : '#e05252', cursor: 'pointer', fontWeight: 700, fontFamily: "'Quicksand',sans-serif" }}>
                            {frontConfirmed ? '✓ Front set' : '✱ Set front view (required)'}
                          </button>
                        </div>
                        {/* Calibrator paste + Merge live side-by-side with the placement_config
                            editor below (see the placement_config field). */}
                        {isPipingType && renderPipingConfig({ isPattern: false })}
                      </div>
                    </div>
                  )}

                  {/* Piping pattern: no GLB of its own — references building-block elements via
                      placement_config.parts. Show the same placement controls (flip / toggles /
                      arrangement) the calibrator tunes, minus block-only bits. */}
                  {isPipingPattern && (() => {
                    let pc = {};
                    try { pc = JSON.parse(placementConfig); } catch {}
                    const parts = Array.isArray(pc.parts) ? pc.parts : [];
                    return (
                      <div style={{ marginBottom: 12, padding: '10px 12px', background: '#f5f8f5', borderRadius: 10, border: '1.5px solid #C5D4C8' }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44', fontFamily: "'Quicksand',sans-serif" }}>Piping pattern</div>
                        <div style={{ fontSize: 10, color: '#6B8C74', marginTop: 4, lineHeight: 1.4 }}>
                          This pattern references building-block elements (no file of its own). Set the
                          thumbnail colors below, then capture the preview as this element's thumbnail.
                        </div>
                        {parts.length > 0 && (
                          <div style={{ fontSize: 10, color: '#6B8C74', marginTop: 6 }}>
                            Block parts: {parts.map(p => p?.element_id).filter(Boolean).join(', ') || '—'}
                          </div>
                        )}

                        {/* Live thumbnail preview — this same canvas is the capture source, so
                            what you see is what gets saved (normalize then crops + centers it).
                            preserveDrawingBuffer lets capturePatternThumbnail() snapshot it;
                            dpr 2–3 gives the saved PNG enough resolution from the small preview. */}
                        {patternThumb && (
                          <div style={{ marginTop: 10 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: '#6B8C74', marginBottom: 4, fontFamily: "'Quicksand',sans-serif", textTransform: 'uppercase', letterSpacing: 0.5 }}>Thumbnail preview</div>
                            <div ref={patternCaptureRef} style={{ width: 200, height: 200, borderRadius: 10, overflow: 'hidden', border: '1.5px solid #C5D4C8', background: '#fff' }}>
                              <Canvas dpr={[2, 3]} gl={{ preserveDrawingBuffer: true, alpha: true }} camera={{ position: [0, 1.55, 4.6], fov: 30 }} style={{ width: '100%', height: '100%', background: 'transparent' }}>
                                <ambientLight intensity={0.85} />
                                <directionalLight position={[4, 9, 6]} intensity={1.3} />
                                <directionalLight position={[-3, 3, -3]} intensity={0.4} />
                                <Suspense fallback={null}>
                                  {previewEnv !== 'none' && <Environment preset={previewEnv} />}
                                  <PatternCakeThumb glbUrl={patternThumb.glbUrl} altGlbUrl={patternThumb.altGlbUrl} cfg={patternThumb.cfg}
                                    zone={patternThumb.zone} color={previewColor} cakeColor={previewCakeColor} boardColor={previewBoardColor} />
                                </Suspense>
                                {/* static framing on the cake centre — no interaction, no auto-rotate (still capture) */}
                                <OrbitControls makeDefault target={[0, 0.78, 0]} enableZoom={false} enablePan={false} enableRotate={false} />
                              </Canvas>
                            </div>
                            {/* Colors + lighting only affect the thumbnail image, not how the cake renders. */}
                            {[
                              { label: 'Piping', value: previewColor,      set: setPreviewColor },
                              { label: 'Cake',   value: previewCakeColor,  set: setPreviewCakeColor },
                              { label: 'Board',  value: previewBoardColor, set: setPreviewBoardColor },
                            ].map(({ label, value, set }) => (
                              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                                <span style={{ fontSize: 10, color: '#6B8C74', fontWeight: 600, minWidth: 56, fontFamily: "'Quicksand',sans-serif" }}>{label}</span>
                                <input type="color" value={value} onChange={e => set(e.target.value)}
                                  style={{ width: 32, height: 26, border: '1.5px solid #C5D4C8', borderRadius: 6, cursor: 'pointer', padding: 2 }} />
                                <span style={{ fontSize: 10, color: '#3D5A44', fontWeight: 700 }}>{value}</span>
                              </div>
                            ))}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                              <span style={{ fontSize: 10, color: '#6B8C74', fontWeight: 600, minWidth: 56, fontFamily: "'Quicksand',sans-serif" }}>Lighting</span>
                              <select value={previewEnv} onChange={e => setPreviewEnv(e.target.value)}
                                style={{ flex: 1, fontSize: 11, padding: '3px 6px', borderRadius: 6, border: '1.5px solid #C5D4C8', color: '#3D5A44', fontFamily: "'Quicksand',sans-serif" }}>
                                {['none','apartment','studio','city','sunset','dawn','warehouse','forest','park','lobby'].map(p => (
                                  <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                                ))}
                              </select>
                            </div>
                            <div style={{ fontSize: 9, color: '#9BB5A2', marginTop: 3 }}>Saved thumbnail is this view, cropped to the cake and centered.</div>
                          </div>
                        )}

                        {/* Capture the live preview above as this element's thumbnail (same id) */}
                        <div style={{ marginTop: 8 }}>
                          <button onClick={capturePatternThumbnail} disabled={!patternThumb || regenerating}
                            title={patternThumb ? 'Capture the preview above and save it as this element’s thumbnail' : 'Referenced block could not be resolved'}
                            style={{ fontSize: 11, padding: '6px 12px', borderRadius: 6, border: '2px solid #3D5A44', background: (!patternThumb || regenerating) ? '#C5D4C8' : '#3D5A44', color: '#fff', cursor: (!patternThumb || regenerating) ? 'not-allowed' : 'pointer', fontWeight: 700, fontFamily: "'Quicksand',sans-serif" }}>
                            {regenerating ? 'Capturing…' : '📸 Capture thumbnail'}
                          </button>
                          {!patternThumb && parts.length > 0 && (
                            <div style={{ fontSize: 10, color: '#c0392b', marginTop: 4 }}>Referenced block not found — can’t capture.</div>
                          )}
                        </div>

                        {renderPipingConfig({ isPattern: true })}
                      </div>
                    );
                  })()}

                  {/* Replace file drop zone — patterns have no file of their own, so hide it. */}
                  {!isPipingPattern && (
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
                  )}
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

                  {/* Replace thumbnail drop zone — a manually uploaded image is already final, so
                      use it as-is (no remove.bg; that's only for cutting the 3D-render background
                      on a captured thumbnail). Matches AddElement's custom-thumbnail upload. */}
                  <label style={{ ...s.fileBox, padding: '12px 16px', marginTop: 6 }}>
                    <input type="file" accept="image/*" style={{ display: 'none' }}
                      onChange={e => { if (e.target.files[0]) setNewThumbBlob(e.target.files[0]); }} />
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
                      { key: 'move',      label: 'Movable',          hint: 'Nudge ◀▶▲▼ position on the cake' },
                      { key: 'tilt',      label: 'Tiltable',         hint: 'Lean / rotate slightly in the designer' },
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
                {!isGeom && applicableZones.length > 0 && (
                  <div style={s.field}>
                    <label style={s.label}>Placement Config</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {applicableZones.map(zone => {
                        const zoneLabel = CAKE_ZONES.find(z => z.value === zone)?.label ?? zone;
                        return (
                          <div key={zone} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>{zoneLabel}</span>
                            <select
                              style={{ ...s.select, flex: 1 }}
                              value={placementZoneConfig[zone] ?? ''}
                              onChange={e => setPlacementZoneConfig(c => ({ ...c, [zone]: e.target.value }))}>
                              {PLACEMENT_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                            </select>
                          </div>
                        );
                      })}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>Default scale (r)</span>
                        <input type="number" min="0.1" step="0.1"
                          style={{ ...s.input, flex: 1 }}
                          value={placementScale}
                          placeholder="e.g. 2.5 — leave blank for auto"
                          onChange={e => setPlacementScale(e.target.value)} />
                      </div>
                    </div>
                  </div>
                )}

                {/* ── placement_config JSON editor (+ calibrator paste side-by-side for piping) ── */}
                <div style={s.field}>
                  <label style={s.label}>placement_config (JSON)</label>

                  {isPipingConfig ? (
                    <>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'stretch', flexWrap: 'wrap' }}>
                        {/* Left — paste from calibrator */}
                        <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: '#6B8C74', marginBottom: 4, fontFamily: "'Quicksand',sans-serif", textTransform: 'uppercase', letterSpacing: 0.5 }}>From Piping Calibrator</div>
                          <textarea
                            rows={14}
                            value={calibratorJson}
                            onChange={e => setCalibratorJson(e.target.value)}
                            onClick={e => e.stopPropagation()}
                            onFocus={e => e.stopPropagation()}
                            onPointerDown={e => e.stopPropagation()}
                            spellCheck={false}
                            placeholder={'{\n  "bottom_flip": true,\n  "bottom_rotation": [83, -180, -3],\n  "bottom_radial_offset": 0.2,\n  "bottom_y_offset": 0.09,\n  "top_flip": false,\n  "top_rotation": [-15, 97, 12],\n  "top_radial_offset": -0.06,\n  "top_y_offset": -0.02\n}'}
                            style={{ flex: 1, width: '100%', minHeight: 260, fontFamily: 'monospace', fontSize: 11, borderRadius: 8, border: '1.5px solid #C5D4C8', padding: '8px 10px', boxSizing: 'border-box', resize: 'vertical', display: 'block', lineHeight: 1.6, color: '#2C4433' }}
                          />
                        </div>

                        {/* Middle — merge arrow */}
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}>
                          <button
                            type="button"
                            title="Merge the calibrator values into placement_config"
                            disabled={!calibratorJson.trim()}
                            onClick={e => {
                              e.stopPropagation();
                              try {
                                const v = JSON.parse(calibratorJson);
                                const cur = JSON.parse(placementConfig);
                                // Combined format: keys are already top_*/bottom_* — merge straight in.
                                // Legacy format has a `target` + generic keys, mapped to one prefix.
                                const isCombined = Object.keys(v).some(k => k.startsWith('top_') || k.startsWith('bottom_'));
                                let merged;
                                if (isCombined) {
                                  merged = { ...cur, ...v };
                                } else {
                                  merged = { ...cur };
                                  const p = v.target === 'rim' ? 'top' : 'bottom';
                                  const flip = v.flip ?? v.flipBottom;
                                  if (flip            !== undefined) merged[`${p}_flip`]          = flip;
                                  if (Array.isArray(v.rotation))     merged[`${p}_rotation`]      = v.rotation;
                                  if (v.radialOffset  !== undefined) merged[`${p}_radial_offset`] = v.radialOffset;
                                  if (v.yOffset       !== undefined) merged[`${p}_y_offset`]      = v.yOffset;
                                  if (v.swagCount     !== undefined) merged[`${p}_swag_count`]    = v.swagCount;
                                  if (v.swagDepth     !== undefined) merged[`${p}_swag_depth`]    = v.swagDepth;
                                  if (v.swagTilt      !== undefined) merged[`${p}_swag_tilt`]     = v.swagTilt;
                                }
                                setPlacementConfig(JSON.stringify(merged, null, 2));
                                setCalibratorJson('');
                              } catch { alert('Invalid JSON — check format and try again.'); }
                            }}
                            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, background: calibratorJson.trim() ? '#3D5A44' : '#C5D4C8', color: '#fff', border: 'none', borderRadius: 10, padding: '14px 16px', cursor: calibratorJson.trim() ? 'pointer' : 'not-allowed', fontFamily: "'Quicksand',sans-serif", fontWeight: 800, fontSize: 11, letterSpacing: 0.5 }}
                          >
                            <span style={{ fontSize: 20, lineHeight: 1 }}>→</span>
                            MERGE
                          </button>
                        </div>

                        {/* Right — placement_config saved to DB */}
                        <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: '#6B8C74', marginBottom: 4, fontFamily: "'Quicksand',sans-serif", textTransform: 'uppercase', letterSpacing: 0.5 }}>placement_config · saved to DB</div>
                          <textarea
                            rows={14}
                            value={placementConfig}
                            onChange={e => setPlacementConfig(e.target.value)}
                            onClick={e => e.stopPropagation()}
                            onFocus={e => e.stopPropagation()}
                            onPointerDown={e => e.stopPropagation()}
                            spellCheck={false}
                            style={{ flex: 1, width: '100%', minHeight: 260, fontFamily: 'monospace', fontSize: 11, borderRadius: 8, border: '1.5px solid #C5D4C8', padding: '8px 10px', boxSizing: 'border-box', resize: 'vertical', display: 'block', lineHeight: 1.6, color: '#2C4433', background: '#f9fbf9' }}
                          />
                        </div>
                      </div>
                      <div style={{ fontSize: 10, color: '#9aaa9e', marginTop: 4, fontFamily: "'Quicksand',sans-serif" }}>
                        Paste the Calibrator output on the left → hit <b>Merge →</b> → it folds into placement_config on the right. Accepts the combined <code>top_*</code>/<code>bottom_*</code> format or the legacy single-<code>target</code> string. Saved as-is to the DB.
                      </div>
                    </>
                  ) : (
                    <>
                      <textarea
                        rows={12}
                        value={placementConfig}
                        onChange={e => setPlacementConfig(e.target.value)}
                        onClick={e => e.stopPropagation()}
                        onFocus={e => e.stopPropagation()}
                        onPointerDown={e => e.stopPropagation()}
                        spellCheck={false}
                        style={{ width: '100%', fontFamily: 'monospace', fontSize: 11, borderRadius: 8, border: '1.5px solid #C5D4C8', padding: '8px 10px', boxSizing: 'border-box', resize: 'vertical', display: 'block', lineHeight: 1.6, color: '#2C4433', background: '#f9fbf9' }}
                      />
                      <div style={{ fontSize: 10, color: '#9aaa9e', marginTop: 4, fontFamily: "'Quicksand',sans-serif" }}>
                        Edit directly. Saved as-is to the DB.
                      </div>
                    </>
                  )}
                </div>

                {/* Baker craft guide (X-Ray) — sidecar table, saved independently */}
                {isPipingConfig && (
                  <CraftGuideEditor
                    key={selectedEl.id}
                    elementId={selectedEl.id}
                    name={selectedEl.name}
                    description={selectedEl.description}
                    thumbnailUrl={selectedEl.thumbnail_url}
                  />
                )}

                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    style={{ ...s.btn('primary'), flex: 1, opacity: saving ? 0.6 : 1 }}
                    onClick={() => handleSave(false)}
                    disabled={saving}
                    title="Save all fields without regenerating the thumbnail (keeps the existing image)"
                  >
                    {saving ? 'Saving…' : 'Save Data'}
                  </button>
                  <button
                    style={{ ...s.btn('secondary'), flex: 1, opacity: (saving || removingBg) ? 0.6 : 1 }}
                    onClick={() => handleSave(true)}
                    disabled={saving || removingBg}
                    title="Save and upload the captured thumbnail (uses a remove.bg credit)"
                  >
                    {removingBg ? 'Processing thumbnail…' : 'Save + Thumbnail'}
                  </button>
                </div>

                {msg && <div style={s.msg(msg.ok)}>{msg.text}</div>}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
