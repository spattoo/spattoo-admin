// GLB Recompose — the pure segmentation engine, framework-free so it can run
// both in the page and in a headless verification harness (.pw/verify-recompose-core.mjs).
// Takes a single fused mesh and produces the per-face data needed to carve it
// into recolourable parts: bake colour, weld, simplify, adjacency, Lab colour,
// normals, centroids, k-means, flood-fill and brush. The React component owns
// only the UI + ref/state orchestration and calls into here.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeVertices, mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';

export { THREE }; // re-exported so headless harnesses can render without resolving bare specifiers

let _loader = null;
export function loader() {
  if (!_loader) _loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  return _loader;
}
// Parse a .glb/.gltf ArrayBuffer → scene (used by the headless harness; the app
// uses loader().loadAsync(objectURL)).
export function parseGLB(arrayBuffer) {
  return new Promise((res, rej) => loader().parse(arrayBuffer, '', g => res(g.scene), rej));
}

export function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }

// linear-RGB → CIE Lab (D65). Used for perceptual colour distance + k-means.
export function linToLab(r, g, b) {
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 1.0;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function labToLin(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = t => { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; };
  const x = inv(fx) * 0.95047, y = inv(fy), z = inv(fz) * 1.08883;
  return [
    x * 3.2406 + y * -1.5372 + z * -0.4986,
    x * -0.9689 + y * 1.8758 + z * 0.0415,
    x * 0.0557 + y * -0.2040 + z * 1.0570,
  ].map(v => Math.max(0, Math.min(1, v)));
}
export function deltaE(a, b) {
  const dl = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

// Bake a textured mesh's colour into a per-vertex colour attribute, so the
// working geometry no longer needs the heavy atlas and we can sample colour per
// face. If the material has no texture, fall back to its flat colour. Returns a
// geometry that always has a linear `color` attribute and no uv.
export function bakeColors(geo, material) {
  const g = geo.clone();
  const count = g.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const mat = Array.isArray(material) ? material[0] : material;
  const tex = mat && mat.map;
  const uv = g.attributes.uv;
  if (tex && tex.image && uv) {
    const img = tex.image, cw = img.width || img.videoWidth, ch = img.height || img.videoHeight;
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, cw, ch);
    const data = ctx.getImageData(0, 0, cw, ch).data;
    const flipY = tex.flipY !== false;
    for (let i = 0; i < count; i++) {
      let u = uv.getX(i), w = uv.getY(i);
      u -= Math.floor(u); w -= Math.floor(w);
      const px = Math.min(cw - 1, Math.max(0, Math.round(u * (cw - 1))));
      const py = Math.min(ch - 1, Math.max(0, Math.round((flipY ? 1 - w : w) * (ch - 1))));
      const idx = (py * cw + px) * 4;
      colors[i * 3]     = srgbToLinear(data[idx]     / 255);
      colors[i * 3 + 1] = srgbToLinear(data[idx + 1] / 255);
      colors[i * 3 + 2] = srgbToLinear(data[idx + 2] / 255);
    }
  } else {
    const c = mat && mat.color ? mat.color : new THREE.Color('#cccccc');
    for (let i = 0; i < count; i++) { colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b; }
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
  return g;
}

// Merge every mesh of the loaded scene (transforms baked into positions) into one
// welded, colour-attributed, normalised geometry, optionally simplified to a
// triangle budget. Returns an indexed welded THREE.BufferGeometry.
export async function buildWorkingGeo(scene, targetTris) {
  const geos = [];
  scene.updateMatrixWorld(true);
  scene.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    let g = bakeColors(o.geometry, o.material);
    g.applyMatrix4(o.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    geos.push(g);
  });
  if (!geos.length) throw new Error('No meshes found in this file');
  let merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
  if (!merged) throw new Error('Could not merge meshes (attribute mismatch)');

  // normalise: centre at origin, scale longest side to ~2 units → world == local,
  // so brush radius and camera framing are predictable.
  merged.computeBoundingBox();
  const bb = merged.boundingBox, c = new THREE.Vector3(), size = new THREE.Vector3();
  bb.getCenter(c); bb.getSize(size);
  const scale = 2 / (Math.max(size.x, size.y, size.z) || 1);
  merged.translate(-c.x, -c.y, -c.z);
  merged.scale(scale, scale, scale);

  // weld so we have shared-vertex topology for adjacency + a clean index to simplify.
  let welded = mergeVertices(merged);

  // simplify (colour-weighted, lock the border) so per-face editing stays snappy
  // and the saved topper is light for mobile. Skip if already under budget.
  const curTris = welded.index.count / 3;
  if (targetTris && curTris > targetTris) {
    await MeshoptSimplifier.ready;
    const index = welded.index.array instanceof Uint32Array ? welded.index.array.slice() : new Uint32Array(welded.index.array);
    const positions = welded.attributes.position.array;
    const target = Math.max(1500, Math.round(targetTris)) * 3;
    let simp;
    if (welded.attributes.color) {
      [simp] = MeshoptSimplifier.simplifyWithAttributes(
        index, positions, 3, welded.attributes.color.array, 3, [4, 4, 4], null, target, 0.5, ['LockBorder']);
    } else {
      [simp] = MeshoptSimplifier.simplify(index, positions, 3, target, 0.5);
    }
    welded.setIndex(new THREE.BufferAttribute(simp, 1));
    welded = mergeVertices(welded); // drop now-unused verts
  }
  welded.computeVertexNormals();
  return welded;
}

// From an indexed welded geometry, derive everything per-FACE we need to segment:
// adjacency (faces sharing an edge), Lab colour, geometric normal, centroid.
export function deriveFaceData(geo) {
  const idx = geo.index.array;
  const pos = geo.attributes.position.array;
  const col = geo.attributes.color.array;
  const triCount = idx.length / 3;

  // Canonical vertex id by POSITION ONLY. mergeVertices welds on all attributes
  // (position+normal+colour), so it splits verts at every colour/normal seam —
  // which would fragment adjacency and stop flood-fill at those seams. Re-weld on
  // quantised position so neighbours connect across seams (a watertight mesh → 1
  // island). EPS is relative to the ~2-unit normalised model.
  const vCount = geo.attributes.position.count;
  const EPS = 1e-4;
  const keyToId = new Map();
  const canon = new Int32Array(vCount);
  for (let i = 0; i < vCount; i++) {
    const key = `${Math.round(pos[i * 3] / EPS)},${Math.round(pos[i * 3 + 1] / EPS)},${Math.round(pos[i * 3 + 2] / EPS)}`;
    let id = keyToId.get(key);
    if (id === undefined) { id = keyToId.size; keyToId.set(key, id); }
    canon[i] = id;
  }

  // edge (canonical vid pair) → face; the two faces sharing it are neighbours.
  const edgeMap = new Map();
  const adjacency = Array.from({ length: triCount }, () => []);
  const addEdge = (ra, rb, f) => {
    const a = canon[ra], b = canon[rb];
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    const e = edgeMap.get(key);
    if (e === undefined) edgeMap.set(key, f);
    else if (e >= 0) { adjacency[f].push(e); adjacency[e].push(f); edgeMap.set(key, -1); }
  };
  const labs = new Float32Array(triCount * 3);
  const normals = new Float32Array(triCount * 3);
  const centroids = new Float32Array(triCount * 3);
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  for (let f = 0; f < triCount; f++) {
    const ia = idx[f * 3], ib = idx[f * 3 + 1], ic = idx[f * 3 + 2];
    addEdge(ia, ib, f); addEdge(ib, ic, f); addEdge(ic, ia, f);
    const r = (col[ia * 3] + col[ib * 3] + col[ic * 3]) / 3;
    const g = (col[ia * 3 + 1] + col[ib * 3 + 1] + col[ic * 3 + 1]) / 3;
    const b = (col[ia * 3 + 2] + col[ib * 3 + 2] + col[ic * 3 + 2]) / 3;
    const lab = linToLab(r, g, b);
    labs[f * 3] = lab[0]; labs[f * 3 + 1] = lab[1]; labs[f * 3 + 2] = lab[2];
    vA.set(pos[ia * 3], pos[ia * 3 + 1], pos[ia * 3 + 2]);
    vB.set(pos[ib * 3], pos[ib * 3 + 1], pos[ib * 3 + 2]);
    vC.set(pos[ic * 3], pos[ic * 3 + 1], pos[ic * 3 + 2]);
    e1.subVectors(vB, vA); e2.subVectors(vC, vA); n.crossVectors(e1, e2).normalize();
    normals[f * 3] = n.x; normals[f * 3 + 1] = n.y; normals[f * 3 + 2] = n.z;
    centroids[f * 3] = (vA.x + vB.x + vC.x) / 3;
    centroids[f * 3 + 1] = (vA.y + vB.y + vC.y) / 3;
    centroids[f * 3 + 2] = (vA.z + vB.z + vC.z) / 3;
  }
  return { triCount, adjacency, labs, normals, centroids };
}

// k-means on per-face Lab colour → { assign: Int32Array(cluster per face),
// colors: [hex per cluster] }. Deterministic seeding by spreading over faces.
export function kmeans(labs, triCount, K) {
  const cents = [];
  for (let k = 0; k < K; k++) {
    const f = Math.floor((k + 0.5) / K * triCount);
    cents.push([labs[f * 3], labs[f * 3 + 1], labs[f * 3 + 2]]);
  }
  const assign = new Int32Array(triCount);
  for (let iter = 0; iter < 12; iter++) {
    for (let f = 0; f < triCount; f++) {
      let best = 0, bd = Infinity;
      const lab = [labs[f * 3], labs[f * 3 + 1], labs[f * 3 + 2]];
      for (let k = 0; k < K; k++) { const d = deltaE(lab, cents[k]); if (d < bd) { bd = d; best = k; } }
      assign[f] = best;
    }
    const sum = Array.from({ length: K }, () => [0, 0, 0, 0]);
    for (let f = 0; f < triCount; f++) {
      const k = assign[f], s = sum[k];
      s[0] += labs[f * 3]; s[1] += labs[f * 3 + 1]; s[2] += labs[f * 3 + 2]; s[3]++;
    }
    for (let k = 0; k < K; k++) if (sum[k][3]) cents[k] = [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]];
  }
  const colors = cents.map(c => {
    const [r, g, b] = labToLin(c[0], c[1], c[2]);
    return '#' + new THREE.Color().setRGB(r, g, b).getHexString(); // linear → hex (sRGB)
  });
  return { assign, colors };
}

