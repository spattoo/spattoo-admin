import { useState, useRef, useEffect, useMemo, Suspense } from 'react';
import { Canvas, useLoader, useThree } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { fetchElementTypes, getSignedUploadUrl, uploadToR2, uploadThumbnail, createGlobalElement, removeBg } from '../lib/api.js';
import { measureGlbBuffer, toStatColumns, deriveAssetClass } from '../lib/glb.js';
import { displaceCreamWaveCylinder, getCreamGrainNormalMap } from '../lib/creamWaveTexture.js';

// Cream-wave finish: a tangent-space normal map baked from the Meshy reference cake (its wavy
// combing lives in geometry, so we baked it to a map and apply it to a SMOOTH cylinder — the
// silhouette/extents stay clean for the designer's collision/placement clamps).
const CREAM_NORMAL_URL = '/cream_normal.png';

// ── 2D canvas constants ──────────────────────────────────────────────────────

const CANVAS_SIZE = 400;
const C = CANVAS_SIZE / 2;
const R = CANVAS_SIZE / 2 - 28;

const SHAPES_2D = [
  { id: 'star',     label: 'Star' },
  { id: 'heart',    label: 'Heart' },
  { id: 'sprinkle', label: 'Sprinkle' },
  { id: 'circle',   label: 'Circle' },
  { id: 'diamond',  label: 'Diamond' },
  { id: 'flower',   label: 'Flower' },
  { id: 'hexagon',  label: 'Hexagon' },
  { id: 'teardrop', label: 'Teardrop' },
];

const SHAPES_3D = [
  { id: 'sphere',    label: 'Sphere' },
  { id: 'fauxball3d', label: 'Faux Ball' },
  { id: 'star3d',    label: 'Star' },
  { id: 'heart3d',   label: 'Heart' },
  { id: 'cone',      label: 'Cone' },
  { id: 'torus',     label: 'Ring / Torus' },
  { id: 'cube',      label: 'Cube' },
  { id: 'creamcake', label: 'Cream Cake' },
  { id: 'creamwaveproc', label: 'Cream Wave (Proc)' },
];

// Per-shape material presets applied when the shape is selected
const SHAPE_3D_PRESETS = {
  fauxball3d:    { color: '#D4A843', roughness: 0.12, metalness: 0.96 },
  creamcake:     { color: '#f7f1e8', roughness: 0.62, metalness: 0.00 },
  creamwaveproc: { color: '#f7f1e8', roughness: 0.62, metalness: 0.00 },
};

// Default cream-wave tuning. With the baked normal map, only relief depth (normalScale) applies.
const CREAM_DEFAULTS = { depth: 1.0 };

// Procedural cream-wave defaults (the tunable engine — density/depth/falloff/wave are continuous).
const PROC_DEFAULTS = { density: 6, lobes: 2, wave: 0.35, interleave: 0.9, lineWidth: 0.05, relief: 0.03, falloff: 0.4 };

import { ZONE_LIST as ZONES } from '../lib/constants.js';

// ── 2D drawing ───────────────────────────────────────────────────────────────

function makeFill(ctx, color, color2) {
  if (!color2) return color;
  const grad = ctx.createRadialGradient(C - R * 0.15, C - R * 0.15, R * 0.05, C, C, R);
  grad.addColorStop(0, color);
  grad.addColorStop(1, color2);
  return grad;
}

function lighten(hex, amount = 0.45) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const m = v => Math.round(v + (255 - v) * amount);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}


