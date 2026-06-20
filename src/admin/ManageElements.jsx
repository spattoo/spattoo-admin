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
  { value: 'hug',              label: 'hug (default)' },   // explicit — saved as "hug", not omitted
  { value: 'stand',            label: 'stand' },
  { value: 'perch',            label: 'perch (sit on edge)' },  // figure seated on the rim, legs over
  { value: 'verge',            label: 'verge (lean over edge)' }, // rests on the rim lip, reclines outward
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

// Default placement_config for decor_pattern elements. A decor_pattern is a fileless
// element that places several building-block parts at once (e.g. two unicorn eyes).
// Seed a parts skeleton so the editor shows the expected shape: each part references a
// building-block element_id and offsets it by dx/dz (mirror flips it). parts_deletable
// controls whether the baker can remove individual parts. See spattoo-core placePattern.
const DEFAULT_DECOR_PATTERN_PLACEMENT_CONFIG = {
  parts_deletable: false,
  parts: [
    { element_id: '', dx: 0, dz: 0 },
  ],
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
  // Return DEGREES — the unified facing-offset unit (the calibrator/AddElement convention). The
  // designer reads placement_config.rotation via facingOffsetRadians (gated by rotation_unit:'deg')
  // and converts to the radians THREE.Euler wants. See spattoo-core placement.js / PLACEMENT_CONFIG.md.
  return [e.x, e.y, e.z].map(v => normDeg360(v * RAD_TO_DEG));
}

// glbRotation is kept in DEGREES (the authored unit). normDeg360 keeps it in [0,360).
const RAD_TO_DEG  = 180 / Math.PI;
const normDeg360  = d => ((d % 360) + 360) % 360;