// k-means by colour, then split each colour cluster into spatially CONNECTED
// components — so same-coloured but physically separate regions (eyes vs shoes,
// left vs right bun) become distinct parts you can recolour independently.
// Tiny fragments (< minFaces) merge into the largest kept part of their colour so
// speckles don't explode the parts list; total parts capped at maxParts.
export function clusterConnected(faceData, K, opts = {}) {
  const { triCount, adjacency } = faceData;
  const minFaces = opts.minFaces ?? Math.max(20, Math.round(triCount * 0.0008));
  const maxParts = opts.maxParts ?? 30;
  const { assign: kAssign, colors: kColors } = kmeans(faceData.labs, triCount, K);

  // connected components within each colour cluster
  const comp = new Int32Array(triCount).fill(-1);
  const compCluster = [], compSize = [];
  let nc = 0;
  for (let s = 0; s < triCount; s++) {
    if (comp[s] !== -1) continue;
    const cl = kAssign[s];
    const stack = [s]; comp[s] = nc; let size = 0;
    while (stack.length) { const f = stack.pop(); size++; for (const nb of adjacency[f]) if (comp[nb] === -1 && kAssign[nb] === cl) { comp[nb] = nc; stack.push(nb); } }
    compCluster.push(cl); compSize.push(size); nc++;
  }

  const order = [...Array(nc).keys()].sort((a, b) => compSize[b] - compSize[a]);
  const keep = new Set();
  for (const ci of order) if (compSize[ci] >= minFaces && keep.size < maxParts) keep.add(ci);
  // every colour must have at least one kept component (its largest)
  const clusterLargestKept = {};
  for (const ci of order) { const cl = compCluster[ci]; if (keep.has(ci) && clusterLargestKept[cl] === undefined) clusterLargestKept[cl] = ci; }
  for (const ci of order) { const cl = compCluster[ci]; if (clusterLargestKept[cl] === undefined) { keep.add(ci); clusterLargestKept[cl] = ci; } }

  // kept components → sequential part ids; small ones fold into their colour's largest kept
  const compToPart = new Int32Array(nc).fill(-1);
  let partCount = 0;
  for (const ci of order) if (keep.has(ci)) compToPart[ci] = partCount++;
  for (let ci = 0; ci < nc; ci++) if (compToPart[ci] === -1) compToPart[ci] = compToPart[clusterLargestKept[compCluster[ci]]];

  const assign = new Int32Array(triCount);
  for (let f = 0; f < triCount; f++) assign[f] = compToPart[comp[f]];
  const partCluster = new Array(partCount);
  for (const ci of order) if (keep.has(ci)) partCluster[compToPart[ci]] = compCluster[ci];
  const colors = partCluster.map(cl => kColors[cl]);
  return { assign, colors };
}