function render2DShape(ctx, shapeId, color, color2) {
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  const fill = makeFill(ctx, color, color2 || null);

  switch (shapeId) {
    case 'star': {
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const angle = (i * Math.PI / 5) - Math.PI / 2;
        const rad = i % 2 === 0 ? R : R * 0.42;
        const x = C + Math.cos(angle) * rad;
        const y = C + Math.sin(angle) * rad;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      break;
    }
    case 'heart': {
      const sc = R / 130;
      ctx.save();
      ctx.translate(C, C);
      ctx.scale(sc, sc);
      ctx.beginPath();
      ctx.moveTo(0, -70);
      ctx.bezierCurveTo(70, -130, 130, -60, 130, -10);
      ctx.bezierCurveTo(130, 45, 70, 105, 0, 130);
      ctx.bezierCurveTo(-70, 105, -130, 45, -130, -10);
      ctx.bezierCurveTo(-130, -60, -70, -130, 0, -70);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'sprinkle': {
      const pw = R * 0.28;
      const ph = R * 0.95;
      const br = pw;
      ctx.save();
      ctx.translate(C, C);
      ctx.rotate(Math.PI / 7);
      ctx.beginPath();
      ctx.moveTo(-pw, -ph + br);
      ctx.arcTo(-pw, -ph, 0, -ph, br);
      ctx.arcTo(pw, -ph, pw, -ph + br, br);
      ctx.lineTo(pw, ph - br);
      ctx.arcTo(pw, ph, 0, ph, br);
      ctx.arcTo(-pw, ph, -pw, ph - br, br);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'circle': {
      ctx.beginPath();
      ctx.arc(C, C, R, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      break;
    }
    case 'diamond': {
      ctx.save();
      ctx.translate(C, C);
      ctx.rotate(Math.PI / 4);
      const side = R * 1.04;
      ctx.beginPath();
      ctx.rect(-side * 0.62, -side * 0.62, side * 1.24, side * 1.24);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'flower': {
      const petals = 6;
      const dist = R * 0.36;
      const pw2 = R * 0.34;
      const ph2 = R * 0.58;
      ctx.fillStyle = fill;
      for (let i = 0; i < petals; i++) {
        const angle = (i / petals) * Math.PI * 2;
        const px = C + Math.cos(angle) * dist;
        const py = C + Math.sin(angle) * dist;
        ctx.beginPath();
        ctx.ellipse(px, py, pw2, ph2, angle, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(C, C, R * 0.28, 0, Math.PI * 2);
      ctx.fillStyle = color2 || lighten(color);
      ctx.fill();
      break;
    }
    case 'hexagon': {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = (i * Math.PI / 3) - Math.PI / 6;
        const x = C + Math.cos(angle) * R;
        const y = C + Math.sin(angle) * R;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      break;
    }
    case 'teardrop': {
      const blobR = R * 0.54;
      const topCy = C - R * 0.12;
      const tipY = C + R;
      ctx.beginPath();
      ctx.arc(C, topCy, blobR, Math.PI, 0);
      ctx.bezierCurveTo(C + blobR, topCy + blobR * 0.75, C + 18, tipY - 28, C, tipY);
      ctx.bezierCurveTo(C - 18, tipY - 28, C - blobR, topCy + blobR * 0.75, C - blobR, topCy);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      break;
    }
    default: break;
  }
}

// ── 3D geometry builders ─────────────────────────────────────────────────────

function makeStarShape3D() {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const angle = (i * Math.PI / 5) - Math.PI / 2;
    const rad = i % 2 === 0 ? 1 : 0.42;
    const x = Math.cos(angle) * rad;
    const y = Math.sin(angle) * rad;
    i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

function makeHeartShape3D() {
  const shape = new THREE.Shape();
  const sc = 1 / 130;
  shape.moveTo(0, 70 * sc);
  shape.bezierCurveTo(70 * sc, 130 * sc, 130 * sc, 60 * sc, 130 * sc, 10 * sc);
  shape.bezierCurveTo(130 * sc, -45 * sc, 70 * sc, -105 * sc, 0, -130 * sc);
  shape.bezierCurveTo(-70 * sc, -105 * sc, -130 * sc, -45 * sc, -130 * sc, 10 * sc);
  shape.bezierCurveTo(-130 * sc, 60 * sc, -70 * sc, 130 * sc, 0, 70 * sc);
  shape.closePath();
  return shape;
}

const BEVEL = { depth: 0.45, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.05, bevelSegments: 4 };

// Faux ball: L = 2R so bbox center = ball bottom = stick top = y=0
// Ball sits above y=0; stick hangs below. When placed on top surface,
// y=0 aligns with the cake surface so the stick goes fully inside.
const FB_BALL_R  = 0.6;   // sphere radius
const FB_STICK_H = 1.2;   // stick length (= 2 × FB_BALL_R)
const FB_STICK_R = 0.035; // stick radius
const FB_BALL_Y  =  0.6;  // ball center y (= FB_BALL_R above surface)
const FB_STICK_Y = -0.6;  // stick center y (= -FB_STICK_H/2)

function make3DGeometry(shapeId) {
  switch (shapeId) {
    case 'sphere':   return new THREE.SphereGeometry(1, 48, 48);
    case 'star3d': {
      const g = new THREE.ExtrudeGeometry(makeStarShape3D(), BEVEL);
      g.center();
      return g;
    }
    case 'heart3d': {
      const g = new THREE.ExtrudeGeometry(makeHeartShape3D(), BEVEL);
      g.center();
      return g;
    }
    case 'cone':     return new THREE.ConeGeometry(1, 2, 48);
    case 'torus':    return new THREE.TorusGeometry(0.75, 0.32, 24, 120);
    case 'cube':     return new THREE.BoxGeometry(1.6, 1.6, 1.6);
    case 'creamcake':
    case 'creamwaveproc': return new THREE.CylinderGeometry(1, 1, 1.7, 220, 1);
    default:         return new THREE.SphereGeometry(1, 48, 48);
  }
}

async function buildAndExportGLB(shapeId, color, roughness, metalness) {
  const scene = new THREE.Scene();
  const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness, metalness });

  if (shapeId === 'fauxball3d') {
    const group = new THREE.Group();
    const ball = new THREE.Mesh(new THREE.SphereGeometry(FB_BALL_R, 36, 36), material);
    ball.position.y = FB_BALL_Y;
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(FB_STICK_R, FB_STICK_R * 0.8, FB_STICK_H, 12), material);
    stick.position.y = FB_STICK_Y;
    group.add(ball);
    group.add(stick);
    scene.add(group);
  } else {
    scene.add(new THREE.Mesh(make3DGeometry(shapeId), material));
  }

  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(scene, result => resolve(result), reject, { binary: true });
  });
}

// ── 3D preview component ─────────────────────────────────────────────────────

// Combed-buttercream cylinder: the baked cream-wave normal map on the SIDE, plain caps
// (CylinderGeometry material groups: 0 = side, 1 = top, 2 = bottom). `depth` (normalScale) is the
// only live knob — it scales the relief without touching geometry.
function CreamCakeMesh({ color, roughness, cream }) {
  const geometry = useMemo(() => new THREE.CylinderGeometry(1, 1, 1.7, 256, 1), []);
  const normalMap = useLoader(THREE.TextureLoader, CREAM_NORMAL_URL);
  useMemo(() => {
    normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
    normalMap.colorSpace = THREE.NoColorSpace;   // a normal map is data, not colour
    normalMap.needsUpdate = true;
  }, [normalMap]);
  return (
    <mesh geometry={geometry}>
      <meshPhysicalMaterial attach="material-0" color={color} roughness={roughness} metalness={0}
        clearcoat={0.08} clearcoatRoughness={0.6} sheen={0.3} sheenRoughness={0.6}
        sheenColor={'#fff6e8'} envMapIntensity={0.5}
        normalMap={normalMap} normalScale={[cream.depth, cream.depth]} />
      <meshPhysicalMaterial attach="material-1" color={color} roughness={roughness} metalness={0}
        clearcoat={0.08} clearcoatRoughness={0.6} sheen={0.3} sheenRoughness={0.6} sheenColor={'#fff6e8'} envMapIntensity={0.5} />
      <meshPhysicalMaterial attach="material-2" color={color} roughness={roughness} metalness={0}
        clearcoat={0.08} clearcoatRoughness={0.6} sheen={0.3} sheenRoughness={0.6} sheenColor={'#fff6e8'} envMapIntensity={0.5} />
    </mesh>
  );
}

// PROCEDURAL cream-wave cylinder — REAL displaced geometry (the ribs project and break the
// silhouette, like the Meshy reference; a normal map can't). The side wall is pushed out by the
// shared wave field; thin `lineWidth` (ribbonW) leaves a smooth wall with thin proud lines, and
// `relief` is the world-space depth. `interleave` (0..1) maps to bandPhase 0..π: 0 = parallel
// corduroy, 0.9 = the braided, out-of-phase ripple. Geometry rebuilds only when a field param moves.
function ProcCreamMesh({ color, roughness, proc }) {
  const geometry = useMemo(() => {
    const g = new THREE.CylinderGeometry(1, 1, 1.7, 420, 380);   // dense enough to resolve thin incised lines
    displaceCreamWaveCylinder(g, {
      relief: proc.relief, ridges: proc.density, lobes: proc.lobes, waveAmp: proc.wave,
      ribbonW: proc.lineWidth, bandPhase: proc.interleave * Math.PI, falloff: proc.falloff,
    });
    return g;
  }, [proc.relief, proc.density, proc.lobes, proc.wave, proc.lineWidth, proc.interleave, proc.falloff]);
  // Fine sugar-paste micro-grain tiled small over the wall — makes it read as cream, not plastic.
  const grain = useMemo(() => {
    const g = getCreamGrainNormalMap().clone();
    g.wrapS = g.wrapT = THREE.RepeatWrapping; g.repeat.set(10, 18); g.needsUpdate = true;
    return g;
  }, []);
  // Buttercream material: MATTE-satin (high roughness, only a whisper of clearcoat/sheen — not glossy
  // plastic) + the grain. Needs the scene env (StudioEnv) for its soft reflections. Same on all three
  // groups (side + caps).
  const mat = (key) => (
    <meshPhysicalMaterial attach={key} color={color} metalness={0} roughness={roughness}
      clearcoat={0.08} clearcoatRoughness={0.6} sheen={0.3} sheenRoughness={0.6}
      sheenColor={'#fff6e8'} envMapIntensity={0.5}
      normalMap={grain} normalScale={[0.18, 0.18]} />
  );
  return (
    <mesh geometry={geometry}>
      {mat('material-0')}{mat('material-1')}{mat('material-2')}
    </mesh>
  );
}

function ShapeMesh({ shapeId, color, roughness, metalness, cream, proc }) {
  const geometry = useMemo(() => (shapeId === 'fauxball3d' || shapeId === 'creamcake' || shapeId === 'creamwaveproc') ? null : make3DGeometry(shapeId), [shapeId]);
  if (shapeId === 'creamcake') {
    return <CreamCakeMesh color={color} roughness={roughness} cream={cream} />;
  }
  if (shapeId === 'creamwaveproc') {
    return <ProcCreamMesh color={color} roughness={roughness} proc={proc} />;
  }
  if (shapeId === 'fauxball3d') {
    return (
      <group>
        <mesh position={[0, FB_BALL_Y, 0]}>
          <sphereGeometry args={[FB_BALL_R, 36, 36]} />
          <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} />
        </mesh>
        <mesh position={[0, FB_STICK_Y, 0]}>
          <cylinderGeometry args={[FB_STICK_R, FB_STICK_R * 0.8, FB_STICK_H, 12]} />
          <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} />
        </mesh>
      </group>
    );
  }
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} />
    </mesh>
  );
}

