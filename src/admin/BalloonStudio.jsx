import { useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import {
  SceneLights, SceneEnv, SceneBackground, DESIGNER_GROUND,
  buildBalloon, BALLOON_DEFAULTS,
} from '@spattoo/designer';

/* ── Fondant balloons ────────────────────────────────────────────────────────────────────────────
 *
 * Three fondant balloons on picks above a baby-shower cake. A balloon is a surface of revolution —
 * one profile curve, spun — which is the whole reason it is procedural rather than a GLB: no asset
 * to host, scales to any size without a second model, and takes whatever colour a customer picks.
 *
 * ⚠️ THE GEOMETRY IS CORE'S, IMPORTED. `buildBalloon` lives in
 * spattoo-core/src/designer/geometry/balloon.js and comes in through `@spattoo/designer`. This file
 * owns the controls and nothing else, so what is tuned here is what renders on a cake
 * (INVARIANTS #15, root CLAUDE.md rule 1).
 *
 * ⚠️ AND IT DRAWS NO STICK. The pick is authored per element on the Manage Elements row
 * (`elementStick.js`), with its own bury depth, built exactly so it would not live inside
 * individual studios — Sandeep, when that was built: *"we did that for few elements. but its part
 * of that individual studio. not as a manage element screen property."* The pale rod below each
 * balloon here is a STAND-IN, so the shape can be judged at the height it will float at. It is not
 * the stick and nothing here authors one.
 *
 * ⚠️ WHAT THIS IS NOT YET. A POC: it decides whether the shape reads and what the numbers should
 * be. There is no `PROCEDURAL_TOOLS` key and no element row, so nothing places a balloon on a cake.
 * The step after that, if the look earns it, is the one every studio here eventually needs — the
 * proportions become a DB overlay an admin tunes without a deploy (INVARIANTS #1a) rather than
 * core's defaults.
 */

const COLOURS = ['#efe6d6', '#9fd6cc', '#f3b9bd', '#cdb9e6', '#f5d9a8', '#ffffff'];

function Balloon({ p, colour, position, tilt, scale }) {
  const geom = useMemo(() => buildBalloon(p), [p]);
  return (
    <group position={position} rotation={[0, 0, tilt]} scale={scale}>
      <mesh geometry={geom} castShadow receiveShadow>
        {/* Fondant: matte and slightly waxy, with no metal and almost no specular. This is sugar
            paste rolled smooth — a latex balloon's sheen would be the wrong material entirely. */}
        <meshStandardMaterial color={colour} roughness={0.78} metalness={0} />
      </mesh>
      <mesh position={[0, -0.55, 0]} castShadow>
        <cylinderGeometry args={[0.012, 0.012, 1.1, 12]} />
        <meshStandardMaterial color="#d8c9a6" roughness={0.6} />
      </mesh>
    </group>
  );
}

export default function BalloonStudio() {
  const [p, setP] = useState({ ...BALLOON_DEFAULTS });
  const [one, setOne] = useState(false);
  const [dark, setDark] = useState(true);
  const set = (k) => (v) => setP(o => ({ ...o, [k]: v }));
  /* The reference is shot against a grey wall and these float ABOVE the cake, so they are seen
     against the room rather than against icing. DESIGNER_GROUND is one click away all the same —
     it is the ground the designer actually uses, and a shape judged only on a flattering backdrop
     is a shape judged somewhere it will never be. */
  const ground = dark ? '#6d6a70' : DESIGNER_GROUND;

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', fontFamily: "'Quicksand',sans-serif" }}>
      <div style={{ width: 290, padding: 16, background: '#faf7f8', overflowY: 'auto', fontSize: 13,
                    borderRight: '1px solid #e7e2e4' }}>
        <h2 style={{ fontSize: 16, margin: '0 0 2px' }}>Fondant balloons</h2>
        <p style={{ fontSize: 11.5, color: '#777', lineHeight: 1.5, margin: '0 0 12px' }}>
          One profile curve, spun. The pick is not drawn here — a stick is authored on the element's
          own row in Manage Elements, with its depth. The pale rod is a stand-in.
        </p>

        <Row label="View">
          <Btn on={!one} onClick={() => setOne(false)}>three</Btn>
          <Btn on={one} onClick={() => setOne(true)}>one, close up</Btn>
        </Row>
        <Row label="Against">
          <Btn on={dark} onClick={() => setDark(true)}>the room</Btn>
          <Btn on={!dark} onClick={() => setDark(false)}>designer ground</Btn>
        </Row>

        <H>The body</H>
        <Sl label="Width × height" v={p.width} min={0.4} max={1.1} step={0.02} on={set('width')} />
        <Sl label="Belly height"   v={p.belly} min={0.25} max={0.85} step={0.01} on={set('belly')}
            hint="Where the widest point sits. Above 0.5 is a balloon; at 0.5 it is an egg standing on its end." />
        <Sl label="Crown"          v={p.crown} min={0} max={1} step={0.02} on={set('crown')}
            hint="0 is a teardrop, 1 is a dome." />

        <H>The tied neck</H>
        <Sl label="Neck"           v={p.neck}  min={0.05} max={0.6} step={0.01} on={set('neck')}
            hint="How far it pinches in before the collar." />
        <Sl label="Collar radius"  v={p.knot}  min={0} max={0.18} step={0.005} on={set('knot')} />
        <Sl label="Collar height"  v={p.collar} min={0} max={0.15} step={0.005} on={set('collar')}
            hint="A rim with two corners, not a bump — that is what makes it read. At 0 it is gone." />

        <H>Mesh</H>
        <Sl label="Profile samples" v={p.segments} min={4} max={30} step={1} on={set('segments')} int />
        <Sl label="Radial"          v={p.radial} min={8} max={96} step={4} on={set('radial')} int />

        <pre style={{ marginTop: 14, padding: 10, background: '#fff', borderRadius: 8, fontSize: 10.5,
                      color: '#555', border: '1px solid #eee' }}>
{JSON.stringify({ width: p.width, belly: p.belly, crown: p.crown, neck: p.neck,
                  knot: p.knot, collar: p.collar }, null, 1)}
        </pre>
      </div>

      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        {/* The designer's own rig (INVARIANTS #17) — fondant's whole character is how matte it is,
            which is a judgement about light, so it has to be the light the cake is lit by. */}
        <Canvas shadows camera={{ position: [0, 0.6, 4.2], fov: 38 }}
          gl={{ preserveDrawingBuffer: true }} style={{ position: 'absolute', inset: 0 }}>
          <SceneLights shadows />
          <SceneEnv />
          <SceneBackground colour={ground} />
          <OrbitControls enablePan={false} makeDefault target={[0, 0.1, 0]} />
          {one ? (
            <Balloon p={p} colour={COLOURS[0]} position={[0, -0.2, 0]} tilt={0.05} scale={1.6} />
          ) : (
            <>
              <Balloon p={p} colour={COLOURS[0]} position={[-0.95, -0.35, 0]} tilt={0.16} scale={1.0} />
              <Balloon p={p} colour={COLOURS[1]} position={[0.1, 0.1, -0.3]} tilt={-0.05} scale={1.25} />
              <Balloon p={p} colour={COLOURS[2]} position={[1.05, -0.25, 0.15]} tilt={-0.19} scale={1.1} />
            </>
          )}
        </Canvas>
      </div>
    </div>
  );
}

