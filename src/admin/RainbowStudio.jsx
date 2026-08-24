import React, { useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
// The SAME generator the designer renders, never a divergent copy — the rule ChocolateDripStudio
// states and GrassStudio repeats. SceneLights/SceneEnv are the designer's own rig for the same
// reason: a colour judged under brighter lights is simply the wrong colour.
import { RainbowArch, rainbowBands, rainbowGuide, RAINBOW_DEFAULTS, SceneLights, SceneEnv,
         RAINBOW_ARRANGEMENTS, ArrangementTile, iconTiers } from '@spattoo/designer';
import { useElementSave } from '../lib/useElementSave.js';

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

// The arrangements live in CORE now — a customer picks from this same list in the designer's edit
// card, so two copies would be a studio tuned to one shape and a cake showing another (INVARIANTS
// #3). The tile component comes with them, which is why this file no longer draws its own.
// The stack, once. The rainbow's geometry comes from the SAME list the mesh is drawn from — two
// descriptions of where tier 2 starts is how a decoration ends up floating above the tier it is
// Which tier, drawn rather than named. "on top" is a phrase that means the top TIER here and the
// top SURFACE two lines down, and the picture is not ambiguous the way the words are. Studio-only —
// a customer never chooses a tier, they drag the rainbow onto the one they want — so it stays here
// rather than moving to core with the arrangement tiles.
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

// ── The picker tile is a picture of the DECORATION ──────────────────────────────────────────────
// Not of a cake with a decoration on it. The tile is about 60px: a whole cake with a small white
// cloud on its board is unreadable at that size, and white fondant against a white cake on a pale
// background is unreadable at any size.
//
// `preserveDrawingBuffer` fixes a BLANK capture. This fixes an EMPTY-LOOKING one, which the blank
// check cannot catch — those pixels differ, they just all differ by nothing anybody can see.
//
// One click, and what is on screen is exactly what gets captured. Automating it at save time was the
// alternative and it hides the one thing worth seeing: the picture you are about to store.
export default function RainbowStudio() {
  const [p, setP] = useState({ ...RAINBOW_DEFAULTS });
  const canvasWrapRef = useRef(null);
  const [thumbView, setThumbView] = useState(false);
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
      // What a falling foot lands ON — for the bottom tier, THE BOARD. It used to be null here and
      // the board grew instead, which meant the studio showed a full-size arch that a real cake then
      // shrank to about half: an author tuning a look nobody would ever get. A board is a thing the
      // baker buys, sized to the cake, so it does not grow on a real one.
      supportRadius: i === 0 ? BOARD_R : stack[i - 1].r,
    };
  }, [tiers, tierIndex]);

  // The board GROWS to hold the rainbow. A standard board is sized for the cake, and a leg that
  // lands past its edge is a decoration resting on nothing — so the board answers to what is
  // standing on it. Never shrinks: a small rainbow does not make a cake need a smaller board.
  // Only the BOTTOM tier stands on the board, so only a rainbow there can make it grow. One on an
  // upper tier falls onto the tier below, which cannot be widened.
  // Fixed. The arch fits the board now, rather than the board stretching to catch the arch.
  const boardR = BOARD_R;

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

  // Where the arch actually IS, and how big — so the thumbnail frames the arch rather than a cake
  // with an arch beside it. Placement is not saved on the row, so a tile showing one describes
  // something the customer will never get.
  const shot = useMemo(() => {
    const pts = rainbowBands(p, cake).bands.flatMap(b => b.path);
    if (!pts.length) return { centre: [0, 1, 0], dist: 3 };
    const ax = a => [Math.min(...pts.map(v => v[a])), Math.max(...pts.map(v => v[a]))];
    const [x0, x1] = ax('x'), [y0, y1] = ax('y'), [z0, z1] = ax('z');
    return {
      centre: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
      dist: Math.max(1.2, Math.max(x1 - x0, y1 - y0) * 1.5),
    };
  }, [p, cake]);

  // The same hook the grass and letter-block studios use — create once, update thereafter
  // (INVARIANTS #3). Needs an element type with slug `rainbow` (migration 072).
  //
  // What goes in the row is the SHAPE, and only the shape. Colours are on the row as a starting
  // point, but where it sits (`offsetX`, `theta`, `standoff`, `surface`) is not: those are the
  // customer's decisions on their own cake, and freezing them here would author a rainbow that can
  // only ever be in one place. `scale` stays for the same reason `surface` goes — an author tuning
  // "small pastel arch" is describing the thing, not where it lives.
  const { editing, saveName, setSaveName, busy, msg, save, startNew } = useElementSave({
    // ONE type for every generated fondant shape, not one per shape (migration 073). What differs
    // between a rainbow and a cloud is which generator draws it, and that is
    // `placement_config.procedural` on the element — the type is how a thing BEHAVES, and these two
    // behave identically.
    typeSlug: 'fondant_decor',
    categorySlug: 'sky',   // where a customer browses to find it (migration 074)
    canvasRef: canvasWrapRef,
    buildPayload: () => ({
      // All three, because the geometry genuinely does all three — the wall version is a different
      // object, not the arch turned sideways.
      allowed_zones: ['top_surface', 'side', 'board'],
      default_color: p.colors?.[0] ?? '#F6A9C0',
      placement_config: {
        procedural: 'rainbow',
        rainbow: {
          bands: p.bands,
          innerRadius: +Number(p.innerRadius).toFixed(3),
          thickness: +Number(p.thickness).toFixed(4),
          spring: +Number(p.spring).toFixed(3),
          flatten: +Number(p.flatten).toFixed(3),
          scale: +Number(p.scale).toFixed(3),
          colors: p.colors,
          // The feet ARE the shape — "over, falling right" and "sitting on top" are different
          // rainbows, not one rainbow in two places.
          footLeft: p.footLeft,
          footRight: p.footRight,
        },
      },
    }),
    onHydrate: (el) => setP(o => ({ ...o, ...(el.placement_config?.rainbow ?? {}) })),
  });

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
      <div style={s.stage} ref={canvasWrapRef}>
        {/* preserveDrawingBuffer, or the saved thumbnail is a BLANK png: WebGL clears the drawing
            buffer after compositing, so canvas.toBlob() reads an empty one. The capture succeeds,
            uploads, and stores nothing. */}
        {/* Keyed on the view, because a Canvas takes its camera on mount only. */}
        <Canvas key={thumbView ? 'thumb' : 'scene'} shadows
          camera={thumbView
            ? { position: [shot.centre[0], shot.centre[1], shot.centre[2] + shot.dist], fov: 38 }
            : { position: [0, 2.4, 7.2], fov: 38 }}
          gl={{ antialias: true, preserveDrawingBuffer: true }}>
          <color attach="background" args={[thumbView ? '#E8E2F0' : '#eceaf3']} />
          <SceneLights />
          <SceneEnv />
          {!thumbView && <Cake tiers={tiers} boardR={boardR} />}
          <RainbowArch params={p} cake={cake} fondant={fondant} />
          <OrbitControls target={thumbView ? shot.centre : [0, cake.topY * 0.6, 0]} enablePan={false} />
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
            Cake · board standard, and it stays that way
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
              Shrunk to {fitted.toFixed(2)}× so the falling foot lands on what is under it — the board
              on the bottom tier, the tier below higher up. Neither grows: a board is a thing the baker
              buys, sized to the cake. On a standard board a full-size leaning arch does not fit at
              all — the foot has to clear the cake AND land inside the board, and that ring is narrow.
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
            {RAINBOW_ARRANGEMENTS.map(a => (
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

        {/* Save. The look has been judged, so the row is what makes it a real catalogue element:
            searchable, taggable, tunable without a deploy. Create once, update thereafter — see
            useElementSave for why that matters. Needs an element type with slug `rainbow`
            (migration 073). */}
        <div style={s.save}>
          <div style={s.saveLbl}>{editing ? 'EDITING A SAVED ELEMENT' : 'SAVE AS ELEMENT'}</div>
          {editing && (
            <p style={s.saveNote}>
              Revising <b>{editing.name}</b> — saving replaces its settings and thumbnail rather than
              adding another row.
            </p>
          )}
          <button onClick={() => setThumbView(v => !v)}
            style={{ ...s.saveInput, marginBottom: 6, cursor: 'pointer', fontWeight: 700,
              background: thumbView ? '#2C4433' : '#fff', color: thumbView ? '#fff' : '#2C4433' }}>
            {thumbView ? 'Thumbnail view — this is the tile' : 'Set up the thumbnail'}
          </button>
          <input value={saveName} onChange={e => setSaveName(e.target.value)}
            placeholder="e.g. Pastel six-band" style={s.saveInput} />
          <button onClick={save} disabled={busy || !saveName.trim()}
            style={{ ...s.saveBtn, ...(busy || !saveName.trim() ? s.saveBtnOff : {}) }}>
            {busy ? (editing ? 'Updating…' : 'Saving…') : (editing ? 'Update this element' : 'Save to catalogue')}
          </button>
          {msg && <p style={{ ...s.saveNote, color: msg.ok ? '#2e7d32' : '#c0392b' }}>{msg.text}</p>}
          {editing && (
            <button onClick={startNew}
              style={{ marginTop: 6, width: '100%', padding: '6px 0', fontSize: 11.5, borderRadius: 7,
                border: '1.5px solid #C9C1B4', background: '#fff', color: '#5B6B60', fontWeight: 700,
                fontFamily: 'inherit', cursor: 'pointer' }}>
              Start a new element instead
            </button>
          )}
          <p style={s.saveNote}>
            The row carries the SHAPE — bands, ropes, colours, which feet. Not where it sits: that is
            the customer's decision on their own cake, and an arrangement frozen here would be a
            rainbow that can only ever stand in one place.
          </p>
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
  save:  { marginTop: 16, paddingTop: 14, borderTop: '1px solid #EFEDE8' },
  saveLbl: { fontSize: 10, fontWeight: 800, letterSpacing: 0.6, color: '#9AA79E', marginBottom: 5 },
  saveNote: { fontSize: 10.5, color: '#7B8A7F', margin: '0 0 6px', lineHeight: 1.45 },
  saveInput: { width: '100%', padding: '7px 9px', fontSize: 12.5, fontFamily: FONT,
               border: '1.5px solid #D9D5CE', borderRadius: 7, boxSizing: 'border-box' },
  saveBtn: { marginTop: 8, width: '100%', padding: '8px 0', fontSize: 12.5, borderRadius: 7,
             border: '1.5px solid #2C4433', background: '#2C4433', color: '#fff', fontWeight: 700,
             fontFamily: FONT, cursor: 'pointer' },
  saveBtnOff: { background: '#E8E4DC', borderColor: '#E8E4DC', color: '#aaa', cursor: 'default' },
  json:  { fontSize: 11, background: '#F7F6F2', padding: 10, borderRadius: 8, overflowX: 'auto' },
};
