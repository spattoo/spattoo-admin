import { useState, useRef, useEffect, useMemo, Suspense } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { toCreasedNormals, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { fetchElementTypes, getSignedUploadUrl, uploadToR2, createGlobalElement, removeBg } from '../lib/api.js';

// GLB Studio — import one or more GLBs as "pieces", position them with a gizmo,
// group their meshes into named recolorable PARTS, optimize, and export/save a
// single merged GLB. Each mesh carries userData.part + a scene part-map. Compose
// e.g. a body + a separate horn into one topper, each its own part.

const FINISHES = {
  matte:  { label: 'Matte',    rough: 0.85, metal: 0.0 },
  satin:  { label: 'Satin',    rough: 0.5,  metal: 0.0 },
  glossy: { label: 'Glossy',   rough: 0.25, metal: 0.0 },
  metal:  { label: 'Metallic', rough: 0.2,  metal: 0.9 },
};

const HILITE = new THREE.Color('#3b82f6');
import { ZONE_LIST as ZONES } from '../lib/constants.js';

// Rebuild each mesh's geometry from its pristine copy, applying (1) flatten —
// a relief cut perpendicular to flat.normal (the "front" set from the camera) —
// then (2) smoothing via toCreasedNormals (0 = faceted → 1 = fully smooth). UVs
// are preserved, so a textured model keeps its texture. Fully reversible.
function applyGeometry(root, flat, smooth, flattenSet) {
  root.updateMatrixWorld(true);
  const n = new THREE.Vector3(flat.normal[0], flat.normal[1], flat.normal[2]);
  if (n.lengthSq() === 0) n.set(0, 0, 1);
  n.normalize();
  const v = new THREE.Vector3();
  // only pieces in flattenSet (null = all) take the flatten — lets you flatten
  // the body but leave the horn full 3D.
  const inSet = o => !flattenSet || flattenSet.has(o.userData._piece);
  let min = Infinity, max = -Infinity;
  if (flat.enabled) {
    root.traverse(o => {
      if (!o.isMesh || !o.userData._origGeo || !inSet(o)) return;
      const pos = o.userData._origGeo.attributes.position.array, mw = o.matrixWorld;
      for (let i = 0; i < pos.length; i += 3) {
        const d = v.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(mw).dot(n);
        if (d < min) min = d; if (d > max) max = d;
      }
    });
  }
  const range = (max - min) || 1;
  const plane = min + flat.amount * range;
  const creaseAngle = Math.max(0, Math.min(1, smooth)) * Math.PI;
  root.traverse(o => {
    if (!o.isMesh || !o.userData._origGeo) return;
    const g = o.userData._origGeo.clone();
    if (flat.enabled && inSet(o)) {
      const mw = o.matrixWorld, inv = new THREE.Matrix4().copy(mw).invert();
      const pos = g.attributes.position.array;
      for (let i = 0; i < pos.length; i += 3) {
        v.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(mw);
        const d = v.dot(n);
        if (d < plane) v.addScaledVector(n, plane - d);
        v.applyMatrix4(inv);
        pos[i] = v.x; pos[i + 1] = v.y; pos[i + 2] = v.z;
      }
      g.attributes.position.needsUpdate = true;
    }
    const sg = toCreasedNormals(g, creaseAngle); // preserves uv (toNonIndexed)
    sg.computeBoundingBox();
    sg.computeBoundingSphere();
    if (o.geometry && o.geometry !== o.userData._origGeo) o.geometry.dispose();
    o.geometry = sg;
  });
}

let _loader = null;
function loader() {
  if (!_loader) _loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  return _loader;
}

function hexOf(mat) {
  const m = Array.isArray(mat) ? mat[0] : mat;
  return m && m.color ? `#${m.color.getHexString()}` : '#cccccc';
}
function hasTex(mat) {
  const m = Array.isArray(mat) ? mat[0] : mat;
  return !!(m && (m.map || m.normalMap || m.roughnessMap || m.emissiveMap));
}
function triCount(geo) {
  if (!geo) return 0;
  return geo.index ? geo.index.count / 3 : (geo.attributes.position?.count || 0) / 3;
}
function findPieceObj(root, id) {
  if (!root || !id) return null;
  let found = null;
  root.children.forEach(c => { if (c.userData._piece === id) found = c; });
  return found;
}

// Apply each part's color/finish to its meshes. selectedKey adds a highlight.
function applyMaterials(root, assign, parts, selectedKey, keepOriginal) {
  const byId = Object.fromEntries(parts.map(p => [p.id, p]));
  root.traverse(o => {
    if (!o.isMesh) return;
    const key = o.userData._key;
    if (keepOriginal) {
      const part = byId[assign[key]];
      const orig = o.userData._origMat;
      let mat = orig;
      const isSel = selectedKey && key === selectedKey;
      // keep the imported material as-is (preserves a baked/metallic finish on
      // re-import) UNLESS the user explicitly set a Finish on the part.
      const applyFinish = part && part.finishSet;
      if (!Array.isArray(orig) && (applyFinish || isSel)) {
        mat = orig.clone();
        if (applyFinish) { const f = FINISHES[part.finish] || FINISHES.matte; mat.metalness = f.metal; mat.roughness = f.rough; }
        if (isSel) { mat.emissive = HILITE.clone(); mat.emissiveIntensity = 0.6; }
      }
      o.material = mat;
      o.userData.part = assign[key];
      return;
    }
    const part = byId[assign[key]];
    if (!part) return;
    const f = FINISHES[part.finish] || FINISHES.matte;
    const mat = new THREE.MeshStandardMaterial({ color: part.color, roughness: f.rough, metalness: f.metal });
    if (selectedKey && key === selectedKey) { mat.emissive = HILITE.clone(); mat.emissiveIntensity = 0.6; }
    o.material = mat;
    o.userData.part = part.id;
  });
}

function compactGeometry(geo, newIndex) {
  const used = new Map(), order = [];
  for (let i = 0; i < newIndex.length; i++) {
    const id = newIndex[i];
    if (!used.has(id)) { used.set(id, order.length); order.push(id); }
  }
  const remapped = new Uint32Array(newIndex.length);
  for (let i = 0; i < newIndex.length; i++) remapped[i] = used.get(newIndex[i]);
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'uv', 'normal', 'color']) {
    const attr = geo.attributes[name];
    if (!attr) continue;
    const is = attr.itemSize, src = attr.array, dst = new Float32Array(order.length * is);
    for (let i = 0; i < order.length; i++) {
      const o = order[i] * is;
      for (let k = 0; k < is; k++) dst[i * is + k] = src[o + k];
    }
    out.setAttribute(name, new THREE.BufferAttribute(dst, is));
  }
  out.setIndex(new THREE.BufferAttribute(remapped, 1));
  return out;
}

function resizeTextures(root, maxSize, pieceId) {
  const seen = new Set();
  root.traverse(o => {
    if (!o.isMesh) return;
    if (pieceId && o.userData._piece !== pieceId) return;
    const mats = Array.isArray(o.userData._origMat) ? o.userData._origMat : [o.userData._origMat];
    mats.forEach(m => {
      if (!m) return;
      ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'].forEach(slot => {
        const tex = m[slot];
        if (!tex || !tex.image || seen.has(tex)) return;
        seen.add(tex);
        const img = tex.image, w = img.width, h = img.height;
        if (!w || !h) return;
        const scale = Math.min(1, maxSize / Math.max(w, h));
        if (scale >= 1) return;
        const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
        tex.image = canvas;
        tex.needsUpdate = true;
      });
    });
  });
}

