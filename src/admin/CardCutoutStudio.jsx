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
  topperShapes, offsetParts, components,
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

const CAKE_R = 1.0;

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

function Cutout({ font, text, faceColour, backColour, offset, thickness, stick, onPieces }) {
  const build = useMemo(() => {
    if (!font || !text.trim()) return null;
    const probe = topperShapes(font, text, { height: 1, tracking: faceFit(BLOCK_KEY) });
    if (!probe.width) return null;
    // Sized by how far it reaches ACROSS the cake, the same rule the acrylic topper sizes by, so a
    // long name shrinks instead of running off the board.
    const height = (CAKE_R * 1.5) / probe.width;
    return topperShapes(font, text, { height, tracking: 0 });
  }, [font, text]);

  const layers = useMemo(() => {
    if (!build?.parts?.length) return null;
    const face = build.parts;
    /* ⚠️ Offset in the WORD's units, not in scene units. `offset` is a fraction of the cap height,
     * so the band stays visually the same on a short "10" and a long "Emily" — an absolute distance
     * looks like a hairline on one and a slab on the other, and the baker would have to re-tune it
     * for every word. */
    const d = offset * (build.capHeight || build.height || 1);
    return { face: sheet(face, thickness), back: sheet(offsetParts(face, d), thickness) };
  }, [build, offset, thickness]);

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
  const pieces = useMemo(() => {
    if (!build?.parts?.length) return 0;
    const d = offset * (build.capHeight || build.height || 1);
    return components(offsetParts(build.parts, d)).length;
  }, [build, offset]);

  useEffect(() => { onPieces?.(pieces); }, [pieces, onPieces]);

  if (!layers) return null;

  /* Measured off the BACKING, which is the biggest sheet — the stick has to disappear behind what
   * is actually there, and the backing hangs lower than the face by the offset. */
  const d = offset * (build.capHeight || build.height || 1);
  const back = offsetParts(build.parts, d);
  let lo = Infinity, hi = -Infinity;
  for (const p of back) for (const q of p.outer) { if (q.y < lo) lo = q.y; if (q.y > hi) hi = q.y; }
  const wordH = Math.max(1e-3, hi - lo);

  return (
    <group>
      {/* The backing sits BEHIND the face by exactly one card thickness — they are two sheets glued
          together, not one sheet with a painted border, and at a glancing angle the step between
          them is visible. That step is what stops it reading as a sticker. */}
      {layers.back.map((g, i) => (
        <mesh key={`b${i}`} geometry={g} position={[0, 0, -thickness]}>
          <meshPhysicalMaterial color={backColour} roughness={0.82} metalness={0}
            clearcoat={0.10} clearcoatRoughness={0.75} />
        </mesh>
      ))}
      {layers.face.map((g, i) => (
        <mesh key={`f${i}`} geometry={g}>
          {/* Printed cardstock: matte, with just enough sheen that the light finds the edge. Not a
              plastic clearcoat — that is the acrylic topper, and this is paper. */}
          <meshPhysicalMaterial color={faceColour} roughness={0.78} metalness={0}
            clearcoat={0.14} clearcoatRoughness={0.68} />
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
        const len = wordH * TUCK + 0.75;              // the part that shows, plus the tuck
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
  const [pieces, setPieces] = useState(0);

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

        <Swatch label="Card" value={faceColour} onChange={setFaceColour}
          open={wheel === 'face'} onToggle={() => setWheel(wheel === 'face' ? null : 'face')} />
        <Swatch label="Offset" value={backColour} onChange={setBackColour}
          open={wheel === 'back'} onToggle={() => setWheel(wheel === 'back' ? null : 'back')} />

        <Slider label="Offset width" value={offset} min={0} max={0.4} step={0.005} onChange={setOffset}
          hint="How far the sheet behind sticks out. Zero is a single layer." />

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
      </div>

      <div style={{ flex: 1, minWidth: 0, position: 'relative', background: '#F2EFE9' }}>
        <Canvas camera={{ position: [0, 0.1, 2.6], fov: 38 }} style={{ position: 'absolute', inset: 0 }}>
          {/* Plain lights, no `<Environment preset>`: that fetches a 1.4MB HDR from a public CDN and
              suspends the whole scene while it does, and printed card is matte — there is nothing
              here for an environment map to reflect. */}
          <ambientLight intensity={0.72} />
          <directionalLight position={[2.5, 3.5, 4]} intensity={1.05} />
          <directionalLight position={[-3, 1, 2]} intensity={0.35} />
          <OrbitControls enablePan={false} makeDefault />
          <Cutout font={font} text={text} faceColour={faceColour} backColour={backColour}
            offset={offset} thickness={thickness} stick={stick} onPieces={setPieces} />
        </Canvas>
      </div>
    </div>
  );
}
