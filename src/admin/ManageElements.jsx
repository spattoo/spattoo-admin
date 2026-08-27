import { useState, useEffect, useRef, useMemo, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, useGLTF, Environment } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  fetchAdminElementTypes, fetchAdminElementCategories, createElementCategory,
  fetchAllElements, fetchParentElements,
  uploadThumbnail, uploadAsset, updateGlobalElement, createGlobalElement, deleteR2Object, exportElements,
} from '../lib/api.js';
import { PatternCakeThumb } from './PipingCalibrator.jsx';
import CraftGuideEditor from './CraftGuideEditor.jsx';
import DecorationGuidePanel from './DecorationGuidePanel.jsx';
import { normalizeArtwork } from '@spattoo/designer';
import { prepareElementImage, ELEMENT_IMAGE_DIM, PATTERN_THUMB_DIM } from '../lib/elementImage.js';
import { statsFromElement } from '../lib/glb.js';
import { GlbStatChips, OverCapBadge } from './GlbStats.jsx';
import { serializeZone, zoneValueMode, zoneValueSeat, zoneValueAlt, zoneAltMode, zoneShowsSeat, zoneShowsInsert, splitZoneValue, ringZonePrefix } from '../lib/placementSeat.js';
import PlacementZoneRow from './PlacementZoneRow.jsx';
import ElementPreviewPanel from './ElementPreviewPanel.jsx';

const CAKE_ZONES = [
  { value: 'top_surface', label: 'Top Surface' },
  { value: 'side',        label: 'Side' },
  { value: 'middle_tier', label: 'Middle Tier' },
  { value: 'rim',         label: 'Rim' },
  { value: 'board',       label: 'Board' },
];

