import { useState, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import { HexColorPicker } from 'react-colorful';
import * as THREE from 'three';
import { Font, mergeBufferGeometries } from 'three-stdlib';

// PIPED uses true single-stroke (centerline) faces — vendored single-line vector fonts
// (EMS + Hershey, public domain), pre-flattened to polylines per glyph: { name, em, space,
// glyphs:{ ch:{ a:advance, s:[[ [x,y],… ],…] } } } in y-up font units. A swept tube along a
// centerline reads as a genuine cream rope. RAISED uses three.js outline faces (extrude).
import creamFonts   from './creamFonts.json';
import gentilis     from 'three/examples/fonts/gentilis_regular.typeface.json';
import gentilisBold from 'three/examples/fonts/gentilis_bold.typeface.json';
import optimer      from 'three/examples/fonts/optimer_regular.typeface.json';
/* ⚠️ CREAM'S MATERIAL COMES FROM CORE. This file had its own `creamMaterialProps`, and it had
 * drifted where it matters most — it passed the raw hex through as `color`/`sheenColor`, while core
 * runs it through `creamAlbedo`, the correction for cream's own measured reference light, and adds
 * `specularIntensity`. So the SAME hex rendered as two different colours here and on the cake, in a
 * tool whose job is judging colour. One definition, imported. */
import { creamMaterialProps } from '@spattoo/designer';

// ── Cake stage — mirrors PipingCalibrator so the preview reads like the designer ──
const CAKE_RADIUS = 1.2;
const CAKE_HEIGHT = 1.45;
const Y_BASE      = 0.1;
const TOP_Y       = Y_BASE + CAKE_HEIGHT;   // the writable top surface
const DEG         = Math.PI / 180;

const PIPING_SOFTNESS_DEFAULT = 0.7;

const STANDARD_CAKE_COLOR = '#f5c6d0';
function CakeScene({ cakeColor = STANDARD_CAKE_COLOR }) {
  return (
    <>
      <mesh position={[0, 0.05, 0]} receiveShadow>
        <cylinderGeometry args={[CAKE_RADIUS + 0.6, CAKE_RADIUS + 0.6, 0.1, 64]} />
        <meshStandardMaterial color="#d4af37" roughness={0.15} metalness={0.75} />
      </mesh>
      <mesh position={[0, Y_BASE + CAKE_HEIGHT / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[CAKE_RADIUS, CAKE_RADIUS, CAKE_HEIGHT, 64]} />
        <meshStandardMaterial color={cakeColor} roughness={0.68} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[20, 20]} />
        <meshStandardMaterial color="#f0ebe5" roughness={0.9} />
      </mesh>
    </>
  );
}

// ── Font registry ─────────────────────────────────────────────────────────────
// 'stroke' faces (single-line, from creamFonts) feed the PIPED tube sweep; 'outline'
// faces (three.js typeface) feed the RAISED extrude. The picker shows only the faces
// matching the current style.
const OUTLINE_FONTS = {
  gentilis:     new Font(gentilis),
  gentilisBold: new Font(gentilisBold),
  optimer:      new Font(optimer),
};
const FONT_OPTIONS = [
  // Single-line cream-pen faces, taken from the vendored set (label from the data).
  ...Object.keys(creamFonts).map(key => ({ key, label: creamFonts[key].name, type: 'stroke' })),
  { key: 'gentilis',     label: 'Gentilis',      type: 'outline' },
  { key: 'gentilisBold', label: 'Gentilis Bold', type: 'outline' },
  { key: 'optimer',      label: 'Optimer',       type: 'outline' },
];
const FONT_TYPE = Object.fromEntries(FONT_OPTIONS.map(f => [f.key, f.type]));

// ── Geometry builders (the reusable core that ports to spattoo-core) ────────────

// Lay a string out in a single-line font → centerline polylines (Vector3, z=0) in the
// font's own units (y-up). `fitStrokes` scales them to the cake afterwards. Missing
// lowercase falls back to uppercase so every name renders.
function strokesFromFont(fontKey, text) {
  const font = creamFonts[fontKey];
  if (!font || !text) return [];
  const out = [];
  let penX = 0;
  for (const ch of text) {
    if (ch === ' ') { penX += font.space; continue; }
    const g = font.glyphs[ch] || font.glyphs[ch.toUpperCase()] || font.glyphs[ch.toLowerCase()];
    if (!g) { penX += font.space; continue; }
    for (const s of g.s) out.push(s.map(([x, y]) => new THREE.Vector3(x + penX, y, 0)));
    penX += g.a;
  }
  return out;
}

// Scale strokes (in place, around origin) so the writing spans `fitFrac` of the cake-top
// diameter — names auto-fit whatever their length. Done on the CENTERLINES, before the
// sweep, so the bead thickness stays an absolute nozzle width independent of fit.
function fitStrokes(strokes, fitFrac) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of strokes) for (const p of s) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX, h = maxY - minY;
  if (!(w > 0) && !(h > 0)) return strokes;
  const target = fitFrac * 2 * CAKE_RADIUS;
  const f = Math.min(w > 0 ? target / w : Infinity, h > 0 ? target / h : Infinity);
  for (const s of strokes) for (const p of s) p.multiplyScalar(f);
  return strokes;
}

