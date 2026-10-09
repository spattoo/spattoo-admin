import { useState, useMemo, useEffect, useRef, useCallback, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment, RoundedBox } from '@react-three/drei';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { fetchAllElements, fetchElementTypes, createGlobalElement, uploadThumbnail } from '../lib/api';
/* ⚠️ THE GEOMETRY COMES FROM CORE, IT IS NOT REIMPLEMENTED HERE. This file used to carry its own
 * `buildShellGeo`, and the two drifted in a way that cost a day of tuning: core caps a shell's scale
 * against the tier radius (`capShellScale`) and this copy did not, so past about 1.15x the tool
 * showed a size the cake would never render. Sandeep, after tuning here and getting something else
 * on the cake: *"i loaded this in piping calibrator. and it landed perfectly fine."*
 * CLAUDE.md states the rule: "THE STUDIO IMPORTS THE GEOMETRY, IT DOES NOT CARRY A COPY OF IT … or
 * the tuned version and the rendered version drift." */
import { normalizeArtwork, buildShellGeo, buildSwagRing, buildFestoons,
         wallPerimeter, buildWrapBand, creamMaterialProps,
         /* ⚠️ THE PEN'S OWN RENDERER, IMPORTED. `side_rotation` is the attitude a HAND-PIPED piece
            takes on a wall, and it cannot be tuned against a ring preview: a ring keeps the piece
            upright in world space and yaws it outward, while the pen aligns its up-axis to the
            surface normal. Calibrating one against the other is exactly how the pen came to be
            reading the board's figure. A second stamp renderer here would reproduce that. */
         StampStroke,
         /* And core's own preparation, replacing a byte-identical local copy that sat in this file
            — `check:no-geometry-copy` watches a named list and this one was not on it. */
         extractGeo, SHELL_HEIGHT_FRAC,
         /* The coat's PACKING — where every rose sits on a tier and the frame it sits in.
            Core owns it because a GLB rose and a procedural one are packed identically;
            only the thing placed in each seat differs. */
         rosetteSeats, ROSETTE_DEFAULTS } from '@spattoo/designer';
import { PATTERN_THUMB_DIM } from '../lib/elementImage.js';

const DEG = Math.PI / 180;

// Cream "softness" → material. MUST stay identical to creamMaterialProps() in
// spattoo-core CakeTier.jsx so this preview matches the designer exactly. 0 = glossy/wet,
// 1 = matte/whipped; the default 0.7 reproduces the original look (roughness 0.85, sheen 0.4).
const PIPING_SOFTNESS_DEFAULT = 0.7;

// Bend a flat ring into `swagCount` scalloped drapes (garland/swag look).
// MUST stay identical to buildSwagRing() in spattoo-core CakeTier.jsx so this
// preview matches the designer exactly. Shells are spaced by arc-length along the
// draped curve; tq pitches each about the world radial axis to follow the slope.

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


// ── Wrap a pre-formed RING GLB around the wall (round OR rect) ─────────────────
// MUST stay identical to circlePerimeter / buildWrapBand in spattoo-core (surface.js /
// festoon.js) so this preview matches the cake. A vertex at angle θ around the ring maps to
// fraction f=θ/2π of the tier perimeter, displaced out by its radial profile and lifted by
// its height — so a ring GLB hugs a round wall as a circle and a sheet wall as a rounded-rect.
function circlePerimeter(r) {
  return { length: 2 * Math.PI * r, at(s) { const a = s / r, nx = Math.cos(a), nz = Math.sin(a); return { x: nx * r, z: nz * r, nx, nz }; } };
}

// ── same extractGeo as CakeTier ───────────────────────────────────────────────

// ── Single positioned piece / ring (with optional A/B alternation) ─────────────
// MUST stay identical to BottomPipingRing/TopPipingRing in spattoo-core CakeTier.jsx.