function forceJpegTextures(root) {
  const seen = new Set();
  root.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(m => {
      if (!m) return;
      ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'].forEach(slot => {
        const t = m[slot];
        if (t && !seen.has(t)) { seen.add(t); t.userData.mimeType = 'image/jpeg'; }
      });
    });
  });
}

// A blue bounding box around the selected piece that tracks it as it moves.
function SelectionBox({ object }) {
  const helper = useMemo(() => {
    if (!object) return null;
    const h = new THREE.BoxHelper(object, new THREE.Color('#2563eb'));
    h.material.depthTest = false;
    h.material.transparent = true;
    return h;
  }, [object]);
  useFrame(() => { if (helper) helper.update(); });
  useEffect(() => () => { helper && helper.geometry.dispose(); }, [helper]);
  if (!helper) return null;
  return <primitive object={helper} renderOrder={999} />;
}

// Default cake matching spattoo-core (constants.js): TIER_RADII, BOTTOM_H 1.45,
// TIER_HEIGHT_STEP 0.08, board top at y 0.1. Duplicated here on purpose — the
// studio is a stand-alone simulator and can't depend on spattoo-core at runtime.
const TIER_RADII = [1.2, 0.9, 0.65, 0.45];
const BOTTOM_H = 1.45, TIER_STEP = 0.08, BOARD_H = 0.1, BOARD_R = 1.6;

function tierGeom(count) {
  const arr = []; let yBase = BOARD_H;
  for (let i = 0; i < Math.min(count, TIER_RADII.length); i++) {
    const height = BOTTOM_H - i * TIER_STEP;
    const topY = yBase + height;
    arr.push({ radius: TIER_RADII[i], yBase, height, topY, midY: yBase + height / 2 });
    yBase = topY;
  }
  return arr;
}

function CakeMesh({ tiers }) {
  return (
    <group>
      <mesh position={[0, BOARD_H / 2, 0]}>
        <cylinderGeometry args={[BOARD_R, BOARD_R, BOARD_H, 72]} />
        <meshStandardMaterial color="#cdb38b" roughness={0.95} metalness={0} />
      </mesh>
      {tiers.map((t, i) => (
        <mesh key={i} position={[0, t.yBase + t.height / 2, 0]}>
          <cylinderGeometry args={[t.radius, t.radius, t.height, 72]} />
          <meshStandardMaterial color="#fbf3e8" roughness={0.85} metalness={0} />
        </mesh>
      ))}
    </group>
  );
}

// Topper bounding box in ROOT-LOCAL space — independent of the cake-display
// wrapper transform, so placement scaling can't feed back on itself.
function localBox(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const box = new THREE.Box3(), m = new THREE.Matrix4();
  root.traverse(o => {
    if (!o.isMesh) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    m.multiplyMatrices(inv, o.matrixWorld);
    box.union(o.geometry.boundingBox.clone().applyMatrix4(m));
  });
  return box;
}

// Wrap the topper around a cylinder of radius R so it hugs the tier wall.
// `normal` (= the "front" the user set) is the OUTWARD direction. Flat-tagged
// pieces (flattenSet) are AUTO-FLATTENED: their back collapses onto the wall
// plane so they seat flush; non-flat pieces (e.g. the horn) stay round and poke
// out. Width wraps as arc length (smaller tier ⇒ more curve), world-up = height.
const SIDE_FLAT_AMOUNT = 0.45; // fraction of body depth pressed onto the wall
function buildBentTopper(root, R, scale, normal, flattenSet, smooth) {
  root.updateMatrixWorld(true);
  const invM = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const n = new THREE.Vector3(normal[0], normal[1], normal[2]);
  if (n.lengthSq() === 0) n.set(0, 0, 1);
  n.normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(up, n);   // horizontal wrap axis
  if (u.lengthSq() < 1e-6) u.set(1, 0, 0);
  u.normalize();
  const v = new THREE.Vector3(), m = new THREE.Matrix4();
  const isFlatMesh = o => !flattenSet || flattenSet.has(o.userData._piece);
  // pass 1 — extents along u/y (all), and n-extent of the flat-tagged body
  let minU = Infinity, maxU = -Infinity, minY = Infinity, maxY = -Infinity;
  let gMinN = Infinity, bMinN = Infinity, bMaxN = -Infinity;
  root.traverse(o => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position, flat = isFlatMesh(o);
    m.multiplyMatrices(invM, o.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      const uu = v.dot(u), nn = v.dot(n);
      if (uu < minU) minU = uu; if (uu > maxU) maxU = uu;
      if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
      if (nn < gMinN) gMinN = nn;
      if (flat) { if (nn < bMinN) bMinN = nn; if (nn > bMaxN) bMaxN = nn; }
    }
  });
  const cU = (minU + maxU) / 2, cY = (minY + maxY) / 2;
  const hasFlat = isFinite(bMinN);
  // the wall plane: where the flattened body back sits (or the rearmost point)
  const wallN = hasFlat ? bMinN + SIDE_FLAT_AMOUNT * (bMaxN - bMinN) : gMinN;
  const g = new THREE.Group();
  root.traverse(o => {
    if (!o.isMesh) return;
    const geo = o.geometry.clone();
    const pos = geo.attributes.position, flat = isFlatMesh(o);
    m.multiplyMatrices(invM, o.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      let nVal = v.dot(n);
      if (flat && nVal < wallN) nVal = wallN;          // press body back onto the wall
      const d = Math.max(0, (nVal - wallN)) * scale;    // depth out from the wall
      const w = (v.dot(u) - cU) * scale, hgt = (v.y - cY) * scale;
      const theta = w / R, rad = R + d;
      pos.setXYZ(i, rad * Math.sin(theta), hgt, rad * Math.cos(theta));
    }
    pos.needsUpdate = true;
    // smooth shading on the bent surface (computeVertexNormals on non-indexed
    // geometry would be flat/faceted; toCreasedNormals smooths by position)
    const sg = toCreasedNormals(geo, Math.max(0, Math.min(1, smooth ?? 0.8)) * Math.PI);
    g.add(new THREE.Mesh(sg, o.material));
  });
  return g;
}

// Inner scene. Pieces are moved via the docked panel (not an in-scene gizmo),
// so orbit never fights with positioning. Click a mesh to select its piece. In
// cake mode the topper is wrapped in a display group (scaled onto the cake) —
// the wrapper is NOT part of `root`, so export stays clean.
function Stage({ root, selectedObj, onPickPiece, showCake, placement, ambientInt, keyInt, fillInt, envPreset }) {
  const pick = e => { e.stopPropagation(); const pid = e.object?.userData?._piece; if (pid && onPickPiece) onPickPiece(pid); };
  const cake = showCake && placement;
  const sideMode = cake && placement.mode === 'side';
  return (
    <>
      <ambientLight intensity={ambientInt} />
      <directionalLight position={[4, 6, 4]} intensity={keyInt} />
      <directionalLight position={[-3, 2, -2]} intensity={fillInt} />
      {envPreset !== 'none' && <Environment preset={envPreset} />}
      <Suspense fallback={null}>
        {root && (cake ? (
          <group position={[0, -placement.focusY, 0]}>
            <CakeMesh tiers={placement.tiers} />
            {placement.mode === 'side'
              ? <primitive object={placement.sideGroup} position={[0, placement.tier.midY, 0]} />
              : (
                <group scale={placement.scale} position={[0, placement.posY, 0]}>
                  <primitive object={root} onClick={pick} />
                </group>
              )}
          </group>
        ) : (
          <primitive object={root} onClick={pick} />
        ))}
      </Suspense>
      {selectedObj && !sideMode && <SelectionBox object={selectedObj} />}
      <OrbitControls />
    </>
  );
}

