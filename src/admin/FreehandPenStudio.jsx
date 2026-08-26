import { useState, useRef, useMemo, useEffect, useCallback, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment, useGLTF } from '@react-three/drei';
import { HexColorPicker } from 'react-colorful';
import * as THREE from 'three';
import { useElementSave } from '../lib/useElementSave.js';

// ── Freehand cream pen ──────────────────────────────────────────────────────
// The customer (or baker) draws cream directly onto the cake with the mouse / finger:
// pointer-down on the cake starts a stroke, drag lays down a centerline along the
// surface, release ends it. Each stroke is swept into a cream-bead tube — the same
// renderer the cream-pen text uses — so freehand stems, vines, squiggles read as
// genuine piping. We can't ship an element for every shape; this is the escape hatch.
//
// Prototype first (mirrors CreamPenStudio): once it reads right, the stroke→tube core
// and the placement_config schema port into spattoo-core.

const CAKE_RADIUS = 1.2;
const CAKE_HEIGHT = 1.45;
const Y_BASE      = 0.1;

const PIPING_SOFTNESS_DEFAULT = 0.7;
function creamMaterialProps(softness, color) {
  const s = Math.min(1, Math.max(0, softness ?? PIPING_SOFTNESS_DEFAULT));
  return { color, roughness: 0.5 + 0.5 * s, sheen: (0.4 / 0.7) * s, sheenRoughness: 0.9, sheenColor: color };
}

const STANDARD_CAKE_COLOR = '#f5c6d0';

// ── Nozzles ──────────────────────────────────────────────────────────────────
// A piping tip is really just a CROSS-SECTION. Cream extruded through it = that
// profile swept along the stroke. So a round tip → smooth rope, an open star →
// ribbed rope with grooves down its length, French → many fine ribs. Each profile
// is a closed polygon at unit radius (max reach = 1); thickness scales it to size.
function starProfile(spikes, inner) {
  const out = [];
  for (let i = 0; i < spikes; i++) {
    const a0 = (i / spikes) * Math.PI * 2;          // outer point
    const a1 = ((i + 0.5) / spikes) * Math.PI * 2;  // valley between points
    out.push([Math.cos(a0), Math.sin(a0)]);
    out.push([Math.cos(a1) * inner, Math.sin(a1) * inner]);
  }
  return out;
}
function roundProfile(n) {
  const out = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; out.push([Math.cos(a), Math.sin(a)]); }
  return out;
}
// Tunable: spikes = rib count, inner = valley depth (smaller = deeper grooves).
const NOZZLES = [
  { key: 'round',    label: 'Round',       hint: 'Writing / smooth rope',  profile: roundProfile(16) },
  { key: 'star5',    label: 'Open Star',   hint: '1M — the classic',        profile: starProfile(5, 0.55) },
  { key: 'star6',    label: '6-Star',      hint: 'Tighter ribs',            profile: starProfile(6, 0.55) },
  { key: 'closed',   label: 'Closed Star', hint: 'Deep grooves',            profile: starProfile(6, 0.40) },
  { key: 'french',   label: 'French',      hint: 'Fine fluted ribs',        profile: starProfile(14, 0.82) },
];
const NOZZLE_BY_KEY = Object.fromEntries(NOZZLES.map(n => [n.key, n]));
const DEFAULT_NOZZLE = 'star5';

// ── Sweep core ───────────────────────────────────────────────────────────────
// Everything (rope, shell, rosette) is the SAME nozzle profile swept along some
// centerline — only the centerline and the radius-along-it change. We sample a
// CatmullRom through the control points, build Frenet frames (a stable normal/
// binormal plane per sample), drop the profile ring into each frame at radius
// `radiusAt(i, segs)`, stitch the rings, and fan-cap both ends (rounded tips).
// Appends into shared pos/idx so one geometry can hold many shells/rosettes.
const CAKE_TOP_Y = Y_BASE + CAKE_HEIGHT;

// Outward surface normal at a point on THIS cake — up on the top cap, radial on the
// wall. Lets shells/rosettes stand off the surface correctly on both.
function surfaceNormalAt(p) {
  if (p.y > CAKE_TOP_Y - 0.05) return new THREE.Vector3(0, 1, 0);
  const radial = new THREE.Vector3(p.x, 0, p.z);
  return radial.lengthSq() < 1e-6 ? new THREE.Vector3(0, 1, 0) : radial.normalize();
}

function pushSweep(pos, idx, controlPts, profile, radiusAt) {
  const curve = new THREE.CatmullRomCurve3(controlPts, false, 'catmullrom', 0.5);
  const segs = Math.min(800, Math.max(20, controlPts.length * 4));
  const samples = curve.getPoints(segs);                 // segs + 1
  const frames = curve.computeFrenetFrames(segs, false);
  const P = profile.length;
  const base = pos.length / 3;

  for (let i = 0; i <= segs; i++) {
    const C = samples[i], N = frames.normals[i], B = frames.binormals[i], r = radiusAt(i, segs);
    for (let j = 0; j < P; j++) {
      const px = profile[j][0] * r, py = profile[j][1] * r;
      pos.push(C.x + N.x * px + B.x * py, C.y + N.y * px + B.y * py, C.z + N.z * px + B.z * py);
    }
  }
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < P; j++) {
      const a = base + i * P + j, b = base + i * P + (j + 1) % P;
      const c = base + (i + 1) * P + j, d = base + (i + 1) * P + (j + 1) % P;
      idx.push(a, c, b, b, c, d);
    }
  }
  // fan caps, centre nudged out along the tangent so the tip rounds off
  const r0 = radiusAt(0, segs), rn = radiusAt(segs, segs);
  const sC = samples[0].clone().addScaledVector(frames.tangents[0], -r0 * 0.6);
  const eC = samples[segs].clone().addScaledVector(frames.tangents[segs], rn * 0.6);
  const sI = pos.length / 3; pos.push(sC.x, sC.y, sC.z);
  const eI = pos.length / 3; pos.push(eC.x, eC.y, eC.z);
  for (let j = 0; j < P; j++) {
    idx.push(sI, base + (j + 1) % P, base + j);
    idx.push(eI, base + segs * P + j, base + segs * P + (j + 1) % P);
  }
}

