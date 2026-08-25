import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
// Same generator the designer will render, and the designer's OWN light rig — a look tuned under
// different lights is tuned wrong (see the note in GrassStudio, which learned that the hard way).
import { NameBlocks, boardRunRadius, NAME_BLOCK_DEFAULTS, SceneLights, SceneEnv } from '@spattoo/designer';
import { getCreamGrainNormalMap } from '../lib/creamWaveTexture.js';
import { useElementSave } from '../lib/useElementSave.js';

// ── Letter blocks studio ──────────────────────────────────────────────────────
// The iced fondant cubes with a raised letter, lined up to spell a name — around the board at the
// cake's foot, or in a row on the top.
//
// ── WHAT THIS SCREEN IS FOR ─────────────────────────────────────────────────────
// One question, as with grass: does a generated cube read as FONDANT? Everything else about the
// feature is layout, and layout is checkable in a test. The look is not.
//
// Judge, roughly in order of what is most likely wrong:
//   1. The CHAMFER. Real fondant blocks are soft-cornered and slightly pillowed. Too sharp and it
//      is a plastic toy brick; too round and it is a marshmallow.
//   2. The LETTER's depth and size on the face. It should sit ON the cube like a cut-out stuck
//      down, not be engraved into it and not float.
//   3. The TYPEFACE. This is helvetiker bold — a plain sans, and the known weak point. Real letter
//      blocks use something rounder and chunkier. If that is what spoils it, the fix is a different
//      typeface JSON, which is a config-level change, not a rewrite.
//   4. Scale against the cake. A block should read as a couple of centimetres of fondant.
//
// The look was judged here BEFORE a designer card or a catalogue row was built around it — the
// discipline isomalt and the palette knife skipped, both of which reached a working studio with all
// the scaffolding and never shipped. It passed, so Save now authors a real cake_elements row.

const R = 1.2, BOTTOM_H = 1.45, BOARD_H = 0.1, BOARD_R = 1.9;

// The reference photos, so the sliders start somewhere real.
const PRESETS = {
  'Christening pink': { blockColor: '#f7f5f2', letterColor: '#e9a8c0', size: 0.30, letterScale: 0.52, chamfer: 0.16 },
  'Nursery pastel':   { blockColor: '#bcd9c4', letterColor: '#ffffff', size: 0.34, letterScale: 0.56, chamfer: 0.22 },
  'Primary ABC':      { blockColor: '#2f5fbf', letterColor: '#f2c230', size: 0.38, letterScale: 0.58, chamfer: 0.10 },
};

function Cake({ cakeColor }) {
  const grain = useMemo(() => {
    const t = getCreamGrainNormalMap();
    const c = t.clone(); c.wrapS = c.wrapT = THREE.RepeatWrapping; c.repeat.set(8, 8); c.needsUpdate = true;
    return c;
  }, []);
  return (
    <group>
      <mesh position={[0, BOARD_H / 2, 0]} receiveShadow>
        <cylinderGeometry args={[BOARD_R, BOARD_R, BOARD_H, 72]} />
        <meshStandardMaterial color="#d9b44a" metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[0, BOARD_H + BOTTOM_H / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[R, R, BOTTOM_H, 96, 1]} />
        <meshStandardMaterial color={cakeColor} roughness={0.9} metalness={0}
          normalMap={grain} normalScale={new THREE.Vector2(0.3, 0.3)} />
      </mesh>
    </group>
  );
}