function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }

// Bake the base-color texture into per-vertex colors (sampling at each vertex's
// UV), then drop the texture. Vertex colors blend smoothly under decimation —
// unlike Meshy's fragmented UV atlas, which shatters. Returns # meshes baked.
function bakeVertexColors(root, pieceId) {
  let baked = 0;
  root.traverse(o => {
    if (!o.isMesh || !o.userData._origGeo) return;
    if (pieceId && o.userData._piece !== pieceId) return;
    const geo = o.userData._origGeo;
    const uv = geo.attributes.uv;
    const mat0 = Array.isArray(o.userData._origMat) ? o.userData._origMat[0] : o.userData._origMat;
    const tex = mat0 && mat0.map;
    if (!uv || !tex || !tex.image) return;
    const img = tex.image, cw = img.width || img.videoWidth, ch = img.height || img.videoHeight;
    if (!cw || !ch) return;
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, cw, ch);
    const data = ctx.getImageData(0, 0, cw, ch).data;
    const count = geo.attributes.position.count;
    const colors = new Float32Array(count * 3);
    const flipY = tex.flipY !== false;
    for (let i = 0; i < count; i++) {
      let u = uv.getX(i), w = uv.getY(i);
      u -= Math.floor(u); w -= Math.floor(w);
      const px = Math.min(cw - 1, Math.max(0, Math.round(u * (cw - 1))));
      const wy = flipY ? 1 - w : w;
      const py = Math.min(ch - 1, Math.max(0, Math.round(wy * (ch - 1))));
      const idx = (py * cw + px) * 4;
      colors[i * 3]     = srgbToLinear(data[idx]     / 255);
      colors[i * 3 + 1] = srgbToLinear(data[idx + 1] / 255);
      colors[i * 3 + 2] = srgbToLinear(data[idx + 2] / 255);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // Average the metallic-roughness map (glTF: G=roughness, B=metalness) over
    // this material's vertices, so a metallic horn stays metallic and a matte
    // body stays matte — automatically, per material. Default matte if no map.
    let avgMetal = 0, avgRough = 0.7;
    const mrTex = mat0.metalnessMap || mat0.roughnessMap;
    if (mrTex && mrTex.image) {
      const mi = mrTex.image, mw = mi.width || mi.videoWidth, mh = mi.height || mi.videoHeight;
      if (mw && mh) {
        const c2 = document.createElement('canvas');
        c2.width = mw; c2.height = mh;
        const x2 = c2.getContext('2d', { willReadFrequently: true });
        x2.drawImage(mi, 0, 0, mw, mh);
        const d2 = x2.getImageData(0, 0, mw, mh).data;
        const fY = mrTex.flipY !== false;
        let sm = 0, sr = 0;
        for (let i = 0; i < count; i++) {
          let u = uv.getX(i), w = uv.getY(i); u -= Math.floor(u); w -= Math.floor(w);
          const px = Math.min(mw - 1, Math.max(0, Math.round(u * (mw - 1))));
          const wy = fY ? 1 - w : w;
          const py = Math.min(mh - 1, Math.max(0, Math.round(wy * (mh - 1))));
          const idx = (py * mw + px) * 4;
          sr += d2[idx + 1] / 255; // green = roughness
          sm += d2[idx + 2] / 255; // blue  = metalness
        }
        avgRough = sr / count; avgMetal = sm / count;
      }
    }
    geo.deleteAttribute('uv'); // UVs are dead weight once color is baked in
    const mats = Array.isArray(o.userData._origMat) ? o.userData._origMat : [o.userData._origMat];
    mats.forEach(m => {
      if (!m) return;
      m.map = m.normalMap = m.roughnessMap = m.metalnessMap = m.emissiveMap = m.aoMap = null;
      m.vertexColors = true;
      if (m.color) m.color.setRGB(1, 1, 1);
      m.metalness = avgMetal;
      m.roughness = avgRough;
      if (m.emissive) m.emissive.setRGB(0, 0, 0);
      m.needsUpdate = true;
    });
    baked++;
  });
  return baked;
}

function ModelView({ root, selectedObj, onPickPiece, showCake, placement, ambientInt, keyInt, fillInt, envPreset, containerRef, onReady, height = 360 }) {
  return (
    <div ref={containerRef} style={{ height, borderRadius: 12, overflow: 'hidden', background: '#E8EDE9' }}>
      <Canvas gl={{ preserveDrawingBuffer: true, alpha: true }} camera={{ position: [0, 0.5, 3], fov: 40 }}>
        <Stage root={root} selectedObj={selectedObj} onPickPiece={onPickPiece} showCake={showCake} placement={placement}
          ambientInt={ambientInt} keyInt={keyInt} fillInt={fillInt} envPreset={envPreset} />
        <CameraRelay onReady={onReady} />
      </Canvas>
    </div>
  );
}

// Hand the live camera back to the parent for "Set front from view".
function CameraRelay({ onReady }) {
  const cam = useThree(s => s.camera);
  useEffect(() => { if (onReady) onReady(cam); }, [cam, onReady]);
  return null;
}

