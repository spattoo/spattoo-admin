import * as THREE from 'three';

// ── Splash / handkerchief "crown" vessel ─────────────────────────────────────────────────────────
// Procedural amber-glass showpiece (isomalt): a rounded bowl whose rim is pulled up into N tapering
// PEAKS, draping between them, edged by a rolled lip. Tuned in the admin studio, then ported to core.
// Pure function of the params → ONE watertight BufferGeometry, so the studio rebuilds live on a slider.
//
// The geometry is a real THIN SHELL, not a zero-thickness sheet:
//   mid-surface  →  outer = M + N·t(v)  ·  inner = M − N·t(v)  ·  rim = semicircular cap joining them.
// Shell thickness t(v) ramps up near the rim into the BEAD, so the rim cap is a semicircle of exactly
// the local half-thickness — i.e. the bead is tangent to both faces by construction (no crease, no
// separate rim tube to intersect the wall). A closed volume is also what `transmission` assumes: the
// old open sheet made `thickness` a meaningless scalar and stacked front/back faces into black creases.
//
// Shape notes (why the basis functions are what they are):
//   • A peak's profile is  t^sharpness  with  t = 1 − d/halfWidth.  At the apex (t→1) its slope is
//     `sharpness` ≠ 0 → a genuine POINT. At the flank (t→0) the slope is 0 for sharpness>1 → adjacent
//     sails meet C1-smooth in the valley. (The old basis smoothstepped FIRST, and smoothstep has zero
//     slope at 1, so no exponent could ever sharpen the apex — every peak came out a blunt plateau.)
//   • Height jitter scales each peak's HEIGHT, never the normalised field. (The old code multiplied the
//     0..1 field by jH and then clamped `min(1, s)`, so any peak with jH>1 saturated across a range of u
//     — a flat ridge, i.e. a knife-edge blade — and its extra height was silently discarded.)
//   • Valleys sit ABOVE the bowl shoulder, so the bowl stays a continuous closed vessel and the rim is
//     one unbroken curve. The floor is a SMOOTH max (not Math.max) — a hard clamp is a C1 discontinuity
//     and shows up as a crease ring.

// Seeded RNG (mulberry32) so per-peak jitter is reproducible for a given seed.
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
// C-infinity max — replaces Math.max where a hard corner would crease the surface.
const softMax = (a, b, eps = 2e-3) => 0.5 * (a + b + Math.sqrt((a - b) * (a - b) + eps));

export const SPLASH_DEFAULTS = {
  peaks:        6,     // number of pulled-up points
  peakHeight:   2.45,  // height of a peak tip above the origin plane
  valleyHeight: 0.85,  // rim height in the drape between peaks — ABOVE bowlBody → the bowl stays closed
  sharpness:    3.60,  // apex exponent: 1 = straight-sided cone, >1 = a NARROW FINGER with a sharp tip.
                       //   The reference's spikes are thin fingers with a broad membrane draping between
                       //   them; that shape is a fast falloff from the apex, i.e. a high exponent.
  sailWidth:    1.00,  // angular half-width of each sail (1 = sails exactly tile the circle)
  valleyVary:   0.30,  // amplitude of per-valley extra depth (each valley a DIFFERENT depth)
  valleyWidth:  0.80,  // angular width of each valley's dip
  baseRadius:   0.30,  // bowl DEPTH below the origin plane — the pole sits at y = −baseRadius
  rimRadius:    0.95,  // bowl body radius (the widest part)
  flare:        0.14,  // extra body width in the valleys vs the peaks
  spread:       0.34,  // tip splay: >0 flares sails OUTWARD (splash), <0 pinches inward
  bowlBody:     0.50,  // height of the rounded bowl body — the shoulder the fingers rise from
  wallCurve:    1.05,  // vertical easing (>1 pushes height up → taller, thinner spikes)
  jitter:       0.14,  // per-peak height/width/angle randomness (hand-pulled irregularity)
  lean:         0.08,  // tip drift, as a fraction of rimRadius (bounded — see leanAt)
  leanOut:      0.70,  // 1 = tips lean purely radially outward, 0 = purely random direction
  wall:         0.045, // shell thickness (world units) away from the rim
  bead:         2.80,  // rim thickness multiplier — the rolled lip is `bead`× the wall. Keep the resulting
                       //   cap radius (wall/2 × bead) BELOW the rim curve's radius of curvature at a peak
                       //   apex, or the swept cap self-intersects across the cusp — the notch at a tip.
  beadWidth:    0.10,  // fraction of the wall height over which thickness ramps into the bead
  seed:         3,
  segU:         256,   // angular segments (rim smoothness)
  segV:         80,    // vertical segments
  beadSeg:      10,    // segments around the rim's semicircular cap
};

