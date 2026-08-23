import React, { useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
// The SAME generator the designer renders, never a divergent copy — the rule ChocolateDripStudio
// states and GrassStudio repeats. SceneLights/SceneEnv are the designer's own rig for the same
// reason: a colour judged under brighter lights is simply the wrong colour.
import { RainbowArch, rainbowBands, rainbowGuide, RAINBOW_DEFAULTS, SceneLights, SceneEnv } from '@spattoo/designer';

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
  'Pastel arch (ref 1)': { bands: 6, innerRadius: 0.62, thickness: 0.085, gap: 0.010, legs: 'board', flatten: 0.25,
    colors: ['#F6A9C0', '#F9C9A0', '#FBE9A6', '#B7DFAE', '#A8CDEB', '#C9AEDD'] },
  'Classic on top (ref 2)': { bands: 7, innerRadius: 0.34, thickness: 0.075, gap: 0.006, legs: 'top', flatten: 0,
    colors: ['#EE6D8E', '#F29B54', '#F6D34F', '#7CC576', '#5BA9DE', '#8E7BC4', '#D98BC4'] },
  'Tall pastel (ref 4)': { bands: 6, innerRadius: 0.30, thickness: 0.07, gap: 0.008, legs: 'top', flatten: 0,
    colors: ['#F49AB6', '#F6B98E', '#F7E39A', '#9BD8B0', '#8FC7E8', '#B9A3DC'] },
};

function Cake({ tiers }) {
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
        <cylinderGeometry args={[BOARD_R, BOARD_R, BOARD_H, 64]} />
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
  const set = (k, v) => setP(o => ({ ...o, [k]: v }));

  // The cake the rainbow must fit — recomputed from the tier count, which is the point of the screen.
  const cake = useMemo(() => {
    let top = BOARD_H;
    for (let i = 0; i < tiers; i++) top += BOTTOM_H - i * 0.12;
    return { radius: R, topY: top, boardY: BOARD_H };
  }, [tiers]);

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
          <Cake tiers={tiers} />
          <RainbowArch params={p} cake={cake} />
          <OrbitControls target={[0, cake.topY * 0.6, 0]} enablePan={false} />
        </Canvas>
      </div>

      <div style={s.panel}>
        <h2 style={s.h2}>Rainbow studio</h2>
        <p style={s.note}>
          Generated, not modelled: the legs reach the board, which is a different distance on every
          cake. Change the tier count and watch the legs stretch while the arch stays put — that is
          the whole reason this is not a GLB.
        </p>

        <div style={s.group}>
          <span style={s.groupLbl}>Preset</span>
          {Object.keys(PRESETS).map(k => (
            <button key={k} style={s.chip} onClick={() => setP(o => ({ ...o, ...PRESETS[k] }))}>{k}</button>
          ))}
        </div>

        <div style={s.group}>
          <span style={s.groupLbl}>Cake</span>
          {[1, 2, 3].map(n => (
            <button key={n} onClick={() => setTiers(n)}
              style={{ ...s.chip, ...(tiers === n ? s.chipOn : {}) }}>{n} tier</button>
          ))}
        </div>

        <div style={s.group}>
          <span style={s.groupLbl}>Legs</span>
          {['board', 'top', 'none'].map(v => (
            <button key={v} onClick={() => set('legs', v)}
              style={{ ...s.chip, ...(p.legs === v ? s.chipOn : {}) }}>{v}</button>
          ))}
        </div>

        {num('Bands', 'bands', 3, 9, 1)}
        {num('Inner radius', 'innerRadius', 0.15, 1.2, 0.01)}
        {num('Thickness', 'thickness', 0.03, 0.2, 0.005)}
        {num('Gap', 'gap', 0, 0.06, 0.002)}
        {num('Flatten', 'flatten', 0, 0.9, 0.05)}
        {num('Lean°', 'lean', -25, 25, 1)}

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
