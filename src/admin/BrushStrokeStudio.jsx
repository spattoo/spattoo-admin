import React, { useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
// The SAME generator the designer would render, never a divergent copy — the rule ChocolateDripStudio
// states and every studio since repeats. SceneLights/SceneEnv are the designer's own rig for the
// same reason: relief judged under brighter lights is simply the wrong relief, and relief is the
// whole subject here.
import { buildBrushStrokeOnWall, BRUSH_ON_CAKE_DEFAULTS, SceneLights, SceneEnv,
         creamMaterialProps } from '@spattoo/designer';

// ── Brushstroke studio (POC) ─────────────────────────────────────────────────────────────────────
//
// Broad buttercream strokes swept across the side of a cake, each its own colour — the reference
// cakes Sandeep sent. Four things to judge, in his words and in the order most likely to be wrong:
//
//   1. SIZE. Does `Width` read as a bigger knife rather than a zoomed-in picture of a small one?
//   2. THE TEAR. "randomness in the edge spikes where we leave the stroke" — the lift-off should
//      finish in fingers of different lengths, never on a ruled line. Shuffle re-rolls it.
//   3. WEIGHT. "if its a thick stroke edges have elevation, if its a lighter stroke, it just merges
//      with the cake surface without elevation." One slider between the two, and at 0 the stroke
//      must still be THERE — coloured, flat, catching no light.
//   4. COLOUR PER STROKE. Not a finish: five strokes, five colours, on one cake.
//
// ⚠️ THIS IS NOT THE PALETTE-KNIFE STUDIO AND IT IS NOT A SECOND COPY OF IT. That one paints strokes
// into a seamless TILE and wraps the whole wall in it — the right answer for an all-over impasto and
// the wrong one here, because a tile cannot give one stroke its own colour or its own weight. Nor is
// it the chocolate brushstroke, which is the same gesture set on acetate, peeled off and STOOD on
// the cake. The gesture generator is shared with that one (`brushStroke.js`); what is new is seating
// it on the wall and giving it relief.
//
// Geometry lives in core (`geometry/brushStrokeOnCake.js`) and is imported, never ported — the rule
// root CLAUDE.md states for every studio: a studio that carries its own copy tunes a renderer no
// customer ever sees.

const R = 1, TIER_H = 1.25, BOARD_R = 1.5, BOARD_H = 0.07;

/* A stroke is authored as a GESTURE, not as a list of points: where it starts round the cake, how
   far it sweeps, how much it climbs, and how much it bows. That is what a hand does — and it means a
   stroke stays the same stroke on a bigger tier, which a point list never would. */
function gesturePath({ at, rise, sweep, climb, bow }) {
  const n = 14, out = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const arc = Math.sin(Math.PI * t) * bow;          // the bow pushes the middle up
    out.push([at + sweep * t, Math.min(0.98, Math.max(0.02, rise + climb * t + arc))]);
  }
  return out;
}

const SWATCHES = ['#F6DCE2', '#8EC5E8', '#F4C542', '#E8788F', '#B79CE0', '#FFFFFF', '#3FAE8E', '#2C2C2C'];
let nextId = 1;
const newStroke = (i) => ({
  id: nextId++,
  color: SWATCHES[i % SWATCHES.length],
  at: (i * 0.17) % 1, rise: 0.22 + (i % 3) * 0.16, sweep: 0.13, climb: 0.1, bow: 0.04,
  width: BRUSH_ON_CAKE_DEFAULTS.width, weight: 0.7, seed: 1 + i * 7,
});