function CalibScene({ glbUrl, cfg, showRing, anchorY, inward, altGlbUrl, shape = null, color = DEFAULT_ELEMENT_COLOR }) {
  const { scene } = useGLTF(glbUrl);
  const { scene: sceneAlt } = useGLTF(altGlbUrl || glbUrl);

  const A = useMemo(() => buildShellGeo(scene, cfg.flipBottom, CAKE_RADIUS, cfg.sizeFactor), [scene, cfg.flipBottom, cfg.sizeFactor]);
  const B = useMemo(() => (cfg.altEnabled ? buildShellGeo(sceneAlt, cfg.altFlip, CAKE_RADIUS, cfg.sizeFactor) : null),
    [cfg.altEnabled, sceneAlt, cfg.altFlip, cfg.sizeFactor]);

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
      perim: wallPerimeter(shape, CAKE_RADIUS), anchorY: anchorY + cfg.yOffset,
      heightFrac: 0.4, sizeFactor: cfg.wrapSize ?? 1, radius: CAKE_RADIUS,
      outset: 0.01 + cfg.radialOffset, tilt: (cfg.wrapTilt ?? 0) * DEG,
    });
  }, [scene, cfg.wrap, cfg.yOffset, cfg.radialOffset, cfg.wrapTilt, cfg.wrapSize, anchorY, shape]);

  if (wrapGeo) {
    return (
      <mesh geometry={wrapGeo} castShadow>
        <meshPhysicalMaterial {...creamMaterialProps(cfg.softness, color)} />
      </mesh>
    );
  }

  if (!A) return null;

  if (festoonGeos) {
    return (
      <>
        {festoonGeos.map((g, i) => (
          <mesh key={i} geometry={g} castShadow>
            <meshPhysicalMaterial {...creamMaterialProps(cfg.softness, color)} />
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
  /* ⚠️ THE ONE PIECE FACES THE CAMERA. `positions[0]` is angle 0 — the +X side — while the preview
     camera sits at +Z, so the single calibration piece was always edge-on at the right of the
     frame, and zooming in pushed it out of view entirely. Picking the piece nearest the front puts
     the subject where the viewer is already looking, which is the whole job of this screen.
     Unchanged when "Show full ring" is on: then every piece renders and there is no one subject. */
  const frontMost = positions.length
    ? positions.reduce((best, q) => (q.pos[2] > best.pos[2] ? q : best), positions[0])
    : null;
  const pts = showRing ? positions : (frontMost ? [frontMost] : []);

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
                <meshPhysicalMaterial {...creamMaterialProps(cfg.softness, color)} />
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
  const A = useMemo(() => buildShellGeo(scene, cfg.flipBottom, CAKE_RADIUS, cfg.sizeFactor), [scene, cfg.flipBottom, cfg.sizeFactor]);
  const B = useMemo(() => buildShellGeo(sceneAlt, cfg.altFlip, CAKE_RADIUS, cfg.sizeFactor), [sceneAlt, cfg.altFlip, cfg.sizeFactor]);
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
  // matches the saved thumbnail (normalizeArtwork also targets ~80%). Translate is scaled too
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
// background (no floor) so normalizeArtwork crops to the cake. Cake/board are neutral so the
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
  const A = useMemo(() => buildShellGeo(scene, cfg.flipBottom, CAKE_RADIUS, cfg.sizeFactor), [scene, cfg.flipBottom, cfg.sizeFactor]);
  const B = useMemo(() => buildShellGeo(sceneAlt, cfg.altFlip, CAKE_RADIUS, cfg.sizeFactor), [sceneAlt, cfg.altFlip, cfg.sizeFactor]);
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
// Default element (cream) colour — matches the cream the shells/festoons/wrap rendered before
// the element-colour picker existed.
const DEFAULT_ELEMENT_COLOR = '#f5e6c8';

/* ── The whole cake coated in this element ───────────────────────────────────────────────────────
 *
 * Sandeep, with a photograph of a rose-covered cake: *"cream piping is filled on entire cake."*
 * This is the GLB answer to it; `rosetteCoat` in core carries a procedural one that proved the
 * packing.
 *
 * ⚠️ IT USES THE PEN'S FRAME ON BOTH SURFACES, NOT THE RING'S. A coat seats every piece by the
 * SURFACE NORMAL — up is out of the cake on the wall, up is up on the lid — which is the pen's
 * frame, not the ring's "upright in world, yawed outward". So it reads the same pair the pen does:
 * the rim figure (`top_rotation`, which is what the rx/ry/rz sliders author) on the top, and
 * `side_rotation` on the wall. Feeding the ring figure to the wall is the exact bug recorded on
 * `side_rotation` in PLACEMENT_CONFIG.md — every piece came out back-on and it read as the wrong
 * element having been chosen.
 *
 * ⚠️ TWO INSTANCED MESHES, ONE PER SURFACE, and that falls out of the rotations rather than being
 * a choice: the top and the wall apply different rotations, so they cannot share a matrix list.
 * It also happens to be the shape multi-colour will need.
 *
 * ⚠️ SCALED BY FOOTPRINT, NOT BY HEIGHT. A ring sizes a shell by its HEIGHT (SHELL_HEIGHT_FRAC of
 * the tier radius) because a border is read in silhouette. A coat is read as a TILING: what has to
 * match the packing is how much surface one rose covers, so the scale comes from the piece's widest
 * horizontal extent AFTER its surface rotation. Size it by height and the roses either collide or
 * leave cake showing, depending on how tall the model happens to be.
 */
function CoatScene({ glbUrl, roseRadius, topRot, sideRot, color, softness, onMeasure, showSeats, cover, rimStretch }) {
  const { scene } = useGLTF(glbUrl);

  const base = useMemo(() => extractGeo(scene), [scene]);

  /* ── How far the SHAPE reaches, not its box ────────────────────────────────────────────────
   *
   * ⚠️ THE BOUNDING BOX IS THE WRONG RULER FOR PACKING, and this cost four rounds to find. The
   * seat arithmetic was measured correct — the side's top piece overlaps the rim's reach by
   * 0.002, and the rim row is present — yet a band of bare cake stayed under the shoulder. That
   * leaves one explanation: the rose does not FILL its box. A spike, a tail or a few stray
   * petals push min/max out past where the cream actually ends, every piece is seated as though
   * it were that big, and the shortfall appears twice over at every seam.
   *
   * So extents come from a PERCENTILE of the vertices rather than their extremes: the span that
   * holds all but the outermost `1 - COVER` of them on each axis. A handful of outlying vertices
   * stop dictating the packing for the whole cake, while the bulk of the shape still does.
   *
   * COVER is deliberately a knob and not a constant — how much of a model is "the shape" depends
   * on the model, and this is the first one. */
  const extent = (geo, cover) => {
    const pos = geo.getAttribute('position');
    const lo = (1 - cover) / 2, hi = 1 - lo;
    const out = [];
    for (let axis = 0; axis < 3; axis++) {
      const v = new Float32Array(pos.count);
      for (let i = 0; i < pos.count; i++) v[i] = pos.getComponent(i, axis);
      v.sort();
      const a = v[Math.floor(lo * (v.length - 1))], b = v[Math.ceil(hi * (v.length - 1))];
      out.push({ min: a, max: b, size: b - a });
    }
    return out;
  };


  /* One geometry per surface, each already carrying its own rotation baked in — so the instance
     matrix only has to place and roll it, and the footprint can be measured on the rotated form. */
  const forSurface = (rot) => {
    if (!base) return null;
    const g = base.geo.clone();
    g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(rot.rx * DEG, rot.ry * DEG, rot.rz * DEG)));
    g.computeBoundingBox();
    const box = new THREE.Vector3(); g.boundingBox.getSize(box);
    /* Scaled and seated on the SOLID extent. Scaling on the box would also shrink the rose to fit
       a width most of it never uses, so both numbers come from the same ruler. */
    const ext = extent(g, cover);
    const size = new THREE.Vector3(ext[0].size, ext[1].size, ext[2].size);
    const footprint = Math.max(size.x, size.z) || 1;
    const scale = (2 * roseRadius) / footprint;
    /* ⚠️ RAW SIZE IS REPORTED, not just the scale. The first GLB coat came out with pieces far
       larger than their seats — they hung below the board and still left cake showing, which is
       the signature of a bounding box bigger than the shape inside it (spiky petals, a stem, or
       an unbaked node transform in the model). Without the measured numbers on screen that is
       indistinguishable from the scale maths being wrong, and we spent a round guessing. */
    /* ⚠️ RE-CENTRED ON ALL THREE AXES AFTER THE ROTATION, not just seated on Y — and the first
     * version did only Y, which is the bug PLACEMENT_CONFIG.md already records for tilted shells:
     * "a tilt moves the shell relative to its own origin, and the seat must follow it in BOTH
     * axes … extractGeo seats the geometry at min Y and centres it on X/Z … a tilt breaks both."
     * extractGeo centres X/Z BEFORE any rotation, so after one the piece hangs off its own
     * origin. Placed at a seat it then dangles — visibly below the board — and leaves cake
     * showing on the side it has moved away from. Both symptoms, one cause.
     *
     * X and Z are centred because the seat is the middle of the patch the piece covers; Y goes to
     * its MINIMUM because that is the face resting on the cake. */
    /* Centred and seated on the solid extent too, so an outlying spike cannot shove the piece off
       its seat — the same reason the sizes come from it. */
    g.translate(-(ext[0].min + ext[0].max) / 2, -ext[1].min, -(ext[2].min + ext[2].max) / 2);
    g.computeBoundingBox();
    return { geo: g, scale, verts: g.getAttribute('position').count,
             raw: [box.x, box.y, box.z], solid: [size.x, size.y, size.z], footprint,
             fitted: [size.x * scale, size.y * scale, size.z * scale] };
  };

  const top  = useMemo(() => forSurface(topRot),  [base, topRot.rx, topRot.ry, topRot.rz, roseRadius, cover]);
  const side = useMemo(() => forSurface(sideRot), [base, sideRot.rx, sideRot.ry, sideRot.rz, roseRadius, cover]);

  /* ⚠️ SEATED FROM THE PIECE'S MEASURED SIZE, NOT FROM THE SIZE SLIDER. The slider asks for a
   * radius; what the packing needs is how far this particular GLB actually reaches across the
   * surface and up the wall ONCE ROTATED AND SCALED — and those differ the moment a model is not
   * square, which a rose with a tail is not. Seating from the nominal radius is what put the
   * bottom row through the board. `fitted` is [x, y, z] in the piece's own frame, where x runs
   * across the surface, z runs up the wall, and y is depth along the normal.
   *
   * The SIDE's measurement governs the rows because the wall is where height matters; the top's
   * own width governs its rings. */
  const seats = useMemo(() => {
    if (!side || !top) return [];
    return rosetteSeats({
      tierRadius: CAKE_RADIUS, tierHeight: CAKE_HEIGHT, baseY: Y_BASE,
      pieceW: Math.max(side.fitted[0], top.fitted[0]),
      pieceH: side.fitted[2],
      jitter: ROSETTE_DEFAULTS.jitter, seed: 1,
    });
  }, [side, top]);

  useEffect(() => {
    if (top && side && onMeasure) onMeasure({ top, side, seats: seats.length });
  }, [top, side, seats.length, onMeasure]);

  if (!base) return null;
  return (
    <>
      <CoatSurface kind="top"  part={top}  seats={seats} color={color} softness={softness} />
      <CoatSurface kind="side" part={side} seats={seats} color={color} softness={softness} />
      {/* The shoulder. It takes the SIDE's geometry — the rim seat's normal bisects up and
          outward, so in the pen's frame it is asking the wall's question, not the lid's, and a
          third rotation to calibrate would be a third thing to get wrong for no gain. */}
      <CoatSurface kind="rim"  part={side} seats={seats} color={color} softness={softness}
                   rimStretch={rimStretch} />
      {showSeats && <SeatMarkers seats={seats} pieceW={Math.max(side.fitted[0], top.fitted[0])} />}
    </>
  );
}

/* ── Seat markers ────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ A DIAGNOSTIC, AND IT EXISTS BECAUSE GUESSING FROM SCREENSHOTS FAILED THREE TIMES. The seam
 * under the rim survived a re-centring fix, a seat-height rewrite and a rounding fix, each of
 * which was a real bug and none of which was THE bug. The arithmetic says the rim's lowest point
 * and the side's highest land within 0.004 of each other, so either the frame maths is wrong or
 * the bounding box is taller than the rose inside it — and a photograph of roses cannot tell
 * those apart.
 *
 * This draws the SEAT itself: a flat disc of the piece's own width, lying in the piece's own
 * tangent plane, plus a stub along the normal. If the discs meet at the rim and the roses do not,
 * the box is bigger than the shape and the fix is to measure the shape. If the discs themselves
 * leave a gap, the arithmetic is wrong and the fix is mine. */
function SeatMarkers({ seats, pieceW }) {
  const ref = useRef();
  const COLOUR = { top: '#2d7ff9', side: '#f9a52d', rim: '#e0392d' };
  useEffect(() => {
    if (!ref.current || !seats.length) return;
    const m = new THREE.Matrix4(), basis = new THREE.Matrix4(), q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    seats.forEach((s, i) => {
      basis.makeBasis(new THREE.Vector3(...s.u), new THREE.Vector3(...s.n), new THREE.Vector3(...s.v));
      q.setFromRotationMatrix(basis);
      m.compose(new THREE.Vector3(...s.p), q, one);
      ref.current.setMatrixAt(i, m);
      ref.current.setColorAt(i, new THREE.Color(COLOUR[s.kind] ?? '#888'));
    });
    ref.current.instanceMatrix.needsUpdate = true;
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
  }, [seats, pieceW]);
  if (!seats.length) return null;
  /* A disc of the piece's WIDTH, in the piece's own plane — cylinderGeometry's axis is +Y, which
     is the seat normal, so the disc lies flat on the surface exactly as a piece's footprint does. */
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, seats.length]}>
      <cylinderGeometry args={[pieceW / 2, pieceW / 2, 0.004, 20]} />
      <meshBasicMaterial transparent opacity={0.55} />
    </instancedMesh>
  );
}

