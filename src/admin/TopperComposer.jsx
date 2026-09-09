import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js';
import helvetikerBold from 'three/examples/fonts/helvetiker_bold.typeface.json';
import {
  topperShapes, backingPlate, outlineOf,
  SceneLights, SceneEnv, SceneBackground, DESIGNER_GROUND,
  SelectionBox, albedoForLight, loadTopperFace,
} from '@spattoo/designer';

/* ── Topper composer — STEP 1 of a staged rebuild ────────────────────────────────────────────────
 *
 * The card cutout studio does one word on one plate, and everything about it is decided by controls
 * that are all on screen all the time. This replaces that model with a COMPOSITION: an empty canvas
 * you add text and shapes to, where a control only appears once there is something for it to act on.
 *
 * ⚠️ THE CANVAS IS THE 3D SCENE SEEN FACE ON — it is NOT a separate 2D editor with a 3D preview
 * beside it. Two representations of one object is the drift INVARIANTS #15 exists to stop: the
 * moment a 2D canvas draws a heart and the 3D preview builds one, they are two hearts and only one
 * of them ships. A card topper is FLAT, so face-on 3D and a 2D canvas look identical anyway — and
 * dragging the camera round shows the same objects standing on a cake, with nothing to keep in step.
 *
 * The grid is a scene object behind the work, at the plane the cards sit on, so it reads as a
 * drawing surface without being a second coordinate system.
 *
 * ⚠️ STEP 1 ONLY. Here: an empty canvas, the grid, the face-on camera, the insert menu, and
 * selection. NOT here, and coming in order: per-selection property panels, dragging, and saving —
 * saving last, because what it stores stops being "a word and some numbers" and becomes a list of
 * objects, which is an element-type decision rather than a studio one.
 *
 * The card cutout studio is deliberately left alone until this can do everything it does. Two
 * screens for a while is cheaper than a half-converted one.
 */

const GRID_HALF = 2.2;        // how far the drawing surface extends from the middle
const GRID_STEP = 0.2;
const CARD_THICK = 0.02;

/* Measured for this exact material under the designer's rig — see CardCutoutStudio for the working,
 * and re-measure if the HDRI, SceneLights or the roughness moves (INVARIANTS #16). */
const CARD_LIGHT = Object.freeze([3.193, 2.940, 3.028]);
const asRendered = (hex) => albedoForLight(hex, CARD_LIGHT, { rolloff: 6 });

const blockFont = new FontLoader().parse(helvetikerBold);

/* The shapes on offer are the families `backingPlate` already understands — the cake's own
 * `OUTLINE_FAMILIES` plus the two analytic ones it samples itself. Listed by key, so a family
 * authored later needs a row here and no new code. */
const SHAPES = [
  { key: 'circle', label: 'Circle' },
  { key: 'rect',   label: 'Panel' },
  { key: 'heart',  label: 'Heart' },
];

/* ⚠️ THE ICON IS THE SHAPE'S OWN OUTLINE, drawn from the same function that builds it. A hand-drawn
 * heart icon beside a generated heart is two hearts, and the icon is the one that lies first — it
 * keeps looking right after the curve behind it has been retuned. */
function ShapeIcon({ family, size = 22 }) {
  const d = useMemo(() => {
    const pts = family === 'heart'
      ? (outlineOf('heart', {}) || []).map(p => ({ x: p.x, y: -p.z }))
      : family === 'rect'
        ? [{ x: -1, y: -0.72 }, { x: 1, y: -0.72 }, { x: 1, y: 0.72 }, { x: -1, y: 0.72 }]
        : Array.from({ length: 48 }, (_, i) => {
            const a = (i / 48) * Math.PI * 2;
            return { x: Math.cos(a), y: Math.sin(a) };
          });
    if (!pts.length) return '';
    const k = size / 2.4;
    return pts.map((p, i) => `${i ? 'L' : 'M'} ${(p.x * k).toFixed(2)} ${(-p.y * k).toFixed(2)}`).join(' ') + ' Z';
  }, [family, size]);
  return (
    <svg width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}
      aria-hidden="true" focusable="false">
      <path d={d} fill="currentColor" />
    </svg>
  );
}

/* The drawing surface. Lines, not a textured plane: a grid drawn as geometry stays crisp at any
 * zoom and costs nothing, and it sits just behind the work so a card never z-fights with it. */
