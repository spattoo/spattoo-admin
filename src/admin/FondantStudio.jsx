import React, { useMemo, useRef, useState, useCallback } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
// The SAME renderer and the SAME contact maths the designer will use, never a divergent copy — the
// rule ChocolateDripStudio states and every studio since repeats. SceneLights/SceneEnv are the
// designer's own rig for the same reason: a figure judged under brighter lights is the wrong figure.
import {
  FondantBuild, FONDANT_SHAPES, FONDANT_SHAPE_ORDER, FONDANT_PRESETS,
  fondantDefaultPart, fondantSettle, fondantToConfig, SceneLights, SceneEnv,
} from '@spattoo/designer';
import { useElementSave } from '../lib/useElementSave.js';

// ── Fondant Studio ────────────────────────────────────────────────────────────────────────────────
// Model a figure the way a baker models one: roll pieces and press them together. A teddy bear is a
// body, a head, two ears, a muzzle and four limbs — that is not an approximation of how a bear is
// made, it is how a bear is made.
//
// ── WHY A STUDIO AND NOT A GENERATOR ────────────────────────────────────────────────────────────
// grass.js sets the test and cloud.js repeats it: procedural work succeeds on subjects with "no
// precise familiar signature the eye can check". ⚠️ A BEAR IS THE OPPOSITE. Everyone knows when the
// head is too big or the ears sit too low, and nobody can say why. So this screen exists to put a
// PERSON in front of the proportions. Nothing here generates a figure; it only makes placing pieces
// cheap enough that judging them is the whole of the work.
//
// ── WHAT TO JUDGE, in the order most likely to be wrong ─────────────────────────────────────────
//   1. Proportion. Head-to-body first, then ear size, then how far the muzzle clears the face. The
//      muzzle was the one real defect the first render had — buried in the head, it left the nose
//      reading as a lone dot on a blank face.
//   2. The seams. Two balls pressed together should CREASE. If the figure reads as one moulded
//      potato the pieces are too deeply overlapped.
//   3. Symmetry. Mirrored pieces cannot drift, but an unmirrored one placed near the centre line
//      can — check the ears from straight on.
//   4. Does it stand on the board, or float above it / sink into it?
//
// ── SAVING ──────────────────────────────────────────────────────────────────────────────────────
// A file-less element like the drip, the grass and the cloud: no asset in R2, a thumbnail captured
// from this canvas, and the PARTS LIST in placement_config. A bear is a few hundred bytes of
// numbers, so it recolours, reopens for editing, and cannot lose detail in an optimisation step —
// which is exactly what the imported unicorn lost on its way through GLB conversion.

const BENCH_R = 2.4;

// ── The drag plane ────────────────────────────────────────────────────────────────────────────────
// ⚠️ ORIENTED TO THE CAMERA, not to a world axis. A fixed XY plane is simpler and works perfectly
// until the author orbits — after which dragging sends the piece off at an angle to the direction
// the mouse moved, which reads as the tool being broken rather than as a projection.
// Sized generously so a drag never runs off its own edge mid-gesture and drops the piece.
function DragPlane({ active, at, onMove }) {
  const ref = useRef();
  const { camera } = useThree();
  useFrame(() => {
    if (!ref.current || !active) return;
    ref.current.position.set(at[0], at[1], at[2]);
    ref.current.quaternion.copy(camera.quaternion);
  });
  if (!active) return null;
  return (
    <mesh ref={ref} visible={false}
      onPointerMove={(e) => { e.stopPropagation(); onMove(e.point); }}>
      <planeGeometry args={[60, 60]} />
      <meshBasicMaterial side={THREE.DoubleSide} />
    </mesh>
  );
}

let seq = 0;
const uid = (shape) => `${shape}-${++seq}`;

