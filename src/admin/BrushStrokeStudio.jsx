import React, { useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
// The SAME generator the designer would render, never a divergent copy — the rule ChocolateDripStudio
// states and every studio since repeats. SceneLights/SceneEnv are the designer's own rig for the
// same reason: relief judged under brighter lights is simply the wrong relief, and relief is the
// whole subject here.
import { buildBrushStrokeOnWall, BRUSH_ON_CAKE_DEFAULTS, SceneLights, SceneEnv,
         creamMaterialProps, grabOffset, dragStrokeTo, paintBrushColors,
         brushGesture, makeBrushBed, buildBrushBand, brushBandCount,
         BRUSH_BAND_DEFAULTS } from '@spattoo/designer';

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
const CAKE_COLOR = '#FBF8F3';   // what a thin stroke washes toward — the wall it is painted on

/* ⚠️ THE GESTURE COMES FROM CORE, not from a copy here. `brushGesture` knows what a hand does — it
   starts the pull at the BASE, where a knife lands and where strokes merge into one another, and
   runs each one out at its own height, because in a photograph of a real cake a short stubby stroke
   sits beside one reaching two thirds up the wall and that unevenness is most of what stops a row of
   them reading as a fence. Authored as a gesture rather than a point list so a stroke stays the same
   stroke on a bigger tier. */

/* ⚠️ EVERY HUE HAS A DEEP TONE, and until now none of them did. Seven pastels and one near-black,
   so the only way to get anything dark on a cake was to go achromatic — Sandeep, after the sheen bug
   was fixed and the render was still pale: *"you fixed the bug but still there is no dark version of
   any color."* Two different faults wearing the same symptom, and fixing the first one is what made
   the second one visible.
   Paired light/deep down the columns, so the row a swatch is in says which it is. A deep tone is NOT
   the pastel darkened — buttercream deepens by losing white rather than by losing light, so the
   bottom row is more saturated as well as darker, which is what the colour actually does in a bowl. */
const HUES = [
  ['#F6DCE2', '#B24A63'],   // blush   → deep rose
  ['#8EC5E8', '#2E5C8A'],   // sky     → navy
  ['#F4C542', '#A9741A'],   // gold    → amber
  ['#E8788F', '#8E2740'],   // rose    → crimson
  ['#B79CE0', '#53348F'],   // lilac   → violet
  ['#3FAE8E', '#1C5B49'],   // mint    → forest
  ['#FFFFFF', '#2C2C2C'],   // white   → charcoal
];
const SWATCHES = HUES.flat();
let nextId = 1;
const newStroke = (i) => ({
  id: nextId++,
  color: SWATCHES[i % SWATCHES.length],
  /* Close enough together that they OVERLAP — a baker does not leave a white gap between strokes,
     and the overlaps are most of what stops a row of them reading as stripes on wallpaper.
     ⚠️ AND IN FRONT OF THE CAMERA. `at` is TURNS round the tier, so 0.47 is very nearly half a
     turn: the three strokes were laid on the far side and this screen opened on a bare white
     cylinder. Everything worked — the chips, the swatches, the sliders — against geometry nobody
     could see, which is how it reached Sandeep as *"i cant change colors in brushstroke studio."*
     The camera sits on +Z and `place` puts turn 0 there, so the set is centred on 0. */
  at: -0.028 + i * 0.028, rise: 0.02, sweep: 0.015, climb: 0.52, bow: 0.012,
  width: BRUSH_ON_CAKE_DEFAULTS.width, weight: 0.7, seed: 1 + i * 7,
});

/* ⚠️ THE WALL IS THE DRAG SURFACE, not the stroke. A stroke dragged by raycasting ITSELF chases its
   own moving geometry and accelerates away from the pointer; the cake is what the hand is really
   moving against. The grab OFFSET is recorded at pointer-down and re-applied, so the point you took
   hold of stays under the pointer — handleAt and dragTo as exact inverses (INVARIANTS #10 law 5). */
function Cake({ onDragTo, onDragEnd }) {
  return (
    <group>
      <mesh position={[0, BOARD_H / 2, 0]} receiveShadow>
        <cylinderGeometry args={[BOARD_R, BOARD_R, BOARD_H, 64]} />
        <meshStandardMaterial color="#EDE7DA" roughness={0.85} />
      </mesh>
      <mesh position={[0, BOARD_H + TIER_H / 2, 0]} castShadow receiveShadow
        onPointerMove={e => onDragTo(e.point)}
        onPointerUp={onDragEnd}>
        <cylinderGeometry args={[R, R, TIER_H, 96]} />
        <meshStandardMaterial color="#FBF8F3" roughness={0.75} />
      </mesh>
    </group>
  );
}

/* The drag maths lives in core (`grabOffset` / `dragStrokeTo`) and is tested there, because a studio
   behind a login cannot be driven and the grab OFFSET is the half that can be wrong: without it the
   stroke jumps to the pointer by however far the grabbed point was from its origin. */
const WALL = { baseY: BOARD_H, wallH: TIER_H };

/* ⚠️ THE BED IS WHAT MAKES AN OVERLAP LOOK LAID RATHER THAN STACKED. Each stroke reads the cream
   already on the wall and rides on it exactly where that cream is, then stamps itself in for the
   next one — so a neighbour's ridge is covered rather than punched through, and a stroke with
   nothing under it still lies flat. Lifting a whole stroke by its place in the order did both
   wrongly at once, and Sandeep saw it: *"the part that coming out from the other strip is elevated
   high."* */
function Stroke({ s, bed, onGrab }) {
  const geo = useMemo(() => buildBrushStrokeOnWall({
    R, baseY: BOARD_H, wallH: TIER_H, bed,
    path: brushGesture({ at: s.at, rise: s.rise, climb: s.climb, sweep: s.sweep, bow: s.bow, seed: s.seed }),
    width: s.width, weight: s.weight, seed: s.seed,
  }), [s.at, s.rise, s.sweep, s.climb, s.bow, s.width, s.weight, s.seed, bed]);
  /* ⚠️ THIN CREAM LETS THE CAKE THROUGH, and that is most of what says buttercream rather than
     vinyl — it took a photograph of a real cake to see it. Saturated where the knife piled up,
     washing toward the wall's colour where it ran dry. */
  useMemo(() => geo && paintBrushColors(geo, s.color, CAKE_COLOR), [geo, s.color]);
  if (!geo) return null;
  return (
    <mesh geometry={geo} castShadow receiveShadow
      onPointerDown={e => { e.stopPropagation(); onGrab(s, e.point); }}>
      {/* ⚠️ THE CREAM MATERIAL, NOT A LOCAL OPINION ABOUT CREAM. `creamMaterialProps` is what every
          piped stroke on every cake already uses — the calibrated albedo, the roughness curve and
          the sheen. A brushstroke IS buttercream, and a studio that mixed its own would be judging
          a colour and a finish no customer will ever see (INVARIANTS #15). */}
      {/* DoubleSide because a painted layer's winding depends on which way the stroke happens to
          run — the call CreamPen already makes for cream. polygonOffset because the thinnest film
          sits almost on the wall and the depth buffer loses over a long grazing sweep, which is what
          "breaking at extreme sweep" was. */}
      <meshPhysicalMaterial side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-1}
        polygonOffsetUnits={-1} {...creamMaterialProps(0.7, s.color)} color="#ffffff" vertexColors />
    </mesh>
  );
}

