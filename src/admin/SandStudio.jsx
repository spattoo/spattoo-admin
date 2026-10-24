import React, { useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
// Tune the SAME generator the designer renders from — never a divergent copy. SandBed is the
// instanced renderer; buildSandGrain / thinOutward / varyGrainSize are its parts, and SAND_DEFAULTS
// is where the sliders start. SceneLights/SceneEnv are the designer's OWN rig, imported rather than
// approximated: sand is judged almost entirely on how its facets catch the key light, so a studio
// that lit itself would be tuning a colour nobody will ever see.
import { SandBed, sandTriangleCount, SAND_DEFAULTS, ZONES_TOP, ZONES_BOARD,
         REGION_KINDS, REGION_DEFAULTS, SceneLights, SceneEnv } from '@spattoo/designer';

// ── Sand studio ───────────────────────────────────────────────────────────────────────────────
// Crushed-biscuit sand banked round the foot of a cake, with shells and pebbles sitting in it —
// the beach look. Sandeep, with a reference photo: "can we create sand like this? i dont think its
// possible with glb. we need to go procedurally only."
//
// ── THIS SCREEN EXISTS TO ANSWER ONE QUESTION ─────────────────────────────────────────────────
// Does it READ as sand, or as gravel? Two procedural studios (isomalt, palette knife) reached a
// working studio and never shipped, both because the subject has a precise familiar signature the
// eye checks against. Sand should be the opposite — no canonical grain, sold on mass and on how
// irregularly it thins — but that is a prediction, and this is where it gets tested.
//
// WHAT TO JUDGE, in the order most likely to be wrong:
//   1. Does the drift THIN convincingly, or stop at a visible boundary? The outer crumbs are what
//      make it sand rather than a doormat. Orbit low and look along the board.
//   2. Grain SIZE against the cake. Too large and it is gravel; too small and it is a flat stain
//      with no grain at all.
//   3. Does it read as one colour? A packed field goes flat without per-grain shade variation —
//      turn Shade to 0 and back to see what it is doing.
//   4. The join at the wall. Sand banked against a cake should look piled, not sprinkled up to a line.
//
// Nothing here saves to the catalogue yet. Deliberate: the look is judged before an element type,
// an admin form and a designer control get built around it.

// Mirrors the designer's bottom tier, so grain size is judged against the real thing — a slider
// tuned at the wrong scale is worse than no slider.
const R = 1.2, BOTTOM_H = 1.45, BOARD_H = 0.1, BOARD_R = 1.95;
const BOARD_TOP = BOARD_H;

const SHAPES = {
  round: { kind: 'round', radius: R },
  sheet: { kind: 'rect', halfW: 1.35, halfD: 0.95, cornerR: 0.18 },
};

// Reference looks, so the sliders start somewhere real rather than in the middle of their range.
const PRESETS = {
  'Beach drift':  { ...SAND_DEFAULTS },
  'Fine sand':    { ...SAND_DEFAULTS, spacing: 0.026, grainSize: 0.018, sizeVary: 0.6, falloff: 0.45, colour: '#e0c39a' },
  'Crushed biscuit': { ...SAND_DEFAULTS, spacing: 0.044, grainSize: 0.036, sizeVary: 1.0, falloff: 0.6, colour: '#c89a63' },
  'Wet sand':     { ...SAND_DEFAULTS, colour: '#a8814f', roughness: 0.7, shadeVary: 0.32 },
};

function CakeMesh({ shapeKey, cakeColor }) {
  const s = SHAPES.sheet;
  return (
    <group>
      {/* A white plate, as in the reference — sand on a gold drum hides exactly the thinning this
          screen exists to judge. */}
      <mesh position={[0, BOARD_H / 2, 0]} receiveShadow>
        <cylinderGeometry args={[BOARD_R, BOARD_R, BOARD_H, 96]} />
        <meshStandardMaterial color="#f4f1ea" metalness={0} roughness={0.75} />
      </mesh>
      <mesh position={[0, BOARD_H + BOTTOM_H / 2, 0]} castShadow receiveShadow>
        {shapeKey === 'round'
          ? <cylinderGeometry args={[R, R, BOTTOM_H, 96, 1]} />
          : <boxGeometry args={[s.halfW * 2, BOTTOM_H, s.halfD * 2]} />}
        <meshStandardMaterial color={cakeColor} roughness={0.9} metalness={0} />
      </mesh>
    </group>
  );
}

export default function SandStudio() {
  const [p, setP] = useState({ ...SAND_DEFAULTS, board: true, top: true });
  /* Which preset is showing, so the row reads as a choice rather than four identical buttons.
     Any slider move clears it — what is on screen is no longer that preset. */
  const [preset, setPreset] = useState('Beach drift');
  const [shapeKey, setShapeKey] = useState('round');
  const [cakeColor, setCakeColor] = useState('#8fd3e8');
  const [bg, setBg] = useState('#efeae2');
  /* ⚠️ THE AREA IS ITS OWN STATE, NOT PART OF `p`. A preset says what the sand LOOKS like — grain,
     colour, how it banks — and has no business moving a patch somebody placed. Keeping them apart
     is also what stops the preset bug from coming back by another door. */
  const [area, setArea] = useState({ on: false, ...REGION_DEFAULTS });
  const setA = (k) => (v) => setArea(q => ({ ...q, [k]: v }));
  /* ⚠️ MEMOISED, OR THE WHOLE DRIFT IS REBUILT EVERY RENDER. SandBed keys its `useMemo` on the
     region's identity, so a fresh object literal each render means `buildSandMound` — a 40,000-cell
     lattice — runs on every mouse move. */
  const region = useMemo(
    () => (area.on ? { kind: area.kind, size: area.size, aspect: area.aspect,
                       rotation: area.rotation, x: area.x, z: area.z } : null),
    [area]);
  /* Looking down is the only way to judge a drawn area; looking along the board is the only way to
     judge how the sand banks. One screen cannot do both from one angle, so it offers both. */
  const [view, setView] = useState('side');
  const set = (k) => (v) => { setPreset(null); setP(q => ({ ...q, [k]: v })); };

  const shape = SHAPES[shapeKey] ?? SHAPES.round;
  // What the drift costs if anybody merged it — as an InstancedMesh it is one draw call whatever
  // this says, but it is the number worth watching while dragging Density.
  const estimate = useMemo(() => {
    const ext = shape.radius ?? Math.max(shape.halfW, shape.halfD);
    const area = Math.PI * ((ext * (1 + p.width)) ** 2 - ext ** 2);
    const seats = area / (p.spacing * p.spacing * 0.866);
    return sandTriangleCount(Math.round(seats * (1 - p.falloff / 3)));
  }, [shape, p.width, p.spacing, p.falloff]);

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: "'Quicksand',sans-serif" }}>
      <div style={{ width: 290, padding: '18px 16px', overflowY: 'auto', borderRight: '1px solid #eee' }}>
        <h2 style={{ margin: '0 0 2px', fontSize: 17 }}>Sand</h2>
        <p style={{ margin: '0 0 14px', fontSize: 11.5, color: '#888', lineHeight: 1.45 }}>
          A drift banked round the foot of the cake. Does it read as sand, or as gravel?
        </p>

        <Row label="Area — top surface only">
          <Btn on={!area.on} onClick={() => setArea(q => ({ ...q, on: false }))}>Whole top</Btn>
          {Object.keys(REGION_KINDS).map(k => (
            <Btn key={k} on={area.on && area.kind === k}
              onClick={() => setArea(q => ({ ...q, on: true, kind: k }))}>
              {k === 'rect' ? 'Rectangle' : 'Triangle'}
            </Btn>
          ))}
        </Row>
        {area.on && (
          <>
            <Sl label="Size"    v={area.size}     min={0.1} max={1.3} step={0.01} on={setA('size')} />
            <Sl label="Stretch" v={area.aspect}   min={0.25} max={4}  step={0.05} on={setA('aspect')} />
            <Sl label="Turn"    v={area.rotation} min={0} max={Math.PI * 2} step={0.02} on={setA('rotation')} />
            <Sl label="Across"  v={area.x}        min={-1} max={1} step={0.02} on={setA('x')} />
            <Sl label="Up the cake" v={area.z}    min={-1} max={1} step={0.02} on={setA('z')} />
            <p style={{ fontSize: 10.5, color: '#999', lineHeight: 1.5, margin: '0 0 11px' }}>
              Size and position are fractions of the cake, so the same area fits any tier. Sand is
              clipped to the cake&rsquo;s own edge, and <em>Edge break</em> at 0 keeps the shape crisp.
            </p>
          </>
        )}

        <Row label="View">
          <Btn on={view === 'side'} onClick={() => setView('side')}>Along the board</Btn>
          <Btn on={view === 'top'} onClick={() => setView('top')}>From above</Btn>
        </Row>

        <Row label="Preset">
          {Object.keys(PRESETS).map(k => (
            /* ⚠️ MERGED ONTO THE CURRENT STATE, NEVER SUBSTITUTED FOR IT. A preset is built from
               SAND_DEFAULTS, which knows nothing about `board` and `top` — those are this screen's
               own. Replacing the object dropped both flags to undefined, so every preset click
               emptied the scene: Sandeep, *"when i click on any preset, sand disappears."* A preset
               says what the sand LOOKS like, not which placements are on show. */
            <Btn key={k} on={preset === k}
              onClick={() => { setPreset(k); setP(q => ({ ...q, ...PRESETS[k] })); }}>{k}</Btn>
          ))}
        </Row>

        <Row label="Colour">
          {['#d9b584', '#e0c39a', '#c89a63', '#a8814f', '#efe0c6'].map(c => (
            <Sw key={c} c={c} on={p.colour === c} onClick={() => set('colour')(c)} />
          ))}
        </Row>

        {/* Sand goes on the board, on the top, or both — the first reference does both at once. */}
        <Row label="Where">
          <Btn on={p.board} onClick={() => set('board')(!p.board)}>Board</Btn>
          <Btn on={p.top} onClick={() => set('top')(!p.top)}>Top</Btn>
        </Row>
        <Sl label="Reach past the cake" v={p.width} min={0.08} max={0.9} step={0.01} on={set('width')} />
        <Sl label="How much of the top" v={p.topSize} min={0.15} max={1} step={0.01} on={set('topSize')} />
        {/* Spacing is the underlying number; density is what a person is adjusting, so the track is
            flipped — dragging right means more sand. The same papercut GrassStudio fixed. */}
        <Sl label="Density" v={p.spacing} min={0.018} max={0.08} step={0.001} on={set('spacing')} inv />
        <Sl label="Grain size" v={p.grainSize} min={0.008} max={0.055} step={0.001} on={set('grainSize')} />
        <Sl label="Size variety" v={p.sizeVary} min={0} max={1.2} step={0.01} on={set('sizeVary')} />
        <Sl label="Thins outward" v={p.falloff} min={0} max={1} step={0.01} on={set('falloff')} />
        <Sl label="Shade variety" v={p.shadeVary} min={0} max={0.6} step={0.01} on={set('shadeVary')} />
        <Sl label="Bank height" v={p.rise} min={0} max={0.14} step={0.002} on={set('rise')} />
        <Sl label="Surface grain" v={p.moundGrain} min={0} max={1.5} step={0.01} on={set('moundGrain')} />
        <Sl label="Edge wander" v={p.edgeBreak} min={0} max={1} step={0.01} on={set('edgeBreak')} />
        <Sl label="Roughness" v={p.roughness} min={0.3} max={1} step={0.01} on={set('roughness')} />
        <Sl label="Seed" v={p.seed} min={1} max={99} step={1} on={set('seed')} int />

        <Row label="Cake">
          <Btn on={shapeKey === 'round'} onClick={() => setShapeKey('round')}>Round</Btn>
          <Btn on={shapeKey === 'sheet'} onClick={() => setShapeKey('sheet')}>Sheet</Btn>
        </Row>
        <Row label="Cake colour">
          {['#8fd3e8', '#f6d6e0', '#ffffff', '#cfe8c9'].map(c => (
            <Sw key={c} c={c} on={cakeColor === c} onClick={() => setCakeColor(c)} />
          ))}
        </Row>
        <Row label="Background">
          {['#efeae2', '#ffffff', '#2b2b2b'].map(c => (
            <Sw key={c} c={c} on={bg === c} onClick={() => setBg(c)} />
          ))}
        </Row>

        <div style={{ marginTop: 14, fontSize: 11, color: '#999', lineHeight: 1.5 }}>
          ≈{estimate.toLocaleString()} triangles for the BOARD RING if merged — one draw call as
          drawn. An area on the top is a different count; this number does not cover it.
          <br />Sand is a SEAT problem: the ring, the hole for the cake and the instancing are
          grass's, reused. Only the grain and the thinning are new.
        </div>
      </div>

      <div style={{ flex: 1, position: 'relative' }}>
        {/* preserveDrawingBuffer, or a saved thumbnail is a blank png — WebGL clears the drawing
            buffer after compositing and toBlob() reads an empty one. */}
        {/* ⚠️ `key` REMOUNTS THE CANVAS when the view changes — r3f reads `camera` once, at mount,
            so setting a new position prop on a live canvas moves nothing. */}
        <Canvas key={view} gl={{ preserveDrawingBuffer: true }} shadows
                camera={{ position: view === 'top' ? [0, 3.5, 3.0] : [0, 1.9, 4.4], fov: 42 }}
                style={{ position: 'absolute', inset: 0 }}>
          <color attach="background" args={[bg]} />
          <SceneLights shadows />
          <SceneEnv />
          <CakeMesh shapeKey={shapeKey} cakeColor={cakeColor} />
          {p.board && <SandBed {...p} shape={shape} topY={BOARD_TOP} zone={ZONES_BOARD} size={p.width} />}
          {p.top && <SandBed {...p} shape={shape} topY={BOARD_H + BOTTOM_H} zone={ZONES_TOP}
                             size={p.topSize} region={region} />}
          <OrbitControls target={[0, view === 'top' ? BOARD_H + BOTTOM_H * 0.8 : BOARD_TOP + 0.3, 0]} />
        </Canvas>
      </div>
    </div>
  );
}