const H = ({ children }) => (
  <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.9, textTransform: 'uppercase',
                color: '#2C4433', margin: '14px 0 2px' }}>{children}</div>
);
const Row = ({ label, children }) => (
  <div style={{ margin: '8px 0' }}>
    <div style={{ fontSize: 11, fontWeight: 700, color: '#666', marginBottom: 4 }}>{label}</div>
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{children}</div>
  </div>
);
const Btn = ({ on, children, ...r }) => (
  <button {...r} style={{ padding: '4px 9px', fontSize: 11.5, borderRadius: 6, cursor: 'pointer',
    border: on ? '1.5px solid #1a1a1a' : '1px solid #ccc', background: on ? '#1a1a1a' : '#fff',
    color: on ? '#fff' : '#333', fontFamily: 'inherit' }}>{children}</button>
);
const Sl = ({ label, v, min, max, step, on, int, hint }) => (
  <label style={{ display: 'block', margin: '7px 0' }}>
    <span style={{ fontSize: 11, color: '#666' }}>{label}{' '}
      <b style={{ color: '#1a1a1a' }}>{int ? v : Number(v).toFixed(3)}</b></span>
    <input type="range" min={min} max={max} step={step} value={v} style={{ width: '100%' }}
      onChange={e => on(int ? parseInt(e.target.value, 10) : parseFloat(e.target.value))} />
    {hint && <span style={{ fontSize: 10, color: '#9a9a9a', lineHeight: 1.4, display: 'block' }}>{hint}</span>}
  </label>
);