// PIPED — sweep a constant-radius cream tube along each centerline stroke (the "pen
// bead"). `thickness` is the bead radius — the real nozzle-width control. Round caps
// at both ends (and a bead for single-point dots) so strokes start/stop like piping.
function buildPipedFromStrokes(strokes, { thickness }) {
  if (!strokes.length) return null;
  const geos = [];
  const cap = pt => {
    const s = new THREE.SphereGeometry(thickness, 8, 6);
    s.translate(pt.x, pt.y, pt.z);
    geos.push(s);
  };
  for (const raw of strokes) {
    // Drop consecutive duplicate points — zero-length segments give TubeGeometry NaN frames.
    const pts = raw.filter((p, i) => i === 0 || p.distanceTo(raw[i - 1]) > 1e-4);
    if (pts.length === 1) { cap(pts[0]); continue; }
    if (pts.length < 2) continue;
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
    geos.push(new THREE.TubeGeometry(curve, Math.max(16, pts.length * 4), thickness, 8, false));
    cap(pts[0]); cap(pts[pts.length - 1]);
  }
  return geos.length ? mergeBufferGeometries(geos, false) : null;
}

// RAISED — extruded filled letters with a rounded bevel → soft cream relief.
// `depth` lifts them off the surface; `bevel` rounds the edges so they read as icing.
// Built at a unit size then scaled in X/Y to fit the top (depth stays absolute).
function buildRaised(font, text, { depth, bevel, fitFrac }) {
  if (!text.trim()) return null;
  const shapes = font.generateShapes(text, 1);
  if (!shapes.length) return null;
  const g = new THREE.ExtrudeGeometry(shapes, {
    depth, curveSegments: 10,
    bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 4,
  });
  g.computeBoundingBox();
  const b = g.boundingBox, w = b.max.x - b.min.x, h = b.max.y - b.min.y;
  const target = fitFrac * 2 * CAKE_RADIUS;
  const f = Math.min(w > 0 ? target / w : Infinity, h > 0 ? target / h : Infinity);
  if (Number.isFinite(f)) g.scale(f, f, 1);   // fit footprint, keep extrude depth
  return g;
}

// Centre the text on X/Y and sit it on the surface (min Z → 0), so group transforms
// below place it cleanly on the cake top.
function centerOnSurface(geo) {
  if (!geo) return null;
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2;
  geo.translate(-cx, -cy, -b.min.z);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  return geo;
}

function CreamWriting({ cfg }) {
  const geo = useMemo(() => {
    let g;
    if (cfg.style === 'piped') {
      const strokes = fitStrokes(strokesFromFont(cfg.font, cfg.text), cfg.fit);
      g = buildPipedFromStrokes(strokes, { thickness: cfg.thickness });
    } else {
      const font = OUTLINE_FONTS[cfg.font] ?? OUTLINE_FONTS.gentilis;
      g = buildRaised(font, cfg.text, { depth: cfg.depth, bevel: cfg.bevel, fitFrac: cfg.fit });
    }
    return centerOnSurface(g);
  }, [cfg.text, cfg.font, cfg.style, cfg.fit, cfg.thickness, cfg.depth, cfg.bevel]);

  if (!geo) return null;
  return (
    // outer: place + yaw on the top surface · inner: lay the XY text flat onto XZ
    <group position={[cfg.offsetX, TOP_Y + cfg.lift, cfg.offsetZ]} rotation={[0, cfg.yaw * DEG, 0]}>
      <group rotation={[-Math.PI / 2, 0, 0]}>
        <mesh geometry={geo} castShadow>
          <meshPhysicalMaterial {...creamMaterialProps(cfg.softness, cfg.color)} />
        </mesh>
      </group>
    </group>
  );
}

