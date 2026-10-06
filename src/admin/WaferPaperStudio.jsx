import { useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import {
  SceneLights, SceneEnv, SceneBackground, DESIGNER_GROUND,
  buildWaferSkirt, WAFER_DEFAULTS,
} from '@spattoo/designer';

/* ── Wafer paper, cut into panels and stood around the cake ───────────────────────────────────────
 *
 * The technique: a sheet of wafer paper (about 0.3mm of dried starch) is cut into strips, each strip
 * is pleated by hand, and the strips are pressed onto the buttercream ALONG THEIR TOP EDGE ONLY so
 * the hem hangs free. The fold lines run from that glued edge down to the hem, and those lines are
 * what the eye reads as a curtain of narrow ribbons — the ribbons are folds, not pieces.
 *
 * ⚠️ THE GEOMETRY IS CORE'S, IMPORTED. `buildWaferSkirt` lives in
 * `spattoo-core/src/designer/geometry/waferPaper.js` and is exported from `@spattoo/designer`. This
 * file owns the CONTROLS and nothing else. Several studios in this folder open by admitting they
 * are "the admin prototype copy; it ports to spattoo-core verbatim" — that was the old order, and
 * it is how a tuned version and a rendered version drift apart (root CLAUDE.md rule 1,
 * INVARIANTS #15). Tune here, and the cake gets exactly what you tuned.
 *
 * ⚠️ WHAT THIS STUDIO IS FOR, AND WHAT IT IS NOT YET. It is a POC: it decides whether the look is
 * worth building, and what the numbers should be. It does not write anything — there is no element
 * row, no catalogue entry, no save. The next step, if the look earns it, is the one every studio
 * here eventually needs: the numbers become a DB-overlaid config an admin can tune without a
 * deploy (INVARIANTS #1a), rather than the defaults baked into core.
 */

const TIER = { radius: 1.45, height: 1.1 };
const SHAPES = {
  round: { kind: 'round', radius: TIER.radius },
  sheet: { kind: 'rect', halfW: 1.65, halfD: 1.1, cornerR: 0.2 },
};

/* Four starting points taken off four reference cakes. They are claims about what each cake IS —
   how many sheets, how deeply pleated, how far the hem swings — so they are the fastest way to find
   out whether a look is reachable at all before touching a slider. */
const PRESETS = {
  'Pink, notched hem': { count: 30, width: 2.0, height: 0.80, rise: 0.22, taper: 0.02, ripple: 0.16,
    ripples: 2.4, sway: 0.05, curl: 0.12, splay: 0.06, lean: 0.03, jitter: 0.30,
    hem: 'notch', notch: 0.18, colour: '#f2766d', opacity: 0.93 },
  'White, waved':      { count: 34, width: 2.3, height: 0.95, rise: 0.04, taper: 0.18, ripple: 0.30,
    ripples: 6.0, sway: 0.10, curl: 0.22, splay: 0.08, lean: 0.05, jitter: 0.45,
    hem: 'straight', notch: 0.10, colour: '#fbf7f2', opacity: 0.88 },
  'White, rippled':    { count: 44, width: 2.0, height: 0.92, rise: 0.02, taper: 0.22, ripple: 0.26,
    ripples: 8.0, sway: 0.12, curl: 0.18, splay: 0.08, lean: 0.03, jitter: 0.50,
    hem: 'torn', notch: 0.12, colour: '#fdfbf7', opacity: 0.86 },
  'White, broad':      { count: 20, width: 2.4, height: 0.98, rise: 0.06, taper: 0.06, ripple: 0.24,
    ripples: 3.0, sway: 0.06, curl: 0.30, splay: 0.06, lean: 0.02, jitter: 0.35,
    hem: 'straight', notch: 0.10, colour: '#ffffff', opacity: 0.82 },
};

function Skirt({ shape, p }) {
  const geom = useMemo(() => buildWaferSkirt({ shape, tierHeight: TIER.height, ...p }), [shape, p]);
  if (!geom) return null;
  return (
    <mesh geometry={geom} position={[0, TIER.height / 2, 0]} castShadow receiveShadow>
      {/* ⚠️ DoubleSide: a sheet of paper has no back. Single-sided, every panel on the far side of
          the cake vanishes the moment it turns — and that is half of them at any angle.
          ⚠️ And the material is half the look. Wafer paper is thin enough to pass light, so the
          panels in front are lit partly THROUGH the ones behind; with transmission at 0 the same
          geometry reads as painted card. Judge the two with the toggle, not from the slider name. */}
      <meshPhysicalMaterial
        color={p.colour} side={THREE.DoubleSide} roughness={p.roughness}
        transmission={p.transmission} thickness={0.02} ior={1.35}
        transparent opacity={p.opacity} />
    </mesh>
  );
}

export default function WaferPaperStudio() {
  const [preset, setPreset] = useState('White, waved');
  const [shapeKey, setShapeKey] = useState('round');
  const [p, setP] = useState({ ...WAFER_DEFAULTS, ...PRESETS['White, waved'], seed: 7,
                               roughness: 0.92, transmission: 0.35 });
  const set = (k) => (v) => setP(o => ({ ...o, [k]: v }));
  const pick = (name) => { setPreset(name); setP(o => ({ ...o, ...PRESETS[name] })); };

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', fontFamily: "'Quicksand',sans-serif" }}>
      <div style={{ width: 300, padding: 16, background: '#faf7f8', overflowY: 'auto', fontSize: 13,
                    borderRight: '1px solid #e7e2e4' }}>
        <h2 style={{ fontSize: 16, margin: '0 0 2px' }}>Wafer paper</h2>
        <p style={{ fontSize: 11.5, color: '#777', lineHeight: 1.5, margin: '0 0 12px' }}>
          Strips of wafer paper, pleated and stuck on along their top edge. The ribbons you see are
          the folds, not the pieces — so a few wide sheets read as many ribbons.
        </p>

        <Row label="Start from">
          {Object.keys(PRESETS).map(k => (
            <Btn key={k} on={preset === k} onClick={() => pick(k)}>{k}</Btn>
          ))}
        </Row>
        <Row label="Tier">
          {Object.keys(SHAPES).map(k => (
            <Btn key={k} on={shapeKey === k} onClick={() => setShapeKey(k)}>{k}</Btn>
          ))}
        </Row>

        <H>The sheets</H>
        <Sl label="Panels"         v={p.count}  min={8} max={90} step={1} on={set('count')} int
            hint="How many strips go round." />
        <Sl label="Width × gap"    v={p.width}  min={0.6} max={3.2} step={0.05} on={set('width')}
            hint="Over 1 they overlap. Every reference does." />
        <Sl label="Height × tier"  v={p.height} min={0.3} max={1.3} step={0.02} on={set('height')} />
        <Sl label="Rise above rim" v={p.rise}   min={-0.1} max={0.4} step={0.01} on={set('rise')}
            hint="How far the strips stand above the top edge." />
        <Sl label="Taper"          v={p.taper}  min={0} max={0.7} step={0.02} on={set('taper')} />

        <H>The pleat</H>
        <Sl label="Fold depth"   v={p.ripple}  min={0} max={0.8} step={0.02} on={set('ripple')} />
        <Sl label="Folds across" v={p.ripples} min={0.5} max={12} step={0.1} on={set('ripples')}
            hint="The fold lines ARE the ribbons." />
        <Sl label="Curl"         v={p.curl}    min={0} max={1} step={0.02} on={set('curl')}
            hint="How much the sheet bows across its width." />
        <Sl label="Drift"        v={p.sway}    min={0} max={0.5} step={0.02} on={set('sway')}
            hint="A lean left or right as it falls. Secondary — keep it small." />
        <Sl label="Splay"        v={p.splay}   min={0} max={0.5} step={0.02} on={set('splay')}
            hint="Hem away from the wall. Paper hugs; a flare reads as a tutu." />
        <Sl label="Lean"         v={p.lean}    min={-0.2} max={0.35} step={0.01} on={set('lean')} />

        <H>Cut and variation</H>
        <Row label="Hem">
          {['straight', 'notch', 'torn'].map(h => (
            <Btn key={h} on={p.hem === h} onClick={() => setP(o => ({ ...o, hem: h }))}>{h}</Btn>
          ))}
        </Row>
        <Sl label="Hem depth" v={p.notch}  min={0} max={0.4} step={0.01} on={set('notch')} />
        <Sl label="Jitter"    v={p.jitter} min={0} max={1} step={0.02} on={set('jitter')}
            hint="How much the strips differ. At 0 the eye finds the repeat." />
        <Sl label="Seed"      v={p.seed}   min={1} max={40} step={1} on={set('seed')} int />

        <H>The paper</H>
        <Sl label="Translucency" v={p.transmission} min={0} max={1} step={0.02} on={set('transmission')}
            hint="At 0 it reads as painted card." />
        <Sl label="Opacity"      v={p.opacity}   min={0.4} max={1} step={0.02} on={set('opacity')} />
        <Sl label="Roughness"    v={p.roughness} min={0.2} max={1} step={0.02} on={set('roughness')} />
        <Row label="Colour">
          {['#ffffff', '#fbf7f2', '#f2766d', '#f6c6cf', '#d9c7f0', '#cfe3d4'].map(c => (
            <button key={c} onClick={() => setP(o => ({ ...o, colour: c }))}
              style={{ width: 26, height: 26, borderRadius: 5, background: c, cursor: 'pointer',
                       border: p.colour === c ? '2.5px solid #1a1a1a' : '1px solid #ccc' }} />
          ))}
        </Row>

        <pre style={{ marginTop: 14, padding: 10, background: '#fff', borderRadius: 8, fontSize: 10.5,
                      color: '#555', overflowX: 'auto', border: '1px solid #eee' }}>
{JSON.stringify({ count: p.count, width: p.width, height: p.height, rise: p.rise, taper: p.taper,
                  ripple: p.ripple, ripples: p.ripples, sway: p.sway, curl: p.curl,
                  splay: p.splay, lean: p.lean, jitter: p.jitter, hem: p.hem, notch: p.notch }, null, 1)}
        </pre>
      </div>

      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        {/* ⚠️ `shadows` + the designer's own rig (INVARIANTS #17). A studio is where a material is
            judged, and this material's whole character is how light passes through it — lighting it
            differently from production would make every reading here describe a cake nobody loads. */}
        <Canvas shadows camera={{ position: [0, 1.3, 4.6], fov: 40 }}
          gl={{ preserveDrawingBuffer: true }} style={{ position: 'absolute', inset: 0 }}>
          <SceneLights shadows />
          <SceneEnv />
          <SceneBackground colour={DESIGNER_GROUND} />
          <OrbitControls enablePan={false} makeDefault target={[0, 0.35, 0]} />

          {/* The cake, and it is not scenery: these panels are cut to the tier's own height and hang
              from its rim, so there is nothing to judge without the wall they hang on. */}
          {shapeKey === 'round' ? (
            <mesh receiveShadow castShadow>
              <cylinderGeometry args={[TIER.radius, TIER.radius, TIER.height, 72]} />
              <meshStandardMaterial color="#FAF5EE" roughness={0.92} />
            </mesh>
          ) : (
            <mesh receiveShadow castShadow>
              <boxGeometry args={[SHAPES.sheet.halfW * 2, TIER.height, SHAPES.sheet.halfD * 2]} />
              <meshStandardMaterial color="#FAF5EE" roughness={0.92} />
            </mesh>
          )}

          <Skirt shape={SHAPES[shapeKey]} p={p} />
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
      <b style={{ color: '#1a1a1a' }}>{int ? v : Number(v).toFixed(2)}</b></span>
    <input type="range" min={min} max={max} step={step} value={v} style={{ width: '100%' }}
      onChange={e => on(int ? parseInt(e.target.value, 10) : parseFloat(e.target.value))} />
    {hint && <span style={{ fontSize: 10, color: '#9a9a9a', lineHeight: 1.4, display: 'block' }}>{hint}</span>}
  </label>
);
