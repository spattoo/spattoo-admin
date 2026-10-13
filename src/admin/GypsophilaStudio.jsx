import { useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import {
  GypCloud, buildGypSprig, GYP_DEFAULTS, GYP_COLOURS, outwardBand, rimBand,
  SceneLights, SceneEnv, SceneBackground, DESIGNER_GROUND,
} from '@spattoo/designer';

/* ── Gypsophila (baby's breath) ──────────────────────────────────────────────────────────────────
 *
 * The filler every florist-style cake uses: tucked between roses, run as a band round the rim,
 * cascaded down one side, scattered over the board.
 *
 * ⚠️ THE GEOMETRY IS CORE'S, IMPORTED. `buildGypSprig` and `GypCloud` live in
 * `spattoo-core/src/designer/geometry/gypsophila.js` and `canvas/GypCloud.jsx`. This screen owns
 * the labels, the hints and the arrangement presets — nothing else. Several studios in this folder
 * open by admitting they are "the admin prototype copy"; that is the old order and it is how a
 * tuned version and a rendered version drift apart (root CLAUDE.md rule 1, INVARIANTS #15).
 *
 * ⚠️ AND THE SEATS ARE GRASS'S. `GypCloud` distributes through `grassSeats`, which already answers
 * cover-this-top, ring-the-rim, put-a-clump-here and keep-out-of-that against any tier outline.
 * There is no gypsophila placement code anywhere.
 */

const TIER = { radius: 1.5, height: 1.1, baseY: 0 };
const TOP_Y = TIER.baseY + TIER.height;
const SHAPES = {
  round: { kind: 'round', radius: TIER.radius },
  sheet: { kind: 'rect', halfW: 1.6, halfD: 1.15, cornerR: 0.2 },
};
/* The board, drawn so the base ring has something to sit against. ⚠️ It is NOT what the ring is
   seated on: a band filling the board floods it and reads as flowers standing in card. The ring is
   the cake's own outline grown outward by `ringWidth` — see `outwardBand`. */
/* Stand-ins for placed roses. The real ones are catalogue GLBs the designer places; this screen
   only needs something the right size in the right spot to judge how the filler sits around one. */
const ROSES = [
  { u: 0.06, v: 0.62, size: 0.30, halo: 0.56 },
  { u: 0.40, v: 0.55, size: 0.26, halo: 0.50 },
  { u: 0.74, v: 0.66, size: 0.22, halo: 0.44 },
];

const BOARD = { round: { kind: 'round', radius: TIER.radius * 1.34 },
                sheet: { kind: 'rect', halfW: 2.15, halfD: 1.55, cornerR: 0.25 } };

/* The arrangements the reference cakes actually show, named for what a baker would call them. */
/* ⚠️ A LAYOUT IS A LIST OF CLOUDS. The reference cake wears TWO rings — one hugging the top edge
   and one on the board round the base — and they are different seat problems, so one cloud could
   not express it.
   ⚠️ AND A RING USES SHORTER, DROOPIER SPRIGS than a standalone one. At the sprig's own default
   the first stem is long and bare before it forks, so a packed ring reads as a fence of green
   sticks with blooms on top; the reference is the other way round, a band of bloom with green
   showing through. That belongs to the arrangement, not to the sprig. */
const LAYOUTS = {
  'One sprig':      { solo: true },
  'A few, close':   { clouds: [{ spacing: 0.34, jitter: 0.8 }] },
  /* ⚠️ `lay` IS THE MOUNTING, and the board's is not a choice. A cake board is card or acrylic —
     you cannot push a stem into it — so a ring round the base is LAID on it, tucked in sideways at
     the join and resting against the cake's side. Seated upright it reads as a hedge round a
     building: *"on the board, it looks more like a tree plantation."* The top ring's stems ARE
     pushed into buttercream, so 45° there keeps them planted and still tips the band over, which
     is what stops it showing a palisade of green stems round the inside of the rim. */
  'Ring the rim':   { clouds: [{ on: 'rim', spacing: 0.075, jitter: 0.65, overhang: 0.8,
                                 height: 0.20, droop: 0.6, lay: 45, bury: 0.06 }] },
  'Rim and board':  { clouds: [{ on: 'rim', spacing: 0.075, jitter: 0.65, overhang: 0.8,
                                 height: 0.20, droop: 0.6, lay: 45, bury: 0.06 },
                               /* ⚠️ NO `bury` at the foot. Burying moves a seat DOWN, which is
                                  right for a stem pushed into buttercream and wrong here — it put
                                  the whole ring inside the board slab, rendering perfectly and
                                  never being seen. Laid against the join, the cut ends are already
                                  hidden by the blooms in front of them. */
                               { on: 'foot', spacing: 0.075, jitter: 0.7,
                                 height: 0.22, droop: 0.3, lay: 78 }] },
  'Cover the top':  { clouds: [{ spacing: 0.16, jitter: 0.75 }] },
  'Clumps':         { clouds: [{ spacing: 0.10, jitter: 0.8,
                                 patches: [{ u: 0.12, v: 0.55, r: 0.45 },
                                           { u: 0.62, v: 0.5, r: 0.38 }] }] },
  /* ⚠️ A COLLAR IS A PATCH WITH A BITE OUT OF IT. Every florist-style reference puts gypsophila
     AROUND the roses — hugging each and radiating outward, so the rose reads as placed rather than
     stuck on. A plain patch would grow flowers through it. */
  'Around roses':   { roses: ROSES,
                      clouds: [{ spacing: 0.055, jitter: 0.85, lay: 55, height: 0.19, droop: 0.5,
                                 collars: ROSES.map(r => ({ ...r, r: r.halo, inner: r.size * 0.92 })) }] },
};

export default function GypsophilaStudio() {
  const [layout, setLayout] = useState('Rim and board');
  const [shapeKey, setShapeKey] = useState('round');
  const [stats, setStats] = useState(null);
  const [p, setP] = useState({ ...GYP_DEFAULTS, ...GYP_COLOURS, spacing: 0.13, jitter: 0.7,
                              ringWidth: 0.18, rimIn: 0.14, rimOut: 0.10,
                              shadeVary: 0.35, spacingScale: 1 });
  const set = (k) => (v) => setP(o => ({ ...o, [k]: v }));
  const L = LAYOUTS[layout];
  const soloTris = useMemo(() => (buildGypSprig(p).index?.count ?? 0) / 3, [p]);
  /* ⚠️ A FRESH OBJECT LITERAL IS A NEW DEPENDENCY EVERY RENDER. `hole` feeds the seat memo inside
     GypCloud, so writing it inline rebuilt every seat on every frame and the board ring shook. */
  const shape = SHAPES[shapeKey];
  const holeForFoot = useMemo(() => ({ shape, scale: 1.0 }), [shape]);
  const footBand = useMemo(() => outwardBand(shape, p.ringWidth ?? 0.18), [shape, p.ringWidth]);
  /* The rim band has two edges and both are controls: how far in it starts, how far out it reaches. */
  const rim = useMemo(() => rimBand(shape, { inn: p.rimIn, out: p.rimOut }),
                      [shape, p.rimIn, p.rimOut]);

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', fontFamily: "'Quicksand',sans-serif" }}>
      <div style={{ width: 300, padding: 16, background: '#faf7f8', overflowY: 'auto', fontSize: 13,
                    borderRight: '1px solid #e7e2e4' }}>
        <h2 style={{ fontSize: 16, margin: '0 0 2px' }}>Gypsophila</h2>
        <p style={{ fontSize: 11.5, color: '#777', lineHeight: 1.5, margin: '0 0 12px' }}>
          Baby's breath: one stem that forks four times and carries clusters of tiny blooms along
          its finer branches. Judge a single sprig before any arrangement — a hundred of them read
          as a white haze whatever each one is doing.
        </p>

        <Row label="Arrangement">
          {Object.keys(LAYOUTS).map(k => (
            <Btn key={k} on={layout === k} onClick={() => setLayout(k)}>{k}</Btn>
          ))}
        </Row>
        <Row label="Tier">
          {Object.keys(SHAPES).map(k => (
            <Btn key={k} on={shapeKey === k} onClick={() => setShapeKey(k)}>{k}</Btn>
          ))}
        </Row>

        <H>The sprig</H>
        <Sl label="Reach"     v={p.height} min={0.12} max={0.6} step={0.01} on={set('height')}
            hint="Cut end to the furthest bloom." />
        <Sl label="Divisions" v={p.levels} min={1} max={4} step={1} on={set('levels')} int
            hint="2 is a twig, 3 a sprig, 4 a branch — and 4 costs about three times the triangles." />
        <Sl label="Branches"  v={p.forks} min={2} max={4} step={1} on={set('forks')} int
            hint="A maximum. The builder rolls two or three per fork, or it reads as a fishbone." />
        <Sl label="Openness"  v={p.spread} min={0.1} max={1.2} step={0.02} on={set('spread')} />
        <Sl label="Shrink"    v={p.shrink} min={0.4} max={0.85} step={0.01} on={set('shrink')}
            hint="Each level as a fraction of its parent. Low is a stick with specks on it." />
        <Sl label="Droop"     v={p.droop} min={0} max={0.9} step={0.02} on={set('droop')} />
        <Sl label="Stem"      v={p.thickness} min={0.0008} max={0.008} step={0.0002} on={set('thickness')}
            hint="A stem is a hair next to its own flowers — about 1:20 on a real sprig. Fatter reads as wire holding beads." />

        <H>The blooms</H>
        <Sl label="Per cluster" v={p.florets} min={1} max={10} step={1} on={set('florets')} int />
        <Sl label="Bloom size"  v={p.floretSize} min={0.004} max={0.04} step={0.001} on={set('floretSize')}
            hint="A radius. Measured off the reference cakes, a floret is about 1.45% of the cake's WIDTH — the default puts it there." />
        <Sl label="Size variety" v={p.floretVary} min={0} max={0.9} step={0.02} on={set('floretVary')}
            hint="Buds and open flowers sit together. At 0 it is a cluster of identical beads." />
        {/* ⚠️ THE TWO ANSWERS TO "IT IS ALL ONE FLAT WHITE". Depth shades a bloom by how low it
            sits in its own sprig — the crown sees sky, the bottom is roofed by the crowd. Crowd
            depth gives each SPRIG its own brightness, which is the only lever an instanced field
            has: every instance shares one geometry, so per-vertex shading paints the same gradient
            on all of them and merely dims the whole band. Measured on the rim ring, tonal range
            43 → 50 when the crowd varies; baking depth alone moved the median and not the range. */}
        <Sl label="Depth"       v={p.ao} min={0} max={1.4} step={0.05} on={set('ao')}
            hint="How much a bloom low in the sprig is darkened." />
        <Sl label="Depth floor" v={p.aoFloor} min={0.2} max={0.9} step={0.02} on={set('aoFloor')}
            hint="The darkest a bloom may go. White petals in shadow are grey, never black." />
        <Sl label="Crowd depth" v={p.shadeVary} min={0} max={0.6} step={0.02} on={set('shadeVary')}
            hint="How much sprigs differ in brightness. A real crowd has some lit and some in the shade of the rest." />
        <Sl label="Seed"        v={p.seed} min={1} max={40} step={1} on={set('seed')} int />

        {!L.solo && (<>
          <H>The arrangement</H>
          {/* ⚠️ A MULTIPLIER, NOT A VALUE. Each arrangement sets its own spacing — a rim band is
              packed where a scatter is not — and the preset wins over the state, so a plain
              Spacing slider was DEAD on every ring. Scaling what the preset asks for keeps both. */}
          <Sl label="Spacing ×" v={p.spacingScale} min={0.5} max={2.5} step={0.05} on={set('spacingScale')}
              hint="Scales whatever the arrangement asks for. Above 1 opens it up and lets the green show." />
          <Sl label="Wander"  v={p.jitter} min={0} max={1} step={0.02} on={set('jitter')}
              hint="How far a sprig may stray off its seat. At 0 the grid shows." />
          <Sl label="Rim: out past the edge" v={p.rimOut} min={0} max={0.4} step={0.01} on={set('rimOut')}
              hint="How far the top ring reaches PAST the rim, × the tier." />
          <Sl label="Rim: in from the edge" v={p.rimIn} min={0.03} max={0.6} step={0.01} on={set('rimIn')}
              hint="How far in from the rim it starts. The two together are the band's width." />
          <Sl label="Foot ring width" v={p.ringWidth} min={0.04} max={0.5} step={0.01} on={set('ringWidth')}
              hint="How far the base ring reaches out from the cake's foot, × the tier. It is a ring on the cake, not a field on the board." />
        </>)}

        {/* ⚠️ TWO COLOURS, AND THE GREEN IS NOT DECORATION. Every reference shows fine green stems
            carrying white blooms, and the contrast between them is what gives the cloud its
            structure — all-white it has nothing to separate it from a white cake under a bright
            key. They ride one vertex attribute, so this is still one draw call. */}
        <Row label="Bloom">
          {['#fdfdfb', '#ffffff', '#f7f3e8', '#f2e4ea'].map(c => (
            <button key={c} onClick={() => setP(o => ({ ...o, bloom: c }))}
              style={{ width: 26, height: 26, borderRadius: 5, background: c, cursor: 'pointer',
                       border: p.bloom === c ? '2.5px solid #1a1a1a' : '1px solid #ccc' }} />
          ))}
        </Row>
        <Row label="Stem">
          {['#8aa06a', '#6f8a54', '#a8b98c', '#c9c2a8'].map(c => (
            <button key={c} onClick={() => setP(o => ({ ...o, stem: c }))}
              style={{ width: 26, height: 26, borderRadius: 5, background: c, cursor: 'pointer',
                       border: p.stem === c ? '2.5px solid #1a1a1a' : '1px solid #ccc' }} />
          ))}
        </Row>

        <div style={{ marginTop: 14, padding: 10, background: '#fff', borderRadius: 8, fontSize: 11,
                      color: '#555', border: '1px solid #eee', lineHeight: 1.6 }}>
          {L.solo
            ? <>One sprig, <b>{soloTris}</b> triangles. Shown at 3.2× so the forking is visible.</>
            : stats
              ? <>{stats.sprigs} sprigs · {stats.perSprig} triangles each<br />
                  <b>{stats.tris.toLocaleString()}</b> if merged — one draw call as it stands.</>
              : '…'}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        {/* ⚠️ The designer's own rig and ground (INVARIANTS #17): a studio is lit like the cake it
            authors for, or every reading here describes a scene no customer sees. Keyed on the
            view because R3F reads `camera` once, at mount. */}
        <Canvas key={L.solo ? 'solo' : 'tier'} shadows
          camera={{ position: L.solo ? [0, 0.9, 2.2] : [0, 2.0, 4.8], fov: 40 }}
          gl={{ preserveDrawingBuffer: true }} style={{ position: 'absolute', inset: 0 }}>
          <SceneBackground />
          <SceneLights shadows />
          <SceneEnv />

          {L.solo ? (
            <mesh geometry={useMemo(() => buildGypSprig(p), [p])} scale={3.2} castShadow receiveShadow>
              <meshStandardMaterial vertexColors color="#ffffff" roughness={0.78} metalness={0} />
            </mesh>
          ) : (<>
            {/* The board, so a ring round the base has something to stand on. */}
            <mesh position={[0, TIER.baseY - 0.03, 0]} receiveShadow>
              {shapeKey === 'round'
                ? <cylinderGeometry args={[BOARD.round.radius, BOARD.round.radius, 0.06, 72]} />
                : <boxGeometry args={[BOARD.sheet.halfW * 2, 0.06, BOARD.sheet.halfD * 2]} />}
              <meshStandardMaterial color="#efe3e8" roughness={0.85} />
            </mesh>
            <mesh position={[0, TIER.baseY + TIER.height / 2, 0]} castShadow receiveShadow>
              {shapeKey === 'round'
                ? <cylinderGeometry args={[TIER.radius, TIER.radius, TIER.height, 72]} />
                : <boxGeometry args={[SHAPES.sheet.halfW * 2, TIER.height, SHAPES.sheet.halfD * 2]} />}
              <meshStandardMaterial color="#f6efe4" roughness={0.9} />
            </mesh>
            {(L.roses ?? []).map((r, i) => {
              const R = SHAPES[shapeKey].radius ?? 1;
              return (
                <mesh key={`rose${i}`} castShadow receiveShadow
                      position={[r.v * R * Math.sin(r.u * Math.PI * 2), TOP_Y + r.size * 0.45,
                                 r.v * R * Math.cos(r.u * Math.PI * 2)]}>
                  <sphereGeometry args={[r.size, 20, 14]} />
                  <meshStandardMaterial color="#9d1b2f" roughness={0.55} />
                </mesh>
              );
            })}
            {L.clouds.map((c, i) => (
              <GypCloud key={i}
                shape={c.on === 'foot' ? footBand : c.on === 'rim' ? rim.shape : SHAPES[shapeKey]}
                bandInner={c.on === 'rim' ? rim.bandInner : undefined}
                topY={c.on === 'foot' ? TIER.baseY + 0.005 : TOP_Y}
                hole={c.on === 'foot' ? holeForFoot : null}
                patchRadius={c.on === 'foot' ? footBand.radius
                           : c.on === 'rim' ? rim.shape.radius : undefined}
                {...p} {...c}
                spacing={(c.spacing ?? p.spacing ?? 0.13) * (p.spacingScale ?? 1)}
                seed={p.seed + i * 13}
                onStats={i === 0 ? setStats : undefined} />
            ))}
          </>)}

          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, L.solo ? -0.4 : 0, 0]} receiveShadow>
            <circleGeometry args={[7, 48]} />
            <meshStandardMaterial color={DESIGNER_GROUND} roughness={1} />
          </mesh>
          <OrbitControls target={[0, L.solo ? 0.35 : TOP_Y * 0.6, 0]} />
        </Canvas>
      </div>
    </div>
  );
}

