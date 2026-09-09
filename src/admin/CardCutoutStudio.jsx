import { useState, useMemo, useEffect, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { HexColorPicker } from 'react-colorful';
import * as THREE from 'three';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js';
import helvetikerBold from 'three/examples/fonts/helvetiker_bold.typeface.json';
/* The word is cut by CORE's functions, not by a copy living here — the designer will cut the
 * customer's own text with these exact calls, so this preview and the cake cannot drift
 * (INVARIANTS #15). `offsetParts` is the backing layer and was added to core for this. */
import {
  topperShapes, offsetParts, components, backingPlate, SizeDial, SceneLights, SceneEnv,
  TOPPER_FACES, DEFAULT_TOPPER_FACE, loadTopperFace, faceFit,
} from '@spattoo/designer';

/* ── Card cutout topper — PROOF OF CONCEPT ───────────────────────────────────────────────────────
 *
 * The printed-card toppers that come on a stick: a name or a number cut from coloured card, with a
 * SECOND sheet cut slightly larger behind it so a band of another colour follows the letterforms all
 * the way round. The "10" and the "Emily" on the reference cake are both this.
 *
 * ⚠️ THE OFFSET IS THE WHOLE FEATURE. Without it this is a flat coloured letter, which the acrylic
 * topper already does. The band is what makes it read as layered card rather than as printed vinyl,
 * and getting it right means the counters — the hole in a 0, an e, an a — have to shrink by the same
 * amount the outline grows. Grow everything uniformly and the band vanishes exactly where the eye
 * looks for it. That logic lives in core's `offsetParts`, not here.
 *
 * ⚠️ WHAT THIS IS NOT, YET. It does not save an element, so nothing it produces reaches a cake —
 * the root CLAUDE.md is explicit that a studio whose output only exists on screen is a mock-up, not
 * authoring. That is deliberate for a first cut: the shape of the thing has to be right before it is
 * worth deciding which element type carries it and what the customer gets to change. Named here so
 * it is a known gap rather than a forgotten one.
 *
 * Also not here, and wanted if this is kept:
 *   - Rounded corners. The reference "10" is a soft rounded block; `glyphShape.js` already rounds
 *     corners for letter cakes (`cornerR`), and `topperShapes` has no equivalent.
 *   - A third layer. Real ones are often three sheets deep.
 *   - The printed outline drawn ON the face, which is ink rather than geometry.
 */

/* The same cake the acrylic studio previews against — a 6-inch top, 1.6 units of radius — so the
 * millimetres printed here and there mean the same thing. Two studios quoting sizes off two
 * different cakes is how a 30mm topper turns out to be 40mm. */
const CAKE_R = 1.6;
const MM = (6 * 25.4) / (CAKE_R * 2);
const mm = (u) => `${(u * MM).toFixed(0)}mm`;

// How much stick hangs below the word. A cake-pop stick is longer than any topper needs; what
// matters is that there is more of it than anyone will push in, so `bury` is never the thing that
// runs out.
const STICK_LEN = 0.75;

/* What sits behind the word. `outline` follows the letterforms; the rest are PLATES the word is
 * written on — the "4" on an orange disc. A key, not a boolean, so a fourth arrives as a row here
 * and reaches the geometry through `backingPlate`'s family without a branch anywhere. */
const BACKINGS = [
  { key: 'outline', label: 'Outline', hint: 'A second cut of the word, slightly larger.' },
  { key: 'circle',  label: 'Circle',  hint: 'A disc behind it.' },
  { key: 'rect',    label: 'Panel',   hint: 'A rounded rectangle.' },
  { key: 'heart',   label: 'Heart',   hint: 'The cake\'s own heart curve.' },
];

/* ⚠️ A BLOCK FACE, because TOPPER_FACES has none. Every face core offers is a script — right for
 * "Emily", and nothing like the chunky rounded "10" this studio exists to reproduce. helvetiker_bold
 * ships inside three, so it costs no asset and no licence question, and `glyphShape.js` already cuts
 * letter cakes from it.
 *
 * Held locally on purpose while this is a POC. If the studio is kept, this belongs in core's
 * TOPPER_FACES as a ROW — a face is config, and a second place that knows what faces exist is the
 * thing rule 2 is about. */
const BLOCK_KEY = '__block';
const BLOCK_FACE = { label: 'Block', kind: 'outline', fit: 0 };
const FACES = { [BLOCK_KEY]: BLOCK_FACE, ...TOPPER_FACES };
const blockFont = new FontLoader().parse(helvetikerBold);

function useFace(key) {
  const [font, setFont] = useState(() => (key === BLOCK_KEY ? blockFont : null));
  useEffect(() => {
    if (key === BLOCK_KEY) { setFont(blockFont); return; }
    let alive = true;
    loadTopperFace(key).then(f => alive && setFont(f)).catch(() => alive && setFont(null));
    return () => { alive = false; };
  }, [key]);
  return font;
}

// One extruded sheet of card, from a list of {outer, holes} contours.
function sheet(parts, thickness) {
  if (!parts?.length) return null;
  const geos = parts.map((p) => {
    const shape = new THREE.Shape(p.outer.map(q => new THREE.Vector2(q.x, q.y)));
    shape.holes = (p.holes ?? []).map(h => new THREE.Path(h.map(q => new THREE.Vector2(q.x, q.y))));
    return new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  });
  return geos;
}

function Cutout({ font, text, span, backing, faceColour, backColour, offset, thickness, stick, bury, onMeasure }) {
  const build = useMemo(() => {
    if (!font || !text.trim()) return null;
    const probe = topperShapes(font, text, { height: 1 });
    if (!probe.width) return null;
    /* ⚠️ SIZED BY HOW FAR IT REACHES ACROSS THE CAKE, not by a letter height — the same rule the
     * acrylic topper sizes by. Set the LETTERS instead and a long name simply runs off the board,
     * because the width follows from the character count and nothing stops it. So `span` is the
     * control and the letter height is the READOUT: drag until the millimetres say what you want.
     * That is also why the acrylic topper stacks onto two rows — it is the only other way to keep
     * a long phrase legible at a fixed span. */
    const height = (CAKE_R * 2 * span) / probe.width;
    return topperShapes(font, text, { height });
  }, [font, text, span]);

  /* ⚠️ ONE derivation of the backing, used by the meshes, the piece count, the stick's seat and the
   * measurements. It was computed three times from the same inputs and they can only agree by
   * accident once anything about it grows. */
  const backParts = useMemo(() => {
    if (!build?.parts?.length) return [];
    const d = offset * (build.capHeight || build.height || 1);
    if (backing === 'outline') return offsetParts(build.parts, d);
    const plate = backingPlate(build.parts, { family: backing, pad: d });
    return plate ? [plate] : [];
  }, [build, offset, backing]);

  const layers = useMemo(() => {
    if (!build?.parts?.length) return null;
    const face = build.parts;
    /* ⚠️ Offset in the WORD's units, not in scene units. `offset` is a fraction of the cap height,
     * so the band stays visually the same on a short "10" and a long "Emily" — an absolute distance
     * looks like a hairline on one and a slab on the other, and the baker would have to re-tune it
     * for every word. */
    return { face: sheet(face, thickness), back: sheet(backParts, thickness) };
  }, [build, backParts, thickness]);

  useEffect(() => () => {
    layers?.face?.forEach(g => g.dispose());
    layers?.back?.forEach(g => g.dispose());
  }, [layers]);

  /* ⚠️ HOW MANY SEPARATE BITS OF CARD THIS IS, which decides whether it can be made at all.
   *
   * A block face's letters do not touch. "Sandeep" in Poppins is SEVEN loose pieces, and the thing
   * that joins them is the backing sheet — grow the offset until the outlines meet and it becomes
   * one cuttable shape. Measured: Lilita One joins at 0.05 and Poppins not until 0.19, against a
   * default of 0.09. So at the default, one of those faces produces a topper and the other produces
   * a bag of letters, and NOTHING ON SCREEN WOULD SAY SO — both render identically from the front.
   *
   * The acrylic studio counts its pieces for exactly this reason. Counted on the BACKING, because
   * that is the sheet that has to hold together; the face can be as loose as it likes. */
  const measured = useMemo(() => {
    if (!build?.parts?.length || !backParts.length) return { pieces: 0, letter: 0, across: 0 };
    let lox = Infinity, hix = -Infinity, loy = Infinity, hiy = -Infinity;
    for (const p of backParts) for (const q of p.outer) {
      if (q.x < lox) lox = q.x; if (q.x > hix) hix = q.x;
      if (q.y < loy) loy = q.y; if (q.y > hiy) hiy = q.y;
    }
    return {
      // Measured off the built backing rather than predicted: on a plate the word's cap height is
      // no longer what a ruler reads across the finished topper.
      pieces: components(backParts).length,
      letter: build.capHeight || 0,
      across: hix - lox,
      tall: hiy - loy,
    };
  }, [build, backParts]);

  useEffect(() => { onMeasure?.(measured); }, [measured, onMeasure]);
  const pieces = measured.pieces;

  if (!layers) return null;

  /* Measured off the BACKING, which is the biggest sheet — the stick has to disappear behind what
   * is actually there, and the backing hangs lower than the face by the offset. */
  let lo = Infinity, hi = -Infinity;
  for (const p of backParts) for (const q of p.outer) { if (q.y < lo) lo = q.y; if (q.y > hi) hi = q.y; }
  const wordH = Math.max(1e-3, hi - lo);

  /* ⚠️ SEATED BY THE BOTTOM OF THE STICK, not by the word. `bury` is how deep the stick goes into
   * the icing, so the thing that must land at the surface is the stick's END — the word then rides
   * wherever that leaves it, which is exactly what happens when a baker pushes one in. Positioning
   * the word and letting the stick dangle would make "into the cake" change nothing you can see.
   *
   * With the stick off there is nothing to insert, so the card simply rests on the surface. */
  const groupY = stick ? STICK_LEN - lo - Math.min(bury, STICK_LEN) : -lo;

  return (
    <group position={[0, groupY, 0]}>
      {/* The backing sits BEHIND the face by exactly one card thickness — they are two sheets glued
          together, not one sheet with a painted border, and at a glancing angle the step between
          them is visible. That step is what stops it reading as a sticker. */}
      {layers.back.map((g, i) => (
        <mesh key={`b${i}`} geometry={g} position={[0, 0, -thickness]}>
          <meshStandardMaterial color={backColour} roughness={0.88} metalness={0} />
        </mesh>
      ))}
      {layers.face.map((g, i) => (
        <mesh key={`f${i}`} geometry={g}>
          {/* ⚠️ NO CLEARCOAT, and that is a correctness decision rather than a taste one.
              A clearcoat is a glossy coat: it lives on the environment map, which is the one thing
              this studio cannot yet match to production, and it adds light rather than multiplying
              it — so no albedo correction can ever divide it back out. The chocolate drip stops at
              grey 152 for precisely this reason and the garnish escapes by zeroing its coat
              (albedoForLight.js, INVARIANTS #16). Printed card is matte anyway: SCENE_ENV notes that
              matte finishes ignore IBL, so without the coat this element is largely immune to the
              environment question AND exactly correctable once its reference light is measured. */}
          <meshStandardMaterial color={faceColour} roughness={0.86} metalness={0} />
        </mesh>
      ))}
      {stick && (() => {
        /* ⚠️ TUCKED UP BEHIND THE WORD, AND BEHIND BOTH SHEETS. A stick that stops at the baseline
         * hangs off the bottom of the letters with daylight between them — which is what this did,
         * and it reads as a word floating above a rod rather than as a topper.
         *
         * A real one is taped to the BACK and runs a good way up behind the letterforms; you never
         * see the join because the card hides it. So it sits at negative z, past the backing sheet,
         * and reaches up to `TUCK` of the word's height. The overlap is the attachment: nothing is
         * glued in the geometry, it is simply hidden.
         *
         * Off the widest letter's midline rather than the whole word's, so on a word with a
         * descender the stick still meets solid card instead of the gap under a 'p'. */
        const TUCK = 0.55;
        const r = 0.018;
        const top = lo + wordH * TUCK;
        const len = wordH * TUCK + STICK_LEN;              // the part that shows, plus the tuck
        return (
          <mesh position={[0, top - len / 2, -(thickness + r)]} rotation={[0, 0, 0]}>
            <cylinderGeometry args={[r, r, len, 14]} />
            <meshStandardMaterial color="#D8BE93" roughness={0.85} />
          </mesh>
        );
      })()}
    </group>
  );
}

function Slider({ label, value, min, max, step, onChange, hint }) {
  return (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#3D5A44' }}>{label}</span>
        <span style={{ fontSize: 12, color: '#6B7C70', fontVariantNumeric: 'tabular-nums' }}>
          {step >= 1 ? value : Number(value).toFixed(3)}
        </span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#3D5A44' }} />
      {hint && <span style={{ fontSize: 11, color: '#8A9A8E', lineHeight: 1.35 }}>{hint}</span>}
    </label>
  );
}

/* A row of exclusive choices, styled like this panel's other buttons.
 *
 * ⚠️ Not core's `Chip`, and not for want of looking. Chip IS the shared toggleable pill and the root
 * CLAUDE.md is right that people rebuild it — but it is the CUSTOMER's control, it is not exported
 * from core's index, and its tone sits against the designer's surfaces rather than this panel's. The
 * honest options were "export a customer control and use it somewhere it does not match" or "match
 * the buttons already in this file". If admin ever needs this a third time, extract it here rather
 * than reaching across for that one.
 */
function Pick({ items, value, onChange }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 7 }}>
      {items.map((it) => {
        const on = it.key === value;
        return (
          <button key={it.key} type="button" onClick={() => onChange(it.key)}
            aria-pressed={on} title={it.hint}
            style={{
              minHeight: 44, borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 12.5, fontWeight: 800,
              border: on ? '1.5px solid #3D5A44' : '1.5px solid #E2E8E3',
              background: on ? '#3D5A44' : '#fff',
              color: on ? '#fff' : '#3D5A44',
            }}>
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

function Swatch({ label, value, onChange, open, onToggle }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <button type="button" onClick={onToggle}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, minHeight: 44,
          padding: '0 11px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
          border: '1.5px solid #E2E8E3', background: '#fff' }}>
        <span style={{ width: 20, height: 20, borderRadius: 5, background: value,
          border: '1px solid rgba(0,0,0,0.12)' }} />
        <span style={{ fontSize: 12.5, fontWeight: 700, color: '#3D5A44' }}>{label}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: '#8A9A8E' }}>{value}</span>
      </button>
      {/* The wheel opens UNDER the swatch that owns it, so the colour and the control that sets it
          are on screen together (INVARIANTS #11). */}
      {open && <HexColorPicker color={value} onChange={onChange} style={{ width: '100%', height: 140, marginTop: 8 }} />}
    </div>
  );
}

