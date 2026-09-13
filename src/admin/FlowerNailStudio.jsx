import { useState, useRef, useCallback, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import { HexColorPicker } from 'react-colorful';
import * as THREE from 'three';
import { buildPipingStroke, NOZZLES, NOZZLE_BY_KEY, PEN_FEEL } from '@spattoo/designer';

/* ── The flower nail ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ THE PROBLEM THIS EXISTS TO FIX IS NOT THE PETAL. It is the GESTURE.
 *
 * Piping a rose in the pen studio meant aiming forty separate strokes around a circle, and that is
 * not piping — it is admin. It would never have felt right however good the petal geometry got.
 *
 * Because in a real kitchen THE BAG BARELY MOVES. The hand makes one small up-and-over arc in ONE
 * PLACE, over and over, while the other hand spins the nail underneath. The repetition is not
 * tedious because it is a RHYTHM, like turning a pot on a wheel. We had been asking the drawing hand
 * to do the nail's job.
 *
 * So the nail turns and the pointer stays put. A rose becomes one continuous rhythm instead of forty
 * aimed strokes, and everything that makes it the baker's own survives: the length of each arc, the
 * speed, the lean, the wobble, and the rate they turn it. Two people doing this get visibly
 * different roses, because the rhythm is the signature. It removes the tedium, not the authorship —
 * which is the only version of "easier" worth having here.
 *
 * ⚠️ POINTS ARE STORED IN THE NAIL'S OWN FRAME, never the world's. A point piped at nail angle θ is
 * stored as R(-θ)·p, so it sits still on the nail afterwards and turns with it. Store world points
 * instead and a rose piped while spinning would smear into a ring the moment the nail moved on.
 *
 * Off the cake on purpose, exactly like the chocolate studio: a flower is piped on a nail, set, and
 * placed. Drawing it here is what makes it an OBJECT rather than a mark on one cake.
 */

const NAIL_R      = 0.55;
const NAIL_TOP    = 0.02;
const BOARD_COLOR = '#efe9e0';

/* Turning the nail. While a stroke is live the work rotates under the tip, which is the whole
 * point — the baker keeps their hand in one place and pipes to a rhythm.
 *
 * ⚠️ Auto, not a second input, and that is a deliberate first cut. A scroll wheel is a genuine
 * second control on a desktop and does not exist on touch; a second finger is literally the other
 * hand but is touch-only. Auto-spin costs no input at all, so it answers the question this studio
 * was built to ask — does the RHYTHM feel like piping — without the answer depending on which
 * device you happen to be on. If the rhythm works, the better inputs are worth building.
 */
function NailSpin({ spinning, degPerSec, angleRef, groupRef }) {
  useFrame((_, dt) => {
    if (spinning) angleRef.current += (degPerSec * Math.PI / 180) * dt;
    if (groupRef.current) groupRef.current.rotation.y = angleRef.current;
  });
  return null;
}

function StrokeMesh({ points, nozzle, color, thickness, lean }) {
  const geo = useMemo(
    () => buildPipingStroke(points, nozzle, thickness, { ...PEN_FEEL, leanDeg: lean }),
    [points, nozzle, thickness, lean],
  );
  if (!geo) return null;
  return (
    <mesh geometry={geo} castShadow>
      {/* DoubleSide: a petal is a thin ribbon and its fan caps are lit either way round. */}
      <meshPhysicalMaterial side={THREE.DoubleSide} color={color}
        roughness={0.82} sheen={0.4} sheenRoughness={0.9} sheenColor={color} />
    </mesh>
  );
}

function Stage({ nozzle, color, thickness, lean, spinDeg, committed, onCommit }) {
  const angleRef  = useRef(0);
  const groupRef  = useRef();
  const activeRef = useRef(false);
  const [live, setLive] = useState([]);
  const [spinning, setSpinning] = useState(false);

  /* World hit → the nail's own frame. The nail has turned by `angle` since the stroke began, so the
   * inverse turn is what puts the point where it belongs ON the nail. Seated a hair above the top
   * so the ribbon rests on the surface rather than through it. */
  const toNail = useCallback((p) => {
    const a = -angleRef.current;
    const c = Math.cos(a), s = Math.sin(a);
    return new THREE.Vector3(p.x * c - p.z * s, NAIL_TOP + thickness * 0.15, p.x * s + p.z * c);
  }, [thickness]);

  const end = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setSpinning(false);
    setLive(pts => {
      if (pts.length > 1) onCommit({ points: pts.map(p => p.toArray()), nozzle, color, thickness, lean });
      return [];
    });
  }, [onCommit, nozzle, color, thickness, lean]);

  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight position={[3, 6, 4]} intensity={1.15} castShadow />
      <Environment preset="apartment" />
      <OrbitControls enablePan={false} makeDefault />

      {/* The nail. Everything piped lives INSIDE this group, so it turns with the work. */}
      <group ref={groupRef}>
        <mesh
          position={[0, NAIL_TOP / 2, 0]}
          receiveShadow
          onPointerDown={e => {
            e.stopPropagation();
            try { e.target.setPointerCapture(e.pointerId); } catch { /* noop */ }
            activeRef.current = true;
            setSpinning(true);              // the work starts turning the moment cream lands
            setLive([toNail(e.point)]);
          }}
          onPointerMove={e => {
            if (!activeRef.current) return;
            e.stopPropagation();
            const p = toNail(e.point);
            setLive(prev => (!prev.length || p.distanceTo(prev[prev.length - 1]) >= thickness * 0.35
              ? [...prev, p] : prev));
          }}
          /* Leaving the nail ends the stroke, for the same reason it ends on the cake: the tip is
             off the work, so nothing lands. Bridging the gap would draw cream nobody piped. */
          onPointerOut={end}
          onPointerUp={end}
        >
          <cylinderGeometry args={[NAIL_R, NAIL_R, NAIL_TOP, 64]} />
          <meshStandardMaterial color={BOARD_COLOR} roughness={0.9} />
        </mesh>

        {committed.map((s, i) => (
          <StrokeMesh key={i} points={s.points} nozzle={s.nozzle} color={s.color}
            thickness={s.thickness} lean={s.lean} />
        ))}
        {live.length > 1 && (
          <StrokeMesh points={live} nozzle={nozzle} color={color} thickness={thickness} lean={lean} />
        )}
      </group>

      <NailSpin spinning={spinning} degPerSec={spinDeg} angleRef={angleRef} groupRef={groupRef} />
    </>
  );
}