// Local image-based lighting from three's RoomEnvironment (a soft studio) — no CDN fetch, unlike
// drei's preset HDRs. The gentle reflections are what make cream read as cream; without an env map
// the sheen/clearcoat have nothing to reflect and the surface looks matte.
function StudioEnv() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const tex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = tex;
    return () => { tex.dispose(); pmrem.dispose(); scene.environment = null; };
  }, [gl, scene]);
  return null;
}

function Preview3D({ shapeId, color, roughness, metalness, cream, proc, containerRef, ambientInt, keyInt, fillInt, envPreset }) {
  return (
    <div
      ref={containerRef}
      style={{ height: 260, borderRadius: 12, overflow: 'hidden', background: '#E8EDE9' }}
    >
      <Canvas
        gl={{ preserveDrawingBuffer: true, alpha: true }}
        camera={{ position: [0, 1, 3.5], fov: 40 }}
        onCreated={({ gl }) => { gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 0.85; }}
      >
        <ambientLight intensity={ambientInt} />
        <directionalLight position={[4, 6, 4]} intensity={keyInt} />
        <directionalLight position={[-3, 2, -2]} intensity={fillInt} />
        {envPreset === 'none' ? <StudioEnv /> : <Environment preset={envPreset} />}
        <Suspense fallback={null}>
          <ShapeMesh shapeId={shapeId} color={color} roughness={roughness} metalness={metalness} cream={cream} proc={proc} />
        </Suspense>
        <OrbitControls enablePan={false} />
      </Canvas>
    </div>
  );
}