/* ── The band ────────────────────────────────────────────────────────────────────────────────────
 *
 * The whole tier at once: a ring of pulls in a palette that repeats, which is what this technique
 * actually is on a cake — the loose strokes above are a way of judging ONE of them.
 *
 * ⚠️ ONE MESH, AND NOT AN InstancedMesh. See buildBrushBand: an instance draws one geometry many
 * times, and no two strokes here share a shape. A merge buys the same single draw call.
 *
 * ⚠️ AND THE COUNT IS NOT WHAT THE SLIDER SAYS. A band is a closed loop, so the strokes are snapped
 * to a whole number of colour repeats — otherwise two of the same colour meet at the seam, once, on
 * the far side of the cake. The readout shows what was actually laid, not what was asked for.
 */
function Band({ palette, count, shape }) {
  const parts = useMemo(() => buildBrushBand({
    R, baseY: BOARD_H, wallH: TIER_H, under: CAKE_COLOR,
    colors: palette, count, seed: shape.seed,
    weight: shape.weight, sweep: shape.sweep, climb: shape.climb, bow: shape.bow,
    overlap: shape.overlap,
  }), [palette.join(), count, shape.seed, shape.weight, shape.sweep, shape.climb, shape.bow, shape.overlap]);
  if (!parts.length) return null;
  /* ⚠️ ONE MATERIAL PER COLOUR, which is why the band comes back in parts rather than as one mesh.
     `creamMaterialProps` takes its SHEEN from the cream's own colour, because that is what cream
     does; one material for the lot puts a white sheen over a charcoal stroke and renders it the
     colour of wet concrete. `color="#ffffff"` because the albedo is already in the vertex colours —
     the per-vertex wash at a thin edge is something no material can say — but sheen and roughness
     come from the real colour. Two to six draw calls for a tier, not one; still nothing. */
  return parts.map(part => (
    <mesh key={part.color} geometry={part.geometry} castShadow receiveShadow>
      <meshPhysicalMaterial side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-1}
        polygonOffsetUnits={-1} {...creamMaterialProps(0.7, part.color)} color="#ffffff" vertexColors />
    </mesh>
  ));
}

