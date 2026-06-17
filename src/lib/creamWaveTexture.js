import * as THREE from 'three';

// Procedural CREAM-WAVE surface — the soft horizontal "spatula-combed buttercream" ridges.
//
// The wave is defined ONCE as a height field h(u,v) ∈ [0,1] (`makeCreamWaveField`). From that single
// definition we can derive EITHER:
//   • a tangent-space NORMAL map (gradient of h) — cheap, fakes the lighting on a smooth cylinder,
//     but leaves the SILHOUETTE flat (the waves never actually project), or
//   • REAL geometry displacement (`displaceCreamWaveCylinder`) — pushes the wall out by relief·h so
//     the ribs genuinely stand proud and break the silhouette, exactly like the Meshy reference.
// Both read the same field, so the fake-lit and true-geometry surfaces describe the same shape.
//
// UV convention (matches THREE.CylinderGeometry's side UVs): U wraps AROUND the cake (0→1 once),
// V runs UP the wall (0→1). Ridges vary with V → horizontal bands; the wave is a U-dependent phase
// shift → the bands undulate as they wrap. `lobes` is an integer so U=0 meets U=1 seamlessly.

const cache = new Map();

// Shared wave FIELD. Deterministic (no Math.random) so it is reproducible and cacheable.
//   height(u,v) → ribbon height ∈ [0,1]: overlapping cosine ribbons, one per band; each band's
//     undulation is phase-shifted by `bandPhase` so adjacent bands interleave and pinch (the braid).
//   reliefMask(v) → vertical 0..1 multiplier for the "top falloff" (waves fade toward the rim).
export function makeCreamWaveField({ ridges, lobes, waveAmp, noiseAmt, ribbonW, driftAmt, bandPhase, falloff }) {
  const TAU = Math.PI * 2;
  // Tileable value noise (wraps in both axes) — the organic irregularity in hand combing.
  const L = 16;
  const rand = new Float32Array(L * L);
  let s = 1234567;
  const next = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < L * L; i++) rand[i] = next();
  const latt = (xi, yi) => rand[((yi % L + L) % L) * L + ((xi % L + L) % L)];
  const smooth = t => t * t * (3 - 2 * t);
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const tx = smooth(x - xi), ty = smooth(y - yi);
    const a = latt(xi, yi),     b = latt(xi + 1, yi);
    const c = latt(xi, yi + 1), d = latt(xi + 1, yi + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };

  // OVERLAPPING-STROKE edge lines. Real combed buttercream is smoothed horizontal strokes, each
  // lapping over the one below — so every band boundary is a thin ASYMMETRIC line: a small proud LIP
  // just above (the upper stroke's edge) and a thin recessed GROOVE just below (the crevice shadow),
  // on an otherwise flat wall. We model each line as the DERIVATIVE OF A GAUSSIAN of the signed
  // distance d to the line: +lip for d>0, −groove for d<0, with ZERO net displacement — so the wall
  // stays cylindrical (no cumulative outward drift over many bands) and the lines read as overlap
  // shadows, NOT piped rope. `ribbonW` is the line half-width in band-cycles (small = thin lines).
  // Each line `m` carries its own wave, phase-shifted by `bandPhase` per band so the lines interleave
  // and braid. Spacing wobbles subtly with height (V only — no vertical crease).
  const w = Math.max(0.02, ribbonW);
  const height = (u, v) => {
    const driftPhase = driftAmt * (noise(3.1, v * 4) * 2 - 1);
    const spacing = noiseAmt * (noise(7.3, v * 5) * 2 - 1);
    const vr = v * ridges + spacing;                              // height in band-cycles
    const mBase = Math.floor(vr);
    let h = 0;
    for (let m = mBase - 1; m <= mBase + 2; m++) {
      const waveM = waveAmp * Math.sin(TAU * u * lobes + m * bandPhase + TAU * driftPhase);
      const d = vr - m - waveM;                                   // signed distance to line m (up = +)
      h += (d / w) * Math.exp(-(d * d) / (2 * w * w));            // derivative-of-gaussian: lip above, groove below
    }
    return h;                                                     // centered ~0; peaks ±~0.6
  };

  // Top falloff: relief fades toward the top (no fade in the bottom 30%, then ease out).
  const ss = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const reliefMask = (v) => 1 - falloff * ss(0.3, 1.0, v);
  return { height, reliefMask };
}