// ── UI bits ─────────────────────────────────────────────────────────────────────
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

// A piping bag that "fills" with the chosen colour — the visual for picking the cream.
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

const DEFAULT_CFG = {
  text:      'Happy Birthday',
  font:      'ems_allure',   // elegant single-line script for the piped rope look
  style:     'piped',        // 'piped' (tube bead) | 'raised' (extruded relief)
  color:     '#ffffff',
  softness:  PIPING_SOFTNESS_DEFAULT,
  fit:       0.8,            // fraction of the cake-top diameter the writing spans (auto-fit)
  thickness: 0.03,           // PIPED: bead radius (nozzle width)
  depth:     0.06,           // RAISED: extrude depth off the surface
  bevel:     0.015,          // RAISED: edge rounding
  lift:      0.02,           // sit slightly proud of the top so it never z-fights
  offsetX:   0,
  offsetZ:   0,
  yaw:       0,              // spin within the top plane (degrees)
};

export default function CreamPenStudio() {
  const [cfg, setCfg] = useState(DEFAULT_CFG);
  const [cakeColor, setCakeColor] = useState(STANDARD_CAKE_COLOR);
  const set = key => v => setCfg(p => ({ ...p, [key]: v }));

  // Each style needs a font of the matching type; switching style snaps the font to
  // the first compatible face so the picker and preview never disagree.
  const wantType = cfg.style === 'piped' ? 'stroke' : 'outline';
  const fontsForStyle = FONT_OPTIONS.filter(f => f.type === wantType);
  const pickStyle = style => setCfg(p => {
    const type = style === 'piped' ? 'stroke' : 'outline';
    const font = FONT_TYPE[p.font] === type ? p.font : FONT_OPTIONS.find(f => f.type === type).key;
    return { ...p, style, font };
  });

  const cfgJson = useMemo(() => JSON.stringify({
    cream_text:      cfg.text,
    cream_font:      cfg.font,
    cream_style:     cfg.style,
    cream_color:     cfg.color,
    cream_softness:  +cfg.softness.toFixed(2),
    cream_fit:       +cfg.fit.toFixed(2),
    ...(cfg.style === 'piped'
      ? { cream_thickness: +cfg.thickness.toFixed(3) }
      : { cream_depth: +cfg.depth.toFixed(3), cream_bevel: +cfg.bevel.toFixed(3) }),
    cream_lift:      +cfg.lift.toFixed(3),
    cream_offset:    [+cfg.offsetX.toFixed(3), +cfg.offsetZ.toFixed(3)],
    cream_yaw:       Math.round(cfg.yaw),
  }, null, 2), [cfg]);

  const panel = { background: '#fff', border: '1.5px solid #E8EFE9', borderRadius: 12, padding: 16, marginBottom: 14 };
  const heading = { fontSize: 11, fontWeight: 800, color: '#9B5F72', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 };

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', fontFamily: "'Quicksand', sans-serif", background: '#EDEAE2' }}>
      {/* Controls */}
      <div style={{ width: 360, overflowY: 'auto', padding: 18, borderRight: '1px solid #DCE5DD' }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, color: '#2C4433', margin: '0 0 4px' }}>Cream Pen</h2>
        <p style={{ fontSize: 11, color: '#9BB5A2', margin: '0 0 16px', lineHeight: 1.5 }}>
          Write a name on the cake top as piped cream. Prototype — once it reads right we port the
          renderer into <b>spattoo-core</b>.
        </p>

        <div style={panel}>
          <div style={heading}>Message</div>
          <input value={cfg.text} onChange={e => set('text')(e.target.value)} placeholder="e.g. Happy Birthday Mia"
            style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', fontSize: 14, fontWeight: 700, color: '#2C4433',
              border: '1.5px solid #C5D4C8', borderRadius: 8, fontFamily: "'Quicksand',sans-serif", outline: 'none' }} />
          <div style={{ marginTop: 10, ...heading, marginBottom: 6 }}>Font</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {fontsForStyle.map(f => (
              <button key={f.key} onClick={() => set('font')(f.key)}
                style={{ fontSize: 11, padding: '5px 10px', borderRadius: 6, cursor: 'pointer', fontWeight: 700,
                  border: `2px solid ${cfg.font === f.key ? '#3D5A44' : '#C5D4C8'}`,
                  background: cfg.font === f.key ? '#3D5A44' : '#fff', color: cfg.font === f.key ? '#fff' : '#6B8C74' }}>
                {f.label}
              </button>
            ))}
          </div>
          <p style={{ fontSize: 10, color: '#9BB5A2', margin: '8px 0 0', lineHeight: 1.5 }}>
            {cfg.style === 'piped'
              ? 'Single-stroke cursive faces — each letter is a centerline, so the piped rope is a true cream stroke.'
              : 'Outline faces extruded into raised relief letters.'}
          </p>
        </div>

        <div style={panel}>
          <div style={heading}>Style</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[{ k: 'piped', l: 'Piped bead' }, { k: 'raised', l: 'Raised relief' }].map(s => (
              <button key={s.k} onClick={() => pickStyle(s.k)}
                style={{ flex: 1, fontSize: 12, padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontWeight: 700,
                  border: `2px solid ${cfg.style === s.k ? '#3D5A44' : '#C5D4C8'}`,
                  background: cfg.style === s.k ? '#3D5A44' : '#fff', color: cfg.style === s.k ? '#fff' : '#6B8C74' }}>
                {s.l}
              </button>
            ))}
          </div>
          <p style={{ fontSize: 10, color: '#9BB5A2', margin: '8px 0 0', lineHeight: 1.5 }}>
            <b>Piped</b> sweeps a cream rope along each letter (true nozzle-width thickness).
            <b> Raised</b> extrudes filled letters with a soft bevel.
          </p>
        </div>

        <div style={panel}>
          <div style={heading}>Cream</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <PipingBag color={cfg.color} />
            <div style={{ flex: 1 }}>
              <HexColorPicker color={cfg.color} onChange={set('color')} style={{ width: '100%', height: 120 }} />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <Slider label="Softness" value={cfg.softness} min={0} max={1} step={0.05} resetTo={PIPING_SOFTNESS_DEFAULT} onChange={set('softness')} />
            <p style={{ fontSize: 10, color: '#9BB5A2', margin: '2px 0 0', lineHeight: 1.5 }}>0 = glossy gel · 0.7 = buttercream · 1 = matte.</p>
          </div>
        </div>

        <div style={panel}>
          <div style={heading}>Size &amp; thickness</div>
          <Slider label="Fit to top" value={cfg.fit} min={0.3} max={0.95} step={0.05} resetTo={0.8} onChange={set('fit')} color="#e0a052" />
          {cfg.style === 'piped'
            ? <Slider label="Thickness" value={cfg.thickness} min={0.008} max={0.07} step={0.002} resetTo={0.03} onChange={set('thickness')} color="#c47ad6" />
            : <>
                <Slider label="Height" value={cfg.depth} min={0.02} max={0.22} step={0.01} resetTo={0.06} onChange={set('depth')} color="#c47ad6" />
                <Slider label="Bevel" value={cfg.bevel} min={0} max={0.04} step={0.002} resetTo={0.015} onChange={set('bevel')} color="#7ab0d6" />
              </>}
        </div>

        <div style={panel}>
          <div style={heading}>Placement (top)</div>
          <Slider label="Move X" value={cfg.offsetX} min={-1} max={1} step={0.02} onChange={set('offsetX')} color="#e05252" />
          <Slider label="Move Z" value={cfg.offsetZ} min={-1} max={1} step={0.02} onChange={set('offsetZ')} color="#5252e0" />
          <Slider label="Rotate" value={cfg.yaw} min={-180} max={180} step={1} onChange={set('yaw')} color="#52c452" />
          <Slider label="Lift" value={cfg.lift} min={0} max={0.2} step={0.005} resetTo={0.02} onChange={set('lift')} />
        </div>

        <div style={panel}>
          <div style={heading}>placement_config</div>
          <pre style={{ fontSize: 11, color: '#2C4433', margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', lineHeight: 1.5 }}>{cfgJson}</pre>
        </div>
      </div>

      {/* Preview */}
      <div style={{ flex: 1, position: 'relative' }}>
        <Canvas shadows camera={{ position: [0, 4.6, 6.2], fov: 42 }}>
          <ambientLight intensity={0.7} />
          <directionalLight position={[5, 10, 5]} intensity={1.4} castShadow />
          <directionalLight position={[-3, 3, -3]} intensity={0.3} />
          <Environment preset="apartment" backgroundBlurriness={1} />
          <CakeScene cakeColor={cakeColor} />
          <CreamWriting cfg={cfg} />
          <OrbitControls makeDefault target={[0, 1.6, 0]} />
        </Canvas>
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