/* The colours on offer, light over deep, shared by both modes — one component rather than the two
   copies this screen had, which is how one of them ended up with a different set from the other. */
function Swatches({ value, onPick }) {
  return (
    <div style={s.swGrid}>
      {HUES.map(([light, deep]) => (
        <div key={light} style={s.swCol}>
          {[light, deep].map(c => (
            <button key={c} onClick={() => onPick(c)} title={c}
              style={{ ...s.sw, background: c,
                       outline: value === c ? '2.5px solid #3D5A44' : '1px solid #ccc' }} />
          ))}
        </div>
      ))}
    </div>
  );
}

const BAND_FIELDS = [
  ['count',   'Strokes',   6,    40,   1],
  ['overlap', 'Overlap',   0,    0.8,  0.05],
  ['weight',  'Thickness', 0,    1,    0.02],
  ['sweep',   'Sweep',     0.00, 0.3,  0.005],
  ['climb',   'Length',    0.15, 0.9,  0.01],
  ['bow',     'Bow',      -0.2,  0.2,  0.01],
];

/* ⚠️ "THICKNESS", NOT "WEIGHT". It is the same number — how much cream the knife left — and Sandeep
   has called it thickness every time: *"if its a thick stroke edges have elevation"*, then
   *"thinkness need to be a controlling nob"*. A baker reaching for this is thinking about how thick
   the cream is, not about how loaded the knife was. The geometry keeps `weight` as its parameter
   name because that is what it does to the relief profile; the LABEL is the baker's word. */
/* ⚠️ ROUND AND HEIGHT ARE NOT SLIDERS ANY MORE. Sandeep: *"round and height need to be done with
   dragging."* Where a stroke SITS is a thing you point at — two sliders for one position is the
   control-and-effect split INVARIANTS #11 is about, and you cannot aim with them. Everything left
   here changes the stroke's SHAPE, which a slider is right for. */
const FIELDS = [
  ['width',  'Width',     0.08, 0.6,  0.01],
  ['weight', 'Thickness', 0,    1,    0.02],
  ['sweep',  'Sweep',     0.00, 0.3,  0.005],
  ['climb',  'Length',    0.15, 0.9,  0.01],
  ['bow',    'Bow',      -0.2,  0.2,  0.01],
];

