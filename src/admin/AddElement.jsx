import { useState, useEffect, useRef, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, useGLTF, Environment } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { fetchElementTypes, fetchParentElements, getSignedUploadUrl, uploadToR2, createGlobalElement, removeBg, suggestElementMeta, suggestCraftGuide, saveCraftGuide } from '../lib/api.js';
import CraftGuideFields, { RANKS } from './CraftGuideFields.jsx';

const ASSET_TYPES = [
  { value: '2D',      label: '2D Image',       folder: 'elements/files/2D' },
  { value: '3D',      label: '3D Model (GLB)', folder: 'elements/files/3D' },
  { value: '3D_GEOM', label: '3D Geometry',    folder: null },
];

const CAKE_ZONES = [
  { value: 'top_surface',  label: 'Top Surface' },
  { value: 'side',         label: 'Side' },
  { value: 'middle_tier',  label: 'Middle Tier' },
  { value: 'rim',          label: 'Rim' },
  { value: 'board',        label: 'Board' },
];

const PLACEMENT_MODES = [
  { value: 'hug',             label: 'hug (default)' },   // explicit — saved as "hug", not omitted
  { value: 'stand',           label: 'stand' },
  { value: 'perch',           label: 'perch (sit on edge)' },  // figure seated on the rim, legs over
  { value: 'faux_ball_single',label: 'faux ball single' },
];