// Flood-fill from a seed face over adjacency, stopping where colour (ΔE vs seed)
// or surface bend (crease angle) exceeds the thresholds. Returns the face indices.
export function floodFillFaces(faceData, startFace, { colorTol, creaseDeg }) {
  const { adjacency, labs, normals, triCount } = faceData;
  const seed = [labs[startFace * 3], labs[startFace * 3 + 1], labs[startFace * 3 + 2]];
  const cosLimit = Math.cos(creaseDeg * Math.PI / 180);
  const visited = new Uint8Array(triCount);
  const stack = [startFace]; visited[startFace] = 1;
  const out = [];
  while (stack.length) {
    const f = stack.pop();
    out.push(f);
    const nx = normals[f * 3], ny = normals[f * 3 + 1], nz = normals[f * 3 + 2];
    for (const nb of adjacency[f]) {
      if (visited[nb]) continue;
      const lab = [labs[nb * 3], labs[nb * 3 + 1], labs[nb * 3 + 2]];
      if (deltaE(lab, seed) > colorTol) continue;
      const dot = nx * normals[nb * 3] + ny * normals[nb * 3 + 1] + nz * normals[nb * 3 + 2];
      if (dot < cosLimit) continue;            // crossed a sharp crease → stop
      visited[nb] = 1; stack.push(nb);
    }
  }
  return out;
}

