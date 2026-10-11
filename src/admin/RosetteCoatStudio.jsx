import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { HexColorPicker } from 'react-colorful';
import * as THREE from 'three';
/* ⚠️ THE GEOMETRY COMES FROM CORE, IT IS NOT REIMPLEMENTED HERE. CLAUDE.md states it plainly —
 * "the studio imports the geometry, it does not carry a copy of it … or the tuned version and the
 * rendered version drift" — and PipingCalibrator carries the worked example of what happens when
 * it does not. `rosetteCoat` owns the packing and the spiral, `creamPen` owns the sweep, and both
 * ship from @spattoo/designer. Whatever is tuned on this page is what the cake will render. */
import {
  rosetteLocalPath, rosetteSeats, ROSETTE_DEFAULTS,
  buildPipingStroke, NOZZLES,
  creamMaterialProps, SceneLights, SceneEnv, SceneBackground, DESIGNER_GROUND,
  configureEnvMap,
} from '@spattoo/designer';

/* The designer's default bottom tier, so what is tuned here is to the scale it will be used at. */
const R = 1.2, H = 1.45, BASE = 0.1;

/* ⚠️ A HOST THAT MOUNTS SceneEnv MUST SAY WHERE THE MAP IS, or the scene silently falls back to a
 * 1.4MB drei preset fetched from GitHub raw. Gated by check:env-map in core; admin is a host. */
configureEnvMap(import.meta.env.VITE_ASSETS_BASE || '');

// ── The coat ────────────────────────────────────────────────────────────────────────────────────
// ⚠️ ONE GEOMETRY, MANY INSTANCES. Every rose is the same shape in a different place, so the coat
// is one swept spiral plus a transform per seat — and `rosetteSeats` returns exactly the frame that
// transform needs. Building each rose separately in world space was the first attempt and measured
// 17.6M vertices on one tier; the page never finished drawing. See the cost note in core's
// rosetteCoat.js for the measured table.
function Coat({ opts, nozzle, colour, softness, onStat }) {
  const geo = useMemo(
    () => buildPipingStroke(rosetteLocalPath(opts), nozzle, opts.ropeRadius),
    [opts, nozzle]);

  const seats = useMemo(
    () => rosetteSeats({ tierRadius: R, tierHeight: H, baseY: BASE, ...opts }),
    [opts]);

  const ref = useRef();
  useEffect(() => {
    if (!ref.current || !geo || !seats.length) return;
    const m = new THREE.Matrix4(), basis = new THREE.Matrix4(), q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    seats.forEach((s, i) => {
      const u = new THREE.Vector3(...s.u), n = new THREE.Vector3(...s.n), v = new THREE.Vector3(...s.v);
      /* The rose is built with X/Z across the surface and Y along the normal, so the basis columns
         are (u, n, v) IN THAT ORDER. Swapping them lays every wall rose flat against the cake, and
         the mistake is invisible from directly in front of the render. */
      basis.makeBasis(u, n, v);
      q.setFromRotationMatrix(basis);
      /* Per-rose variety lives in a roll about the normal. It used to be a different start angle
         per spiral, which is the same picture and defeats instancing entirely. The golden angle
         gives a different roll for every rose without storing one. */
      const roll = new THREE.Quaternion().setFromAxisAngle(n, (i * 2.399963) % (Math.PI * 2));
      m.compose(new THREE.Vector3(...s.p), roll.multiply(q), one);
      ref.current.setMatrixAt(i, m);
    });
    ref.current.instanceMatrix.needsUpdate = true;
    const per = geo.getAttribute('position').count;
    onStat({ roses: seats.length, per, total: per * seats.length });
  }, [geo, seats, onStat]);

  if (!geo || !seats.length) return null;
  /* ⚠️ NO castShadow. The shadow pass re-renders every instance, and self-shadowing between roses
     is not where the look comes from — the cream material's own sheen is. Measured note in core. */
  return (
    <instancedMesh ref={ref} args={[geo, undefined, seats.length]} receiveShadow>
      <meshPhysicalMaterial {...creamMaterialProps(softness)} color={colour} />
    </instancedMesh>
  );
}

