import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js';
import helvetikerBold from 'three/examples/fonts/helvetiker_bold.typeface.json';
import { HexColorPicker } from 'react-colorful';
import {
  topperShapes, backingPlate, offsetParts, outlineOf,
  SceneLights, SceneEnv, SceneBackground, DESIGNER_GROUND,
  SelectionBox, albedoForLight, loadTopperFace, TOPPER_FACES,
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

/* Every face core offers, plus the block one three ships. Same list as the card cutout studio, and
 * for the same reason: TOPPER_FACES is all scripts, and a number topper wants a block. */
const BLOCK_KEY = '__block';
const FACES = { [BLOCK_KEY]: { label: 'Block' }, ...TOPPER_FACES };

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
    if (!font || !obj.text.trim()) return null;
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

const extrude = (parts, z) => (parts ?? []).map((p) => {
  const shape = new THREE.Shape(p.outer.map(q => new THREE.Vector2(q.x, q.y)));
  shape.holes = (p.holes ?? []).map(h => new THREE.Path(h.map(q => new THREE.Vector2(q.x, q.y))));
  const g = new THREE.ExtrudeGeometry(shape, { depth: CARD_THICK, bevelEnabled: false });
  g.translate(0, 0, z - CARD_THICK / 2);
  return g;
});

function Piece({ obj, font, selected, onSelect }) {
  const parts = useMemo(() => contoursOf(obj, font), [obj, font]);

  /* ⚠️ The offset is a PROPERTY OF THE TEXT, not of the screen. It was a slider that existed whether
   * or not there was anything to offset; here it belongs to the object it acts on, so two words on
   * one topper can carry different bands — which the single-object studio could never express. */
  const backParts = useMemo(() => (
    obj.kind === 'text' && obj.offset > 0 && parts ? offsetParts(parts, obj.offset * obj.size) : null
  ), [obj.kind, obj.offset, obj.size, parts]);

  const geos = useMemo(() => extrude(parts, 0), [parts]);
  const backGeos = useMemo(() => extrude(backParts, -CARD_THICK), [backParts]);
  useEffect(() => () => { geos.forEach(g => g.dispose()); backGeos.forEach(g => g.dispose()); },
    [geos, backGeos]);

  // The selection border traces the object's own bounds — including its backing, because that is
  // the extent of the thing and what a drag will grab.
  const box = useMemo(() => {
    let lo = Infinity, hi = -Infinity, bo = Infinity, to = -Infinity;
    for (const p of (backParts ?? parts ?? [])) for (const q of p.outer) {
      if (q.x < lo) lo = q.x; if (q.x > hi) hi = q.x;
      if (q.y < bo) bo = q.y; if (q.y > to) to = q.y;
    }
    return Number.isFinite(lo) ? { w: hi - lo, h: to - bo, cx: (lo + hi) / 2, cy: (bo + to) / 2 } : null;
  }, [parts]);

  if (!geos.length || !box) return null;

  return (
    <group position={[obj.x, obj.y, 0]}>
      {backGeos.map((g, i) => (
        <mesh key={`b${i}`} geometry={g} castShadow receiveShadow
          onPointerDown={(e) => { e.stopPropagation(); onSelect(obj.id); }}>
          <meshStandardMaterial color={asRendered(obj.offsetColour)} roughness={0.86} metalness={0} />
        </mesh>
      ))}
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

/* ── The properties of whatever is selected ──────────────────────────────────────────────────────
 *
 * ⚠️ IT ONLY EXISTS WHEN SOMETHING IS SELECTED, and that is the point of the whole rebuild. The card
 * cutout studio showed every control at all times — the offset slider with nothing to offset, the
 * insertion depth with no stick — and a control that cannot act is one the reader has to rule out
 * before finding the one that can (INVARIANTS #12). Here a control's presence IS the answer to
 * "does this apply".
 *
 * ⚠️ And it sits BESIDE the canvas, never over it: the whole reason for the composition model is
 * that you watch the thing change as you change it (INVARIANTS #11).
 */
function Row({ label, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: '#3D5A44', marginBottom: 5 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function Slide({ label, value, min, max, step, onChange, fmt }) {
  return (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: '#3D5A44' }}>{label}</span>
        <span style={{ fontSize: 11.5, color: '#6B7C70', fontVariantNumeric: 'tabular-nums' }}>
          {fmt ? fmt(value) : value}
        </span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#3D5A44' }} />
    </label>
  );
}

function Colour({ label, value, onChange, open, onToggle }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <button type="button" onClick={onToggle}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, minHeight: 42,
          padding: '0 11px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
          border: '1.5px solid #E2E8E3', background: '#fff' }}>
        <span style={{ width: 19, height: 19, borderRadius: 5, background: value,
          border: '1px solid rgba(0,0,0,0.12)' }} />
        <span style={{ fontSize: 11.5, fontWeight: 700, color: '#3D5A44' }}>{label}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#8A9A8E' }}>{value}</span>
      </button>
      {open && <HexColorPicker color={value} onChange={onChange}
        style={{ width: '100%', height: 132, marginTop: 8 }} />}
    </div>
  );
}

const inputStyle = {
  width: '100%', boxSizing: 'border-box', padding: '9px 10px', borderRadius: 9,
  border: '1.5px solid #E2E8E3', fontFamily: 'inherit', fontSize: 13.5,
};