// Returns { geometry: BufferGeometry, rim: Vector3[] } — `rim` is the mid-surface top edge (for callers
// that want to attach something to the lip). The bead is part of `geometry`; there is no separate tube.
export function buildSplashCrown(params = {}) {
  const o = { ...SPLASH_DEFAULTS, ...params };
  const rand = rng(o.seed);
  const { peaks, segU, segV, beadSeg } = o;

  // Per-peak AND per-valley jitter so it reads HAND-PULLED, not machine-regular. All seeded.
  const jH = [], jA = [], jW = [], jLx = [], jLz = [], jVd = [], jVa = [];
  for (let k = 0; k < peaks; k++) {
    jH.push(1 + (rand() * 2 - 1) * o.jitter);                  // scales this peak's HEIGHT (not the field)
    jA.push((rand() * 2 - 1) * o.jitter * (Math.PI / peaks));  // angular wobble of the peak
    jW.push(1 + (rand() * 2 - 1) * o.jitter * 0.7);            // this peak's angular width
    const ang = rand() * Math.PI * 2;
    jLx.push(Math.cos(ang)); jLz.push(Math.sin(ang));          // this peak's random lean direction
    jVd.push(rand());                                          // 0..1 depth of valley k (each different)
    jVa.push((rand() * 2 - 1) * o.jitter * (Math.PI / peaks)); // valley centre wobble
  }
  const centerOf = (k) => (k / peaks) * Math.PI * 2 + jA[k];
  const halfWOf  = (k) => (Math.PI / peaks) * o.sailWidth * jW[k];
  const angDist  = (a, b) => { const d = Math.abs(a - b); return Math.min(d, Math.PI * 2 - d); };

  // Peak k's normalised influence at angle u: t^sharpness, t = 1 − d/halfWidth. Sharp at the apex,
  // flat-tangent at the flank → sharp tips, C1 valleys. Zero outside the sail.
  const sailK = (u, k) => {
    const hw = halfWOf(k), d = angDist(u, centerOf(k));
    if (d >= hw) return 0;
    return Math.pow(1 - d / hw, o.sharpness);
  };
  // A curved dip centred in each valley, scaled by that valley's own random depth → the valleys
  // undulate at DIFFERENT depths, not one uniform floor.
  const valleyDip = (u) => {
    let s = 0;
    const vw = (Math.PI / peaks) * o.valleyWidth;
    for (let k = 0; k < peaks; k++) {
      const vc = ((k + 0.5) / peaks) * Math.PI * 2 + jVa[k];
      const d = angDist(u, vc);
      if (d < vw) { const b = smoothstep(1 - d / vw) * jVd[k]; if (b > s) s = b; }
    }
    return s;
  };

  // ── Per-column (per-u) profile: rim height, sail field, body radius, lean direction ──────────────
  const colH = new Float64Array(segU);   // rim height of this column
  const colS = new Float64Array(segU);   // max sail field 0..1 (1 at a peak apex, 0 in a valley)
  const colR = new Float64Array(segU);   // body radius
  const colLx = new Float64Array(segU), colLz = new Float64Array(segU), colLw = new Float64Array(segU);
  const floor = o.bowlBody * 1.02;       // valleys never cut into the bowl → the vessel stays closed

  for (let i = 0; i < segU; i++) {
    const u = (i / segU) * Math.PI * 2;
    let hMax = o.valleyHeight, sMax = 0, wSum = 0, lx = 0, lz = 0;
    for (let k = 0; k < peaks; k++) {
      const s = sailK(u, k);
      if (s <= 0) continue;
      const h = o.valleyHeight + (o.peakHeight * jH[k] - o.valleyHeight) * s;
      if (h > hMax) hMax = h;
      if (s > sMax) sMax = s;
      // Lean direction is BLENDED across peaks by their influence, so it can't jump where the
      // nearest-peak changes (a piecewise-constant direction would tear the sheet at the sail boundary).
      const ck = centerOf(k);
      const dx = o.leanOut * Math.cos(ck) + (1 - o.leanOut) * jLx[k];
      const dz = o.leanOut * Math.sin(ck) + (1 - o.leanOut) * jLz[k];
      lx += dx * s; lz += dz * s; wSum += s;
    }
    const h = softMax(hMax - o.valleyVary * valleyDip(u), floor);
    colH[i] = h;
    colS[i] = clamp01(sMax);
    colR[i] = o.rimRadius + o.flare * (1 - colS[i]);
    const len = Math.hypot(lx, lz) || 1;
    colLx[i] = lx / len; colLz[i] = lz / len;
    colLw[i] = clamp01(wSum);   // no lean in the valleys (wSum→0), full lean at an apex
  }

  // Profile: the form is BOWL-then-SPIKES, never a cone. `v` ∈ [0,1] runs pole → rim, and the first
  // BOWL_V of it is spent on the bowl.
  //
  // The bowl is swept by ARC ANGLE, not by height: r = br·sin(a), y = yPole + span·(1 − cos a). Near the
  // pole r ≈ br·a — linear, so ring 1 sits just off the pole. Distributing rings by HEIGHT instead makes
  // r ∝ √(…), which has a vertical tangent at the pole: ring 1 lands at r ≈ 0.25·br and the pole fan
  // becomes a wide flat cone whose normals converge — that is the starburst at the bottom of the bowl.
  //
  // Above the shoulder the wall runs near-vertical, splaying outward only near the tip (tt² keeps the
  // shoulder crisp). C1 at the join: the bowl arrives horizontal (a = π/2) and the wall leaves vertical.
  const yPole = -o.baseRadius;
  const BOWL_V = 0.42;                         // fraction of the rings spent on the bowl
  function profile(i, v, hMax) {
    const br = colR[i], sh = o.bowlBody;
    if (v <= BOWL_V) {
      const a = (v / BOWL_V) * (Math.PI / 2);
      return { y: yPole + (sh - yPole) * (1 - Math.cos(a)), r: br * Math.sin(a) };
    }
    const tt = Math.pow((v - BOWL_V) / (1 - BOWL_V), o.wallCurve);
    return { y: sh + (hMax - sh) * tt, r: br * (1 + o.spread * tt * tt) };
  }
  // Lateral tip drift, bounded by lean·rimRadius (the old `lean·above²` was unbounded and hit 0.62 —
  // 62% of the bowl radius — which is what toppled the spikes into each other).
  function leanAt(i, y) {
    const sh = o.bowlBody;
    if (y <= sh || o.lean <= 0) return 0;
    const t = clamp01((y - sh) / Math.max(1e-3, o.peakHeight - sh));
    return o.lean * o.rimRadius * t * t * colLw[i];
  }

  // ── Mid-surface ─────────────────────────────────────────────────────────────────────────────────
  // No duplicated seam column: the ring wraps via (i+1)%segU, so computeVertexNormals averages across
  // u=0 like any other edge. (A duplicated-but-coincident column gets its own normals → a seam crease.)
  // Rings j = 1..segV plus ONE pole vertex at the bottom (sphere-cap topology, no flat fan).
  const ringVerts = segU * segV;
  const midCount  = ringVerts + 1;
  const POLE_M    = ringVerts;
  const rIdx = (i, j) => (j - 1) * segU + (i % segU);
  const mid = new Float32Array(midCount * 3);
  for (let j = 1; j <= segV; j++) {
    const v = j / segV;
    for (let i = 0; i < segU; i++) {
      const u = (i / segU) * Math.PI * 2;
      const hMax = colH[i];
      const { y, r } = profile(i, v, hMax);
      const amt = leanAt(i, y);
      const p = rIdx(i, j) * 3;
      mid[p]     = r * Math.cos(u) + colLx[i] * amt;
      mid[p + 1] = y;
      mid[p + 2] = r * Math.sin(u) + colLz[i] * amt;
    }
  }
  mid[POLE_M * 3 + 1] = yPole;

  // Mid-surface normals, via a throwaway geometry (indices wrap, so the seam is seamless).
  const midIdx = [];
  for (let j = 1; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = rIdx(i, j), b = rIdx(i + 1, j), c = rIdx(i, j + 1), d = rIdx(i + 1, j + 1);
      midIdx.push(a, c, b, b, c, d);
    }
  }
  for (let i = 0; i < segU; i++) midIdx.push(POLE_M, rIdx(i + 1, 1), rIdx(i, 1));
  const midGeo = new THREE.BufferGeometry();
  midGeo.setAttribute('position', new THREE.BufferAttribute(mid, 3));
  midGeo.setIndex(midIdx);
  midGeo.computeVertexNormals();
  const N = midGeo.attributes.normal.array;
  midGeo.dispose();

  // Orient outward: sample a mid-wall vertex and compare its normal with the radial direction.
  const probe = rIdx(0, Math.max(1, Math.floor(segV * 0.5))) * 3;
  const outward = (N[probe] * mid[probe] + N[probe + 2] * mid[probe + 2]) >= 0 ? 1 : -1;

  // Shell half-thickness at height fraction v: constant `wall/2`, ramping into the bead near the rim.
  // The rim cap is then a semicircle of exactly this radius → tangent to both faces, no crease.
  const halfT = (v) => {
    const ramp = smoothstep((v - (1 - o.beadWidth)) / o.beadWidth);
    return 0.5 * o.wall * (1 + (o.bead - 1) * ramp);
  };

  // ── Shell: outer + inner + rim bead ─────────────────────────────────────────────────────────────
  const OUT = 0;                         // outer ring verts   [0, ringVerts)
  const OUT_P = ringVerts;               // outer pole
  const IN = ringVerts + 1;              // inner ring verts
  const IN_P = IN + ringVerts;           // inner pole
  const BEAD = IN_P + 1;                 // (beadSeg-1) intermediate rings of the rim cap
  const total = BEAD + (beadSeg - 1) * segU;

  const pos = new Float32Array(total * 3);
  const put = (idx, x, y, z) => { pos[idx * 3] = x; pos[idx * 3 + 1] = y; pos[idx * 3 + 2] = z; };

  for (let j = 1; j <= segV; j++) {
    const t = halfT(j / segV);
    for (let i = 0; i < segU; i++) {
      const m = rIdx(i, j), p = m * 3;
      const nx = N[p] * outward, ny = N[p + 1] * outward, nz = N[p + 2] * outward;
      put(OUT + m, mid[p] + nx * t, mid[p + 1] + ny * t, mid[p + 2] + nz * t);
      put(IN + m,  mid[p] - nx * t, mid[p + 1] - ny * t, mid[p + 2] - nz * t);
    }
  }
  {
    const p = POLE_M * 3, t = halfT(0);
    const nx = N[p] * outward, ny = N[p + 1] * outward, nz = N[p + 2] * outward;
    put(OUT_P, mid[p] + nx * t, mid[p + 1] + ny * t, mid[p + 2] + nz * t);
    put(IN_P,  mid[p] - nx * t, mid[p + 1] - ny * t, mid[p + 2] - nz * t);
  }

  // Rim cap: sweep a semicircle from the outer edge (φ=0) to the inner edge (φ=π), bulging along B — the
  // direction off the edge, in the surface, perpendicular to N.
  //
  // B is derived from the WALL direction (rim vertex minus the row below it), projected perpendicular to N.
  // It must NOT come from cross(rimTangent, N): at a peak apex the rim curve has a CUSP, so the tangent
  // (next − prev) collapses toward zero and its direction flips across the tip. That flip twists the cap
  // through 180° over one segment — the notch at the top of a peak.
  const rimT = halfT(1);
  const rim = [];
  const vN = new THREE.Vector3(), vB = new THREE.Vector3(), vUp = new THREE.Vector3();
  const pHere = new THREE.Vector3(), pBelow = new THREE.Vector3();
  for (let i = 0; i < segU; i++) {
    const m = rIdx(i, segV), p = m * 3;
    pHere.set(mid[p], mid[p + 1], mid[p + 2]);
    rim.push(pHere.clone());
    const pb = rIdx(i, segV - 1) * 3;
    pBelow.set(mid[pb], mid[pb + 1], mid[pb + 2]);
    vN.set(N[p] * outward, N[p + 1] * outward, N[p + 2] * outward).normalize();
    vUp.copy(pHere).sub(pBelow);
    vB.copy(vUp).addScaledVector(vN, -vUp.dot(vN));            // project the wall direction onto the surface
    if (vB.lengthSq() < 1e-12) vB.set(0, 1, 0).addScaledVector(vN, -vN.y);  // degenerate guard
    vB.normalize();
    for (let m2 = 1; m2 < beadSeg; m2++) {
      const phi = (m2 / beadSeg) * Math.PI;
      const c = Math.cos(phi), s = Math.sin(phi);
      put(BEAD + (m2 - 1) * segU + i,
        pHere.x + rimT * (c * vN.x + s * vB.x),
        pHere.y + rimT * (c * vN.y + s * vB.y),
        pHere.z + rimT * (c * vN.z + s * vB.z));
    }
  }

  // ── Faces ───────────────────────────────────────────────────────────────────────────────────────
  const idx = [];
  const quad = (a, b, c, d) => idx.push(a, c, b, b, c, d);         // outer winding
  const quadR = (a, b, c, d) => idx.push(a, b, c, b, d, c);        // reversed (inner faces point inward)

  for (let j = 1; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = rIdx(i, j), b = rIdx(i + 1, j), c = rIdx(i, j + 1), d = rIdx(i + 1, j + 1);
      quad(OUT + a, OUT + b, OUT + c, OUT + d);
      quadR(IN + a, IN + b, IN + c, IN + d);
    }
  }
  for (let i = 0; i < segU; i++) {
    idx.push(OUT_P, OUT + rIdx(i + 1, 1), OUT + rIdx(i, 1));
    idx.push(IN_P,  IN + rIdx(i, 1),      IN + rIdx(i + 1, 1));
  }
  // Bead rings: ring 0 = outer rim row, ring beadSeg = inner rim row, the rest are the cap's own verts.
  const beadRing = (m2, i) => (
    m2 === 0 ? OUT + rIdx(i, segV)
      : m2 === beadSeg ? IN + rIdx(i, segV)
        : BEAD + (m2 - 1) * segU + (i % segU)
  );
  for (let m2 = 0; m2 < beadSeg; m2++) {
    for (let i = 0; i < segU; i++) {
      quad(beadRing(m2, i), beadRing(m2, i + 1), beadRing(m2 + 1, i), beadRing(m2 + 1, i + 1));
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setIndex(idx);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return { geometry, rim };
}