// Read placement_config.rotation as a DEGREES triple for the UI, converting legacy un-flagged rows
// (radians — ManageElements' historical output) so editing + re-saving normalizes them to deg+flag.
function rotationToDegrees(pc) {
  const r = pc?.rotation;
  if (!Array.isArray(r)) return [0, 0, 0];
  return (pc.rotation_unit === 'deg' ? r : r.map(v => v * RAD_TO_DEG)).map(normDeg360);
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
  // True only when the staged thumbnail is a DELIBERATE choice (manual upload, or a 2D image
  // replace). The 3D preview auto-captures a blob on load just to show a live preview — that is
  // NOT deliberate, so plain "Save" must ignore it (only "Save + Thumbnail" persists it).
  const [thumbManual,      setThumbManual]      = useState(false);
  const [removingBg,       setRemovingBg]       = useState(false);
  const [glbColor,         setGlbColor]         = useState('#F0DEB8');
  const [userPickedColor,  setUserPickedColor]  = useState(false);
  const [glbRoughness,     setGlbRoughness]     = useState(0.6);
  const [glbMetalness,     setGlbMetalness]     = useState(0);
  const [glbEnvPreset,     setGlbEnvPreset]     = useState('none');

  const [placementConfig,    setPlacementConfig]    = useState('{}');
  const [placementZoneConfig, setPlacementZoneConfig] = useState({});
  const [placementScale,      setPlacementScale]      = useState('');
  const [placementScaleMin,   setPlacementScaleMin]   = useState('');   // placement_config.scale.min
  const [placementScaleMax,   setPlacementScaleMax]   = useState('');   // placement_config.scale.max
  const [placementScaleStep,  setPlacementScaleStep]  = useState('');   // placement_config.scale.step
  const [singlePerSlot,      setSinglePerSlot]      = useState(false);
  const [canScatter,         setCanScatter]         = useState(false);
  const [sideProud,          setSideProud]          = useState(false);
  const [useFondant,         setUseFondant]         = useState(false);   // placement_config.useSharedFondantTexture
  const [hugFill,            setHugFill]            = useState('');
  // Verge (rests on the rim lip, reclines outward over the edge) — placement_config.verge object.
  const [vergeSeat,      setVergeSeat]      = useState('center'); // verge.seat: center | base
  const [vergeAngle,     setVergeAngle]     = useState('');   // verge.angle_deg (blank = default 35)
  const [vergeYOffset,   setVergeYOffset]   = useState('');   // verge.y_offset (blank = 0)
  const [vergeEdgeInset, setVergeEdgeInset] = useState('');   // verge.edge_inset (blank = 0)
  // Folded sticker (2D) + pixel-recolour region — config-driven capabilities (see spattoo-core).
  const [foldable,      setFoldable]      = useState(false);
  const [foldAngle,     setFoldAngle]     = useState('');
  const [spineSplit,    setSpineSplit]    = useState('');
  const [recolorMethod, setRecolorMethod] = useState('opaque');
  const [recolorGuard,  setRecolorGuard]  = useState('12');
  const [recolorSat,    setRecolorSat]    = useState('0.25');
  const [patternOnly,        setPatternOnly]        = useState(false);
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
    setThumbManual(false);
    setMsg(null);
    setUserPickedColor(false);
    setGlbColor('#F0DEB8');
    const elSlug = elementTypes.find(t => t.id === el.element_type_id)?.slug;
    const elIsPiping = elSlug === 'cream_piping' || elSlug === 'piping_pattern';
    const elIsDecorPattern = elSlug === 'decor_pattern';
    const pc = el.placement_config ?? (
      elIsPiping ? { ...DEFAULT_PIPING_PLACEMENT_CONFIG }
      : elIsDecorPattern ? structuredClone(DEFAULT_DECOR_PATTERN_PLACEMENT_CONFIG)
      : {});
    setPlacementConfig(JSON.stringify(pc, null, 2));
    setGlbRoughness(pc.roughness ?? 0.6);
    setGlbMetalness(pc.metalness ?? 0.15);
    const zoneConf = {};
    (el.allowed_zones ?? []).forEach(z => { if (pc[z]) zoneConf[z] = pc[z]; });
    setPlacementZoneConfig(zoneConf);
    setPlacementScale(pc.r != null ? String(pc.r) : '');
    setPlacementScaleMin(pc.scale?.min != null ? String(pc.scale.min) : '');
    setPlacementScaleMax(pc.scale?.max != null ? String(pc.scale.max) : '');
    setPlacementScaleStep(pc.scale?.step != null ? String(pc.scale.step) : '');
    setSinglePerSlot(pc.single_per_slot === true);
    setUseFondant(pc.useSharedFondantTexture === true);
    setCanScatter(pc.scatter === true);
    setSideProud(pc.side_proud === true);
    setHugFill(pc.hug_fill != null ? String(pc.hug_fill) : '');
    setVergeSeat(pc.verge?.seat === 'base' ? 'base' : 'center');
    setVergeAngle(pc.verge?.angle_deg != null ? String(pc.verge.angle_deg) : '');
    setVergeYOffset(pc.verge?.y_offset != null ? String(pc.verge.y_offset) : '');
    setVergeEdgeInset(pc.verge?.edge_inset != null ? String(pc.verge.edge_inset) : '');
    setFoldable(pc.foldable === true);
    setFoldAngle(pc.fold != null ? String(pc.fold) : '');
    setSpineSplit(pc.spine != null ? String(pc.spine) : '');
    setRecolorMethod(pc.recolor?.method ?? 'opaque');
    setRecolorGuard(pc.recolor?.guard != null ? String(pc.recolor.guard) : '12');
    setRecolorSat(pc.recolor?.sat != null ? String(pc.recolor.sat) : '0.25');
    setPatternOnly(pc.pattern_only === true);
    setGlbEnvPreset('none');
    setGlbRotation(rotationToDegrees(pc));   // degrees for the UI; converts legacy radians rows
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
    // Auto-capture from the 3D preview — for the live preview only, not a deliberate save.
    setThumbManual(false);
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

  // ── Live two-way binding between the structured controls and the placement_config JSON ──
  // patchPc: a structured control writes its key into the JSON in real time (value of
  // null/undefined/'' removes the key). syncStructuredFromPc: editing the JSON directly reflects
  // back into the controls (only when it parses, so it doesn't fight you mid-type).
  function patchPc(patch) {
    setPlacementConfig(prev => {
      let cur = {}; try { cur = JSON.parse(prev); } catch { cur = {}; }
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === '') delete cur[k];
        else cur[k] = v;
      }
      return JSON.stringify(cur, null, 2);
    });
  }
  function syncStructuredFromPc(pc) {
    const zoneConf = {};
    (applicableZones ?? []).forEach(z => { if (pc[z]) zoneConf[z] = pc[z]; });
    setPlacementZoneConfig(zoneConf);
    setPlacementScale(pc.r != null ? String(pc.r) : '');
    setPlacementScaleMin(pc.scale?.min != null ? String(pc.scale.min) : '');
    setPlacementScaleMax(pc.scale?.max != null ? String(pc.scale.max) : '');
    setPlacementScaleStep(pc.scale?.step != null ? String(pc.scale.step) : '');
    setSinglePerSlot(pc.single_per_slot === true);
    setUseFondant(pc.useSharedFondantTexture === true);
    setCanScatter(pc.scatter === true);
    setSideProud(pc.side_proud === true);
    setHugFill(pc.hug_fill != null ? String(pc.hug_fill) : '');
    setVergeSeat(pc.verge?.seat === 'base' ? 'base' : 'center');
    setVergeAngle(pc.verge?.angle_deg != null ? String(pc.verge.angle_deg) : '');
    setVergeYOffset(pc.verge?.y_offset != null ? String(pc.verge.y_offset) : '');
    setVergeEdgeInset(pc.verge?.edge_inset != null ? String(pc.verge.edge_inset) : '');
    setFoldable(pc.foldable === true);
    setFoldAngle(pc.fold != null ? String(pc.fold) : '');
    setSpineSplit(pc.spine != null ? String(pc.spine) : '');
    setRecolorMethod(pc.recolor?.method ?? 'opaque');
    setRecolorGuard(pc.recolor?.guard != null ? String(pc.recolor.guard) : '12');
    setRecolorSat(pc.recolor?.sat != null ? String(pc.recolor.sat) : '0.25');
    setPatternOnly(pc.pattern_only === true);
    // Keep glbRotation in lockstep with the JSON. handleSave rewrites rotation from glbRotation,
    // so without this an edit to `rotation` in the textarea is silently reverted on save. UI unit
    // is degrees; rotationToDegrees honours the JSON's rotation_unit (legacy rows = radians).
    setGlbRotation(rotationToDegrees(pc));
  }
  function onPcJsonEdit(text) {
    setPlacementConfig(text);
    try { syncStructuredFromPc(JSON.parse(text)); } catch { /* invalid mid-type: leave controls */ }
  }
  const numPatch = v => (v === '' || isNaN(parseFloat(v))) ? '' : parseFloat(v);
  // The recolour descriptor for the current method + its param (override any field for live edits,
  // since setState is async). Mirrors the AddElement build + spattoo-core matcher methods.
  const recolorDesc = (m = recolorMethod, g = recolorGuard, sv = recolorSat) =>
    m === 'blue_gt_green' ? { method: 'blue_gt_green', guard: g !== '' ? parseInt(g, 10) : 12 }
    : m === 'saturated'   ? { method: 'saturated', sat: sv !== '' ? parseFloat(sv) : 0.25 }
    : { method: 'opaque' };
  // The verge descriptor (rests on the rim lip, reclines outward) — only non-blank fields; all blank
  // → '' so patchPc drops the key and the designer uses its defaults (angle_deg 35 / 0 offsets).
  const vergeDesc = (seat = vergeSeat, a = vergeAngle, y = vergeYOffset, ei = vergeEdgeInset) => {
    const v = {};
    if (seat === 'base') v.seat = 'base';   // default 'center' omitted (the renderer default)
    if (a  !== '') v.angle_deg  = parseFloat(a);
    if (y  !== '') v.y_offset   = parseFloat(y);
    if (ei !== '') v.edge_inset = parseFloat(ei);
    return Object.keys(v).length ? v : '';
  };
  // Build the placement_config.scale patch from the min/max inputs: an object with only the set
  // keys, or '' so patchPc removes `scale` entirely when all are blank. The sibling fields' current
  // strings are passed through so editing one (min/max/step) keeps the others.
  const scalePatch = (minStr, maxStr, stepStr) => {
    const o = {};
    if (numPatch(minStr)  !== '') o.min  = numPatch(minStr);
    if (numPatch(maxStr)  !== '') o.max  = numPatch(maxStr);
    if (numPatch(stepStr) !== '') o.step = numPatch(stepStr);
    return Object.keys(o).length ? o : '';
  };

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
      // Fail loudly on bad JSON instead of silently saving {} (which would wipe parts/config).
      let parsedConfig = {};
      try { parsedConfig = JSON.parse(placementConfig); }
      catch (e) {
        setMsg({ ok: false, text: `placement_config is not valid JSON — fix it before saving (${e.message}).` });
        setSaving(false);
        return;
      }
      // Merge zone config — write the chosen mode for EVERY applicable zone, explicitly (default
      // 'hug'). No more "absent means hug": the saved config states the mode for each zone, so the
      // designer never has to guess. (Existing config still wins via the designer's spread/backfill.)
      applicableZones.forEach(z => { parsedConfig[z] = placementZoneConfig[z] || 'hug'; });
      if (placementScale !== '') parsedConfig.r = parseFloat(placementScale);
      else delete parsedConfig.r;
      // Optional size-dial bounds { min, max, step } (each independent). r is the default WITHIN this
      // range; all blank → drop the key so the designer keeps its built-in bounds.
      const scaleBounds = scalePatch(placementScaleMin, placementScaleMax, placementScaleStep);
      if (scaleBounds !== '') parsedConfig.scale = scaleBounds;
      else delete parsedConfig.scale;
      // Placement STYLE (hero = one instance per tier×surface vs. free scatter). Config-driven,
      // never inferred from element type — see spattoo-core INVARIANTS.md rule #4.
      if (singlePerSlot) parsedConfig.single_per_slot = true;
      else delete parsedConfig.single_per_slot;
      // Scatter STYLE: many packed instances driven by a density control (sprinkles), vs. discrete
      // decor placed/duplicated by hand. Config-driven; the designer reads placement_config.scatter,
      // never the element type. Mutually exclusive with single_per_slot.
      if (canScatter) { parsedConfig.scatter = true; delete parsedConfig.single_per_slot; }
      else delete parsedConfig.scatter;
      // Side seating: default flush (true hug); proud = stands off the wall.
      if (sideProud) parsedConfig.side_proud = true;
      else delete parsedConfig.side_proud;
      // Hero side-hug size = fraction of tier wall height (designer derives at render; r = stand size).
      if (hugFill !== '') parsedConfig.hug_fill = parseFloat(hugFill);
      else delete parsedConfig.hug_fill;
      // Building-block part of a pattern — hidden from the picker, placed via its parent pattern.
      if (patternOnly) parsedConfig.pattern_only = true;
      else delete parsedConfig.pattern_only;
      // Shared fondant surface (designer overlays the matte grain under any colour). Off → GLB's own.
      if (useFondant) parsedConfig.useSharedFondantTexture = true;
      else delete parsedConfig.useSharedFondantTexture;
      // Facing offset persisted in DEGREES + rotation_unit:'deg' (unified with AddElement and the
      // piping calibrator; read by the designer via facingOffsetRadians). Clearing it drops both.
      if (glbRotation.some(v => v !== 0)) {
        parsedConfig.rotation      = glbRotation.map(v => Math.round(v));
        parsedConfig.rotation_unit = 'deg';
      } else {
        delete parsedConfig.rotation;
        delete parsedConfig.rotation_unit;
      }
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

      // Persist a new thumbnail only when it's a deliberate change: the user clicked
      // "Save + Thumbnail" (withThumbnail), OR they manually uploaded/replaced one (thumbManual).
      // The 3D preview auto-stages a blob on load purely for the live preview — plain "Save" must
      // NOT upload that, so routine data edits keep the existing thumbnail untouched.
      if (newThumbBlob && (withThumbnail || thumbManual)) {
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
      setThumbManual(false);
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
            {flip ? 'Flip: On' : 'Flip: Off'}
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
                      {on ? `${mode}` : mode}
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
                    onChange={e => {
                      const newTypeId = e.target.value;
                      setElementTypeId(newTypeId);
                      setParentId('');
                      // Seed a parts skeleton when switching to decor_pattern, unless the
                      // current config already has parts (don't clobber real edits).
                      if (elementTypes.find(t => t.id === newTypeId)?.slug === 'decor_pattern') {
                        let cur = {}; try { cur = JSON.parse(placementConfig); } catch { cur = {}; }
                        if (!Array.isArray(cur.parts)) {
                          onPcJsonEdit(JSON.stringify({ ...DEFAULT_DECOR_PATTERN_PLACEMENT_CONFIG, ...cur }, null, 2));
                        }
                      }
                    }}>
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
                        ? <span style={{ fontSize: 11, fontWeight: 800, color: '#6B8C74', letterSpacing: 0.5 }}>3D</span>
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
                              <div style={{ width: `${(normDeg360(glbRotation[idx]) / 359) * 100}%`, height: '100%', background: axisColor, borderRadius: 2 }} />
                            </div>
                            <span style={{ fontSize: 11, color: '#6B8C74', fontWeight: 600, minWidth: 32, textAlign: 'right' }}>{Math.round(normDeg360(glbRotation[idx]))}°</span>
                          </div>
                        ))}
                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                          <button onClick={confirmFrontView}
                            style={{ fontSize: 11, padding: '5px 12px', borderRadius: 6, border: `2px solid ${frontConfirmed ? '#3D5A44' : '#e05252'}`, background: frontConfirmed ? '#3D5A44' : '#fff', color: frontConfirmed ? '#fff' : '#e05252', cursor: 'pointer', fontWeight: 700, fontFamily: "'Quicksand',sans-serif" }}>
                            {frontConfirmed ? 'Front set' : 'Set front view (required)'}
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
                            {regenerating ? 'Capturing…' : 'Capture thumbnail'}
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
                          if (!isGlb) { setThumbManual(true); processRemoveBg(f); }
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
                      onChange={e => { if (e.target.files[0]) { setNewThumbBlob(e.target.files[0]); setThumbManual(true); } }} />
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
                      { key: 'color',     label: 'Color changeable', hint: 'Color picker in the designer — tints a GLB material, or recolours a 2D image (choose the area below)' },
                      { key: 'gradient',  label: 'Gradient colors',  hint: 'Customer can blend up to 3 colors (swirl / vertical / linear) — for swirls & ombré (GLB only)' },
                      { key: 'delete',    label: 'Deletable',        hint: 'Remove button shown when selected' },
                      { key: 'move',      label: 'Movable',          hint: 'Nudge ◀▶▲▼ position on the cake' },
                      { key: 'tilt',      label: 'Tiltable',         hint: 'Lean / rotate slightly in the designer' },
                    ].map(({ key, label, hint }) => (
                      <label key={key} style={{ ...s.checkRow, alignItems: 'flex-start', cursor: 'pointer' }}>
                        <input type="checkbox" style={{ ...s.checkbox, marginTop: 1 }}
                          checked={capabilities[key] ?? false}
                          onChange={e => {
                            const checked = e.target.checked;
                            setCapabilities(c => ({ ...c, [key]: checked }));
                            // A colour-changeable 2D image needs a recolour region descriptor (which
                            // pixels). Write the default on enable, remove it on disable.
                            if (key === 'color' && selectedEl?.image_url && !isGlb) {
                              patchPc({ recolor: checked ? recolorDesc() : '' });
                            }
                          }} />
                        <div>
                          <div style={s.checkLabel}>{label}</div>
                          <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>{hint}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                  {/* Recolourable area — generic; appears only when colour-changeable AND a 2D image. */}
                  {capabilities.color && selectedEl?.image_url && !isGlb && (
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed #C5D4C8' }}>
                      <label style={{ ...s.label, marginBottom: 4 }}>Recolourable area</label>
                      <select style={s.select} value={recolorMethod}
                        onChange={e => { const m = e.target.value; setRecolorMethod(m); patchPc({ recolor: recolorDesc(m) }); }}>
                        <option value="opaque">Whole image — recolour every pixel (solid stickers)</option>
                        <option value="saturated">Coloured fill, keep black/white lines (any colour + outline)</option>
                        <option value="blue_gt_green">Coloured fill, keep gold/white outline (blue-dominant fill)</option>
                      </select>
                      {recolorMethod === 'blue_gt_green' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>Edge protect</span>
                          <input type="number" min="0" max="50" step="1" style={{ ...s.input, flex: 1 }} value={recolorGuard}
                            placeholder="12 — raise if colour bleeds into the outline"
                            onChange={e => { const g = e.target.value; setRecolorGuard(g); patchPc({ recolor: recolorDesc('blue_gt_green', g) }); }} />
                        </div>
                      )}
                      {recolorMethod === 'saturated' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>Saturation min</span>
                          <input type="number" min="0" max="0.8" step="0.01" style={{ ...s.input, flex: 1 }} value={recolorSat}
                            placeholder="0.25 — lower catches more, higher protects lines"
                            onChange={e => { const sv = e.target.value; setRecolorSat(sv); patchPc({ recolor: recolorDesc('saturated', recolorGuard, sv) }); }} />
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 6, lineHeight: 1.5 }}>
                        Which pixels the colour picker recolours (brightness preserved). <b>Whole image</b> for a single-fill sticker; <b>Coloured fill</b> keeps gold/white outlines. Multi-colour artwork isn't a fit — leave colour-changeable off.
                      </div>
                    </div>
                  )}
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

                {/* ── Placement Config ── */}
                {applicableZones.length > 0 && (
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
                              value={placementZoneConfig[zone] ?? 'hug'}
                              onChange={e => { const v = e.target.value; setPlacementZoneConfig(c => ({ ...c, [zone]: v })); patchPc({ [zone]: v }); }}>
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
                          onChange={e => { setPlacementScale(e.target.value); patchPc({ r: numPatch(e.target.value) }); }} />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>Size range</span>
                        <input type="number" min="0.1" step="0.1"
                          style={{ ...s.input, flex: 1 }}
                          value={placementScaleMin}
                          placeholder="min — e.g. 0.5"
                          onChange={e => { setPlacementScaleMin(e.target.value); patchPc({ scale: scalePatch(e.target.value, placementScaleMax, placementScaleStep) }); }} />
                        <input type="number" min="0.1" step="0.1"
                          style={{ ...s.input, flex: 1 }}
                          value={placementScaleMax}
                          placeholder="max — e.g. 1.5"
                          onChange={e => { setPlacementScaleMax(e.target.value); patchPc({ scale: scalePatch(placementScaleMin, e.target.value, placementScaleStep) }); }} />
                        <input type="number" min="0.01" step="0.01"
                          style={{ ...s.input, flex: 1 }}
                          value={placementScaleStep}
                          placeholder="step — e.g. 0.05"
                          onChange={e => { setPlacementScaleStep(e.target.value); patchPc({ scale: scalePatch(placementScaleMin, placementScaleMax, e.target.value) }); }} />
                      </div>
                      <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>
                        Size-control bounds in the designer: min, max, and the step increment per notch. All optional. Pick a step that divides max−min evenly, and keep r within the range.
                      </div>
                      <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>
                        Limits how far users can resize this element in the designer (e.g. sprinkles stay small). Either bound is optional; blank both for the designer defaults. Keep the default scale (r) within this range.
                      </div>
                      <label style={{ ...s.checkRow, alignItems: 'flex-start', marginTop: 6 }}>
                        <input type="checkbox" style={{ ...s.checkbox, marginTop: 1 }}
                          checked={singlePerSlot}
                          onChange={e => { setSinglePerSlot(e.target.checked); patchPc({ single_per_slot: e.target.checked ? true : null }); }} />
                        <div>
                          <div style={s.checkLabel}>Single per slot (hero element)</div>
                          <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>
                            One instance per tier×surface via the checkbox chooser (toppers, top&side decor), instead of free scatter.
                          </div>
                        </div>
                      </label>
                      <label style={{ ...s.checkRow, alignItems: 'flex-start', marginTop: 6 }}>
                        <input type="checkbox" style={{ ...s.checkbox, marginTop: 1 }}
                          checked={useFondant}
                          onChange={e => { setUseFondant(e.target.checked); patchPc({ useSharedFondantTexture: e.target.checked ? true : null }); }} />
                        <div>
                          <div style={s.checkLabel}>Use shared fondant texture</div>
                          <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>
                            Overlays a soft, matte fondant grain in the designer (under any colour). Off = use the GLB's own surface.
                          </div>
                        </div>
                      </label>
                      <label style={{ ...s.checkRow, alignItems: 'flex-start', marginTop: 6 }}>
                        <input type="checkbox" style={{ ...s.checkbox, marginTop: 1 }}
                          checked={canScatter}
                          onChange={e => {
                            const on = e.target.checked;
                            setCanScatter(on);
                            // Scatter and single-per-slot are mutually exclusive.
                            if (on) { setSinglePerSlot(false); patchPc({ scatter: true, single_per_slot: null }); }
                            else patchPc({ scatter: null });
                          }} />
                        <div>
                          <div style={s.checkLabel}>Can scatter (density)</div>
                          <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>
                            Many packed instances controlled by a density slider in the designer (sprinkles, pearls). For discrete decor, leave off and let users duplicate by hand.
                          </div>
                        </div>
                      </label>
                      <label style={{ ...s.checkRow, alignItems: 'flex-start', marginTop: 6 }}
                        title="Off = lies flat against the side (hugs the wall). On = raised off the wall — for deep 3D pieces that look half-buried when flattened.">
                        <input type="checkbox" style={{ ...s.checkbox, marginTop: 1 }}
                          checked={sideProud}
                          onChange={e => { setSideProud(e.target.checked); patchPc({ side_proud: e.target.checked ? true : null }); }} />
                        <div>
                          <div style={s.checkLabel}>Stands out from the side wall</div>
                          <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>
                            Off = lies flat against the side (hugs the wall). On = raised off the wall — for deep 3D pieces (e.g. a topper) that look half-buried when flattened.
                          </div>
                        </div>
                      </label>
                      <label style={{ ...s.checkRow, alignItems: 'flex-start', marginTop: 6 }}>
                        <input type="checkbox" style={{ ...s.checkbox, marginTop: 1 }}
                          checked={patternOnly}
                          onChange={e => { setPatternOnly(e.target.checked); patchPc({ pattern_only: e.target.checked ? true : null }); }} />
                        <div>
                          <div style={s.checkLabel}>Pattern-only (hide as individual)</div>
                          <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>
                            A building-block part of a pattern (e.g. one unicorn eye). Hidden from the decorations picker; placed only via its parent decor_pattern.
                          </div>
                        </div>
                      </label>
                      {singlePerSlot && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>Side hug fill</span>
                          <input type="number" min="0.1" max="1" step="0.05"
                            style={{ ...s.input, flex: 1 }}
                            value={hugFill}
                            placeholder="0.7 — fraction of wall height (blank = default)"
                            onChange={e => { setHugFill(e.target.value); patchPc({ hug_fill: numPatch(e.target.value) }); }} />
                        </div>
                      )}
                      {applicableZones.some(z => (placementZoneConfig[z] ?? 'hug') === 'verge') && (
                        <>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>Verge seat</span>
                            <select style={{ ...s.select, flex: 1 }} value={vergeSeat}
                              onChange={e => { setVergeSeat(e.target.value); patchPc({ verge: vergeDesc(e.target.value) }); }}>
                              <option value="center">center — mid-spine rests on the rim edge (drapes over the lip)</option>
                              <option value="base">base — body base sits on the top surface, leans from there</option>
                            </select>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>Verge lean</span>
                            <input type="number" min="0" max="69" step="1" style={{ ...s.input, flex: 1 }} value={vergeAngle}
                              placeholder="angle° — e.g. 35 (blank = default)"
                              onChange={e => { setVergeAngle(e.target.value); patchPc({ verge: vergeDesc(vergeSeat, e.target.value) }); }} />
                            <input type="number" step="0.01" style={{ ...s.input, flex: 1 }} value={vergeYOffset}
                              placeholder="height — e.g. 0"
                              onChange={e => { setVergeYOffset(e.target.value); patchPc({ verge: vergeDesc(vergeSeat, vergeAngle, e.target.value) }); }} />
                            <input type="number" step="0.01" style={{ ...s.input, flex: 1 }} value={vergeEdgeInset}
                              placeholder="edge inset — e.g. 0"
                              onChange={e => { setVergeEdgeInset(e.target.value); patchPc({ verge: vergeDesc(vergeSeat, vergeAngle, vergeYOffset, e.target.value) }); }} />
                          </div>
                          <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>
                            Verge reclines radially outward over the rim (butterflies, flowers). Seat = center (mid-spine on the lip, body drapes over) or base (body base on the top). Lean angle° (blank = 35) is the default Tilt, plus an optional height nudge and edge inset (+ pulls in, − pushes out over the lip).
                          </div>
                        </>
                      )}
                      {selectedEl?.image_url && !isGlb && (
                        <>
                          <label style={{ ...s.checkRow, alignItems: 'flex-start', marginTop: 4 }}>
                            <input type="checkbox" style={{ ...s.checkbox, marginTop: 1 }} checked={foldable}
                              onChange={e => { const on = e.target.checked; setFoldable(on);
                                patchPc(on ? { foldable: true } : { foldable: '', fold: '', spine: '' }); }} />
                            <div>
                              <div style={s.checkLabel}>Folded decal (two hinged wings)</div>
                              <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>
                                Splits the image at the spine into two wings that fold up into a shallow V — for folded card decals like a butterfly. Upright, roughly symmetric image.
                              </div>
                            </div>
                          </label>
                          {foldable && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                              <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>Fold / spine</span>
                              <input type="number" min="0" max="75" step="1" style={{ ...s.input, flex: 1 }} value={foldAngle}
                                placeholder="fold° — e.g. 32 (blank = 30)"
                                onChange={e => { setFoldAngle(e.target.value); patchPc({ fold: numPatch(e.target.value) }); }} />
                              <input type="number" min="0.35" max="0.65" step="0.01" style={{ ...s.input, flex: 1 }} value={spineSplit}
                                placeholder="spine — e.g. 0.5"
                                onChange={e => { setSpineSplit(e.target.value); patchPc({ spine: numPatch(e.target.value) }); }} />
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}

                {/* ── placement_config JSON editor (+ calibrator paste side-by-side for piping) ── */}
                <div style={s.field}>
                  <label style={s.label}>placement_config (JSON)
                    {(() => { try { JSON.parse(placementConfig); return <span style={{ marginLeft: 8, fontSize: 11, color: '#3D5A44', fontWeight: 600 }}>valid</span>; }
                      catch (e) { return <span style={{ marginLeft: 8, fontSize: 11, color: '#c0392b', fontWeight: 700 }}>invalid JSON — won’t save</span>; } })()}
                  </label>

                  <>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'stretch', flexWrap: 'wrap' }}>
                        {/* Left — paste to merge */}
                        <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: '#6B8C74', marginBottom: 4, fontFamily: "'Quicksand',sans-serif", textTransform: 'uppercase', letterSpacing: 0.5 }}>{isPipingConfig ? 'From Piping Calibrator' : 'Paste JSON to merge'}</div>
                          <textarea
                            rows={14}
                            value={calibratorJson}
                            onChange={e => setCalibratorJson(e.target.value)}
                            onClick={e => e.stopPropagation()}
                            onFocus={e => e.stopPropagation()}
                            onPointerDown={e => e.stopPropagation()}
                            spellCheck={false}
                            placeholder={isPipingConfig
                              ? '{\n  "bottom_flip": true,\n  "bottom_rotation": [83, -180, -3],\n  "bottom_radial_offset": 0.2,\n  "bottom_y_offset": 0.09,\n  "top_flip": false,\n  "top_rotation": [-15, 97, 12],\n  "top_radial_offset": -0.06,\n  "top_y_offset": -0.02\n}'
                              : '{\n  "mode": "side",\n  "r": 1,\n  "rotation": [0, 0, 0],\n  "y_offset": 0\n}'}
                            style={{ flex: 1, width: '100%', minHeight: 260, fontFamily: 'monospace', fontSize: 11, borderRadius: 8, border: '1.5px solid #C5D4C8', padding: '8px 10px', boxSizing: 'border-box', resize: 'vertical', display: 'block', lineHeight: 1.6, color: '#2C4433' }}
                          />
                        </div>

                        {/* Middle — merge arrow */}
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}>
                          <button
                            type="button"
                            title="Merge the pasted values into placement_config"
                            disabled={!calibratorJson.trim()}
                            onClick={e => {
                              e.stopPropagation();
                              try {
                                const v = JSON.parse(calibratorJson);
                                const cur = JSON.parse(placementConfig);
                                // Combined format: keys are already top_*/bottom_* — merge straight in.
                                // Legacy piping format has a `target` + generic keys, mapped to one prefix.
                                // Non-piping elements always take the plain shallow merge.
                                const isCombined = Object.keys(v).some(k => k.startsWith('top_') || k.startsWith('bottom_'));
                                let merged;
                                if (!isPipingConfig || isCombined) {
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
                                onPcJsonEdit(JSON.stringify(merged, null, 2));
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
                            onChange={e => onPcJsonEdit(e.target.value)}
                            onClick={e => e.stopPropagation()}
                            onFocus={e => e.stopPropagation()}
                            onPointerDown={e => e.stopPropagation()}
                            spellCheck={false}
                            style={{ flex: 1, width: '100%', minHeight: 260, fontFamily: 'monospace', fontSize: 11, borderRadius: 8, border: '1.5px solid #C5D4C8', padding: '8px 10px', boxSizing: 'border-box', resize: 'vertical', display: 'block', lineHeight: 1.6, color: '#2C4433', background: '#f9fbf9' }}
                          />
                        </div>
                      </div>
                      <div style={{ fontSize: 10, color: '#9aaa9e', marginTop: 4, fontFamily: "'Quicksand',sans-serif" }}>
                        {isPipingConfig
                          ? <>Paste the Calibrator output on the left → hit <b>Merge →</b> → it folds into placement_config on the right. Accepts the combined <code>top_*</code>/<code>bottom_*</code> format or the legacy single-<code>target</code> string. Saved as-is to the DB.</>
                          : <>Paste JSON on the left → hit <b>Merge →</b> → its keys fold into placement_config on the right (overwriting matching keys). Or edit the right side directly. Saved as-is to the DB.</>}
                      </div>
                    </>
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