function Properties({ obj, onChange, onDelete }) {
  const [wheel, setWheel] = useState(null);
  const set = (patch) => onChange(obj.id, patch);

  return (
    <div style={{ flex: '0 0 268px', overflowY: 'auto', padding: 16, background: '#fff',
      borderLeft: '1px solid #E8EFE9' }}>
      <h2 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 800, color: '#2C3E33' }}>
        {obj.kind === 'text' ? 'Text' : (SHAPES.find(x => x.key === obj.family)?.label ?? 'Shape')}
      </h2>

      {obj.kind === 'text' && (
        <>
          <Row label="Words">
            <input value={obj.text} onChange={e => set({ text: e.target.value })} style={inputStyle} />
          </Row>
          <Row label="Face">
            <select value={obj.face} onChange={e => set({ face: e.target.value })}
              style={{ ...inputStyle, background: '#fff' }}>
              {Object.entries(FACES).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
            </select>
          </Row>
        </>
      )}

      {obj.kind === 'shape' && (
        <Row label="Shape">
          <select value={obj.family} onChange={e => set({ family: e.target.value })}
            style={{ ...inputStyle, background: '#fff' }}>
            {SHAPES.map(sh => <option key={sh.key} value={sh.key}>{sh.label}</option>)}
          </select>
        </Row>
      )}

      <Slide label="Size" value={obj.size} min={0.25} max={2.6} step={0.02} onChange={v => set({ size: v })}
        fmt={v => v.toFixed(2)} />

      <Colour label="Colour" value={obj.colour} onChange={v => set({ colour: v })}
        open={wheel === 'c'} onToggle={() => setWheel(wheel === 'c' ? null : 'c')} />

      {/* ⚠️ Offset belongs to TEXT and appears with it. A shape is already a solid — an outline
          around it is a second shape, which is what adding another shape is for. */}
      {obj.kind === 'text' && (
        <>
          <Slide label="Offset" value={obj.offset} min={0} max={0.22} step={0.005}
            onChange={v => set({ offset: v })} fmt={v => (v === 0 ? 'none' : v.toFixed(3))} />
          {obj.offset > 0 && (
            <Colour label="Offset colour" value={obj.offsetColour} onChange={v => set({ offsetColour: v })}
              open={wheel === 'o'} onToggle={() => setWheel(wheel === 'o' ? null : 'o')} />
          )}
        </>
      )}

      <button type="button" onClick={() => onDelete(obj.id)}
        style={{ width: '100%', marginTop: 10, minHeight: 42, borderRadius: 9, cursor: 'pointer',
          fontFamily: 'inherit', fontSize: 12, fontWeight: 800, color: '#8A6320',
          background: '#FDF3E7', border: '1.5px solid #F0DCC0' }}>
        Remove
      </button>
    </div>
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
  const nextId = useRef(1);

  /* ⚠️ FONTS PER OBJECT, loaded once and kept. Two words on one topper can want two faces, so the
   * font cannot be a property of the screen the way it was in the single-word studio. Held in state
   * rather than a ref so arrival re-renders — a ref would load the face and never draw it. */
  const [fonts, setFonts] = useState({ [BLOCK_KEY]: blockFont });
  const wanted = useMemo(
    () => [...new Set(objects.filter(o => o.kind === 'text').map(o => o.face))], [objects]);
  useEffect(() => {
    let alive = true;
    for (const key of wanted) {
      if (fonts[key]) continue;
      loadTopperFace(key).then(f => alive && setFonts(m => (m[key] ? m : { ...m, [key]: f })))
        .catch(() => {});
    }
    return () => { alive = false; };
  }, [wanted, fonts]);

  const add = useCallback((obj) => {
    const id = nextId.current++;
    /* Dropped at the middle, which is where the eye already is. Later objects step down and right so
     * a second one does not land exactly on the first and look like nothing happened. */
    const n = objects.length;
    setObjects(o => [...o, { id, x: n * 0.12, y: -n * 0.12, colour: '#F2AEC4', ...obj }]);
    setSelected(id);
  }, [objects.length]);

  const addText = () => add({
    kind: 'text', text: 'TEST', size: 1.2, face: BLOCK_KEY,
    // A band by default, because a card topper almost always has one and a baker who does not want
    // it can drag it to none — easier than discovering a control that starts at zero.
    offset: 0.06, offsetColour: '#FFFFFF',
  });
  const addShape = (family) => add({ kind: 'shape', family, size: 1.0, colour: '#E9DFF2' });

  const update = useCallback((id, patch) => {
    setObjects(o => o.map(x => (x.id === id ? { ...x, ...patch } : x)));
  }, []);
  const remove = useCallback((id) => {
    setObjects(o => o.filter(x => x.id !== id));
    setSelected(s => (s === id ? null : s));
  }, []);
  const selected = objects.find(o => o.id === selectedId) ?? null;

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
            <Piece key={o.id} obj={o} font={fonts[o.face] ?? blockFont}
              selected={o.id === selectedId} onSelect={setSelected} />
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

      {/* Only when there is something selected — see the note on Properties. */}
      {selected && <Properties obj={selected} onChange={update} onDelete={remove} />}
    </div>
  );
}