// ── Main screen ──────────────────────────────────────────────────────────────

export default function GenerateShape() {
  const [assetType, setAssetType] = useState('2D');

  // 2D state
  const [shape2d, setShape2d]         = useState('star');
  const [color2d, setColor2d]         = useState('#FF6B9D');
  const [color2dB, setColor2dB]       = useState('#FF3366');
  const [useGradient, setUseGradient] = useState(false);

  // 3D state
  const [shape3d, setShape3d]         = useState('fauxball3d');
  const [color3d, setColor3d]         = useState(SHAPE_3D_PRESETS.fauxball3d.color);
  const [roughness, setRoughness]     = useState(SHAPE_3D_PRESETS.fauxball3d.roughness);
  const [metalness, setMetalness]     = useState(SHAPE_3D_PRESETS.fauxball3d.metalness);

  // Cream-wave finish tuning (only used by the 'creamcake' preview shape).
  const [cream, setCream]             = useState(CREAM_DEFAULTS);
  // Procedural cream-wave tuning (only used by the 'creamwaveproc' preview shape).
  const [proc, setProc]               = useState(PROC_DEFAULTS);

  // Lighting — defaults tuned for the local studio IBL (StudioEnv); the env carries most of the
  // light so the directional lights are gentle (bright directionals + env washes colour to white).
  const [ambientInt, setAmbientInt]   = useState(0.25);
  const [keyInt, setKeyInt]           = useState(1.4);
  const [fillInt, setFillInt]         = useState(0.5);
  const [envPreset, setEnvPreset]     = useState('none');

  // Shared
  const [elementTypes, setElementTypes]     = useState([]);
  const [elementTypeId, setElementTypeId]   = useState('');
  const [name, setName]                     = useState('Faux Ball');
  const [zones, setZones]                   = useState(['top_surface', 'side', 'middle_tier']);
  const [placementConfig, setPlacementConfig] = useState({});
  const [canScatter, setCanScatter]         = useState(false);
  const [capabilities, setCapabilities]     = useState({ resize: true, duplicate: true, color: false, delete: true, move: false, tilt: false });
  const [saving, setSaving]                 = useState(false);
  const [msg, setMsg]                       = useState(null);

  const canvas2dRef     = useRef(null);
  const preview3dRef    = useRef(null); // div wrapping the R3F Canvas

  useEffect(() => {
    fetchElementTypes()
      .then(types => {
        setElementTypes(types);
        if (types.length > 0) setElementTypeId(types[0].id);
      })
      .catch(() => {});
  }, []);

  // Redraw 2D canvas when relevant state changes
  useEffect(() => {
    if (assetType !== '2D') return;
    const canvas = canvas2dRef.current;
    if (!canvas) return;
    render2DShape(canvas.getContext('2d'), shape2d, color2d, useGradient ? color2dB : null);
  }, [assetType, shape2d, color2d, color2dB, useGradient]);

  function pick2D(id) {
    setShape2d(id);
    const found = SHAPES_2D.find(s => s.id === id);
    if (found) setName(found.label);
  }

  function pick3D(id) {
    setShape3d(id);
    const found = SHAPES_3D.find(s => s.id === id);
    if (found) setName(found.label);
    const preset = SHAPE_3D_PRESETS[id];
    if (preset) {
      if (preset.color    !== undefined) setColor3d(preset.color);
      if (preset.roughness !== undefined) setRoughness(preset.roughness);
      if (preset.metalness !== undefined) setMetalness(preset.metalness);
    }
  }

  function switchType(t) {
    setAssetType(t);
    setMsg(null);
    if (t === '2D') { const f = SHAPES_2D.find(s => s.id === shape2d); if (f) setName(f.label); }
    if (t === '3D') { const f = SHAPES_3D.find(s => s.id === shape3d); if (f) setName(f.label); }
  }

  // When element type changes, seed placement config from the type's placement_rules
  useEffect(() => {
    const type = elementTypes.find(t => t.id === elementTypeId);
    const rules = type?.placement_rules ?? {};
    setPlacementConfig(prev => {
      const next = {};
      zones.forEach(z => { next[z] = prev[z] ?? rules.placement?.[z] ?? 'stand'; });
      return next;
    });
  }, [elementTypeId, elementTypes]);

  function toggleZone(z) {
    setZones(prev => {
      const next = prev.includes(z) ? prev.filter(x => x !== z) : [...prev, z];
      // Add default for newly added zone
      if (!prev.includes(z)) {
        const type = elementTypes.find(t => t.id === elementTypeId);
        const defaultMode = type?.placement_rules?.placement?.[z] ?? 'stand';
        setPlacementConfig(pc => ({ ...pc, [z]: defaultMode }));
      }
      return next;
    });
  }

  function setZonePlacement(z, mode) {
    setPlacementConfig(prev => ({ ...prev, [z]: mode }));
  }

  // Density-scatter: inherent for the scattered_decor type, otherwise opt-in (matches AddElement).
  const isScatterType = elementTypes.find(t => t.id === elementTypeId)?.slug === 'scattered_decor';
  const effectiveCanScatter = isScatterType || canScatter;

  async function handleSave() {
    if (!name.trim())    return setMsg({ ok: false, text: 'Enter a name' });
    if (!elementTypeId)  return setMsg({ ok: false, text: 'Select an element type' });
    if (!zones.length)   return setMsg({ ok: false, text: 'Select at least one zone' });

    setSaving(true);
    setMsg(null);

    // Density-scatter is config-driven in the designer (placement_config.scatter), never inferred
    // from element type — so persist it explicitly. Mutually exclusive with single_per_slot.
    const finalPlacementConfig = effectiveCanScatter
      ? { ...placementConfig, scatter: true }
      : placementConfig;

    try {
      if (assetType === '2D') {
        const canvas = canvas2dRef.current;
        const rawBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const fn = `${crypto.randomUUID()}.png`;
        const { url: fu, key: fk } = await getSignedUploadUrl('elements/files/2D', fn, 'image/png');
        await uploadToR2(fu, rawBlob);
        let thumbBlob = rawBlob;
        try { thumbBlob = await removeBg(rawBlob); } catch (e) { console.warn('remove.bg failed:', e.message); }
        const tk = await uploadThumbnail('elements/thumbnails', thumbBlob);
        await createGlobalElement({ name: name.trim(), element_type_id: elementTypeId, parent_id: null, image_url: fk, thumbnail_url: tk, allowed_zones: zones, placement_config: finalPlacementConfig, allowed_actions: capabilities, default_color: null, sort_order: 0 });

      } else {
        // Capture thumbnail from WebGL canvas
        const glCanvas = preview3dRef.current?.querySelector('canvas');
        if (!glCanvas) throw new Error('3D preview not ready — try again');
        const rawThumbBlob = await new Promise(resolve => glCanvas.toBlob(resolve, 'image/png'));
        let thumbBlob = rawThumbBlob;
        try { thumbBlob = await removeBg(rawThumbBlob); } catch (e) { console.warn('remove.bg failed:', e.message); }

        // Export GLB
        const glbBuffer = await buildAndExportGLB(shape3d, color3d, roughness, metalness);
        const glbBlob = new Blob([glbBuffer], { type: 'model/gltf-binary' });

        const glbFilename = `${crypto.randomUUID()}.glb`;
        const { url: fu, key: fk } = await getSignedUploadUrl('elements/files/3D', glbFilename, 'model/gltf-binary');
        await uploadToR2(fu, glbBlob);

        const tk = await uploadThumbnail('elements/thumbnails', thumbBlob);

        // Record the GLB cost (§3) — measured from the exported buffer. Best-effort; never blocks save.
        let statCols = {};
        try { statCols = toStatColumns(await measureGlbBuffer(glbBuffer, Math.round(glbBuffer.byteLength / 1024), deriveAssetClass({ placementConfig: finalPlacementConfig, zones }))); }
        catch (e) { console.warn('GLB measure failed:', e.message); }

        await createGlobalElement({ name: name.trim(), element_type_id: elementTypeId, parent_id: null, image_url: fk, thumbnail_url: tk, allowed_zones: zones, placement_config: finalPlacementConfig, allowed_actions: capabilities, default_color: color3d, sort_order: 0, ...statCols });
      }

      setMsg({ ok: true, text: 'Element saved!' });
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  }

  const s = {
    page: { minHeight: '100vh', background: '#EDEAE2', fontFamily: 'Quicksand, sans-serif', padding: '32px 24px' },
    title: { fontSize: 22, fontWeight: 800, color: '#2C4433', marginBottom: 24 },
    typeRow: { display: 'flex', gap: 10, marginBottom: 24 },
    typeBtn: (active) => ({
      flex: 1, padding: '10px 0', borderRadius: 10, border: `2px solid ${active ? '#3D5A44' : '#C5D4C8'}`,
      background: active ? '#3D5A44' : '#fff', color: active ? '#fff' : '#6B8C74',
      fontFamily: 'Quicksand, sans-serif', fontSize: 14, fontWeight: 800, cursor: 'pointer',
    }),
    layout: { display: 'grid', gridTemplateColumns: '1fr 320px', gap: 24, maxWidth: 1020, margin: '0 auto', alignItems: 'start' },
    card: { background: '#fff', borderRadius: 18, border: '1.5px solid #C5D4C8', padding: 28 },
    section: { marginBottom: 24 },
    sectionTitle: { fontSize: 11, fontWeight: 700, color: '#6B8C74', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 },
    shapeGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 },
    shapeBtn: (active) => ({
      padding: '12px 8px', borderRadius: 12, border: `2px solid ${active ? '#3D5A44' : '#C5D4C8'}`,
      background: active ? '#E8EDE9' : '#fff', cursor: 'pointer', fontFamily: 'Quicksand, sans-serif',
      fontSize: 12, fontWeight: 700, color: active ? '#2C4433' : '#6B8C74', transition: 'all 0.15s',
    }),
    colorRow: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' },
    colorGroup: { display: 'flex', alignItems: 'center', gap: 8 },
    colorSwatch: { width: 38, height: 38, borderRadius: 8, border: '1.5px solid #C5D4C8', cursor: 'pointer', padding: 2 },
    colorLabel: { fontSize: 12, fontWeight: 700, color: '#6B8C74' },
    gradToggle: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, fontWeight: 700, color: '#3D5A44' },
    label: { fontSize: 12, fontWeight: 700, color: '#6B8C74', display: 'block', marginBottom: 6 },
    input: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontFamily: 'Quicksand, sans-serif', fontSize: 14, fontWeight: 600, color: '#2C4433', background: '#fff', boxSizing: 'border-box', outline: 'none' },
    select: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontFamily: 'Quicksand, sans-serif', fontSize: 14, fontWeight: 600, color: '#2C4433', background: '#fff', boxSizing: 'border-box' },
    slider: { width: '100%', accentColor: '#3D5A44' },
    sliderRow: { display: 'flex', alignItems: 'center', gap: 10 },
    sliderVal: { fontSize: 12, fontWeight: 700, color: '#6B8C74', minWidth: 30 },
    zonesRow: { display: 'flex', flexWrap: 'wrap', gap: 8 },
    zoneChip: (active) => ({
      padding: '6px 12px', borderRadius: 20, border: `1.5px solid ${active ? '#3D5A44' : '#C5D4C8'}`,
      background: active ? '#E8EDE9' : '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700,
      color: active ? '#2C4433' : '#6B8C74',
    }),
    previewWrap: {
      display: 'flex', justifyContent: 'center', borderRadius: 12, padding: 20, marginBottom: 20,
      backgroundImage: 'linear-gradient(45deg, #ddd 25%, transparent 25%), linear-gradient(-45deg, #ddd 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ddd 75%), linear-gradient(-45deg, transparent 75%, #ddd 75%)',
      backgroundSize: '12px 12px',
      backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0px',
    },
    saveBtn: (disabled) => ({
      width: '100%', padding: '13px 0', borderRadius: 10, border: 'none',
      background: disabled ? '#9BB5A2' : '#3D5A44', color: '#fff',
      fontFamily: 'Quicksand, sans-serif', fontSize: 15, fontWeight: 800,
      cursor: disabled ? 'not-allowed' : 'pointer',
    }),
    msg: (ok) => ({
      marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700,
      background: ok ? '#E8F5E9' : '#FFF0F0', color: ok ? '#2E7D32' : '#C0392B',
    }),
  };

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Quicksand:wght@400;600;700;800&display=swap" rel="stylesheet" />
      <div style={s.page}>
        <div style={{ maxWidth: 1020, margin: '0 auto' }}>
          <div style={s.title}>Generate Shape Element</div>

          {/* 2D / 3D toggle */}
          <div style={s.typeRow}>
            <button style={s.typeBtn(assetType === '2D')} onClick={() => switchType('2D')}>2D Image</button>
            <button style={s.typeBtn(assetType === '3D')} onClick={() => switchType('3D')}>3D Model (GLB)</button>
          </div>
        </div>

        <div style={s.layout}>
          {/* ── Left: shape controls ── */}
          <div style={s.card}>

            {/* Shape grid */}
            <div style={s.section}>
              <div style={s.sectionTitle}>Shape</div>
              <div style={s.shapeGrid}>
                {(assetType === '2D' ? SHAPES_2D : SHAPES_3D).map(sh => (
                  <button
                    key={sh.id}
                    style={s.shapeBtn(assetType === '2D' ? shape2d === sh.id : shape3d === sh.id)}
                    onClick={() => assetType === '2D' ? pick2D(sh.id) : pick3D(sh.id)}
                  >
                    {sh.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Color */}
            {assetType === '2D' && (
              <div style={s.section}>
                <div style={s.sectionTitle}>Color</div>
                <div style={s.colorRow}>
                  <div style={s.colorGroup}>
                    <span style={s.colorLabel}>Primary</span>
                    <input type="color" value={color2d} onChange={e => setColor2d(e.target.value)} style={s.colorSwatch} />
                    <span style={{ fontSize: 12, color: '#6B8C74', fontWeight: 600 }}>{color2d}</span>
                  </div>
                  <label style={s.gradToggle}>
                    <input type="checkbox" checked={useGradient} onChange={e => setUseGradient(e.target.checked)} style={{ accentColor: '#3D5A44' }} />
                    Gradient
                  </label>
                  {useGradient && (
                    <div style={s.colorGroup}>
                      <span style={s.colorLabel}>Secondary</span>
                      <input type="color" value={color2dB} onChange={e => setColor2dB(e.target.value)} style={s.colorSwatch} />
                      <span style={{ fontSize: 12, color: '#6B8C74', fontWeight: 600 }}>{color2dB}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {assetType === '3D' && (
              <div style={s.section}>
                <div style={s.sectionTitle}>Material</div>
                <div style={{ ...s.colorRow, marginBottom: 14 }}>
                  <div style={s.colorGroup}>
                    <span style={s.colorLabel}>Color</span>
                    <input type="color" value={color3d} onChange={e => setColor3d(e.target.value)} style={s.colorSwatch} />
                    <span style={{ fontSize: 12, color: '#6B8C74', fontWeight: 600 }}>{color3d}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div>
                    <label style={s.label}>Roughness</label>
                    <div style={s.sliderRow}>
                      <span style={{ ...s.sliderVal, color: '#aaa', fontSize: 11 }}>Smooth</span>
                      <input type="range" min={0} max={1} step={0.01} value={roughness} onChange={e => setRoughness(+e.target.value)} style={s.slider} />
                      <span style={{ ...s.sliderVal, color: '#aaa', fontSize: 11 }}>Rough</span>
                      <span style={s.sliderVal}>{roughness.toFixed(2)}</span>
                    </div>
                  </div>
                  <div>
                    <label style={s.label}>Metalness</label>
                    <div style={s.sliderRow}>
                      <span style={{ ...s.sliderVal, color: '#aaa', fontSize: 11 }}>Matte</span>
                      <input type="range" min={0} max={1} step={0.01} value={metalness} onChange={e => setMetalness(+e.target.value)} style={s.slider} />
                      <span style={{ ...s.sliderVal, color: '#aaa', fontSize: 11 }}>Metal</span>
                      <span style={s.sliderVal}>{metalness.toFixed(2)}</span>
                    </div>
                  </div>

                </div>
              </div>
            )}

            {/* Name */}
            <div style={s.section}>
              <label style={s.label}>Element Name</label>
              <input style={s.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Pink Star" />
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
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#2C4433' }}>
                          {z.replace(/_/g, ' ')}
                        </span>
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

                {/* Density scatter — packed instances controlled by a density slider in the
                    designer (sprinkles, pearls). Config-driven (placement_config.scatter); inherent
                    for the scattered_decor type. Pair with a small shape (e.g. Sphere) + Hug. */}
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: effectiveCanScatter && isScatterType ? 'default' : 'pointer', marginTop: 12, background: '#F4F8F5', borderRadius: 8, padding: '10px 12px' }}>
                  <input
                    type="checkbox"
                    style={{ width: 18, height: 18, accentColor: '#3D5A44', cursor: 'pointer', marginTop: 1, flexShrink: 0 }}
                    checked={effectiveCanScatter}
                    disabled={isScatterType}
                    onChange={e => setCanScatter(e.target.checked)}
                  />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#2C4433' }}>Can scatter (density){isScatterType ? ' — inherent to this type' : ''}</div>
                    <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 1 }}>
                      Drops many packed instances managed by a density slider (sprinkles, pearls). For gold sprinkles: pick Sphere, set zones to Hug, and turn this on.
                    </div>
                  </div>
                </label>
              </div>
            )}
          </div>

          {/* Capabilities */}
          <div style={s.section}>
            <div style={s.sectionTitle}>Capabilities</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { key: 'resize',    label: 'Resizable',        hint: '＋/− size buttons in edit strip' },
                { key: 'duplicate', label: 'Duplicatable',     hint: 'Copy button creates another instance with same size and color' },
                { key: 'color',     label: 'Color changeable', hint: 'Color picker in designer (3D only)' },
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

          {/* ── Right: preview + save ── */}
          <div style={s.card}>
            <div style={s.sectionTitle}>Preview</div>

            {assetType === '2D' ? (
              <div style={s.previewWrap}>
                <canvas
                  ref={canvas2dRef}
                  width={CANVAS_SIZE}
                  height={CANVAS_SIZE}
                  style={{ borderRadius: 12, display: 'block', width: 260, height: 260 }}
                />
              </div>
            ) : (
              <div style={{ marginBottom: 20 }}>
                {/* Cream-wave finish controls live here, directly above the preview, so tuning the
                    surface needs no scrolling between the sliders and the rendered result. */}
                {shape3d === 'creamcake' && (
                  <div style={{ marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={s.sectionTitle}>Cream Wave (baked normal map)</div>
                    {[
                      { key: 'depth',  label: 'Depth',      min: 0,  max: 3,  step: 0.05, fmt: v => v.toFixed(2) },
                    ].map(({ key, label, min, max, step, fmt }) => (
                      <div key={key}>
                        <label style={s.label}>{label}</label>
                        <div style={s.sliderRow}>
                          <input type="range" min={min} max={max} step={step} value={cream[key]}
                            onChange={e => setCream(c => ({ ...c, [key]: +e.target.value }))} style={s.slider} />
                          <span style={s.sliderVal}>{fmt(cream[key])}</span>
                        </div>
                      </div>
                    ))}
                    <button
                      onClick={() => setCream(CREAM_DEFAULTS)}
                      style={{ alignSelf: 'flex-start', padding: '6px 12px', borderRadius: 6, border: '1.5px solid #C5D4C8', background: '#fff', color: '#6B8C74', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                      Reset
                    </button>
                  </div>
                )}

                {shape3d === 'creamwaveproc' && (
                  <div style={{ marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={s.sectionTitle}>Cream Wave (procedural)</div>
                    {[
                      { key: 'density',    label: 'Density (bands)',  min: 2,    max: 24,   step: 1,     fmt: v => v },
                      { key: 'lobes',      label: 'Waves around',     min: 1,    max: 6,    step: 1,     fmt: v => v },
                      { key: 'wave',       label: 'Wave amount',      min: 0,    max: 1,    step: 0.05,  fmt: v => v.toFixed(2) },
                      { key: 'interleave', label: 'Interleave',       min: 0,    max: 1,    step: 0.05,  fmt: v => v.toFixed(2) },
                      { key: 'lineWidth',  label: 'Line width',       min: 0.04, max: 0.6,  step: 0.01,  fmt: v => v.toFixed(2) },
                      { key: 'relief',     label: 'Relief (depth)',   min: 0,    max: 0.15, step: 0.005, fmt: v => v.toFixed(3) },
                      { key: 'falloff',    label: 'Top falloff',      min: 0,    max: 1,    step: 0.05,  fmt: v => v.toFixed(2) },
                    ].map(({ key, label, min, max, step, fmt }) => (
                      <div key={key}>
                        <label style={s.label}>{label}</label>
                        <div style={s.sliderRow}>
                          <input type="range" min={min} max={max} step={step} value={proc[key]}
                            onChange={e => setProc(p => ({ ...p, [key]: +e.target.value }))} style={s.slider} />
                          <span style={s.sliderVal}>{fmt(proc[key])}</span>
                        </div>
                      </div>
                    ))}
                    <button
                      onClick={() => setProc(PROC_DEFAULTS)}
                      style={{ alignSelf: 'flex-start', padding: '6px 12px', borderRadius: 6, border: '1.5px solid #C5D4C8', background: '#fff', color: '#6B8C74', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                      Reset
                    </button>
                  </div>
                )}

                <Preview3D
                  shapeId={shape3d}
                  color={color3d}
                  roughness={roughness}
                  metalness={metalness}
                  cream={cream}
                  proc={proc}
                  containerRef={preview3dRef}
                  ambientInt={ambientInt}
                  keyInt={keyInt}
                  fillInt={fillInt}
                  envPreset={envPreset}
                />
                <p style={{ fontSize: 11, color: '#9BB5A2', fontWeight: 600, marginTop: 8, textAlign: 'center' }}>
                  Drag to rotate
                </p>

                {/* Lighting controls */}
                <div style={{ marginTop: 16, padding: '14px 16px', background: '#F4F8F5', borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#6B8C74', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 2 }}>Lighting</div>

                  {[
                    { label: 'Ambient',  value: ambientInt, set: setAmbientInt, max: 3 },
                    { label: 'Key',      value: keyInt,     set: setKeyInt,     max: 6 },
                    { label: 'Fill',     value: fillInt,    set: setFillInt,    max: 4 },
                  ].map(({ label, value, set, max }) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#6B8C74', width: 46 }}>{label}</span>
                      <input type="range" min={0} max={max} step={0.05} value={value}
                        onChange={e => set(+e.target.value)} style={{ flex: 1, accentColor: '#3D5A44' }} />
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
              </div>
            )}

            <button style={s.saveBtn(saving)} onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save as Element'}
            </button>

            {msg && <div style={s.msg(msg.ok)}>{msg.text}</div>}
          </div>
        </div>
      </div>
    </>
  );
}
