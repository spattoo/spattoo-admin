import { useState, useMemo, useEffect, useRef, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment, RoundedBox } from '@react-three/drei';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { fetchAllElements, fetchElementTypes, createGlobalElement, getSignedUploadUrl, uploadToR2 } from '../lib/api';
import { normalizeThumbnail } from '../lib/thumbnail.js';

const DEG = Math.PI / 180;

// Cream "softness" → material. MUST stay identical to creamMaterialProps() in
// spattoo-core CakeTier.jsx so this preview matches the designer exactly. 0 = glossy/wet,
// 1 = matte/whipped; the default 0.7 reproduces the original look (roughness 0.85, sheen 0.4).
const PIPING_SOFTNESS_DEFAULT = 0.7;
function creamMaterialProps(softness, color) {
  const s = Math.min(1, Math.max(0, softness ?? PIPING_SOFTNESS_DEFAULT));
  return {
    color,
    roughness:      0.5 + 0.5 * s,
    sheen:          (0.4 / 0.7) * s,
    sheenRoughness: 0.9,
    sheenColor:     color,
  };
}

// Bend a flat ring into `swagCount` scalloped drapes (garland/swag look).
// MUST stay identical to buildSwagRing() in spattoo-core CakeTier.jsx so this
// preview matches the designer exactly. Shells are spaced by arc-length along the
// draped curve; tq pitches each about the world radial axis to follow the slope.
function buildSwagRing({ r, baseY, step, swagCount, swagDepth, swagTilt = 0.5 }) {
  const dipAt = a => -swagDepth * (1 - Math.cos(a * swagCount)) / 2;
  const N = 1440;
  const cum = [0];
  let px = r, py = baseY + dipAt(0), pz = 0;
  for (let s = 1; s <= N; s++) {
    const a = (s / N) * Math.PI * 2;
    const cx = Math.cos(a) * r, cy = baseY + dipAt(a), cz = Math.sin(a) * r;
    cum.push(cum[s - 1] + Math.hypot(cx - px, cy - py, cz - pz));
    px = cx; py = cy; pz = cz;
  }
  const total = cum[N];
  const count = Math.max(6, Math.round(total / step));
  const out = [];
  let seg = 0;
  for (let j = 0; j < count; j++) {
    const target = (j / count) * total;
    while (seg < N && cum[seg + 1] < target) seg++;
    const a0 = (seg / N) * Math.PI * 2, a1 = ((seg + 1) / N) * Math.PI * 2;
    const f  = (target - cum[seg]) / Math.max(1e-9, cum[seg + 1] - cum[seg]);
    const a  = a0 + (a1 - a0) * f;
    const slope = -(swagDepth * swagCount / 2) * Math.sin(a * swagCount);
    const tilt  = -swagTilt * Math.atan2(slope, r);
    const sh = Math.sin(tilt / 2), ch = Math.cos(tilt / 2);
    const tq = [Math.cos(a) * sh, 0, Math.sin(a) * sh, ch];
    out.push({ pos: [Math.cos(a) * r, baseY + dipAt(a), Math.sin(a) * r], rotY: a, tq });
  }
  return out;
}

// Match the designer's default cake so the calibrator is to scale.
const CAKE_RADIUS = 1.2;   // designer TIER_RADII[0]
const CAKE_HEIGHT = 1.45;  // designer BOTTOM_H
const Y_BASE      = 0.1;   // top of board (designer BOTTOM_BASE)
const SWAG_LIFT   = 0.55;  // attachment height the festoon hangs from when swag is first enabled

// ── Sheet (rectangular) cake samples ──────────────────────────────────────────
// Preview-only: lets you check the pattern on a sheet cake as well as the round one.
// Standard US bakery sizes (w × d inches), scaled so the half sheet's long side reads
// at roughly the round cake's footprint (diameter 2.4). w = long side (world X), d = short (Z).
const SHEET_INCH_TO_WORLD = 0.12;
const inToW = (n) => +(n * SHEET_INCH_TO_WORLD).toFixed(3);
const SHEET_SIZES = [
  { key: 'quarter', label: 'Quarter', inches: '9×13',  w: inToW(13), d: inToW(9)  },
  { key: 'half',    label: 'Half',    inches: '13×18', w: inToW(18), d: inToW(13) },
  { key: 'full',    label: 'Full',    inches: '18×26', w: inToW(26), d: inToW(18) },
];
const SHEET_CORNER_R = 0.14;   // fillet on the sheet cake's vertical corners

// Build the rounded-rect perimeter for a sheet `shape` ({ halfW, halfD, cornerR }) or
// null for a circle. Exposes { length, at(s) → { x, z, nx, nz } } where (nx,nz) is the
// unit OUTWARD normal — the shell's facing is atan2(nz,nx), so on a circle this reduces
// to the same polar angle the round ring already uses.
function roundedRectPerimeter(halfW, halfD, cornerR) {
  const cr = Math.max(0, Math.min(cornerR, halfW, halfD));
  const sx = halfW - cr, sz = halfD - cr;
  const A = (Math.PI / 2) * cr, HP = Math.PI / 2;
  const line = (x0, z0, x1, z1, nx, nz) => ({
    len: Math.hypot(x1 - x0, z1 - z0),
    at: (u) => ({ x: x0 + (x1 - x0) * u, z: z0 + (z1 - z0) * u, nx, nz }),
  });
  const arc = (cx, cz, a0, a1) => ({
    len: A,
    at: (u) => { const a = a0 + (a1 - a0) * u, nx = Math.cos(a), nz = Math.sin(a);
                 return { x: cx + cr * nx, z: cz + cr * nz, nx, nz }; },
  });
  // Start at front-centre (0,+halfD), wind once around. s=0 is the cake front (+Z).
  const segs = [
    line(0, halfD, sx, halfD, 0, 1),
    arc(sx, sz, HP, 0),
    line(halfW, sz, halfW, -sz, 1, 0),
    arc(sx, -sz, 0, -HP),
    line(sx, -halfD, -sx, -halfD, 0, -1),
    arc(-sx, -sz, -HP, -Math.PI),
    line(-halfW, -sz, -halfW, sz, -1, 0),
    arc(-sx, sz, Math.PI, HP),
    line(-sx, halfD, 0, halfD, 0, 1),
  ];
  const length = segs.reduce((t, s) => t + s.len, 0);
  return {
    length,
    at(s) {
      let d = ((s % length) + length) % length;
      for (let k = 0; k < segs.length; k++) {
        if (d <= segs[k].len || k === segs.length - 1) return segs[k].at(segs[k].len ? d / segs[k].len : 0);
        d -= segs[k].len;
      }
      return segs[0].at(0);
    },
  };
}

// ── Bend a straight strip GLB into U-shaped festoons (swags) on the cake wall ──
// One strip = one swag, its whole mesh bent into a U (belly hangs, ends attach high).
// Returns an array of bent geometries (one per festoon around the cake). The SAME
// math is mirrored in the designer (CakeTier.jsx) so the preview matches.
// Build a FRESH plain (non-interleaved, de-normalized) Float32 world-space buffer instead of
// cloning the mesh geometry — meshopt/quantized GLBs use interleaved + normalised attributes
// that must NOT be cloned-and-mutated (it can corrupt the cached useGLTF buffer). MUST match
// bakeStrip in spattoo-core festoon.js.
function bakeStrip(scene, flip) {
  scene.updateMatrixWorld(true);
  let mesh = null;
  scene.traverse(o => { if (o.isMesh && !mesh) mesh = o; });
  if (!mesh) return null;
  const pos = mesh.geometry.attributes.position;
  const arr = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z;
  }
  const src = new THREE.BufferGeometry();
  src.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  if (mesh.geometry.index) src.setIndex(mesh.geometry.index.clone());
  if (flip) src.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI));
  src.computeBoundingBox();
  return src;
}