function Slider({ label, value, min, max, step, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: '#3D5A44', minWidth: 92 }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))} style={{ flex: 1, accentColor: '#c47ad6' }} />
      <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 44, textAlign: 'right' }}>
        {Number.isInteger(value) ? value : value.toFixed(3)}
      </span>
    </div>
  );
}

export default function FlowerNailStudio() {
  const [nozzle, setNozzle]   = useState('petal');
  const [color, setColor]     = useState('#c9345a');
  const [thickness, setThick] = useState(0.06);
  const [lean, setLean]       = useState(PEN_FEEL.leanDeg);
  const [spinDeg, setSpin]    = useState(70);
  const [committed, setCommitted] = useState([]);
  const onCommit = useCallback(s => setCommitted(c => [...c, s]), []);

  return (
    /* ⚠️ calc(100vh - 56px), matching the other studios: the admin shell's nav sits above this, so a
       flat 100vh overflows AND leaves the canvas's flex parent without a resolved height — which is
       how it came up as the default 300x150 with nothing in it. */
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', fontFamily: "'Quicksand',sans-serif" }}>
      <div style={{ width: 320, padding: 20, overflowY: 'auto', borderRight: '1px solid #e6e1d8' }}>
        <h1 style={{ fontSize: 19, margin: '0 0 4px', color: '#2C4433' }}>Flower nail</h1>
        <p style={{ fontSize: 12, color: '#6B8C74', lineHeight: 1.55, margin: '0 0 16px' }}>
          Keep your hand in one place and pipe a rhythm — the nail turns under you while cream is
          landing, the way the other hand would turn it. Short arcs, over and over.
        </p>

        <div style={{ fontSize: 10.5, fontWeight: 800, color: '#6B8C74', letterSpacing: 0.5,
                      textTransform: 'uppercase', margin: '0 0 6px' }}>Nozzle</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6, marginBottom: 14 }}>
          {NOZZLES.map(n => (
            <button key={n.key} onClick={() => setNozzle(n.key)} title={n.hint}
              style={{ padding: '8px 2px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 9.5, fontWeight: 700, color: '#2C4433', background: '#fff',
                border: nozzle === n.key ? '2px solid #2C4433' : '1.5px solid #e0dbd2' }}>
              {n.label}
            </button>
          ))}
        </div>

        <Slider label="Thickness" value={thickness} min={0.02} max={0.14} step={0.005} onChange={setThick} />
        <Slider label="Lean" value={lean} min={-80} max={80} step={2} onChange={setLean} />
        {/* The rate the work turns under the tip. Slower = petals land closer together. */}
        <Slider label="Nail spin °/s" value={spinDeg} min={0} max={220} step={5} onChange={setSpin} />

        <div style={{ margin: '14px 0 8px' }}><HexColorPicker color={color} onChange={setColor} style={{ width: '100%' }} /></div>

        <button onClick={() => setCommitted([])}
          style={{ width: '100%', padding: '9px 0', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit',
            fontSize: 12, fontWeight: 800, color: '#3D5A44', background: '#fff', border: '1.5px solid #C5D4C8' }}>
          Clear the nail
        </button>
      </div>

      <div style={{ flex: 1, minWidth: 0, position: 'relative', background: '#F2EFE9' }}>
        <Canvas shadows camera={{ position: [0, 1.15, 1.5], fov: 40 }}>
          <Stage nozzle={nozzle} color={color} thickness={thickness} lean={lean}
            spinDeg={spinDeg} committed={committed} onCommit={onCommit} />
        </Canvas>
      </div>
    </div>
  );
}