function finishGeo(pos, idx) {
  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// Walk a drawn polyline and drop a stamp every `step` of arc length, giving its
// position + travel direction — used to lay shell/rosette borders along the drag.
function stampAlong(points, step) {
  const pts = points.filter((p, i) => i === 0 || p.distanceTo(points[i - 1]) > 1e-4);
  if (pts.length === 0) return [];
  if (pts.length === 1) return [{ p: pts[0], dir: new THREE.Vector3(0, 0, -1) }];
  const out = [];
  let acc = 0, next = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], seg = a.distanceTo(b);
    if (seg < 1e-6) continue;
    const dir = b.clone().sub(a).multiplyScalar(1 / seg);
    while (next <= acc + seg + 1e-9) {
      out.push({ p: a.clone().lerp(b, (next - acc) / seg), dir: dir.clone() });
      next += step;
    }
    acc += seg;
  }
  if (!out.length) out.push({ p: pts[0], dir: pts[1].clone().sub(pts[0]).normalize() });
  return out;
}

// Seat a drawn path onto the cake. Each point is pushed out along the surface normal so
// the rope's UNDERSIDE touches whatever is below it: the cake itself (offset = rope
// radius), or — where the path loops back over cream it already laid — the top of that
// cream, so the new coil rests ON the lower one. `stack` turns that build-up on (rosette)
// or off (single layer: line). Works on the top (normal = up) and the wall (normal =
// radial). Input is the RAW surface hit; output is the seated centerline to sweep.
function seat(rawPoints, thickness, stack) {
  const pts = rawPoints.filter((p, i) => i === 0 || p.distanceTo(rawPoints[i - 1]) > 1e-4);
  if (pts.length === 0) return [];
  const reach = thickness * 1.6;   // footprints closer than this (along the surface) overlap
  const behind = thickness * 3;    // ignore same-coil neighbours laid within this arc length
  const placed = [];               // { tp: raw surface pt, s: arc length so far, off: normal offset }
  const out = [];
  let cum = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) cum += pts[i].distanceTo(pts[i - 1]);
    let off = thickness;           // default: rest on the cake (underside grazes the surface)
    if (stack) {
      let below = 0;
      for (const q of placed) {
        if (cum - q.s < behind) continue;                       // skip the current coil itself
        if (pts[i].distanceTo(q.tp) < reach && q.off > below) below = q.off;
      }
      if (below > 0) off = below + thickness * 1.7;             // nestle on top of the cream below
    }
    placed.push({ tp: pts[i], s: cum, off });
    out.push(pts[i].clone().addScaledVector(surfaceNormalAt(pts[i]), off));
  }
  return out;
}

// A lone tap can't sweep — give it a tiny stub so a dot still reads as piped cream.
function stubIfSingle(pts, thickness) {
  return pts.length === 1 ? [pts[0], pts[0].clone().add(new THREE.Vector3(0, Math.max(0.02, thickness), 0))] : pts;
}

// ── Style builders ──────────────────────────────────────────────────────────
// LINE — steady rope resting on the surface (single layer). Stems, vines, writing.
function buildLine(points, profile, thickness) {
  const pts = stubIfSingle(seat(points, thickness, false), thickness);
  if (pts.length === 0) return null;
  const pos = [], idx = [];
  pushSweep(pos, idx, pts, profile, () => thickness);
  return finishGeo(pos, idx);
}

// SHELL — a fat rounded head tapering to a pointed tail, piped in a row (shell border).
// Each shell is the profile swept along a short arc that rises off the surface then
// settles, with the radius swelling near the head and tapering to a point at the tail.
function buildShells(points, profile, thickness) {
  const headR = thickness * 2.2, L = thickness * 7, step = Math.max(L * 0.5, thickness * 3);
  const pos = [], idx = [];
  for (const { p, dir } of stampAlong(points, step)) {
    const up = surfaceNormalAt(p);
    let f = dir.clone().negate().addScaledVector(up, dir.dot(up));   // tail dir, on the surface
    if (f.lengthSq() < 1e-6) { f = new THREE.Vector3(1, 0, 0).addScaledVector(up, -up.x); }
    f.normalize();
    const hmax = headR * 1.1;
    const c = [
      p.clone().addScaledVector(up, headR * 0.7),   // nose resting on the surface, not sunk
      p.clone().addScaledVector(f, L * 0.15).addScaledVector(up, hmax * 0.95),
      p.clone().addScaledVector(f, L * 0.45).addScaledVector(up, hmax),
      p.clone().addScaledVector(f, L * 0.75).addScaledVector(up, hmax * 0.4),
      p.clone().addScaledVector(f, L).addScaledVector(up, headR * 0.05),
    ];
    const radiusAt = (i, n) => {
      const t = i / n;
      const s = t < 0.25 ? 0.55 + 0.45 * (t / 0.25) : Math.pow(1 - (t - 0.25) / 0.75, 1.5);
      return headR * Math.max(0.03, s);
    };
    pushSweep(pos, idx, c, profile, radiusAt);
  }
  return finishGeo(pos, idx);
}