export default function CardCutoutStudio() {
  const [text, setText] = useState('10');
  const [faceKey, setFaceKey] = useState(BLOCK_KEY);
  const [faceColour, setFaceColour] = useState('#F2AEC4');
  const [backColour, setBackColour] = useState('#FFFFFF');
  const [offset, setOffset] = useState(0.09);
  const [thickness, setThickness] = useState(0.018);
  const [stick, setStick] = useState(true);
  const [wheel, setWheel] = useState(null);
  const [span, setSpan] = useState(0.62);
  const [bury, setBury] = useState(0.22);
  const [backing, setBacking] = useState('outline');
  const [m, setM] = useState({ pieces: 0, letter: 0, across: 0 });
  const pieces = m.pieces;

  const font = useFace(faceKey);

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', overflow: 'hidden' }}>
      <div style={{ flex: '0 0 320px', overflowY: 'auto', padding: 18,
        borderRight: '1px solid #E8EFE9', background: '#fff' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 19, color: '#2C3E33' }}>Card cutout</h1>
        <p style={{ margin: '0 0 16px', fontSize: 12, lineHeight: 1.5, color: '#6B7C70' }}>
          A name or number cut from card, with a second sheet behind it in another colour.
          Proof of concept — it does not save an element yet.
        </p>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <span style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#3D5A44', marginBottom: 5 }}>
            Word or number
          </span>
          <input value={text} onChange={e => setText(e.target.value)} placeholder="10"
            style={{ width: '100%', boxSizing: 'border-box', padding: '10px 11px', borderRadius: 9,
              border: '1.5px solid #E2E8E3', fontFamily: 'inherit', fontSize: 14 }} />
        </label>

        {/* ⚠️ SizeDial, not another slider. The root CLAUDE.md names it as THE size control, and
            the acrylic topper — the closest thing to this screen — already sizes with it. A second
            way to set a size is how two topper studios start disagreeing about what 30mm means.
            The millimetres sit right under it, because "font size" is a number a baker has in mind
            and the span is only the way to reach it. */}
        <div style={{ marginBottom: 14 }}>
          <span style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#3D5A44', marginBottom: 6 }}>
            Size
          </span>
          {/* Capped at the cake's own width. Past 1.0 the FACE is already wider than the cake it
              sits on, and the backing overhangs further still — measured, "10" at 1.15 came out
              198mm across a 152mm cake. The readout would have said so, but a slider should not
              travel into territory that is always wrong. */}
          <SizeDial size={span} min={0.25} max={1.0} step={0.01} onChange={setSpan} />
          <span style={{ display: 'block', marginTop: 6, fontSize: 11.5, color: '#6B7C70' }}>
            letters <strong style={{ color: '#3D5A44' }}>{mm(m.letter)}</strong>
            {' · '}{mm(m.across)} across, on a 6in cake
          </span>
        </div>

        <label style={{ display: 'block', marginBottom: 14 }}>
          <span style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#3D5A44', marginBottom: 5 }}>
            Face
          </span>
          <select value={faceKey} onChange={e => setFaceKey(e.target.value)}
            style={{ width: '100%', padding: '9px 10px', borderRadius: 9, fontFamily: 'inherit',
              fontSize: 13, border: '1.5px solid #E2E8E3', background: '#fff' }}>
            {Object.entries(FACES).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
          </select>
        </label>

        <div style={{ marginBottom: 14 }}>
          <span style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#3D5A44', marginBottom: 5 }}>
            Behind
          </span>
          <Pick items={BACKINGS} value={backing} onChange={setBacking} />
        </div>

        <Swatch label="Card" value={faceColour} onChange={setFaceColour}
          open={wheel === 'face'} onToggle={() => setWheel(wheel === 'face' ? null : 'face')} />
        <Swatch label="Offset" value={backColour} onChange={setBackColour}
          open={wheel === 'back'} onToggle={() => setWheel(wheel === 'back' ? null : 'back')} />

        {/* ⚠️ One control, two readings, and the label follows. On an outline it is how far the
            second cut sticks out past the letters; on a plate it is the margin between the word and
            the edge of the disc. Both are "how much backing shows", which is why it is not two
            sliders — but calling it "offset" while it sets a margin would be a label describing the
            implementation rather than the thing (INVARIANTS #12). */}
        <Slider label={backing === 'outline' ? 'Offset width' : 'Margin'}
          value={offset} min={0} max={0.4} step={0.005} onChange={setOffset}
          hint={backing === 'outline'
            ? 'How far the sheet behind sticks out. Zero is a single layer.'
            : 'Room between the word and the edge of the shape.'} />

        {/* Beside the control that fixes it, not in a corner: the offset is the only thing that
            changes this number (INVARIANTS #11). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14,
          padding: '9px 11px', borderRadius: 9,
          background: pieces === 1 ? '#EEF4EF' : '#FDF3E7',
          border: `1px solid ${pieces === 1 ? '#CFE0D4' : '#F0DCC0'}` }}>
          <span style={{ fontSize: 12, fontWeight: 800, color: pieces === 1 ? '#3D5A44' : '#8A6320' }}>
            {pieces === 1 ? 'One piece' : `${pieces} separate pieces`}
          </span>
          {/* ⚠️ Two remedies, not one. Widening always joins them eventually, but on a widely-spaced
              face it joins them into a SLAB — Poppins needs 0.19 and by then the backing is a blob
              with the letters sunk in it. Sometimes the answer is a different face, and the panel
              should not send the baker down the one road that ruins it. */}
          {pieces > 1 && (
            <span style={{ fontSize: 11, color: '#8A6320', lineHeight: 1.35 }}>
              — widen the offset until the backing joins them, or pick a face whose letters sit closer.
            </span>
          )}
        </div>
        <Slider label="Card thickness" value={thickness} min={0.004} max={0.06} step={0.002} onChange={setThickness}
          hint="Real cardstock is thin — the step between the two sheets is what you are setting." />

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, fontSize: 12.5,
          fontWeight: 700, color: '#3D5A44', cursor: 'pointer' }}>
          <input type="checkbox" checked={stick} onChange={e => setStick(e.target.checked)} />
          Stick
        </label>

        {/* Only when there is a stick to push in. A depth control beside a topper with nothing to
            insert is a control that cannot do anything, which reads as broken rather than as
            inapplicable. The acrylic topper hides its `buried` the same way when it has no legs. */}
        {stick && (
          <Slider label="Into the cake" value={bury} min={0} max={STICK_LEN} step={0.005}
            onChange={setBury}
            hint={`${mm(bury)} of the stick goes in — ${mm(STICK_LEN - bury)} of it still showing.`} />
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0, position: 'relative', background: '#F2EFE9' }}>
        <Canvas camera={{ position: [0, 0.75, 3.2], fov: 38 }} style={{ position: 'absolute', inset: 0 }}>
          {/* ⚠️ THE DESIGNER'S OWN RIG, not a hand-rolled one. This studio lit itself with ambient
              0.72 and two directionals against production's 0.45 / 1.1 / 0.4 and an environment map
              — sixty percent more fill and no IBL at all — so every colour judged here was judged
              under a light no cake has ever had. The Cloud, Grass and Relief Sticker studios already
              mount these two for the same reason.
              ⚠️ It is still not the customer's scene: admin never calls `configureEnvMap`, so
              SceneEnv falls back to drei's INDOOR apartment preset while every deployed cake uses
              the self-hosted OUTDOOR map. envProps warns about it in the console. Matching the LAMPS
              is worth having on its own; matching the environment is a separate, wider fix. */}
          <SceneLights />
          <SceneEnv />
          <OrbitControls enablePan={false} makeDefault target={[0, 0.45, 0]} />
          {/* ⚠️ THE CAKE, and it is not scenery. "How far into the cake" is a number with no visible
              effect unless the surface it goes into is on screen — you would be setting a depth
              against empty space and judging it by the label (INVARIANTS #11). It also shows the
              thing that actually matters: how much stick is still showing above the icing. */}
          <mesh position={[0, -0.36, 0]} receiveShadow>
            <cylinderGeometry args={[CAKE_R, CAKE_R, 0.72, 72]} />
            <meshStandardMaterial color="#FAF5EE" roughness={0.92} />
          </mesh>
          <Cutout font={font} text={text} span={span} faceColour={faceColour} backColour={backColour}
            backing={backing} offset={offset} thickness={thickness} stick={stick} bury={bury}
            onMeasure={setM} />
        </Canvas>
      </div>
    </div>
  );
}
