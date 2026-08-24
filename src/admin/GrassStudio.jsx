import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
// Tune against the SAME generator the designer renders — never a divergent copy (see the note in
// ChocolateDripStudio). GrassPatch is the instanced renderer; buildGrassTuft/grassSeats are its parts.
//
// SceneLights/SceneEnv are the designer's OWN rig, imported rather than approximated. The first
// version of this studio lit the scene ad hoc (key 1.6, the `studio` HDRI, no fill) and the darkest
// green rendered as pale sage — the designer's rig carries a note that a key of 1.5 already
// "washed the diffuse colour toward white" on the cake top, which is precisely where grass sits.
// A colour tuned under the wrong lights is the wrong colour.
import { GrassPatch, grassTriangleCount, GRASS_DEFAULTS, SceneLights, SceneEnv } from '@spattoo/designer';
import { getCreamGrainNormalMap } from '../lib/creamWaveTexture.js';
import { useElementSave } from '../lib/useElementSave.js';

// ── Grass studio ──────────────────────────────────────────────────────────────
// Piped grass, the Wilton 233 look: a nozzle face pierced with ~15 holes, so one squeeze lays down a
// whole clump. It is generated, not modelled, for the same reason the chocolate drip is — it has to
// fit any tier, and a modelled patch is authored at one radius.
//
// ── THIS SCREEN EXISTS TO ANSWER ONE QUESTION ───────────────────────────────────
// Does it READ as grass? Two procedural studios (isomalt, palette knife) reached a working studio
// and never shipped, both because the subject has a precise familiar signature the eye checks
// against. Grass should be the opposite — irregular by nature, sold on silhouette, and dense enough
// that no single blade is inspected — but that is a prediction, and this is where it gets tested.
//
// Nothing here saves to the catalogue yet. Deliberate: the look is judged before an element type,
// an admin form and a designer control get built around it.
//
// WHAT TO JUDGE, in the order most likely to be wrong:
//   1. SILHOUETTE against the background — orbit until the grass is against the backdrop, not the
//      cake. A ragged edge is what sells it; a smooth dome means the blades are too short or too fat.
//   2. Does it read as many CLUMPS, or as one undifferentiated fuzz?
//   3. Blade TIPS must come to a point. Stumps read as wires.
//   4. Bald patches at the working density.

// Mirrors the designer's bottom tier (radius 1.2, top at BOARD_H + BOTTOM_H) so blade height is
// judged against the real thing — a slider tuned at the wrong scale is worse than no slider.
const R = 1.2, BOTTOM_H = 1.45, BOARD_H = 0.1, BOARD_R = 1.6;
const TOP_Y = BOARD_H + BOTTOM_H;

const SHAPES = {
  round: { kind: 'round', radius: R },
  sheet: { kind: 'rect', halfW: 1.35, halfD: 0.95, cornerR: 0.18 },
};

// The reference looks, so the sliders start somewhere real instead of at the middle of their range.
const PRESETS = {
  'Football pitch': { spacing: 0.062, height: 0.20, strands: 12, thickness: 0.011, splay: 0.42, droop: 0.32, lengthVary: 0.45, color: '#5bc236' },
  'Putting green': { spacing: 0.048, height: 0.11, strands: 14, thickness: 0.009, splay: 0.22, droop: 0.12, lengthVary: 0.30, color: '#3f8f2b' },
  'Wild meadow':   { spacing: 0.085, height: 0.34, strands: 9,  thickness: 0.013, splay: 0.62, droop: 0.55, lengthVary: 0.60, color: '#4a9c34' },
};

function CakeMesh({ shapeKey, cakeColor }) {
  const grain = useMemo(() => {
    const t = getCreamGrainNormalMap();
    const c = t.clone(); c.wrapS = c.wrapT = THREE.RepeatWrapping; c.repeat.set(8, 8); c.needsUpdate = true;
    return c;
  }, []);
  const s = SHAPES.sheet;
  return (
    <group>
      <mesh position={[0, BOARD_H / 2, 0]} receiveShadow>
        <cylinderGeometry args={[BOARD_R, BOARD_R, BOARD_H, 72]} />
        <meshStandardMaterial color="#d9b44a" metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[0, BOARD_H + BOTTOM_H / 2, 0]} castShadow receiveShadow>
        {shapeKey === 'round'
          ? <cylinderGeometry args={[R, R, BOTTOM_H, 96, 1]} />
          : <boxGeometry args={[s.halfW * 2, BOTTOM_H, s.halfD * 2]} />}
        <meshStandardMaterial color={cakeColor} roughness={0.9} metalness={0}
          normalMap={grain} normalScale={new THREE.Vector2(0.3, 0.3)} />
      </mesh>
    </group>
  );
}