// Positions only. `insert` is NO LONGER a position — it's a per-zone MODIFIER (a checkbox on the
// stand/hug poses, see PlacementZoneRow + zoneShowsInsert), so it stays out of this list.
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
  recencyRow: { display: 'flex', gap: 4, marginTop: 8 },
  recencyChip: {
    flex: 1, padding: '5px 0', borderRadius: 8, cursor: 'pointer',
    borderWidth: 1.5, borderStyle: 'solid', borderColor: '#C5D4C8',
    background: '#fff', color: '#6B8C74', fontSize: 11, fontWeight: 700,
    fontFamily: "'Quicksand',sans-serif",
  },
  recencyChipOn: { background: '#2C4433', borderColor: '#2C4433', color: '#fff' },
  selectAllBtn: {
    marginTop: 8, width: '100%', padding: '6px 0', borderRadius: 8, cursor: 'pointer',
    borderWidth: 1.5, borderStyle: 'solid', borderColor: '#C5D4C8',
    background: '#fff', color: '#2C4433', fontSize: 12, fontWeight: 700,
    fontFamily: "'Quicksand',sans-serif",
  },

  // Appears only when something is picked — a permanently visible bar for an occasional action is
  // chrome the other 99% of visits pay for.
  exportBar: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 12px', borderBottom: '1px solid #C5D4C8',
    background: '#F3F7F4', fontSize: 12, color: '#2C4433', fontFamily: "'Quicksand',sans-serif",
  },
  exportBtn: {
    marginLeft: 'auto', padding: '5px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
    background: '#2C4433', color: '#fff', fontSize: 12, fontWeight: 700, fontFamily: "'Quicksand',sans-serif",
  },
  exportClear: {
    padding: '5px 10px', borderRadius: 8, cursor: 'pointer',
    borderWidth: 1.5, borderStyle: 'solid', borderColor: '#C5D4C8',
    background: '#fff', color: '#6B8C74', fontSize: 12, fontWeight: 700, fontFamily: "'Quicksand',sans-serif",
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

// Which studio authored a generated element, by the generator it names. The key is
// `placement_config.procedural` — the same value the designer's PROCEDURAL_TOOLS registry looks up
// to place one, so the two cannot drift about what exists.
const PROCEDURAL_STUDIOS = {
  rainbow:       { href: '/elements/rainbow',        label: 'Rainbow Studio' },
  cloud:         { href: '/elements/cloud',          label: 'Cloud Studio' },
  grass:         { href: '/elements/grass',          label: 'Grass Studio' },
  letter_blocks: { href: '/elements/letter-blocks',  label: 'Letter Blocks Studio' },
};
// Chocolate drip is deliberately absent, the same way it is absent from PROCEDURAL_TOOLS: it writes
// a piping layer rather than placing a decoration, and its config says `top_drip` rather than naming
// a generator. An entry for it would be a key nothing ever matches.

// ── Main component ────────────────────────────────────────────────────────────
export default function ManageElements() {
  const [elementTypes, setElementTypes] = useState([]);
  // Browsing category (migration 065). This screen is where the 86 backfilled elements get their
  // categories corrected — the backfill guessed from names, and a guess is not an authored answer.
  const [categories, setCategories]     = useState([]);
  const [categoryId, setCategoryId]     = useState('');
  const [newCategory, setNewCategory]   = useState('');
  const [addingCategory, setAddingCategory] = useState(false);
  const [elements,     setElements]     = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [query,        setQuery]        = useState('');
  const [overCapOnly,  setOverCapOnly]  = useState(false);   // filter: only elements over their §3 budget
  // Filter: how recently an element was added. "The ones I added today" is how a promotion is
  // actually thought about, and ticking ten boxes from memory is how one gets missed — a missing
  // element does not error in prod, it is simply absent until somebody notices.
  const [addedWithin, setAddedWithin] = useState(0);   // days; 0 = any time
  const [selectedId,   setSelectedId]   = useState(null);
  const [cloneMode,    setCloneMode]    = useState(false);   // "create a NEW element from these settings"
  // Bumped on every successful save. The preview renders the SAVED row, so this is its cue to
  // re-fetch — which is what makes "save, then look" a loop instead of a page reload.
  const [savedAt,      setSavedAt]      = useState(0);
  // ── Picked for export ─────────────────────────────────────────────────────────────────────────
  // Separate from `selectedId`, which is "the element being edited". Ticking a row must not load it
  // into the form, and editing one must not change what is about to be promoted.
  const [picked, setPicked] = useState(() => new Set());
  const [exporting, setExporting] = useState(false);

  const togglePicked = (id) => setPicked(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  async function handleExport() {
    if (!picked.size) return;
    setExporting(true);
    try {
      const bundle = await exportElements([...picked]);
      // The server resolves the CLOSURE, so what comes back is routinely more than what was ticked —
      // element types, parent elements, tags. Say so, because silently exporting a parent nobody
      // chose is a surprise best had here rather than in prod.
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `elements-${new Date().toISOString().slice(0, 10)}-${bundle.elements.length}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg({ ok: true, text:
        `Exported ${bundle.elements.length} element(s) — plus ${bundle.element_types.length} type(s), ` +
        `${bundle.tags.length} tag(s), ${bundle.assets.length} asset(s).` });
    } catch (e) {
      setMsg({ ok: false, text: e?.message ?? 'Export failed' });
    } finally {
      setExporting(false);
    }
  }

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
  // WHAT IT IS MADE OF. Technique already lives in the element TYPE (Cream Piping vs Palette knife
  // art), so this is material only — and it decides what X-Ray offers: fondant gets a modelling
  // guide AND printing, a printed sheet gets only printing, acrylic gets neither.
  const [medium,           setMedium]           = useState('');
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
  // 2D only: run remove.bg when generating the thumbnail from a replaced image. ON by default; turn
  // OFF for images whose alpha is already authored (e.g. a photo-frame overlay). NOTE: the asset
  // (image_url) is always uploaded untouched here regardless — this only governs the auto-thumbnail.
  const [removeBgEnabled,  setRemoveBgEnabled]  = useState(true);
  const [glbColor,         setGlbColor]         = useState('#F0DEB8');
  const [userPickedColor,  setUserPickedColor]  = useState(false);
  const [glbRoughness,     setGlbRoughness]     = useState(0.6);
  const [glbMetalness,     setGlbMetalness]     = useState(0);
  const [glbEnvPreset,     setGlbEnvPreset]     = useState('none');

  const [placementConfig,    setPlacementConfig]    = useState('{}');
  const [placementZoneConfig, setPlacementZoneConfig] = useState({});   // per-zone MODE string
  const [seatConfig,          setSeatConfig]          = useState({});   // per-zone seat override: { side: 'proud'|'flush', ... } — 'auto'/absent = default
  const [placementScale,      setPlacementScale]      = useState('');
  const [placementScaleMin,   setPlacementScaleMin]   = useState('');   // placement_config.scale.min
  const [placementScaleMax,   setPlacementScaleMax]   = useState('');   // placement_config.scale.max
  const [placementScaleStep,  setPlacementScaleStep]  = useState('');   // placement_config.scale.step
  const [singlePerSlot,      setSinglePerSlot]      = useState(false);
  const [canScatter,         setCanScatter]         = useState(false);
  const [scatterCount,       setScatterCount]       = useState('');   // placement_config.scatter_count (blank = designer default 12)
  const [useFondant,         setUseFondant]         = useState(false);   // placement_config.useSharedFondantTexture
  const [hugFill,            setHugFill]            = useState('');
  // Packed ball cluster (placement_config.cluster) — see AddElement. sizes = [largest,2nd,3rd,small].
  const [canCluster,         setCanCluster]         = useState(false);
  const [clusterMin,         setClusterMin]         = useState('');
  const [clusterMax,         setClusterMax]         = useState('');
  const [clusterSizes,       setClusterSizes]       = useState('1.6, 1.35, 0.85, 0.5');
  const [clusterPalette,     setClusterPalette]     = useState('');
  // Verge (rests on the rim lip, reclines outward over the edge) — placement_config.verge object.
  const [vergeSeat,      setVergeSeat]      = useState('center'); // verge.seat: center | base
  const [vergeAngle,     setVergeAngle]     = useState('');   // verge.angle_deg (blank = default 35)
  const [vergeYOffset,   setVergeYOffset]   = useState('');   // verge.y_offset (blank = 0)
  const [vergeEdgeInset, setVergeEdgeInset] = useState('');   // verge.edge_inset (blank = 0)
  // Insert (base sunk into the surface at an angle — chocolate bars, sparklers) is a per-zone
  // MODIFIER now (rides `placement_config[zone].insert`, like `seat`), NOT a global position. One
  // entry per zone that has it on: { [zone]: { depth?, lean_deg?, jitter_deg? } } ({} = on, defaults).
  const [insertConfig,  setInsertConfig]   = useState({});
  // Per-zone SECOND pose the customer may pick: { top_surface: 'hug' }. Absent = one pose, which is
  // every element authored so far — the control only appears where a choice is possible at all.
  const [altConfig,     setAltConfig]      = useState({});
  const [fullRingConfig, setFullRingConfig] = useState({});   // per ring-zone { rim, board } — mirrors top_/bottom_ring_finish==='element'
  // Folded sticker (2D) + pixel-recolour region — config-driven capabilities (see spattoo-core).
  const [foldable,      setFoldable]      = useState(false);
  const [foldAngle,     setFoldAngle]     = useState('');
  const [spineSplit,    setSpineSplit]    = useState('');
  const [recolorMethod, setRecolorMethod] = useState('opaque');
  const [recolorGuard,  setRecolorGuard]  = useState('12');
  const [recolorSat,    setRecolorSat]    = useState('0.25');
  // Print finish (placement_config.print_finish) — OPTIONAL artistic overrides. The designer now renders a
  // print at exactly 1× its artwork by construction (spattoo-core shared/printExposure.js), so these exist
  // to make a deliberate choice, NOT to correct a render that is wrong. Blank writes no key at all.
  const [printSat,     setPrintSat]     = useState('');   // print_finish.saturation — chroma boost (1 = the artwork)
  const [printShading, setPrintShading] = useState('');   // print_finish.shading    — how much cake light it takes
  const [printGain,    setPrintGain]    = useState('');   // print_finish.gain       — exposure (1 = the artwork)
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

  // Deep link: /elements/manage?element=<id> opens straight onto that element (the Relief Sticker Studio
  // links back this way, so you return to the row you were tuning). Waits for BOTH lists — selectElement
  // resolves the element's type slug to seed a missing placement_config, and would mis-seed on an empty
  // elementTypes. Fires once; a later manual selection must not be yanked back.
  const deepLinkId = useMemo(() => new URLSearchParams(window.location.search).get('element'), []);
  const deepLinkedRef = useRef(false);
  useEffect(() => {
    if (deepLinkedRef.current || !deepLinkId || !elements.length || !elementTypes.length) return;
    deepLinkedRef.current = true;
    const el = elements.find(e => e.id === deepLinkId);
    if (el) selectElement(el);
  }, [deepLinkId, elements, elementTypes]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!elementTypeId || isParent) { setParentOptions([]); return; }
    fetchParentElements(elementTypeId)
      .then(setParentOptions)
      .catch(() => setParentOptions([]));
  }, [elementTypeId, isParent]);

  async function loadAll() {
    setLoading(true);
    try {
      const [types, els, cats] = await Promise.all([
        fetchAdminElementTypes(),
        fetchAllElements(),
        // Categories must not be able to fail the whole screen — every other field on this form
        // works without them, and an element with no category is still fully placeable.
        fetchAdminElementCategories().catch(() => []),
      ]);
      setElementTypes(types);
      setElements(els);
      setCategories(cats);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  // Inline, for the same reason as on AddElement: you discover a category is missing while looking
  // at the element that needs it, and being sent to another screen loses the edit in progress.
  async function addCategory() {
    const name = newCategory.trim();
    if (!name) return;
    setAddingCategory(true);
    try {
      const created = await createElementCategory(name);
      // Sorted, not appended — the API places a new category at the END of the menu, and this list
      // has to match or the picker stops reflecting the order customers will see.
      setCategories(cs => [...cs, created].sort((a, b) => a.sort_order - b.sort_order));
      setCategoryId(created.id);
      setNewCategory('');
    } catch (err) {
      console.error(err);
      alert(err.message);
    } finally {
      setAddingCategory(false);
    }
  }

  function selectElement(el) {
    setCloneMode(false);   // selecting a row always exits clone mode
    setSelectedId(el.id);
    setName(el.name);
    setElementTypeId(el.element_type_id);
    // '' rather than null so the select is controlled — a null value makes React treat it as
    // uncontrolled and the field stops responding to further selections.
    setCategoryId(el.category_id ?? '');
    setApplicableZones(el.allowed_zones ?? []);
    setIsParent(!el.parent_id);
    setParentId(el.parent_id ?? '');
    setCapabilities(el.allowed_actions ?? { resize: true, duplicate: true, color: false, delete: true, move: false, tilt: false });
    setDefaultColor(el.default_color ?? '#F0DEB8');
    setMedium(el.medium ?? '');
    setPreviewColor(el.default_color ?? '#f5e6c8');   // seed pattern-thumbnail cream from default
    setIsActive(el.is_active ?? true);
    setNewAssetFile(null);
    setNewThumbBlob(null);
    setThumbManual(false);
    setRemoveBgEnabled(true);
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
    loadZonesFromPc(pc, el.allowed_zones);
    setPlacementScale(pc.r != null ? String(pc.r) : '');
    setPlacementScaleMin(pc.scale?.min != null ? String(pc.scale.min) : '');
    setPlacementScaleMax(pc.scale?.max != null ? String(pc.scale.max) : '');
    setPlacementScaleStep(pc.scale?.step != null ? String(pc.scale.step) : '');
    setSinglePerSlot(pc.single_per_slot === true);
    setUseFondant(pc.useSharedFondantTexture === true);
    setCanScatter(pc.scatter === true);
    setScatterCount(pc.scatter_count != null ? String(pc.scatter_count) : '');
    setHugFill(pc.hug_fill != null ? String(pc.hug_fill) : '');
    loadClusterFromPc(pc);
    loadPrintFinishFromPc(pc);
    setVergeSeat(pc.verge?.seat === 'base' ? 'base' : 'center');
    setVergeAngle(pc.verge?.angle_deg != null ? String(pc.verge.angle_deg) : '');
    setVergeYOffset(pc.verge?.y_offset != null ? String(pc.verge.y_offset) : '');
    setVergeEdgeInset(pc.verge?.edge_inset != null ? String(pc.verge.edge_inset) : '');
    // insert is loaded per-zone inside loadZonesFromPc (splitZoneValue promotes the legacy global).
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

  async function processRemoveBg(blob, enabled = removeBgEnabled) {
    setRemovingBg(true);
    setNewThumbBlob(null);
    try {
      // Same shared 2D pipeline as AddElement: bg-remove (unless disabled) + normalize. Used as the
      // thumbnail AND (for 2D + remove-bg) the replacement asset, so the sticker comes out transparent.
      setNewThumbBlob(await prepareElementImage(blob, { removeBgEnabled: enabled }));
    } catch {
      setNewThumbBlob(await normalizeArtwork(blob, { size: ELEMENT_IMAGE_DIM }));
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
  // Split a placement_config's per-zone values (string OR { mode, seat, insert }) into the mode +
  // seat + insert control maps. Used by both element-load and JSON-edit sync so they can't drift.
  // `splitZoneValue` promotes the legacy `insert` POSITION (mode:"insert" + shared global insert)
  // into { mode:<stand|hug>, insert:{…} }. Migrates the legacy global `side_proud` flag → a per-zone
  // 'proud' seat when no explicit seat is authored.
  function loadZonesFromPc(pc, zones) {
    const modeConf = {}, seatConf = {}, insertConf = {}, altConf = {};
    (zones ?? []).forEach(z => {
      const raw = pc[z];
      const { mode, insert } = splitZoneValue(raw, z, pc.insert);
      if (raw != null) modeConf[z] = mode;
      // Only keep a stored alternate the zone could actually offer — an author may have hand-edited
      // the JSON, and a pose the renderer has no branch for would be a promise we cannot keep.
      const alt = zoneValueAlt(raw);
      if (alt && alt === zoneAltMode(z, mode)) altConf[z] = alt;
      let seat = zoneValueSeat(raw);
      if (seat === 'auto' && pc.side_proud === true && zoneShowsSeat(z, mode)) seat = 'proud';
      if (seat !== 'auto') seatConf[z] = seat;
      if (insert != null && zoneShowsInsert(mode)) insertConf[z] = insert;
    });
    setPlacementZoneConfig(modeConf);
    setSeatConfig(seatConf);
    setInsertConfig(insertConf);
    setAltConfig(altConf);
    // Full ring is a FLAT top_/bottom_ config, not a per-zone value — read it straight off the pc.
    setFullRingConfig({ rim: pc.top_ring_finish === 'element', board: pc.bottom_ring_finish === 'element' });
  }

  // Toggle the "full ring" for a rim/board zone. Stored as the FLAT top_/bottom_ ring keys the designer
  // reads (arrangement:'ring' + ring_finish:'element' so any decoration keeps its real materials), NOT
  // the per-zone object. rim → top_, board → bottom_ (ringZonePrefix). Clearing removes the keys.
  function setZoneFullRing(zone, on) {
    const ns = ringZonePrefix(zone);
    if (!ns) return;
    setFullRingConfig(c => ({ ...c, [zone]: on }));
    patchPc(on
      ? { [`${ns}_ring_finish`]: 'element', [`${ns}_arrangement`]: 'ring', [`${ns}_arrangements_allowed`]: ['ring', 'single'] }
      : { [`${ns}_ring_finish`]: null, [`${ns}_arrangement`]: null, [`${ns}_arrangements_allowed`]: null });
  }
  // Write a zone's mode + seat + insert modifier back into all three control maps AND the
  // placement_config JSON (ONE path, used by every zone control). A seat only sticks on a wall hug;
  // an insert modifier only on a pose that supports it (stand/hug). `insert` is null (off) or a params
  // object (on; {} = defaults). Also clears the LEGACY global `side_proud`/`insert` keys — they're
  // per-zone now, so any zone edit migrates them away. The JSON stores the string-or-object form.
  function commitZone(zone, mode, seat, insert, alt) {
    const effSeat = zoneShowsSeat(zone, mode) ? seat : 'auto';
    const effInsert = zoneShowsInsert(mode) ? (insert ?? null) : null;
    // A stored alternate stops being valid when the mode changes under it (stand's other pose is hug
    // and vice versa; a wall or a rim pose has none), so it is re-derived here rather than carried.
    const effAlt = (alt && alt === zoneAltMode(zone, mode)) ? alt : null;
    setAltConfig(c => {
      const next = { ...c };
      if (effAlt) next[zone] = effAlt; else delete next[zone];
      return next;
    });
    setPlacementZoneConfig(c => ({ ...c, [zone]: mode }));
    setSeatConfig(c => {
      const next = { ...c };
      if (effSeat === 'proud' || effSeat === 'flush') next[zone] = effSeat;
      else delete next[zone];
      return next;
    });
    setInsertConfig(c => {
      const next = { ...c };
      if (effInsert) next[zone] = effInsert; else delete next[zone];
      return next;
    });
    patchPc({ [zone]: serializeZone(mode, effSeat, effInsert, effAlt), side_proud: null, insert: null });
  }
  // A single insert param field edit for a zone: blank removes the key, else parse. Passing {} (all
  // blank) keeps insert ON with defaults.
  function setZoneInsertField(zone, mode, field, value) {
    const cur = insertConfig[zone] ?? {};
    const next = { ...cur };
    if (value === '' || value == null) delete next[field];
    else next[field] = parseFloat(value);
    commitZone(zone, mode, seatConfig[zone], next, altConfig[zone]);
  }
  // Reflect placement_config.print_finish into its controls (used by both load + JSON-edit sync — one
  // helper, so the two paths can't drift). Blank when absent: the designer's defaults then apply.
  function loadPrintFinishFromPc(pc) {
    setPrintSat(pc.print_finish?.saturation != null ? String(pc.print_finish.saturation) : '');
    setPrintShading(pc.print_finish?.shading != null ? String(pc.print_finish.shading) : '');
    setPrintGain(pc.print_finish?.gain != null ? String(pc.print_finish.gain) : '');
    // `emissive` is the LEGACY key from the pre-exposure model; the designer ignores it. Not surfaced.
  }
  // Reflect placement_config.cluster into the cluster controls (used by both load + JSON-edit sync).
  function loadClusterFromPc(pc) {
    setCanCluster(!!pc.cluster);
    setClusterMin(pc.cluster?.min != null ? String(pc.cluster.min) : '');
    setClusterMax(pc.cluster?.max != null ? String(pc.cluster.max) : '');
    setClusterSizes(Array.isArray(pc.cluster?.sizes) && pc.cluster.sizes.length ? pc.cluster.sizes.join(', ') : '1.6, 1.35, 0.85, 0.5');
    setClusterPalette(Array.isArray(pc.cluster?.palette) ? pc.cluster.palette.join(', ') : '');
  }
  // Write the cluster object into the JSON from the current fields (with an optional override for the
  // field being edited, since setState is async). Cluster is exclusive with scatter/single_per_slot.
  function patchCluster(ov = {}) {
    const min = ov.min ?? clusterMin, max = ov.max ?? clusterMax;
    const sizesStr = ov.sizes ?? clusterSizes, paletteStr = ov.palette ?? clusterPalette;
    const c = {};
    if (min !== '') c.min = parseInt(min, 10);
    if (max !== '') c.max = parseInt(max, 10);
    const sizes = sizesStr.split(',').map(x => parseFloat(x.trim())).filter(n => !isNaN(n) && n > 0);
    if (sizes.length) c.sizes = sizes;
    const palette = paletteStr.split(',').map(x => x.trim()).filter(Boolean);
    if (palette.length) c.palette = palette;
    patchPc({ cluster: c });
  }
  function syncStructuredFromPc(pc) {
    loadZonesFromPc(pc, applicableZones);
    setPlacementScale(pc.r != null ? String(pc.r) : '');
    setPlacementScaleMin(pc.scale?.min != null ? String(pc.scale.min) : '');
    setPlacementScaleMax(pc.scale?.max != null ? String(pc.scale.max) : '');
    setPlacementScaleStep(pc.scale?.step != null ? String(pc.scale.step) : '');
    setSinglePerSlot(pc.single_per_slot === true);
    setUseFondant(pc.useSharedFondantTexture === true);
    setCanScatter(pc.scatter === true);
    setScatterCount(pc.scatter_count != null ? String(pc.scatter_count) : '');
    setHugFill(pc.hug_fill != null ? String(pc.hug_fill) : '');
    loadClusterFromPc(pc);
    loadPrintFinishFromPc(pc);
    setVergeSeat(pc.verge?.seat === 'base' ? 'base' : 'center');
    setVergeAngle(pc.verge?.angle_deg != null ? String(pc.verge.angle_deg) : '');
    setVergeYOffset(pc.verge?.y_offset != null ? String(pc.verge.y_offset) : '');
    setVergeEdgeInset(pc.verge?.edge_inset != null ? String(pc.verge.edge_inset) : '');
    // insert is loaded per-zone inside loadZonesFromPc (splitZoneValue promotes the legacy global).
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
    // hue_regions clusters the coloured pixels BY HUE and gives the customer one swatch per detected colour
    // (the multi-colour path — a tree's trunk/leaves/flower stay separate). Like `saturated` it thresholds on
    // `sat` (which pixels count as coloured); the per-region swatches are chosen per instance in the designer.
    : m === 'hue_regions' ? { method: 'hue_regions', sat: sv !== '' ? parseFloat(sv) : 0.18 }
    : { method: 'opaque' };
  // The print_finish descriptor — only non-blank fields; all blank → '' so patchPc drops the key entirely
  // and the print renders as its artwork. Never write a "default" value into the config: an explicit key
  // freezes the element against the model. (The Relief Studio used to stamp its defaults into every
  // element it touched, which is how {emissive:0.22, saturation:1.12} ended up frozen on 7 elements and
  // the 1.4× overshoot got baked across the library. Don't reintroduce that.) The legacy `emissive` key is
  // dropped on save, so re-saving a legacy element cleans it up.
  const printFinishDesc = (sat = printSat, sh = printShading, g = printGain) => {
    const p = {};
    if (numPatch(sat) !== '') p.saturation = numPatch(sat);
    if (numPatch(sh)  !== '') p.shading    = numPatch(sh);
    if (numPatch(g)   !== '') p.gain       = numPatch(g);
    return Object.keys(p).length ? p : '';
  };
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

  // Build the element fields + merged placement_config from the CURRENT form state (no id, no asset
  // upload). Shared by Save (update) and Clone (create) so the two can't drift. Throws on bad JSON.
  function buildElementFields() {
    let parsedConfig = {};
    try { parsedConfig = JSON.parse(placementConfig); }
    catch (e) { throw new Error(`placement_config is not valid JSON — fix it before saving (${e.message}).`); }
    // Merge zone config — write the chosen mode for EVERY applicable zone, explicitly (default
    // 'hug'). No more "absent means hug": the saved config states the mode for each zone, so the
    // designer never has to guess. Per-zone modifiers (`seat` on a wall hug, `insert` on a stand/hug
    // pose) serialize into the { mode, … } object form; otherwise the plain mode string (shared
    // serializeZone). The legacy GLOBAL `insert` key is dropped — insert is per-zone now.
    applicableZones.forEach(z => {
      const mode = placementZoneConfig[z] || 'hug';
      parsedConfig[z] = serializeZone(
        mode,
        zoneShowsSeat(z, mode) ? seatConfig[z] : undefined,
        zoneShowsInsert(mode) ? insertConfig[z] : undefined,
        altConfig[z] ?? null,
      );
    });
    delete parsedConfig.insert;
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
    if (canScatter) {
      parsedConfig.scatter = true; delete parsedConfig.single_per_slot;
      // Admin-authored default instance count (core reads placement_config.scatter_count, else 12).
      if (scatterCount !== '' && parseInt(scatterCount, 10) > 0) parsedConfig.scatter_count = parseInt(scatterCount, 10);
      else delete parsedConfig.scatter_count;
    } else { delete parsedConfig.scatter; delete parsedConfig.scatter_count; }
    // Legacy global side_proud is superseded by the per-zone seat written above — never persist it.
    delete parsedConfig.side_proud;
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
    const fields = {
      name:             name.trim(),
      element_type_id:  elementTypeId,
      // null clears it — the PATCH checks `!== undefined`, so "No category" is a real edit and not
      // a no-op. A wrong category has to be removable, not merely changeable.
      category_id:      categoryId || null,
      parent_id:        isParent ? null : (parentId || null),
      allowed_zones:    applicableZones,
      /* ⚠️ delete is forced ON at the point of SAVE, not just in the form.
       * The tick being disabled stops an admin turning it off; it does not stop a `false` that is
       * ALREADY on the row being loaded into state and written straight back. Three rows in dev
       * carry delete:false from before the rule, and editing any of them for an unrelated reason
       * would have re-saved it. The form shows the rule; this is what makes it true. */
      allowed_actions:  { ...capabilities, delete: true },
      default_color:    defaultColor || null,
      // '' means "not stated" and must reach the API as null, not as an empty string the CHECK
      // constraint would reject.
      medium:           medium || null,
      is_active:        isActive,
      description,
      placement_config: parsedConfig,
    };
    return { fields, parsedConfig };
  }

  // Upload any staged files (asset / alternate GLB / thumbnail) into `fields`/`parsedConfig`. Shared
  // by Save and Clone. `forceThumb` always persists the staged thumbnail (Clone needs one); plain
  // Save only persists a DELIBERATE thumbnail change (the "Save + Thumbnail" button or a manual one).
  async function uploadStagedAssets(fields, parsedConfig, forceThumb) {
    if (newAssetFile) {
      const isGlb = /\.(glb|gltf)$/i.test(newAssetFile.name);
      const folder = isGlb ? 'elements/files/3D' : 'elements/files/2D';
      // 2D + remove-bg: store the bg-removed + normalized image (the same blob shown as the thumbnail)
      // as the asset, so the sticker is transparent and matches AddElement. GLB or remove-bg-off keeps
      // the raw file (authored alpha must survive untouched, e.g. a photo-frame overlay).
      const assetSrc = (!isGlb && removeBgEnabled && newThumbBlob) ? newThumbBlob : newAssetFile;
      fields.image_url = await uploadAsset(folder, assetSrc);
      fields.file_size = assetSrc.size ?? null;
    }
    if (altAssetFile) {
      const key = await uploadAsset('elements/files/3D', altAssetFile);
      parsedConfig.bottom_alt_glb_url = key;
      parsedConfig.top_alt_glb_url    = key;
      fields.placement_config = parsedConfig;
    }
    if (newThumbBlob && (forceThumb || thumbManual)) {
      fields.thumbnail_url = await uploadThumbnail('elements/thumbnails', newThumbBlob);
    }
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
      let fields, parsedConfig;
      try { ({ fields, parsedConfig } = buildElementFields()); }
      catch (e) { setMsg({ ok: false, text: e.message }); setSaving(false); return; }
      await uploadStagedAssets(fields, parsedConfig, withThumbnail);
      const updates = fields;
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
      setSavedAt(n => n + 1);
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

  // Enter clone mode: keep every loaded setting, but drop the source's identity + art so the next
  // save creates a NEW element. The user just adds the new image/GLB (+ thumbnail).
  function startClone() {
    setCloneMode(true);
    setNewAssetFile(null);
    setAltAssetFile(null);
    setNewThumbBlob(null);
    setThumbManual(false);
    setName(`${name.trim()} copy`);
    setMsg({ ok: true, text: 'Cloning — settings carried over. Add the new image/GLB and a thumbnail, then Create clone.' });
  }

  function cancelClone() {
    setCloneMode(false);
    setNewAssetFile(null);
    setAltAssetFile(null);
    setNewThumbBlob(null);
    setThumbManual(false);
    if (selectedEl) { setName(selectedEl.name ?? ''); }   // restore the source name
    setMsg(null);
  }

  // Create a NEW element from the current (cloned) settings. Same payload builder as Save, but POSTs
  // a fresh row — the only required new inputs are the asset and a thumbnail.
  async function handleClone() {
    if (!name.trim()) { setMsg({ ok: false, text: 'Name is required.' }); return; }
    if (!newAssetFile) { setMsg({ ok: false, text: 'Upload the new image/GLB for the clone first.' }); return; }
    if (!newThumbBlob) { setMsg({ ok: false, text: 'Add a thumbnail for the clone (upload one, or capture the front view).' }); return; }
    if (isGlb && rotationDirty && !frontConfirmed) {
      setMsg({ ok: false, text: 'Rotation was changed — click "Set front view" to confirm the orientation before creating the clone.' });
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      let fields, parsedConfig;
      try { ({ fields, parsedConfig } = buildElementFields()); }
      catch (e) { setMsg({ ok: false, text: e.message }); setSaving(false); return; }
      await uploadStagedAssets(fields, parsedConfig, true);   // clone always persists its new thumbnail
      const created = await createGlobalElement(fields);
      setCloneMode(false);
      setNewAssetFile(null);
      setAltAssetFile(null);
      setNewThumbBlob(null);
      setThumbManual(false);
      await loadAll();
      // Jump to the new element so it's ready to tweak; if the API didn't echo a full row, restore the
      // source so the form isn't left half-cloned.
      if (created?.id && created.element_type_id) selectElement(created);
      else if (selectedEl) selectElement(selectedEl);
      setMsg({ ok: true, text: `Created "${fields.name}" as a new element.` });
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
  const overCapCount = elements.filter(el => el.over_cap).length;
  // Cut once per render, not per element: `new Date()` inside the filter would make every row's
  // comparison a slightly different "now".
  const addedSince = addedWithin ? Date.now() - addedWithin * 864e5 : null;

  const grouped = elementTypes
    .map(et => ({
      type: et,
      items: elements.filter(el =>
        el.element_type_id === et.id &&
        (lowerQuery === '' || (el.name ?? '').toLowerCase().includes(lowerQuery)) &&
        (!overCapOnly || el.over_cap) &&
        // No created_at (older rows predate the column being populated) → treated as OLD rather
        // than recent. A filter that quietly includes unknowns is worse than one that excludes
        // them: you would promote something you did not mean to and never see it in the list.
        (!addedSince || (el.created_at ? new Date(el.created_at).getTime() >= addedSince : false))
      ),
    }))
    .filter(g => g.items.length > 0);

  // Select-all works on what is VISIBLE — the same filtered set the list renders, so "today" plus
  // "select all" means exactly the ten added today. Anything else would be a button that lies.
  const visibleIds = grouped.flatMap(g => g.items.map(el => el.id));
  const allVisiblePicked = visibleIds.length > 0 && visibleIds.every(id => picked.has(id));

  function toggleAllVisible() {
    setPicked(prev => {
      const next = new Set(prev);
      // Deselecting removes only the visible ones, leaving a selection built up under another
      // filter intact — the picked set is deliberately cumulative across filter changes.
      if (allVisiblePicked) visibleIds.forEach(id => next.delete(id));
      else visibleIds.forEach(id => next.add(id));
      return next;
    });
  }

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
      const thumb = await normalizeArtwork(raw, { size: PATTERN_THUMB_DIM });
      const key = await uploadThumbnail('elements/thumbnails', thumb);
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
      // ── Hand piping ────────────────────────────────────────────────────────────────────────
      // Whether "I'll pipe it myself" is offered on this element's card — repeating it along a
      // line the customer draws, instead of round a rim or a board.
      //
      // Not every piping element survives that. A wrap band is ONE pre-formed ring and a drip is a
      // procedural curtain: both are rings by nature, and stamping either along a freehand squiggle
      // produces something nobody would pipe. A shell or a rosette repeats happily. That judgement
      // is per-element and belongs to whoever calibrated it, which is why it is a checkbox here
      // rather than a rule in the designer.
      //
      // NOT one of the *_arrangements_allowed lists, deliberately: those are per-zone (rim vs
      // board) and hand piping has no zone, so putting it there would pose the question "can you
      // hand-pipe this on the board?", which is not a real question.
      //
      // Absent means OFF. An element that has never been considered does not get the feature by
      // default — see the designer's gate.
      { key: 'hand_piping', label: 'Allow hand piping (draw it on freehand)' },
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
              <button
                onClick={() => setOverCapOnly(v => !v)}
                title="Show only elements over their phone-memory budget (§3)"
                style={{ marginTop: 8, width: '100%', padding: '7px 0', borderRadius: 8, cursor: 'pointer',
                  border: `1.5px solid ${overCapOnly ? '#E0B341' : '#C5D4C8'}`,
                  background: overCapOnly ? '#FFF6E5' : '#fff',
                  color: overCapOnly ? '#8a6d1a' : '#6B8C74', fontFamily: "'Quicksand',sans-serif", fontSize: 12, fontWeight: 700 }}>
                {overCapOnly ? '⚠ Showing over-budget only' : `⚠ Over budget (${overCapCount})`}
              </button>

              <div style={s.recencyRow}>
                {[[0, 'Any time'], [1, 'Today'], [7, '7 days'], [30, '30 days']].map(([days, label]) => (
                  <button key={days} onClick={() => setAddedWithin(days)}
                          style={{ ...s.recencyChip, ...(addedWithin === days ? s.recencyChipOn : {}) }}>
                    {label}
                  </button>
                ))}
              </div>

              {visibleIds.length > 0 && (
                <button onClick={toggleAllVisible} style={s.selectAllBtn}>
                  {allVisiblePicked ? `Deselect these ${visibleIds.length}` : `Select all ${visibleIds.length} shown`}
                </button>
              )}
            </div>
            {picked.size > 0 && (
              <div style={s.exportBar}>
                <span style={{ fontWeight: 700 }}>{picked.size} picked</span>
                <button onClick={handleExport} disabled={exporting} style={s.exportBtn}>
                  {exporting ? 'Exporting…' : 'Export'}
                </button>
                <button onClick={() => setPicked(new Set())} style={s.exportClear}>Clear</button>
              </div>
            )}
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
                      {/* stopPropagation: ticking a row picks it for export, it does not load it
                          into the editor. Two different intents on one row. */}
                      <input
                        type="checkbox"
                        checked={picked.has(el.id)}
                        onClick={e => e.stopPropagation()}
                        onChange={() => togglePicked(el.id)}
                        title="Pick for export"
                        style={{ width: 15, height: 15, flexShrink: 0, cursor: 'pointer', accentColor: '#2C4433' }} />
                      {el.thumbnail_url
                        ? <img src={el.thumbnail_url} alt="" style={s.elementThumb} />
                        : <div style={s.elementThumb} />
                      }
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={s.elementName}>{el.name}</div>
                        {!el.is_active && <span style={s.inactiveBadge}>Inactive</span>}
                        {(() => { const st = statsFromElement(el); return st ? (
                          <div style={{ marginTop: 3 }}>
                            <OverCapBadge stats={st} />
                            <GlbStatChips stats={st} style={{ marginTop: 3, fontSize: 10 }} />
                          </div>
                        ) : null; })()}
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
                    {/* Relief authoring is a 2D-image capability (the studio bakes displacement from the
                        image's alpha + luminance), so this is gated on the ASSET KIND — not on the element
                        type. The studio loads this element and pre-fills from its placement_config. */}
                    {/* ── Back to the studio that authored it ──────────────────────────────────
                        A generated element has NO asset, so the relief link below — gated on
                        image_url — never showed for one, and this screen offered no way into its
                        studio at all. Typing the URL by hand was the only route, which is not a
                        route.

                        Keyed off `placement_config.procedural`, the same value the designer's
                        PROCEDURAL_TOOLS registry reads to place one. A new generated element is an
                        entry here and nothing else — no branch on element type, and no separate
                        list of which things are generated. */}
                    {PROCEDURAL_STUDIOS[selectedEl.placement_config?.procedural] && (
                      <a
                        href={`${PROCEDURAL_STUDIOS[selectedEl.placement_config.procedural].href}?element=${selectedEl.id}`}
                        style={{ ...s.smallBtn, display: 'inline-block', marginTop: 8, marginBottom: 0, textDecoration: 'none' }}
                        title="Open this element in the studio that made it — tuning and thumbnail"
                      >
                        Open in {PROCEDURAL_STUDIOS[selectedEl.placement_config.procedural].label}
                      </a>
                    )}
                    {!isGlb && selectedEl.image_url && (
                      <a
                        href={`/elements/relief-sticker?element=${selectedEl.id}`}
                        style={{ ...s.smallBtn, display: 'inline-block', marginTop: 8, marginBottom: 0, textDecoration: 'none' }}
                        title="Tune this element's raised-fondant relief in the Relief Sticker Studio"
                      >
                        Open in Relief Sticker Studio
                      </a>
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

                {/* Category — what customers browse by. Independent of element type above, and
                    usually a different answer: a unicorn horn is a Cake Topper AND Unicorn &
                    Rainbow. The 86 existing elements were categorised by a name-matching backfill,
                    so this field is where a guess becomes an authored answer. */}
                <div style={s.field}>
                  <label style={s.label}>Category <span style={{ fontWeight: 400, color: '#9b8f94' }}>— how customers browse for it</span></label>
                  <select style={s.select} value={categoryId} onChange={e => setCategoryId(e.target.value)}>
                    <option value="">No category</option>
                    {categories.filter(c => c.is_active || c.id === categoryId)
                               .map(c => <option key={c.id} value={c.id}>{c.name}{c.is_active ? '' : ' (retired)'}</option>)}
                  </select>
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <input
                      style={{ ...s.input, flex: 1, fontSize: 12 }}
                      placeholder="…or type a new category"
                      value={newCategory}
                      onChange={e => setNewCategory(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCategory(); } }}
                    />
                    <button type="button" onClick={addCategory} disabled={!newCategory.trim() || addingCategory}
                      style={{ padding: '0 14px', borderRadius: 8, border: '1.5px solid #c9a8b5', background: '#fff',
                               color: '#9b5268', fontWeight: 700, fontSize: 12, cursor: newCategory.trim() ? 'pointer' : 'default',
                               opacity: newCategory.trim() ? 1 : 0.5, fontFamily: "'Quicksand',sans-serif" }}>
                      {addingCategory ? 'Adding…' : 'Add'}
                    </button>
                  </div>
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
                  {!isPipingPattern && !isGlb && (
                    <label style={{ ...s.checkRow, alignItems: 'flex-start', marginTop: 8 }}
                      title="Run remove.bg when generating the thumbnail from a replaced image. The asset itself is always uploaded untouched.">
                      <input type="checkbox" style={{ ...s.checkbox, marginTop: 1 }} checked={removeBgEnabled}
                        onChange={e => { const v = e.target.checked; setRemoveBgEnabled(v); if (newAssetFile) processRemoveBg(newAssetFile, v); }} />
                      <div>
                        <div style={s.checkLabel}>Remove background</div>
                        <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>
                          On by default; affects the auto-generated <b>thumbnail</b> only (the image asset is uploaded untouched here either way). <b>Uncheck for photo-frame overlays</b> and other already-transparent PNGs.
                        </div>
                      </div>
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
                      { key: 'delete',    label: 'Deletable',        hint: 'Always on — a customer can remove anything from their cake. Kept as a field so the rule stays visible and could be revisited, but it is not a choice.', fixed: true },
                      { key: 'move',      label: 'Movable',          hint: 'Nudge ◀▶▲▼ position on the cake' },
                      { key: 'tilt',      label: 'Tiltable',         hint: 'Lean / rotate slightly in the designer' },
                    /* `fixed`: ticked and not clickable — every element is deletable, and the
                       designer stopped honouring `delete: false`. See AddElement for the reasoning. */
                    ].map(({ key, label, hint, fixed }) => (
                      <label key={key} style={{ ...s.checkRow, alignItems: 'flex-start', cursor: fixed ? 'default' : 'pointer' }}>
                        <input type="checkbox" style={{ ...s.checkbox, marginTop: 1 }}
                          checked={fixed ? true : (capabilities[key] ?? false)}
                          disabled={fixed}
                          onChange={e => {
                            if (fixed) return;
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
                        <option value="hue_regions">Multi-colour — one swatch per colour (tree: trunk + leaves + flower)</option>
                      </select>
                      {recolorMethod === 'blue_gt_green' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>Edge protect</span>
                          <input type="number" min="0" max="50" step="1" style={{ ...s.input, flex: 1 }} value={recolorGuard}
                            placeholder="12 — raise if colour bleeds into the outline"
                            onChange={e => { const g = e.target.value; setRecolorGuard(g); patchPc({ recolor: recolorDesc('blue_gt_green', g) }); }} />
                        </div>
                      )}
                      {(recolorMethod === 'saturated' || recolorMethod === 'hue_regions') && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>Saturation min</span>
                          <input type="number" min="0" max="0.8" step="0.01" style={{ ...s.input, flex: 1 }} value={recolorSat}
                            placeholder="lower catches more, higher protects lines"
                            onChange={e => { const sv = e.target.value; setRecolorSat(sv); patchPc({ recolor: recolorDesc(recolorMethod, recolorGuard, sv) }); }} />
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 6, lineHeight: 1.5 }}>
                        Which pixels the colour picker recolours (brightness preserved). <b>Whole image</b> for a single-fill sticker; <b>Coloured fill</b> keeps gold/white outlines; <b>Multi-colour</b> gives the customer one swatch per detected colour (whites/blacks stay) — the fit for artwork like a tree or a dino.
                      </div>
                    </div>
                  )}
                </div>

                {/* ── Print finish — 2D image stickers only (these act on the printed decal, not a GLB). ──
                    LEAVE THESE BLANK unless you mean it. The designer renders a print at exactly 1× its
                    artwork by construction (spattoo-core shared/printExposure.js) — so a print that looks
                    wrong on the cake is now a bug to REPORT, not a slider to fight. These are deliberate
                    artistic overrides only. Blank writes no key at all. */}
                {selectedEl?.image_url && !isGlb && (
                  <div style={s.field}>
                    <label style={s.label}>Print finish <span style={{ fontWeight: 500, color: '#6B8C74' }}>— optional; blank = looks like the artwork</span></label>
                    {[
                      { k: 'gain', label: 'Exposure', v: printGain, min: 0.2, max: 1.5, step: 0.01,
                        ph: '1.0 = exactly the artwork. Below 1 dims the print, above 1 brightens it.',
                        set: setPrintGain, desc: (x) => printFinishDesc(printSat, printShading, x) },
                      { k: 'saturation', label: 'Saturation', v: printSat, min: 0.5, max: 1.6, step: 0.01,
                        ph: "1.0 = the artwork's own colour. Above 1 punches the chroma up.",
                        set: setPrintSat, desc: (x) => printFinishDesc(x, printShading, printGain) },
                      { k: 'shading', label: 'Takes shading', v: printShading, min: 0, max: 1, step: 0.05,
                        ph: '0.35 — how much of the cake\'s light/shadow falls on the print. 0 = flat, immune to light.',
                        set: setPrintShading, desc: (x) => printFinishDesc(printSat, x, printGain) },
                    ].map(f => (
                      <div key={f.k} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>{f.label}</span>
                        <input type="number" min={f.min} max={f.max} step={f.step} style={{ ...s.input, flex: 1 }}
                          value={f.v} placeholder={f.ph}
                          onChange={e => { const x = e.target.value; f.set(x); patchPc({ print_finish: f.desc(x) }); }} />
                      </div>
                    ))}
                    <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 6, lineHeight: 1.5 }}>
                      <b>Leave these blank.</b> A print now renders as its artwork — same brightness on the wall,
                      on a topper, on any cake — so you should not need to calibrate elements one by one.
                      Use them only to make a deliberate choice (a deliberately muted or punchier print).
                      If an element looks wrong with these blank, that&apos;s a renderer bug worth reporting, not a
                      slider to fight.
                    </div>
                  </div>
                )}

                {/* ── Made of ──
                    MATERIAL only. How it is worked is already the element TYPE — 'Cream Piping'
                    and 'Palette knife art' are the same material, and that is exactly why this
                    column does not carry technique.

                    It decides WHAT X-RAY OFFERS, which is why it is worth setting even though it
                    is optional: fondant gets both a modelling guide and printing at actual size
                    (bakers substitute one for the other constantly — time, budget, a cake that has
                    to travel); a printed sheet gets only printing, because there is no hand-made
                    version of one; acrylic gets neither, being bought rather than made.

                    Blank is safe: X-Ray offers both and the model self-reports when something is
                    not hand-made, which costs at most one generation. */}
                {!isPipingConfig && (
                  <div style={s.field}>
                    <label style={s.label}>Made of</label>
                    <select value={medium} onChange={e => setMedium(e.target.value)}
                      style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1.5px solid #C5D4C8', background: '#fff', fontSize: 13, fontFamily: "'Quicksand', sans-serif", color: '#2F4A38' }}>
                      <option value="">Not stated — X-Ray offers both</option>
                      <option value="fondant">Fondant / gumpaste — guide + print</option>
                      <option value="chocolate">Modelling chocolate — print only for now</option>
                      <option value="edible_paper">Edible paper (printed sheet) — print only</option>
                      <option value="acrylic">Acrylic / non-edible — neither</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                )}

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
                      {/* Seat depth (side/middle_tier hug) supersedes the old global "Stands out from
                          the side wall" checkbox — see PlacementZoneRow. */}
                      {applicableZones.map(zone => {
                        const mode = placementZoneConfig[zone] ?? 'hug';
                        return (
                          <PlacementZoneRow
                            key={zone}
                            zone={zone}
                            zoneLabel={CAKE_ZONES.find(z => z.value === zone)?.label ?? zone}
                            mode={mode}
                            seat={seatConfig[zone]}
                            insert={insertConfig[zone] ?? null}
                            alt={altConfig[zone] ?? null}
                            fullRing={fullRingConfig[zone] ?? false}
                            modes={PLACEMENT_MODES}
                            selectStyle={s.select}
                            inputStyle={s.input}
                            onModeChange={v => commitZone(zone, v, seatConfig[zone], insertConfig[zone], altConfig[zone])}
                            onSeatChange={v => commitZone(zone, mode, v, insertConfig[zone], altConfig[zone])}
                            onInsertToggle={on => commitZone(zone, mode, seatConfig[zone], on ? (insertConfig[zone] ?? {}) : null, altConfig[zone])}
                            onAltToggle={v => commitZone(zone, mode, seatConfig[zone], insertConfig[zone], v)}
                            onInsertField={(field, val) => setZoneInsertField(zone, mode, field, val)}
                            onFullRingToggle={on => setZoneFullRing(zone, on)} />
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
                      <label style={{ ...s.checkRow, alignItems: 'flex-start', marginTop: 6, opacity: canCluster ? 0.45 : 1 }}>
                        <input type="checkbox" style={{ ...s.checkbox, marginTop: 1 }}
                          checked={singlePerSlot} disabled={canCluster}
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
                      <label style={{ ...s.checkRow, alignItems: 'flex-start', marginTop: 6, opacity: canCluster ? 0.45 : 1 }}>
                        <input type="checkbox" style={{ ...s.checkbox, marginTop: 1 }}
                          checked={canScatter} disabled={canCluster}
                          onChange={e => {
                            const on = e.target.checked;
                            setCanScatter(on);
                            // Scatter and single-per-slot are mutually exclusive.
                            if (on) { setSinglePerSlot(false); patchPc({ scatter: true, single_per_slot: null }); }
                            else { setScatterCount(''); patchPc({ scatter: null, scatter_count: null }); }
                          }} />
                        <div>
                          <div style={s.checkLabel}>Can scatter (density)</div>
                          <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>
                            Many packed instances controlled by a density slider in the designer (sprinkles, pearls). For discrete decor, leave off and let users duplicate by hand.
                          </div>
                        </div>
                      </label>
                      {canScatter && (
                        <div style={{ marginTop: 6, marginLeft: 26 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', marginBottom: 3 }}>Default scatter count</div>
                          <input type="number" min="1" step="1" style={{ ...s.input, width: 120 }}
                            value={scatterCount} placeholder="e.g. 12"
                            onChange={e => { const v = e.target.value; setScatterCount(v); patchPc({ scatter_count: v === '' ? '' : parseInt(v, 10) }); }} />
                          <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 2 }}>
                            How many instances a scatter seeds with per surface (top and side). Blank = 12. Capped to what fits the cake; the customer adjusts with the density slider.
                          </div>
                        </div>
                      )}
                      <label style={{ ...s.checkRow, alignItems: 'flex-start', marginTop: 6, opacity: (canScatter || singlePerSlot) ? 0.45 : 1 }}
                        title="A packed clump of mixed-size balls. Drops as a single ball the customer grows into a cluster; mixed colours from a palette.">
                        <input type="checkbox" style={{ ...s.checkbox, marginTop: 1 }}
                          checked={canCluster} disabled={canScatter || singlePerSlot}
                          onChange={e => {
                            const on = e.target.checked;
                            setCanCluster(on);
                            // Cluster is exclusive with scatter + single-per-slot.
                            if (on) { setCanScatter(false); setSinglePerSlot(false); patchPc({ scatter: null, single_per_slot: null }); patchCluster(); }
                            else patchPc({ cluster: null });
                          }} />
                        <div>
                          <div style={s.checkLabel}>Can cluster (packed balls)</div>
                          <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>
                            Drops as a single ball the customer can grow into a packed, mixed-size clump (faux pearls/balls) that clings top→rim→side. Multiple clusters per cake.
                          </div>
                        </div>
                      </label>
                      {canCluster && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6, padding: '8px 10px', background: '#F7FAF8', borderRadius: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 110 }}>Ball count</span>
                            <input type="number" min="1" step="1" style={{ ...s.input, flex: 1 }} value={clusterMin} placeholder="min (blank = 3)" onChange={e => { setClusterMin(e.target.value); patchCluster({ min: e.target.value }); }} />
                            <input type="number" min="1" step="1" style={{ ...s.input, flex: 1 }} value={clusterMax} placeholder="max (blank = 30)" onChange={e => { setClusterMax(e.target.value); patchCluster({ max: e.target.value }); }} />
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 110 }}>Size tiers</span>
                            <input type="text" style={{ ...s.input, flex: 1 }} value={clusterSizes} placeholder="largest, 2nd, 3rd, small — e.g. 1.6, 1.35, 0.85, 0.5" onChange={e => { setClusterSizes(e.target.value); patchCluster({ sizes: e.target.value }); }} />
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 110 }}>Default colours</span>
                            <input type="text" style={{ ...s.input, flex: 1 }} value={clusterPalette} placeholder="comma hex — e.g. #D4AF37, #E8C66B (blank = element colour / gold)" onChange={e => { setClusterPalette(e.target.value); patchCluster({ palette: e.target.value }); }} />
                          </div>
                          <div style={{ fontSize: 11, color: '#6B8C74' }}>
                            Size tiers are relative multipliers (1 = the GLB's natural size), biggest → smallest. The customer controls size and can recolour the mix; these are the defaults.
                          </div>
                        </div>
                      )}
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
                      {/* Insert is now a per-zone MODIFIER — its depth/lean/jitter live in each zone's
                          row above (PlacementZoneRow, gated by zoneShowsInsert). No global block. */}
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

                {/* ── Preview ─────────────────────────────────────────────────────────────────
                    Directly under the placement editor because that is what it verifies. It is also
                    the only way to see a decoration on a cake without signing in as a baker, which
                    an admin cannot do. Renders the SAVED row — see ElementPreviewPanel. */}
                {selectedId && !cloneMode && (
                  <ElementPreviewPanel elementId={selectedId} savedAt={savedAt} />
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

                {/* The other half of the same rail: how a decoration is MADE, for the flat
                    placeables. Piping is excluded because its answer is the nozzle guide above —
                    the two are never both right for one element. */}
                {!isPipingConfig && !cloneMode && (
                  <DecorationGuidePanel key={selectedEl.id} elementId={selectedEl.id} />
                )}

                {cloneMode ? (
                  <>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#3D5A44', background: '#F4F8F5', border: '1px solid #C5D4C8', borderRadius: 8, padding: '8px 10px', marginBottom: 8, lineHeight: 1.45 }}>
                      Creating a NEW element from these settings. Add the new image/GLB (and a thumbnail) below, then Create clone.
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        style={{ ...s.btn('primary'), flex: 1, opacity: saving ? 0.6 : 1 }}
                        onClick={handleClone}
                        disabled={saving}
                        title="Create a new element from these settings + the new asset"
                      >
                        {saving ? 'Creating…' : 'Create clone'}
                      </button>
                      <button
                        style={{ ...s.btn('secondary'), flex: 1, opacity: saving ? 0.6 : 1 }}
                        onClick={cancelClone}
                        disabled={saving}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <>
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
                    <button
                      style={{ ...s.btn('secondary'), marginTop: 8, opacity: saving ? 0.6 : 1 }}
                      onClick={startClone}
                      disabled={saving}
                      title="Create a NEW element from these settings — you only add a new image/GLB"
                    >
                      Clone to new element
                    </button>
                  </>
                )}

                {msg && <div style={s.msg(msg.ok)}>{msg.text}</div>}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
