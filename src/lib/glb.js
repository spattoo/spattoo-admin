import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

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

/* ── What colour is this model, before anyone recolours it ───────────────────────────────────────
 *
 * ⚠️ AN OPTIMISED MODEL ARRIVES WITH NO COLOUR TO SHOW. `bake` mode — the default, and the whole
 * reason a Meshy download fits on a phone — folds the base-colour TEXTURE into per-vertex colours
 * and drops the map. Core then has to take the HUE back out for any element marked
 * colour-changeable, because three.js MULTIPLIES material colour by vertex colour and a baked red
 * eats every colour a customer picks (designer/canvas/bakedColour.js: ask for cream, get red; ask
 * for blue, get nearly black). What survives is the shading, which is correct — but with
 * `default_color` null the piece lands on the cake grey.
 *
 * Reported while building one: *"i am loosing the original color of the glb element. is there a way
 * to retain the original color, but still be able to change it?"* There is, and it is this: record
 * what the model actually looked like, and put it in `default_color`. The tint then lands over the
 * preserved shading, so the piece arrives looking like itself AND stays changeable.
 *
 * ⚠️ MEASURED FROM THE VERTICES FIRST, because after a bake that is where the colour went. A
 * material's own `color` is usually white once a map has been folded in, so reading it would report
 * white for exactly the models this exists for. Material colour is the fallback for a model that
 * was never baked.
 *
 * Weighted by vertex count so a large part decides, not a small one: a unicorn that is mostly white
 * with a pink horn is white. The mean is taken in LINEAR space (what three stores) and handed back
 * as an sRGB hex, which is what a colour input and the `default_color` column both speak.
 */
export function dominantColour(root) {
  if (!root?.traverse) return null;
  let r = 0, g = 0, b = 0, n = 0;
  let mr = 0, mg = 0, mb = 0, mn = 0;
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const col = o.geometry.attributes?.color;
    if (col?.count) {
      for (let i = 0; i < col.count; i++) { r += col.getX(i); g += col.getY(i); b += col.getZ(i); }
      n += col.count;
    }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m?.color) continue;
      const w = o.geometry.attributes?.position?.count ?? 1;
      mr += m.color.r * w; mg += m.color.g * w; mb += m.color.b * w; mn += w;
    }
  });
  const [lr, lg, lb] = n ? [r / n, g / n, b / n] : mn ? [mr / mn, mg / mn, mb / mn] : [null, null, null];
  if (lr == null) return null;
  /* ⚠️ A NEARLY-BLACK OR NEARLY-WHITE MEAN IS NOT A COLOUR, it is an unlit or untextured model, and
     writing it into `default_color` would paint every piece that colour on arrival. Say nothing
     instead: null leaves the element exactly as it behaves today. */
  const lum = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  if (lum < 0.004 || lum > 0.985) return null;
  return '#' + new THREE.Color().setRGB(lr, lg, lb, THREE.LinearSRGBColorSpace).getHexString(THREE.SRGBColorSpace);
}

/* From a raw buffer, the way `measureGlbBuffer` is — same loader, so a meshopt or Draco file is
   read identically. This is also how the measurement is testable without a scene in hand. */
export async function dominantColourFromBuffer(buffer) {
  const gltf = await bufLoader().parseAsync(buffer, '');
  return dominantColour(gltf.scene);
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
  rows.forEach(r => { r.over = r.value > r.cap; r.ratio = r.cap ? (r.value ?? 0) / r.cap : 0; });
  // How far over the worst metric is. A little over is a judgement call about detail; an order of
  // magnitude over is a different situation entirely — past what a graphics card will draw, so the
  // preview goes blank and the verdict line has to stop saying "it's allowed, just flagged".
  const worstRatio = Math.max(0, ...rows.map(r => r.ratio));
  return {
    assetClass, capLabel: cap.label, rows,
    anyOver: rows.some(r => r.over),
    worstRatio: worstRatio >= 10 ? Math.round(worstRatio) : Math.round(worstRatio * 10) / 10,
    wayOver: worstRatio >= 10,
  };
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
function bufLoader() {
  if (!_loader) {
    // Measure whatever compression the drei preview accepts — meshopt AND draco. A Draco-compressed asset
    // (e.g. a pre-optimised GLB) must be MEASURABLE for the mobile budget, not just previewable. Same gstatic
    // decoder version the drei preview's DRACOLoader uses (@react-three/drei Gltf.js).
    const draco = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.5/');
    _loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setDRACOLoader(draco);
  }
  return _loader;
}
export async function measureGlbBuffer(buffer, sizeKB, assetClass) {
  const gltf = await bufLoader().parseAsync(buffer, '');
  return measureForSave(gltf.scene, sizeKB, assetClass);
}

// Inverse of toStatColumns: normalize a cake_elements row's GLB stat columns back to the camelCase
// shape the badges render. Returns null for elements with no recorded stats (e.g. 2D, pre-gate 3D).
export function statsFromElement(el) {
  if (!el || (el.tri_count == null && el.decoded_mem_kb == null && el.optimized_size_kb == null)) return null;
  return {
    tris:          el.tri_count,
    textureMaxDim: el.texture_max_dim,
    decodedMemKB:  el.decoded_mem_kb,
    sizeKB:        el.optimized_size_kb,
    assetClass:    el.asset_class,
    overCap:       el.over_cap,
  };
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

// ── Part groups the GLB already knows about ─────────────────────────────────────────────────────
/* Recover `placement_config._model` from the FILE, for the recompose → download → attach-to-an-
 * existing-element path. RecomposeEditor only writes `_model` when it CREATES an element
 * (createGlobalElement), so a GLB recomposed and then uploaded onto a row that already exists loses
 * its part groups and the customer gets one flat colour.
 *
 * Nothing is inferred. The Recompose Studio records the answer twice and both copies travel inside
 * the file (GLTFExporter writes `mesh.userData` to a node's glTF `extras`):
 *   • the ROOT node's `extras.segments` — the whole part list: id, label, default hex, finish,
 *     group, and `editable`, which is the tick the admin set in the studio's editable-groups grid
 *   • each MESH node's `extras` — { segment, group, editable }, the copy the renderer matches on
 *     (CakeCanvas recolours a mesh by `userData.group`)
 *
 * Only the container's JSON chunk is read, so no geometry is decoded: a draco- or meshopt-compressed
 * file costs nothing here and needs no decoder.
 */

// The JSON chunk of a .glb, or the whole document of a .gltf. Chunk lengths are 4-byte aligned by
// spec (JSON padded with spaces), so walking by the declared length is enough.
export function readGltfJson(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength >= 4 && view.getUint32(0, true) === 0x46546C67) {     // 'glTF'
    let off = 12;
    while (off + 8 <= view.byteLength) {
      const len = view.getUint32(off, true), type = view.getUint32(off + 4, true);
      if (type === 0x4E4F534A) {                                            // 'JSON'
        return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, off + 8, len)));
      }
      off += 8 + len;
    }
    throw new Error('No JSON chunk in this GLB');
  }
  return JSON.parse(new TextDecoder().decode(buffer));                      // plain .gltf
}