export default function GlbStudio() {
  const [root, setRoot]     = useState(null);   // live THREE container (pieces are children)
  const [pieces, setPieces] = useState([]);     // [{id,name,meshKeys}]
  const [meshes, setMeshes] = useState([]);     // [{key,name,tris,hasTexture,origColor,piece}]
  const [parts, setParts]   = useState([]);     // [{id,label,color,finish}]
  const [assign, setAssign] = useState({});     // meshKey -> partId
  const [selectedKey, setSelectedKey]   = useState(null);  // mesh highlight
  const [selectedPiece, setSelectedPiece] = useState(null); // transform target
  const [xf, setXf] = useState({ px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, sc: 1 });
  const [error, setError]   = useState(null);
  const [busy, setBusy]     = useState(false);
  const [flat, setFlat]     = useState({ enabled: false, amount: 0.35, normal: [0, 0, 1], frontSet: false });
  const [smooth, setSmooth] = useState(0.8);
  const [keepOriginal, setKeepOriginal] = useState(false);
  const [opt, setOpt]       = useState({ targetTris: 20000 });
  const [optScope, setOptScope] = useState('all'); // 'all' | 'selected'
  const [optMsg, setOptMsg] = useState(null);

  // Save-as-element form
  const [elementTypes, setElementTypes]   = useState([]);
  const [elementTypeId, setElementTypeId] = useState('');
  const [name, setName]                   = useState('');
  const [zones, setZones]                 = useState(['top_surface', 'side', 'middle_tier']);
  const [placementConfig, setPlacementConfig] = useState({});
  const [capabilities, setCapabilities] = useState({ resize: true, duplicate: true, color: false, delete: true, move: false, tilt: false });
  const [saveMsg, setSaveMsg]             = useState(null);

  const [showCake, setShowCake]   = useState(false);
  const [topperSize, setTopperSize] = useState(1.0); // scale multiplier vs tier-fit
  const [tierCount, setTierCount] = useState(1);
  const [placeTier, setPlaceTier] = useState(0);
  const [placeMode, setPlaceMode] = useState('top'); // 'top' | 'side'
  const [ambientInt, setAmbientInt] = useState(0.5);
  const bentRef = useRef(null);
  const [keyInt, setKeyInt]         = useState(2.2);
  const [fillInt, setFillInt]       = useState(0.9);
  const [envPreset, setEnvPreset]   = useState('studio');

  const previewRef = useRef(null);
  const cameraRef  = useRef(null);
  const sceneRef   = useRef(null);   // the THREE container (synchronous, race-free)
  const partSeq  = useRef(0);
  const meshSeq  = useRef(0);
  const pieceSeq = useRef(0);

  function setFront() {
    const cam = cameraRef.current;
    if (!cam) return;
    const dir = cam.getWorldDirection(new THREE.Vector3()).negate().normalize();
    setFlat(f => ({ ...f, normal: [dir.x, dir.y, dir.z], frontSet: true, enabled: true }));
  }

  // Load the selected piece's transform into the panel.
  useEffect(() => {
    const obj = findPieceObj(sceneRef.current, selectedPiece);
    if (!obj) { setXf({ px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, sc: 1 }); return; }
    setXf({
      px: obj.position.x, py: obj.position.y, pz: obj.position.z,
      rx: THREE.MathUtils.radToDeg(obj.rotation.x),
      ry: THREE.MathUtils.radToDeg(obj.rotation.y),
      rz: THREE.MathUtils.radToDeg(obj.rotation.z),
      sc: obj.scale.x,
    });
    // eslint-disable-next-line
  }, [selectedPiece]);

  // Write a transform change straight onto the selected piece.
  function applyXf(patch) {
    setXf(prev => {
      const n = { ...prev, ...patch };
      const obj = findPieceObj(sceneRef.current, selectedPiece);
      if (obj) {
        obj.position.set(n.px, n.py, n.pz);
        obj.rotation.set(THREE.MathUtils.degToRad(n.rx), THREE.MathUtils.degToRad(n.ry), THREE.MathUtils.degToRad(n.rz));
        obj.scale.setScalar(n.sc);
      }
      return n;
    });
  }

  useEffect(() => {
    if (root) applyMaterials(root, assign, parts, selectedKey, keepOriginal);
  }, [root, assign, parts, selectedKey, keepOriginal]);

  useEffect(() => {
    if (root) applyGeometry(root, flat, smooth, new Set(pieces.filter(p => p.flatten !== false).map(p => p.id)));
  }, [root, flat, smooth, pieces]);

  useEffect(() => {
    fetchElementTypes().then(t => { setElementTypes(t); if (t.length) setElementTypeId(t[0].id); }).catch(() => {});
  }, []);

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

  // Add a GLB as a new piece (additive). The first piece normalizes the whole
  // scene to ~2 units; later pieces come in at native scale to be positioned.
  async function addPiece(file) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const url = URL.createObjectURL(file);
      const gltf = await loader().loadAsync(url);
      URL.revokeObjectURL(url);

      const scene = gltf.scene;
      const pieceId = `pc${pieceSeq.current++}`;
      scene.userData._piece = pieceId;

      // center each piece at origin (in its own space) so it starts on top of
      // the others; spread pieces apart with the transform panel.
      const box = new THREE.Box3().setFromObject(scene);
      const size = new THREE.Vector3(); box.getSize(size);
      const center = new THREE.Vector3(); box.getCenter(center);
      scene.position.sub(center);

      const firstPiece = !sceneRef.current;
      if (firstPiece) sceneRef.current = new THREE.Group();
      const container = sceneRef.current;
      container.add(scene);
      if (firstPiece) container.scale.setScalar(2 / (Math.max(size.x, size.y, size.z) || 1));

      const newList = [];
      scene.traverse(o => {
        if (!o.isMesh) return;
        o.userData._origGeo = o.geometry.clone();
        o.userData._origMat = o.material;
        o.userData._key = `m${meshSeq.current++}`;
        o.userData._piece = pieceId;
        newList.push({
          key: o.userData._key,
          name: o.name || `Mesh ${o.userData._key}`,
          tris: Math.round(triCount(o.geometry)),
          hasTexture: hasTex(o.material),
          origColor: hexOf(o.material),
          piece: pieceId,
        });
      });

      const base = file.name.replace(/\.(glb|gltf)$/i, '').replace(/[-_]/g, ' ').trim();
      // one part PER MESH — so a merged file (body + horn) still splits into
      // separate parts you can finish independently (e.g. horn → Metallic).
      const newParts = newList.map((m, i) => ({
        id: `p${partSeq.current++}`,
        label: newList.length > 1 ? `${base || 'Part'} · ${i + 1}` : (base || m.name),
        color: (!m.origColor || m.origColor === '#ffffff') ? '#f2f2f2' : m.origColor,
        finish: 'matte',
      }));

      setRoot(container);
      setPieces(prev => [...prev, { id: pieceId, name: base || file.name, meshKeys: newList.map(m => m.key) }]);
      setMeshes(prev => [...prev, ...newList]);
      setParts(prev => [...prev, ...newParts]);
      setAssign(prev => { const next = { ...prev }; newList.forEach((m, i) => { next[m.key] = newParts[i].id; }); return next; });
      setKeepOriginal(k => k || newList.some(m => m.hasTexture));
      setSelectedPiece(pieceId);
      setName(n => n || base);

      applyGeometry(container, flat, smooth);
    } catch (e) {
      setError(`Couldn't load GLB: ${e.message}. If it's Draco-compressed, re-export uncompressed.`);
    } finally {
      setBusy(false);
    }
  }

  function removePiece(id) {
    const container = sceneRef.current;
    if (!container) return;
    const child = findPieceObj(container, id);
    if (child) {
      child.traverse(o => { if (o.isMesh) o.geometry?.dispose?.(); });
      container.remove(child);
    }
    const piece = pieces.find(p => p.id === id);
    const keys = piece ? piece.meshKeys : [];
    setMeshes(prev => prev.filter(m => !keys.includes(m.key)));
    setAssign(prev => { const n = { ...prev }; keys.forEach(k => delete n[k]); return n; });
    setPieces(prev => prev.filter(p => p.id !== id));
    if (selectedPiece === id) setSelectedPiece(null);

    const remaining = container.children.filter(c => c.userData._piece);
    if (remaining.length === 0) clearAll();
    else applyGeometry(container, flat, smooth);
  }

  function clearAll() {
    sceneRef.current = null;
    setRoot(null); setPieces([]); setMeshes([]); setParts([]); setAssign({});
    setSelectedPiece(null); setSelectedKey(null); setOptMsg(null);
    partSeq.current = 0;
  }

  function togglePieceFlatten(id) {
    setPieces(prev => prev.map(p => p.id === id ? { ...p, flatten: p.flatten === false ? true : false } : p));
  }

  function updatePart(id, patch) { setParts(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p)); }
  function addPart() {
    const id = `p${partSeq.current++}`;
    setParts(prev => [...prev, { id, label: `Part ${prev.length + 1}`, color: '#cccccc', finish: 'matte' }]);
  }
  function removePart(id) {
    if (Object.values(assign).includes(id)) return;
    setParts(prev => prev.filter(p => p.id !== id));
  }
  function assignMesh(meshKey, partId) { setAssign(prev => ({ ...prev, [meshKey]: partId })); }
  function meshCountFor(partId) { return Object.values(assign).filter(p => p === partId).length; }

  async function buildGLBBuffer() {
    applyMaterials(root, assign, parts, null, keepOriginal);
    root.userData.parts = parts
      .filter(p => meshCountFor(p.id) > 0)
      .map(p => ({ id: p.id, label: p.label, default: p.color, finish: p.finish }));
    const restore = [];
    const udSaved = [];
    root.traverse(o => {
      if (o.isMesh) { restore.push([o, o.geometry]); try { o.geometry = mergeVertices(o.geometry); } catch { /* leave as-is */ } }
      // strip our heavy internal userData (_origGeo is a whole geometry clone!)
      // so GLTFExporter doesn't serialize it into the glTF JSON `extras`.
      if (o.userData) {
        const saved = {};
        for (const k of ['_origGeo', '_origMat', '_key', '_piece']) {
          if (k in o.userData) { saved[k] = o.userData[k]; delete o.userData[k]; }
        }
        if (Object.keys(saved).length) udSaved.push([o, saved]);
      }
    });
    forceJpegTextures(root);
    try {
      return await new Promise((res, rej) =>
        new GLTFExporter().parse(root, res, rej, { binary: true, includeCustomExtensions: true }));
    } finally {
      udSaved.forEach(([o, saved]) => Object.assign(o.userData, saved));
      restore.forEach(([o, g]) => { if (o.geometry !== g) o.geometry.dispose?.(); o.geometry = g; });
      applyMaterials(root, assign, parts, selectedKey, keepOriginal);
    }
  }

  async function exportGLB() {
    if (!root) return;
    setBusy(true); setError(null);
    try {
      const buffer = await buildGLBBuffer();
      const blob = new Blob([buffer], { type: 'model/gltf-binary' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (name.trim() ? name.trim().replace(/\s+/g, '-') : 'model') + '.glb';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(`Export failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function optimize() {
    if (!root) return;
    const pieceId = (optScope === 'selected' && selectedPiece) ? selectedPiece : null;
    setBusy(true); setOptMsg(null);
    try {
      await MeshoptSimplifier.ready;
      // bake texture → vertex colors FIRST so decimation blends colors instead
      // of shattering the fragmented UV atlas.
      const baked = bakeVertexColors(root, pieceId);
      // distribute the absolute triangle budget across in-scope meshes by size
      let scopeTotal = 0;
      root.traverse(o => {
        if (!o.isMesh || !o.userData._origGeo) return;
        if (pieceId && o.userData._piece !== pieceId) return;
        const g = o.userData._origGeo;
        scopeTotal += (g.index ? g.index.count : g.attributes.position.count) / 3;
      });
      scopeTotal = Math.max(1, scopeTotal);
      let before = 0, after = 0;
      root.traverse(o => {
        if (!o.isMesh || !o.userData._origGeo) return;
        if (pieceId && o.userData._piece !== pieceId) return;
        let geo = o.userData._origGeo;
        if (!geo.index) geo = mergeVertices(geo);
        const index = geo.index.array instanceof Uint32Array ? geo.index.array.slice() : new Uint32Array(geo.index.array);
        const positions = geo.attributes.position.array;
        const tris = index.length / 3;
        before += tris;
        const targetTris = Math.min(tris, Math.max(150, Math.round(opt.targetTris * tris / scopeTotal)));
        const targetIndexCount = targetTris * 3;
        let simpIndex;
        if (geo.attributes.color) {
          [simpIndex] = MeshoptSimplifier.simplifyWithAttributes(
            index, positions, 3, geo.attributes.color.array, 3, [6, 6, 6], null,
            targetIndexCount, 0.5, ['LockBorder']); // high color weight keeps eyes/lashes/mane edges crisp
        } else if (geo.attributes.uv) {
          [simpIndex] = MeshoptSimplifier.simplifyWithAttributes(
            index, positions, 3, geo.attributes.uv.array, 2, [1, 1], null,
            targetIndexCount, 0.5, ['LockBorder']);
        } else {
          [simpIndex] = MeshoptSimplifier.simplify(index, positions, 3, targetIndexCount, 0.5);
        }
        o.userData._origGeo = compactGeometry(geo, simpIndex);
        after += simpIndex.length / 3;
      });
      // any meshes that weren't baked (no texture) → matte, drop extra maps
      const seenMat = new Set();
      root.traverse(o => {
        if (!o.isMesh) return;
        if (pieceId && o.userData._piece !== pieceId) return;
        const mats = Array.isArray(o.userData._origMat) ? o.userData._origMat : [o.userData._origMat];
        mats.forEach(m => {
          if (!m || seenMat.has(m) || m.vertexColors) return; // baked materials already set their finish
          seenMat.add(m);
          ['normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'].forEach(slot => { if (m[slot]) m[slot] = null; });
          m.metalness = 0; m.roughness = 0.7;
          if (m.emissive) m.emissive.setRGB(0, 0, 0);
          m.needsUpdate = true;
        });
      });
      const counts = {};
      root.traverse(o => {
        if (o.isMesh && o.userData._key) {
          const g = o.userData._origGeo;
          counts[o.userData._key] = (g.index ? g.index.count : g.attributes.position.count) / 3;
        }
      });
      setMeshes(ms => ms.map(m => ({ ...m, tris: Math.round(counts[m.key] ?? m.tris) })));
      applyGeometry(root, flat, smooth, new Set(pieces.filter(p => p.flatten !== false).map(p => p.id)));
      setOptMsg({ ok: true, text: `${Math.round(before).toLocaleString()} → ${Math.round(after).toLocaleString()} tris${baked ? ' · color baked to vertices' : ''}${pieceId ? ' · this piece' : ''}` });
    } catch (e) {
      setOptMsg({ ok: false, text: `Optimize failed: ${e.message}` });
    } finally {
      setBusy(false);
    }
  }

  function toggleZone(z) {
    setZones(prev => {
      if (!prev.includes(z)) {
        const type = elementTypes.find(t => t.id === elementTypeId);
        const dm = type?.placement_rules?.placement?.[z] ?? 'stand';
        setPlacementConfig(pc => ({ ...pc, [z]: dm }));
        return [...prev, z];
      }
      return prev.filter(x => x !== z);
    });
  }
  function setZonePlacement(z, mode) { setPlacementConfig(prev => ({ ...prev, [z]: mode })); }

  async function handleSaveElement() {
    if (!root)          return setSaveMsg({ ok: false, text: 'Import a GLB first' });
    if (!name.trim())   return setSaveMsg({ ok: false, text: 'Enter a name' });
    if (!elementTypeId) return setSaveMsg({ ok: false, text: 'Select an element type' });
    if (!zones.length)  return setSaveMsg({ ok: false, text: 'Select at least one zone' });
    setBusy(true); setSaveMsg(null);
    try {
      const glCanvas = previewRef.current?.querySelector('canvas');
      if (!glCanvas) throw new Error('Preview not ready — try again');
      const rawThumb = await new Promise(r => glCanvas.toBlob(r, 'image/png'));
      let thumbBlob = rawThumb;
      try { thumbBlob = await removeBg(rawThumb); } catch (e) { console.warn('remove.bg failed:', e.message); }

      const buffer = await buildGLBBuffer();
      const glbBlob = new Blob([buffer], { type: 'model/gltf-binary' });
      const { url: fu, key: fk } = await getSignedUploadUrl('elements/files/3D', `${crypto.randomUUID()}.glb`, 'model/gltf-binary');
      await uploadToR2(fu, glbBlob);
      const { url: tu, key: tk } = await getSignedUploadUrl('elements/thumbnails', `${crypto.randomUUID()}.png`, 'image/png');
      await uploadToR2(tu, thumbBlob);

      const partsMeta = parts.filter(p => meshCountFor(p.id) > 0).map(p => ({ id: p.id, label: p.label, default: p.color, finish: p.finish }));
      await createGlobalElement({
        name: name.trim(),
        element_type_id: elementTypeId,
        parent_id: null,
        image_url: fk,
        thumbnail_url: tk,
        allowed_zones: zones,
        placement_config: { ...placementConfig, r: topperSize, _model: { parts: partsMeta, source: 'glb-studio' } },
        allowed_actions: capabilities,
        default_color: keepOriginal ? null : (parts[0]?.color ?? null),
        sort_order: 0,
      });
      setSaveMsg({ ok: true, text: 'Saved as element!' });
    } catch (e) {
      setSaveMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  }

  const activeParts = parts.filter(p => meshCountFor(p.id) > 0);
  const totalTris = meshes.reduce((a, m) => a + m.tris, 0);
  const selectedObj = findPieceObj(root, selectedPiece);

  // Cake placement: scale the topper to the chosen tier, place it on top (stand)
  // or bent around the tier wall (side, hug). Recomputes when geometry changes.
  const placement = useMemo(() => {
    if (!root || !showCake) {
      if (bentRef.current) { bentRef.current.traverse(o => o.geometry?.dispose?.()); bentRef.current = null; }
      return null;
    }
    const tiers = tierGeom(tierCount);
    const tier = tiers[Math.min(placeTier, tiers.length - 1)] || tiers[0];
    const box = localBox(root);
    const h = (box.max.y - box.min.y) || 1;
    const maxDim = Math.max(box.max.x - box.min.x, h, box.max.z - box.min.z) || 1;
    if (bentRef.current) { bentRef.current.traverse(o => o.geometry?.dispose?.()); bentRef.current = null; }
    if (placeMode === 'side') {
      const scale = (tier.height * topperSize) / h; // relief height ≈ tier height × size
      const fset = new Set(pieces.filter(p => p.flatten !== false).map(p => p.id));
      const sideGroup = buildBentTopper(root, tier.radius, scale, flat.normal, fset, smooth);
      bentRef.current = sideGroup;
      return { tiers, tier, focusY: tier.midY, mode: 'side', sideGroup };
    }
    const scale = (tier.radius * 1.4 * topperSize) / maxDim; // topper fits the tier top
    const posY = tier.topY - box.min.y * scale;             // base rests on the tier top
    return { tiers, tier, focusY: tier.topY, mode: 'top', scale, posY };
    // eslint-disable-next-line
  }, [root, showCake, placeMode, placeTier, tierCount, topperSize, pieces, smooth, flat, optMsg]);

  const s = useMemo(() => ({
    page: { minHeight: '100vh', background: '#EDEAE2', fontFamily: 'Quicksand, sans-serif', padding: '32px 24px' },
    title: { fontSize: 22, fontWeight: 800, color: '#2C4433', marginBottom: 6 },
    sub: { fontSize: 13, color: '#6B8C74', fontWeight: 600, marginBottom: 24 },
    layout: { display: 'grid', gridTemplateColumns: '300px minmax(0, 1fr) 340px', gap: 20, maxWidth: 1560, margin: '0 auto', alignItems: 'start' },
    colCard: { background: '#fff', borderRadius: 18, border: '1.5px solid #C5D4C8', padding: 22 },
    card: { background: '#fff', borderRadius: 18, border: '1.5px solid #C5D4C8', padding: 28 },
    section: { marginBottom: 24 },
    sectionTitle: { fontSize: 11, fontWeight: 700, color: '#6B8C74', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 },
    pickBtn: { display: 'block', padding: '14px 18px', borderRadius: 12, border: '2px dashed #C5D4C8', background: '#F4F8F5', color: '#3D5A44', fontFamily: 'Quicksand, sans-serif', fontSize: 14, fontWeight: 700, cursor: 'pointer', textAlign: 'center' },
    err: { marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, background: '#FFF0F0', color: '#C0392B' },
    meshRow: (sel) => ({ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', background: sel ? '#E8EDE9' : '#F4F8F5', border: `1.5px solid ${sel ? '#3D5A44' : 'transparent'}` }),
    badge: { fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 5, background: '#FFE8B0', color: '#8a6d1a' },
    miniSelect: { padding: '4px 6px', borderRadius: 6, border: '1.5px solid #C5D4C8', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, color: '#2C4433', background: '#fff' },
    partRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: '#F4F8F5', borderRadius: 8 },
    swatch: { width: 32, height: 32, borderRadius: 8, border: '1.5px solid #C5D4C8', cursor: 'pointer', padding: 2, background: '#fff', flexShrink: 0 },
    labelInput: { flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 6, border: '1.5px solid #C5D4C8', fontFamily: 'Quicksand, sans-serif', fontSize: 13, fontWeight: 700, color: '#2C4433', background: '#fff' },
    addBtn: { marginTop: 10, padding: '8px 14px', borderRadius: 8, border: '1.5px solid #C5D4C8', background: '#fff', color: '#3D5A44', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
    modeBtn: (a) => ({ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, background: a ? '#3D5A44' : '#E8EDE9', color: a ? '#fff' : '#6B8C74' }),
    input: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontFamily: 'Quicksand, sans-serif', fontSize: 14, fontWeight: 600, color: '#2C4433', background: '#fff', boxSizing: 'border-box', outline: 'none' },
    elLabel: { fontSize: 12, fontWeight: 700, color: '#6B8C74', display: 'block', marginBottom: 6 },
    zoneChip: (a) => ({ padding: '6px 12px', borderRadius: 20, border: `1.5px solid ${a ? '#3D5A44' : '#C5D4C8'}`, background: a ? '#E8EDE9' : '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: a ? '#2C4433' : '#6B8C74' }),
    exportBtn: (d) => ({ width: '100%', padding: '13px 0', borderRadius: 10, border: 'none', background: d ? '#9BB5A2' : '#3D5A44', color: '#fff', fontFamily: 'Quicksand, sans-serif', fontSize: 15, fontWeight: 800, cursor: d ? 'not-allowed' : 'pointer', marginTop: 20 }),
    hint: { fontSize: 11, color: '#9BB5A2', fontWeight: 600, marginTop: 8 },
  }), []);

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Quicksand:wght@400;600;700;800&display=swap" rel="stylesheet" />
      <div style={s.page}>
        <div style={{ maxWidth: 1140, margin: '0 auto' }}>
          <div style={s.title}>GLB Studio</div>
          <div style={s.sub}>Import one or more GLBs as pieces, position them with the gizmo, group meshes into recolorable parts, optimize, and export/save a merged topper.</div>
        </div>

        <div style={s.layout}>
          {/* ── LEFT: structure (pieces · meshes · parts) ── */}
          <div style={s.colCard}>
            <div style={s.section}>
              <div style={s.sectionTitle}>Pieces</div>
              <label style={s.pickBtn}>
                ＋ Add GLB piece
                <input type="file" accept=".glb,.gltf" multiple style={{ display: 'none' }}
                  onChange={async e => { const fs = Array.from(e.target.files); e.target.value = ''; for (const f of fs) await addPiece(f); }} />
              </label>
              {error && <div style={s.err}>{error}</div>}
              {pieces.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
                  {pieces.map(p => (
                    <div key={p.id} style={s.meshRow(selectedPiece === p.id)}
                      onClick={() => setSelectedPiece(selectedPiece === p.id ? null : p.id)}>
                      <span style={{ fontSize: 14 }}>{selectedPiece === p.id ? '🎯' : '🧩'}</span>
                      <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, color: '#2C4433', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                      <button onClick={e => { e.stopPropagation(); togglePieceFlatten(p.id); }} title="Include this piece when flattening the back"
                        style={{ padding: '3px 8px', borderRadius: 6, border: `1.5px solid ${p.flatten !== false ? '#3D5A44' : '#C5D4C8'}`, background: p.flatten !== false ? '#E8EDE9' : '#fff', color: p.flatten !== false ? '#2C4433' : '#9BB5A2', fontFamily: 'Quicksand, sans-serif', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>flat</button>
                      <button onClick={e => { e.stopPropagation(); removePiece(p.id); }} title="Remove piece"
                        style={{ background: 'none', border: 'none', color: '#C0392B', fontSize: 16, fontWeight: 700, cursor: 'pointer', lineHeight: 1 }}>×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {meshes.length > 0 && (
              <div style={s.section}>
                <div style={s.sectionTitle}>Meshes — click to highlight</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {meshes.map(m => (
                    <div key={m.key} style={s.meshRow(selectedKey === m.key)}
                      onClick={() => setSelectedKey(selectedKey === m.key ? null : m.key)}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#2C4433', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</div>
                        <div style={{ fontSize: 11, color: '#9BB5A2', fontWeight: 600 }}>{m.tris.toLocaleString()} tris</div>
                      </div>
                      {m.hasTexture && <span style={s.badge}>texture</span>}
                      <select style={s.miniSelect} value={assign[m.key] || ''} onClick={e => e.stopPropagation()} onChange={e => assignMesh(m.key, e.target.value)}>
                        {parts.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {parts.length > 0 && (
              <div style={{ ...s.section, marginBottom: 0 }}>
                <div style={s.sectionTitle}>Parts ({activeParts.length})</div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 12, padding: '8px 10px', background: '#F4F8F5', borderRadius: 8 }}>
                  <input type="checkbox" checked={keepOriginal} onChange={e => setKeepOriginal(e.target.checked)} style={{ width: 18, height: 18, accentColor: '#3D5A44' }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#2C4433' }}>Keep original colors (texture)</span>
                </label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {parts.map(p => {
                    const count = meshCountFor(p.id);
                    return (
                      <div key={p.id} style={s.partRow}>
                        <input type="color" value={p.color} disabled={keepOriginal} onChange={e => updatePart(p.id, { color: e.target.value })} style={{ ...s.swatch, opacity: keepOriginal ? 0.4 : 1, cursor: keepOriginal ? 'not-allowed' : 'pointer' }} title={keepOriginal ? 'Using imported colors — finish still applies' : 'Part color'} />
                        <input value={p.label} onChange={e => updatePart(p.id, { label: e.target.value })} style={s.labelInput} />
                        <select style={s.miniSelect} value={p.finish} onChange={e => updatePart(p.id, { finish: e.target.value, finishSet: true })}>
                          {Object.entries(FINISHES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                        </select>
                        {count === 0 && (
                          <button onClick={() => removePart(p.id)} title="Remove empty part"
                            style={{ background: 'none', border: 'none', color: '#C0392B', fontSize: 16, fontWeight: 700, cursor: 'pointer', lineHeight: 1 }}>×</button>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button style={s.addBtn} onClick={addPart}>＋ Add part</button>
                <div style={s.hint}>With "Keep original colors" on, color comes from the texture but <b>Finish</b> still applies — set the horn part to <b>Metallic</b> for gold shine.</div>
              </div>
            )}
          </div>

          {/* ── CENTER: the stage ── */}
          <div style={{ ...s.colCard, position: 'sticky', top: 16 }}>
            <div style={{ position: 'relative' }}>
              <ModelView
                root={root}
                selectedObj={selectedObj}
                onPickPiece={setSelectedPiece}
                showCake={showCake} placement={placement}
                ambientInt={ambientInt} keyInt={keyInt} fillInt={fillInt} envPreset={envPreset}
                containerRef={previewRef}
                onReady={cam => { cameraRef.current = cam; }}
                height={560}
              />
              {/* cake simulator (bottom-left) */}
              {root && (
                <div style={{ position: 'absolute', bottom: 12, left: 12, background: 'rgba(255,255,255,0.95)', border: '1.5px solid #C5D4C8', borderRadius: 10, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '72%' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={showCake} onChange={e => setShowCake(e.target.checked)} style={{ width: 16, height: 16, accentColor: '#3D5A44' }} />
                      <span style={{ fontSize: 12, fontWeight: 800, color: '#2C4433' }}>🎂 Show cake</span>
                    </label>
                    {showCake && (
                      <>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: '#6B8C74' }}>Tiers</span>
                          <select value={tierCount} onChange={e => { const n = +e.target.value; setTierCount(n); setPlaceTier(p => Math.min(p, n - 1)); }} style={s.miniSelect}>
                            {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
                          </select>
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: '#6B8C74' }}>On tier</span>
                          <select value={placeTier} onChange={e => setPlaceTier(+e.target.value)} style={s.miniSelect}>
                            {Array.from({ length: tierCount }, (_, i) => <option key={i} value={i}>{i === 0 ? 'bottom' : i === tierCount - 1 ? 'top' : `#${i + 1}`}</option>)}
                          </select>
                        </label>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {[['top', 'Top'], ['side', 'Side']].map(([m, l]) => (
                            <button key={m} onClick={() => setPlaceMode(m)} style={s.modeBtn(placeMode === m)}>{l}</button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  {showCake && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#6B8C74', width: 64 }}>Size (r)</span>
                      <input type="range" min={0.3} max={2.5} step={0.05} value={topperSize} onChange={e => setTopperSize(+e.target.value)} style={{ flex: 1, accentColor: '#3D5A44' }} />
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44', width: 30, textAlign: 'right' }}>{topperSize.toFixed(2)}</span>
                    </div>
                  )}
                </div>
              )}
              {/* selected-piece label (top-left) */}
              <div style={{ position: 'absolute', top: 12, left: 12, background: 'rgba(255,255,255,0.92)', border: '1.5px solid #C5D4C8', borderRadius: 10, padding: '6px 12px', fontSize: 13, fontWeight: 800, color: selectedPiece ? '#2563eb' : '#6B8C74', maxWidth: '46%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', pointerEvents: 'none' }}>
                {selectedPiece ? `🎯 ${pieces.find(p => p.id === selectedPiece)?.name}` : (root ? 'Click a piece to select' : 'Add a piece to begin')}
              </div>
              {/* transform panel (top-right) — moves the selected piece */}
              {selectedPiece && (
                <div style={{ position: 'absolute', top: 12, right: 12, width: 234, background: 'rgba(255,255,255,0.96)', border: '1.5px solid #C5D4C8', borderRadius: 12, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 7, boxShadow: '0 4px 16px rgba(44,68,51,0.14)' }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: '#2563eb', letterSpacing: 1, textTransform: 'uppercase' }}>Position</div>
                  {[['X', 'px'], ['Y', 'py'], ['Z', 'pz']].map(([l, k]) => (
                    <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#6B8C74', width: 14 }}>{l}</span>
                      <input type="range" min={-3} max={3} step={0.01} value={xf[k]} onChange={e => applyXf({ [k]: +e.target.value })} style={{ flex: 1, accentColor: '#2563eb' }} />
                      <span style={{ fontSize: 10, fontWeight: 700, color: '#3D5A44', width: 30, textAlign: 'right' }}>{xf[k].toFixed(2)}</span>
                    </div>
                  ))}
                  <div style={{ fontSize: 10, fontWeight: 800, color: '#6B8C74', letterSpacing: 1, textTransform: 'uppercase', marginTop: 2 }}>Rotation</div>
                  {[['X', 'rx'], ['Y', 'ry'], ['Z', 'rz']].map(([l, k]) => (
                    <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#6B8C74', width: 14 }}>{l}</span>
                      <input type="range" min={-180} max={180} step={1} value={xf[k]} onChange={e => applyXf({ [k]: +e.target.value })} style={{ flex: 1, accentColor: '#3D5A44' }} />
                      <span style={{ fontSize: 10, fontWeight: 700, color: '#3D5A44', width: 30, textAlign: 'right' }}>{Math.round(xf[k])}°</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <span style={{ fontSize: 10, fontWeight: 800, color: '#6B8C74', letterSpacing: 1, textTransform: 'uppercase', width: 38 }}>Scale</span>
                    <input type="range" min={0.05} max={3} step={0.01} value={xf.sc} onChange={e => applyXf({ sc: +e.target.value })} style={{ flex: 1, accentColor: '#3D5A44' }} />
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#3D5A44', width: 30, textAlign: 'right' }}>{xf.sc.toFixed(2)}</span>
                  </div>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
              <span style={{ fontSize: 11, color: '#9BB5A2', fontWeight: 600 }}>
                {root ? 'Drag empty space to orbit · scroll to zoom · drag the gizmo arrows to move the selected piece' : 'Add a GLB piece to begin'}
              </span>
              {root && (
                <span style={{ fontSize: 11, color: '#9BB5A2', fontWeight: 700 }}>
                  {pieces.length}p · {meshes.length}m · {totalTris.toLocaleString()} tris · <button onClick={clearAll} style={{ background: 'none', border: 'none', color: '#C0392B', fontWeight: 700, fontSize: 11, cursor: 'pointer', padding: 0 }}>clear</button>
                </span>
              )}
            </div>

            <button style={s.exportBtn(busy || !root)} onClick={exportGLB} disabled={busy || !root}>
              {busy ? 'Working…' : '⬇ Export merged GLB'}
            </button>
            <div style={s.hint}>One .glb merging all pieces, each its own part. Pick it in the Piping Calibrator to test on a cake.</div>
          </div>

          {/* ── RIGHT: finishing tools ── */}
          <div style={s.colCard}>
            {root && (
              <div style={s.section}>
                <div style={s.sectionTitle}>Optimize (reduce size)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#6B8C74', width: 56 }}>Target</span>
                  <input type="range" min={3000} max={60000} step={1000} value={opt.targetTris} onChange={e => setOpt(o => ({ ...o, targetTris: +e.target.value }))} style={{ flex: 1, accentColor: '#3D5A44' }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44', minWidth: 80, textAlign: 'right' }}>≈ {opt.targetTris.toLocaleString()} tris</span>
                </div>
                <div style={{ fontSize: 11, color: '#9BB5A2', fontWeight: 600, marginBottom: 10 }}>Absolute triangle budget (works for any input size). <b>~15–25k</b> keeps faces crisp at ~1–2 MB.</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#6B8C74', width: 56 }}>Apply to</span>
                  <select value={optScope} onChange={e => setOptScope(e.target.value)} style={s.miniSelect}>
                    <option value="all">All pieces</option>
                    <option value="selected">Selected piece only</option>
                  </select>
                </div>
                <button style={s.exportBtn(busy || (optScope === 'selected' && !selectedPiece))} onClick={optimize} disabled={busy || (optScope === 'selected' && !selectedPiece)}>{busy ? 'Optimizing…' : (optScope === 'selected' ? '⚡ Optimize selected' : '⚡ Optimize all')}</button>
                <div style={s.hint}>Bakes the texture into vertex colors (no shatter on the mane), then decimates. No texture file = lighter. Run once; clear & re-add to redo.</div>
                {optMsg && <div style={optMsg.ok ? { ...s.err, background: '#E8F5E9', color: '#2E7D32' } : s.err}>{optMsg.text}</div>}
              </div>
            )}

            {root && (
              <div style={s.section}>
                <div style={s.sectionTitle}>Surface</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#6B8C74', width: 84 }}>Smoothness</span>
                  <input type="range" min={0} max={1} step={0.02} value={smooth} onChange={e => setSmooth(+e.target.value)} style={{ flex: 1, accentColor: '#3D5A44' }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44', minWidth: 36, textAlign: 'right' }}>{Math.round(smooth * 100)}%</span>
                </div>
                <div style={s.hint}>Smooths shading across low-poly facets (shading only).</div>
              </div>
            )}

            {root && (
              <div style={s.section}>
                <div style={s.sectionTitle}>Flatten Back (relief)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <button onClick={setFront} style={{ ...s.addBtn, marginTop: 0 }}>🎯 Set front</button>
                  <span style={{ fontSize: 12, fontWeight: 700, color: flat.frontSet ? '#2E7D32' : '#9BB5A2' }}>{flat.frontSet ? 'Front set ✓' : 'Default view'}</span>
                </div>
                <div style={{ fontSize: 11, color: '#9BB5A2', fontWeight: 600, marginBottom: 10 }}>Orbit to the profile you want, Set front, then flatten — the back cuts parallel to that view. Only pieces with <b>flat</b> on (Pieces list) are flattened — e.g. flatten the body, leave the horn.</div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: flat.enabled ? 12 : 0 }}>
                  <input type="checkbox" checked={flat.enabled} onChange={e => setFlat(f => ({ ...f, enabled: e.target.checked }))} style={{ width: 18, height: 18, accentColor: '#3D5A44' }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#2C4433' }}>Flat-backed relief</span>
                </label>
                {flat.enabled && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#6B8C74', width: 46 }}>Depth</span>
                    <input type="range" min={0.02} max={0.95} step={0.01} value={flat.amount} onChange={e => setFlat(f => ({ ...f, amount: +e.target.value }))} style={{ flex: 1, accentColor: '#3D5A44' }} />
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44', minWidth: 36, textAlign: 'right' }}>{Math.round(flat.amount * 100)}%</span>
                  </div>
                )}
              </div>
            )}

            <div style={s.section}>
              <div style={s.sectionTitle}>Lighting</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
            </div>

            {root && (
              <div style={{ ...s.section, marginBottom: 0 }}>
                <div style={s.sectionTitle}>Save as Element</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div>
                    <label style={s.elLabel}>Name</label>
                    <input style={s.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Unicorn Topper" />
                  </div>
                  <div>
                    <label style={s.elLabel}>Element Type</label>
                    <select style={s.input} value={elementTypeId} onChange={e => setElementTypeId(e.target.value)}>
                      <option value="">Select type…</option>
                      {elementTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <div style={s.elLabel}>Zones</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {ZONES.map(z => (
                        <button key={z} onClick={() => toggleZone(z)} style={s.zoneChip(zones.includes(z))}>{z.replace(/_/g, ' ')}</button>
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
                    <div style={s.elLabel}>Capabilities (designer edit controls)</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {[
                        { key: 'resize', label: 'Resize' },
                        { key: 'duplicate', label: 'Duplicate' },
                        { key: 'color', label: 'Recolor' },
                        { key: 'delete', label: 'Delete' },
                        { key: 'move', label: 'Move ◀▶▲▼' },
                        { key: 'tilt', label: 'Tilt' },
                      ].map(({ key, label }) => (
                        <button key={key} onClick={() => setCapabilities(c => ({ ...c, [key]: !c[key] }))} style={s.zoneChip(capabilities[key])}>{label}</button>
                      ))}
                    </div>
                  </div>
                  <button style={s.exportBtn(busy)} onClick={handleSaveElement} disabled={busy}>{busy ? 'Working…' : '✓ Save as Element'}</button>
                  {saveMsg && <div style={saveMsg.ok ? { ...s.err, background: '#E8F5E9', color: '#2E7D32' } : s.err}>{saveMsg.text}</div>}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
