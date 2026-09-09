import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import * as THREE from 'three';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js';
import helvetikerBold from 'three/examples/fonts/helvetiker_bold.typeface.json';
import { HexColorPicker } from 'react-colorful';
import {
  topperShapes, backingPlate, offsetParts, outlineOf,
  SceneLights, SceneEnv, SceneBackground, DESIGNER_GROUND,
  SelectionBox, SELECTION_COLOR, albedoForLight, loadTopperFace, TOPPER_FACES,
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

/* ── Dragging ────────────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ AGAINST A FIXED PLANE, never against the object's own surface. `e.point` is where the ray met
 * THIS mesh, and the mesh is the thing being moved — read it every frame and the object chases its
 * own hit point, accelerating away from the pointer. The card plane at z = 0 does not move, so the
 * arithmetic is stable: grab the offset once, subtract it forever.
 *
 * ⚠️ AND THE GRAB OFFSET IS THE WHOLE OF IT. Without it an object jumps so its centre lands under the
 * pointer the instant you touch it — INVARIANTS #10's law that `handleAt` and `dragTo` are exact
 * inverses, in the smallest possible form: where you grabbed is where you are still holding.
 */
const DRAG_PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const SNAP = 0.05;             // how near a centre line counts as on it

// Where the pointer's ray meets the card plane, or null if it runs parallel to it.
function planeHit(ray) {
  const p = new THREE.Vector3();
  return ray.intersectPlane(DRAG_PLANE, p) ? p : null;
}

const extrude = (parts, z) => (parts ?? []).map((p) => {
  const shape = new THREE.Shape(p.outer.map(q => new THREE.Vector2(q.x, q.y)));
  shape.holes = (p.holes ?? []).map(h => new THREE.Path(h.map(q => new THREE.Vector2(q.x, q.y))));
  const g = new THREE.ExtrudeGeometry(shape, { depth: CARD_THICK, bevelEnabled: false });
  g.translate(0, 0, z - CARD_THICK / 2);
  return g;
});

/* ⚠️ EVERY OBJECT ON ITS OWN LAYER, or they interpenetrate. Coplanar extrusions do not stack — a
 * word laid on a disc at the same z has half its letters INSIDE the disc, so the disc wins wherever
 * it happens to be nearer and the letters show through in patches. It looks like transparency and is
 * actually two solids sharing a plane.
 *
 * A tenth of the card's thickness per layer: enough that the depth test is decisive, small enough
 * that the stack is still one flat card when it is cut. Layer order is also z-order, so "the last
 * thing added is in front" is true rather than accidental. */
const LAYER_Z = CARD_THICK * 0.1;

/* Corner grips on the selection box. Small squares in world units — the working camera is
 * orthographic and fixed, so a world size IS a screen size and there is nothing to compensate for. */
const HANDLE = 0.075;

function Piece({ obj, layer, font, selected, editing, onSelect, onMove, onEdit, onChange }) {
  const { controls } = useThree();
  const grab = useRef(null);
  const sizing = useRef(null);

  const begin = (e) => {
    e.stopPropagation();
    onSelect(obj.id);
    if (editing) return;                 // a drag would fight the caret
    const hit = planeHit(e.ray);
    if (!hit) return;
    grab.current = { dx: obj.x - hit.x, dy: obj.y - hit.y };
    // ⚠️ Orbit off for the duration, or one drag both moves the card and swings the camera.
    if (controls) controls.enabled = false;
    e.target.setPointerCapture?.(e.pointerId);
  };

  const move = (e) => {
    if (!grab.current || editing) return;
    e.stopPropagation();
    const hit = planeHit(e.ray);
    if (!hit) return;
    let x = hit.x + grab.current.dx, y = hit.y + grab.current.dy;
    /* ⚠️ Snapped to the MIDDLE only, not to every grid line. Centring a word on a shape is the
     * alignment anyone actually wants, and it is the one the eye catches instantly when it is a
     * pixel out. Snapping to all of them would make the grid a cage — free placement is the normal
     * case and a drawn grid is there to be read, not obeyed. */
    if (Math.abs(x) < SNAP) x = 0;
    if (Math.abs(y) < SNAP) y = 0;
    onMove(obj.id, { x, y });
  };

  const end = (e) => {
    if (!grab.current) return;
    grab.current = null;
    if (controls) controls.enabled = true;
    e.target?.releasePointerCapture?.(e.pointerId);
  };

  /* ── Resizing, from any corner ─────────────────────────────────────────────────────────────────
   *
   * ⚠️ SCALED BY THE RATIO OF DISTANCES FROM THE CENTRE, not by matching the corner to the pointer.
   * The two agree only while the grip is exactly under the finger, and they part company the moment
   * the pointer strays off the diagonal — matching the corner then makes the object lunge. A ratio
   * of "how far out are you now" to "how far out were you when you grabbed" is stable in every
   * direction, and it is the same law as the drag's grab offset (INVARIANTS #10): the thing you took
   * hold of stays where you are holding it.
   *
   * ⚠️ AND IT SCALES ABOUT THE OBJECT'S CENTRE, so the piece grows evenly and its position does not
   * drift. Anchoring the opposite corner is the other convention and needs the object's own bounds
   * to stay fixed while its size changes — which is exactly what a re-cut word does not do. */
  const sizeStart = (e) => {
    e.stopPropagation();
    onSelect(obj.id);
    const hit = planeHit(e.ray);
    if (!hit) return;
    const r = Math.hypot(hit.x - obj.x, hit.y - obj.y);
    if (r < 1e-4) return;
    sizing.current = { r, size: obj.size };
    if (controls) controls.enabled = false;
    e.target.setPointerCapture?.(e.pointerId);
  };

  const sizeMove = (e) => {
    if (!sizing.current) return;
    e.stopPropagation();
    const hit = planeHit(e.ray);
    if (!hit) return;
    const r = Math.hypot(hit.x - obj.x, hit.y - obj.y);
    const next = sizing.current.size * (r / sizing.current.r);
    onChange(obj.id, { size: Math.max(0.2, Math.min(3.2, next)) });
  };

  const sizeEnd = (e) => {
    if (!sizing.current) return;
    sizing.current = null;
    if (controls) controls.enabled = true;
    e.target?.releasePointerCapture?.(e.pointerId);
  };

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
    <group position={[obj.x, obj.y, layer * LAYER_Z]}>
      {backGeos.map((g, i) => (
        <mesh key={`b${i}`} geometry={g} castShadow receiveShadow
          onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
          <meshStandardMaterial color={asRendered(obj.offsetColour)} roughness={0.86} metalness={0} />
        </mesh>
      ))}
      {geos.map((g, i) => (
        <mesh key={i} geometry={g} castShadow receiveShadow
          onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
          onDoubleClick={(e) => { if (obj.kind === 'text') { e.stopPropagation(); onEdit(obj.id); } }}>
          <meshStandardMaterial color={asRendered(obj.colour)} roughness={0.86} metalness={0} />
        </mesh>
      ))}
      {/* ⚠️ EDITED WHERE IT IS. The words were also a field in the side panel, which meant typing in
          one place and watching another — and two controls for one value, either of which could be
          the one you reach for. A real <input> is laid over the object rather than keystrokes being
          captured: a caret, selection, undo, IME and a phone keyboard all come free, and none of
          them can be faked by listening for keydown.
          Screen-space rather than `transform`, on purpose — this is an editing affordance, not the
          artwork, so it should stay legible when the card is small or the camera is turned. */}
      {editing && obj.kind === 'text' && (
        <Html center zIndexRange={[40, 0]} style={{ pointerEvents: 'auto' }}>
          <input
            autoFocus
            defaultValue={obj.text}
            onFocus={(e) => e.target.select()}
            onChange={(e) => onChange(obj.id, { text: e.target.value })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
            }}
            onBlur={() => onEdit(null)}
            style={{
              minWidth: 120, textAlign: 'center', padding: '6px 10px', borderRadius: 8,
              border: `2px solid ${SELECTION_COLOR}`, outline: 'none', background: '#fff',
              fontFamily: "'Quicksand', sans-serif", fontSize: 16, fontWeight: 700, color: '#2C3E33',
            }}
          />
        </Html>
      )}
      {selected && (
        <group position={[box.cx, box.cy, 0]}>
          {/* THE selection cue, from core — a border and not a tint, because an emissive highlight is
              additive and corrupts the albedo it is meant to advertise. On a screen for choosing
              colours that is not a small thing. */}
          <SelectionBox width={box.w * 1.06} height={box.h * 1.12} depth={CARD_THICK * 3} />
          {/* A grip on each corner, so the nearest one is always to hand whichever way the piece
              is sitting. All four do the same thing — the scale is about the centre. */}
          {[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => (
            <mesh key={`${sx}${sy}`}
              position={[sx * box.w * 0.53, sy * box.h * 0.56, CARD_THICK * 2]}
              onPointerDown={sizeStart} onPointerMove={sizeMove}
              onPointerUp={sizeEnd} onPointerCancel={sizeEnd}>
              <planeGeometry args={[HANDLE, HANDLE]} />
              <meshBasicMaterial color={SELECTION_COLOR} toneMapped={false} />
            </mesh>
          ))}
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
  const wrap = useRef(null);
  /* ⚠️ CLOSES ON A CLICK OUTSIDE IT. Opened, the wheel is 130px of panel sitting between the colour
   * and everything below it, and the only way out was to find the same swatch again — so it stayed
   * open and pushed the rest of the controls down the page. Closing on the next click anywhere else
   * is what every picker does and needs no affordance of its own.
   * `mousedown`, not `click`: a click that lands on another control should close this AND reach that
   * control, and waiting for click means the first press is spent shutting the picker. */
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) onToggle(); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open, onToggle]);

  return (
    <div ref={wrap} style={{ marginBottom: 10 }}>
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
    <div className="tcProps" style={{ padding: 16, background: '#fff', borderLeft: '1px solid #E8EFE9' }}>
      <h2 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 800, color: '#2C3E33' }}>
        {obj.kind === 'text' ? 'Text' : (SHAPES.find(x => x.key === obj.family)?.label ?? 'Shape')}
      </h2>

      {obj.kind === 'text' && (
        <>
          {/* ⚠️ NO "Words" FIELD HERE. It used to be one, which meant typing on the right while
              watching the middle — and two controls for one value, either of which might be the one
              you reach for. The words are edited on the object; this panel is for everything that is
              not the words. */}
          <p style={{ margin: '-4px 0 12px', fontSize: 11, color: '#8A9A8E', lineHeight: 1.4 }}>
            Double-click the text to edit it.
          </p>
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
  const [editingId, setEditing] = useState(null);
  /* ⚠️ FLAT IS THE WORKING VIEW; 3D IS A LOOK, and they are two different jobs. Composing needs a
   * surface that does not move: an orbit-able perspective camera means one stray drag skews the grid,
   * turns the selection box into a parallelogram and makes "is this centred" unanswerable. It also
   * means objects at different layers are scaled differently by perspective, so a card in front
   * looks bigger than the same card behind. An ORTHOGRAPHIC camera has neither problem.
   * Seeing it standing on a cake is still worth having, so it is a deliberate switch rather than
   * something a mis-aimed drag does to you. */
  const [view3d, setView3d] = useState(false);
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
    /* New text opens for editing with "TEST" selected, so the first keystroke replaces it. Adding a
     * word and then having to discover how to change it is a step nobody wants. */
    if (obj.kind === 'text') setEditing(id);
    return id;
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
    setEditing(e => (e === id ? null : e));
  }, []);
  const selected = objects.find(o => o.id === selectedId) ?? null;

  return (
    /* ⚠️ ONE COLUMN ON A PHONE, and built for it now rather than at the port. Three columns —
     * rail, canvas, properties — is 96 + canvas + 268, which has nothing left at 375px. Stacked, the
     * rail becomes a strip across the top and the properties a sheet under the canvas, so the canvas
     * stays visible while a control is touched (INVARIANTS #11): a colour or a size judged with the
     * thing it changes off-screen is judged blind.
     * A real media query, because it cannot be written inline — same call as the flower studio. */
    <div className="tc">
      <style>{`
        .tc { display: flex; height: calc(100vh - 56px); overflow: hidden; }
        .tc > .tcRail { flex: 0 0 96px; display: flex; flex-direction: column; gap: 16; }
        .tc > .tcStage { flex: 1; min-width: 0; position: relative; }
        .tc > .tcProps { flex: 0 0 268px; overflow-y: auto; }
        @media (max-width: 820px) {
          .tc { flex-direction: column; height: auto; overflow: visible; }
          .tc > .tcRail {
            flex: none; flex-direction: row; align-items: flex-start; gap: 14px;
            overflow-x: auto; border-right: none; border-bottom: 1px solid #E8EFE9;
          }
          /* The canvas keeps a definite height of its own — a flex child with nothing to fill
             collapses to nothing, and R3F will not create a renderer for a zero-height box. */
          .tc > .tcStage { flex: none; height: 52vh; min-height: 280px; }
          .tc > .tcProps { flex: none; border-left: none; border-top: 1px solid #E8EFE9; }
        }
      `}</style>
      <div className="tcRail" style={{ padding: 14, borderRight: '1px solid #E8EFE9', background: '#fff' }}>
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

      <div className="tcStage">
        {/* ⚠️ Keyed on the view, because a Canvas takes its camera ON MOUNT ONLY — remounting is the
            honest way to change camera type, and the same call ChocolateDripStudio makes. */}
        <Canvas key={view3d ? '3d' : 'flat'} shadows
          orthographic={!view3d}
          camera={view3d ? { position: [0, -1.6, 4.6], fov: 34 } : { position: [0, 0, 6], zoom: 190 }}
          gl={{ preserveDrawingBuffer: true }} style={{ position: 'absolute', inset: 0 }}>
          <SceneLights shadows />
          <SceneEnv />
          {/* The designer's own ground, imported rather than chosen, so what is judged here is what a
              cake shows (INVARIANTS #17). */}
          <SceneBackground colour={DESIGNER_GROUND} />
          <Grid />
          {/* A click on nothing clears the selection, which is what every canvas does and what makes
              the border mean "this one" rather than "the last one you touched". */}
          <mesh position={[0, 0, -0.05]} onPointerDown={() => { setSelected(null); setEditing(null); }}>
            <planeGeometry args={[GRID_HALF * 2, GRID_HALF * 2]} />
            <meshBasicMaterial visible={false} />
          </mesh>
          {objects.map((o, i) => (
            <Piece key={o.id} obj={o} layer={i} font={fonts[o.face] ?? blockFont}
              selected={o.id === selectedId} editing={o.id === editingId}
              onSelect={setSelected} onMove={update} onEdit={setEditing} onChange={update} />
          ))}
          {/* Only in the 3D look. While composing there is nothing to orbit: the camera is the one
              thing on this screen that must hold still. */}
          {view3d && <OrbitControls enablePan={false} makeDefault />}
        </Canvas>

        <button type="button" onClick={() => setView3d(v => !v)}
          style={{ position: 'absolute', top: 12, right: 12, minHeight: 34, padding: '0 12px',
            borderRadius: 9, cursor: 'pointer', fontFamily: "'Quicksand', sans-serif", fontSize: 11.5,
            fontWeight: 800, color: view3d ? '#fff' : '#3D5A44',
            background: view3d ? '#3D5A44' : 'rgba(255,255,255,0.92)',
            border: '1.5px solid #C5D4C8' }}>
          {view3d ? 'Back to flat' : 'See it in 3D'}
        </button>

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