function Cake() {
  return (
    <group>
      <mesh position={[0, BOARD_H / 2, 0]} receiveShadow>
        <cylinderGeometry args={[BOARD_R, BOARD_R, BOARD_H, 64]} />
        <meshStandardMaterial color="#EDE7DA" roughness={0.85} />
      </mesh>
      <mesh position={[0, BOARD_H + TIER_H / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[R, R, TIER_H, 96]} />
        <meshStandardMaterial color="#FBF8F3" roughness={0.75} />
      </mesh>
    </group>
  );
}

function Stroke({ s }) {
  const geo = useMemo(() => buildBrushStrokeOnWall({
    R, baseY: BOARD_H, wallH: TIER_H,
    path: gesturePath(s), width: s.width, weight: s.weight, seed: s.seed,
  }), [s.at, s.rise, s.sweep, s.climb, s.bow, s.width, s.weight, s.seed]);
  if (!geo) return null;
  return (
    <mesh geometry={geo} castShadow receiveShadow>
      {/* ⚠️ THE CREAM MATERIAL, NOT A LOCAL OPINION ABOUT CREAM. `creamMaterialProps` is what every
          piped stroke on every cake already uses — the calibrated albedo, the roughness curve and
          the sheen. A brushstroke IS buttercream, and a studio that mixed its own would be judging
          a colour and a finish no customer will ever see (INVARIANTS #15). */}
      <meshPhysicalMaterial {...creamMaterialProps(0.7, s.color)} />
    </mesh>
  );
}

/* ⚠️ "THICKNESS", NOT "WEIGHT". It is the same number — how much cream the knife left — and Sandeep
   has called it thickness every time: *"if its a thick stroke edges have elevation"*, then
   *"thinkness need to be a controlling nob"*. A baker reaching for this is thinking about how thick
   the cream is, not about how loaded the knife was. The geometry keeps `weight` as its parameter
   name because that is what it does to the relief profile; the LABEL is the baker's word. */
const FIELDS = [
  ['width',  'Width',     0.08, 0.6,  0.01],
  ['weight', 'Thickness', 0,    1,    0.02],
  ['sweep',  'Sweep',     0.03, 0.4,  0.01],
  ['climb',  'Climb',    -0.4,  0.4,  0.01],
  ['bow',    'Bow',      -0.2,  0.2,  0.01],
  ['at',     'Round',     0,    1,    0.01],
  ['rise',   'Height',    0.05, 0.9,  0.01],
];

export default function BrushStrokeStudio() {
  const [strokes, setStrokes] = useState(() => [0, 1, 2].map(newStroke));
  const [sel, setSel] = useState(0);
  const cur = strokes[Math.min(sel, strokes.length - 1)];
  const patch = p => setStrokes(list => list.map((s, i) => (i === sel ? { ...s, ...p } : s)));

  return (
    <div style={s.wrap}>
      <div style={s.stage}>
        <Canvas shadows camera={{ position: [0, 1.5, 4.2], fov: 38 }} gl={{ antialias: true }}>
          <color attach="background" args={['#eceaf3']} />
          <SceneLights />
          <SceneEnv />
          <Cake />
          {strokes.map(st => <Stroke key={st.id} s={st} />)}
          <OrbitControls target={[0, BOARD_H + TIER_H * 0.5, 0]} enablePan={false} />
        </Canvas>
      </div>

      <div style={s.panel}>
        <h2 style={s.h2}>Brushstroke studio</h2>
        <p style={s.note}>
          Broad buttercream strokes painted on the wall. <b>Thickness</b> is the one to judge: at the
          top of its range the edges stand proud and cast a shadow, at the bottom the stroke should
          merge into the cake with no relief at all — and still be there. Every stroke tears and
          releases at its own width; <b>Shuffle</b> rolls another.
        </p>

        <div style={s.rowWrap}>
          {strokes.map((st, i) => (
            <button key={st.id} onClick={() => setSel(i)} title={`Stroke ${i + 1}`}
              style={{ ...s.chip, background: st.color,
                       outline: i === sel ? '2.5px solid #3D5A44' : '1.5px solid #C5D4C8' }} />
          ))}
          <button style={s.add} title="Add a stroke"
            onClick={() => { setStrokes(l => [...l, newStroke(l.length)]); setSel(strokes.length); }}>+</button>
          {strokes.length > 1 && (
            <button style={s.del} title="Remove this stroke"
              onClick={() => { setStrokes(l => l.filter((_, i) => i !== sel)); setSel(0); }}>Remove</button>
          )}
        </div>

        <div style={s.swatches}>
          {SWATCHES.map(c => (
            <button key={c} onClick={() => patch({ color: c })} title={c}
              style={{ ...s.sw, background: c, outline: cur.color === c ? '2.5px solid #3D5A44' : '1px solid #ccc' }} />
          ))}
        </div>

        {FIELDS.map(([k, label, min, max, step]) => (
          <label key={k} style={s.field}>
            <span style={s.lab}>{label}<b style={s.val}>{(cur[k] ?? 0).toFixed(2)}</b></span>
            <input type="range" min={min} max={max} step={step} value={cur[k]}
              onChange={e => patch({ [k]: +e.target.value })} style={s.range} />
          </label>
        ))}

        {/* The tear is random by seed, which is the only honest way to offer "another one": it must
            come back identical after a reload, so there is a number behind it rather than a dice. */}
        <button style={s.shuffle} onClick={() => patch({ seed: 1 + Math.floor(Math.random() * 9999) })}>
          Shuffle the tear
        </button>
      </div>
    </div>
  );
}

const s = {
  wrap:   { display: 'flex', gap: 16, padding: 16, height: 'calc(100vh - 80px)', boxSizing: 'border-box' },
  stage:  { flex: 1, minWidth: 0, borderRadius: 14, overflow: 'hidden', background: '#eceaf3' },
  panel:  { width: 300, overflowY: 'auto', fontFamily: "'Quicksand',sans-serif", color: '#3D5A44' },
  h2:     { fontSize: 16, margin: '0 0 6px' },
  note:   { fontSize: 11.5, lineHeight: 1.5, color: '#6B8C74', margin: '0 0 12px' },
  rowWrap:{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10 },
  chip:   { width: 26, height: 26, borderRadius: '50%', border: 'none', cursor: 'pointer' },
  add:    { width: 26, height: 26, borderRadius: '50%', border: '1.5px dashed #C5D4C8', background: '#fff', cursor: 'pointer', fontWeight: 700 },
  del:    { marginLeft: 'auto', fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1.5px solid #e4b7bf', background: '#fff6f7', color: '#b4545f', cursor: 'pointer', fontWeight: 700 },
  swatches:{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 },
  sw:     { width: 22, height: 22, borderRadius: '50%', border: 'none', cursor: 'pointer' },
  field:  { display: 'block', marginBottom: 8 },
  lab:    { display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 700, marginBottom: 2 },
  val:    { color: '#6B8C74' },
  range:  { width: '100%' },
  shuffle:{ width: '100%', marginTop: 8, padding: '8px 0', borderRadius: 8, border: '1.5px solid #C5D4C8', background: '#fff', color: '#3D5A44', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
};
