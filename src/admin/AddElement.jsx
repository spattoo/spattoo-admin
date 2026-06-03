import { useState, useEffect, useRef, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, useGLTF, Environment } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { fetchElementTypes, fetchParentElements, getSignedUploadUrl, uploadToR2, createGlobalElement, removeBg, suggestElementMeta } from '../lib/api.js';

const ASSET_TYPES = [
  { value: '2D',      label: '2D Image',       folder: 'elements/files/2D' },
  { value: '3D',      label: '3D Model (GLB)', folder: 'elements/files/3D' },
  { value: '3D_GEOM', label: '3D Geometry',    folder: null },
];

const CAKE_ZONES = [
  { value: 'top_surface',  label: 'Top Surface' },
  { value: 'side',         label: 'Side' },
  { value: 'middle_tier',  label: 'Middle Tier' },
  { value: 'board',        label: 'Board' },
];

const PLACEMENT_MODES = [
  { value: '',                label: 'hug (default)' },
  { value: 'stand',           label: 'stand' },
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

// Captures camera ref from inside Canvas so parent can read it on confirm
function CameraCapture({ camRef }) {
  const { camera } = useThree();
  useEffect(() => { camRef.current = camera; }, [camera]);
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

// Compute model rotation from how much the camera orbited vs its initial orientation
function cameraToModelRotation(initialQuat, currentQuat) {
  const delta = initialQuat.clone().invert().multiply(currentQuat);
  const euler = new THREE.Euler().setFromQuaternion(delta, 'XYZ');
  const toDeg = r => ((r * 180 / Math.PI) % 360 + 360) % 360;
  return [toDeg(euler.x), toDeg(euler.y), toDeg(euler.z)];
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
  const [capabilities, setCapabilities]       = useState({ resize: true, duplicate: true, color: false, delete: true });
  const [glbRotation, setGlbRotation]       = useState([0, 0, 0]);
  const [frontConfirmed, setFrontConfirmed] = useState(false);
  const camRef      = useRef(null);
  const initialQuat = useRef(null);
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

  function captureInitialQuat() {
    if (camRef.current && !initialQuat.current) {
      initialQuat.current = camRef.current.quaternion.clone();
    }
  }

  function confirmFrontView() {
    if (camRef.current && initialQuat.current) {
      const rotation = cameraToModelRotation(initialQuat.current, camRef.current.quaternion);
      setGlbRotation(rotation);
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

  async function handleSave() {
    const needsFile = assetType !== '3D_GEOM';
    if (!name.trim() || !elementTypeId || (needsFile && !assetFile)) {
      setMsg({ ok: false, text: 'Name, element type and asset file are required.' });
      return;
    }
    if (assetType === '3D' && !frontConfirmed) {
      setMsg({ ok: false, text: 'Set the front view before saving — drag the model and click "✓ This is the front".' });
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
    if ((assetType === '3D' || assetType === '3D_GEOM') && !thumbnailBlob) {
      setMsg({ ok: false, text: 'A thumbnail is required — upload one below.' });
      return;
    }
    setSaving(true);
    setMsg(null);

    try {
      // Asset file upload — skipped for 3D Geometry (procedural, no file)
      // For 2D, upload the background-removed blob so the canvas renders without a background.
      let assetKey = null;
      if (needsFile) {
        const folder = ASSET_TYPES.find(a => a.value === assetType).folder;
        const fileToUpload = assetType === '2D' && thumbnailBlob ? thumbnailBlob : assetFile;
        const ext = assetType === '2D' ? 'png' : assetFile.name.split('.').pop();
        const assetFilename = `${crypto.randomUUID()}.${ext}`;
        const assetContentType = assetType === '2D' ? 'image/png' : (assetFile.type || 'model/gltf-binary');
        const { url: assetUrl, key } = await getSignedUploadUrl(folder, assetFilename, assetContentType);
        await uploadToR2(assetUrl, fileToUpload);
        assetKey = key;
      }

      // Thumbnail is always PNG (remove.bg output or manual upload)
      const thumbFilename = `${crypto.randomUUID()}.png`;
      const { url: thumbUrl, key: thumbKey } = await getSignedUploadUrl('elements/thumbnails', thumbFilename, 'image/png');
      await uploadToR2(thumbUrl, thumbnailBlob);

      let builtPlacementConfig = {};
      if (assetType === '3D_GEOM') {
        builtPlacementConfig = { top_surface: 'faux_balls', side: 'faux_balls', roughness: glbRoughness, metalness: glbMetalness };
      } else {
        for (const zone of applicableZones) {
          if (placementConfig[zone]) builtPlacementConfig[zone] = placementConfig[zone];
        }
        if (placementScale !== '') builtPlacementConfig.r = parseFloat(placementScale);
        if (assetType === '3D' && glbRotation.some(v => v !== 0))
          builtPlacementConfig.rotation = glbRotation;
      }

      await createGlobalElement({
        name:             name.trim(),
        description:      description.trim() || null,
        element_type_id:  elementTypeId,
        parent_id:        isParent ? null : parentId,
        image_url:        assetKey,
        thumbnail_url:    thumbKey,
        allowed_zones:    applicableZones,
        placement_config: builtPlacementConfig,
        allowed_actions:  capabilities,
        default_color:    assetType === '3D_GEOM'
          ? elementColor
          : (assetType === '3D' && userPickedColor ? elementColor : null),
        sort_order:       0,
      });

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
      setCapabilities({ resize: true, duplicate: true, color: false, delete: true });
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  }

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
              onChange={f => { setAssetFile(f); setGlbHasTexture(null); setUserPickedColor(false); setGlbRoughness(0.6); setGlbMetalness(0); setGlbEnvPreset('none'); setGlbRotation([0,0,0]); setFrontConfirmed(false); initialQuat.current = null; }}
            />
          )}

          {/* 3D Geometry preview + controls */}
          {assetType === '3D_GEOM' && (
            <>
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
                onCapture={() => { captureInitialQuat(); captureThumbnail(); }}
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
                  <button onClick={confirmFrontView}
                    style={{ fontSize: 11, padding: '5px 12px', borderRadius: 6, border: `2px solid ${frontConfirmed ? '#3D5A44' : '#e05252'}`, background: frontConfirmed ? '#3D5A44' : '#fff', color: frontConfirmed ? '#fff' : '#e05252', cursor: 'pointer', fontWeight: 700, fontFamily: "'Quicksand',sans-serif" }}>
                    {frontConfirmed ? '✓ Front set' : '✱ Set front view (required)'}
                  </button>
                </div>
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
                {suggesting ? 'Thinking…' : '✦ Suggest'}
              </button>
            </div>
            <input style={s.input} value={name} onChange={e => { setName(e.target.value); setSuggestions(null); }} placeholder="e.g. Rainbow Topper" />
            {suggestError && (
              <div style={{ fontSize: 11, color: '#c0392b', fontWeight: 600, marginTop: 6, padding: '6px 10px', background: '#fdf0ee', borderRadius: 6 }}>
                ✕ {suggestError}
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
                      <select style={{ ...s.select, flex: 1 }} value={placementConfig[zone] ?? ''} onChange={e => setPlacementConfig(c => ({ ...c, [zone]: e.target.value }))}>
                        {PLACEMENT_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                      </select>
                    </div>
                  );
                })}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 100 }}>Default scale (r)</span>
                  <input type="number" min="0.1" step="0.1" style={{ ...s.input, flex: 1 }} value={placementScale} placeholder="e.g. 2.5 — leave blank for auto" onChange={e => setPlacementScale(e.target.value)} />
                </div>
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
                { key: 'color',     label: 'Color changeable', hint: 'Color picker in designer (GLB only)' },
                { key: 'delete',    label: 'Deletable',        hint: 'Remove button shown when selected' },
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
          </div>

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
