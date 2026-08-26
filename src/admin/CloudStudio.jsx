import React, { useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
// The SAME generator the designer renders, never a divergent copy — the rule ChocolateDripStudio
// states and RainbowStudio repeats. SceneLights/SceneEnv are the designer's own rig for the same
// reason: a colour judged under brighter lights is simply the wrong colour.
import { FondantCloud, cloudPlacement, cloudGuide, CLOUD_DEFAULTS, SceneLights, SceneEnv } from '@spattoo/designer';
import { useElementSave } from '../lib/useElementSave.js';

// ── Cloud studio ──────────────────────────────────────────────────────────────
// Fondant clouds. Its own element and its own screen, NOT a checkbox on the rainbow — clouds turn up
// without rainbows (sky, unicorn, aeroplane), several at a time, on the top and the sides and the
// board. A cloud buried inside the rainbow could not be priced, counted, placed twice, or carry its
// own craft guide, and a baker rolling clouds for a plain sky cake would never see that guide.
//
// The two arrive together via a `decor_pattern` instead: "Rainbow with clouds" is a parts list, not
// a merged element, and Ungroup already exists for the customer who wants one without the other.
//
// ── WHY IT IS GENERATED AND NOT A GLB ───────────────────────────────────────────
// The WALL. A modelled plaque laid against a round tier touches in the middle and floats at its
// ends — what festoon.js bends imported strips to avoid — and no scale factor fixes a curve. It also
// passes the test grass.js sets for when procedural work is safe: it fails on subjects with "a
// precise familiar signature the eye can check", and a cloud is a handful of lumps. There is no
// proportion to get wrong.
//
// ── TWO VARIANTS, FROM TWO REFERENCES ───────────────────────────────────────────
// They are different objects, not one at two sizes:
//   PUFF — balls rolled and pressed together. SEPARATE lumps at different depths, so the cluster
//          self-shadows and reads as a bunch. The seams between balls are the point, and its
//          underside is scalloped because that is what balls set down on a surface look like.
//   FLAT — ONE piece, rolled out and cut: the outline is traced round the whole cluster and extruded
//          once, bevelled. No seams anywhere, and a soft lip all the way round the edge.
//
// The flat one was overlapping discs on a box slab first, and it read as cut paper — every pair of
// discs left a visible circle where they met and the slab left a knife edge across the front.
//
// WHAT TO JUDGE, in the order most likely to be wrong:
//   1. Does the puff read as several balls pressed together, or as one blobby potato? `Variation`,
//      `Lumps` and `Depth` are the three controls that decide it.
//   2. Does the flat one read as ROLLED fondant or as cut paper? The bevel is the whole of that —
//      it is the only thing catching a highlight along the cut edge.
//   3. The grain. It repeated once across a whole ball in the first cut, which turned sugar into
//      embossed fabric; it is built from the CIRCUMFERENCE now. It should be barely visible.
//   4. On the wall: does it HUG? The flat sheet is bent whole, so its ends should curve away rather
//      than lift off.
//   5. Next to the rainbow. They share the fondant grain on purpose; a cloud that is subtly smoother
//      reads as a different material and the pair falls apart.
//
// Nothing here saves to the catalogue yet — deliberately, the same order the rainbow follows: the
// look is judged before an element type, an admin form and a designer control get built around it.

// Mirrors the designer's own bottom tier so every ratio is judged against the real thing.
const R = 1.2, TIER_H = 1.45, BOARD_H = 0.1, BOARD_R = 1.6;

// Each preset is a whole cloud, transcribed from a reference rather than derived — the same call the
// rainbow's arrangements make. A tile that sets one number and leaves the rest is a tile that shows
// the previous cloud with a tweak.
const PRESETS = [
  // Both transcribed off the sun-and-rainbow cake: a small nearly-round bunch at the front of the
  // board, and a wider, flatter one up beside the sun.
  { key: 'puff-board', label: 'Puffy, on the board',
    p: { variant: 'puff', surface: 'board', width: 0.34, height: 0.24, lobes: 3, rows: 2,
         variation: 0.22, taper: 0.2, puffDepth: 0.24, offsetX: -0.35, scale: 1 } },
  { key: 'puff-top', label: 'Puffy, on the top',
    p: { variant: 'puff', surface: 'top', width: 0.52, height: 0.28, lobes: 4, rows: 2,
         variation: 0.25, taper: 0.2, puffDepth: 0.26, offsetX: 0.2, standoff: 0.3, scale: 1 } },
  { key: 'flat-wall', label: 'Cut-out, on the wall',
    p: { variant: 'flat', surface: 'side', width: 0.55, height: 0.24, lobes: 4, rows: 1,
         variation: 0.3, taper: 0.45, depth: 0.08, theta: -0.5, offsetX: 0, scale: 1 } },
  { key: 'flat-board', label: 'Cut-out, on the board',
    p: { variant: 'flat', surface: 'board', width: 0.60, height: 0.26, lobes: 5, rows: 1,
         variation: 0.3, taper: 0.45, depth: 0.08, offsetX: 0.4, scale: 1 } },
];

function VariantTile({ item, on, onPick }) {
  const flat = item.p.variant === 'flat';
  return (
    <button type="button" onClick={onPick} title={item.label}
      style={{ ...s.tile, ...(on ? s.tileOn : {}) }}>
      <svg viewBox="0 0 44 30" style={{ width: 52, height: 36 }}>
        <rect x="2" y="25" width="40" height="3" rx="1" fill="#EDE7DA" />
        {/* The tile shows the DIFFERENCE and nothing else. The puff keeps its seams and its
            scalloped underside; the cut piece is one outline with a straight bottom. */}
        {flat ? (
          <path d="M8 25 L8 20 A6 6 0 0 1 19 15 A8 8 0 0 1 33 19 A5 5 0 0 1 36 25 Z"
                fill={on ? '#2C4433' : '#C7C0B4'} />
        ) : (
          // A bunch: a bottom row with the next row nestled into its gaps.
          <g fill={on ? '#2C4433' : '#C7C0B4'} stroke="#fff" strokeWidth="0.7">
            <circle cx="14" cy="20" r="5" />
            <circle cx="22" cy="20" r="5" />
            <circle cx="30" cy="20" r="5" />
            <circle cx="18" cy="14" r="5" />
            <circle cx="26" cy="14" r="5" />
          </g>
        )}
      </svg>
      <span style={s.tileLbl}>{item.label}</span>
    </button>
  );
}

function Cake({ tiers }) {
  const geo = useMemo(() => {
    const g = [];
    let y = BOARD_H;
    for (let i = 0; i < tiers; i++) {
      const h = TIER_H - i * 0.12;
      g.push({ r: R - i * 0.28, h, y });
      y += h;
    }
    return g;
  }, [tiers]);
  return (
    <group>
      <mesh position={[0, BOARD_H / 2, 0]} receiveShadow>
        <cylinderGeometry args={[BOARD_R, BOARD_R, BOARD_H, 64]} />
        <meshStandardMaterial color="#EDE7DA" roughness={0.85} />
      </mesh>
      {geo.map((t, i) => (
        <mesh key={i} position={[0, t.y + t.h / 2, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[t.r, t.r, t.h, 64]} />
          <meshStandardMaterial color="#FBF8F3" roughness={0.75} />
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
export default function CloudStudio() {
  const [p, setP] = useState({ ...CLOUD_DEFAULTS, ...PRESETS[0].p });
  const [tiers, setTiers] = useState(1);
  const [fondant, setFondant] = useState(true);
  const [count, setCount] = useState(1);
  const canvasWrapRef = useRef(null);
  const [thumbView, setThumbView] = useState(false);

  const cake = useMemo(() => {
    let top = BOARD_H;
    for (let i = 0; i < tiers; i++) top += TIER_H - i * 0.12;
    return { radius: R, topY: top, boardY: BOARD_H };
  }, [tiers]);


  // Where the cloud actually IS, and how big — so the thumbnail can frame the object rather than the
  // corner of a cake it happens to be standing on. Placement is not saved on the row, so a tile
  // showing one is describing something the customer will never get.
  const shot = useMemo(() => {
    const { lobes } = cloudPlacement(p, cake);
    if (!lobes.length) return { centre: [0, 0.4, 0], dist: 2 };
    const xs = lobes.map(l => l.position.x), ys = lobes.map(l => l.position.y), zs = lobes.map(l => l.position.z);
    const c = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2,
               (Math.min(...zs) + Math.max(...zs)) / 2];
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys),
                          ...lobes.map(l => l.r * 2));
    // A little over twice the span: enough that the fondant grain still reads, close enough that the
    // cloud fills a 60px tile instead of sitting in the middle of one.
    return { centre: c, dist: Math.max(0.8, span * 2.2) };
  }, [p, cake]);
  const guide = useMemo(() => cloudGuide(p, cake), [p, cake]);

  // The same hook every procedural studio uses — create once, update thereafter, and the address
  // remembers which row this is so a reload does not quietly author a second one.
  //
  // The type is `fondant_decor`, shared with the rainbow (migration 073). One type per generated
  // shape was the first instinct and the wrong one: a type is how a thing BEHAVES, and a cloud and a
  // rainbow behave identically — same three surfaces, same `stand`, both movable, neither uploaded.
  // Which generator draws it is `placement_config.procedural`; what it depicts is its category.
  const { editing, saveName, setSaveName, busy, msg, save, startNew } = useElementSave({
    typeSlug: 'fondant_decor',
    categorySlug: 'sky',   // where a customer browses to find it (migration 074)
    canvasRef: canvasWrapRef,
    // The SHAPE, and only the shape. Where it sits — surface, yaw, standoff, theta — is the
    // customer's decision on their own cake, and freezing it here would author a cloud that can only
    // ever stand in one place.
    buildPayload: () => ({
      allowed_zones: ['top_surface', 'side', 'board'],
      default_color: p.color,
      placement_config: {
        procedural: 'cloud',
        cloud: {
          variant: p.variant,
          width: +Number(p.width).toFixed(3),
          height: +Number(p.height).toFixed(3),
          lobes: p.lobes,
          rows: p.rows,
          variation: +Number(p.variation).toFixed(3),
          taper: +Number(p.taper).toFixed(3),
          puffDepth: +Number(p.puffDepth).toFixed(3),
          depth: +Number(p.depth).toFixed(3),
          bevel: +Number(p.bevel).toFixed(3),
          scale: +Number(p.scale).toFixed(3),
          color: p.color,
        },
      },
    }),
    onHydrate: (el) => setP(o => ({ ...o, ...(el.placement_config?.cloud ?? {}) })),
  });

  // Several clouds at once, which is how they actually turn up — one is not the question. Spread
  // round the cake rather than stacked, so the copies do not hide each other.
  const copies = useMemo(() => Array.from({ length: count }, (_, i) => {
    if (i === 0) return p;
    const step = i * 1.15;
    return p.surface === 'side'
      ? { ...p, theta: (p.theta ?? 0) + step, scale: (p.scale ?? 1) * (i % 2 ? 0.8 : 1.05) }
      : { ...p, offsetX: (p.offsetX ?? 0) + (i % 2 ? step * 0.5 : -step * 0.5),
          scale: (p.scale ?? 1) * (i % 2 ? 0.8 : 1.05) };
  }), [p, count]);

  const num = (label, key, min, max, step) => (
    <div style={s.row}>
      <span style={s.lbl}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={p[key] ?? 0} style={{ flex: 1 }}
        onChange={e => setP(o => ({ ...o, [key]: parseFloat(e.target.value) }))} />
      <span style={s.val}>{(p[key] ?? 0).toFixed(step < 0.01 ? 3 : 2)}</span>
    </div>
  );

  return (
    <div style={s.wrap}>
      <div style={s.stage} ref={canvasWrapRef}>
        {/* preserveDrawingBuffer, or the saved thumbnail is a BLANK png: WebGL clears the drawing
            buffer after compositing, so canvas.toBlob() reads an empty one. The capture succeeds,
            uploads, and stores nothing. */}
        {/* Keyed on the view, because a Canvas takes its camera on mount only — remounting is the
            honest way to move it, and a studio can afford it. */}
        <Canvas key={thumbView ? 'thumb' : 'scene'} shadows
          camera={thumbView
            ? { position: [shot.centre[0], shot.centre[1] + shot.dist * 0.25, shot.centre[2] + shot.dist], fov: 38 }
            : { position: [0, 2.0, 6.4], fov: 38 }}
          gl={{ antialias: true, preserveDrawingBuffer: true }}>
          <color attach="background" args={[thumbView ? '#BFD8EA' : '#eceaf3']} />
          <SceneLights />
          <SceneEnv />
          {!thumbView && <Cake tiers={tiers} />}
          {copies.map((c, i) => <FondantCloud key={i} params={c} cake={cake} fondant={fondant} />)}
          <OrbitControls target={thumbView ? shot.centre : [0, cake.topY * 0.5, 0]} enablePan={false} />
        </Canvas>
      </div>

      <div style={s.panel}>
        <h2 style={s.h2}>Cloud</h2>
        <p style={s.note}>
          Its own element, not a checkbox on the rainbow: clouds turn up without one, several at a
          time, on the top and the sides and the board. The pair arrives together as a pattern
          instead.
        </p>

        <div style={s.group}>
          <span style={s.groupLbl}>Cake</span>
          {[1, 2].map(n => (
            <button key={n} onClick={() => setTiers(n)}
              style={{ ...s.chip, ...(tiers === n ? s.chipOn : {}) }}>{n} tier</button>
          ))}
          <span style={s.groupLbl}>Grain</span>
          {[['fondant', true], ['plain', false]].map(([l, v]) => (
            <button key={l} onClick={() => setFondant(v)}
              style={{ ...s.chip, ...(fondant === v ? s.chipOn : {}) }}>{l}</button>
          ))}
        </div>

        <div style={s.group}>
          <span style={s.groupLbl}>Kind</span>
          {PRESETS.map(item => (
            <VariantTile key={item.key} item={item}
              on={p.variant === item.p.variant && p.surface === item.p.surface}
              onPick={() => setP(o => ({ ...o, ...item.p }))} />
          ))}
        </div>

        <div style={s.group}>
          <span style={s.groupLbl}>How many</span>
          {[1, 2, 3, 5].map(n => (
            <button key={n} onClick={() => setCount(n)}
              style={{ ...s.chip, ...(count === n ? s.chipOn : {}) }}>{n}</button>
          ))}
        </div>


        {num('Size', 'scale', 0.3, 2.2, 0.05)}
        {num('Width', 'width', 0.2, 1.2, 0.02)}
        {num('Height', 'height', 0.08, 0.7, 0.02)}
        {num('Balls across', 'lobes', 2, 8, 1)}
        {p.variant === 'puff' && num('Rows', 'rows', 1, 3, 1)}
        {num('Taper', 'taper', 0, 0.8, 0.05)}
        {num('Variation', 'variation', 0, 1, 0.05)}
        {p.variant === 'flat' && num('Thickness', 'depth', 0.02, 0.25, 0.01)}
        {p.variant === 'flat' && num('Soft edge', 'bevel', 0, 0.9, 0.05)}
        {p.variant === 'puff' && num('Depth', 'puffDepth', 0.05, 0.7, 0.02)}
        {num('Position', 'offsetX', -1.2, 1.2, 0.02)}
        {p.surface === 'top' && num('Stands back', 'standoff', -1, 1, 0.05)}
        {p.surface === 'side' && num('Round the cake', 'theta', -3.14, 3.14, 0.05)}

        <div style={s.group}>
          <span style={s.groupLbl}>Colour</span>
          <input type="color" value={p.color} style={s.swatch}
            onChange={e => setP(o => ({ ...o, color: e.target.value }))} />
        </div>

        {/* Ratios, never millimetres: the baker bakes the cake they bake, and a millimetre is a
            promise about a cake nobody has seen. Same rule the rainbow's guide follows. */}
        <div style={s.guide}>
          <span style={s.groupLbl}>What the baker rolls</span>
          <div style={s.guideRow}>
            <span>{guide.balls} balls, biggest first</span>
            <span style={s.guideVal}>{guide.widthOfCakeWidth}× the cake's width</span>
          </div>
          {guide.ballsOfCakeWidth.map((b, i) => (
            <div key={i} style={s.guideRow}>
              <span style={{ ...s.dot, background: p.color, border: '1px solid #D9D5CE' }} />
              <span>ball {i + 1}</span>
              <span style={s.guideVal}>{b}× the cake's width</span>
            </div>
          ))}
        </div>

        {/* Save. The look has been judged, so the row is what makes it a real catalogue element:
            searchable, taggable, tunable without a deploy. */}
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
            placeholder="e.g. Small puffy cloud" style={s.saveInput} />
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
            The row carries the SHAPE — which kind, how many balls, how big. Not where it sits: that
            is the customer's decision on their own cake.
          </p>
        </div>

        <pre style={s.json}>{JSON.stringify(p, null, 1)}</pre>
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
  swatch:{ width: 30, height: 26, border: '1px solid #D9D5CE', borderRadius: 6, padding: 0, cursor: 'pointer' },
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
  json:  { fontSize: 11, background: '#F7F6F2', padding: 10, borderRadius: 8, overflowX: 'auto', marginTop: 12 },
};