// Paint: faces reachable over adjacency from the hit face whose centroid lies
// within `radius` of the hit point. Returns the face indices.
export function brushFaces(faceData, startFace, point, radius) {
  const { adjacency, centroids, triCount } = faceData;
  const r2 = radius * radius;
  const visited = new Uint8Array(triCount);
  const stack = [startFace]; visited[startFace] = 1;
  const out = [];
  while (stack.length) {
    const f = stack.pop();
    out.push(f);
    for (const nb of adjacency[f]) {
      if (visited[nb]) continue;
      const dx = centroids[nb * 3] - point.x, dy = centroids[nb * 3 + 1] - point.y, dz = centroids[nb * 3 + 2] - point.z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      visited[nb] = 1; stack.push(nb);
    }
  }
  return out;
}

// Boundary outline of a part: edges used by exactly ONE face of `target` (where
// the part meets non-selected faces or the mesh edge). Welds by quantised position
// so the trace is continuous across a non-indexed display geometry. `positions` is
// the non-indexed position array (9 floats per face). Endpoints are nudged slightly
// OUTWARD from the model centre (`inflate`) so the line sits just proud of the
// surface — with depthTest on, the back side is then occluded (no see-through web).
// Returns line-segment floats.
export function boundaryEdges(positions, faceParts, target, EPS = 1e-4, inflate = 0.004) {
  const k = (x, y, z) => `${Math.round(x / EPS)},${Math.round(y / EPS)},${Math.round(z / EPS)}`;
  const edges = new Map();
  for (let f = 0; f < faceParts.length; f++) {
    if (faceParts[f] !== target) continue;
    const o = f * 9;
    const v = [[positions[o], positions[o + 1], positions[o + 2]], [positions[o + 3], positions[o + 4], positions[o + 5]], [positions[o + 6], positions[o + 7], positions[o + 8]]];
    const vk = v.map(p => k(p[0], p[1], p[2]));
    for (let e = 0; e < 3; e++) {
      const a = e, b = (e + 1) % 3;
      const key = vk[a] < vk[b] ? `${vk[a]}|${vk[b]}` : `${vk[b]}|${vk[a]}`;
      const ex = edges.get(key);
      if (ex) ex.count++; else edges.set(key, { count: 1, a: v[a], b: v[b] });
    }
  }
  const push = p => { const l = Math.hypot(p[0], p[1], p[2]) || 1; const s = 1 + inflate / l; return [p[0] * s, p[1] * s, p[2] * s]; };
  const segs = [];
  for (const { count, a, b } of edges.values()) if (count === 1) { const A = push(a), B = push(b); segs.push(A[0], A[1], A[2], B[0], B[1], B[2]); }
  return segs.length ? new Float32Array(segs) : null;
}