export default function LetterBlocksStudio() {
  const [p, setP] = useState({ ...NAME_BLOCK_DEFAULTS });
  const [text, setText] = useState('EMILY');
  const [zone, setZone] = useState('board');
  const [angle, setAngle] = useState(0);
  const [cakeColor, setCakeColor] = useState('#fdfdfd');
  const [bg, setBg] = useState('#efe7e0');
  const [stats, setStats] = useState({ blocks: 0 });
  const canvasWrapRef = useRef(null);

  // Same hook the grass studio uses — create once, update thereafter (INVARIANTS #3).
  const { editing, saveName, setSaveName, busy, msg, save, startNew } = useElementSave({
        // The same type the rainbow and the cloud use: generated, standing on a surface, made of
    // fondant. A type of its own would be a type per decoration, which 073 corrected.
    typeSlug: 'fondant_decor',
    categorySlug: 'numbers-letters',   // where a customer browses to find it
    canvasRef: canvasWrapRef,
    // What makes a cube read as FONDANT: the chamfer, how the letter sits on the face, the spacing.
    // NOT the name, the size or the colours — those are the card's, and they change per cake.
    buildPayload: () => ({
      allowed_zones: ['top_surface', 'board'],
      default_color: p.blockColor,
      placement_config: {
        procedural: 'letter_blocks',
        letter_blocks: {
          chamfer: +p.chamfer.toFixed(3),
          letterScale: +p.letterScale.toFixed(3),
          letterDepth: +p.letterDepth.toFixed(4),
          gap: +p.gap.toFixed(4),
          letterColor: p.letterColor,
        },
      },
    }),
    onHydrate: (el) => setP(o => ({
      ...o, ...(el.placement_config?.letter_blocks ?? {}),
      blockColor: el.default_color ?? o.blockColor,
    })),
  });

  const set = k => v => setP(o => ({ ...o, [k]: v }));
  const onStats = useCallback(s => setStats(s), []);

  // Board runs arc just clear of the wall; a top row sits on the lid.
  const radius = boardRunRadius(R, p.size);
  const y = zone === 'board' ? BOARD_H : BOARD_H + BOTTOM_H;

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: "'Quicksand', sans-serif" }}>
      <div style={{ width: 292, padding: 18, background: '#fbf7f8', overflowY: 'auto', fontSize: 13 }}>
        <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>Letter Blocks</h2>
        <p style={{ fontSize: 11, color: '#9b5f72', margin: '0 0 14px', lineHeight: 1.5 }}>
          Does a generated cube read as <b>fondant</b>? Watch the chamfer and how the letter sits on
          the face — those decide it, not the layout.
        </p>

        <Row label="Name">
          <input value={text} onChange={e => setText(e.target.value.slice(0, 12))}
            style={{ flex: 1, padding: '6px 9px', fontSize: 13, fontFamily: 'inherit', fontWeight: 700,
              border: '1.5px solid #999', borderRadius: 7, textTransform: 'uppercase' }} />
        </Row>
        <Row label="Preset">
          {Object.keys(PRESETS).map(k => (
            <Btn key={k} onClick={() => setP(o => ({ ...o, ...PRESETS[k] }))}>{k}</Btn>
          ))}
        </Row>
        <Row label="Where">
          {['board', 'top'].map(z => <Btn key={z} on={zone === z} onClick={() => setZone(z)}>{z}</Btn>)}
        </Row>

        <Sl label="Block size"    v={p.size}        min={0.16} max={0.55} step={0.01}  on={set('size')} />
        <Sl label="Chamfer"       v={p.chamfer}     min={0.02} max={0.42} step={0.01}  on={set('chamfer')} />
        <Sl label="Letter size"   v={p.letterScale} min={0.3}  max={0.8}  step={0.02}  on={set('letterScale')} />
        <Sl label="Letter relief" v={p.letterDepth} min={0.01} max={0.2}  step={0.005} on={set('letterDepth')} />
        <Sl label="Gap"           v={p.gap}         min={0}    max={0.15} step={0.005} on={set('gap')} />
        {zone === 'board' && (
          <Sl label="Around the cake" v={angle} min={-3.14} max={3.14} step={0.05} on={setAngle} />
        )}

        <Row label="Block colour">
          {['#f7f5f2', '#bcd9c4', '#bcd0e8', '#f2c6d6', '#2f5fbf', '#d94f4f'].map(c => (
            <Sw key={c} c={c} on={p.blockColor === c} onClick={() => setP(o => ({ ...o, blockColor: c }))} />
          ))}
        </Row>
        <Row label="Letter colour">
          {['#ffffff', '#e9a8c0', '#f2c230', '#2f5fbf', '#4a4a4a'].map(c => (
            <Sw key={c} c={c} on={p.letterColor === c} onClick={() => setP(o => ({ ...o, letterColor: c }))} />
          ))}
        </Row>
        <Row label="Cake / backdrop">
          {['#fdfdfd', '#f6dfe8'].map(c => <Sw key={c} c={c} on={cakeColor === c} onClick={() => setCakeColor(c)} />)}
          <span style={{ width: 8 }} />
          {['#efe7e0', '#2a2a2a', '#ffffff'].map(c => <Sw key={c} c={c} on={bg === c} onClick={() => setBg(c)} />)}
        </Row>

        <div style={{ marginTop: 12, padding: 9, background: '#fff', borderRadius: 7, color: '#666', border: '1px solid #f0e2e7' }}>
          <b style={{ color: '#1a1a1a' }}>{stats.blocks}</b> blocks
        </div>
        <button onClick={() => setP({ ...NAME_BLOCK_DEFAULTS })}
          style={{ marginTop: 12, padding: '6px 14px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
            border: '1.5px solid #1a1a1a', background: '#fff', fontFamily: 'inherit', fontWeight: 600 }}>
          Reset
        </button>
        {/* Save. The look has been judged, so the row is what makes it a real catalogue element:
            searchable, taggable, tunable without a deploy. Create once, update thereafter — see
            useElementSave for why that matters. Needs an element type with slug `letter_blocks`. */}
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #f0e2e7' }}>
          <div style={{ fontSize: 10.5, color: '#a98', marginBottom: 4, letterSpacing: 0.3 }}>
            {editing ? 'EDITING A SAVED ELEMENT' : 'SAVE AS ELEMENT'}
          </div>
          {editing && (
            <p style={{ fontSize: 10.5, color: '#9b5f72', margin: '0 0 6px', lineHeight: 1.45 }}>
              Revising <b>{editing.name}</b> — saving replaces its settings and thumbnail rather than
              adding another row.
            </p>
          )}
          <input value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="e.g. Christening pink"
            style={{ width: '100%', padding: '7px 9px', fontSize: 12.5, fontFamily: 'inherit',
              border: '1.5px solid #999', borderRadius: 7, boxSizing: 'border-box' }} />
          <button onClick={save} disabled={busy || !saveName.trim()}
            style={{ marginTop: 8, width: '100%', padding: '8px 0', fontSize: 12.5, borderRadius: 7,
              border: '1.5px solid #1a1a1a', background: busy || !saveName.trim() ? '#e8e2e4' : '#1a1a1a',
              color: busy || !saveName.trim() ? '#aaa' : '#fff', fontWeight: 700, fontFamily: 'inherit',
              cursor: busy || !saveName.trim() ? 'default' : 'pointer' }}>
            {busy ? (editing ? 'Updating...' : 'Saving...') : (editing ? 'Update this element' : 'Save to catalogue')}
          </button>
          {msg && (
            <p style={{ fontSize: 11, marginTop: 8, lineHeight: 1.45, color: msg.ok ? '#2e7d32' : '#c0392b' }}>
              {msg.text}
            </p>
          )}
          {editing && (
            <button onClick={startNew}
              style={{ marginTop: 6, width: '100%', padding: '6px 0', fontSize: 11.5, borderRadius: 7,
                border: '1.5px solid #C9C1B4', background: '#fff', color: '#5B6B60', fontWeight: 700,
                fontFamily: 'inherit', cursor: 'pointer' }}>
              Start a new element instead
            </button>
          )}
          <p style={{ fontSize: 10.5, color: '#a98', marginTop: 8, lineHeight: 1.5 }}>
            The name, block size and colours are <b>not</b> saved — a baker sets those per cake. This
            row fixes the chamfer, the letter's relief and the spacing.
          </p>
        </div>
      </div>

      <div ref={canvasWrapRef} style={{ flex: 1, position: 'relative' }}>
        {/* preserveDrawingBuffer, or the saved thumbnail is a BLANK png — WebGL clears the
            drawing buffer after compositing and toBlob() reads an empty one. */}
        <Canvas gl={{ preserveDrawingBuffer: true }} shadows camera={{ position: [0, 2.2, 4.4], fov: 42 }} style={{ position: 'absolute', inset: 0 }}>
          <color attach="background" args={[bg]} />
          <SceneLights shadows />
          <SceneEnv />
          <Cake cakeColor={cakeColor} />
          <NameBlocks
            text={text} zone={zone} radius={radius} angle={angle} y={y}
            size={p.size} gap={p.gap} chamfer={p.chamfer}
            letterScale={p.letterScale} letterDepth={p.letterDepth}
            blockColor={p.blockColor} letterColor={p.letterColor}
            onStats={onStats}
          />
          <OrbitControls target={[0, zone === 'board' ? 0.45 : BOARD_H + BOTTOM_H, 0]} />
        </Canvas>
      </div>
    </div>
  );
}

const Row = ({ label, children }) => (
  <div style={{ marginBottom: 11 }}>
    <div style={{ fontSize: 10.5, color: '#a98', marginBottom: 4, letterSpacing: 0.3 }}>{label.toUpperCase()}</div>
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>{children}</div>
  </div>
);
const Btn = ({ on, onClick, children }) => (
  <button onClick={onClick} style={{
    padding: '4px 10px', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
    border: '1.5px solid #1a1a1a', background: on ? '#1a1a1a' : '#fff',
    color: on ? '#fff' : '#1a1a1a', fontWeight: 600,
  }}>{children}</button>
);
const Sw = ({ c, on, onClick }) => (
  <button onClick={onClick} title={c} style={{
    width: 24, height: 24, borderRadius: 5, background: c, cursor: 'pointer',
    border: on ? '2.5px solid #1a1a1a' : '1px solid #ddd',
  }} />
);
const Sl = ({ label, v, min, max, step, on }) => (
  <div style={{ marginBottom: 8 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#666' }}>
      <span>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{Number(v).toFixed(3)}</span>
    </div>
    <input type="range" min={min} max={max} step={step} value={v}
      onChange={e => on(+e.target.value)} style={{ width: '100%' }} />
  </div>
);