const Row = ({ label, children }) => (
  <div style={{ marginBottom: 11 }}>
    <div style={{ fontSize: 10.5, color: '#a98', marginBottom: 4, letterSpacing: 0.3 }}>{label.toUpperCase()}</div>
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>{children}</div>
  </div>
);
const Btn = ({ on, onClick, children }) => (
  <button onClick={onClick} style={{
    padding: '4px 10px', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
    border: '1.5px solid #1a1a1a', background: on ? '#1a1a1a' : '#fff',
    color: on ? '#fff' : '#1a1a1a', fontWeight: 600,
  }}>{children}</button>
);
const Sw = ({ c, on, onClick }) => (
  <button onClick={onClick} title={c} style={{
    width: 24, height: 24, borderRadius: 5, background: c, cursor: 'pointer',
    border: on ? '2.5px solid #1a1a1a' : '1px solid #ddd',
  }} />
);
const Sl = ({ label, v, min, max, step, on, int, inv }) => (
  <div style={{ marginBottom: 8 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#666' }}>
      <span>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{int ? v : Number(v).toFixed(3)}</span>
    </div>
    <input type="range" min={min} max={max} step={step}
      value={inv ? min + max - v : v}
      onChange={e => on(inv ? min + max - +e.target.value : +e.target.value)}
      style={{ width: '100%' }} />
  </div>
);