// ROSETTE — fully freehand: the rope follows the exact path you draw (so YOU make the
// swirl). It's Line with stacking ON — the first coil sits on the cake, and where your
// spiral comes back over an earlier coil it climbs onto it, so tight coils dome up while
// a spread-out spiral stays flat. No floating: cream only rises when there's cream under it.
function buildRosettes(points, profile, thickness) {
  const pts = stubIfSingle(seat(points, thickness, true), thickness);
  if (pts.length === 0) return null;
  const pos = [], idx = [];
  pushSweep(pos, idx, pts, profile, () => thickness);
  return finishGeo(pos, idx);
}

const STROKE_BUILDERS = { line: buildLine, shell: buildShells, rosette: buildRosettes };
function buildStrokeGeometry(style, points, profile, thickness) {
  return (STROKE_BUILDERS[style] || buildLine)(points, profile, thickness);
}

function StrokeMesh({ style, points, color, thickness, softness, nozzle }) {
  const profile = (NOZZLE_BY_KEY[nozzle] || NOZZLE_BY_KEY[DEFAULT_NOZZLE]).profile;
  const geo = useMemo(() => buildStrokeGeometry(style, points, profile, thickness), [style, points, profile, thickness]);
  if (!geo) return null;
  return (
    <mesh geometry={geo} castShadow>
      {/* DoubleSide keeps the fan caps lit regardless of winding (cream is opaque) */}
      <meshPhysicalMaterial side={THREE.DoubleSide} {...creamMaterialProps(softness, color)} />
    </mesh>
  );
}

// ── GLB stamps ────────────────────────────────────────────────────────────────
// The other approach: instead of swept geometry, stamp a real modelled cream piece
// (dollop / swirl / shell) along the stroke — a tap drops one, a drag tiles a row (a
// shell/rope border). The GLB's own material is stripped and the shared cream material
// applied, so colour/softness still drive the look. This is the building-block path we'll
// port to spattoo-core if it reads better than the swept tubes.
const STAMPS = [
  { key: 'dollop',   label: 'Round Dollop',  url: '/piping/piping-round-dollop.glb' },
  { key: 'soft',     label: 'Soft Swirl',    url: '/piping/piping-soft-swirl.glb' },
  { key: 'shellsw',  label: 'Shell Swirl',   url: '/piping/piping-shell-swirl.glb' },
  { key: 'ruffled',  label: 'Ruffled Swirl', url: '/piping/piping-ruffled-swirl.glb' },
  { key: 'stardome', label: 'Star Dome',     url: '/piping/piping-star-dome.glb' },
];
STAMPS.forEach(s => useGLTF.preload(s.url));
const DEFAULT_STAMP = STAMPS[0].url;

// Tiny deterministic PRNG so per-stamp jitter (size + spin) is stable across re-renders.
function mulberry32(seed) {
  let t = (seed >>> 0) || 1;
  return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}

// Merge a GLB's meshes into one geometry, centred on X/Z with its base at y=0; report the
// footprint (max x/z) so a stamp can be scaled to the rope size.
function mergeGeos(geos) {
  const pos = [], idx = [];
  for (const g of geos) {
    const p = g.attributes.position, gi = g.index, base = pos.length / 3;
    for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i));
    if (gi) for (let i = 0; i < gi.count; i++) idx.push(base + gi.getX(i));
    else for (let i = 0; i < p.count; i++) idx.push(base + i);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setIndex(idx); out.computeVertexNormals();
  return out;
}
function useStampGeo(url) {
  const { scene } = useGLTF(url);
  return useMemo(() => {
    const geos = [];
    scene.traverse(o => { if (o.isMesh && o.geometry) geos.push(o.geometry.clone()); });
    if (!geos.length) return { geo: null, footprint: 1 };
    const merged = geos.length === 1 ? geos[0] : mergeGeos(geos);
    // These piping GLBs are authored lying down (tip along Z, glTF Y-up vs Z-up). Stand them
    // upright — tip → +Y — the same X+90° convention the cake's piping-ring loader uses, so
    // mapping +Y to the surface normal makes the piece point straight out of the cake.
    merged.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    merged.computeBoundingBox();
    const b = merged.boundingBox, size = new THREE.Vector3(), c = new THREE.Vector3();
    b.getSize(size); b.getCenter(c);
    merged.translate(-c.x, -b.min.y, -c.z);
    return { geo: merged, footprint: Math.max(size.x, size.z) };
  }, [scene]);
}

// Transforms for one stamp stroke: tap → one piece, drag → a tiled row. Orients each piece's
// up axis to the cake surface normal and its forward to the travel direction; seeded jitter
// keeps a row from looking cloned. The raw hit already sits ON the surface (no seat offset).
function stampTransforms(points, size, spacing, footprint, seed) {
  const baseScale = size / Math.max(footprint, 1e-4);   // size = stamp footprint in world units
  const rand = mulberry32(seed);
  const out = [];
  const place = (p, dir) => {
    const up = surfaceNormalAt(p);
    let fwd = dir ? dir.clone() : new THREE.Vector3(1, 0, 0);
    fwd.applyAxisAngle(up, dir ? (rand() - 0.5) * 0.5 : rand() * Math.PI * 2);
    let z = fwd.sub(up.clone().multiplyScalar(fwd.dot(up)));
    if (z.lengthSq() < 1e-8) z = new THREE.Vector3(0, 0, 1).sub(up.clone().multiplyScalar(up.z));
    z.normalize();
    const x = new THREE.Vector3().crossVectors(up, z).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, z));
    out.push({ pos: p.clone(), quat: q, scale: baseScale * (1 + (rand() - 0.5) * 0.16) });
  };
  const pts = points.filter((p, i) => i === 0 || p.distanceTo(points[i - 1]) > 1e-4);
  if (!pts.length) return out;
  let len = 0; for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
  if (pts.length === 1 || len < size * 0.5) { place(pts[0], null); return out; }          // tap
  const step = Math.max(spacing * size, 1e-3);
  for (const { p, dir } of stampAlong(pts, step)) place(p, dir);                          // row
  return out;
}