// `tilt` (radians) ROLLS each segment about the rope's length so the strip leans instead of
// facing dead-on — the natural draped look of a piped rope swag (vs a flat-facing ribbon).
function bendOneFestoon(srcGeo, { th0, span, depth, attachY, radius, tilt = 0 }) {
  const g = srcGeo.clone();
  g.computeBoundingBox();
  const bb = g.boundingBox, min = bb.min.clone(), size = new THREE.Vector3(); bb.getSize(size);
  const ax = ['x', 'y', 'z'];
  const lenAxis = ax.reduce((a, b) => (size[b] > size[a] ? b : a), 'x'); // longest = strip length
  const cross = ax.filter(a => a !== lenAxis);
  const L = size[lenAxis];
  const uscale = (span * radius) / L; // stretch cross-section like the length → bumps stay proportional
  const outAxis = size[cross[0]] >= size[cross[1]] ? cross[0] : cross[1]; // bump axis (sticks out)
  const widthAxis = outAxis === cross[0] ? cross[1] : cross[0];
  const cOut = min[outAxis] + size[outAxis] / 2, cW = min[widthAxis] + size[widthAxis] / 2;
  const outHalf = (size[outAxis] / 2) * uscale;
  const R = radius + outHalf; // sit proud of the wall
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const pos = g.attributes.position, v = new THREE.Vector3();
  const curve = t => {
    const th = th0 + (t - 0.5) * span;
    const cy = attachY - depth * (1 - Math.pow(2 * t - 1, 2)); // U: belly at t=0.5, ends at attachY
    return { p: new THREE.Vector3(Math.cos(th) * R, cy, Math.sin(th) * R), th };
  };
  for (let i = 0; i < pos.count; i++) {
    const comp = { x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i) };
    const t = (comp[lenAxis] - min[lenAxis]) / L;
    const oOut = (comp[outAxis] - cOut) * uscale, oW = (comp[widthAxis] - cW) * uscale;
    const cur = curve(t), nxt = curve(Math.min(1, t + 1e-3)), prv = curve(Math.max(0, t - 1e-3));
    const T = new THREE.Vector3().subVectors(nxt.p, prv.p).normalize();      // tangent along the U
    const Rhat0 = new THREE.Vector3(Math.cos(cur.th), 0, Math.sin(cur.th));  // radial out (bumps)
    const B0 = new THREE.Vector3().crossVectors(T, Rhat0).normalize();       // in-wall perpendicular
    // Roll the (out, width) cross-section frame about the tangent by `tilt` → the lean.
    const Rhat = Rhat0.clone().multiplyScalar(ct).addScaledVector(B0, st);
    const B    = B0.clone().multiplyScalar(ct).addScaledVector(Rhat0, -st);
    v.copy(cur.p).addScaledVector(Rhat, oOut).addScaledVector(B, oW);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

function buildFestoons(scene, { flip, festoons, depth, attachY, radius, spread = 0.96, tilt = 0 }) {
  const src = bakeStrip(scene, flip);
  if (!src) return [];
  const span = (2 * Math.PI / festoons) * spread; // each U spans its share of the ring (small gap)
  return Array.from({ length: festoons }, (_, k) =>
    bendOneFestoon(src, { th0: Math.PI / 2 + k * (2 * Math.PI / festoons), span, depth, attachY, radius, tilt }));
}

// ── Wrap a pre-formed RING GLB around the wall (round OR rect) ─────────────────
// MUST stay identical to circlePerimeter / buildWrapBand in spattoo-core (surface.js /
// festoon.js) so this preview matches the cake. A vertex at angle θ around the ring maps to
// fraction f=θ/2π of the tier perimeter, displaced out by its radial profile and lifted by
// its height — so a ring GLB hugs a round wall as a circle and a sheet wall as a rounded-rect.
function circlePerimeter(r) {
  return { length: 2 * Math.PI * r, at(s) { const a = s / r, nx = Math.cos(a), nz = Math.sin(a); return { x: nx * r, z: nz * r, nx, nz }; } };
}
function wallPerimeter(shape) {
  return shape?.kind === 'rect' ? roundedRectPerimeter(shape.halfW, shape.halfD, shape.cornerR) : circlePerimeter(CAKE_RADIUS);
}
function buildWrapBand(scene, { perim, anchorY = 0, heightFrac = 0.4, sizeFactor = 1, radius = CAKE_RADIUS, outset = 0.01, tilt = 0 }) {
  const g = bakeStrip(scene, false);
  if (!g || !perim) return null;
  g.computeBoundingBox();
  let size = new THREE.Vector3(); g.boundingBox.getSize(size);
  const thin = (size.x <= size.y && size.x <= size.z) ? 'x' : (size.z <= size.y ? 'z' : 'y');
  if (thin === 'x') g.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
  else if (thin === 'z') g.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  g.computeBoundingBox();
  const c = new THREE.Vector3(); g.boundingBox.getCenter(c);
  g.translate(-c.x, 0, -c.z);
  g.computeBoundingBox();
  const yMin = g.boundingBox.min.y;
  size = new THREE.Vector3(); g.boundingBox.getSize(size);
  const ringH = size.y || 1e-3;
  const pos = g.attributes.position;
  let rInner = Infinity;
  for (let i = 0; i < pos.count; i++) { const rho = Math.hypot(pos.getX(i), pos.getZ(i)); if (rho < rInner) rInner = rho; }
  const cs = (radius * heightFrac / ringH) * Math.max(0.05, sizeFactor);
  const L = perim.length, v = new THREE.Vector3();
  const cb = Math.cos(tilt), sb = Math.sin(tilt);                          // tilt about the wall tangent
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const f = (((Math.atan2(z, x) / (2 * Math.PI)) % 1) + 1) % 1;
    const P = perim.at(f * L);
    const rRel = (Math.hypot(x, z) - rInner) * cs;                         // radial dist from inner face
    const h    = (y - yMin) * cs;                                          // height above the band base
    const out  = rRel * cb + h * sb + outset;                            // tilt rotates the cross-section
    const hT   = h * cb - rRel * sb;                                      //   about the inner-bottom edge
    v.set(P.x + P.nx * out, anchorY + hT, P.z + P.nz * out);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

// ── same extractGeo as CakeTier ───────────────────────────────────────────────
function extractGeo(scene) {
  let geo = null;
  scene.traverse(obj => {
    if (obj.isMesh && !geo) geo = obj.geometry.clone();
  });
  if (!geo) return null;
  geo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  geo.computeBoundingBox();
  const box  = geo.boundingBox;
  const size = new THREE.Vector3(); box.getSize(size);
  const ctr  = new THREE.Vector3(); box.getCenter(ctr);
  geo.translate(-ctr.x, -box.min.y, -ctr.z);
  return { geo, sizeY: size.y };
}

// ── Single positioned piece / ring (with optional A/B alternation) ─────────────
// MUST stay identical to BottomPipingRing/TopPipingRing in spattoo-core CakeTier.jsx.
function buildShellGeo(scene, flip) {
  const result = extractGeo(scene);
  if (!result) return null;
  const geo = result.geo;
  if (flip) {
    geo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI));
    geo.computeBoundingBox();
    geo.translate(0, -geo.boundingBox.min.y, 0);
  }
  const sc = (CAKE_RADIUS * 0.24) / result.sizeY;
  geo.computeBoundingBox();
  const bb = new THREE.Vector3(); geo.boundingBox.getSize(bb);
  return { geometry: geo, shellScale: sc, bbDepth: bb.z, bbWidth: bb.x };
}

function CalibScene({ glbUrl, cfg, showRing, anchorY, inward, altGlbUrl, shape = null }) {
  const { scene } = useGLTF(glbUrl);
  const { scene: sceneAlt } = useGLTF(altGlbUrl || glbUrl);

  const A = useMemo(() => buildShellGeo(scene, cfg.flipBottom), [scene, cfg.flipBottom]);
  const B = useMemo(() => (cfg.altEnabled ? buildShellGeo(sceneAlt, cfg.altFlip) : null),
    [cfg.altEnabled, sceneAlt, cfg.altFlip]);

  const pattern = patternStr(cfg);
  const altActive = cfg.altEnabled;
  const isRect = shape?.kind === 'rect';

  // Ring positions — identical formula to BottomPipingRing in the designer.
  // Sheet cakes walk a rounded-rect perimeter; round cakes keep the circle.
  const positions = useMemo(() => {
    if (!A) return [];
    // Board hugs the side wall (outward); rim sits on the top surface (inward).
    const halfDepth = (A.bbDepth / 2) * A.shellScale;
    const off  = (inward ? -halfDepth : halfDepth) + cfg.radialOffset;
    const r    = CAKE_RADIUS + off;
    const step = A.shellScale * A.bbWidth * 0.9 * (cfg.spacing ?? 1);
    if (isRect) {
      // Swag/bend aren't modelled on rectangles yet — fall back to a flat wrapped ring.
      const perim = roundedRectPerimeter(shape.halfW, shape.halfD, shape.cornerR);
      let count = Math.max(6, Math.round(perim.length / step));
      if (altActive) { const L = pattern.length || 1; count = Math.max(L, Math.ceil(count / L) * L); }
      return Array.from({ length: count }, (_, i) => {
        const p = perim.at((i / count) * perim.length);
        return { pos: [p.x + off * p.nx, anchorY + cfg.yOffset, p.z + off * p.nz], rotY: Math.atan2(p.nz, p.nx), tq: [0, 0, 0, 1] };
      });
    }
    if (cfg.swagCount > 0 && cfg.swagDepth > 0) {
      return buildSwagRing({ r, baseY: anchorY + cfg.yOffset, step, swagCount: cfg.swagCount, swagDepth: cfg.swagDepth, swagTilt: cfg.swagTilt });
    }
    let count = Math.max(6, Math.round((2 * Math.PI * r) / step));
    if (altActive) { const L = pattern.length || 1; count = Math.max(L, Math.ceil(count / L) * L); }
    return Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2;
      return { pos: [Math.cos(angle) * r, anchorY + cfg.yOffset, Math.sin(angle) * r], rotY: angle, tq: [0, 0, 0, 1] };
    });
  }, [A, cfg.radialOffset, cfg.yOffset, cfg.spacing, cfg.swagCount, cfg.swagDepth, cfg.swagTilt, anchorY, inward, altActive, pattern, isRect, shape]);

  // Bend mode: deform the whole strip into U festoons draped on the wall (round-only).
  // `bendRing` tiles them edge-to-edge (spread 1.0) into ONE continuous ring; otherwise
  // they're separate swags with a small gap between each (spread 0.96).
  const festoonGeos = useMemo(() => {
    if (!cfg.bend || isRect) return null;
    return buildFestoons(scene, {
      flip: false,
      festoons: cfg.festoons,
      depth: cfg.bendDepth,
      attachY: anchorY + cfg.yOffset,
      radius: CAKE_RADIUS + cfg.radialOffset,
      spread: cfg.bendRing ? 1.0 : 0.96,
      tilt: (cfg.bendTilt ?? 0) * DEG,
    });
  }, [scene, cfg.bend, cfg.bendRing, cfg.festoons, cfg.bendDepth, cfg.bendTilt, cfg.yOffset, cfg.radialOffset, anchorY, isRect]);

  // Wrap mode: a pre-formed ring re-routed onto the wall as ONE band (round or rect).
  const wrapGeo = useMemo(() => {
    if (!cfg.wrap) return null;
    return buildWrapBand(scene, {
      perim: wallPerimeter(shape), anchorY: anchorY + cfg.yOffset,
      heightFrac: 0.4, sizeFactor: cfg.wrapSize ?? 1, radius: CAKE_RADIUS,
      outset: 0.01 + cfg.radialOffset, tilt: (cfg.wrapTilt ?? 0) * DEG,
    });
  }, [scene, cfg.wrap, cfg.yOffset, cfg.radialOffset, cfg.wrapTilt, cfg.wrapSize, anchorY, shape]);

  if (wrapGeo) {
    return (
      <mesh geometry={wrapGeo} castShadow>
        <meshPhysicalMaterial {...creamMaterialProps(cfg.softness, '#f5e6c8')} />
      </mesh>
    );
  }

  if (!A) return null;

  if (festoonGeos) {
    return (
      <>
        {festoonGeos.map((g, i) => (
          <mesh key={i} geometry={g} castShadow>
            <meshPhysicalMaterial {...creamMaterialProps(cfg.softness, '#f5e6c8')} />
          </mesh>
        ))}
      </>
    );
  }

  // Y onto the group, X+Z onto the mesh — same split as the designer.
  const ryA = cfg.ry * DEG, meshA = [cfg.rx * DEG, 0, cfg.rz * DEG];
  const ryB = cfg.altRy * DEG, meshB = [cfg.altRx * DEG, 0, cfg.altRz * DEG];
  const dRadialB = altActive ? (cfg.altRadialOffset - cfg.radialOffset) : 0;
  const dYB = altActive ? (cfg.altYOffset - cfg.yOffset) : 0;
  const L = pattern.length || 1;
  const pts = showRing ? positions : (positions.length ? [positions[0]] : []);

  return (
    <>
      {pts.map((u, i) => {
        const isB = altActive && B && pattern[i % L] === 'B';
        const ver = isB ? B : A;
        let pos = u.pos;
        if (isB && (dRadialB || dYB)) {
          const [px, , pz] = u.pos; const len = Math.hypot(px, pz) || 1;
          pos = [px + (px / len) * dRadialB, u.pos[1] + dYB, pz + (pz / len) * dRadialB];
        }
        return (
          <group key={i} position={pos} quaternion={u.tq}>
            <group rotation={[0, -u.rotY + Math.PI / 2 + (isB ? ryB : ryA), 0]}>
              <mesh geometry={ver.geometry} rotation={isB ? meshB : meshA} scale={ver.shellScale} castShadow>
                <meshPhysicalMaterial {...creamMaterialProps(cfg.softness, '#f5e6c8')} />
              </mesh>
            </group>
          </group>
        );
      })}
    </>
  );
}