// Re-index a simplified geometry so only the vertices the new index references
// remain (meshopt's simplify leaves the full vertex buffer otherwise).
function compactGeometry(geo, newIndex) {
  const used = new Map(), order = [];
  for (let i = 0; i < newIndex.length; i++) { const id = newIndex[i]; if (!used.has(id)) { used.set(id, order.length); order.push(id); } }
  const remapped = new Uint32Array(newIndex.length);
  for (let i = 0; i < newIndex.length; i++) remapped[i] = used.get(newIndex[i]);
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'uv', 'normal', 'color']) {
    const attr = geo.attributes[name]; if (!attr) continue;
    const is = attr.itemSize, src = attr.array, dst = new Float32Array(order.length * is);
    for (let i = 0; i < order.length; i++) { const o = order[i] * is; for (let k = 0; k < is; k++) dst[i * is + k] = src[o + k]; }
    out.setAttribute(name, new THREE.BufferAttribute(dst, is));
  }
  out.setIndex(new THREE.BufferAttribute(remapped, 1));
  return out;
}

// FAITHFUL export: clone the pristine textured scene, simplify each mesh while
// PRESERVING uv (so the texture still maps), downscale + JPEG-flag textures for
// mobile weight. Materials/textures are cloned first so the live preview is
// untouched. Returns a THREE.Group ready for GLTFExporter. (Recolourable-parts
// export is the other path — handled in the component from faceParts.)
export async function buildTexturedScene(srcGroup, targetTris, maxTex = 1024) {
  await MeshoptSimplifier.ready;
  const root = srcGroup.clone(true); // shares geometry/material refs — replaced below
  let total = 0;
  root.traverse(o => { if (o.isMesh && o.geometry) total += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  total = Math.max(1, total);

  const cloneMat = m => {
    if (!m) return m;
    const c = m.clone();
    for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
      if (c[slot]) { c[slot] = c[slot].clone(); c[slot].needsUpdate = true; }
    }
    return c;
  };

  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    o.material = Array.isArray(o.material) ? o.material.map(cloneMat) : cloneMat(o.material);
    let geo = o.geometry.index ? o.geometry : mergeVertices(o.geometry);
    const tris = geo.index.count / 3;
    const budget = Math.min(tris, Math.max(500, Math.round(targetTris * tris / total)));
    if (budget < tris) {
      const index = geo.index.array instanceof Uint32Array ? geo.index.array.slice() : new Uint32Array(geo.index.array);
      const positions = geo.attributes.position.array;
      let simp;
      if (geo.attributes.uv) {
        [simp] = MeshoptSimplifier.simplifyWithAttributes(index, positions, 3, geo.attributes.uv.array, 2, [1, 1], null, budget * 3, 0.5, ['LockBorder']);
      } else {
        [simp] = MeshoptSimplifier.simplify(index, positions, 3, budget * 3, 0.5);
      }
      geo = compactGeometry(geo, simp);
    }
    o.geometry = geo;
  });

  // downscale + JPEG-flag every unique texture (GLTFExporter defaults to PNG → huge)
  const seen = new Set();
  root.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(m => {
      if (!m) return;
      for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
        const t = m[slot];
        if (!t || seen.has(t)) continue;
        seen.add(t);
        const img = t.image, w = img && (img.width || img.videoWidth), h = img && (img.height || img.videoHeight);
        if (w && h) {
          const s = Math.min(1, maxTex / Math.max(w, h));
          if (s < 1) {
            const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
            const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
            cv.getContext('2d').drawImage(img, 0, 0, cw, ch);
            t.image = cv; t.needsUpdate = true;
          }
        }
        t.userData.mimeType = 'image/jpeg';
      }
    });
  });
  return root;
}