const Row = ({ label, children }) => (
  <div style={{ margin: '0 0 10px' }}>
    <div style={{ fontSize: 10.5, fontWeight: 700, color: '#888', letterSpacing: 0.5,
                  textTransform: 'uppercase', marginBottom: 5 }}>{label}</div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>{children}</div>
  </div>
);
const Btn = ({ on, onClick, children }) => (
  <button onClick={onClick} style={{ padding: '5px 9px', borderRadius: 6, fontSize: 11.5,
    cursor: 'pointer', fontFamily: 'inherit', border: on ? 'none' : '1px solid #d8d2d4',
    background: on ? '#1a1a1a' : '#fff', color: on ? '#fff' : '#333' }}>{children}</button>
);
const H = ({ children }) => (
  <div style={{ fontSize: 10.5, fontWeight: 700, color: '#888', letterSpacing: 0.6,
                textTransform: 'uppercase', margin: '14px 0 6px' }}>{children}</div>
);
const Sl = ({ label, v, min, max, step, on, int, hint }) => (
  <div style={{ margin: '0 0 9px' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}>
      <span>{label}</span><b>{int ? Math.round(v) : Number(v).toFixed(step < 0.01 ? 4 : 2)}</b>
    </div>
    <input type="range" min={min} max={max} step={step} value={v} style={{ width: '100%' }}
      onChange={e => on(Number(e.target.value))} />
    {hint && <div style={{ fontSize: 10, color: '#999', lineHeight: 1.4 }}>{hint}</div>}
  </div>
);