// ── Pattern thumbnail: a short FRONT ARC of the real ring, facing the camera ──
// A flat side-by-side row can't reproduce the cake look: on the ring each shell is rotated
// to follow the curve (-angle + π/2 + ry) and overlaps the next, which is what makes the
// scrolls tuck into a continuous border. So we render the EXACT ring transform for a few
// shells centred on the front (angle = π/2, which faces +Z toward the camera), then shift the
// whole arc forward so that front shell sits at the origin — the capture camera then sees the
// border head-on, identical to spattoo-core. `overlap` is the ring's spacing factor (0.9 =
// default ring look; lower packs tighter). `shellCount` = how many shells across the arc.
export function BuildingBlockScene({ glbUrl, altGlbUrl, cfg, overlap = 0.9, shellCount = 2, color = '#f5e6c8' }) {
  const { scene }          = useGLTF(glbUrl);
  const { scene: sceneAlt } = useGLTF(altGlbUrl || glbUrl);
  const A = useMemo(() => buildShellGeo(scene, cfg.flipBottom), [scene, cfg.flipBottom]);
  const B = useMemo(() => buildShellGeo(sceneAlt, cfg.altFlip), [sceneAlt, cfg.altFlip]);
  if (!A) return null;
  const pattern = patternStr(cfg);
  const L = pattern.length;
  const total = Math.max(1, shellCount);
  // Same radius + step the designer's BottomPipingRing uses (board hugs the wall, outward).
  const r    = CAKE_RADIUS + (A.bbDepth / 2) * A.shellScale + (cfg.radialOffset || 0);
  const step = A.shellScale * A.bbWidth * overlap * (cfg.spacing ?? 1);
  const dAngle = step / r;                 // angular spacing between consecutive shells
  const FRONT  = Math.PI / 2;              // front of the ring → +Z, toward the camera
  const ryA = cfg.ry * DEG, meshA = [cfg.rx * DEG, 0, cfg.rz * DEG];
  const ryB = cfg.altRy * DEG, meshB = [cfg.altRx * DEG, 0, cfg.altRz * DEG];
  const dRadialB = (cfg.altRadialOffset || 0) - (cfg.radialOffset || 0);
  const dYB      = (cfg.altYOffset || 0) - (cfg.yOffset || 0);
  // Scale the motif to FILL ~85% of the capture frustum width (both up for a lone A/B set and
  // down for a long arc) so the shells are always large in frame — the live preview then closely
  // matches the saved thumbnail (normalizeThumbnail also targets ~80%). Translate is scaled too
  // so the arc's centre (the front, angle π/2) stays at the origin, head-on to the camera.
  const span = Math.max(1e-3, (total - 1) * step + A.shellScale * A.bbWidth);
  const fit  = 0.85 / span;
  return (
    // Shift the front point (0, 0, r) to the origin so the capture camera frames it head-on.
    <group scale={fit} position={[0, 0, -r * fit]}>
      {Array.from({ length: total }, (_, k) => {
        const idx   = k - (total - 1) / 2;   // centre the arc on the front (symmetric)
        const angle = FRONT + idx * dAngle;
        const isB   = pattern[((k % L) + L) % L] === 'B';
        const ver   = isB ? (B || A) : A;
        let pos = [Math.cos(angle) * r, 0, Math.sin(angle) * r];
        if (isB && (dRadialB || dYB)) {
          const len = Math.hypot(pos[0], pos[2]) || 1;
          pos = [pos[0] + (pos[0] / len) * dRadialB, pos[1] + dYB, pos[2] + (pos[2] / len) * dRadialB];
        }
        return (
          <group key={k} position={pos} rotation={[0, -angle + Math.PI / 2 + (isB ? ryB : ryA), 0]}>
            <mesh geometry={ver.geometry} rotation={isB ? meshB : meshA} scale={ver.shellScale}>
              <meshPhysicalMaterial {...creamMaterialProps(cfg.softness, color)} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

// ── Pattern thumbnail on a mini cake ─────────────────────────────────────────
// Renders a small cake + board with the pattern's FULL piping ring wrapping it, exactly as
// the designer renders it (same radius/step/per-shell rotation as BottomPipingRing). This is
// the clearest "this is a pattern" thumbnail — a continuous border around a cake. Transparent
// background (no floor) so normalizeThumbnail crops to the cake. Cake/board are neutral so the
// piping (in the chosen `color`) reads clearly. `zone` picks board (bottom) vs rim (top).
export function PatternCakeThumb({
  glbUrl, altGlbUrl, cfg, color = '#f5e6c8', zone = 'board',
  cakeColor = '#F6C6A8', boardColor = '#D4AF37',
}) {
  // Cake top cap is a slightly lighter tint of the cake body so it doesn't need its own control.
  const capColor = cakeColor;
  const { scene }          = useGLTF(glbUrl);
  const { scene: sceneAlt } = useGLTF(altGlbUrl || glbUrl);
  const isTop = zone === 'rim';
  const A = useMemo(() => buildShellGeo(scene, cfg.flipBottom), [scene, cfg.flipBottom]);
  const B = useMemo(() => buildShellGeo(sceneAlt, cfg.altFlip), [sceneAlt, cfg.altFlip]);
  const pattern = patternStr(cfg);
  const L = pattern.length;
  const anchorY = isTop ? (Y_BASE + CAKE_HEIGHT) : Y_BASE;
  const positions = useMemo(() => {
    if (!A) return [];
    const halfDepth = (A.bbDepth / 2) * A.shellScale;
    const r = CAKE_RADIUS + (isTop ? -halfDepth : halfDepth) + (cfg.radialOffset || 0);
    const step = A.shellScale * A.bbWidth * 0.9 * (cfg.spacing ?? 1);
    let count = Math.max(6, Math.round((2 * Math.PI * r) / step));
    const Ln = pattern.length || 1; count = Math.max(Ln, Math.ceil(count / Ln) * Ln);
    return Array.from({ length: count }, (_, i) => {
      const a = (i / count) * Math.PI * 2;
      return { pos: [Math.cos(a) * r, anchorY + (cfg.yOffset || 0), Math.sin(a) * r], rotY: a };
    });
  }, [A, isTop, cfg.radialOffset, cfg.spacing, cfg.yOffset, anchorY, pattern]);
  if (!A) return null;
  const ryA = cfg.ry * DEG, meshA = [cfg.rx * DEG, 0, cfg.rz * DEG];
  const ryB = cfg.altRy * DEG, meshB = [cfg.altRx * DEG, 0, cfg.altRz * DEG];
  const dRadialB = (cfg.altRadialOffset || 0) - (cfg.radialOffset || 0);
  const dYB      = (cfg.altYOffset || 0) - (cfg.yOffset || 0);
  return (
    <group>
      {/* board / drum — metallic finish so a gold board reads as gold */}
      <mesh position={[0, Y_BASE / 2, 0]}>
        <cylinderGeometry args={[CAKE_RADIUS * 1.32, CAKE_RADIUS * 1.32, Y_BASE, 56]} />
        <meshStandardMaterial color={boardColor} roughness={0.25} metalness={0.7} />
      </mesh>
      {/* cake body */}
      <mesh position={[0, Y_BASE + CAKE_HEIGHT / 2, 0]}>
        <cylinderGeometry args={[CAKE_RADIUS, CAKE_RADIUS, CAKE_HEIGHT, 48]} />
        <meshStandardMaterial color={cakeColor} roughness={0.85} />
      </mesh>
      {/* top cap */}
      <mesh position={[0, Y_BASE + CAKE_HEIGHT + 0.005, 0]}>
        <cylinderGeometry args={[CAKE_RADIUS - 0.01, CAKE_RADIUS - 0.01, 0.01, 48]} />
        <meshStandardMaterial color={capColor} roughness={0.7} />
      </mesh>
      {/* piping ring */}
      {positions.map((u, i) => {
        const isB = B && pattern[i % L] === 'B';
        const ver = isB ? B : A;
        let pos = u.pos;
        if (isB && (dRadialB || dYB)) {
          const len = Math.hypot(pos[0], pos[2]) || 1;
          pos = [pos[0] + (pos[0] / len) * dRadialB, pos[1] + dYB, pos[2] + (pos[2] / len) * dRadialB];
        }
        return (
          <group key={i} position={pos} rotation={[0, -u.rotY + Math.PI / 2 + (isB ? ryB : ryA), 0]}>
            <mesh geometry={ver.geometry} rotation={isB ? meshB : meshA} scale={ver.shellScale}>
              <meshPhysicalMaterial {...creamMaterialProps(cfg.softness, color)} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

// ── Cake + board backdrop ─────────────────────────────────────────────────────
// `shape` null → round cylinder; { kind:'rect', halfW, halfD, cornerR } → sheet cake.
// Default cake body colour — the picker's starting value and its "Reset" target.
const STANDARD_CAKE_COLOR = '#f5c6d0';

function CakeScene({ shape = null, floor = true, cakeColor = STANDARD_CAKE_COLOR }) {
  const isRect = shape?.kind === 'rect';
  return (
    <>
      {isRect ? (
        <>
          {/* Board — rounded slab a little larger than the cake footprint */}
          <RoundedBox position={[0, 0.05, 0]} args={[(shape.halfW + 0.45) * 2, 0.1, (shape.halfD + 0.45) * 2]} radius={0.05} smoothness={4} receiveShadow>
            <meshStandardMaterial color="#d4af37" roughness={0.15} metalness={0.75} />
          </RoundedBox>
          {/* Sheet cake body */}
          <RoundedBox position={[0, Y_BASE + CAKE_HEIGHT / 2, 0]} args={[shape.halfW * 2, CAKE_HEIGHT, shape.halfD * 2]} radius={shape.cornerR} smoothness={4} castShadow receiveShadow>
            <meshStandardMaterial color={cakeColor} roughness={0.68} />
          </RoundedBox>
        </>
      ) : (
        <>
          {/* Board */}
          <mesh position={[0, 0.05, 0]} receiveShadow>
            <cylinderGeometry args={[CAKE_RADIUS + 0.6, CAKE_RADIUS + 0.6, 0.1, 64]} />
            <meshStandardMaterial color="#d4af37" roughness={0.15} metalness={0.75} />
          </mesh>
          {/* Cake */}
          <mesh position={[0, Y_BASE + CAKE_HEIGHT / 2, 0]} castShadow receiveShadow>
            <cylinderGeometry args={[CAKE_RADIUS, CAKE_RADIUS, CAKE_HEIGHT, 64]} />
            <meshStandardMaterial color={cakeColor} roughness={0.68} />
          </mesh>
        </>
      )}
      {/* Floor — opaque ground for the live preview; omitted in the thumbnail capture so the
          shot crops cleanly to the cake + piping (no big floor plane filling the frame). */}
      {floor && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
          <planeGeometry args={[20, 20]} />
          <meshStandardMaterial color="#f0ebe5" roughness={0.9} />
        </mesh>
      )}
    </>
  );
}

// ── Slider row ────────────────────────────────────────────────────────────────
function Slider({ label, value, min, max, step = 1, onChange, color = '#3D5A44', resetTo = 0 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color, minWidth: 90, fontFamily: "'Quicksand',sans-serif" }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor: color }} />
      <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 46, textAlign: 'right', fontFamily: "'Quicksand',sans-serif" }}>
        {typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(2) : value}
      </span>
      <button onClick={() => onChange(resetTo)}
        style={{ fontSize: 10, padding: '2px 6px', border: '1px solid #C5D4C8', borderRadius: 4, background: '#fff', cursor: 'pointer', color: '#9BB5A2', fontFamily: "'Quicksand',sans-serif" }}>
        {resetTo}
      </button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
const DEFAULT_TARGET_CFG = {
  flipBottom:   true,
  rx: 0, ry: 0, rz: 0,
  radialOffset: 0,
  yOffset:      0,
  spacing:      1,   // shell gap multiplier: 1 = touching/default, >1 = wider gaps (fewer shells)
  softness:     PIPING_SOFTNESS_DEFAULT, // 0 glossy/wet … 0.7 default … 1 matte/whipped
  swagCount:    0,   // festoons around the ring (0 = flat ring, no swag). 2–3 = big U drapes.
  swagDepth:    0.4, // how far each festoon hangs (cake units)
  swagTilt:     0.4, // how strongly shells lean to follow the drape (0–1; ~0.4 looks best)
  bend:         false, // bend the whole strip into U festoons (one strip = one U swag)
  bendRing:     false, // tile the bent strips edge-to-edge (no gap) into ONE continuous garland
  festoons:     6,   // how many U swags around the cake (1 = one big U at the front)
  bendDepth:    0.4, // how far each U belly hangs below the attachment ends (cake units)
  bendTilt:     30,  // degrees the strip rolls about its length → the draped lean (0 = face-on)
  wrap:         false, // the GLB is a complete RING — wrap it round the wall as one band (no repeat)
  wrapTilt:     0,     // degrees the wrap band's cross-section pitches: + flares the top edge outward
  wrapSize:     1,     // scale of the wrap band's cross-section (height + thickness); 1 = default
  // Alternating pattern — version B (the "alternate") + its own transform + the repeat ratio.
  altEnabled:   false,
  altFlip:      false,
  altRx: 0, altRy: 0, altRz: 0,
  altRadialOffset: 0,
  altYOffset:   0,
  patternA:     1,   // originals per cycle
  patternB:     1,   // alternates per cycle
};

// Build the repeating cycle string (e.g. A=2,B=1 → "AAB"). Always ≥1 of each.
function patternStr(c) {
  return 'A'.repeat(Math.max(1, c.patternA || 1)) + 'B'.repeat(Math.max(1, c.patternB || 1));
}

// Map one edited config to its placement_config section. board → bottom_*, rim → top_*.
// These are the exact keys the designer's pipingPlacementFromConfig() reads.
function sectionFor(prefix, c) {
  // Softness is shared by all modes — written only when nudged off the default.
  const softness = Math.abs((c.softness ?? PIPING_SOFTNESS_DEFAULT) - PIPING_SOFTNESS_DEFAULT) > 1e-9
    ? { [`${prefix}_softness`]: +(c.softness ?? PIPING_SOFTNESS_DEFAULT).toFixed(2) }
    : {};
  // Wrap (complete-ring) element: a totally different placement, so emit a CLEAN, minimal
  // config — just the wrap flag + the two controls it actually uses (height up the wall and
  // proud-of-wall offset). Rotation / spacing / swag / flip / alternation don't apply and are
  // omitted, so the config reads unambiguously as "this is a ring."
  if (c.wrap) {
    return {
      [`${prefix}_wrap`]:          true,
      [`${prefix}_y_offset`]:      +c.yOffset.toFixed(3),
      [`${prefix}_radial_offset`]: +c.radialOffset.toFixed(3),
      // Tilt — pitches the band's cross-section about the wall tangent. Written only when nudged.
      ...(Math.round(c.wrapTilt) !== 0 ? { [`${prefix}_wrap_tilt`]: Math.round(c.wrapTilt) } : {}),
      // Size — scales the band's cross-section. Written only when off the default.
      ...(Math.abs((c.wrapSize ?? 1) - 1) > 1e-9 ? { [`${prefix}_wrap_size`]: +(c.wrapSize).toFixed(2) } : {}),
      ...softness,
    };
  }
  const base = {
    [`${prefix}_flip`]:          c.flipBottom,
    [`${prefix}_rotation`]:      [Math.round(c.rx), Math.round(c.ry), Math.round(c.rz)],
    [`${prefix}_radial_offset`]: +c.radialOffset.toFixed(3),
    [`${prefix}_y_offset`]:      +c.yOffset.toFixed(3),
    [`${prefix}_spacing`]:       +(c.spacing ?? 1).toFixed(2),
    ...softness,   // cream roughness/sheen — present only when nudged off the default
    [`${prefix}_swag_count`]:    Math.round(c.swagCount),
    [`${prefix}_swag_depth`]:    +c.swagDepth.toFixed(3),
    [`${prefix}_swag_tilt`]:     +c.swagTilt.toFixed(2),
    // Bend (U-shaped festoon) — only written when on, so non-bend elements stay clean.
    ...(c.bend ? {
      [`${prefix}_bend`]:        true,
      [`${prefix}_bend_ring`]:   !!c.bendRing,
      [`${prefix}_festoons`]:    Math.round(c.festoons),
      [`${prefix}_bend_depth`]:  +c.bendDepth.toFixed(3),
      [`${prefix}_bend_tilt`]:   Math.round(c.bendTilt ?? 0),
    } : {}),
    // Wrap (pre-formed ring around the wall) — flag only, written when on.
    ...(c.wrap ? { [`${prefix}_wrap`]: true } : {}),
  };
  if (!c.altEnabled) return base;
  // Alternate version B (its GLB url is set during upload in Manage Elements, not here).
  return {
    ...base,
    [`${prefix}_alt_enabled`]:      true,
    [`${prefix}_alt_flip`]:         c.altFlip,
    [`${prefix}_alt_rotation`]:     [Math.round(c.altRx), Math.round(c.altRy), Math.round(c.altRz)],
    [`${prefix}_alt_radial_offset`]: +c.altRadialOffset.toFixed(3),
    [`${prefix}_alt_y_offset`]:      +c.altYOffset.toFixed(3),
    [`${prefix}_pattern`]:           patternStr(c),
  };
}

export default function PipingCalibrator() {
  const [file, setFile]     = useState(null);
  const [blobUrl, setBlobUrl] = useState(null);
  const [altFile, setAltFile]     = useState(null);   // alternate shape (version B) GLB
  const [altBlobUrl, setAltBlobUrl] = useState(null);
  const [showRing, setShowRing] = useState(false);
  const [target, setTarget] = useState('board'); // which config the sliders edit: 'board' | 'rim'
  const [sampleShape, setSampleShape] = useState('cylinder'); // preview cake: 'cylinder' | 'rect'
  const [sheetKey,    setSheetKey]    = useState('half');     // which sheet size when rect

  // Preview shape passed to the cake + rings. null = round; else the sheet's rounded-rect.
  const shape = useMemo(() => {
    if (sampleShape !== 'rect') return null;
    const sz = SHEET_SIZES.find(z => z.key === sheetKey) ?? SHEET_SIZES[1];
    return { kind: 'rect', halfW: sz.w / 2, halfD: sz.d / 2, cornerR: SHEET_CORNER_R };
  }, [sampleShape, sheetKey]);

  // Independent configs — the board ring sits OUTSIDE the wall, the rim pulls INWARD,
  // so each needs its own rotation/offsets. The Board/Rim selector just swaps which one
  // the sliders drive; both rings always render together on the cake.
  const [boardCfg, setBoardCfg] = useState({ ...DEFAULT_TARGET_CFG });
  const [rimCfg,   setRimCfg]   = useState({ ...DEFAULT_TARGET_CFG, flipBottom: false });

  // Which sections get written to the output JSON — board-only / rim-only / both.
  const [includeBoard, setIncludeBoard] = useState(true);
  // Rim starts OFF so a freshly uploaded GLB only shows on the board — the rim ring appears
  // when its zone is ticked or its tab is opened (render gate: includeRim || target === 'rim').
  const [includeRim,   setIncludeRim]   = useState(false);

  // ── Create-pattern mode: load an existing block element from the library by id,
  // tune the alternating pattern against its R2 GLB, capture a building-block thumbnail,
  // and save a new piping_pattern element that references the block (no new file). ──
  const [mode, setMode]           = useState('tune'); // 'tune' | 'pattern'
  const [allElements, setAllElements]       = useState([]);
  const [elementTypesList, setElementTypesList] = useState([]);
  const [blockId, setBlockId]     = useState('');
  const [block, setBlock]         = useState(null);   // resolved element { id, name, image_url, ... }
  const [patternName, setPatternName] = useState('');
  const [creating, setCreating]   = useState(false);
  const [msg, setMsg]             = useState(null);
  const captureRef = useRef(null);
  const thumbRef = useRef(null);
  // Cake body colour (picker) — drives both the live preview and the captured thumbnail.
  const [cakeColor, setCakeColor] = useState(STANDARD_CAKE_COLOR);

  const cfg    = target === 'board' ? boardCfg : rimCfg;
  const setCfg = target === 'board' ? setBoardCfg : setRimCfg;

  // Capture a clean element thumbnail from the dedicated offscreen canvas — transparent
  // background, no floor — then crop it to the cake + piping with normalizeThumbnail (the same
  // crop the pattern thumbnails use) and download. Faithful to the tuned look (bend included),
  // but framed/cropped like the originals instead of grabbing the whole live canvas.
  async function captureScreenshot() {
    const canvas = thumbRef.current?.querySelector('canvas');
    if (!canvas) { setMsg({ ok: false, text: 'Thumbnail preview not ready — try again.' }); return; }
    const raw = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const thumb = await normalizeThumbnail(raw);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(thumb);
    a.download = `piping-${target}-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // GLB the preview/capture renders: the loaded block in pattern mode, else the upload.
  const activeGlbUrl = mode === 'pattern' ? (block?.image_url ?? null) : blobUrl;

  // Lazy-load the element library + types the first time we enter pattern mode.
  useEffect(() => {
    if (mode !== 'pattern' || allElements.length) return;
    Promise.all([fetchAllElements(), fetchElementTypes()])
      .then(([els, types]) => { setAllElements(els); setElementTypesList(types); })
      .catch(e => setMsg({ ok: false, text: e.message }));
  }, [mode, allElements.length]);

  function loadBlock() {
    const el = allElements.find(e => e.id === blockId.trim());
    if (!el) { setMsg({ ok: false, text: 'No element found with that id.' }); return; }
    setBlock(el);
    setPatternName(`${el.name} Pattern`);
    setBoardCfg(p => ({ ...p, altEnabled: true }));
    setRimCfg(p => ({ ...p, altEnabled: true }));
    setShowRing(true);
    setMsg({ ok: true, text: `Loaded "${el.name}".` });
  }

  async function createPattern() {
    if (!block) { setMsg({ ok: false, text: 'Load a block element first.' }); return; }
    if (!patternName.trim()) { setMsg({ ok: false, text: 'Pattern name is required.' }); return; }
    const ptype = elementTypesList.find(t => t.slug === 'piping_pattern');
    if (!ptype) { setMsg({ ok: false, text: 'No "piping_pattern" element type exists yet — create it first.' }); return; }
    const zones = [...(includeBoard ? ['board'] : []), ...(includeRim ? ['rim'] : [])];
    if (!zones.length) { setMsg({ ok: false, text: 'Include at least one zone (Board / Rim).' }); return; }
    setCreating(true); setMsg(null);
    try {
      // Capture the building-block thumbnail → normalize → upload (store the R2 key).
      const canvas = captureRef.current?.querySelector('canvas');
      if (!canvas) throw new Error('Thumbnail preview not ready — try again.');
      const raw = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const thumb = await normalizeThumbnail(raw);
      const tfn = `${crypto.randomUUID()}.png`;
      const { url, key: thumbKey } = await getSignedUploadUrl('elements/thumbnails', tfn, 'image/png');
      await uploadToR2(url, thumb);

      // MVP: both parts reference the SAME block (self-alternate). Two-file later just
      // points part B at a different element id — same shape, no structural change.
      const placement_config = {
        ...(includeBoard ? sectionFor('bottom', boardCfg) : {}),
        ...(includeRim   ? sectionFor('top',    rimCfg)   : {}),
        parts: [{ element_id: block.id }, { element_id: block.id }],
      };
      await createGlobalElement({
        name:             patternName.trim(),
        element_type_id:  ptype.id,
        image_url:        null,           // patterns own no file — they reference blocks
        thumbnail_url:    thumbKey,
        allowed_zones:    zones,
        placement_config,
        allowed_actions:  { resize: true, duplicate: true, color: true, delete: true, move: false, tilt: false },
        sort_order:       0,
      });
      setMsg({ ok: true, text: `Pattern "${patternName.trim()}" created.` });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setCreating(false);
    }
  }

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (!altFile) { setAltBlobUrl(null); return; }
    const url = URL.createObjectURL(altFile);
    setAltBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [altFile]);

  function set(key) { return v => setCfg(prev => ({ ...prev, [key]: v })); }

  // One combined placement_config fragment — only the checked sections are written, so
  // the same paste covers board-only, rim-only, or both. Merge it straight into an
  // element's placement_config (ManageElements "Paste from Piping Calibrator").
  const valuesJson = JSON.stringify({
    ...(includeBoard ? sectionFor('bottom', boardCfg) : {}),
    ...(includeRim   ? sectionFor('top',    rimCfg)   : {}),
  }, null, 2);

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', fontFamily: "'Quicksand',sans-serif", background: '#EDEAE2' }}>

      {/* ── Left: controls ─────────────────────────────────────────────── */}
      <div style={{ width: 320, flexShrink: 0, overflowY: 'auto', background: '#fff', borderRight: '1.5px solid #E8EFE9', padding: 20, position: 'relative', zIndex: 10 }}>

        <div style={{ fontSize: 15, fontWeight: 800, color: '#2C4433', marginBottom: 12 }}>Piping Calibrator</div>

        {/* Sample cake shape — check the pattern on a round or sheet cake (preview only) */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#6B8C74', marginBottom: 4 }}>Sample cake</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[{ v: 'cylinder', label: 'Round' }, { v: 'rect', label: 'Sheet' }].map(({ v, label }) => (
              <button key={v} onClick={() => setSampleShape(v)}
                style={{ flex: 1, fontSize: 11, padding: '6px 0', borderRadius: 6, border: `2px solid ${sampleShape === v ? '#3D5A44' : '#C5D4C8'}`, background: sampleShape === v ? '#3D5A44' : '#fff', color: sampleShape === v ? '#fff' : '#6B8C74', cursor: 'pointer', fontWeight: 700, fontFamily: "'Quicksand',sans-serif" }}>
                {label}
              </button>
            ))}
          </div>
          {sampleShape === 'rect' && (
            <>
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                {SHEET_SIZES.map(sz => (
                  <button key={sz.key} onClick={() => setSheetKey(sz.key)} title={`${sz.label} sheet · ${sz.inches}"`}
                    style={{ flex: 1, fontSize: 10, padding: '5px 0', borderRadius: 6, border: `2px solid ${sheetKey === sz.key ? '#9B5F72' : '#C5D4C8'}`, background: sheetKey === sz.key ? '#9B5F72' : '#fff', color: sheetKey === sz.key ? '#fff' : '#6B8C74', cursor: 'pointer', fontWeight: 700, fontFamily: "'Quicksand',sans-serif" }}>
                    {sz.label}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 10, color: '#9BB5A2', marginTop: 6, lineHeight: 1.5 }}>
                Preview only — checks the pattern on a sheet cake. Swag/bend aren’t modelled on sheets yet (they show as a flat ring), and the copied JSON is unchanged.
              </div>
            </>
          )}
        </div>

        {/* Mode: tune a local GLB (copy JSON) vs create a pattern from a library element */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {[{ v: 'tune', label: 'Tune (upload)' }, { v: 'pattern', label: 'Create Pattern' }].map(({ v, label }) => (
            <button key={v} onClick={() => setMode(v)}
              style={{ flex: 1, fontSize: 11, padding: '6px 0', borderRadius: 6, border: `2px solid ${mode === v ? '#9B5F72' : '#C5D4C8'}`, background: mode === v ? '#9B5F72' : '#fff', color: mode === v ? '#fff' : '#6B8C74', cursor: 'pointer', fontWeight: 700, fontFamily: "'Quicksand',sans-serif" }}>
              {label}
            </button>
          ))}
        </div>

        {mode === 'tune' ? (
          /* GLB upload */
          <label style={{ display: 'block', marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6B8C74', marginBottom: 4 }}>GLB File</div>
            <div style={{ border: '2px dashed #C5D4C8', borderRadius: 8, padding: '10px 14px', cursor: 'pointer', background: '#F4F8F5', fontSize: 12, color: '#9BB5A2', textAlign: 'center' }}>
              {file ? file.name : 'Click to pick .glb file'}
              <input type="file" accept=".glb,.gltf" style={{ display: 'none' }}
                onChange={e => { if (e.target.files[0]) setFile(e.target.files[0]); }} />
            </div>
          </label>
        ) : (
          /* Load an existing building-block element by id (loads its GLB from R2) */
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6B8C74', marginBottom: 4 }}>Building-block element id</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={blockId} onChange={e => setBlockId(e.target.value)} placeholder="paste cream_piping element id"
                style={{ flex: 1, fontSize: 11, padding: '8px 10px', borderRadius: 6, border: '1.5px solid #C5D4C8', fontFamily: 'monospace' }} />
              <button onClick={loadBlock}
                style={{ fontSize: 11, padding: '0 12px', borderRadius: 6, border: '2px solid #3D5A44', background: '#3D5A44', color: '#fff', cursor: 'pointer', fontWeight: 700 }}>
                Load
              </button>
            </div>
            {block && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 11, color: '#3D5A44', fontWeight: 700, marginBottom: 4 }}>Loaded: {block.name}</div>
                <input value={patternName} onChange={e => setPatternName(e.target.value)} placeholder="Pattern name"
                  style={{ width: '100%', fontSize: 12, padding: '8px 10px', borderRadius: 6, border: '1.5px solid #C5D4C8', boxSizing: 'border-box' }} />
              </div>
            )}
          </div>
        )}

        {msg && (
          <div style={{ marginBottom: 12, fontSize: 11, fontWeight: 700, padding: '8px 10px', borderRadius: 6, background: msg.ok ? '#EAF3EC' : '#FBEAEA', color: msg.ok ? '#3D5A44' : '#A23B3B' }}>
            {msg.text}
          </div>
        )}

        {activeGlbUrl && (
          <>
            {/* Target: rim (top edge) vs board (base) */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6B8C74', marginBottom: 4 }}>Edit values for (both rings shown)</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {[{ v: 'board', label: 'Board (base)' }, { v: 'rim', label: 'Rim (top edge)' }].map(({ v, label }) => (
                  <button key={v} onClick={() => setTarget(v)}
                    style={{ flex: 1, fontSize: 11, padding: '6px 0', borderRadius: 6, border: `2px solid ${target === v ? '#3D5A44' : '#C5D4C8'}`, background: target === v ? '#3D5A44' : '#fff', color: target === v ? '#fff' : '#6B8C74', cursor: 'pointer', fontWeight: 700, fontFamily: "'Quicksand',sans-serif" }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Cake colour — drives the live preview and the captured thumbnail */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44' }}>Cake colour</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="color" value={cakeColor} onChange={e => setCakeColor(e.target.value)}
                  style={{ width: 34, height: 26, padding: 0, border: '1.5px solid #C5D4C8', borderRadius: 6, background: '#fff', cursor: 'pointer' }} />
                {cakeColor.toLowerCase() !== STANDARD_CAKE_COLOR && (
                  <button onClick={() => setCakeColor(STANDARD_CAKE_COLOR)}
                    style={{ fontSize: 10, padding: '4px 8px', border: '1px solid #C5D4C8', borderRadius: 4, background: '#fff', cursor: 'pointer', color: '#9BB5A2', fontFamily: "'Quicksand',sans-serif", fontWeight: 700 }}>
                    Reset
                  </button>
                )}
              </div>
            </div>

            {/* Flip */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44' }}>Flip (180° X on geometry)</span>
              <button onClick={() => setCfg(p => ({ ...p, flipBottom: !p.flipBottom }))}
                style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: `2px solid ${cfg.flipBottom ? '#3D5A44' : '#C5D4C8'}`, background: cfg.flipBottom ? '#3D5A44' : '#fff', color: cfg.flipBottom ? '#fff' : '#6B8C74', cursor: 'pointer', fontWeight: 700 }}>
                {cfg.flipBottom ? 'ON' : 'OFF'}
              </button>
            </div>

            {/* Rotation */}
            <div style={{ fontSize: 11, fontWeight: 800, color: '#9B5F72', marginBottom: 6, marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.8 }}>Rotation (degrees)</div>
            <Slider label="X rotation" value={cfg.rx} min={-180} max={180} onChange={set('rx')} color="#e05252" />
            <Slider label="Y rotation" value={cfg.ry} min={-180} max={180} onChange={set('ry')} color="#52c452" />
            <Slider label="Z rotation" value={cfg.rz} min={-180} max={180} onChange={set('rz')} color="#5252e0" />

            {/* Position tweaks */}
            <div style={{ fontSize: 11, fontWeight: 800, color: '#9B5F72', marginBottom: 6, marginTop: 10, textTransform: 'uppercase', letterSpacing: 0.8 }}>Position</div>
            <Slider label="Radial offset" value={cfg.radialOffset} min={-0.3} max={0.5} step={0.01} onChange={set('radialOffset')} />
            <Slider label="Y offset" value={cfg.yOffset} min={-0.2} max={1.2} step={0.01} onChange={set('yOffset')} />
            <Slider label="Spacing" value={cfg.spacing} min={0.5} max={2.5} step={0.05} resetTo={1} onChange={set('spacing')} />
            <div style={{ fontSize: 10, color: '#9BB5A2', marginTop: -2, marginBottom: 6, lineHeight: 1.5 }}>
              Gap between shells. 1 = touching (default). Higher = wider gaps & fewer shells.
              Set the <b>Rim</b>’s spacing higher to match the <b>Board</b>’s wider gap.
            </div>

            {/* Finish — how glossy vs matte the piped cream reads (drives roughness + sheen) */}
            <div style={{ fontSize: 11, fontWeight: 800, color: '#9B5F72', marginBottom: 6, marginTop: 12, textTransform: 'uppercase', letterSpacing: 0.8 }}>Finish</div>
            <Slider label="Softness" value={cfg.softness} min={0} max={1} step={0.05} resetTo={PIPING_SOFTNESS_DEFAULT} onChange={set('softness')} />
            <div style={{ fontSize: 10, color: '#9BB5A2', marginTop: -2, marginBottom: 6, lineHeight: 1.5 }}>
              0 = glossy / wet icing · {PIPING_SOFTNESS_DEFAULT} = standard (default) · 1 = matte / whipped.
              Drives the cream’s roughness &amp; sheen. <b>Board</b> and <b>Rim</b> tune separately.
            </div>

            {/* Ring wrap — the GLB is a complete ring; wrap it round the wall as one band */}
            <div style={{ fontSize: 11, fontWeight: 800, color: '#9B5F72', marginBottom: 6, marginTop: 12, textTransform: 'uppercase', letterSpacing: 0.8 }}>Ring (wrap around cake)</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44' }}>GLB is a complete ring</span>
              <button onClick={() => { setCfg(p => ({ ...p, wrap: !p.wrap })); if (!cfg.wrap) setShowRing(true); }}
                style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: `2px solid ${cfg.wrap ? '#3D5A44' : '#C5D4C8'}`, background: cfg.wrap ? '#3D5A44' : '#fff', color: cfg.wrap ? '#fff' : '#6B8C74', cursor: 'pointer', fontWeight: 700 }}>
                {cfg.wrap ? 'ON' : 'OFF'}
              </button>
            </div>
            {cfg.wrap && <>
              <Slider label="Size" value={cfg.wrapSize} min={0.2} max={2} step={0.05} resetTo={1} onChange={set('wrapSize')} color="#e0a052" />
              <Slider label="Tilt" value={cfg.wrapTilt} min={-90} max={90} step={1} resetTo={0} onChange={set('wrapTilt')} color="#c47ad6" />
              <Slider label="Radial offset" value={cfg.radialOffset} min={-0.3} max={0.5} step={0.01} resetTo={0} onChange={set('radialOffset')} />
              <div style={{ fontSize: 10, color: '#9BB5A2', marginTop: -2, marginBottom: 6, lineHeight: 1.5 }}>
                Wraps the whole ring around the cake wall as one band — auto-fits the tier (round <i>or</i> sheet),
                no repeating shells. <b>Size</b> scales the band's height &amp; thickness (lower = slimmer).
                <b>Tilt</b> pitches the band: + flares the top edge outward, − tucks it in.
                <b>Radial offset</b> sits it proud (+) or tucks it into the wall (−); <b>Y offset</b> rides it up the wall.
                Plain rotation / spacing / swag / bend don’t apply in this mode.
              </div>
            </>}

            {/* Bend into U — bend the whole strip into draped U swags */}
            <div style={{ fontSize: 11, fontWeight: 800, color: '#9B5F72', marginBottom: 6, marginTop: 12, textTransform: 'uppercase', letterSpacing: 0.8 }}>Bend into U (swag)</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44' }}>Bend the strip into a U</span>
              <button onClick={() => setCfg(p => ({ ...p, bend: !p.bend, yOffset: (!p.bend && p.yOffset === 0) ? 0.9 : p.yOffset }))}
                style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: `2px solid ${cfg.bend ? '#3D5A44' : '#C5D4C8'}`, background: cfg.bend ? '#3D5A44' : '#fff', color: cfg.bend ? '#fff' : '#6B8C74', cursor: 'pointer', fontWeight: 700 }}>
                {cfg.bend ? 'ON' : 'OFF'}
              </button>
            </div>
            {cfg.bend && <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44' }}>Connect into a ring (no gaps)</span>
                <button onClick={() => { setCfg(p => ({ ...p, bendRing: !p.bendRing })); if (!cfg.bendRing) setShowRing(true); }}
                  style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: `2px solid ${cfg.bendRing ? '#3D5A44' : '#C5D4C8'}`, background: cfg.bendRing ? '#3D5A44' : '#fff', color: cfg.bendRing ? '#fff' : '#6B8C74', cursor: 'pointer', fontWeight: 700 }}>
                  {cfg.bendRing ? 'ON' : 'OFF'}
                </button>
              </div>
              <Slider label={cfg.bendRing ? 'Segments (ring)' : 'Festoons'} value={cfg.festoons} min={1} max={24} step={1} onChange={set('festoons')} />
              <Slider label="Bend depth" value={cfg.bendDepth} min={0} max={0.9} step={0.01} onChange={set('bendDepth')} />
              <Slider label="Bend tilt" value={cfg.bendTilt} min={-90} max={90} step={1} onChange={set('bendTilt')} />
              <div style={{ fontSize: 10, color: '#9BB5A2', marginTop: -2, marginBottom: 6, lineHeight: 1.5 }}>
                One strip bends into one U swag. <b>Connect into a ring</b> tiles the swags edge-to-edge into a
                single continuous garland all the way around (no gaps). <b>Segments/Festoons</b> = how many
                swags around (more = shorter, tighter drapes). <b>Bend depth</b> = how far each U hangs.
                <b>Bend tilt</b> rolls the strip so it leans into a draped rope look (0 = facing dead-on).
                <b>Y offset</b> sets the attachment height up the wall.
              </div>
            </>}

            {/* Swag / drape — bend the ring into scallops like a garland border */}
            <div style={{ fontSize: 11, fontWeight: 800, color: '#9B5F72', marginBottom: 6, marginTop: 10, textTransform: 'uppercase', letterSpacing: 0.8 }}>Swag / Drape</div>
            <Slider label="Swag count" value={cfg.swagCount} min={0} max={12} step={1}
              onChange={v => {
                // Activating swag: show the ring and lift the ATTACHMENT points to a fixed mid-wall
                // height (SWAG_LIFT) so the festoon hangs on the side. Depth then drops the belly
                // DOWN from there — attachment height stays put, so depth deepens the U (not raises it).
                setCfg(p => ({ ...p, swagCount: v, yOffset: (v > 0 && p.yOffset === 0) ? SWAG_LIFT : p.yOffset }));
                if (v > 0) setShowRing(true);
              }} />
            <Slider label="Swag depth" value={cfg.swagDepth} min={0} max={1} step={0.01}
              onChange={v => {
                // Depth only shows on the full ring — so dragging it activates the swag: enable the
                // ring, default to 2 festoons, and lift the attachment height (once) if not already.
                setCfg(p => {
                  const count = (p.swagCount === 0 && v > 0) ? 2 : p.swagCount;
                  const yOffset = (count > 0 && p.yOffset === 0) ? SWAG_LIFT : p.yOffset;
                  return { ...p, swagDepth: v, swagCount: count, yOffset };
                });
                if (v > 0) setShowRing(true);
              }} />
            <Slider label="Swag tilt" value={cfg.swagTilt} min={0} max={1} step={0.05}
              onChange={v => {
                setCfg(p => ({ ...p, swagTilt: v, swagCount: (p.swagCount === 0 && p.swagDepth > 0) ? 2 : p.swagCount }));
                setShowRing(true);
              }} />
            <div style={{ fontSize: 10, color: '#9BB5A2', marginTop: -2, marginBottom: 6, lineHeight: 1.5 }}>
              <b>Count</b> = number of U festoons (2–3 = big U drapes; higher = small ripples).
              <b> Depth</b> = how far each U hangs down. <b>Y offset</b> = attachment height on the wall
              (auto-lifted when swag turns on). <b>Tilt</b> ~0.4 — near 1 over-rolls chunky shells.
              {cfg.swagCount > 0 && !showRing && <><br/>Turn on “Show full ring” to see the swag.</>}
            </div>

            {/* Alternating pattern — version B alternates with the original around the ring */}
            <div style={{ fontSize: 11, fontWeight: 800, color: '#9B5F72', marginBottom: 6, marginTop: 12, textTransform: 'uppercase', letterSpacing: 0.8 }}>Alternating pattern</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44' }}>Alternate a 2nd shape</span>
              <button onClick={() => { setCfg(p => ({ ...p, altEnabled: !p.altEnabled })); if (!cfg.altEnabled) setShowRing(true); }}
                style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: `2px solid ${cfg.altEnabled ? '#3D5A44' : '#C5D4C8'}`, background: cfg.altEnabled ? '#3D5A44' : '#fff', color: cfg.altEnabled ? '#fff' : '#6B8C74', cursor: 'pointer', fontWeight: 700 }}>
                {cfg.altEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
            {cfg.altEnabled && <>
              {/* Alternate shape GLB (optional — falls back to the main shape) */}
              <label style={{ display: 'block', marginBottom: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#6B8C74', marginBottom: 4 }}>Alternate shape GLB (optional — defaults to main)</div>
                <div style={{ border: '2px dashed #C5D4C8', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', background: '#F4F8F5', fontSize: 11, color: '#9BB5A2', textAlign: 'center' }}>
                  {altFile ? altFile.name : 'Click to pick alternate .glb'}
                  <input type="file" accept=".glb,.gltf" style={{ display: 'none' }}
                    onChange={e => { if (e.target.files[0]) setAltFile(e.target.files[0]); }} />
                </div>
              </label>
              {/* Pattern ratio */}
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 8 }}>
                {[{ key: 'patternA', label: 'Originals' }, { key: 'patternB', label: 'Alternates' }].map(({ key, label }) => (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44' }}>{label}</span>
                    <button onClick={() => setCfg(p => ({ ...p, [key]: Math.max(1, (p[key] || 1) - 1) }))}
                      style={{ width: 22, height: 22, borderRadius: 5, border: '1.5px solid #C5D4C8', background: '#fff', cursor: 'pointer', color: '#3D5A44', fontWeight: 700 }}>−</button>
                    <span style={{ fontSize: 12, fontWeight: 800, color: '#2C4433', minWidth: 14, textAlign: 'center' }}>{cfg[key]}</span>
                    <button onClick={() => setCfg(p => ({ ...p, [key]: Math.min(6, (p[key] || 1) + 1) }))}
                      style={{ width: 22, height: 22, borderRadius: 5, border: '1.5px solid #C5D4C8', background: '#fff', cursor: 'pointer', color: '#3D5A44', fontWeight: 700 }}>+</button>
                  </div>
                ))}
                <span style={{ fontSize: 11, fontWeight: 800, color: '#9B5F72', fontFamily: 'monospace' }}>{patternStr(cfg)}</span>
              </div>
              {/* Alternate transform */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44' }}>Alt flip (180° X)</span>
                <button onClick={() => setCfg(p => ({ ...p, altFlip: !p.altFlip }))}
                  style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: `2px solid ${cfg.altFlip ? '#3D5A44' : '#C5D4C8'}`, background: cfg.altFlip ? '#3D5A44' : '#fff', color: cfg.altFlip ? '#fff' : '#6B8C74', cursor: 'pointer', fontWeight: 700 }}>
                  {cfg.altFlip ? 'ON' : 'OFF'}
                </button>
              </div>
              <Slider label="Alt X rotation" value={cfg.altRx} min={-180} max={180} onChange={set('altRx')} color="#e05252" />
              <Slider label="Alt Y rotation" value={cfg.altRy} min={-180} max={180} onChange={set('altRy')} color="#52c452" />
              <Slider label="Alt Z rotation" value={cfg.altRz} min={-180} max={180} onChange={set('altRz')} color="#5252e0" />
              <Slider label="Alt radial" value={cfg.altRadialOffset} min={-0.3} max={0.5} step={0.01} onChange={set('altRadialOffset')} />
              <Slider label="Alt Y offset" value={cfg.altYOffset} min={-0.2} max={1.2} step={0.01} onChange={set('altYOffset')} />
              <div style={{ fontSize: 10, color: '#9BB5A2', marginTop: -2, marginBottom: 6, lineHeight: 1.5 }}>
                Version B alternates with the original per the ratio above. The alternate GLB url is set
                when you upload it in <b>Manage Elements</b>; here you only tune B's transform + pattern.
              </div>
            </>}

            {/* Ring toggle */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44' }}>Show full ring</span>
              <button onClick={() => setShowRing(r => !r)}
                style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: `2px solid ${showRing ? '#3D5A44' : '#C5D4C8'}`, background: showRing ? '#3D5A44' : '#fff', color: showRing ? '#fff' : '#6B8C74', cursor: 'pointer', fontWeight: 700 }}>
                {showRing ? 'ON' : 'OFF'}
              </button>
            </div>

            {/* Include in output — board-only / rim-only / both */}
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: '#9B5F72', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Include in JSON</div>
              {[{ k: 'board', on: includeBoard, setter: setIncludeBoard, label: 'Board (base)' },
                { k: 'rim',   on: includeRim,   setter: setIncludeRim,   label: 'Rim (top edge)' }].map(row => (
                <label key={row.k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, cursor: 'pointer' }}>
                  <input type="checkbox" checked={row.on} onChange={e => row.setter(e.target.checked)} style={{ accentColor: '#3D5A44', width: 15, height: 15 }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44', fontFamily: "'Quicksand',sans-serif" }}>{row.label}</span>
                </label>
              ))}
              <div style={{ fontSize: 10, color: '#9BB5A2', marginTop: 2, lineHeight: 1.5 }}>
                Only checked sections are written. Board → <code>bottom_*</code>, Rim → <code>top_*</code>.
              </div>
            </div>

            {/* Output — copy JSON (tune) or create a pattern element (pattern mode) */}
            {mode === 'tune' ? (
              <div style={{ marginTop: 20, background: '#F4F8F5', border: '1.5px solid #C5D4C8', borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: '#3D5A44', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 }}>Values to share</div>
                <pre style={{ fontSize: 12, color: '#2C4433', margin: 0, fontFamily: 'monospace', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{valuesJson}</pre>
                <button onClick={() => navigator.clipboard?.writeText(valuesJson)}
                  style={{ marginTop: 10, width: '100%', padding: '8px 0', background: '#3D5A44', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: "'Quicksand',sans-serif" }}>
                  Copy to clipboard
                </button>
                <div style={{ borderTop: '1px solid #D8E2DB', margin: '12px 0 8px' }} />
                <div style={{ fontSize: 10, color: '#9BB5A2', marginBottom: 8, lineHeight: 1.5 }}>
                  Saves a clean, cropped PNG of the tuned piece (bend/swag included) on a transparent
                  background — auto-framed and cropped like the pattern thumbnails. Use it as the element’s
                  thumbnail.
                </div>
                <button onClick={captureScreenshot} disabled={!activeGlbUrl}
                  style={{ width: '100%', padding: '8px 0', background: activeGlbUrl ? '#9B5F72' : '#d8c2cb', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: activeGlbUrl ? 'pointer' : 'default', fontFamily: "'Quicksand',sans-serif" }}>
                  📸 Download screenshot
                </button>
              </div>
            ) : (
              <div style={{ marginTop: 20, background: '#F7F0F3', border: '1.5px solid #E2C9D3', borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: '#9B5F72', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Create pattern element</div>
                <div style={{ fontSize: 10, color: '#9BB5A2', marginBottom: 8, lineHeight: 1.5 }}>
                  Saves a new <code>piping_pattern</code> element referencing this block, with the
                  tuned A/B pattern and a captured building-block thumbnail. No new file is uploaded.
                </div>
                <button onClick={createPattern} disabled={creating || !block}
                  style={{ width: '100%', padding: '9px 0', background: (creating || !block) ? '#d8c2cb' : '#9B5F72', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 700, cursor: (creating || !block) ? 'default' : 'pointer', fontFamily: "'Quicksand',sans-serif" }}>
                  {creating ? 'Creating…' : 'Create Pattern'}
                </button>
              </div>
            )}
          </>
        )}

        {!activeGlbUrl && (
          <div style={{ marginTop: 20, padding: 16, background: '#F4F8F5', borderRadius: 10, fontSize: 12, color: '#9BB5A2', lineHeight: 1.6, border: '1.5px dashed #C5D4C8' }}>
            {mode === 'tune'
              ? 'Upload a GLB file to start. Tune each ring (Board / Rim), tick which zones to include, then share the "Values" box.'
              : 'Paste a building-block element id and hit Load. Tune the alternating pattern, then Create Pattern to save it.'}
          </div>
        )}
      </div>

      {/* ── Right: 3D canvas ────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <Canvas shadows camera={{ position: [0, 5.5, 7.9], fov: 42 }}>
          <ambientLight intensity={0.7} />
          <directionalLight position={[5, 10, 5]} intensity={1.4} castShadow />
          <directionalLight position={[-3, 3, -3]} intensity={0.3} />
          <color attach="background" args={['#f4f0ea']} />
          <Environment preset="apartment" backgroundBlurriness={1} />

          <CakeScene shape={shape} cakeColor={cakeColor} />

          <Suspense fallback={null}>
            {/* Both rings render together; a ring shows when it's included OR being edited. */}
            {activeGlbUrl && (includeBoard || target === 'board') && (
              <CalibScene glbUrl={activeGlbUrl} cfg={boardCfg} showRing={showRing} anchorY={Y_BASE} inward={false} altGlbUrl={altBlobUrl} shape={shape} />
            )}
            {activeGlbUrl && (includeRim || target === 'rim') && (
              <CalibScene glbUrl={activeGlbUrl} cfg={rimCfg} showRing={showRing} anchorY={Y_BASE + CAKE_HEIGHT} inward={true} altGlbUrl={altBlobUrl} shape={shape} />
            )}
          </Suspense>

          <OrbitControls makeDefault target={[0, 2, 0]} />
        </Canvas>

        {!activeGlbUrl && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <div style={{ background: 'rgba(255,255,255,0.85)', borderRadius: 12, padding: '16px 24px', fontSize: 13, color: '#9BB5A2', fontWeight: 700, fontFamily: "'Quicksand',sans-serif" }}>
              {mode === 'tune' ? 'Upload a GLB to see the piece on the cake' : 'Load a building-block element to start'}
            </div>
          </div>
        )}

        {/* Hidden building-block capture canvas (pattern mode) — one cycle, transparent bg */}
        {mode === 'pattern' && activeGlbUrl && (
          <div ref={captureRef} style={{ position: 'absolute', left: -9999, top: -9999, width: 512, height: 512 }}>
            <Canvas gl={{ preserveDrawingBuffer: true, alpha: true }} camera={{ position: [0, 0.18, 1.7], fov: 34 }} style={{ width: 512, height: 512, background: 'transparent' }}>
              <ambientLight intensity={0.95} />
              <directionalLight position={[3, 5, 5]} intensity={1.2} />
              <directionalLight position={[-3, 2, 1]} intensity={0.4} />
              <Suspense fallback={null}>
                <Environment preset="apartment" />
                <BuildingBlockScene glbUrl={activeGlbUrl} altGlbUrl={null} cfg={target === 'rim' ? rimCfg : boardCfg} />
              </Suspense>
              <OrbitControls target={[0, 0.14, 0]} enableZoom={false} enablePan={false} enableRotate={false} />
            </Canvas>
          </div>
        )}

        {/* Hidden thumbnail capture canvas (tune mode) — transparent bg, NO floor, framed on the
            cake front so "Download screenshot" crops cleanly to the cake + piping (bend included),
            instead of grabbing the whole live canvas with its floor and empty background. */}
        {mode === 'tune' && activeGlbUrl && (
          <div ref={thumbRef} style={{ position: 'absolute', left: -9999, top: -9999, width: 512, height: 512 }}>
            <Canvas shadows gl={{ preserveDrawingBuffer: true, alpha: true }} camera={{ position: [0, 3.4, 5.4], fov: 38 }} style={{ width: 512, height: 512, background: 'transparent' }}>
              <ambientLight intensity={0.75} />
              <directionalLight position={[5, 10, 5]} intensity={1.4} />
              <directionalLight position={[-3, 3, -3]} intensity={0.3} />
              <Suspense fallback={null}>
                <Environment preset="apartment" />
                <CakeScene shape={shape} floor={false} cakeColor={cakeColor} />
                {(includeBoard || target === 'board') && (
                  <CalibScene glbUrl={activeGlbUrl} cfg={boardCfg} showRing anchorY={Y_BASE} inward={false} altGlbUrl={altBlobUrl} shape={shape} />
                )}
                {(includeRim || target === 'rim') && (
                  <CalibScene glbUrl={activeGlbUrl} cfg={rimCfg} showRing anchorY={Y_BASE + CAKE_HEIGHT} inward={true} altGlbUrl={altBlobUrl} shape={shape} />
                )}
              </Suspense>
            </Canvas>
          </div>
        )}
      </div>
    </div>
  );
}