function CoatSurface({ kind, part, seats, color, softness, rimStretch = 1 }) {
  const mine = useMemo(() => seats.filter(s => s.kind === kind), [seats, kind]);
  const ref = useRef();

  useEffect(() => {
    if (!ref.current || !part || !mine.length) return;
    const m = new THREE.Matrix4(), basis = new THREE.Matrix4(), q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    mine.forEach((s, i) => {
      /* ⚠️ STRETCHED ALONG `v` ONLY. The shoulder row sizes itself to meet the side row below it
         and the top ring inside it — core computes the factor from where those actually reach, so
         a GLB that leaves a band gets a longer shoulder rather than a slider. Scaling the other
         two axes with it would make the rim pieces fatter than their neighbours and trade the gap
         for a ridge. compose() applies scale in LOCAL axes, and local Z is `v`. */
      sc.set(part.scale, part.scale, part.scale * (s.stretch ?? 1) * (s.kind === 'rim' ? rimStretch : 1));
      const u = new THREE.Vector3(...s.u), n = new THREE.Vector3(...s.n), v = new THREE.Vector3(...s.v);
      /* (u, n, v): the piece was rotated with Y as its surface normal, so Y maps to n. Getting the
         column order wrong lays every wall piece flat against the cake, and it looks plausible
         from directly in front. */
      basis.makeBasis(u, n, v);
      q.setFromRotationMatrix(basis);
      /* Variety is a roll about the normal. Doing it as a different model per piece would defeat
         instancing, which is the only reason a coat renders at all. */
      const roll = new THREE.Quaternion().setFromAxisAngle(n, (i * 2.399963) % (Math.PI * 2));
      m.compose(new THREE.Vector3(...s.p), roll.multiply(q), sc);
      ref.current.setMatrixAt(i, m);
    });
    ref.current.instanceMatrix.needsUpdate = true;
  }, [part, mine, rimStretch]);

  if (!part || !mine.length) return null;
  /* No castShadow — the shadow pass re-renders every instance and self-shadowing between pieces is
     not where the look comes from. Measured note in core's rosetteCoat.js. */
  return (
    <instancedMesh ref={ref} args={[part.geo, undefined, mine.length]} receiveShadow>
      <meshPhysicalMaterial {...creamMaterialProps(softness, color)} />
    </instancedMesh>
  );
}