function StampStrokeMesh({ url, points, size, spacing, softness, color, seed }) {
  const { geo, footprint } = useStampGeo(url);
  const transforms = useMemo(
    () => (geo ? stampTransforms(points, size, spacing, footprint, seed) : []),
    [geo, footprint, points, size, spacing, seed],
  );
  if (!geo) return null;
  const mat = creamMaterialProps(softness, color);
  return transforms.map((t, i) => (
    <mesh key={i} geometry={geo} position={t.pos} quaternion={t.quat} scale={t.scale} castShadow>
      <meshPhysicalMaterial {...mat} />
    </mesh>
  ));
}

// The raw point where the pointer ray meets the cake surface. No offset here — the
// stroke builders seat the cream onto the surface (and onto cream already piped beneath
// it), so resting height is decided by geometry, not a fixed fudge.
function hitPoint(e) {
  return e.point.clone();
}

function Scene({
  thumbView, thumbTarget,
  cakeColor, minGap, activeRef,
  liveColor, liveThickness, liveSoftness, liveNozzle, liveStyleKind, liveStampUrl, liveStampSize, liveSpacing,
  committed, live, onStart, onMove,
}) {
  // Orbit is on by default; we only switch OFF rotate while the pointer is over the
  // cake, so a press-drag there pipes instead of spinning the view. A drag that starts
  // off the cake (empty space) rotates normally. Zoom & pan stay live everywhere.
  const controls = useRef();
  const overRef  = useRef(false);   // is the pointer currently over the cake?
  const setRotate = on => { if (controls.current) controls.current.enableRotate = on; };

  // Disable rotate the instant the pointer is over the cake (not just on press), so the
  // pointerdown that begins a stroke can never be grabbed by OrbitControls first.
  const handleEnter = useCallback(() => { overRef.current = true; setRotate(false); }, []);
  // Leaving re-arms orbit — unless we're mid-stroke (a fast drag can wander off the cake
  // and we don't want it to suddenly start spinning the view).
  const handleLeave = useCallback(() => { overRef.current = false; if (!activeRef.current) setRotate(true); }, [activeRef]);

  const handleDown = useCallback(e => {
    e.stopPropagation();
    try { e.target.setPointerCapture(e.pointerId); } catch { /* noop */ }
    setRotate(false);
    onStart(hitPoint(e));
  }, [onStart]);

  const handleMove = useCallback(e => {
    e.stopPropagation();
    onMove(hitPoint(e), minGap);
  }, [onMove, minGap]);

  // A stroke can end off the cake (pointer wandered off the surface). Once released,
  // re-arm orbit if the pointer is no longer over the cake.
  useEffect(() => {
    const rearm = () => { if (!overRef.current) setRotate(true); };
    window.addEventListener('pointerup', rearm);
    window.addEventListener('pointercancel', rearm);
    return () => {
      window.removeEventListener('pointerup', rearm);
      window.removeEventListener('pointercancel', rearm);
    };
  }, []);

  return (
    <>
      <ambientLight intensity={0.7} />
      <directionalLight position={[5, 10, 5]} intensity={1.4} castShadow />
      <directionalLight position={[-3, 3, -3]} intensity={0.3} />
      <Environment preset="apartment" backgroundBlurriness={1} />

      {/* board */}
      {!thumbView && (
        <mesh position={[0, 0.05, 0]} receiveShadow>
          <cylinderGeometry args={[CAKE_RADIUS + 0.6, CAKE_RADIUS + 0.6, 0.1, 64]} />
          <meshStandardMaterial color="#d4af37" roughness={0.15} metalness={0.75} />
        </mesh>
      )}

      {/* ── The writable cake — top cap + side wall, one mesh, so you can pipe anywhere ──────────
          GONE in the tile. A picker card is about 60px, and every tile that showed a cake was
          unreadable at that size while the one that showed only its object — the letter block — read
          perfectly. The cake is what the cream was drawn ON; it is not what is being chosen.
          The cream keeps the shape the cake gave it, because the stroke points are already seated on
          that surface. It simply floats, exactly as the letter block does. */}
      {!thumbView && (
        <mesh
          position={[0, Y_BASE + CAKE_HEIGHT / 2, 0]}
          castShadow receiveShadow
          onPointerEnter={handleEnter}
          onPointerLeave={handleLeave}
          onPointerDown={handleDown}
          onPointerMove={handleMove}
        >
          <cylinderGeometry args={[CAKE_RADIUS, CAKE_RADIUS, CAKE_HEIGHT, 96]} />
          <meshStandardMaterial color={cakeColor} roughness={0.68} />
        </mesh>
      )}

      {/* floor — gone in the tile, where the subject is the cream and nothing else */}
      {!thumbView && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
          <planeGeometry args={[20, 20]} />
          <meshStandardMaterial color="#f0ebe5" roughness={0.9} />
        </mesh>
      )}

      {/* committed + live strokes (Suspense covers the GLB stamp loads) */}
      <Suspense fallback={null}>
        {committed.map((s, i) => (s.style === 'stamp'
          ? <StampStrokeMesh key={i} url={s.stampUrl} points={s.points} size={s.stampSize} spacing={s.spacing} softness={s.softness} color={s.color} seed={s.seed} />
          : <StrokeMesh key={i} style={s.style} points={s.points} color={s.color} thickness={s.thickness} softness={s.softness} nozzle={s.nozzle} />))}
        {live.length > 0 && (liveStyleKind === 'stamp'
          ? <StampStrokeMesh url={liveStampUrl} points={live} size={liveStampSize} spacing={liveSpacing} softness={liveSoftness} color={liveColor} seed={1} />
          : <StrokeMesh style={liveStyleKind} points={live} color={liveColor} thickness={liveThickness} softness={liveSoftness} nozzle={liveNozzle} />)}
      </Suspense>

      {/* rotate auto-disables while the pointer is over the cake (see handlers above) */}
      {/* The tile looks AT the cream, not at the middle of the cake. */}
      <OrbitControls ref={controls} makeDefault target={thumbView ? thumbTarget : [0, 1.6, 0]} />
    </>
  );
}