export default function BrushStrokeStudio() {
  /* Two things to look at, not two studios: one stroke on its own is how you judge a stroke, and a
     band is the thing that goes on a cake. Same generator under both. */
  const [mode, setMode] = useState('band');
  const [palette, setPalette] = useState(BRUSH_BAND_DEFAULTS.colors);
  const [slot, setSlot] = useState(0);        // which colour of the repeat is being changed
  const [band, setBand] = useState({
    count: BRUSH_BAND_DEFAULTS.count, overlap: BRUSH_BAND_DEFAULTS.overlap,
    weight: 0.75, sweep: BRUSH_BAND_DEFAULTS.sweep, climb: BRUSH_BAND_DEFAULTS.climb,
    bow: BRUSH_BAND_DEFAULTS.bow, seed: BRUSH_BAND_DEFAULTS.seed,
  });
  const laid = brushBandCount({ count: band.count, colors: palette });
  const [strokes, setStrokes] = useState(() => [0, 1, 2].map(newStroke));
  const [sel, setSel] = useState(0);
  const cur = strokes[Math.min(sel, strokes.length - 1)];
  const patch = p => setStrokes(list => list.map((s, i) => (i === sel ? { ...s, ...p } : s)));

  /* ⚠️ REBUILT WHENEVER ANYTHING MOVES, because the bed is an ACCUMULATION: drag a stroke and the
     cream it had laid would still be recorded where it used to be. Cheap — it is one typed array,
     and the strokes fill it in render order, each one reading what the ones before it laid down. */
  const bed = useMemo(() => makeBrushBed({ R, wallH: TIER_H }), [JSON.stringify(strokes)]);

  /* The grab: which stroke, and how far its origin was from the point taken hold of. A ref rather
     than state — it is read inside a pointermove that was captured when the drag began. */
  const grab = useRef(null);
  const onGrab = (st, point) => {
    setSel(strokes.findIndex(x => x.id === st.id));
    grab.current = { id: st.id, ...grabOffset(st, point, WALL) };
  };
  const onDragTo = (point) => {
    const g = grab.current;
    if (!g) return;
    const next = dragStrokeTo(g, point, WALL);
    setStrokes(list => list.map(st => (st.id === g.id ? { ...st, ...next } : st)));
  };
  const onDragEnd = () => { grab.current = null; };

  return (
    <div style={s.wrap}>
      <div style={s.stage}>
        <Canvas shadows camera={{ position: [0, 1.5, 4.2], fov: 38 }} gl={{ antialias: true }}
          onPointerMissed={onDragEnd} onPointerUp={onDragEnd}>
          <color attach="background" args={['#eceaf3']} />
          {/* ⚠️ `shadows`, BECAUSE A STUDIO IS LIT LIKE THE CAKE IT AUTHORS FOR (INVARIANTS #17).
              SceneLights defaults it off; the live designer mounts it on. A studio whose whole
              subject is how proud the cream stands cannot be the one place the height cue is
              missing. */}
          <SceneLights shadows />
          <SceneEnv />
          <Cake onDragTo={onDragTo} onDragEnd={onDragEnd} />
          {mode === 'band'
            ? <Band palette={palette} count={band.count} shape={band} />
            : strokes.map(st => <Stroke key={st.id} s={st} bed={bed} onGrab={onGrab} />)}
          {/* Orbit stands down while a stroke is in hand, or the cake spins out from under it. */}
          <OrbitControls makeDefault enabled={!grab.current} target={[0, BOARD_H + TIER_H * 0.5, 0]} enablePan={false} />
        </Canvas>
      </div>

      <div style={s.panel}>
        <h2 style={s.h2}>Brushstroke studio</h2>

        <div style={s.modes}>
          {[['band', 'Band round the cake'], ['one', 'Single strokes']].map(([k, label]) => (
            <button key={k} onClick={() => setMode(k)}
              style={{ ...s.mode, ...(mode === k ? s.modeOn : null) }}>{label}</button>
          ))}
        </div>

        {mode === 'band' ? (
          <>
            <p style={s.note}>
              The whole tier at once. Pick the colours and they <b>repeat</b> round the cake — two
              colours alternate, three cycle, and so on. Each stroke runs out at its own height and
              tears at its own width, so no two are the same; <b>Shuffle</b> rolls the lot.
              <br />One mesh, one draw call — <b>{laid}</b> strokes.
            </p>

            {/* ⚠️ THE READOUT IS THE SNAPPED COUNT, NOT THE SLIDER. A band is a closed loop, so the
                strokes are rounded to a whole number of colour repeats — otherwise two of the same
                colour sit together at the seam, exactly once, on the side of the cake nobody is
                looking at while they set it. A slider that said 19 and laid 18 with no sign of it
                would be the control lying about its own effect. */}
            {/* ⚠️ A CHIP IS PICKED, THEN COLOURED — the same two-step the single-stroke mode above
                already uses, and the reason is rule 1 rather than consistency for its own sake: a
                native <select> styled as a circle renders its VALUE inside itself, so every chip
                carried "#F6DCE2" in black text across the colour it was showing. */}
            <div style={s.rowWrap}>
              {palette.map((c, i) => (
                <button key={i} onClick={() => setSlot(i)} title={`Colour ${i + 1}`}
                  style={{ ...s.chip, background: c,
                           outline: i === slot ? '2.5px solid #3D5A44' : '1.5px solid #C5D4C8' }} />
              ))}
              {palette.length < 6 && (
                <button style={s.add} title="Add a colour"
                  onClick={() => { setPalette(p => [...p, SWATCHES[p.length % SWATCHES.length]]); setSlot(palette.length); }}>+</button>
              )}
              {palette.length > 1 && (
                <button style={s.del} title="Drop this colour"
                  onClick={() => { setPalette(p => p.filter((_, j) => j !== slot)); setSlot(0); }}>Remove</button>
              )}
            </div>

            <Swatches value={palette[slot]}
              onPick={c => setPalette(p => p.map((x, j) => (j === slot ? c : x)))} />

            {BAND_FIELDS.map(([k, label, min, max, step]) => (
              <label key={k} style={s.field}>
                <span style={s.lab}>{label}<b style={s.val}>
                  {k === 'count' ? laid : (band[k] ?? 0).toFixed(2)}</b></span>
                <input type="range" min={min} max={max} step={step} value={band[k]}
                  onChange={e => setBand(b => ({ ...b, [k]: +e.target.value }))} style={s.range} />
              </label>
            ))}

            <button style={s.shuffle}
              onClick={() => setBand(b => ({ ...b, seed: 1 + Math.floor(Math.random() * 9999) }))}>
              Shuffle the band
            </button>
          </>
        ) : (
        <>
        <p style={s.note}>
          Broad buttercream strokes painted on the wall. <b>Thickness</b> is the one to judge: at the
          top of its range the edges stand proud and cast a shadow, at the bottom the stroke should
          merge into the cake with no relief at all — and still be there. Every stroke tears and
          releases at its own width; <b>Shuffle</b> rolls another.
          <br /><b>Drag a stroke on the cake</b> to place it; the sliders only change its shape.
          Strokes are meant to <b>overlap</b> — each new one lays over the ones before it.
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

        <Swatches value={cur.color} onPick={c => patch({ color: c })} />

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
        </>
        )}
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
  swGrid: { display: 'flex', gap: 6, marginBottom: 12 },
  swCol:  { display: 'flex', flexDirection: 'column', gap: 5 },
  sw:     { width: 22, height: 22, borderRadius: '50%', border: 'none', cursor: 'pointer' },
  field:  { display: 'block', marginBottom: 8 },
  lab:    { display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 700, marginBottom: 2 },
  val:    { color: '#6B8C74' },
  range:  { width: '100%' },
  modes:  { display: 'flex', gap: 6, marginBottom: 10 },
  mode:   { flex: 1, fontSize: 11, fontWeight: 700, padding: '6px 4px', borderRadius: 8,
            border: '1.5px solid #C5D4C8', background: '#fff', color: '#6B8C74', cursor: 'pointer' },
  modeOn: { background: '#3D5A44', borderColor: '#3D5A44', color: '#fff' },
  shuffle:{ width: '100%', marginTop: 8, padding: '8px 0', borderRadius: 8, border: '1.5px solid #C5D4C8', background: '#fff', color: '#3D5A44', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
};