const s = {
  page: {
    minHeight: '100vh', background: '#EDEAE2',
    fontFamily: "'Quicksand', sans-serif", padding: '40px 0',
    display: 'flex', justifyContent: 'center',
  },
  card: {
    background: '#fff', borderRadius: 16,
    border: '1.5px solid #C5D4C8',
    padding: 32, width: '100%', maxWidth: 520,
    alignSelf: 'flex-start',
  },
  title:  { fontSize: 20, fontWeight: 800, color: '#2C4433', marginBottom: 28 },
  field:  { marginBottom: 20 },
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
  checkRow:  { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' },
  checkbox:  { width: 18, height: 18, accentColor: '#3D5A44', cursor: 'pointer' },
  checkLabel:{ fontSize: 13, fontWeight: 700, color: '#2C4433' },
  radioRow:  { display: 'flex', gap: 12 },
  radioBtn: (active) => ({
    flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer',
    border: `1.5px solid ${active ? '#3D5A44' : '#C5D4C8'}`,
    background: active ? '#E8EDE9' : '#fff',
    color: active ? '#2C4433' : '#6B8C74',
    fontSize: 13, fontWeight: 700, fontFamily: "'Quicksand', sans-serif",
  }),
  fileBox: {
    width: '100%', padding: '28px 16px', border: '1.5px dashed #C5D4C8', borderRadius: 10,
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    background: '#f7f9f7', cursor: 'pointer', boxSizing: 'border-box',
  },
  fileName:   { fontSize: 12, color: '#3D5A44', marginTop: 6, fontWeight: 600 },
  previewBox: {
    width: '100%', height: 380, borderRadius: 10, overflow: 'hidden',
    border: '1.5px solid #C5D4C8', marginBottom: 8, background: '#f7f9f7',
  },
  thumbPreview: {
    width: '100%', height: 120, borderRadius: 10, overflow: 'hidden',
    border: '1.5px solid #C5D4C8', marginBottom: 8,
    // Checkerboard so transparency shows clearly
    background: 'repeating-conic-gradient(#d0d8d2 0% 25%, #f7f9f7 0% 50%) 0 0 / 16px 16px',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  spinner: {
    width: 22, height: 22, borderRadius: '50%',
    border: '3px solid #C5D4C8', borderTopColor: '#3D5A44',
    animation: 'spin 0.7s linear infinite',
  },
  btn: (variant = 'primary') => ({
    width: '100%', padding: '11px 0', borderRadius: 10,
    cursor: 'pointer', border: 'none', fontSize: 14, fontWeight: 700,
    fontFamily: "'Quicksand', sans-serif",
    background: variant === 'primary' ? '#3D5A44' : '#E8EDE9',
    color: variant === 'primary' ? '#fff' : '#3D5A44',
  }),
  smallBtn: {
    padding: '7px 14px', borderRadius: 8, cursor: 'pointer', border: 'none',
    fontSize: 12, fontWeight: 700, fontFamily: "'Quicksand', sans-serif",
    background: '#E8EDE9', color: '#3D5A44', marginBottom: 12,
  },
  msg: (ok) => ({
    fontSize: 13, fontWeight: 600, textAlign: 'center',
    color: ok ? '#3D5A44' : '#c00', marginTop: 12,
  }),
};

function FileDropZone({ label, accept, file, onChange }) {
  return (
    <div style={s.field}>
      <label style={s.label}>{label}</label>
      <label style={s.fileBox}>
        <input type="file" accept={accept} style={{ display: 'none' }} onChange={e => onChange(e.target.files[0])} />
        <span style={{ fontSize: 12, color: '#6B8C74' }}>Click to choose file</span>
        {file && <span style={s.fileName}>{file.name}</span>}
      </label>
    </div>
  );
}

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

function GLBModel({ url, color, roughness, metalness, onLoad, onTextureDetected, onMaterialRead }) {
  const { scene }  = useGLTF(url);
  const { camera, controls } = useThree();

  useEffect(() => {
    if (!scene) return;
    let hasAnyTexture = false;
    let firstMat = null;
    scene.traverse(obj => {
      if (!obj.isMesh) return;
      const mat = obj.material;
      if (!firstMat) firstMat = mat;
      if (mat && (mat.map || mat.normalMap || mat.roughnessMap)) {
        hasAnyTexture = true;
      }
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
    const dist   = maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360)) * 1.25;

    camera.position.set(center.x, center.y, center.z + dist);
    camera.near = dist / 100;
    camera.far  = dist * 100;
    camera.lookAt(center);
    camera.updateProjectionMatrix();

    if (controls) {
      controls.target.copy(center);
      controls.update();
    }

    const t = setTimeout(onLoad, 800);
    return () => clearTimeout(t);
  }, [scene]);

  return <primitive object={scene} />;
}

// Captures camera + controls ref from inside Canvas
function CameraCapture({ camRef }) {
  const { camera, controls } = useThree();
  useEffect(() => { camRef.current = { camera, controls }; }, [camera, controls]);
  return null;
}

function GLBPreview({ file, color, roughness, metalness, envPreset, camRef, canvasRef, onCapture, onTextureDetected, onMaterialRead }) {
  const [objectUrl, setObjectUrl] = useState(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <div style={s.previewBox} ref={canvasRef}>
      <Canvas flat gl={{ preserveDrawingBuffer: true }} camera={{ position: [0, 1, 3], fov: 45 }}>
        <ambientLight intensity={envPreset === 'none' ? 1 : 0.3} />
        <directionalLight position={[2, 2, 2]} intensity={envPreset === 'none' ? 0.6 : 0.2} />
        <directionalLight position={[-2, 1, -2]} intensity={envPreset === 'none' ? 0.4 : 0.1} />
        <Suspense fallback={null}>
          {objectUrl && <GLBModel url={objectUrl} color={color} roughness={roughness} metalness={metalness} onLoad={onCapture} onTextureDetected={onTextureDetected} onMaterialRead={onMaterialRead} />}
          {envPreset !== 'none' && <Environment preset={envPreset} />}
        </Suspense>
        <OrbitControls makeDefault enablePan />
        <CameraCapture camRef={camRef} />
      </Canvas>
    </div>
  );
}

// Compute model rotation from camera's spherical position relative to target.
// Camera at phi azimuth and theta elevation → model needs to rotate so that
// the face pointing toward the camera now faces +Z (outward on the cake).
function cameraToModelRotation({ camera, controls }) {
  const target = controls?.target ?? new THREE.Vector3(0, 0, 0);
  const rel    = camera.position.clone().sub(target);
  const phi    = Math.atan2(rel.x, rel.z);                              // azimuth
  const theta  = Math.atan2(rel.y, Math.sqrt(rel.x ** 2 + rel.z ** 2)); // elevation
  const toDeg  = r => ((r * 180 / Math.PI) % 360 + 360) % 360;
  return [toDeg(-theta), toDeg(-phi), 0];
}

export default function AddElement() {
  const [elementTypes, setElementTypes]   = useState([]);
  const [parentOptions, setParentOptions] = useState([]);
  const [name, setName]                   = useState('');
  const [description, setDescription]     = useState('');
  const [suggesting,    setSuggesting]     = useState(false);
  const [suggestions,   setSuggestions]   = useState(null);
  const [suggestError,  setSuggestError]  = useState(null);
  const [elementTypeId, setElementTypeId] = useState('');
  const [applicableZones, setApplicableZones] = useState([]);
  const [isParent, setIsParent]           = useState(false);
  const [parentId, setParentId]           = useState('');
  const [assetType, setAssetType]         = useState('2D');
  const [elementColor, setElementColor]   = useState('#F0DEB8');
  const [userPickedColor, setUserPickedColor] = useState(false);
  const [glbRoughness, setGlbRoughness]   = useState(0.6);
  const [glbMetalness, setGlbMetalness]   = useState(0);
  const [glbEnvPreset, setGlbEnvPreset]   = useState('none');
  const [glbHasTexture, setGlbHasTexture] = useState(null);
  const [assetFile, setAssetFile]         = useState(null);
  const [thumbnailBlob, setThumbnailBlob] = useState(null);
  const [placementConfig, setPlacementConfig] = useState({});
  const [placementScale, setPlacementScale]   = useState('');
  const [placementScaleMin, setPlacementScaleMin] = useState('');   // placement_config.scale.min
  const [placementScaleMax, setPlacementScaleMax] = useState('');   // placement_config.scale.max
  const [placementScaleStep, setPlacementScaleStep] = useState(''); // placement_config.scale.step
  const [singlePerSlot,  setSinglePerSlot]    = useState(false);
  const [canScatter,     setCanScatter]       = useState(false);
  const [sideProud,      setSideProud]        = useState(false);
  const [hugFill,        setHugFill]          = useState('');
  // Folded sticker (2D only): a flat decal splits at the body spine into two hinged wings.
  const [foldable,   setFoldable]   = useState(false);
  const [foldAngle,  setFoldAngle]  = useState('');   // placement_config.fold (deg, blank = default 30)
  const [spineSplit, setSpineSplit] = useState('');   // placement_config.spine (0–1, blank = default 0.5)
  // Pixel-recolour region for a colour-changeable 2D image (companion to allowed_actions.color).
  const [recolorMethod, setRecolorMethod] = useState('opaque');   // 'opaque' | 'saturated' | 'blue_gt_green'
  const [recolorGuard,  setRecolorGuard]  = useState('12');       // blue_gt_green margin
  const [recolorSat,    setRecolorSat]    = useState('0.25');     // saturated threshold
  const [capabilities, setCapabilities]       = useState({ resize: true, duplicate: true, color: false, gradient: false, delete: true, move: false, tilt: false });
  const [glbRotation, setGlbRotation]         = useState([0, 0, 0]);
  const [frontConfirmed, setFrontConfirmed]   = useState(false);
  const [pipingBottomFlip, setPipingBottomFlip] = useState(true);

  // Craft guide (X-Ray) — required for cream_piping elements. Saved to the
  // element_craft_guide sidecar AFTER the element row is created.
  const [craftRecs,         setCraftRecs]         = useState([]);
  const [craftConsistency,  setCraftConsistency]  = useState('');
  const [craftTechnique,    setCraftTechnique]    = useState('');
  const [craftSuggesting,   setCraftSuggesting]   = useState(false);
  const [craftSuggestError, setCraftSuggestError] = useState(null);
  const camRef = useRef(null);
  const [saving, setSaving]               = useState(false);
  const [removingBg, setRemovingBg]       = useState(false);
  const [msg, setMsg]                     = useState(null);
  const canvasRef                         = useRef();

  useEffect(() => {
    fetchElementTypes()
      .then(setElementTypes)
      .catch(err => setMsg({ ok: false, text: err.message }));
  }, []);

  useEffect(() => {
    if (!elementTypeId || isParent) { setParentOptions([]); setParentId(''); return; }
    fetchParentElements(elementTypeId)
      .then(setParentOptions)
      .catch(() => setParentOptions([]));
  }, [elementTypeId, isParent]);

  // For 2D, auto remove-bg from the asset file when selected
  useEffect(() => {
    if (assetType !== '2D' || !assetFile) { if (assetType === '2D') setThumbnailBlob(null); return; }
    processRemoveBg(assetFile);
  }, [assetFile, assetType]);

  function toggleZone(zone) {
    setApplicableZones(prev =>
      prev.includes(zone) ? prev.filter(z => z !== zone) : [...prev, zone]
    );
  }

  function handleIsParentToggle() {
    setIsParent(p => !p);
    setParentId('');
  }

  // Normalize a transparent PNG so the content fills ~80% of a 512×512 square.
  // Works by finding the non-transparent bounding box, then centering it with 10% padding.
  function normalizeThumbnail(blob) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const src = document.createElement('canvas');
        src.width  = img.width;
        src.height = img.height;
        const sCtx = src.getContext('2d');
        sCtx.drawImage(img, 0, 0);

        // Find non-transparent bounding box
        const { data } = sCtx.getImageData(0, 0, src.width, src.height);
        let minX = src.width, minY = src.height, maxX = 0, maxY = 0;
        for (let y = 0; y < src.height; y++) {
          for (let x = 0; x < src.width; x++) {
            if (data[(y * src.width + x) * 4 + 3] > 10) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }

        const OUT  = 512;
        const FILL = 0.8; // content occupies 80% of the output square
        const out  = document.createElement('canvas');
        out.width  = OUT;
        out.height = OUT;
        const oCtx = out.getContext('2d');

        if (maxX >= minX && maxY >= minY) {
          const cw    = maxX - minX + 1;
          const ch    = maxY - minY + 1;
          const scale = (OUT * FILL) / Math.max(cw, ch);
          const dw    = cw * scale;
          const dh    = ch * scale;
          const dx    = (OUT - dw) / 2;
          const dy    = (OUT - dh) / 2;
          oCtx.drawImage(src, minX, minY, cw, ch, dx, dy, dw, dh);
        } else {
          // Fully transparent fallback — just scale to fit
          const scale = (OUT * FILL) / Math.max(src.width, src.height);
          const dw    = src.width  * scale;
          const dh    = src.height * scale;
          oCtx.drawImage(src, (OUT - dw) / 2, (OUT - dh) / 2, dw, dh);
        }

        out.toBlob(resolve, 'image/png');
        URL.revokeObjectURL(img.src);
      };
      img.src = URL.createObjectURL(blob);
    });
  }

  async function processRemoveBg(blob) {
    setRemovingBg(true);
    setThumbnailBlob(null);
    try {
      const processed   = await removeBg(blob);
      const normalized  = await normalizeThumbnail(processed);
      setThumbnailBlob(normalized);
    } catch {
      // Fall back to original if remove.bg fails; still normalize
      const normalized = await normalizeThumbnail(blob);
      setThumbnailBlob(normalized);
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
      setGlbRotation(cameraToModelRotation(camRef.current));
    }
    setFrontConfirmed(true);
    captureThumbnail();
  }

  async function handleSuggest() {
    if (!thumbnailBlob) return;
    setSuggesting(true);
    setSuggestions(null);
    setSuggestError(null);
    try {
      const elementTypeName = elementTypes.find(t => t.id === elementTypeId)?.name ?? '';
      const result = await suggestElementMeta(thumbnailBlob, elementTypeName);
      setSuggestions(result);
    } catch (e) {
      console.error('Suggest failed:', e);
      setSuggestError(e.message || 'Unknown error');
    } finally {
      setSuggesting(false);
    }
  }

  // GPT-suggest the craft guide from the staged thumbnail (pre-creation, so we
  // send the image as base64 rather than a URL).
  async function handleCraftSuggest() {
    if (!thumbnailBlob) return;
    setCraftSuggesting(true);
    setCraftSuggestError(null);
    try {
      const ab = await thumbnailBlob.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const imageBase64 = btoa(binary);
      const r = await suggestCraftGuide({ imageBase64, mimeType: thumbnailBlob.type || 'image/png', name, description });
      setCraftRecs(r.nozzle_recs ?? []);
      if (r.consistency) setCraftConsistency(r.consistency);
      if (r.technique) setCraftTechnique(r.technique);
      if (!r.nozzle_recs?.length) setCraftSuggestError('GPT found no confident nozzle match — add manually.');
    } catch (e) {
      setCraftSuggestError(e.message || 'Unknown error');
    } finally {
      setCraftSuggesting(false);
    }
  }

  async function handleSave() {
    const needsFile = assetType !== '3D_GEOM' && !isPatternType;
    if (!name.trim() || !elementTypeId || (needsFile && !assetFile)) {
      setMsg({ ok: false, text: 'Name, element type and asset file are required.' });
      return;
    }
    // The front view exists to (a) orient the model and (b) auto-capture a thumbnail from it.
    // If a thumbnail has already been provided (uploaded or captured), it's no longer required.
    if (assetType === '3D' && !isPatternType && !frontConfirmed && !thumbnailBlob) {
      setMsg({ ok: false, text: 'Set the front view before saving — drag the model and click "This is the front", or upload a thumbnail.' });
      return;
    }
    if (applicableZones.length === 0) {
      setMsg({ ok: false, text: 'Select at least one applicable zone.' });
      return;
    }
    if (!isParent && !parentId) {
      setMsg({ ok: false, text: 'Select a parent element or check "Is Parent".' });
      return;
    }
    if (!thumbnailBlob) {
      setMsg({ ok: false, text: 'A thumbnail is required — upload or capture one below.' });
      return;
    }

    // Craft guide is mandatory for cream_piping elements — at least one nozzle.
    const cleanCraftRecs = craftRecs
      .map(r => ({
        nozzle_id:  r.nozzle_id ?? null,
        brand:      (r.brand ?? '').trim(),
        number:     String(r.number ?? '').trim(),
        name:       (r.name ?? '').trim(),
        rank:       RANKS.includes(r.rank) ? r.rank : 'primary',
        confidence: r.confidence ?? null,
      }))
      .filter(r => r.brand && r.number);
    if (isPipingType && cleanCraftRecs.length === 0) {
      setMsg({ ok: false, text: 'Add at least one piping nozzle (or use Fill with GPT) — required for cream piping elements.' });
      return;
    }

    setSaving(true);
    setMsg(null);

    try {
      // Asset file upload — skipped for 3D Geometry (procedural, no file)
      // For 2D, upload the background-removed blob so the canvas renders without a background.
      let assetKey = null;
      let assetSize = null;
      if (needsFile) {
        const folder = ASSET_TYPES.find(a => a.value === assetType).folder;
        const fileToUpload = assetType === '2D' && thumbnailBlob ? thumbnailBlob : assetFile;
        const ext = assetType === '2D' ? 'png' : assetFile.name.split('.').pop();
        const assetFilename = `${crypto.randomUUID()}.${ext}`;
        const assetContentType = assetType === '2D' ? 'image/png' : (assetFile.type || 'model/gltf-binary');
        const { url: assetUrl, key } = await getSignedUploadUrl(folder, assetFilename, assetContentType);
        await uploadToR2(assetUrl, fileToUpload);
        assetKey = key;
        // Record the byte size of what we actually uploaded (bg-removed PNG for 2D).
        assetSize = fileToUpload.size ?? null;
      }

      // Thumbnail is always PNG (remove.bg output or manual upload)
      const thumbFilename = `${crypto.randomUUID()}.png`;
      const { url: thumbUrl, key: thumbKey } = await getSignedUploadUrl('elements/thumbnails', thumbFilename, 'image/png');
      await uploadToR2(thumbUrl, thumbnailBlob);

      let builtPlacementConfig = {};
      if (assetType === '3D_GEOM') {
        // A file-less procedural element (image_url null). The designer's ONLY file-less render
        // mode is `faux_balls` (a sculpted gold-ball cluster), so that's the mode for each zone the
        // admin actually selected — written per applicableZone so placement_config stays in sync
        // with allowed_zones (no blanket top+side hardcode that ignored the chosen zones). For
        // scattered shapes that aren't a clump, create a "3D Model (GLB)" element with scatter.
        builtPlacementConfig = { roughness: glbRoughness, metalness: glbMetalness };
        for (const zone of applicableZones) builtPlacementConfig[zone] = 'faux_balls';
      } else {
        // Write the chosen mode for EVERY applicable zone explicitly (default 'hug') — no more
        // "absent means hug"; the config states each zone's mode so the designer never guesses.
        for (const zone of applicableZones) {
          builtPlacementConfig[zone] = placementConfig[zone] || 'hug';
        }
        if (placementScale !== '') builtPlacementConfig.r = parseFloat(placementScale);
        // Optional size-dial bounds in the designer: { min, max } (each independent). r is the
        // default WITHIN this range. Omitted when both blank → designer keeps its built-in bounds.
        const scaleBounds = {};
        if (placementScaleMin !== '')  scaleBounds.min  = parseFloat(placementScaleMin);
        if (placementScaleMax !== '')  scaleBounds.max  = parseFloat(placementScaleMax);
        if (placementScaleStep !== '') scaleBounds.step = parseFloat(placementScaleStep);
        if (Object.keys(scaleBounds).length) builtPlacementConfig.scale = scaleBounds;
        // Placement STYLE: hero (one per tier×surface) vs. free scatter. Config-driven, never
        // inferred from element type — see spattoo-core INVARIANTS.md rule #4.
        if (effectiveCanScatter) builtPlacementConfig.scatter = true;        // sprinkles: density-driven, packed
        else if (singlePerSlot) builtPlacementConfig.single_per_slot = true;  // mutually exclusive with scatter
        // Side seating: default flush (true hug); proud = stands off the wall (deep toppers).
        if (sideProud) builtPlacementConfig.side_proud = true;
        // Hero side-hug size = this fraction of the tier wall height (designer derives it at
        // render time; r is the stand size only). Blank → designer default (0.7).
        if (hugFill !== '') builtPlacementConfig.hug_fill = parseFloat(hugFill);
        // Folded sticker (2D image only): split at the spine into two hinged wings. fold (deg) /
        // spine (0–1) are optional — the designer falls back to its defaults. See spattoo-core
        // placement.js / PLACEMENT_CONFIG.md.
        if (assetType === '2D' && foldable) {
          builtPlacementConfig.foldable = true;
          if (foldAngle  !== '') builtPlacementConfig.fold  = parseFloat(foldAngle);
          if (spineSplit !== '') builtPlacementConfig.spine = parseFloat(spineSplit);
        }
        // Pixel-recolour region (2D image only) — the companion to the generic "Color changeable"
        // capability: it tells the designer WHICH pixels the colour picker recolours. GLB recolour
        // tints the material instead (no descriptor needed). Never element-type aware.
        if (assetType === '2D' && capabilities.color) {
          builtPlacementConfig.recolor =
            recolorMethod === 'blue_gt_green' ? { method: 'blue_gt_green', guard: recolorGuard !== '' ? parseInt(recolorGuard, 10) : 12 }
            : recolorMethod === 'saturated'   ? { method: 'saturated', sat: recolorSat !== '' ? parseFloat(recolorSat) : 0.25 }
            : { method: 'opaque' };
        }
        // Facing offset is authored in DEGREES (cameraToModelRotation → toDeg). Tag the unit so
        // the designer reads it via facingOffsetRadians instead of mistaking degrees for radians
        // (the ~57× over-spin this used to cause). See spattoo-core placement.js / PLACEMENT_CONFIG.md.
        if (assetType === '3D' && glbRotation.some(v => v !== 0)) {
          builtPlacementConfig.rotation      = glbRotation.map(v => Math.round(v));
          builtPlacementConfig.rotation_unit = 'deg';
        }
        if (assetType === '3D' && isPipingType) {
          builtPlacementConfig.bottom_flip = pipingBottomFlip;
          // Flexible out of the box: both layouts allowed, default ring. Admins refine
          // allowed/default per zone in Manage Elements. See spattoo-core designer.
          builtPlacementConfig.top_arrangements_allowed    = ['ring', 'single'];
          builtPlacementConfig.bottom_arrangements_allowed = ['ring', 'single'];
          builtPlacementConfig.top_arrangement    = 'ring';
          builtPlacementConfig.bottom_arrangement = 'ring';
          // single_angle omitted → designer seeds the first piece at the cake front.
          builtPlacementConfig.top_single_max    = 12;
          builtPlacementConfig.bottom_single_max = 12;
          // Alternating pattern off by default; configured later in the Piping Calibrator.
          builtPlacementConfig.top_alt_enabled    = false;
          builtPlacementConfig.bottom_alt_enabled = false;
          builtPlacementConfig.top_pattern    = 'AB';
          builtPlacementConfig.bottom_pattern = 'AB';
        }
      }

      const created = await createGlobalElement({
        name:             name.trim(),
        description:      description.trim() || null,
        element_type_id:  elementTypeId,
        parent_id:        isParent ? null : parentId,
        image_url:        assetKey,
        thumbnail_url:    thumbKey,
        file_size:        assetSize,
        allowed_zones:    applicableZones,
        placement_config: builtPlacementConfig,
        allowed_actions:  capabilities,
        default_color:    assetType === '3D_GEOM'
          ? elementColor
          : (assetType === '3D' && userPickedColor ? elementColor : null),
        sort_order:       0,
      });

      // Step 2 — save the craft guide to the sidecar table now the element id exists.
      if (isPipingType && created?.id && cleanCraftRecs.length) {
        await saveCraftGuide(created.id, {
          nozzle_recs: cleanCraftRecs,
          consistency: craftConsistency || null,
          technique:   craftTechnique.trim() || null,
        });
      }

      setMsg({ ok: true, text: 'Element saved!' });
      setName('');
      setElementTypeId('');
      setApplicableZones([]);
      setIsParent(false);
      setParentId('');
      setAssetFile(null);
      setElementColor('#F0DEB8');
      setUserPickedColor(false);
      setGlbRoughness(0.6);
      setGlbMetalness(0);
      setGlbEnvPreset('none');
      setThumbnailBlob(null);
      setPlacementConfig({});
      setPlacementScale('');
      setPlacementScaleMin('');
      setPlacementScaleMax('');
      setPlacementScaleStep('');
      setSinglePerSlot(false);
      setCanScatter(false);
      setSideProud(false);
      setHugFill('');
      setFoldable(false);
      setFoldAngle('');
      setSpineSplit('');
      setRecolorMethod('opaque');
      setRecolorGuard('12');
      setRecolorSat('0.25');
      setCapabilities({ resize: true, duplicate: true, color: false, delete: true, move: false, tilt: false });
      setPipingBottomFlip(true);
      setCraftRecs([]);
      setCraftConsistency('');
      setCraftTechnique('');
      setCraftSuggestError(null);
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  }

  const isPipingType = elementTypes.find(t => t.id === elementTypeId)?.slug === 'cream_piping';
  // The "scattered decor" type IS inherently scatter — force the flag on (and lock it) when chosen.
  // This is an admin-side type→default coupling only; the designer still reads placement_config.scatter,
  // never the element type. Other types can opt in via the editable checkbox.
  const isScatterType = elementTypes.find(t => t.id === elementTypeId)?.slug === 'scattered_decor';
  const effectiveCanScatter = isScatterType || canScatter;
  // Pattern types have no asset of their own — they reference part elements via
  // placement_config.parts (decor_pattern: decor stickers; piping_pattern: cream blocks). So no
  // file upload is required; image_url stays null (same as 3D-geometry elements already do).
  const isPatternType = ['decor_pattern', 'piping_pattern'].includes(
    elementTypes.find(t => t.id === elementTypeId)?.slug);

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Quicksand:wght@400;600;700;800&display=swap" rel="stylesheet" />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={s.page}>
        <div style={s.card}>
          <div style={s.title}>Add Element</div>

          <div style={s.field}>
            <label style={s.label}>Asset Type</label>
            <div style={s.radioRow}>
              {ASSET_TYPES.map(a => (
                <button key={a.value} style={s.radioBtn(assetType === a.value)} onClick={() => { setAssetType(a.value); setAssetFile(null); setThumbnailBlob(null); setGlbHasTexture(null); setUserPickedColor(false); setGlbRoughness(0.6); setGlbMetalness(0); setGlbEnvPreset('none'); }}>
                  {a.label}
                </button>
              ))}
            </div>
          </div>

          {assetType !== '3D_GEOM' && (
            <FileDropZone
              label={assetType === '3D' ? 'GLB File' : 'Image File'}
              accept={assetType === '3D' ? '.glb,.gltf' : 'image/*'}
              file={assetFile}
              onChange={f => { setAssetFile(f); setGlbHasTexture(null); setUserPickedColor(false); setGlbRoughness(0.6); setGlbMetalness(0); setGlbEnvPreset('none'); setGlbRotation([0,0,0]); setFrontConfirmed(false); }}
            />
          )}

          {/* 3D Geometry preview + controls */}
          {assetType === '3D_GEOM' && (
            <>
              <div style={{ ...s.field, background: '#F2F7F3', border: '1px solid #C5D4C8', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 12, color: '#2C4433', fontWeight: 700, marginBottom: 3 }}>Places as a faux-ball cluster</div>
                <div style={{ fontSize: 11, color: '#6B8C74', lineHeight: 1.4 }}>
                  3D Geometry is file-less, so the designer renders it as a sculpted gold-ball cluster (mode <code>faux_balls</code>) on each selected zone — not free-scattered shapes. For scattered sprinkles/pearls, upload a small ball as a <strong>3D Model (GLB)</strong> and tick <strong>Can scatter</strong> instead.
                </div>
              </div>
              <div style={s.field}>
                <label style={s.label}>Default Color</label>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <input type="color" value={elementColor} onChange={e => setElementColor(e.target.value)}
                    style={{ width: 40, height: 32, border: '1.5px solid #C5D4C8', borderRadius: 6, cursor: 'pointer', padding: 2 }} />
                  <span style={{ fontSize: 12, color: '#6B8C74', fontWeight: 600 }}>{elementColor}</span>
                </div>
              </div>
              <div style={s.field}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <label style={{ ...s.label, marginBottom: 0, minWidth: 80 }}>Roughness</label>
                    <input type="range" min="0" max="1" step="0.01" value={glbRoughness} onChange={e => setGlbRoughness(parseFloat(e.target.value))} style={{ flex: 1, accentColor: '#3D5A44' }} />
                    <span style={{ fontSize: 12, color: '#6B8C74', fontWeight: 600, minWidth: 30 }}>{glbRoughness.toFixed(2)}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <label style={{ ...s.label, marginBottom: 0, minWidth: 80 }}>Metalness</label>
                    <input type="range" min="0" max="1" step="0.01" value={glbMetalness} onChange={e => setGlbMetalness(parseFloat(e.target.value))} style={{ flex: 1, accentColor: '#3D5A44' }} />
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
                <label style={s.label}>Preview</label>
                <GeomSpherePreview
                  color={elementColor}
                  roughness={glbRoughness}
                  metalness={glbMetalness}
                  envPreset={glbEnvPreset}
                  canvasRef={canvasRef}
                  onCapture={captureThumbnail}
                />
                <button style={s.smallBtn} onClick={captureThumbnail}>Re-capture Thumbnail</button>
              </div>
            </>
          )}

          {/* 3D preview + auto-capture */}
          {assetType === '3D' && assetFile && (
            <div style={s.field}>
              <label style={s.label}>3D Preview</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <label style={{ ...s.label, marginBottom: 0, minWidth: 80 }} htmlFor="elColor">Color</label>
                  <input
                    id="elColor"
                    type="color"
                    value={elementColor}
                    onChange={e => { setElementColor(e.target.value); setUserPickedColor(true); }}
                    style={{ width: 40, height: 32, border: '1.5px solid #C5D4C8', borderRadius: 6, cursor: 'pointer', padding: 2 }}
                  />
                  <span style={{ fontSize: 12, color: '#6B8C74', fontWeight: 600 }}>
                    {userPickedColor ? elementColor : 'from GLB'}
                  </span>
                  {userPickedColor && (
                    <button
                      onClick={() => setUserPickedColor(false)}
                      style={{ padding: '2px 8px', borderRadius: 6, border: '1.5px solid #C5D4C8', background: '#fff', color: '#6B8C74', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: "'Quicksand', sans-serif" }}
                    >
                      Reset
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <label style={{ ...s.label, marginBottom: 0, minWidth: 80 }}>Roughness</label>
                  <input
                    type="range" min="0" max="1" step="0.01"
                    value={glbRoughness}
                    onChange={e => setGlbRoughness(parseFloat(e.target.value))}
                    style={{ flex: 1, accentColor: '#3D5A44' }}
                  />
                  <span style={{ fontSize: 12, color: '#6B8C74', fontWeight: 600, minWidth: 30 }}>{glbRoughness.toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <label style={{ ...s.label, marginBottom: 0, minWidth: 80 }}>Metalness</label>
                  <input
                    type="range" min="0" max="1" step="0.01"
                    value={glbMetalness}
                    onChange={e => setGlbMetalness(parseFloat(e.target.value))}
                    style={{ flex: 1, accentColor: '#3D5A44' }}
                  />
                  <span style={{ fontSize: 12, color: '#6B8C74', fontWeight: 600, minWidth: 30 }}>{glbMetalness.toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <label style={{ ...s.label, marginBottom: 0, minWidth: 80 }}>Environment</label>
                  <select
                    value={glbEnvPreset}
                    onChange={e => setGlbEnvPreset(e.target.value)}
                    style={{ ...s.select, flex: 1 }}
                  >
                    {['none','studio','city','sunset','dawn','warehouse','forest','park','lobby'].map(p => (
                      <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                    ))}
                  </select>
                </div>
              </div>
              <GLBPreview
                file={assetFile}
                color={userPickedColor ? elementColor : undefined}
                roughness={glbRoughness}
                metalness={glbMetalness}
                envPreset={glbEnvPreset}
                camRef={camRef}
                canvasRef={canvasRef}
                onCapture={captureThumbnail}
                onTextureDetected={setGlbHasTexture}
                onMaterialRead={({ roughness, metalness, color }) => {
                  setGlbRoughness(roughness);
                  setGlbMetalness(metalness);
                  if (color) setElementColor(color);
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
                  {(() => {
                    // Front view is required only when no thumbnail exists yet (it captures one);
                    // with a thumbnail already provided it's optional (just sets orientation).
                    const accent = frontConfirmed ? '#3D5A44' : (thumbnailBlob ? '#6B8C74' : '#e05252');
                    const text   = frontConfirmed ? 'Front set' : (thumbnailBlob ? 'Set front view (optional)' : 'Set front view (required)');
                    return (
                      <button onClick={confirmFrontView}
                        style={{ fontSize: 11, padding: '5px 12px', borderRadius: 6, border: `2px solid ${accent}`, background: frontConfirmed ? '#3D5A44' : '#fff', color: frontConfirmed ? '#fff' : accent, cursor: 'pointer', fontWeight: 700, fontFamily: "'Quicksand',sans-serif" }}>
                        {text}
                      </button>
                    );
                  })()}
                </div>
                {isPipingType && (
                  <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #e2ebe3' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 11, color: '#3D5A44', fontWeight: 600, fontFamily: "'Quicksand',sans-serif" }}>Flip for bottom placement</span>
                      <button onClick={() => setPipingBottomFlip(f => !f)}
                        style={{ fontSize: 11, padding: '5px 12px', borderRadius: 6, border: `2px solid ${pipingBottomFlip ? '#3D5A44' : '#C5D4C8'}`, background: pipingBottomFlip ? '#3D5A44' : '#fff', color: pipingBottomFlip ? '#fff' : '#6B8C74', cursor: 'pointer', fontWeight: 700, fontFamily: "'Quicksand',sans-serif" }}>
                        {pipingBottomFlip ? 'Flip: On' : 'Flip: Off'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Thumbnail preview (both 2D and 3D) */}
          <div style={s.field}>
            <label style={s.label}>Thumbnail</label>
            {(removingBg || thumbnailBlob) && (
              <div style={s.thumbPreview}>
                {removingBg ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                    <div style={s.spinner} />
                    <span style={{ fontSize: 11, color: '#6B8C74', fontWeight: 600 }}>Removing background…</span>
                  </div>
                ) : (
                  <img
                    src={URL.createObjectURL(thumbnailBlob)}
                    style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                    alt="thumbnail"
                  />
                )}
              </div>
            )}
            <label style={{ ...s.fileBox, padding: '12px 16px', marginTop: 8 }}>
              <input
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={e => { if (e.target.files[0]) setThumbnailBlob(e.target.files[0]); }}
              />
              <span style={{ fontSize: 12, color: '#6B8C74' }}>
                {thumbnailBlob ? 'Replace thumbnail…' : 'Upload custom thumbnail…'}
              </span>
            </label>
          </div>

          {/* Name + AI suggest */}
          <div style={s.field}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <label style={{ ...s.label, marginBottom: 0 }}>Name</label>
              <button
                type="button"
                onClick={handleSuggest}
                disabled={!thumbnailBlob || suggesting}
                style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, border: '1px solid #c9a8b5', background: thumbnailBlob ? '#fff0f5' : '#f5f5f5', color: thumbnailBlob ? '#9b5268' : '#bbb', cursor: thumbnailBlob ? 'pointer' : 'not-allowed', fontWeight: 700, fontFamily: "'Quicksand',sans-serif" }}>
                {suggesting ? 'Thinking…' : 'Suggest'}
              </button>
            </div>
            <input style={s.input} value={name} onChange={e => { setName(e.target.value); setSuggestions(null); }} placeholder="e.g. Rainbow Topper" />
            {suggestError && (
              <div style={{ fontSize: 11, color: '#c0392b', fontWeight: 600, marginTop: 6, padding: '6px 10px', background: '#fdf0ee', borderRadius: 6 }}>
                {suggestError}
              </div>
            )}
            {suggestions?.names && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {suggestions.names.map(n => (
                  <button key={n} type="button" onClick={() => setName(n)}
                    style={{ fontSize: 11, padding: '3px 10px', borderRadius: 20, border: '1.5px solid #c9a8b5', background: name === n ? '#9b5268' : '#fff', color: name === n ? '#fff' : '#9b5268', cursor: 'pointer', fontWeight: 700, fontFamily: "'Quicksand',sans-serif" }}>
                    {n}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div style={s.field}>
            <label style={s.label}>Description <span style={{ fontWeight: 400, color: '#999' }}>(used for search)</span></label>
            <input style={s.input} value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. shiny gold star for top of cake" />
            {suggestions?.description && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button type="button" onClick={() => setDescription(suggestions.description)}
                  style={{ fontSize: 11, padding: '3px 10px', borderRadius: 20, border: '1.5px solid #c9a8b5', background: description === suggestions.description ? '#9b5268' : '#fff', color: description === suggestions.description ? '#fff' : '#9b5268', cursor: 'pointer', fontWeight: 700, fontFamily: "'Quicksand',sans-serif", textAlign: 'left' }}>
                  {suggestions.description}
                </button>
              </div>
            )}
          </div>

          <div style={s.field}>
            <label style={s.label}>Element Type</label>
            <select style={s.select} value={elementTypeId} onChange={e => { setElementTypeId(e.target.value); setParentId(''); }}>
              <option value="">Select type…</option>
              {elementTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>

          <div style={s.field}>
            <label style={s.label}>Applicable Zones</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 20px', marginTop: 4 }}>
              {CAKE_ZONES.map(z => (
                <label key={z.value} style={s.checkRow}>
                  <input type="checkbox" style={s.checkbox} checked={applicableZones.includes(z.value)} onChange={() => toggleZone(z.value)} />
                  <span style={s.checkLabel}>{z.label}</span>
                </label>
              ))}
            </div>
          </div>

          {assetType !== '3D_GEOM' && applicableZones.length > 0 && (
            <div style={s.field}>
              <label style={s.label}>Placement Config</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {applicableZones.map(zone => {
                  const zoneLabel = CAKE_ZONES.find(z => z.value === zone)?.label ?? zone;
                  return (
                    <div key={zone} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>{zoneLabel}</span>
                      <select style={{ ...s.select, flex: 1 }} value={placementConfig[zone] ?? 'hug'} onChange={e => setPlacementConfig(c => ({ ...c, [zone]: e.target.value }))}>
                        {PLACEMENT_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                      </select>
                    </div>
                  );
                })}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>Default scale (r)</span>
                  <input type="number" min="0.1" step="0.1" style={{ ...s.input, flex: 1 }} value={placementScale} placeholder="e.g. 2.5 — leave blank for auto" onChange={e => setPlacementScale(e.target.value)} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>Size range</span>
                  <input type="number" min="0.1" step="0.1" style={{ ...s.input, flex: 1 }} value={placementScaleMin} placeholder="min — e.g. 0.5" onChange={e => setPlacementScaleMin(e.target.value)} />
                  <input type="number" min="0.1" step="0.1" style={{ ...s.input, flex: 1 }} value={placementScaleMax} placeholder="max — e.g. 1.5" onChange={e => setPlacementScaleMax(e.target.value)} />
                  <input type="number" min="0.01" step="0.01" style={{ ...s.input, flex: 1 }} value={placementScaleStep} placeholder="step — e.g. 0.05" onChange={e => setPlacementScaleStep(e.target.value)} />
                </div>
                <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>
                  Limits how far users can resize this element in the designer (e.g. sprinkles stay small): min, max, and the step increment per notch on the size control. All optional — blank uses the designer defaults. Keep the default scale (r) within this range, and pick a step that divides max−min evenly.
                </div>
                <label style={{ ...s.checkRow, alignItems: 'flex-start', marginTop: 4 }}>
                  <input type="checkbox" style={{ ...s.checkbox, marginTop: 1 }} checked={effectiveCanScatter} disabled={isScatterType} onChange={e => setCanScatter(e.target.checked)} />
                  <div>
                    <div style={s.checkLabel}>Can scatter (density){isScatterType ? ' — inherent to this type' : ''}</div>
                    <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>
                      Many packed instances controlled by a density slider in the designer (sprinkles, pearls). For discrete decor, leave off and let users duplicate by hand. Mutually exclusive with single-per-slot.
                    </div>
                  </div>
                </label>
                <label style={{ ...s.checkRow, alignItems: 'flex-start', marginTop: 4 }}
                  title="Off = lies flat against the side (hugs the wall). On = raised off the wall — for deep 3D pieces that look half-buried when flattened.">
                  <input type="checkbox" style={{ ...s.checkbox, marginTop: 1 }} checked={sideProud} onChange={e => setSideProud(e.target.checked)} />
                  <div>
                    <div style={s.checkLabel}>Stands out from the side wall</div>
                    <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>
                      Off = lies flat against the side (hugs the wall). On = raised off the wall — for deep 3D pieces (e.g. a topper) that look half-buried when flattened.
                    </div>
                  </div>
                </label>
                <label style={{ ...s.checkRow, alignItems: 'flex-start', marginTop: 4, opacity: effectiveCanScatter ? 0.45 : 1 }}>
                  <input type="checkbox" style={{ ...s.checkbox, marginTop: 1 }} checked={singlePerSlot} disabled={effectiveCanScatter} onChange={e => setSinglePerSlot(e.target.checked)} />
                  <div>
                    <div style={s.checkLabel}>Single per slot (hero element)</div>
                    <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>
                      One instance per tier×surface via the checkbox chooser (toppers, top&side decor), instead of free scatter.
                    </div>
                  </div>
                </label>
                {singlePerSlot && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>Side hug fill</span>
                    <input type="number" min="0.1" max="1" step="0.05" style={{ ...s.input, flex: 1 }} value={hugFill} placeholder="0.7 — fraction of wall height (blank = default)" onChange={e => setHugFill(e.target.value)} />
                  </div>
                )}
                {assetType === '2D' && (
                  <>
                    <label style={{ ...s.checkRow, alignItems: 'flex-start', marginTop: 4 }}
                      title="Splits the image down the middle into two wings that hinge up into a shallow V — a folded card decal (e.g. a butterfly).">
                      <input type="checkbox" style={{ ...s.checkbox, marginTop: 1 }} checked={foldable} onChange={e => setFoldable(e.target.checked)} />
                      <div>
                        <div style={s.checkLabel}>Folded decal (two hinged wings)</div>
                        <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>
                          Splits the image at the spine into two wings that fold up into a shallow V — for folded card decals like a butterfly. Use an upright, roughly symmetric image.
                        </div>
                      </div>
                    </label>
                    {foldable && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>Fold / spine</span>
                        <input type="number" min="0" max="75" step="1" style={{ ...s.input, flex: 1 }} value={foldAngle} placeholder="fold° — e.g. 32 (blank = 30)" onChange={e => setFoldAngle(e.target.value)} />
                        <input type="number" min="0.35" max="0.65" step="0.01" style={{ ...s.input, flex: 1 }} value={spineSplit} placeholder="spine — e.g. 0.5" onChange={e => setSpineSplit(e.target.value)} />
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          <div style={s.field}>
            <label style={s.checkRow}>
              <input type="checkbox" style={s.checkbox} checked={isParent} onChange={handleIsParentToggle} />
              <span style={s.checkLabel}>Is Parent</span>
            </label>
          </div>

          {!isParent && elementTypeId && (
            <div style={s.field}>
              <label style={s.label}>Parent Element</label>
              <select style={s.select} value={parentId} onChange={e => setParentId(e.target.value)}>
                <option value="">Select parent…</option>
                {parentOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}

          <div style={s.field}>
            <label style={s.label}>Capabilities</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
              {[
                { key: 'resize',    label: 'Resizable',        hint: '＋/− size buttons in edit strip' },
                { key: 'duplicate', label: 'Duplicatable',     hint: 'Copy button creates another instance with same size and color' },
                { key: 'color',     label: 'Color changeable', hint: 'Color picker in the designer — tints a GLB material, or recolours a 2D image (choose the area below)' },
                { key: 'gradient',  label: 'Gradient colors',  hint: 'Customer can blend up to 3 colors (swirl / vertical / linear) — for swirls & ombré (GLB only)' },
                { key: 'delete',    label: 'Deletable',        hint: 'Remove button shown when selected' },
                { key: 'move',      label: 'Movable',          hint: 'Nudge ◀▶▲▼ position on the cake' },
                { key: 'tilt',      label: 'Tiltable',         hint: 'Lean / rotate slightly in the designer' },
              ].map(({ key, label, hint }) => (
                <label key={key} style={{ ...s.checkRow, alignItems: 'flex-start', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    style={{ ...s.checkbox, marginTop: 1 }}
                    checked={capabilities[key]}
                    onChange={e => setCapabilities(c => ({ ...c, [key]: e.target.checked }))}
                  />
                  <div>
                    <div style={s.checkLabel}>{label}</div>
                    <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>{hint}</div>
                  </div>
                </label>
              ))}
            </div>
            {/* Which pixels of a 2D image the colour picker recolours. Generic (not asset-specific):
                appears only when this element is colour-changeable AND the asset is a 2D image. */}
            {capabilities.color && assetType === '2D' && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed #C5D4C8' }}>
                <label style={{ ...s.label, marginBottom: 4 }}>Recolourable area</label>
                <select style={s.select} value={recolorMethod} onChange={e => setRecolorMethod(e.target.value)}>
                  <option value="opaque">Whole image — recolour every pixel (solid stickers)</option>
                  <option value="saturated">Coloured fill, keep black/white lines (any colour + outline)</option>
                  <option value="blue_gt_green">Coloured fill, keep gold/white outline (blue-dominant fill)</option>
                </select>
                {recolorMethod === 'blue_gt_green' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>Edge protect</span>
                    <input type="number" min="0" max="50" step="1" style={{ ...s.input, flex: 1 }} value={recolorGuard} placeholder="12 — raise if colour bleeds into the outline" onChange={e => setRecolorGuard(e.target.value)} />
                  </div>
                )}
                {recolorMethod === 'saturated' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>Saturation min</span>
                    <input type="number" min="0" max="0.8" step="0.01" style={{ ...s.input, flex: 1 }} value={recolorSat} placeholder="0.25 — lower catches more, higher protects lines" onChange={e => setRecolorSat(e.target.value)} />
                  </div>
                )}
                <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 6, lineHeight: 1.5 }}>
                  The picker keeps each pixel's brightness (shading survives). <b>Whole image</b> suits a single-fill sticker; <b>Coloured fill</b> recolours only the blue-dominant fill and leaves gold/white lines — for outlined decals. Multi-colour artwork isn't a fit: leave colour-changeable off.
                </div>
              </div>
            )}
          </div>

          {/* Baker craft guide (X-Ray) — required for cream piping elements */}
          {isPipingType && (
            <div style={{ marginBottom: 20, padding: 16, borderRadius: 12, border: '1.5px solid #C9D9E0', background: '#F4F8FB' }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: '#3A5563', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 }}>
                Baker Craft Guide · X-Ray <span style={{ color: '#c0392b' }}>*</span>
              </div>
              <div style={{ fontSize: 11, color: '#7E97A2', marginBottom: 14, lineHeight: 1.5 }}>
                Required for cream piping — at least one nozzle. Add a thumbnail, then hit <b>Fill with GPT</b> or enter them by hand.
              </div>
              <CraftGuideFields
                recs={craftRecs} setRecs={setCraftRecs}
                consistency={craftConsistency} setConsistency={setCraftConsistency}
                technique={craftTechnique} setTechnique={setCraftTechnique}
                onSuggest={handleCraftSuggest} suggesting={craftSuggesting} suggestError={craftSuggestError}
                canSuggest={!!thumbnailBlob}
              />
            </div>
          )}

          <button
            style={{ ...s.btn('primary'), opacity: (saving || removingBg) ? 0.6 : 1 }}
            onClick={handleSave}
            disabled={saving || removingBg}
          >
            {saving ? 'Saving…' : removingBg ? 'Processing thumbnail…' : 'Save Element'}
          </button>

          {msg && <div style={s.msg(msg.ok)}>{msg.text}</div>}
        </div>
      </div>
    </>
  );
}
