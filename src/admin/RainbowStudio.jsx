import React, { useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
// The SAME generator the designer renders, never a divergent copy — the rule ChocolateDripStudio
// states and GrassStudio repeats. SceneLights/SceneEnv are the designer's own rig for the same
// reason: a colour judged under brighter lights is simply the wrong colour.
import { RainbowArch, rainbowBands, rainbowGuide, rainbowBoardReach, RAINBOW_DEFAULTS, SceneLights, SceneEnv } from '@spattoo/designer';

// ── Rainbow studio ────────────────────────────────────────────────────────────
// Concentric fondant ropes, arching over the cake.
//
// ── WHY IT IS GENERATED AND NOT A GLB ───────────────────────────────────────────
// The legs have to REACH THE BOARD, and that is a different distance on a single tier than on a
// stack — there is no scale factor that fixes it either, because the legs must stretch while the
// arch must not. A modelled arch is authored at one leg length. chocolateDrip.js met this first for
// its radius; this is the same argument standing up.
//
// ── THIS SCREEN EXISTS TO ANSWER ONE QUESTION ───────────────────────────────────
// Does it read as ROLLED FONDANT rather than as six coloured tubes? Two procedural studios (isomalt,
// palette knife) reached a working screen and never shipped, both because the subject has a precise
// familiar signature the eye checks against. A rainbow should be the safe kind — it IS concentric
// tubes, so there is no material trick to get wrong — but that is a prediction, and this is where it
// gets tested.
//
// WHAT TO JUDGE, in the order most likely to be wrong:
//   1. The JOIN where the leg meets the arch. It is tangential by construction, so a visible crease
//      means the path is being smoothed wrongly, not that the maths is off.
//   2. Band spacing. Ropes touching reads as one slab; too much daylight reads as a diagram.
//   3. Does `flatten` help? References 1 and 3 look flatter than round, but a squashed tube can
//      read as a ribbon rather than a rope.
//   4. Against a THREE-tier cake: the legs stretch and the arch does not. That is the whole feature.
//
// Nothing here saves to the catalogue yet — deliberately, exactly as GrassStudio says: the look is
// judged before an element type, an admin form and a designer control get built around it.

// Mirrors the designer's own bottom tier so every ratio is judged against the real thing.
const R = 1.2, BOTTOM_H = 1.45, BOARD_H = 0.1, BOARD_R = 1.6, TIER_STEP = 0.28;

const PRESETS = {
  // ON THE WALL, facing front — the shape in the reference photos. Three things distinguish it from
  // the arch that goes OVER a cake, and the first version had all three wrong:
  //   · SMALL — about 56% of the cake's width and half the wall's height, not 93% and 177%.
  //   · NO LEGS — `spring: 0` springs the arc straight off the board, so the ends touch it. The
  //     references have no straight legs at all; an arch on a wall is a half-circle, not a doorway.
  //   · FLAT — rolled ribbons pressed onto buttercream, not round ropes lying on it.
  'On the wall, ends on board': { surface: 'side', bands: 6, innerRadius: 0.30, thickness: 0.115,
    footLeft: 'board', footRight: 'board', offsetX: 0, theta: 0, proud: 0.02,
    spring: 0, scale: 0.6, flatten: 0.55,
    colors: ['#F6A9C0', '#F9C9A0', '#FBE9A6', '#B7DFAE', '#A8CDEB', '#C9AEDD'] },
  // The other reference: the arch sits partway UP the wall with nothing under its ends.
  'On the wall, mid-height': { surface: 'side', bands: 6, innerRadius: 0.30, thickness: 0.115,
    footLeft: 'none', footRight: 'none', offsetX: 0, theta: 0, proud: 0.02,
    spring: 0.42, scale: 0.5, flatten: 0.55,
    colors: ['#F6A9C0', '#F9C9A0', '#FBE9A6', '#B7DFAE', '#A8CDEB', '#C9AEDD'] },
  // Leaning the OTHER way — left leg down to the board, right foot on the cake.
  'Over the shoulder, mirrored': { bands: 6, innerRadius: 0.30, thickness: 0.115,
    footLeft: 'board', footRight: 'top', standoff: 0, topFootAt: 0.28, flatten: 0,
    colors: ['#F49AB6', '#F6B98E', '#F7E39A', '#9BD8B0', '#8FC7E8', '#B9A3DC'] },
  // A BACKDROP: stands behind the cake, springs from about halfway up, and the cake overlaps its
  // lower half. Not a hoop the cake sits inside.
  // The one everybody means: springs off the cake top on one side, sweeps down to the board on the
  // other. Only reachable once the two feet stopped sharing a setting.
  'Over the shoulder (ref 3)': { bands: 6, innerRadius: 0.30, thickness: 0.115, 
    footLeft: 'top', footRight: 'board', standoff: 0, topFootAt: 0.28, flatten: 0,
    colors: ['#F49AB6', '#F6B98E', '#F7E39A', '#9BD8B0', '#8FC7E8', '#B9A3DC'] },
  'Backdrop (ref 1)': { bands: 6, innerRadius: 0.34, thickness: 0.115, 
    footLeft: 'board', footRight: 'board', standoff: 0, topFootAt: 0.28, flatten: 0.15,
    colors: ['#F6A9C0', '#F9C9A0', '#FBE9A6', '#B7DFAE', '#A8CDEB', '#C9AEDD'] },
  // Sitting ON the cake: no legs to speak of, so it wants to be centred rather than set back.
  // Centred, because a STANDING arch is fitted onto the cake — placed off to one side there is
  // barely any cake left to stand on and it shrinks to a badge.
  'Classic on top (ref 2)': { bands: 7, innerRadius: 0.34, thickness: 0.075, 
    footLeft: 'top', footRight: 'top', standoff: 0.15, offsetX: 0, scale: 1, flatten: 0,
    colors: ['#EE6D8E', '#F29B54', '#F6D34F', '#7CC576', '#5BA9DE', '#8E7BC4', '#D98BC4'] },
  'Tall pastel (ref 4)': { bands: 6, innerRadius: 0.30, thickness: 0.07, 
    footLeft: 'top', footRight: 'top', standoff: 0.15, offsetX: 0, scale: 1, flatten: 0,
    colors: ['#F49AB6', '#F6B98E', '#F7E39A', '#9BD8B0', '#8FC7E8', '#B9A3DC'] },
};

// ── The arrangements a rainbow can actually be in ───────────────────────────────────────────────
// "top / board / none", twice over, is engineer's vocabulary: it names the two ENDS and leaves the
// reader to imagine what the pair adds up to. There are only five useful combinations, so they are
// offered as themselves — each with a drawing, because the whole question is what it will look like.
//
// Deliberately plain SVG rather than a 3D thumbnail: the point is to tell five silhouettes apart at
// a glance, and five little renders would cost five canvases to say less.
// Each carries EVERY field that makes it the shape it is — including where it stands. Setting only
// the feet left the position behind, so picking "falling right" from a centred arrangement changed
// the feet and moved nothing: the arch stayed in the middle and the choice looked broken. This is
// the same rule the surface toggle already followed and these tiles did not.
//
// Both leaning tiles use the SAME positive offset: it is measured toward the side the rainbow falls,
// so "falling left" mirrors without a second number.
const ARRANGEMENTS = [
  { key: 'fall-right', surface: 'top', label: 'Over, falling right',
    params: { footLeft: 'top', footRight: 'board', spring: 1, offsetX: 0.71, standoff: 0,
              scale: 1, flatten: 0 },
    draw: <><path d="M9 30 A11 11 0 0 1 31 30 L31 40" /><path d="M9 30 L9 22" /></> },
  { key: 'fall-left', surface: 'top', label: 'Over, falling left',
    params: { footLeft: 'board', footRight: 'top', spring: 1, offsetX: 0.71, standoff: 0,
              scale: 1, flatten: 0 },
    draw: <><path d="M9 30 A11 11 0 0 1 31 30 L31 22" /><path d="M9 30 L9 40" /></> },
  { key: 'backdrop', surface: 'top', label: 'Behind, both down',
    params: { footLeft: 'board', footRight: 'board', spring: 0.55, offsetX: 0, standoff: 0,
              scale: 1, flatten: 0.15 },
    draw: <><path d="M8 26 A12 12 0 0 1 32 26 L32 40" /><path d="M8 26 L8 40" /></> },
  // spring 1, NOT above it. Past 1 the springing point rises above the cake top and the arch grows
  // LEGS to reach it — it stood on 0.38 of stilt, floating clear of the cake it was supposed to be
  // sitting on. At 1 the springing point is pinned to the feet, so the arc rests straight on the
  // surface. scale 0.75 puts the feet at ±0.84 inside a 1.2 rim, and the arch about 61% of the
  // cake's height — the proportion in references 2 and 4.
  { key: 'on-top', surface: 'top', label: 'Sitting on top',
    params: { footLeft: 'top', footRight: 'top', spring: 1, offsetX: 0, standoff: 0,
              scale: 0.75, flatten: 0 },
    draw: <path d="M12 22 A8 8 0 0 1 28 22" /> },
  // ONE wall tile, not two. The pair that was here differed only in HEIGHT — ends on the board
  // versus floating partway up — and `Springs at` already moves it between them. A chooser offering
  // two points on a slider as though they were different shapes is a chooser with a wasted tile.
  { key: 'wall', surface: 'side', label: 'On the wall',
    params: { footLeft: 'board', footRight: 'board', spring: 0, offsetX: 0, standoff: 0,
              theta: 0, proud: 0.02, scale: 0.6, flatten: 0.55 },
    draw: <path d="M13 40 A7 7 0 0 1 27 40" /> },
];

// A cake in outline with the arrangement drawn against it — the SAME cake in every tile, so the
// difference between them is the rainbow and nothing else.
function ArrangementTile({ item, on, onPick }) {
  return (
    <button type="button" onClick={onPick} title={item.label}
      style={{ ...s.tile, ...(on ? s.tileOn : {}) }}>
      <svg viewBox="0 0 40 46" style={{ width: 46, height: 52 }}>
        <ellipse cx="20" cy="42" rx="17" ry="3" fill="#EDE7DA" />
        <rect x="8" y="22" width="24" height="19" rx="1.5" fill="#F7F5F1" stroke="#DDD8CF" />
        <g fill="none" stroke={on ? '#2C4433' : '#B7AEA1'} strokeWidth="2.6"
           strokeLinecap="round">{item.draw}</g>
      </svg>
      <span style={s.tileLbl}>{item.label}</span>
    </button>
  );
}

function Cake({ tiers, boardR }) {
  const geo = useMemo(() => {
    const g = [];
    let y = BOARD_H;
    for (let i = 0; i < tiers; i++) {
      const r = R - i * TIER_STEP;
      g.push({ r, h: BOTTOM_H - i * 0.12, y });
      y += BOTTOM_H - i * 0.12;
    }
    return g;
  }, [tiers]);
  return (
    <group>
      <mesh position={[0, BOARD_H / 2, 0]} receiveShadow>
        <cylinderGeometry args={[boardR, boardR, BOARD_H, 64]} />
        <meshStandardMaterial color="#d9c9a3" roughness={0.7} metalness={0.15} />
      </mesh>
      {geo.map((t, i) => (
        <mesh key={i} position={[0, t.y + t.h / 2, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[t.r, t.r, t.h, 64]} />
          <meshStandardMaterial color="#fdfbf7" roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

export default function RainbowStudio() {
  const [p, setP] = useState({ ...RAINBOW_DEFAULTS });
  const [tiers, setTiers] = useState(1);
  // On by default — it is what the thing is made of. The toggle exists to see the difference, which
  // is the only way to judge whether the grain is doing any work at this size.
  const [fondant, setFondant] = useState(true);
  const set = (k, v) => setP(o => ({ ...o, [k]: v }));

  // The cake the rainbow must fit — recomputed from the tier count, which is the point of the screen.
  const cake = useMemo(() => {
    let top = BOARD_H;
    for (let i = 0; i < tiers; i++) top += BOTTOM_H - i * 0.12;
    return { radius: R, topY: top, boardY: BOARD_H };
  }, [tiers]);

  // The board GROWS to hold the rainbow. A standard board is sized for the cake, and a leg that
  // lands past its edge is a decoration resting on nothing — so the board answers to what is
  // standing on it. Never shrinks: a small rainbow does not make a cake need a smaller board.
  const boardR = useMemo(() => Math.max(BOARD_R, rainbowBoardReach(p, cake)), [p, cake]);
  // How far the clearance rule had to move it beyond what was asked for. Zero at any sane setting.
  // Is `spring` doing anything right now? It sets where the arc begins, but a foot RESTING on the
  // cake top pins the springing point to that foot — so in that one arrangement the slider is inert
  // and the screen should say so rather than let somebody drag a dead control. It is live in every
  // other arrangement: backdrop, no feet, and both wall shapes.
  const springPinned = useMemo(() => {
    const b = rainbowBands(p, cake);
    const asked = cake.boardY + (cake.topY - cake.boardY) * (p.spring ?? 1);
    return b.archY > asked + 1e-6;
  }, [p, cake]);

  const stepped = useMemo(() => {
    const used = rainbowBands(p, cake).standoff;
    return Math.max(0, used - (p.standoff ?? 0) * R);
  }, [p, cake]);
  const guide = useMemo(() => rainbowGuide(p, cake), [p, cake]);
  const bandCount = rainbowBands(p, cake).bands.length;

  const num = (label, key, min, max, step) => (
    <label style={s.row} key={key}>
      <span style={s.lbl}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={p[key]}
             onChange={e => set(key, parseFloat(e.target.value))} style={{ flex: 1 }} />
      <span style={s.val}>{typeof p[key] === 'number' ? p[key].toFixed(3) : p[key]}</span>
    </label>
  );

  return (
    <div style={s.wrap}>
      <div style={s.stage}>
        <Canvas shadows camera={{ position: [0, 2.4, 7.2], fov: 38 }} gl={{ antialias: true }}>
          <color attach="background" args={['#eceaf3']} />
          <SceneLights />
          <SceneEnv />
          <Cake tiers={tiers} boardR={boardR} />
          <RainbowArch params={p} cake={cake} fondant={fondant} />
          <OrbitControls target={[0, cake.topY * 0.6, 0]} enablePan={false} />
        </Canvas>
      </div>

      <div style={s.panel}>
        <h2 style={s.h2}>Rainbow studio</h2>
        <p style={s.note}>
          Generated, not modelled: the legs reach the board, which is a different distance on every
          cake. Change the tier count and watch the legs stretch while the arch stays put — that is
          the whole reason this is not a GLB.
          <br /><br />
          <b>Size</b> scales the whole thing; <b>Inner radius</b> stretches it from the inside — the
          hole grows and everything outside it moves out with it, so it is not a "hole size" control.
          <b>Springs at</b> is where the arc begins — on the wall that is the whole vertical story:
          0 rests the ends on the board, higher floats it partway up. An arch with BOTH feet on the top is
          standing on the cake, so it is fitted to it — placed off to one side there is little cake
          left to stand on and it shrinks, which is what <b>Position</b> costs you there.
          <br /><br />
          <b>Position</b> is measured toward the side it FALLS, so swapping the feet mirrors it —
          left leg on the board and right foot on the cake needs no second number. And no size
          control moves it. Dragging the inner radius used
          to walk the rainbow across the cake, because the position was derived from the outer
          radius; it is a plain number now.
          <br /><br />
          The two feet land INDEPENDENTLY: one on the cake top and the other down on the board is
          the lopsided shape a real rainbow cake uses. When they differ, the arch leans toward the
          board side on its own, so the resting foot lands ON the cake instead of in mid-air beside
          it — <b>Rests at</b> is how far out it sits, 0 being the middle of the top and 1 the rim.
          <br /><br />
          The proportion that matters is a <b>tight inner radius under fat ropes</b>: that is what
          makes the band stack reach past the cake, so the legs come down beside it and nearly touch.
          A wide hole with thin ropes gives a shallow hoop that can only miss the cake by standing
          back — which puts the rainbow at the front of the board with a gap down its side. <b>Stands back</b> puts it behind the cake;
          at 0 it is centred and straddles it.
          <br /><br />
          Gone, and worth knowing why: <b>Gap</b> — fondant ropes with daylight between them do not
          hold each other up, so they touch, always. <b>Lean</b> — nothing wanted it.
        </p>

        <div style={s.group}>
          <span style={s.groupLbl}>Preset</span>
          {Object.keys(PRESETS).map(k => (
            <button key={k} style={s.chip} onClick={() => setP(o => ({ ...o, ...PRESETS[k] }))}>{k}</button>
          ))}
        </div>

        <div style={s.group}>
          <span style={s.groupLbl}>
            Cake · board {boardR > BOARD_R + 1e-6
              ? `grown to ${(boardR / BOARD_R).toFixed(2)}×`
              : 'standard'}
            {/* Said out loud rather than done quietly. Stepping back is the one move the geometry
                makes on its own, and only to avoid a rope through the icing — so when it happens,
                the screen says so instead of leaving somebody wondering why it drifted. */}
            {stepped > 0.001 && ` · stepped back ${stepped.toFixed(2)} to clear the cake`}
          </span>
          {[1, 2, 3].map(n => (
            <button key={n} onClick={() => setTiers(n)}
              style={{ ...s.chip, ...(tiers === n ? s.chipOn : {}) }}>{n} tier</button>
          ))}
        </div>

        <div style={s.group}>
          <span style={s.groupLbl}>Grain</span>
          {[[true, 'fondant'], [false, 'plain']].map(([v, label]) => (
            <button key={label} onClick={() => setFondant(v)}
              style={{ ...s.chip, ...(fondant === v ? s.chipOn : {}) }}>{label}</button>
          ))}
        </div>

        {/* Each foot lands on its own. One on the cake and one on the board is the lopsided shape a
            rainbow cake actually uses — a single setting could only ever make a symmetric arch. */}
        {/* One question — what does it look like — instead of two enums and a mental model. */}
        <div style={s.group}>
          <span style={s.groupLbl}>Arrangement</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {ARRANGEMENTS.map(a => (
              <ArrangementTile key={a.key} item={a}
                // On the wall the FEET are not part of the choice — the tile is the surface, and
                // where it sits up the wall is the slider's job.
                on={(p.surface ?? 'top') === a.surface
                    && (a.surface === 'side'
                        || (p.footLeft === a.params.footLeft && p.footRight === a.params.footRight))}
                onPick={() => setP(o => ({ ...o, surface: a.surface, ...a.params }))} />
            ))}
          </div>
        </div>

        {/* Back after being cut. It was measured in ONE arrangement — an arch leaning over the cake,
            where a resting foot pins it — and cut on that evidence. It is live in the other four. */}
        {num('Springs at', 'spring', 0, 1.4, 0.02)}
        {springPinned && (
          <div style={{ ...s.row, marginTop: -4, marginBottom: 10 }}>
            <span style={s.lbl} />
            <span style={{ fontSize: 10.5, color: '#B08A6A' }}>
              pinned by the foot resting on the cake — free it by putting both feet on the board
            </span>
          </div>
        )}
        {num('Size', 'scale', 0.3, 2.5, 0.05)}
        {num('Bands', 'bands', 3, 9, 1)}
        {num('Inner radius', 'innerRadius', 0.15, 1.2, 0.01)}
        {num('Thickness', 'thickness', 0.03, 0.2, 0.005)}
        {num('Position', 'offsetX', -0.5, 1.6, 0.02)}
        {(p.surface ?? 'top') === 'side' && num('Round the cake', 'theta', -3.14, 3.14, 0.05)}
        {(p.surface ?? 'top') === 'side' && num('Off the wall', 'proud', 0, 0.1, 0.005)}
        {num('Stands back', 'standoff', 0, 2, 0.05)}
        {num('Flatten', 'flatten', 0, 0.9, 0.05)}

        <div style={s.colors}>
          <span style={s.groupLbl}>Colours</span>
          {Array.from({ length: bandCount }, (_, i) => (
            <input key={i} type="color" value={p.colors[i % p.colors.length]} style={s.swatch}
              onChange={e => setP(o => {
                const next = [...o.colors];
                while (next.length < bandCount) next.push(next[next.length % o.colors.length]);
                next[i] = e.target.value;
                return { ...o, colors: next };
              })} />
          ))}
        </div>

        {/* The lengths a baker would roll, said the ONLY way that survives them baking a different
            size. Never millimetres: the cake here is a nominal one, and a millimetre would be a
            promise about a cake nobody has seen. Same reason the X-ray stores tier_width_ratio and
            derives millimetres last. */}
        <div style={s.guide}>
          <span style={s.groupLbl}>What the baker rolls</span>
          {guide.map(g => (
            <div key={g.index} style={s.guideRow}>
              <span style={{ ...s.dot, background: g.color }} />
              <span>band {g.index + 1}</span>
              <span style={s.guideVal}>{g.lengthOfCakeWidth}× the cake's width</span>
            </div>
          ))}
        </div>

        <details style={{ marginTop: 14 }}>
          <summary style={s.groupLbl}>placement_config</summary>
          <pre style={s.json}>{JSON.stringify({ rainbow: p }, null, 2)}</pre>
        </details>
      </div>
    </div>
  );
}

const FONT = "'Quicksand', sans-serif";
const s = {
  wrap:  { display: 'flex', height: '100vh', fontFamily: FONT },
  stage: { flex: 1, minWidth: 0, background: '#eceaf3' },
  panel: { width: 340, overflowY: 'auto', padding: 18, borderLeft: '1px solid #E3E0DA', background: '#fff' },
  h2:    { margin: '0 0 6px', fontSize: 18, color: '#2C4433' },
  note:  { margin: '0 0 14px', fontSize: 12, lineHeight: 1.5, color: '#7B8A7F' },
  group: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 12 },
  groupLbl: { fontSize: 10, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', color: '#9AA79E', width: '100%' },
  tile:  { border: '1.5px solid #E3E0DA', background: '#fff', borderRadius: 10, padding: '6px 4px 4px',
           cursor: 'pointer', width: 76, display: 'flex', flexDirection: 'column', alignItems: 'center',
           gap: 2, fontFamily: FONT },
  tileOn:{ borderColor: '#2C4433', background: '#F4F7F4' },
  tileLbl:{ fontSize: 9, lineHeight: 1.2, color: '#5B6B60', textAlign: 'center' },
  chip:  { border: '1px solid #D9D5CE', background: '#fff', borderRadius: 20, padding: '5px 11px', cursor: 'pointer', fontSize: 12, fontFamily: FONT },
  chipOn:{ background: '#2C4433', color: '#fff', borderColor: '#2C4433' },
  row:   { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 12 },
  lbl:   { width: 92, color: '#5B6B60' },
  val:   { width: 48, textAlign: 'right', color: '#9AA79E', fontVariantNumeric: 'tabular-nums' },
  colors:{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '10px 0' },
  swatch:{ width: 30, height: 26, border: '1px solid #D9D5CE', borderRadius: 6, padding: 0, cursor: 'pointer' },
  guide: { marginTop: 14, borderTop: '1px solid #EFEDE8', paddingTop: 10 },
  guideRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5B6B60', padding: '3px 0' },
  guideVal: { marginLeft: 'auto', color: '#9AA79E' },
  dot:   { width: 12, height: 12, borderRadius: '50%', display: 'inline-block' },
  json:  { fontSize: 11, background: '#F7F6F2', padding: 10, borderRadius: 8, overflowX: 'auto' },
};
