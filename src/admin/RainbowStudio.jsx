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
  'On the wall, ends on board': { surface: 'side', bands: 6, innerRadius: 0.30, thickness: 0.12,
    footLeft: 'board', footRight: 'board', offsetX: 0, theta: -0.09, proud: 0.02,
    spring: 0.18, scale: 0.75, flatten: 0,
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
    draw: (t, floor) => {
      const [a, b] = leanFeet(t, 1);
      const r = (b - a) / 2;
      return <path d={`M${a} ${t.top} A${r} ${r} 0 0 1 ${b} ${t.top} L${b} ${floor}`} />;
    } },
  { key: 'fall-left', surface: 'top', label: 'Over, falling left',
    params: { footLeft: 'board', footRight: 'top', spring: 1, offsetX: 0.71, standoff: 0,
              scale: 1, flatten: 0 },
    draw: (t, floor) => {
      const [a, b] = leanFeet(t, -1);
      const r = (b - a) / 2;
      return <path d={`M${a} ${floor} L${a} ${t.top} A${r} ${r} 0 0 1 ${b} ${t.top}`} />;
    } },
  // spring 1, NOT above it. Past 1 the springing point rises above the cake top and the arch grows
  // LEGS to reach it — it stood on 0.38 of stilt, floating clear of the cake it was supposed to be
  // sitting on. At 1 the springing point is pinned to the feet, so the arc rests straight on the
  // surface. scale 0.75 puts the feet at ±0.84 inside a 1.2 rim, and the arch about 61% of the
  // cake's height — the proportion in references 2 and 4.
  { key: 'on-top', surface: 'top', label: 'Sitting on top',
    params: { footLeft: 'top', footRight: 'top', spring: 1, offsetX: 0, standoff: 0,
              scale: 0.75, flatten: 0 },
    draw: t => {
      const r = t.w * 0.34;
      return <path d={`M${t.cx - r} ${t.top} A${r} ${r} 0 0 1 ${t.cx + r} ${t.top}`} />;
    } },
  // ONE wall tile, not two. The pair that was here differed only in HEIGHT — ends on the board
  // versus floating partway up — and `Springs at` already moves it between them. A chooser offering
  // two points on a slider as though they were different shapes is a chooser with a wasted tile.
  // Every number here was dialled in by hand and handed over as "take this as the default" — so it
  // is transcribed, not derived. Two of them are things I would have got wrong on my own: flatten is
  // ZERO (round ropes read better on a wall than pressed ribbons, whatever the photos suggested to
  // me), and the arch is rotated slightly off dead-centre, which stops it looking like a diagram.
  { key: 'wall', surface: 'side', label: 'On the wall',
    params: { footLeft: 'board', footRight: 'board', spring: 0.18, offsetX: 0, standoff: 0,
              theta: -0.09, proud: 0.02, scale: 0.75, flatten: 0,
              bands: 6, innerRadius: 0.30, thickness: 0.12 },
    draw: t => {
      const r = Math.min(t.w * 0.30, (t.base - t.top) * 0.75);
      return <path d={`M${t.cx - r} ${t.base - 1} A${r} ${r} 0 0 1 ${t.cx + r} ${t.base - 1}`} />;
    } },
];

// The stack as the ICONS draw it — the same shape the studio renders, flattened to a 40×46 box.
// Heights and widths taper the way the real tiers do, so a 3-tier icon reads as a 3-tier cake and
// not as a wedding cake drawn by someone who has not seen one.
const BOARD_Y = 41;
function iconTiers(tiers) {
  const boxes = [];
  let base = BOARD_Y;
  for (let i = 0; i < tiers; i++) {
    const w = 24 - i * 5.5;
    const h = tiers === 1 ? 19 : (tiers === 2 ? 13 - i * 2 : 11 - i * 1.5);
    boxes.push({ x: 20 - w / 2, w, cx: 20, base, top: base - h });
    base -= h;
  }
  return boxes;
}

// The two feet of a LEANING arch: one resting on the tier, one hanging past its edge. Defined by
// where the feet go rather than by a radius, because a radius that suits the top tier of a stack
// runs the bottom tier's arch off the side of a 40-wide icon — which is what a radius did.
// `dir` is +1 falling right, -1 falling left.
function leanFeet(t, dir) {
  const rest = t.cx + dir * (t.w * 0.5 - t.w * 0.28);   // on the tier, in from the far edge
  const fall = t.cx + dir * Math.min(t.w * 0.5 + 5, 17); // past the edge, inside the icon
  return dir > 0 ? [rest, fall] : [fall, rest];
}