const Row = ({ label, value, children }) => (
  <label style={{ display: 'grid', gridTemplateColumns: '120px 1fr 54px', alignItems: 'center',
                  gap: 8, fontSize: 12.5, marginBottom: 8 }}>
    <span style={{ color: '#444' }}>{label}</span>
    {children}
    <span style={{ color: '#888', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
  </label>
);

function Cost({ s }) {
  if (!s) return null;
  const heavy = s.total > 3e6;
  return (
    <div style={{ fontSize: 11.5, lineHeight: 1.55, marginTop: 12, padding: '9px 11px',
                  borderRadius: 7, background: heavy ? '#fff1f0' : '#f1f6f2',
                  color: heavy ? '#a4252a' : '#3d5247' }}>
      <b>{s.roses}</b> roses · <b>{s.per.toLocaleString()}</b> verts each · one instanced mesh
      <div style={{ opacity: 0.75, marginTop: 2 }}>
        {(s.total / 1e6).toFixed(1)}M vertices through the vertex stage each frame
        {heavy && ' — drop Samples/turn or pick a lighter nozzle'}
      </div>
    </div>
  );
}

// ── Rosette Coat Studio ─────────────────────────────────────────────────────────────────────────
// A cake covered end to end in piped roses, the way a rosette cake actually is. Sandeep, with a
// photograph: *"cream piping is filled on entire cake. we need to achieve this."*
//
// ⚠️ ONE COLOUR, DELIBERATELY, FOR NOW. *"we will first do with only one color for all piping
// pieces. then we will see how to go about multi color."* Instancing is what makes the coat
// renderable at all, and a single instanced mesh carries a single material — so multi-colour is
// not a colour picker away, it is a decision between instanced colour attributes or one mesh per
// colour band. That is the next conversation, and the shape of it is already set by this file.
export default function RosetteCoatStudio() {
  const [o, setO] = useState({ ...ROSETTE_DEFAULTS, coverTop: true, coverSide: true, seed: 1 });
  const [nozzle, setNozzle] = useState('star5');
  const [colour, setColour] = useState('#d81e5b');
  const [softness, setSoftness] = useState(0.7);
  const [stat, setStat] = useState(null);
  const onStat = useCallback(setStat, []);
  const set = (k, v) => setO(p => ({ ...p, [k]: v }));
  const slider = (k, min, max, step) => (
    <input type="range" min={min} max={max} step={step} value={o[k]}
           onChange={e => set(k, +e.target.value)} />
  );

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ width: 340, padding: 18, overflowY: 'auto', background: '#fafafa',
                    borderRight: '1px solid #e4e4e4' }}>
        <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>Rosette Coat</h2>
        <p style={{ fontSize: 11.5, color: '#777', margin: '0 0 16px', lineHeight: 1.5 }}>
          A whole cake piped in roses. Start with <b>Peak</b> and <b>Overlap</b> — they are what
          separate a rose from a coil of rope, which is why the pen's own rosette style was dropped
          the first time round.
        </p>

        <Row label="Peak (dome)" value={o.peak.toFixed(2)}>{slider('peak', 0, 1.2, 0.01)}</Row>
        <Row label="Coil overlap" value={o.coilOverlap.toFixed(2)}>{slider('coilOverlap', 0, 0.75, 0.01)}</Row>
        <Row label="Rose radius" value={o.rosetteRadius.toFixed(3)}>{slider('rosetteRadius', 0.08, 0.5, 0.005)}</Row>
        <Row label="Rope radius" value={o.ropeRadius.toFixed(3)}>{slider('ropeRadius', 0.02, 0.12, 0.002)}</Row>
        <Row label="Centre start" value={o.startRadiusFrac.toFixed(2)}>{slider('startRadiusFrac', 0.02, 0.5, 0.01)}</Row>
        <Row label="Tail turns" value={o.tailTurns.toFixed(2)}>{slider('tailTurns', 0, 0.5, 0.01)}</Row>
        <Row label="Jitter" value={o.jitter.toFixed(2)}>{slider('jitter', 0, 1, 0.02)}</Row>
        <Row label="Samples/turn" value={o.samplesPerTurn}>{slider('samplesPerTurn', 8, 48, 4)}</Row>
        <Row label="Seed" value={o.seed}>{slider('seed', 1, 40, 1)}</Row>

        <div style={{ display: 'flex', gap: 16, margin: '14px 0 12px', fontSize: 12.5 }}>
          <label><input type="checkbox" checked={o.coverTop}
                        onChange={e => set('coverTop', e.target.checked)} /> Top</label>
          <label><input type="checkbox" checked={o.coverSide}
                        onChange={e => set('coverSide', e.target.checked)} /> Side</label>
        </div>

        <Row label="Nozzle" value="">
          <select value={nozzle} onChange={e => setNozzle(e.target.value)} style={{ fontSize: 12.5 }}>
            {NOZZLES.map(n => <option key={n.key} value={n.key}>{n.label}</option>)}
          </select>
        </Row>
        <Row label="Softness" value={softness.toFixed(2)}>
          <input type="range" min={0} max={1} step={0.01} value={softness}
                 onChange={e => setSoftness(+e.target.value)} />
        </Row>

        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12.5, color: '#444', marginBottom: 6 }}>Cream colour</div>
          <HexColorPicker color={colour} onChange={setColour} style={{ width: '100%', height: 140 }} />
        </div>

        <Cost s={stat} />

        <button onClick={() => setO({ ...ROSETTE_DEFAULTS, coverTop: true, coverSide: true, seed: 1 })}
                style={{ marginTop: 14, padding: '8px 12px', fontSize: 12.5, borderRadius: 8,
                         border: '1px solid #d9d9e0', background: '#fff', cursor: 'pointer' }}>
          Reset to defaults
        </button>
      </div>

      <div style={{ flex: 1 }}>
        <Canvas shadows camera={{ position: [0, 2.6, 4.6], fov: 38 }}>
          <SceneBackground />
          <SceneLights />
          <SceneEnv />
          {/* The bare tier. It should be INVISIBLE once the coat closes — leaving it brown is what
              makes a packing gap obvious instead of subtle. */}
          <mesh position={[0, BASE + H / 2, 0]} receiveShadow>
            <cylinderGeometry args={[R, R, H, 64]} />
            <meshStandardMaterial color="#6d4a35" roughness={0.9} />
          </mesh>
          <Coat opts={o} nozzle={nozzle} colour={colour} softness={softness} onStat={onStat} />
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, BASE, 0]} receiveShadow>
            <circleGeometry args={[R * 1.45, 64]} />
            <meshStandardMaterial color={DESIGNER_GROUND} roughness={0.8} />
          </mesh>
          <OrbitControls target={[0, BASE + H * 0.5, 0]} />
        </Canvas>
      </div>
    </div>
  );
}
