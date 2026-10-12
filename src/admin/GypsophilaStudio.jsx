import { useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import {
  GypCloud, buildGypSprig, GYP_DEFAULTS,
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

/* The arrangements the reference cakes actually show, named for what a baker would call them. */
const LAYOUTS = {
  'One sprig':      { solo: true },
  'A few, close':   { spacing: 0.34, jitter: 0.8 },
  'Ring the rim':   { spacing: 0.12, jitter: 0.7, bandInner: 0.82, overhang: 0.6 },
  'Cover the top':  { spacing: 0.16, jitter: 0.75 },
  'Clumps':         { spacing: 0.10, jitter: 0.8,
                      patches: [{ u: 0.12, v: 0.55, r: 0.45 }, { u: 0.62, v: 0.5, r: 0.38 }] },
};

export default function GypsophilaStudio() {
  const [layout, setLayout] = useState('Ring the rim');
  const [shapeKey, setShapeKey] = useState('round');
  const [stats, setStats] = useState(null);
  const [p, setP] = useState({ ...GYP_DEFAULTS, colour: '#fdfdfb', spacing: 0.13, jitter: 0.7 });
  const set = (k) => (v) => setP(o => ({ ...o, [k]: v }));
  const L = LAYOUTS[layout];
  const soloTris = useMemo(() => (buildGypSprig(p).index?.count ?? 0) / 3, [p]);

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
        <Sl label="Stem"      v={p.thickness} min={0.001} max={0.012} step={0.0005} on={set('thickness')} />

        <H>The blooms</H>
        <Sl label="Per cluster" v={p.florets} min={1} max={10} step={1} on={set('florets')} int />
        <Sl label="Bloom size"  v={p.floretSize} min={0.003} max={0.02} step={0.0005} on={set('floretSize')}
            hint="A radius. On a real stem a floret is about 3% of the sprig — bigger and it reads as berries." />
        <Sl label="Size variety" v={p.floretVary} min={0} max={0.9} step={0.02} on={set('floretVary')}
            hint="Buds and open flowers sit together. At 0 it is a cluster of identical beads." />
        <Sl label="Seed"        v={p.seed} min={1} max={40} step={1} on={set('seed')} int />

        {!L.solo && (<>
          <H>The arrangement</H>
          <Sl label="Spacing" v={p.spacing} min={0.05} max={0.5} step={0.01} on={set('spacing')}
              hint="Centre to centre. Tight is a hedge, loose is a scatter." />
          <Sl label="Wander"  v={p.jitter} min={0} max={1} step={0.02} on={set('jitter')}
              hint="How far a sprig may stray off its seat. At 0 the grid shows." />
        </>)}

        <Row label="Colour">
          {['#fdfdfb', '#ffffff', '#f7f3e8', '#f2e4ea', '#eceff2'].map(c => (
            <button key={c} onClick={() => setP(o => ({ ...o, colour: c }))}
              style={{ width: 26, height: 26, borderRadius: 5, background: c, cursor: 'pointer',
                       border: p.colour === c ? '2.5px solid #1a1a1a' : '1px solid #ccc' }} />
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
              <meshStandardMaterial color={p.colour} roughness={0.78} metalness={0} />
            </mesh>
          ) : (<>
            <mesh position={[0, TIER.baseY + TIER.height / 2, 0]} castShadow receiveShadow>
              {shapeKey === 'round'
                ? <cylinderGeometry args={[TIER.radius, TIER.radius, TIER.height, 72]} />
                : <boxGeometry args={[SHAPES.sheet.halfW * 2, TIER.height, SHAPES.sheet.halfD * 2]} />}
              <meshStandardMaterial color="#f6efe4" roughness={0.9} />
            </mesh>
            <GypCloud shape={SHAPES[shapeKey]} topY={TOP_Y} color={p.colour}
              {...p} {...L} onStats={setStats} />
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