function Grid() {
  const geo = useMemo(() => {
    const pts = [];
    for (let v = -GRID_HALF; v <= GRID_HALF + 1e-6; v += GRID_STEP) {
      pts.push(-GRID_HALF, v, 0, GRID_HALF, v, 0);
      pts.push(v, -GRID_HALF, 0, v, GRID_HALF, 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, []);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <group position={[0, 0, -0.06]}>
      <lineSegments geometry={geo}>
        <lineBasicMaterial color="#D8D8DA" transparent opacity={0.9} toneMapped={false} />
      </lineSegments>
      {/* The two middle lines darker, so the centre of the card is findable without counting. */}
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[new Float32Array([
            -GRID_HALF, 0, 0.001, GRID_HALF, 0, 0.001,
            0, -GRID_HALF, 0.001, 0, GRID_HALF, 0.001,
          ]), 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#B9B9BD" toneMapped={false} />
      </lineSegments>
    </group>
  );
}

// One object's geometry: a word, or a shape plate. Both end as extruded contours, which is why they
// can share everything downstream.
function contoursOf(obj, font) {
  if (obj.kind === 'text') {
    if (!font) return null;
    const probe = topperShapes(font, obj.text, { height: 1 });
    if (!probe.width) return null;
    return topperShapes(font, obj.text, { height: obj.size / probe.width }).parts;
  }
  // A shape on its own has no word to fit, so it is fitted to a square of its own size.
  const box = [{ outer: [
    { x: -obj.size / 2, y: -obj.size / 2 }, { x: obj.size / 2, y: -obj.size / 2 },
    { x: obj.size / 2, y: obj.size / 2 }, { x: -obj.size / 2, y: obj.size / 2 },
  ], holes: [] }];
  const plate = backingPlate(box, { family: obj.family, pad: 0 });
  return plate ? [plate] : null;
}

function Piece({ obj, font, selected, onSelect }) {
  const parts = useMemo(() => contoursOf(obj, font), [obj, font]);

  const geos = useMemo(() => (parts ?? []).map((p) => {
    const shape = new THREE.Shape(p.outer.map(q => new THREE.Vector2(q.x, q.y)));
    shape.holes = (p.holes ?? []).map(h => new THREE.Path(h.map(q => new THREE.Vector2(q.x, q.y))));
    const g = new THREE.ExtrudeGeometry(shape, { depth: CARD_THICK, bevelEnabled: false });
    g.translate(0, 0, -CARD_THICK / 2);
    return g;
  }), [parts]);
  useEffect(() => () => geos.forEach(g => g.dispose()), [geos]);

  // The selection border traces the object's own bounds, which is also what a drag will grab.
  const box = useMemo(() => {
    let lo = Infinity, hi = -Infinity, bo = Infinity, to = -Infinity;
    for (const p of parts ?? []) for (const q of p.outer) {
      if (q.x < lo) lo = q.x; if (q.x > hi) hi = q.x;
      if (q.y < bo) bo = q.y; if (q.y > to) to = q.y;
    }
    return Number.isFinite(lo) ? { w: hi - lo, h: to - bo, cx: (lo + hi) / 2, cy: (bo + to) / 2 } : null;
  }, [parts]);

  if (!geos.length || !box) return null;

  return (
    <group position={[obj.x, obj.y, 0]}>
      {geos.map((g, i) => (
        <mesh key={i} geometry={g} castShadow receiveShadow
          onPointerDown={(e) => { e.stopPropagation(); onSelect(obj.id); }}>
          <meshStandardMaterial color={asRendered(obj.colour)} roughness={0.86} metalness={0} />
        </mesh>
      ))}
      {selected && (
        <group position={[box.cx, box.cy, 0]}>
          {/* THE selection cue, from core — a border and not a tint, because an emissive highlight is
              additive and corrupts the albedo it is meant to advertise. On a screen for choosing
              colours that is not a small thing. */}
          <SelectionBox width={box.w * 1.06} height={box.h * 1.12} depth={CARD_THICK * 3} />
        </group>
      )}
    </group>
  );
}

function RailButton({ onClick, title, children, wide = false }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
        width: wide ? '100%' : 46, minHeight: 46, borderRadius: 10, cursor: 'pointer',
        fontFamily: 'inherit', fontSize: 15, fontWeight: 800, color: '#3D5A44',
        background: '#fff', border: '1.5px solid #E2E8E3',
      }}>
      {children}
    </button>
  );
}