function Slider({ label, value, min, max, step = 1, onChange, color = '#3D5A44', resetTo = 0 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color, minWidth: 96, fontFamily: "'Quicksand',sans-serif" }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))} style={{ flex: 1, accentColor: color }} />
      <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 46, textAlign: 'right', fontFamily: "'Quicksand',sans-serif" }}>
        {typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(3) : value}
      </span>
      <button onClick={() => onChange(resetTo)}
        style={{ fontSize: 10, padding: '2px 6px', border: '1px solid #C5D4C8', borderRadius: 4, background: '#fff', cursor: 'pointer', color: '#9BB5A2' }}>
        {resetTo}
      </button>
    </div>
  );
}

// Draw a nozzle's cross-section polygon as a little tip icon (the hole you'd pipe through).
function NozzlePreview({ profile, fill, size = 30 }) {
  const r = size / 2 - 2, c = size / 2;
  const d = profile.map((p, i) => `${i ? 'L' : 'M'}${(c + p[0] * r).toFixed(1)} ${(c - p[1] * r).toFixed(1)}`).join(' ') + ' Z';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <circle cx={c} cy={c} r={r + 1.5} fill="none" stroke="#C5D4C8" strokeWidth="1.5" />
      <path d={d} fill={fill} stroke="#7d9a86" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  );
}