// A cake in outline with the arrangement drawn against it. The stack and the CHOSEN tier are the
// same in every tile, so the only difference between tiles is the rainbow — and the same drawing
// answers "which tier" and "which arrangement" at once, which is how the choice is actually made:
// nobody picks "on the wall" and then wonders whose wall.
function ArrangementTile({ item, on, onPick, tiers, tierIndex }) {
  const boxes = iconTiers(tiers);
  const t = boxes[Math.min(tierIndex, boxes.length - 1)];
  // What a falling foot lands on: the tier below, or the board when there is nothing below.
  const floor = tierIndex === 0 ? BOARD_Y : boxes[tierIndex - 1].top;
  const rainbow = (
    <g fill="none" stroke={on ? '#2C4433' : '#B7AEA1'} strokeWidth="2.6"
       strokeLinecap="round">{item.draw(t, floor)}</g>
  );
  return (
    <button type="button" onClick={onPick} title={item.label}
      style={{ ...s.tile, ...(on ? s.tileOn : {}) }}>
      <svg viewBox="0 0 40 46" style={{ width: 46, height: 52 }}>
        <ellipse cx="20" cy="42" rx="17" ry="3" fill="#EDE7DA" />
        {boxes.map((b, i) => (
          <rect key={i} x={b.x} y={b.top} width={b.w} height={b.base - b.top} rx="1.5"
                fill={i === tierIndex ? '#FFFFFF' : '#F7F5F1'}
                stroke={i === tierIndex ? '#C9C1B4' : '#DDD8CF'} />
        ))}
        {rainbow}
      </svg>
      <span style={s.tileLbl}>{item.label}</span>
    </button>
  );
}

// Which tier, drawn rather than named. "on top" is a phrase that means the top TIER here and the top
// SURFACE two lines down, and the picture is not ambiguous the way the words are.
function TierTile({ tiers, index, on, onPick }) {
  const boxes = iconTiers(tiers);
  return (
    <button type="button" onClick={onPick} title={`tier ${index + 1}`}
      style={{ ...s.tierTile, ...(on ? s.tileOn : {}) }}>
      <svg viewBox="0 0 40 46" style={{ width: 30, height: 34 }}>
        <ellipse cx="20" cy="42" rx="17" ry="3" fill="#EDE7DA" />
        {boxes.map((b, i) => (
          <rect key={i} x={b.x} y={b.top} width={b.w} height={b.base - b.top} rx="1.5"
                fill={i === index ? '#2C4433' : '#F7F5F1'}
                stroke={i === index ? '#2C4433' : '#DDD8CF'} />
        ))}
      </svg>
    </button>
  );
}

// The stack, once. The rainbow's geometry comes from the SAME list the mesh is drawn from — two
// descriptions of where tier 2 starts is how a decoration ends up floating above the tier it is
// supposed to be standing on.
function tierStack(tiers) {
  const g = [];
  let y = BOARD_H;
  for (let i = 0; i < tiers; i++) {
    const h = BOTTOM_H - i * 0.12;
    g.push({ r: R - i * TIER_STEP, h, y, topY: y + h });
    y += h;
  }
  return g;
}