export default function TopperComposer() {
  const [objects, setObjects] = useState([]);          // ⚠️ EMPTY. Nothing is on the canvas until asked for.
  const [selectedId, setSelected] = useState(null);
  const [faceKey] = useState('__block');
  const [font, setFont] = useState(blockFont);
  const nextId = useRef(1);

  useEffect(() => {
    if (faceKey === '__block') { setFont(blockFont); return; }
    let alive = true;
    loadTopperFace(faceKey).then(f => alive && setFont(f)).catch(() => {});
    return () => { alive = false; };
  }, [faceKey]);

  const add = useCallback((obj) => {
    const id = nextId.current++;
    /* Dropped at the middle, which is where the eye already is. Later objects step down and right so
     * a second one does not land exactly on the first and look like nothing happened. */
    const n = objects.length;
    setObjects(o => [...o, { id, x: n * 0.12, y: -n * 0.12, colour: '#F2AEC4', ...obj }]);
    setSelected(id);
  }, [objects.length]);

  const addText = () => add({ kind: 'text', text: 'TEST', size: 1.2 });
  const addShape = (family) => add({ kind: 'shape', family, size: 1.0, colour: '#E9DFF2' });

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', overflow: 'hidden' }}>
      <div style={{ flex: '0 0 96px', padding: 14, borderRight: '1px solid #E8EFE9', background: '#fff',
        display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <span style={{ display: 'block', fontSize: 10, fontWeight: 800, letterSpacing: 0.6,
            textTransform: 'uppercase', color: '#9AA8A0', marginBottom: 7 }}>Text</span>
          {/* A "T" and nothing else. It is the one mark every editor uses for this, so it needs no
              label (INVARIANTS #14) — the accessible name carries the words. */}
          <RailButton onClick={addText} title="Add text" wide>
            <span style={{ fontSize: 19, fontWeight: 800, lineHeight: 1 }}>T</span>
          </RailButton>
        </div>

        <div>
          <span style={{ display: 'block', fontSize: 10, fontWeight: 800, letterSpacing: 0.6,
            textTransform: 'uppercase', color: '#9AA8A0', marginBottom: 7 }}>Shapes</span>
          <div style={{ display: 'grid', gap: 7 }}>
            {SHAPES.map(sh => (
              <RailButton key={sh.key} onClick={() => addShape(sh.key)} title={`Add ${sh.label.toLowerCase()}`} wide>
                <ShapeIcon family={sh.key} />
              </RailButton>
            ))}
          </div>
        </div>

        {objects.length > 0 && (
          <button type="button" onClick={() => { setObjects([]); setSelected(null); }}
            style={{ marginTop: 'auto', minHeight: 40, borderRadius: 9, cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 11.5, fontWeight: 800, color: '#8A6320',
              background: '#FDF3E7', border: '1.5px solid #F0DCC0' }}>
            Clear
          </button>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        <Canvas shadows camera={{ position: [0, 0, 5.2], fov: 34 }}
          gl={{ preserveDrawingBuffer: true }} style={{ position: 'absolute', inset: 0 }}>
          <SceneLights shadows />
          <SceneEnv />
          {/* The designer's own ground, imported rather than chosen, so what is judged here is what a
              cake shows (INVARIANTS #17). */}
          <SceneBackground colour={DESIGNER_GROUND} />
          <Grid />
          {/* A click on nothing clears the selection, which is what every canvas does and what makes
              the border mean "this one" rather than "the last one you touched". */}
          <mesh position={[0, 0, -0.05]} onPointerDown={() => setSelected(null)}>
            <planeGeometry args={[GRID_HALF * 2, GRID_HALF * 2]} />
            <meshBasicMaterial visible={false} />
          </mesh>
          {objects.map(o => (
            <Piece key={o.id} obj={o} font={font} selected={o.id === selectedId} onSelect={setSelected} />
          ))}
          {/* Starts face on — a card is flat, so this IS the 2D view — and turns, because the same
              objects are what stands on the cake. */}
          <OrbitControls enablePan={false} makeDefault />
        </Canvas>

        {objects.length === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'center', pointerEvents: 'none' }}>
            <span style={{ fontSize: 13, color: '#8A9A8E', fontFamily: "'Quicksand', sans-serif",
              background: 'rgba(255,255,255,0.82)', padding: '8px 14px', borderRadius: 9 }}>
              Add text or a shape from the left
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
