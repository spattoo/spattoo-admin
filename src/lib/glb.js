import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// ── GLB measurement & cap evaluation ────────────────────────────────────────────────────────────
// The "real picture" on a 3D element's cost, surfaced at ingest so the admin decides with numbers in
// hand (ASSET_OPTIMIZATION_PLAN.md §3). We FLAG over-cap assets, never block — some toppers genuinely
// need to stay heavy, and over-optimizing degrades the design. The runtime budget guard reads these
// same stats later. Mobile caps are used as the gate (the binding floor; desktop has headroom).
//
// The cost that actually crashes phones is DECODED GPU memory, not file size: a 2048² RGBA texture is
// a few hundred KB on disk but ~16 MB decoded (~22 MB with mips). So decoded-mem is the headline metric.

// Per-class mobile caps (§3, 3-class tiered model). Sizes in KB, dims in px.
export const CAPS = {
  scatter: { label: 'Scatter / small', textureMaxDim:  512, tris:  3000, sizeKB:  250, decodedMemKB:  1536 },
  decor:   { label: 'Decor',           textureMaxDim: 1024, tris: 25000, sizeKB: 1024, decodedMemKB:  4096 },
  topper:  { label: 'Topper / hero',   textureMaxDim: 1024, tris: 75000, sizeKB: 2048, decodedMemKB: 10240 },
};

export const ASSET_CLASSES = ['scatter', 'decor', 'topper'];

// Best-effort asset class from how the element is placed/used (§3: derived, not a new manual field —
// scatter/cluster multiply and are the real OOM risk; a single top-perched piece is a topper; else
// decor). Returned as a SUGGESTION the admin can override.
export function deriveAssetClass({ placementConfig = {}, zones = [] } = {}) {
  const modes = Object.values(placementConfig).map(v => String(v).toLowerCase());
  if (modes.some(m => m === 'scatter' || m === 'cluster')) return 'scatter';
  if (zones.includes('top') && !zones.some(z => z !== 'top')) return 'topper';
  return 'decor';
}

// Decoded GPU memory estimate in KB: Σ_textures(w·h·4·1.33 mips) + tris·~32 B (§3 formula).
// `textures` is an array of { width, height }.
export function decodedMemKB(tris, textures) {
  const texBytes = textures.reduce((sum, t) => sum + (t.width * t.height * 4 * 1.33), 0);
  const geoBytes = tris * 32;
  return Math.round((texBytes + geoBytes) / 1024);
}

// Walk a three.js root and pull the cost-relevant facts: triangle total, unique textures (and their
// max dimension), and the decoded-mem estimate. Pure read — never mutates the scene.
const TEX_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'];
export function measureGlbRoot(root) {
  let tris = 0;
  const seenTex = new Set();
  const textures = [];
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(m => {
      if (!m) return;
      TEX_SLOTS.forEach(slot => {
        const tex = m[slot];
        const img = tex?.image;
        if (!tex || seenTex.has(tex) || !img?.width) return;
        seenTex.add(tex);
        textures.push({ width: img.width, height: img.height });
      });
    });
  });
  tris = Math.round(tris);
  const textureMaxDim = textures.reduce((mx, t) => Math.max(mx, t.width, t.height), 0);
  return { tris, textureCount: textures.length, textureMaxDim, decodedMemKB: decodedMemKB(tris, textures) };
}

// Compare measured stats against a class's caps. Returns one row per metric with over/under flags so
// the UI can badge each line; `anyOver` is the headline (flag, not block). `sizeKB` is optional (it
// requires building the GLB, so callers pass it once they have a buffer).
export function evaluateCaps({ tris, textureMaxDim, decodedMemKB: decoded, sizeKB }, assetClass) {
  const cap = CAPS[assetClass] ?? CAPS.decor;
  const rows = [
    { key: 'decodedMemKB',  label: 'Decoded GPU',  value: decoded,       cap: cap.decodedMemKB,  unit: 'KB' },
    { key: 'tris',          label: 'Triangles',    value: tris,          cap: cap.tris,          unit: '' },
    { key: 'textureMaxDim', label: 'Texture max',  value: textureMaxDim, cap: cap.textureMaxDim, unit: 'px' },
  ];
  if (sizeKB != null) rows.push({ key: 'sizeKB', label: 'GLB size', value: sizeKB, cap: cap.sizeKB, unit: 'KB' });
  rows.forEach(r => { r.over = r.value > r.cap; });
  return { assetClass, capLabel: cap.label, rows, anyOver: rows.some(r => r.over) };
}

// Human-friendly size: KB under 1 MB, else MB with one decimal.
export function fmtSize(kb) {
  if (kb == null) return '—';
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

// Measure a root + its exported size + class into the camelCase stats object the UI shows AND that
// gets persisted. One shape used by every ingest path (GLB Studio, AddElement handoff, generators).
export function measureForSave(root, sizeKB, assetClass) {
  const m = measureGlbRoot(root);
  return { ...m, sizeKB, assetClass, overCap: evaluateCaps({ ...m, sizeKB }, assetClass).anyOver };
}

// Measure an exported GLB ArrayBuffer (for paths that build a buffer rather than hold a live root —
// RecomposeEditor, the procedural generators). Parses once, then measures like any root.
let _loader;
function bufLoader() { if (!_loader) _loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder); return _loader; }
export async function measureGlbBuffer(buffer, sizeKB, assetClass) {
  const gltf = await bufLoader().parseAsync(buffer, '');
  return measureForSave(gltf.scene, sizeKB, assetClass);
}

// Map the camelCase stats to createGlobalElement's DB field names. The ONE place that mapping lives.
export function toStatColumns(stats) {
  if (!stats) return {};
  return {
    asset_class:       stats.assetClass,
    tri_count:         stats.tris,
    texture_max_dim:   stats.textureMaxDim,
    decoded_mem_kb:    stats.decodedMemKB,
    optimized_size_kb: stats.sizeKB,
    over_cap:          stats.overCap,
  };
}