function PipingBag({ color }) {
  return (
    <svg width="40" height="52" viewBox="0 0 40 52" style={{ flexShrink: 0 }}>
      <path d="M6 4 H34 L24 30 H16 Z" fill={color} stroke="#9BB5A2" strokeWidth="1.5" strokeLinejoin="round" />
      <rect x="16" y="30" width="8" height="9" rx="1.5" fill={color} stroke="#9BB5A2" strokeWidth="1.5" />
      <path d="M18 39 Q20 48 20 50 Q20 48 22 39 Z" fill={color} />
      <path d="M6 4 H34" stroke="#7d9a86" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

// One number, used by both the camera and the fit that decides where to put it — two copies
// would be a tile framed for a field of view it is not being rendered at.
const THUMB_FOV = 34;

export default function FreehandPenStudio() {
  const [color, setColor]       = useState('#ffffff');
  const [thickness, setThick]   = useState(0.03);
  const [softness, setSoft]     = useState(PIPING_SOFTNESS_DEFAULT);
  const [nozzle, setNozzle]     = useState(DEFAULT_NOZZLE);
  const [style, setStyle]       = useState('line');   // line | shell | rosette | stamp
  const [stampUrl, setStampUrl] = useState(DEFAULT_STAMP);
  const [stampSize, setStampSize] = useState(0.32);   // stamp footprint in world units (cake r = 1.2)
  const [spacing, setSpacing]   = useState(0.85);
  const [cakeColor, setCakeColor] = useState(STANDARD_CAKE_COLOR);

  const previewRef = useRef(null);
  // ── The tile is the CREAM, close up ───────────────────────────────────────────────────────────
  // A card is about 60px. A whole cake at that size is a pale disc and the bead of cream — the thing
  // being chosen — is a few pixels of it. Draw a stroke, then frame it.
  const [thumbView, setThumbView] = useState(false);

  // ── Save, so the pen can be filed under Art ───────────────────────────────────────────────────
  // This was a calibration screen with no way out — the pen could be tuned and never authored, so it
  // had no row and sat loose in the tools area with grass and dust. Luster dust had the same gap and
  // was fixed the same way today.
  //
  // A row carries the LOOK: the nozzle, the colour, how thick and how soft. NOT the strokes — those
  // are where this hand went on this cake, and shipping them would put somebody else's drawing on
  // every cake that picks the row. Same call the dust makes about its splashes.
  //
  // `surface_treatment` is already the right type. Migration 076 wrote its description as "generated
  // finishes that COVER a surface rather than standing on it — piped grass over a tier, dust flicked
  // up a wall, freehand cream", so the shelf was built for this before it existed.
  const { editing, saveName, setSaveName, busy, msg, save } = useElementSave({
    typeSlug: 'surface_treatment',
    categorySlug: 'art',
    canvasRef: previewRef,
    buildPayload: () => ({
      allowed_zones: ['top_surface', 'side', 'board'],
      default_color: color,
      placement_config: {
        procedural: 'cream_pen',
        cream_pen: { nozzle, color, thickness: +thickness.toFixed(4),
                     softness: +softness.toFixed(3), spacing: +spacing.toFixed(3) },
      },
    }),
    onHydrate: (el) => {
      const t = el.placement_config?.cream_pen ?? {};
      if (t.color) setColor(t.color);
      if (t.thickness != null) setThick(t.thickness);
      if (t.softness != null) setSoft(t.softness);
      if (t.nozzle) setNozzle(t.nozzle);
      if (t.spacing != null) setSpacing(t.spacing);
    },
  });

  const [committed, setCommitted] = useState([]);   // [{ style, points, color, thickness, softness, nozzle, stampUrl, spacing, seed }]
  const [live, setLive]           = useState([]);   // Vector3[]
  const activeRef = useRef(false);
  // freeze the cream + nozzle + style of the in-progress stroke at the values it started with
  const liveStyle = useRef({ color, thickness, softness, nozzle, style, stampUrl, stampSize, spacing });
  // min world-space spacing between captured points (keeps the tube clean + cheap)
  const minGap = useMemo(() => Math.max(0.008, thickness * 0.5), [thickness]);

  const startStroke = useCallback(pt => {
    activeRef.current = true;
    liveStyle.current = { color, thickness, softness, nozzle, style, stampUrl, stampSize, spacing };
    setLive([pt]);
  }, [color, thickness, softness, nozzle, style, stampUrl, stampSize, spacing]);

  const movePoint = useCallback((pt, gap) => {
    if (!activeRef.current) return;
    setLive(prev => {
      if (prev.length && pt.distanceTo(prev[prev.length - 1]) < gap) return prev;
      return [...prev, pt];
    });
  }, []);

  // End the stroke wherever the pointer comes up — even off the cake / off-canvas.
  useEffect(() => {
    const end = () => {
      if (!activeRef.current) return;
      activeRef.current = false;
      setLive(pts => {
        if (pts.length) {
          const s = liveStyle.current;
          setCommitted(c => [...c, { style: s.style, points: pts, color: s.color, thickness: s.thickness, softness: s.softness, nozzle: s.nozzle, stampUrl: s.stampUrl, stampSize: s.stampSize, spacing: s.spacing, seed: Math.floor(Math.random() * 1e6) }]);
        }
        return [];
      });
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, []);

  // ── The tile frames the CREAM, fitted to it ───────────────────────────────────────────────────
  // A fixed camera distance was the first attempt and produced a tiny drawing in a big frame: how
  // far away the right distance is depends entirely on how big a thing was drawn, and a stroke can
  // be a dot or a wreath round the whole cake.
  //
  // So it measures. Centre on the strokes' own middle, stand back by their largest dimension, and
  // the drawing fills the tile whatever was drawn. The same thing RainbowStudio's `shot` does.
  const shot = useMemo(() => {
    const pts = committed.flatMap(s => s.points ?? []);
    if (!pts.length) return { centre: [0, Y_BASE + CAKE_HEIGHT * 0.55, 0], dist: 2.6 };
    const span = a => { const v = pts.map(p => p[a]); return [Math.min(...v), Math.max(...v)]; };
    const [x0, x1] = span('x'), [y0, y1] = span('y'), [z0, z1] = span('z');
    const centre = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    // How far back to stand is TRIGONOMETRY, not a guessed multiplier. To fit something `size`
    // across at a vertical field of view `f`, the camera sits at (size/2) / tan(f/2) — for 34° that
    // is size × 2.05. The first attempt used 1.5×, which is nearer than the fit requires, so the
    // drawing was cropped rather than framed.
    //
    // The BIGGER of width and height, measured against the VERTICAL fov: a wide squiggle needs the
    // same room a tall one does, and the canvas is wider than it is tall, so fitting the height
    // fits the width for free.
    const size = Math.max(x1 - x0, y1 - y0, 0.25);
    const fit = size / (2 * Math.tan((THUMB_FOV * Math.PI / 180) / 2));
    return { centre, dist: Math.max(0.6, fit * 1.18) };   // 18% air, so nothing touches the edge
  }, [committed]);

  const undo  = () => setCommitted(c => c.slice(0, -1));
  const clear = () => setCommitted([]);

  // placement_config — strokes as rounded polylines in cake-space (origin-centred,
  // CAKE_RADIUS units). The core importer rebuilds the same tubes from this.
  const cfgJson = useMemo(() => JSON.stringify({
    type: 'freehand_piping',
    strokes: committed.map(s => ({
      style:     s.style,
      ...(s.style === 'stamp'
        ? { stampUrl: s.stampUrl, stampSize: +s.stampSize.toFixed(3), spacing: +s.spacing.toFixed(2), seed: s.seed }
        : { nozzle: s.nozzle }),
      color:     s.color,
      thickness: +s.thickness.toFixed(3),
      softness:  +s.softness.toFixed(2),
      points:    s.points.map(p => [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)]),
    })),
  }, null, 2), [committed]);

  const panel = { background: '#fff', border: '1.5px solid #E8EFE9', borderRadius: 12, padding: 16, marginBottom: 14 };
  const heading = { fontSize: 11, fontWeight: 800, color: '#9B5F72', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 };
  const totalPts = committed.reduce((n, s) => n + s.points.length, 0);

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', fontFamily: "'Quicksand', sans-serif", background: '#EDEAE2' }}>
      {/* Controls */}
      <div style={{ width: 360, overflowY: 'auto', padding: 18, borderRight: '1px solid #DCE5DD' }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, color: '#2C4433', margin: '0 0 4px' }}>Freehand Pen</h2>
        <p style={{ fontSize: 11, color: '#9BB5A2', margin: '0 0 16px', lineHeight: 1.5 }}>
          Drag on the cake to pipe a stroke, release to stop. Drag the empty space around it to
          rotate the view. Great for stems, vines and squiggles. Prototype — the stroke→tube core
          ports into <b>spattoo-core</b>.
        </p>

        <div style={panel}>
          <div style={heading}>Style</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {[
              { k: 'line',    l: 'Line',    h: 'Steady rope — stems, vines, writing' },
              { k: 'shell',   l: 'Shell',   h: 'Shell border — drag to lay a row' },
              { k: 'rosette', l: 'Rosette', h: 'Freehand swirl that builds up as you coil it' },
              { k: 'stamp',   l: 'Stamp',   h: 'Place a real cream GLB — tap one, drag a row' },
            ].map(s => {
              const on = style === s.k;
              return (
                <button key={s.k} onClick={() => setStyle(s.k)} title={s.h}
                  style={{ flex: 1, fontSize: 12, padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontWeight: 700,
                    border: `2px solid ${on ? '#3D5A44' : '#C5D4C8'}`,
                    background: on ? '#3D5A44' : '#fff', color: on ? '#fff' : '#6B8C74' }}>
                  {s.l}
                </button>
              );
            })}
          </div>
          <p style={{ fontSize: 10, color: '#9BB5A2', margin: '8px 0 0', lineHeight: 1.5 }}>
            {style === 'line' ? 'Drag to pipe a continuous rope.'
              : style === 'shell' ? 'Drag along where you want the border — shells march along the path.'
              : style === 'rosette' ? 'Draw a spiral — the cream follows your hand and builds up as the coils stack.'
              : 'Tap the cake to place one cream piece · drag to lay a row of them.'}
          </p>
        </div>

        {style === 'stamp' && (
          <div style={panel}>
            <div style={heading}>Cream piece (GLB)</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {STAMPS.map(st => {
                const on = stampUrl === st.url;
                return (
                  <button key={st.key} onClick={() => setStampUrl(st.url)} title={st.label}
                    style={{ flex: '1 0 96px', padding: '8px 6px', borderRadius: 8, cursor: 'pointer', fontSize: 10.5, fontWeight: 800,
                      background: on ? '#EEF4EF' : '#fff', border: `2px solid ${on ? '#3D5A44' : '#C5D4C8'}`, color: on ? '#2C4433' : '#6B8C74' }}>
                    {st.label}
                  </button>
                );
              })}
            </div>
            <div style={{ marginTop: 12 }}>
              <Slider label="Size" value={stampSize} min={0.1} max={0.8} step={0.02} resetTo={0.32} onChange={setStampSize} color="#c47ad6" />
              <Slider label="Spacing" value={spacing} min={0.5} max={2.0} step={0.05} resetTo={0.85} onChange={setSpacing} color="#c47ad6" />
            </div>
            <p style={{ fontSize: 10, color: '#9BB5A2', margin: '8px 0 0', lineHeight: 1.5 }}>
              Size = piece footprint in cake units (cake radius ≈ 1.2) · Spacing = how tightly a dragged row overlaps. Thickness/Nozzle are ignored in this mode.
            </p>
          </div>
        )}

        <div style={panel}>
          <div style={heading}>Nozzle</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {NOZZLES.map(n => {
              const on = nozzle === n.key;
              return (
                <button key={n.key} onClick={() => setNozzle(n.key)} title={n.hint}
                  style={{ flex: '1 0 60px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                    padding: '8px 4px', borderRadius: 8, cursor: 'pointer', background: on ? '#EEF4EF' : '#fff',
                    border: `2px solid ${on ? '#3D5A44' : '#C5D4C8'}` }}>
                  <NozzlePreview profile={n.profile} fill={color} />
                  <span style={{ fontSize: 9.5, fontWeight: 800, color: on ? '#2C4433' : '#6B8C74' }}>{n.label}</span>
                </button>
              );
            })}
          </div>
          <p style={{ fontSize: 10, color: '#9BB5A2', margin: '8px 0 0', lineHeight: 1.5 }}>
            {NOZZLE_BY_KEY[nozzle]?.hint} — the cream takes the tip's cross-section as you draw.
          </p>
        </div>

        <div style={panel}>
          <div style={heading}>Cream</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <PipingBag color={color} />
            <div style={{ flex: 1 }}>
              <HexColorPicker color={color} onChange={setColor} style={{ width: '100%', height: 120 }} />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <Slider label="Thickness" value={thickness} min={0.008} max={0.07} step={0.002} resetTo={0.03} onChange={setThick} color="#c47ad6" />
            <Slider label="Softness" value={softness} min={0} max={1} step={0.05} resetTo={PIPING_SOFTNESS_DEFAULT} onChange={setSoft} />
          </div>
          <p style={{ fontSize: 10, color: '#9BB5A2', margin: '8px 0 0', lineHeight: 1.5 }}>
            Softness: 0 = glossy gel · 0.7 = buttercream · 1 = matte.
          </p>
        </div>

        <div style={panel}>
          <div style={heading}>Strokes</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={undo} disabled={!committed.length}
              style={{ flex: 1, fontSize: 12, padding: '9px 0', borderRadius: 8, fontWeight: 700,
                border: '2px solid #C5D4C8', background: '#fff', color: committed.length ? '#6B8C74' : '#C5D4C8',
                cursor: committed.length ? 'pointer' : 'not-allowed' }}>
              Undo
            </button>
            <button onClick={clear} disabled={!committed.length}
              style={{ flex: 1, fontSize: 12, padding: '9px 0', borderRadius: 8, fontWeight: 700,
                border: '2px solid #E7C3C3', background: '#fff', color: committed.length ? '#C0392B' : '#E7C3C3',
                cursor: committed.length ? 'pointer' : 'not-allowed' }}>
              Clear
            </button>
          </div>
          <p style={{ fontSize: 11, color: '#6B8C74', margin: '10px 0 0', fontWeight: 700 }}>
            {committed.length} stroke{committed.length === 1 ? '' : 's'} · {totalPts} points
          </p>
        </div>

        {/* The look has been judged; the row is what puts it on a shelf a customer browses. */}
        <div style={panel}>
          <div style={heading}>{editing ? 'editing a saved pen' : 'save as element'}</div>
          {editing && (
            <p style={{ fontSize: 10.5, color: '#6B8C74', margin: '0 0 6px', lineHeight: 1.45 }}>
              Revising <b>{editing.name}</b> — saving replaces its settings and thumbnail.
            </p>
          )}
          {/* One click, and what is on screen is exactly what gets stored. */}
          <button onClick={() => setThumbView(v => !v)}
            style={{ width: '100%', marginBottom: 6, padding: '7px 9px', fontSize: 12, borderRadius: 7,
              cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700, border: '1.5px solid #2C4433',
              background: thumbView ? '#2C4433' : '#fff', color: thumbView ? '#fff' : '#2C4433' }}>
            {thumbView ? 'Thumbnail view — this is the tile' : 'Set up the thumbnail'}
          </button>
          {thumbView && !committed.length && (
            <p style={{ fontSize: 10.5, color: '#C0392B', margin: '0 0 6px', lineHeight: 1.45 }}>
              Nothing drawn yet — draw a stroke on the cake first, or the tile will be empty.
            </p>
          )}
          <input value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="e.g. Cream pen"
            style={{ width: '100%', padding: '7px 9px', fontSize: 12.5, fontFamily: 'inherit',
              border: '1.5px solid #C5D4C8', borderRadius: 7, boxSizing: 'border-box' }} />
          <button onClick={save} disabled={busy || !saveName.trim()}
            style={{ marginTop: 8, width: '100%', padding: '8px 0', fontSize: 12.5, borderRadius: 7,
              fontFamily: 'inherit', fontWeight: 700, border: 'none',
              cursor: busy || !saveName.trim() ? 'default' : 'pointer',
              background: busy || !saveName.trim() ? '#E3E0DA' : '#2C4433',
              color: busy || !saveName.trim() ? '#9a939a' : '#fff' }}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Save to catalogue'}
          </button>
          {msg && <p style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45,
            color: msg.ok ? '#2C4433' : '#C0392B' }}>{msg.text}</p>}
        </div>

        <div style={panel}>
          <div style={heading}>placement_config</div>
          <pre style={{ fontSize: 10, color: '#2C4433', margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', lineHeight: 1.4, maxHeight: 220, overflowY: 'auto' }}>{cfgJson}</pre>
        </div>
      </div>

      {/* Preview */}
      <div style={{ flex: 1, position: 'relative' }} ref={previewRef}>
        {/* preserveDrawingBuffer, or the saved thumbnail is a BLANK png: WebGL clears the drawing
            buffer after compositing, so toBlob() reads an empty one and every step after it
            succeeds — the upload works, the row saves, and the element sits in the picker with no
            picture. Four of the five studios were missing this and were fixed; this one was the
            fifth, which is why "Cream Pen" saved with no thumbnail.
            Keyed on the view, because a Canvas takes its camera on mount only. */}
        <Canvas key={thumbView ? 'thumb' : 'scene'} shadows
          camera={thumbView
            ? { position: [shot.centre[0], shot.centre[1], shot.centre[2] + shot.dist], fov: THUMB_FOV }
            : { position: [0, 4.6, 6.2], fov: 42 }}
          gl={{ preserveDrawingBuffer: true }}
          style={{ touchAction: 'none', cursor: 'crosshair' }}>
          <Scene
            cakeColor={cakeColor} minGap={minGap} activeRef={activeRef}
            liveColor={color} liveThickness={thickness} liveSoftness={softness} liveNozzle={nozzle} liveStyleKind={style}
            liveStampUrl={stampUrl} liveStampSize={stampSize} liveSpacing={spacing}
            committed={committed} live={live} onStart={startStroke} onMove={movePoint}
            thumbView={thumbView} thumbTarget={shot.centre}
          />
        </Canvas>

        <div style={{ position: 'absolute', top: 14, left: 14, background: '#fff', padding: '6px 12px',
          borderRadius: 10, border: '1px solid #E8EFE9', fontSize: 11, fontWeight: 700, color: '#3D5A44' }}>
          Drag on the cake to pipe · drag the empty space to rotate
        </div>

        <div style={{ position: 'absolute', top: 14, right: 14, display: 'flex', alignItems: 'center', gap: 8,
          background: '#fff', padding: '6px 10px', borderRadius: 10, border: '1px solid #E8EFE9' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#6B8C74' }}>Cake</span>
          <input type="color" value={cakeColor} onChange={e => setCakeColor(e.target.value)}
            style={{ width: 28, height: 28, border: 'none', background: 'none', cursor: 'pointer' }} />
        </div>
      </div>
    </div>
  );
}