/* ── Hand-piped stamps on the wall, drawn by the designer's own StampStroke ──────────────────────
 *
 * ⚠️ NOT A PREVIEW OF A RING. A ring places a shell upright in world space and yaws it outward; the
 * pen aligns the piece's up-axis to the SURFACE NORMAL, so on a wall "up" points out of the cake.
 * The two frames give the same numbers different meanings, which is why `side_rotation` exists at
 * all and why tuning it against the ring previews above would reproduce the original bug.
 *
 * The stroke is shaped exactly as CreamPen commits one: `kind` is implicit in StampStroke, `normal`
 * is the wall's outward normal, `points` is a short run along it, `regular: true` means "behave like
 * a ring" (faces across the run, not along it), and `rotation` is what we are tuning. Everything
 * about how that becomes geometry — the +90° X bake, the footprint/height measurement, the seat
 * after rotation — belongs to core and is not reproduced here.
 */
function WallStamps({ glbUrl, rot, color }) {
  /* ⚠️ SIZED LIKE A RING, NOT PICKED. The pen sizes a `regular` stamp by HEIGHT (`target = 2 x
     thickness`), and a ring normalises a shell to `radius x SHELL_HEIGHT_FRAC`. Deriving the
     thickness from the same constant puts this run at exactly the scale of the rings beside it, so
     the comparison is honest; a guessed 0.1 rendered specks you could not judge an attitude from.
     INVARIANTS #8 — a studio must not hardcode a world dimension it can derive. */
  const thickness = (CAKE_RADIUS * SHELL_HEIGHT_FRAC) / 2;

  /* A short arc across the camera-FACING side of the wall at mid-height: enough pieces to read the
     attitude, few enough to stay legible while a slider is moving.
     ⚠️ +Z, BECAUSE THE PREVIEW CAMERA SITS AT [0, 5.5, 7.9]. The first cut put the run at -Z and
     every piece hid behind the cake — one speck on the silhouette, which looks exactly like a
     broken preview rather than a mis-aimed one. */
  const stroke = useMemo(() => {
    const y = Y_BASE + CAKE_HEIGHT * 0.5;
    /* ⚠️ ON THE CENTRELINE, NOT ON THE SURFACE. `stampTransforms` seats a piece at `-th + seatDrop`
       because a pen stroke's stored points are its rope's CENTRE, one radius proud of what the
       pointer hit ("the stored centerline is lifted one radius"). Handing it points that already sit
       on the cylinder makes that -th push every piece a radius INTO the wall — at [0,0,0] the disc
       is thin enough that some still showed, and at [-90,0,0] the run vanished completely, which
       reads as "the rotation broke it" rather than "the preview fed it the wrong points". */
    const r = CAKE_RADIUS + thickness;
    const pts = [];
    for (let i = -4; i <= 4; i++) {
      const a = Math.PI / 2 + i * 0.16;
      pts.push([Math.cos(a) * r, y, Math.sin(a) * r]);
    }
    return {
      points: pts,
      // The outward normal at the middle of the run — the surface the pen seats against.
      normal: [0, 0, 1],
      thickness, spacing: 0.85, regular: true, seed: 1,
      rotation: [rot.rx, rot.ry, rot.rz], lean: 0,
    };
  }, [rot.rx, rot.ry, rot.rz, thickness]);

  return <StampStroke stroke={stroke} url={glbUrl} color={color} />;
}

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
  sizeFactor:   1,   // preview scale of the element (1 = the designer's base size)
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

  /* ── Hand piping on the WALL — one key, not a third ring ────────────────────────────────────
     `side_rotation` is a single rotation, so it gets a compact block rather than a Board/Rim-style
     tab: none of the ring controls (flip, radial, swag, alternation) mean anything to a pen stroke.
     Off by default — an element that authors nothing falls back to `bottom_rotation`, which is the
     behaviour every element shipped before this had. */
  const [sideRot,     setSideRot]     = useState({ rx: 0, ry: 0, rz: 0 });
  /* ── Cover the cake ───────────────────────────────────────────────────────────────────────────
   * Sandeep: *"similarly we need to have a flag to cover the cake. once side and top calibration
   * is done, we can do it."* It belongs here rather than in its own studio precisely because it
   * consumes the two rotations this page already authors — the rim figure for the lid and
   * `side_rotation` for the wall — so the calibration and the thing it calibrates are on one
   * screen. A separate page would have meant tuning blind and checking elsewhere. */
  const [coat,        setCoat]        = useState(false);
  const [coatRadius,  setCoatRadius]  = useState(ROSETTE_DEFAULTS.rosetteRadius);
  /* ⚠️ THE COAT'S TOP NEEDS ITS OWN ROTATION, and the first cut wrongly reused the rim ring's.
   * A coat lays a piece FACE-UP on the lid; a rim ring stands it UPRIGHT facing outward. Same
   * surface, opposite poses — so `top_rotation`, which is authored for the ring, put every lid
   * piece on its edge and the top rendered as a crater with the cake visible through the middle.
   * PLACEMENT_CONFIG.md says as much in passing: "laid face-up with -90 about X a rosette spans
   * Y -0.45…+0.45". Defaults to the SIDE figure, because in the pen's frame both surfaces are
   * asking the same question — face along the normal — and the side one is already measured. */
  const [coatTopRot,  setCoatTopRot]  = useState(null);   // null = follow the side rotation
  const [coatStat,    setCoatStat]    = useState(null);
  const [coatSeats,   setCoatSeats]   = useState(false);
  const [coatCover,   setCoatCover]   = useState(0.9);
  /* ⚠️ ON TOP OF THE COMPUTED STRETCH, NOT INSTEAD OF IT — and the reason it exists is worth
   * keeping. Core sizes the shoulder row from where its neighbours' SEATS reach, which is exactly
   * right and, on a cake whose seats already overlap, correctly resolves to 1. The seam that
   * survives that is a property of the MESH: a spiky model does not visually fill even its
   * percentile extent, and no arithmetic over seat positions can see how much. Automatic where it
   * can be computed, by hand where it cannot. */
  const [coatRimStretch, setCoatRimStretch] = useState(1);
  const onCoatMeasure = useCallback(setCoatStat, []);
  const [includeSide, setIncludeSide] = useState(false);

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
  const shotRef = useRef(null);   // offscreen clean canvas (transparent bg, no floor) → screenshot
  // Cake body colour (picker) — drives both the live preview and the captured thumbnail.
  const [cakeColor, setCakeColor] = useState(STANDARD_CAKE_COLOR);
  // Element (cream) colour — drives the piped element in the preview + thumbnail.
  const [elementColor, setElementColor] = useState(DEFAULT_ELEMENT_COLOR);

  /* Ring configs only. The Side tab authors ONE key (`side_rotation`) and shows none of the
     controls below, so it deliberately has no entry here — falling through to the rim would let a
     slider on a hidden panel write to a ring nobody is looking at. */
  const cfg    = target === 'rim' ? rimCfg    : boardCfg;
  const setCfg = target === 'rim' ? setRimCfg : setBoardCfg;

  // Download the cake on its own — the full cake, board, and placed element with NO canvas
  // background or floor. Rendered on a dedicated offscreen canvas (transparent, no floor, framed
  // like the live view) then cropped to the cake's bounds so there's no empty margin.
  async function captureScreenshot() {
    const canvas = shotRef.current?.querySelector('canvas');
    if (!canvas) { setMsg({ ok: false, text: 'Capture canvas not ready — try again.' }); return; }
    const raw = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const thumb = await normalizeArtwork(raw, { size: PATTERN_THUMB_DIM });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(thumb);
    a.download = `calibrator-${target}-${Date.now()}.webp`;
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
      const thumb = await normalizeArtwork(raw, { size: PATTERN_THUMB_DIM });
      const thumbKey = await uploadThumbnail('elements/thumbnails', thumb);

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

  /* ── Zoom toward the piping, not toward the air above it ────────────────────────────────────
   * The orbit target was fixed at [0, 2, 0] — ABOVE the top of the cake (Y_BASE + CAKE_HEIGHT =
   * 1.55). Dollying in converges on the target, so zooming walked the camera into empty space over
   * the lid while the thing being calibrated slid off the bottom of the frame. Sandeep: *"when i
   * zoom in, i cant see the actual piping. to calibrate better i need to be able to see"*.
   * The target follows the surface being edited, so close inspection is just scroll-to-zoom.
   */
  const focusY = target === 'rim'  ? Y_BASE + CAKE_HEIGHT
               : target === 'side' ? Y_BASE + CAKE_HEIGHT * 0.5
               :                     Y_BASE + CAKE_HEIGHT * 0.08;   // board ring sits just off the plate
  /* ⚠️ AND THE FRONT OF THE CAKE, NOT ITS AXIS. Aiming at [0, y, 0] fixed the HEIGHT but still
     converged on the centre column, so a rim or board piece — which lives out at the radius —
     drifted off the edge as you zoomed. Every subject here sits at the front: the rings show their
     one piece there now, and the wall run is drawn there. Target the subject. */
  const focusZ = CAKE_RADIUS;
  const orbitRef = useRef(null);
  /* ⚠️ SET THROUGH THE REF, NOT ONLY THE PROP. drei applies `target` when the controls are created;
     a later change to the array does not move an existing instance, so switching tabs would leave
     the camera aimed at the surface you just left. `update()` is what makes the change take. */
  useEffect(() => {
    const c = orbitRef.current;
    if (!c?.target) return;
    c.target.set(0, focusY, focusZ);
    c.update();
  }, [focusY, focusZ]);

  // One combined placement_config fragment — only the checked sections are written, so
  // the same paste covers board-only, rim-only, or both. Merge it straight into an
  // element's placement_config (ManageElements "Paste from Piping Calibrator").
  /* ⚠️ THE SECTION YOU ARE EDITING COMES FIRST, and that is not cosmetic. With the sections in a
     fixed board→rim→side order, `side_rotation` landed 84% of the way down a block whose bottom
     143px sits below the fold — so you could tune the wall, watch the cake change, and read a JSON
     box that appeared not to mention it. Sandeep: *"json field in the piping calibrator is not
     adding side values"*. It was adding them; they were off-screen. Measured: block top 758px,
     bottom 1123px, viewport 980px, panel scrolled to 0.
     Key order carries no meaning in a paste, so the output can be ordered for the reader — and the
     reader is always looking for what they just moved. */
  const sections = {
    board: includeBoard ? sectionFor('bottom', boardCfg) : {},
    rim:   includeRim   ? sectionFor('top',    rimCfg)   : {},
    // Not a `sectionFor` prefix: `side_rotation` has no top_/bottom_ twin, because there is no wall
    // above the rim. Emitted only when ticked, so a paste never silently overrides the fallback.
    side:  includeSide  ? { side_rotation: [Math.round(sideRot.rx), Math.round(sideRot.ry), Math.round(sideRot.rz)] } : {},
  };
  const valuesJson = JSON.stringify(
    Object.assign({}, ...[target, 'board', 'rim', 'side'].filter((k, i, a) => a.indexOf(k) === i).map(k => sections[k] ?? {})),
    null, 2);

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', fontFamily: "'Quicksand',sans-serif", background: '#EDEAE2' }}>

      {/* ── Left: controls ─────────────────────────────────────────────── */}
      <div style={{ width: 320, flexShrink: 0, overflowY: 'auto', background: '#fff', borderRight: '1.5px solid #E8EFE9', padding: 20, position: 'relative', zIndex: 10 }}>

        <div style={{ fontSize: 15, fontWeight: 800, color: '#2C4433', marginBottom: 12 }}>Calibrator</div>

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
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6B8C74', marginBottom: 4 }}>Edit values for</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {/* ⚠️ THREE SURFACES. The wall began as a tick-box below the ring controls and that
                    was wrong: "which surface am I tuning" is the question this selector answers, and
                    burying one of the three answers somewhere else means nobody finds it. Sandeep:
                    *"board and ring, we should add side option. how would i calibrate otherwise"*. */}
                {[{ v: 'board', label: 'Board (base)' }, { v: 'rim', label: 'Rim (top edge)' },
                  { v: 'side', label: 'Side (wall)' }].map(({ v, label }) => (
                  /* ⚠️ OPENING THE WALL TAB TICKS IT FOR OUTPUT. Without this you can select Side,
                     move all three sliders, watch the cake change — and copy a JSON with no
                     `side_rotation` in it, because the tick lives further down the panel. A control
                     that visibly works while its value is silently dropped is the exact fault this
                     whole key exists to fix; reproducing it in the tool that authors it would be
                     absurd. It is a tick, not a lock: untick it and the element goes back to
                     following the board. */
                  <button key={v} onClick={() => { setTarget(v); if (v === 'side') setIncludeSide(true); }}
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

            {/* Element (cream) colour — drives the piped element in the preview + thumbnail */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44' }}>Element colour</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="color" value={elementColor} onChange={e => setElementColor(e.target.value)}
                  style={{ width: 34, height: 26, padding: 0, border: '1.5px solid #C5D4C8', borderRadius: 6, background: '#fff', cursor: 'pointer' }} />
                {elementColor.toLowerCase() !== DEFAULT_ELEMENT_COLOR && (
                  <button onClick={() => setElementColor(DEFAULT_ELEMENT_COLOR)}
                    style={{ fontSize: 10, padding: '4px 8px', border: '1px solid #C5D4C8', borderRadius: 4, background: '#fff', cursor: 'pointer', color: '#9BB5A2', fontFamily: "'Quicksand',sans-serif", fontWeight: 700 }}>
                    Reset
                  </button>
                )}
              </div>
            </div>

            {/* ── The wall: ONE key, so one short panel ──────────────────────────────────────
                `side_rotation` is the whole of what a wall authors. Every ring control below —
                flip, radial, y-offset, size, spacing, swag, wrap, alternation — describes a BORDER,
                and a hand-piped stroke has none of them: the customer draws where it goes and the
                pen card carries size and spacing. Showing them here would offer settings that reach
                nothing, which is worse than not offering them (INVARIANTS #12 — lay a surface out
                by what it actually does). */}
            {target === 'side' && (
              <>
                <div style={{ fontSize: 11, fontWeight: 800, color: '#9B5F72', marginBottom: 4, marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.8 }}>Hand piping on the wall</div>
                <div style={{ fontSize: 10.5, color: '#6B8C74', lineHeight: 1.5, marginBottom: 8 }}>
                  How a piece stands when a customer pipes it on the SIDE with the pen. The rings
                  above keep a piece upright and face it outward; the pen lines its up-axis up with
                  the surface, so a wall needs its own number. Left out, it follows the board.
                </div>
                <Slider label="Side X" value={sideRot.rx} min={-180} max={180} onChange={v => setSideRot(p => ({ ...p, rx: v }))} color="#e05252" />
                <Slider label="Side Y" value={sideRot.ry} min={-180} max={180} onChange={v => setSideRot(p => ({ ...p, ry: v }))} color="#52c452" />
                <Slider label="Side Z" value={sideRot.rz} min={-180} max={180} onChange={v => setSideRot(p => ({ ...p, rz: v }))} color="#5252e0" />
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13 }}>
                  <input type="checkbox" checked={coat} onChange={e => setCoat(e.target.checked)} />
                  <b>Cover the cake</b>
                </label>
                <div style={{ fontSize: 11.5, color: '#777', lineHeight: 1.45, margin: '4px 0 8px' }}>
                  Packs this element over the whole top and side. Uses the <b>rim</b> rotation on the
                  lid and the <b>side</b> rotation on the wall — the same pair the pen picks between.
                </div>
                {coat && (
                  <Slider label="Piece size" value={coatRadius} min={0.08} max={0.5} step={0.005}
                          onChange={setCoatRadius} color="#8a6fd0" />
                )}
                {coat && (
                  <Slider label="Shape cover" value={coatCover} min={0.5} max={1} step={0.01}
                          onChange={setCoatCover} color="#c06fa0" />
                )}
                {coat && (
                  <Slider label="Rim stretch" value={coatRimStretch} min={1} max={2.5} step={0.02}
                          onChange={setCoatRimStretch} color="#d0704f" />
                )}
                {coat && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 12 }}>
                    <input type="checkbox" checked={coatSeats} onChange={e => setCoatSeats(e.target.checked)} />
                    Show seats <span style={{ color: '#888', fontSize: 11 }}>(blue top · orange side · red rim)</span>
                  </label>
                )}
                {coat && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                  fontSize: 11.5, color: '#555', marginBottom: 4 }}>
                      <b>Top rotation</b>
                      <button onClick={() => setCoatTopRot(null)}
                              style={{ fontSize: 10.5, padding: '2px 7px', borderRadius: 5,
                                       border: '1px solid #d9d9e0', background: coatTopRot ? '#fff' : '#eceaf2',
                                       cursor: 'pointer' }}>
                        {coatTopRot ? 'follow side' : 'following side'}
                      </button>
                    </div>
                    <Slider label="Top X" value={(coatTopRot ?? sideRot).rx} min={-180} max={180}
                            onChange={v => setCoatTopRot(p => ({ ...(p ?? sideRot), rx: v }))} color="#e05252" />
                    <Slider label="Top Y" value={(coatTopRot ?? sideRot).ry} min={-180} max={180}
                            onChange={v => setCoatTopRot(p => ({ ...(p ?? sideRot), ry: v }))} color="#52c452" />
                    <Slider label="Top Z" value={(coatTopRot ?? sideRot).rz} min={-180} max={180}
                            onChange={v => setCoatTopRot(p => ({ ...(p ?? sideRot), rz: v }))} color="#5252e0" />
                  </div>
                )}
                {coat && coatStat && (
                  <div style={{ fontSize: 11, lineHeight: 1.5, padding: '7px 9px', borderRadius: 6,
                                background: '#f3f1f7', color: '#4a4458', fontFamily: 'monospace' }}>
                    <div><b>{coatStat.seats}</b> pieces · {coatStat.side.verts.toLocaleString()} verts each</div>
                    <div>GLB box&nbsp;&nbsp;{coatStat.side.raw.map(n => n.toFixed(2)).join(' × ')}</div>
                    <div>solid&nbsp;&nbsp;&nbsp;&nbsp;{coatStat.side.solid.map(n => n.toFixed(2)).join(' × ')}</div>
                    <div>side fit {coatStat.side.fitted.map(n => n.toFixed(2)).join(' × ')} (×{coatStat.side.scale.toFixed(3)})</div>
                    <div>top&nbsp; fit {coatStat.top.fitted.map(n => n.toFixed(2)).join(' × ')} (×{coatStat.top.scale.toFixed(3)})</div>
                    <div style={{ opacity: 0.7, marginTop: 3 }}>
                      seats from W {Math.max(coatStat.side.fitted[0], coatStat.top.fitted[0]).toFixed(3)}
                      · H {coatStat.side.fitted[2].toFixed(3)} · cake h 1.45
                      → {Math.max(1, Math.round((1.45 - coatStat.side.fitted[2]) / (coatStat.side.fitted[2] * 0.6)) + 1)} rows
                    </div>
                  </div>
                )}
              </>
            )}

            {/* ── Ring controls — board and rim only ─────────────────────────────────────────── */}
            {target !== 'side' && (<>
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
            <Slider label="Radial offset" value={cfg.radialOffset} min={-2} max={2} step={0.01} onChange={set('radialOffset')} />
            <Slider label="Y offset" value={cfg.yOffset} min={-0.5} max={4} step={0.01} onChange={set('yOffset')} />
            {!cfg.wrap && (
              <Slider label="Size" value={cfg.sizeFactor} min={0.2} max={8} step={0.05} resetTo={1} onChange={set('sizeFactor')} color="#e0a052" />
            )}
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
              <Slider label="Size" value={cfg.wrapSize} min={0.2} max={4} step={0.05} resetTo={1} onChange={set('wrapSize')} color="#e0a052" />
              <Slider label="Tilt" value={cfg.wrapTilt} min={-90} max={90} step={1} resetTo={0} onChange={set('wrapTilt')} color="#c47ad6" />
              <Slider label="Radial offset" value={cfg.radialOffset} min={-2} max={2} step={0.01} resetTo={0} onChange={set('radialOffset')} />
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
              <Slider label="Alt radial" value={cfg.altRadialOffset} min={-2} max={2} step={0.01} onChange={set('altRadialOffset')} />
              <Slider label="Alt Y offset" value={cfg.altYOffset} min={-0.5} max={4} step={0.01} onChange={set('altYOffset')} />
              <div style={{ fontSize: 10, color: '#9BB5A2', marginTop: -2, marginBottom: 6, lineHeight: 1.5 }}>
                Version B alternates with the original per the ratio above. The alternate GLB url is set
                when you upload it in <b>Manage Elements</b>; here you only tune B's transform + pattern.
              </div>
            </>}

            </>)}

            {/* Ring toggle — a RING preview switch, so it has no meaning on the wall tab. */}
            {target !== 'side' && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44' }}>Show full ring</span>
              <button onClick={() => setShowRing(r => !r)}
                style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: `2px solid ${showRing ? '#3D5A44' : '#C5D4C8'}`, background: showRing ? '#3D5A44' : '#fff', color: showRing ? '#fff' : '#6B8C74', cursor: 'pointer', fontWeight: 700 }}>
                {showRing ? 'ON' : 'OFF'}
              </button>
            </div>
            )}

            {/* Include in output — board-only / rim-only / both */}
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: '#9B5F72', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Include in JSON</div>
              {[{ k: 'board', on: includeBoard, setter: setIncludeBoard, label: 'Board (base)' },
                { k: 'rim',   on: includeRim,   setter: setIncludeRim,   label: 'Rim (top edge)' },
                /* Unticked writes nothing, and nothing is the right default: an element with no
                   `side_rotation` falls back to `bottom_rotation`, which is what every element
                   shipped before this key did. A paste must never silently take that away. */
                { k: 'side',  on: includeSide,  setter: setIncludeSide,  label: 'Side (wall)' }].map(row => (
                <label key={row.k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, cursor: 'pointer' }}>
                  <input type="checkbox" checked={row.on} onChange={e => row.setter(e.target.checked)} style={{ accentColor: '#3D5A44', width: 15, height: 15 }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44', fontFamily: "'Quicksand',sans-serif" }}>{row.label}</span>
                </label>
              ))}
              <div style={{ fontSize: 10, color: '#9BB5A2', marginTop: 2, lineHeight: 1.5 }}>
                Only checked sections are written. Board → <code>bottom_*</code>, Rim → <code>top_*</code>, Side → <code>side_rotation</code> (absent = follows the board).
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
                  Downloads a PNG of the cake on its own — full cake, board, and the placed element on a
                  transparent background (no canvas backdrop or floor), cropped to the cake.
                </div>
                <button onClick={captureScreenshot} disabled={!activeGlbUrl}
                  style={{ width: '100%', padding: '8px 0', background: activeGlbUrl ? '#9B5F72' : '#d8c2cb', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: activeGlbUrl ? 'pointer' : 'default', fontFamily: "'Quicksand',sans-serif" }}>
                  Download screenshot
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
              <CalibScene glbUrl={activeGlbUrl} cfg={boardCfg} showRing={showRing} anchorY={Y_BASE} inward={false} altGlbUrl={altBlobUrl} shape={shape} color={elementColor} />
            )}
            {activeGlbUrl && (includeRim || target === 'rim') && (
              <CalibScene glbUrl={activeGlbUrl} cfg={rimCfg} showRing={showRing} anchorY={Y_BASE + CAKE_HEIGHT} inward={true} altGlbUrl={altBlobUrl} shape={shape} color={elementColor} />
            )}
            {/* The wall run appears only while `side_rotation` is being authored — it is a hand-piped
                stroke, not a ring, and leaving it on the cake would misread as a third border. */}
            {activeGlbUrl && (includeSide || target === 'side') && (
              <WallStamps glbUrl={activeGlbUrl} rot={sideRot} color={elementColor} />
            )}
            {/* The coat is the whole cake, so it replaces the rings visually rather than joining
                them — but it is left as an independent toggle on purpose: seeing a border and a
                coat together is how you notice the two are reading the same rotation differently. */}
            {activeGlbUrl && coat && (
              <CoatScene glbUrl={activeGlbUrl} roseRadius={coatRadius}
                         topRot={coatTopRot ?? sideRot} sideRot={sideRot}
                         color={elementColor} softness={rimCfg.softness}
                         onMeasure={onCoatMeasure} showSeats={coatSeats} cover={coatCover}
                         rimStretch={coatRimStretch} />
            )}
          </Suspense>

          {/* minDistance lets the camera get inside a shell's own scale — the default 0 is fine but
              a floor stops a scroll flick from flying through the cake and losing the piece. */}
          <OrbitControls ref={orbitRef} makeDefault target={[0, focusY, focusZ]} minDistance={0.55} maxDistance={16} />
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
                <BuildingBlockScene glbUrl={activeGlbUrl} altGlbUrl={null} cfg={target === 'rim' ? rimCfg : boardCfg} color={elementColor} />
              </Suspense>
              <OrbitControls target={[0, 0.14, 0]} enableZoom={false} enablePan={false} enableRotate={false} />
            </Canvas>
          </div>
        )}

        {/* Hidden "clean" capture canvas (tune mode) — the SAME framing as the live view (whole
            cake + board + element), but on a TRANSPARENT background with NO floor, so "Download
            screenshot" yields just the cake (cropped to its bounds), not the canvas backdrop. */}
        {mode === 'tune' && activeGlbUrl && (
          <div ref={shotRef} style={{ position: 'absolute', left: -9999, top: -9999, width: 768, height: 768 }}>
            <Canvas shadows gl={{ preserveDrawingBuffer: true, alpha: true }} camera={{ position: [0, 5.5, 7.9], fov: 42 }} style={{ width: 768, height: 768, background: 'transparent' }}>
              <ambientLight intensity={0.7} />
              <directionalLight position={[5, 10, 5]} intensity={1.4} castShadow />
              <directionalLight position={[-3, 3, -3]} intensity={0.3} />
              <Suspense fallback={null}>
                <Environment preset="apartment" />
                <CakeScene shape={shape} floor={false} cakeColor={cakeColor} />
                {(includeBoard || target === 'board') && (
                  <CalibScene glbUrl={activeGlbUrl} cfg={boardCfg} showRing anchorY={Y_BASE} inward={false} altGlbUrl={altBlobUrl} shape={shape} color={elementColor} />
                )}
                {(includeRim || target === 'rim') && (
                  <CalibScene glbUrl={activeGlbUrl} cfg={rimCfg} showRing anchorY={Y_BASE + CAKE_HEIGHT} inward={true} altGlbUrl={altBlobUrl} shape={shape} color={elementColor} />
                )}
              </Suspense>
              <OrbitControls target={[0, 2, 0]} enableZoom={false} enablePan={false} enableRotate={false} />
            </Canvas>
          </div>
        )}

      </div>
    </div>
  );
}