// glTF stores baseColorFactor LINEAR; a hex an admin types (and `_model.groups[].default`) is sRGB.
function lin2srgb(c) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}
function hexOfMaterial(mat) {
  const f = mat?.pbrMetallicRoughness?.baseColorFactor;
  if (!Array.isArray(f)) return '#ffffff';
  return '#' + f.slice(0, 3).map(c => lin2srgb(c).toString(16).padStart(2, '0')).join('');
}
const FINISH_BY_ROUGH = [[0.85, 'matte'], [0.5, 'satin'], [0.25, 'glossy']];
function finishOfMaterial(mat) {
  const pbr = mat?.pbrMetallicRoughness ?? {};
  if ((pbr.metallicFactor ?? 1) > 0.5) return 'metal';
  const r = pbr.roughnessFactor ?? 1;
  return FINISH_BY_ROUGH.reduce((best, [v, k]) => Math.abs(r - v) < Math.abs(r - best[0]) ? [v, k] : best,
                                [Infinity, 'matte'])[1];
}

/* Every tagged part of a GLB, as the file records it.
 * → { parts: [{ id, label, group, editable, color, finish, textured }], source, meshCount }
 *   `source` is 'segments' when the studio's own part list was found, 'nodes' when it was rebuilt
 *   from the per-mesh tags, and null when nothing in the file is tagged at all.
 *   `textured` means that part's material carries a baseColorTexture — the renderer skips
 *   `mat.color` whenever `mat.map` is set, so such a part cannot be recoloured whatever is authored.
 */
export function readGlbParts(buffer) {
  const json = readGltfJson(buffer);
  const nodes = json.nodes ?? [], meshes = json.meshes ?? [], materials = json.materials ?? [];
  const meshCount = nodes.filter(n => n.mesh != null).length;

  // What each tagged mesh node says about itself, keyed by segment id (falling back to its name).
  const tagged = nodes
    .filter(n => n.mesh != null && (n.extras?.group != null || n.extras?.segment != null))
    .map(n => {
      const mats = (meshes[n.mesh]?.primitives ?? []).map(p => materials[p.material]).filter(Boolean);
      return {
        id:       n.extras.segment ?? n.name ?? '',
        label:    n.name || n.extras.segment || '(unnamed)',
        group:    (n.extras.group ?? '').trim(),
        editable: !!n.extras.editable,
        color:    hexOfMaterial(mats[0]),
        finish:   finishOfMaterial(mats[0]),
        textured: mats.some(m => !!m.pbrMetallicRoughness?.baseColorTexture),
      };
    });

  // The studio's own list wins where it exists — it carries the label and hex the admin chose, not
  // whatever survived the exporter. Texture and material facts still come from the node it matches.
  const recorded = nodes.find(n => Array.isArray(n.extras?.segments))?.extras.segments;
  if (recorded?.length) {
    const byId = new Map(tagged.map(t => [t.id, t]));
    return {
      source: 'segments',
      meshCount,
      parts: recorded.map(s => ({
        id:       s.id,
        label:    s.label || s.id,
        group:    (s.group ?? '').trim(),
        editable: !!s.editable,
        color:    s.default || byId.get(s.id)?.color || '#ffffff',
        finish:   s.finish || byId.get(s.id)?.finish || 'matte',
        textured: !!byId.get(s.id)?.textured,
      })),
    };
  }
  return { source: tagged.length ? 'nodes' : null, meshCount, parts: tagged };
}

/* The `_model` block to merge into placement_config. `editable` is taken from the parts passed in —
 * so an admin re-ticking a part in Manage Elements overrides what the studio recorded — and the
 * groups are collapsed by key exactly as RecomposeEditor.buildPartsBuffer does: one customer-facing
 * control per distinct NAMED editable group, its default being the first member's colour. */
export function modelFromParts(parts) {
  const groups = [], seen = new Set();
  parts.forEach(p => {
    if (!p.group || !p.editable || seen.has(p.group)) return;
    seen.add(p.group);
    groups.push({ key: p.group, label: p.group, editable: true, default: p.color });
  });
  return {
    groups,
    segments: parts.map(p => ({ id: p.id, label: p.label, default: p.color, finish: p.finish, group: p.group, editable: !!p.editable })),
    source: 'glb-read',
  };
}