function Cake({ tiers, boardR }) {
  const geo = useMemo(() => tierStack(tiers), [tiers]);
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
  const [tierIndex, setTierIndex] = useState(0);
  // On by default — it is what the thing is made of. The toggle exists to see the difference, which
  // is the only way to judge whether the grain is doing any work at this size.
  const [fondant, setFondant] = useState(true);
  const set = (k, v) => setP(o => ({ ...o, [k]: v }));

  // The cake the rainbow must fit — recomputed from the tier count, which is the point of the screen.
  // A rainbow belongs to a TIER, not to the cake. The geometry asks for { radius, topY, boardY } and
  // has never cared which of the two that describes — so tier 2 is the same code given tier 2's
  // numbers: its own radius, its own top, and the surface it STANDS on, which is the board for the
  // bottom tier and the tier below's top for any other.
  const cake = useMemo(() => {
    const stack = tierStack(tiers);
    const i = Math.min(tierIndex, stack.length - 1);
    const t = stack[i];
    return {
      radius: t.r, topY: t.topY, boardY: t.y,
      // What a falling foot lands ON. The board is left out on purpose: it GROWS to catch a foot,
      // so it is never the thing that limits the rainbow. A tier below cannot grow, so it is.
      supportRadius: i === 0 ? null : stack[i - 1].r,
    };
  }, [tiers, tierIndex]);

  // The board GROWS to hold the rainbow. A standard board is sized for the cake, and a leg that
  // lands past its edge is a decoration resting on nothing — so the board answers to what is
  // standing on it. Never shrinks: a small rainbow does not make a cake need a smaller board.
  // Only the BOTTOM tier stands on the board, so only a rainbow there can make it grow. One on an
  // upper tier falls onto the tier below, which cannot be widened.
  const boardR = useMemo(
    () => (tierIndex === 0 ? Math.max(BOARD_R, rainbowBoardReach(p, cake)) : BOARD_R),
    [p, cake, tierIndex],
  );

  // How much the geometry had to shrink it so the falling foot lands on the tier below. Announced,
  // not silent — the same rule the step-back follows: the studio says what it did rather than
  // leaving the author wondering why the size slider stopped doing anything.
  const fitted = useMemo(() => rainbowBands(p, cake).supportFit, [p, cake]);
  // How far the clearance rule had to move it beyond what was asked for. Zero at any sane setting.
  // Is `spring` doing anything right now? It sets where the arc begins, but a foot RESTING on the
  // cake top pins the springing point to that foot — so in that one arrangement the slider is inert
  // and the screen should say so rather than let somebody drag a dead control. It is live in every
  // other arrangement: a leaning arch whose top foot is off the cake, and both wall shapes.
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

  // WHICH width the guide's ratios are measured against. Every one of them is a fraction of the tier
  // the rainbow sits on, and on a stack "1.6x the cake's width" names three different numbers — the
  // one thing a ratio was supposed to stop happening.
  const tierName = tierIndex === 0 ? 'bottom' : tierIndex === tiers - 1 ? 'top' : `tier ${tierIndex + 1}`;
  const guideWidth = tiers === 1 ? "the cake's width" : `the ${tierName} tier's width`;
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
          back — which puts the rainbow at the front of the board with a gap down its side. <b>Stands back</b>
          is how far off the cake's middle it stands, and at 0 it is centred and straddles it.
          <br /><br />
          Gone, and worth knowing why: <b>Gap</b> — fondant ropes with daylight between them do not
          hold each other up, so they touch, always. <b>Lean</b> — nothing wanted it. <b>Off the
          wall</b> — a rope pressed onto a cake is pressed onto it; the one value that is not zero is
          there to keep the two surfaces from flickering against each other, which is a rendering
          detail and not a decision anybody makes.
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
            <button key={n} onClick={() => { setTiers(n); setTierIndex(i => Math.min(i, n - 1)); }}
              style={{ ...s.chip, ...(tiers === n ? s.chipOn : {}) }}>{n} tier</button>
          ))}
          {/* WHICH tier the rainbow belongs to. The geometry asks for { radius, topY, boardY } and
              has never cared whether that is the whole cake or one tier of it — so this passes the
              chosen tier's numbers and every ratio scales to that tier instead. Drawn top-first, so
              the buttons sit in the order the tiers do. */}
          {tiers > 1 && Array.from({ length: tiers }, (_, i) => tiers - 1 - i).map(i => (
            <TierTile key={`t${i}`} tiers={tiers} index={i} on={tierIndex === i}
                      onPick={() => setTierIndex(i)} />
          ))}
          {fitted < 0.999 && (
            <span style={{ ...s.tileLbl, width: '100%', textAlign: 'left', marginTop: 2, color: '#b45309' }}>
              Shrunk to {fitted.toFixed(2)}× so the falling foot lands on the tier below. A board grows
              to catch a foot; a tier cannot. Move it in (Position) to get more of the size back.
            </span>
          )}
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
              <ArrangementTile key={a.key} item={a} tiers={tiers} tierIndex={tierIndex}
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
              <span style={s.guideVal}>{g.lengthOfCakeWidth}× {guideWidth}</span>
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
  tierTile: { padding: 2, borderRadius: 8, border: '1px solid #E4E0D8', background: '#fff',
              cursor: 'pointer', lineHeight: 0 },
  guide: { marginTop: 14, borderTop: '1px solid #EFEDE8', paddingTop: 10 },
  guideRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5B6B60', padding: '3px 0' },
  guideVal: { marginLeft: 'auto', color: '#9AA79E' },
  dot:   { width: 12, height: 12, borderRadius: '50%', display: 'inline-block' },
  json:  { fontSize: 11, background: '#F7F6F2', padding: 10, borderRadius: 8, overflowX: 'auto' },
};