export default function FondantStudio() {
  const canvasWrapRef = useRef(null);
  const [parts, setParts]           = useState(() => FONDANT_PRESETS.bear.parts());
  const [selectedId, setSelectedId] = useState(null);
  const [dragId, setDragId]         = useState(null);
  const [color, setColor]           = useState('#C79A6B');

  const selected = parts.find(p => p.id === selectedId) ?? null;
  const patch = (id, fields) => setParts(ps => ps.map(p => (p.id === id ? { ...p, ...fields } : p)));

  /* Add a piece. ⚠️ It arrives ON the selected piece, not at the origin — "put another ball on the
     head" is the actual gesture of modelling, and a piece that lands at the centre of the bench
     every time has to be dragged into place before it can be judged. It is then dropped, so it
     rests on whatever is beneath rather than intersecting it. */
  const addShape = useCallback((shape) => {
    setParts(ps => {
      const anchor = ps.find(p => p.id === selectedId);
      const seed = {
        ...fondantDefaultPart(shape, uid(shape)),
        size: [0.16, 0.16, 0.16],
        pos: anchor ? [anchor.pos[0], anchor.pos[1] + 9, anchor.pos[2]] : [0, 9, 0],
      };
      const next = [...ps, fondantSettle(seed, ps)];
      setSelectedId(seed.id);
      return next;
    });
  }, [selectedId]);

  // Re-apply gravity to a piece the author has dragged into the air. Everything placed BEFORE it
  // holds it up — a figure is built from the bench upward, like the real thing.
  const drop = (id) => setParts(ps => ps.map((p, i) => (p.id === id ? fondantSettle(p, ps.slice(0, i)) : p)));

  const { editing, saveName, setSaveName, busy, msg, save, startNew } = useElementSave({
    typeSlug: 'fondant_decor',
    categorySlug: 'animals',   // where a customer browses for a bear
    canvasRef: canvasWrapRef,
    // The FIGURE, and only the figure. Where it sits on a cake is the customer's decision, and
    // freezing it here would author a bear that can only ever stand in one place.
    buildPayload: () => ({ placement_config: { fondant: fondantToConfig(parts) }, default_color: color }),
    onHydrate: (el) => {
      const cfg = el?.placement_config?.fondant;
      if (Array.isArray(cfg?.parts) && cfg.parts.length) setParts(cfg.parts);
      if (el?.default_color) setColor(el.default_color);
    },
  });

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: "'Quicksand', sans-serif" }}>
      {/* ── The bench: shapes you pull from, then the pieces you have used ────────────────────── */}
      <aside style={{ width: 232, flexShrink: 0, borderRight: '1px solid #e5e5e5', background: '#FAFAF8',
                      padding: 14, overflowY: 'auto' }}>
        <h2 style={{ fontSize: 15, fontWeight: 800, marginBottom: 2 }}>Fondant Studio</h2>
        <p style={{ fontSize: 11, color: '#888', marginBottom: 14, lineHeight: 1.45 }}>
          Roll pieces and press them together. A new piece lands on whatever is selected.
        </p>

        <Label>Shapes</Label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 16 }}>
          {FONDANT_SHAPE_ORDER.map(s => (
            <button key={s} onClick={() => addShape(s)} style={paletteBtn}>
              {FONDANT_SHAPES[s].label}
            </button>
          ))}
        </div>

        {/* ⚠️ An empty bench is the wrong place to start, and this is the difference between a tool
            people use and one they open once: nine proportions judged at the same time versus a
            bear whose ears need nudging. Bear and bunny are ONE skeleton. */}
        <Label>Start from</Label>
        <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
          {Object.entries(FONDANT_PRESETS).map(([k, v]) => (
            <button key={k} onClick={() => { setParts(v.parts()); setSelectedId(null); }} style={paletteBtn}>
              {v.label}
            </button>
          ))}
          <button onClick={() => { setParts([]); setSelectedId(null); }} style={paletteBtn}>Empty</button>
        </div>

        <Label>Pieces ({parts.length})</Label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {parts.map(p => (
            <button key={p.id} onClick={() => setSelectedId(p.id)} style={{
              ...rowBtn,
              background: p.id === selectedId ? '#2C4433' : '#fff',
              color:      p.id === selectedId ? '#fff' : '#333',
            }}>
              <span>{p.id}</span>
              {/* Says out loud that this piece is drawn twice — the single most surprising thing
                  about the model if you have not read it. */}
              {p.mirror && <span style={{ opacity: 0.7, fontSize: 10 }}>×2</span>}
            </button>
          ))}
          {!parts.length && <span style={{ fontSize: 11, color: '#aaa' }}>Nothing on the bench.</span>}
        </div>
      </aside>

      {/* ── The figure ────────────────────────────────────────────────────────────────────────── */}
      <div ref={canvasWrapRef} style={{ flex: 1, minWidth: 0, position: 'relative', background: '#EDEAE3' }}>
        <Canvas shadows camera={{ position: [0, 1.6, 4.2], fov: 34 }}>
          <color attach="background" args={['#EDEAE3']} />
          <SceneLights /><SceneEnv />

          <FondantBuild
            parts={parts} color={color} selectedId={selectedId}
            onPickPart={(id) => { setSelectedId(id); setDragId(id); }}
          />

          {/* ⚠️ Dragging a MIRRORED piece moves the stored row, so both copies move together. That
              is the point of storing it once, and it is why the drag targets the row rather than
              whichever copy happened to be under the pointer. */}
          <DragPlane
            active={!!dragId}
            at={parts.find(p => p.id === dragId)?.pos ?? [0, 0, 0]}
            onMove={(pt) => dragId && patch(dragId, { pos: [pt.x, Math.max(0, pt.y), pt.z] })}
          />

          {/* The board, so "does it stand on the bench" is answerable by eye rather than by number. */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <circleGeometry args={[BENCH_R, 64]} />
            <shadowMaterial opacity={0.28} />
          </mesh>

          {/* Orbit is off mid-drag: with both live, one gesture both moves the piece and swings the
              camera, and the piece appears to fly away from the pointer. */}
          <OrbitControls target={[0, 0.8, 0]} enabled={!dragId} makeDefault />
        </Canvas>

        {/* Pointer-up anywhere ends a drag — releasing outside the plane used to leave the piece
            stuck to the cursor with no way to put it down but a reload. */}
        <div onPointerUp={() => { if (dragId) { drop(dragId); setDragId(null); } }}
             style={{ position: 'absolute', inset: 0, pointerEvents: dragId ? 'auto' : 'none' }} />

        <div style={{ position: 'absolute', left: 12, bottom: 12, fontSize: 11, color: '#8a8a8a' }}>
          Drag a piece to move it · it drops onto what is beneath when you let go
        </div>
      </div>

      {/* ── The selected piece ────────────────────────────────────────────────────────────────── */}
      <aside style={{ width: 268, flexShrink: 0, borderLeft: '1px solid #e5e5e5', background: '#FAFAF8',
                      padding: 14, overflowY: 'auto' }}>
        <Label>Colour</Label>
        <input type="color" value={color} onChange={e => setColor(e.target.value)}
               style={{ width: '100%', height: 32, marginBottom: 16 }} />

        {!selected && <p style={{ fontSize: 12, color: '#888' }}>Pick a piece to resize or move it.</p>}

        {selected && (
          <>
            <Label>{selected.id}</Label>
            {['Width', 'Height', 'Depth'].map((axis, i) => (
              <Slider key={axis} label={axis} value={selected.size[i]} min={0.02} max={0.8} step={0.005}
                onChange={v => patch(selected.id, { size: selected.size.map((s, j) => (j === i ? v : s)) })} />
            ))}
            <button onClick={() => {
              // Uniform grow/shrink, because most resizing is "a bit bigger" rather than one axis.
              const k = 1.12;
              patch(selected.id, { size: selected.size.map(s => Math.min(0.8, s * k)) });
            }} style={{ ...paletteBtn, width: '100%', marginBottom: 4 }}>Bigger</button>
            <button onClick={() => patch(selected.id, { size: selected.size.map(s => Math.max(0.02, s / 1.12)) })}
                    style={{ ...paletteBtn, width: '100%', marginBottom: 12 }}>Smaller</button>

            <Slider label="Depth (front ↔ back)" value={selected.pos[2]} min={-1} max={1} step={0.01}
              onChange={v => patch(selected.id, { pos: [selected.pos[0], selected.pos[1], v] })} />
            <Slider label="Lean" value={selected.rot[2]} min={-1.6} max={1.6} step={0.02}
              onChange={v => patch(selected.id, { rot: [selected.rot[0], selected.rot[1], v] })} />

            {/* ⚠️ Mirroring is the single biggest saving on this screen: place one ear, get two, and
                they can never drift apart because there is only one row to edit. */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, margin: '10px 0' }}>
              <input type="checkbox" checked={!!selected.mirror}
                     onChange={e => patch(selected.id, { mirror: e.target.checked })} />
              Mirror across the centre (a pair)
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 10 }}>
              <input type="checkbox" checked={selected.color != null}
                     onChange={e => patch(selected.id, { color: e.target.checked ? '#3B2B24' : null })} />
              Its own colour
            </label>
            {selected.color != null && (
              <input type="color" value={selected.color} onChange={e => patch(selected.id, { color: e.target.value })}
                     style={{ width: '100%', height: 30, marginBottom: 12 }} />
            )}

            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => drop(selected.id)} style={{ ...paletteBtn, flex: 1 }}>Drop</button>
              <button onClick={() => {
                setParts(ps => ps.filter(p => p.id !== selected.id));
                setSelectedId(null);
              }} style={{ ...paletteBtn, flex: 1, color: '#B42318' }}>Delete</button>
            </div>
          </>
        )}

        <hr style={{ margin: '18px 0', border: 0, borderTop: '1px solid #e5e5e5' }} />
        <Label>{editing ? 'Editing an element' : 'Save to the catalogue'}</Label>
        <input value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="Teddy bear"
               style={{ width: '100%', padding: '8px 10px', border: '1px solid #ddd', borderRadius: 8,
                        fontFamily: 'inherit', fontSize: 13, marginBottom: 8 }} />
        <button onClick={save} disabled={busy || !parts.length}
                style={{ ...paletteBtn, width: '100%', background: '#2C4433', color: '#fff',
                         opacity: (busy || !parts.length) ? 0.5 : 1 }}>
          {busy ? 'Saving…' : editing ? 'Update' : 'Save'}
        </button>
        {editing && <button onClick={startNew} style={{ ...paletteBtn, width: '100%', marginTop: 6 }}>New</button>}
        {msg && <p style={{ fontSize: 11, color: '#666', marginTop: 8 }}>{msg}</p>}
      </aside>
    </div>
  );
}

const Label = ({ children }) => (
  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.4, color: '#9a9a9a',
                textTransform: 'uppercase', marginBottom: 6 }}>{children}</div>
);

function Slider({ label, value, min, max, step, onChange }) {
  return (
    <label style={{ display: 'block', marginBottom: 8 }}>
      <span style={{ fontSize: 11, color: '#666', display: 'flex', justifyContent: 'space-between' }}>
        {label}<span style={{ fontVariantNumeric: 'tabular-nums' }}>{Number(value).toFixed(2)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value}
             onChange={e => onChange(parseFloat(e.target.value))} style={{ width: '100%' }} />
    </label>
  );
}

const paletteBtn = {
  padding: '7px 10px', borderRadius: 8, border: '1px solid #ddd', background: '#fff',
  fontFamily: 'inherit', fontSize: 12, fontWeight: 700, cursor: 'pointer', color: '#333',
};

const rowBtn = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '6px 9px', borderRadius: 7, border: '1px solid #e5e5e5',
  fontFamily: 'inherit', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', textAlign: 'left',
};