export default function GrassStudio() {
  const [p, setP] = useState({ ...GRASS_DEFAULTS, color: '#4caf3d' });
  const [shapeKey, setShapeKey] = useState('round');
  const [bandInner, setBandInner] = useState(null);
  // Strands spilling over the rim — the football cake's edge. Its own state rather than a param on
  // `p` because it is a PLACEMENT of the tufts, not a property of one.
  const [overhang, setOverhang] = useState(0);
  const [cakeColor, setCakeColor] = useState('#fdfdfd');
  const [bg, setBg] = useState('#e8b4a8');
  const [stats, setStats] = useState({ tufts: 0, blades: 0 });
  const canvasWrapRef = useRef(null);

  // Authoring a catalogue row is the same job in every procedural studio, so it lives in one hook
  // (INVARIANTS #3) — create the first time, update every time after, thumbnail included.
  const { editing, saveName, setSaveName, busy, msg, save, startNew } = useElementSave({
    typeSlug: 'grass',
    categorySlug: 'finishes',   // where a customer browses to find it
    canvasRef: canvasWrapRef,
    // The LOOK, and only the look. Density, height and colour are what the baker's card exposes;
    // freezing them here would take away a per-cake choice.
    buildPayload: () => ({
      allowed_zones: ['top_surface', 'board'],
      default_color: p.color,
      placement_config: {
        procedural: 'grass',
        grass: {
          strands: p.strands, thickness: +p.thickness.toFixed(4),
          splay: +p.splay.toFixed(3), droop: +p.droop.toFixed(3),
          lengthVary: +p.lengthVary.toFixed(3), jitter: +p.jitter.toFixed(3),
        },
      },
    }),
    onHydrate: (el) => setP(o => ({ ...o, ...(el.placement_config?.grass ?? {}), color: el.default_color ?? o.color })),
  });

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: "'Quicksand', sans-serif" }}>
      <div style={{ width: 290, padding: 18, background: '#fbf7f8', overflowY: 'auto', fontSize: 13 }}>
        <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>Grass Studio</h2>
        <p style={{ fontSize: 11, color: '#9b5f72', margin: '0 0 14px', lineHeight: 1.5 }}>
          Wilton&nbsp;233. Orbit until the grass sits against the <b>background</b> — the silhouette
          is what decides whether this reads.
        </p>

        <Row label="Preset">
          {Object.keys(PRESETS).map(k => (
            <Btn key={k} onClick={() => setP(o => ({ ...o, ...PRESETS[k] }))}>{k}</Btn>
          ))}
        </Row>
        <Row label="Tier">
          {Object.keys(SHAPES).map(k => <Btn key={k} on={shapeKey === k} onClick={() => setShapeKey(k)}>{k}</Btn>)}
        </Row>
        <Row label="Coverage">
          <Btn on={bandInner == null} onClick={() => setBandInner(null)}>whole top</Btn>
          <Btn on={bandInner != null} onClick={() => setBandInner(0.55)}>rim band</Btn>
        </Row>

        {bandInner != null && (
          <Sl label="Band width" v={1 - bandInner} min={0.12} max={0.9} step={0.02}
            on={v => setBandInner(+(1 - v).toFixed(2))} />
        )}
        <Sl label="Overhang (over the rim)" v={overhang} min={0} max={1} step={0.02} on={setOverhang} />
        <Sl label="Density"          v={p.spacing}    min={0.04}  max={0.20}  step={0.002} on={set('spacing')} inv />
        <Sl label="Blade height"     v={p.height}     min={0.05}  max={0.45}  step={0.005} on={set('height')} />
        <Sl label="Strands per tuft" v={p.strands}    min={4}     max={20}    step={1}     on={set('strands')} int />
        <Sl label="Blade thickness"  v={p.thickness}  min={0.004} max={0.025} step={0.001} on={set('thickness')} />
        <Sl label="Splay"            v={p.splay}      min={0}     max={1}     step={0.02}  on={set('splay')} />
        <Sl label="Droop"            v={p.droop}      min={0}     max={1}     step={0.02}  on={set('droop')} />
        <Sl label="Length variation" v={p.lengthVary} min={0}     max={0.8}   step={0.02}  on={set('lengthVary')} />
        <Sl label="Seat jitter"      v={p.jitter}     min={0}     max={1}     step={0.02}  on={set('jitter')} />

        <Row label="Grass colour">
          {['#5bc236', '#4caf3d', '#3f8f2b', '#2e7d32', '#1b5e20'].map(c => (
            <Sw key={c} c={c} on={p.color === c} onClick={() => setP(o => ({ ...o, color: c }))} />
          ))}
        </Row>
        <Row label="Cake / backdrop">
          {['#fdfdfd', '#f6dfe8', '#5d3a1f'].map(c => (
            <Sw key={c} c={c} on={cakeColor === c} onClick={() => setCakeColor(c)} />
          ))}
          <span style={{ width: 8 }} />
          {['#e8b4a8', '#2a2a2a', '#ffffff'].map(c => (
            <Sw key={c} c={c} on={bg === c} onClick={() => setBg(c)} />
          ))}
        </Row>

        <div style={{ marginTop: 14, padding: 10, background: '#fff', borderRadius: 7, color: '#666', lineHeight: 1.7, border: '1px solid #f0e2e7' }}>
          <b style={{ color: '#1a1a1a' }}>Cost</b><br />
          tufts <b>{stats.tufts.toLocaleString()}</b> · blades <b>{stats.blades.toLocaleString()}</b><br />
          triangles <b style={{ color: tris > 400_000 ? '#c0392b' : '#1a1a1a' }}>{tris.toLocaleString()}</b><br />
          draw calls <b>1</b>
          {tris > 400_000 && (
            <div style={{ color: '#c0392b', fontSize: 11, marginTop: 4 }}>
              Above what a phone should be asked to rasterise — back the density off.
            </div>
          )}
        </div>

        <button onClick={() => setP({ ...GRASS_DEFAULTS, color: p.color })}
          style={{ marginTop: 12, padding: '6px 14px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                   border: '1.5px solid #1a1a1a', background: '#fff', fontFamily: 'inherit', fontWeight: 600 }}>
          Reset
        </button>
        {/* Save. The look has been judged, so this is the step that makes it a real catalogue
            element - searchable, taggable, manageable without a deploy. Until a row exists, grass
            reaches the designer ONLY through a hardcoded Tools button, which no search can find.
            Needs an element type with slug `grass` (Element Types screen). */}
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
          <input value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="e.g. Football pitch"
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
            Density, height and colour are <b>not</b> saved - those are the three a baker sets per
            cake. Everything above them is what this row fixes.
          </p>
        </div>
      </div>

      <div ref={canvasWrapRef} style={{ flex: 1, position: 'relative' }}>
        <Canvas shadows camera={{ position: [0, 2.9, 4.6], fov: 42 }} style={{ position: 'absolute', inset: 0 }}>
          <color attach="background" args={[bg]} />
          <SceneLights shadows />
          <SceneEnv />
          <CakeMesh shapeKey={shapeKey} cakeColor={cakeColor} />
          <GrassPatch
            shape={shape} topY={TOP_Y} color={p.color}
            strands={p.strands} height={p.height} spacing={p.spacing} jitter={p.jitter}
            splay={p.splay} droop={p.droop} thickness={p.thickness} lengthVary={p.lengthVary}
            bandInner={bandInner} overhang={overhang} onStats={onStats}
          />
          <OrbitControls target={[0, TOP_Y * 0.75, 0]} />
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
const Sl = ({ label, v, min, max, step, on, int, inv }) => (
  <div style={{ marginBottom: 8 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#666' }}>
      <span>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{int ? v : Number(v).toFixed(3)}</span>
    </div>
    {/* `inv` flips the track so dragging RIGHT means MORE grass. Spacing is the underlying number,
        but density is what a person is actually adjusting, and an inverted slider is a papercut. */}
    <input type="range" min={min} max={max} step={step}
      value={inv ? min + max - v : v}
      onChange={e => on(inv ? min + max - +e.target.value : +e.target.value)}
      style={{ width: '100%' }} />
  </div>
);