function buildCreamWaveNormalMap({ size, ridges, lobes, waveAmp, noiseAmt, relief, ribbonW, driftAmt, falloff, bandPhase }) {
  const TAU = Math.PI * 2;
  const { height, reliefMask } = makeCreamWaveField({ ridges, lobes, waveAmp, noiseAmt, ribbonW, driftAmt, bandPhase, falloff });
  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) H[y * size + x] = height(x / size, y / size);

  // Gradient → tangent-space normal map. Central difference brought to per-UV-unit (× size), then
  // de-frequencied by the ridge count so per-ridge steepness is constant — `relief` is the single
  // soft-relief knob. Neighbours wrap so the seam around U is invisible.
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => H[((y % size) + size) % size * size + (((x % size) + size) % size)];
  const k = relief / (TAU * ridges);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const v = y / size;
    const mask = reliefMask(v);
    const du = (at(x + 1, y) - at(x - 1, y)) * 0.5 * size;
    const dv = (at(x, y + 1) - at(x, y - 1)) * 0.5 * size;
    const nx = -du * k * mask, ny = -dv * k * mask, nz = 1;
    const len = Math.hypot(nx, ny, nz);
    const o = (y * size + x) * 4;
    data[o]     = Math.round((nx / len * 0.5 + 0.5) * 255);
    data[o + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
    data[o + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
    data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

// Cached per (rounded) parameter set. `relief` baked here is gentle; the material's normalScale
// (the screen's "Depth" slider) gives a final live multiplier without rebuilding the texture.
export function getCreamWaveNormalMap({
  size = 512, ridges = 6, lobes = 2, waveAmp = 0.35, noiseAmt = 0.12, relief = 1.0, ribbonW = 0.05, driftAmt = 0.08, falloff = 0.4, bandPhase = 0.9 * Math.PI,
} = {}) {
  const key = [size, ridges, lobes, waveAmp.toFixed(2), noiseAmt.toFixed(2), relief.toFixed(2), ribbonW.toFixed(2), driftAmt.toFixed(2), falloff.toFixed(2), bandPhase.toFixed(3)].join('|');
  if (!cache.has(key)) cache.set(key, buildCreamWaveNormalMap({ size, ridges, lobes, waveAmp, noiseAmt, relief, ribbonW, driftAmt, falloff, bandPhase }));
  return cache.get(key);
}

// Fine, tileable MICRO-GRAIN normal map — the soft sugar-paste/buttercream surface texture that
// makes the smooth wall read as cream rather than glossy plastic. Carries bumps only (no colour);
// tile it many times (repeat) over the cake so the grain stays small. Same value-noise → Sobel →
// tangent-normal recipe as the fondant grain. Cached.
let _grain = null;
export function getCreamGrainNormalMap(size = 256, strength = 0.5) {
  if (_grain) return _grain;
  const L = 24;
  const rand = new Float32Array(L * L);
  let s = 99173;
  const next = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < L * L; i++) rand[i] = next();
  const latt = (xi, yi) => rand[((yi % L + L) % L) * L + ((xi % L + L) % L)];
  const smooth = t => t * t * (3 - 2 * t);
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const tx = smooth(x - xi), ty = smooth(y - yi);
    const a = latt(xi, yi), b = latt(xi + 1, yi), c = latt(xi, yi + 1), d = latt(xi + 1, yi + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size * L, v = y / size * L;
    H[y * size + x] = noise(u, v) * 0.6 + noise(u * 2.3, v * 2.3) * 0.4;
  }
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => H[((y % size) + size) % size * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength * size * 0.02;
    const dy = (at(x, y + 1) - at(x, y - 1)) * strength * size * 0.02;
    const nx = -dx, ny = -dy, nz = 1, len = Math.hypot(nx, ny, nz), o = (y * size + x) * 4;
    data[o] = Math.round((nx / len * 0.5 + 0.5) * 255);
    data[o + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
    data[o + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
    data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  _grain = tex;
  return tex;
}

// REAL relief: displace a cylinder's side wall outward by the wave field so the ribs genuinely
// project and break the silhouette (a normal map cannot). Only side vertices (near-horizontal
// normal) move, radially; caps stay flat. Normals are recomputed so shading is real, not faked.
// `relief` is in WORLD units (e.g. 0.04 ≈ 4% of a radius-1 cake, matching the shallow Meshy ripple).
// The cylinder must be well tessellated (high radial + height segments) to resolve the waves.
export function displaceCreamWaveCylinder(geometry, { relief = 0.03, ...fieldOpts } = {}) {
  const field = makeCreamWaveField({
    ridges: 6, lobes: 2, waveAmp: 0.35, noiseAmt: 0.12, ribbonW: 0.05, driftAmt: 0.08, bandPhase: 0.9 * Math.PI, falloff: 0.4,
    ...fieldOpts,
  });
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const yMin = bb.min.y, yH = (bb.max.y - bb.min.y) || 1;
  const TAU = Math.PI * 2;
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(nor, i);
    if (Math.abs(n.y) > 0.5) continue;                            // cap vertex — leave flat
    p.fromBufferAttribute(pos, i);
    const r = Math.hypot(p.x, p.z) || 1e-6;
    const u = (Math.atan2(p.z, p.x) / TAU) + 0.5;                 // 0..1 around
    const v = (p.y - yMin) / yH;                                  // 0..1 up
    const d = relief * field.height(u, v) * field.reliefMask(v);
    const sc = (r + d) / r;
    pos.setXYZ(i, p.x * sc, p.y, p.z * sc);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}
