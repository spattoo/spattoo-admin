import { useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import {
  SceneLights, SceneEnv, SceneBackground, DESIGNER_GROUND,
  buildWaferSkirt, WAFER_DEFAULTS, WAFER_PAPER_MATERIAL, waferFibreTexture,
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

/* ── Backdrops, and why this control exists at all ────────────────────────────────────────────────
 * Sandeep: *"everything looks white and so much glaring. cant see cake and wafer."*
 *
 * It is not the lighting. The rig here is core's own (SceneLights/SceneEnv) and admin's /cdn proxy
 * serves byte-for-byte the same HDRI core's harness does — both checked. It is not the material
 * either: dropping transmission from 0.45 to 0.18 moved measured contrast by 0.000.
 *
 * It is CONTRAST, and the number is brutal. White paper on a white cake against DESIGNER_GROUND
 * reads 0.064 — (p95−p5)/mean, the reading INVARIANTS 18c uses, where a surface nobody has ever
 * called dull sits at 0.463. On a darker ground the same frame reads 0.300; in pink, 0.176.
 *
 * ⚠️ WHICH IS A FACT ABOUT THE CAKE, NOT ABOUT THIS SCREEN, so the default stays DESIGNER_GROUND.
 * CardCutoutStudio already made the other choice — it switched to a mid grey so a white card would
 * read, and its own note calls that fixing a symptom in a surface that does not exist on a cake.
 * The darker backdrops here are labelled as what they are: a way to answer "is that the cake or the
 * backdrop?" in one click, and then go back. Every reference photograph solves this in the cake
 * rather than in the room — berries, strawberries, a dark board, a grey wall behind. */
const BACKDROPS = {
  'Designer (real)': DESIGNER_GROUND,
  'Warm':            '#d8cfc4',
  'Mid':             '#b9b0a6',
  'Dark':            '#6f6862',
};
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
    hem: 'notch', notch: 0.18, colour: '#f2766d' },
  'White, waved':      { count: 34, width: 2.3, height: 0.95, rise: 0.04, taper: 0.18, ripple: 0.30,
    ripples: 6.0, sway: 0.10, curl: 0.22, splay: 0.08, lean: 0.05, jitter: 0.45,
    hem: 'straight', notch: 0.10, colour: '#fbf7f2' },
  'White, rippled':    { count: 44, width: 2.0, height: 0.92, rise: 0.02, taper: 0.22, ripple: 0.26,
    ripples: 8.0, sway: 0.12, curl: 0.18, splay: 0.08, lean: 0.03, jitter: 0.50,
    hem: 'torn', notch: 0.12, colour: '#fdfbf7' },
  'White, broad':      { count: 20, width: 2.4, height: 0.98, rise: 0.06, taper: 0.06, ripple: 0.24,
    ripples: 3.0, sway: 0.06, curl: 0.30, splay: 0.06, lean: 0.02, jitter: 0.35,
    hem: 'straight', notch: 0.10, colour: '#ffffff' },
};

function Skirt({ shape, p }) {
  // Generated, not shipped: it is noise, and a procedural one scales to any panel without UVs.
  const fibre = useMemo(() => waferFibreTexture({ strength: p.fibre }), [p.fibre]);
  const geom = useMemo(() => buildWaferSkirt({ shape, tierHeight: TIER.height, ...p }), [shape, p]);
  if (!geom) return null;
  return (
    <mesh geometry={geom} position={[0, TIER.height / 2, 0]} castShadow receiveShadow>
      {/* ⚠️ DoubleSide: a sheet of paper has no back. Single-sided, every panel on the far side of
          the cake vanishes the moment it turns — and that is half of them at any angle.

          ⚠️ AND NO `transparent` / `opacity` WHILE TRANSMISSION IS ON. Sandeep, on the first
          render: "may be geometrically fine, but it does not look like wafer paper." He was right
          and the geometry was not the fault: setting that pair puts the mesh on the alpha-blended
          path, so every pixel becomes a flat lerp toward what is behind it and the transmission is
          thrown away. Two overlapping panels came out the same flat pink instead of getting denser
          where they cross, which is the single most paper-like thing about the references.
          The numbers live in core's WAFER_PAPER_MATERIAL so this studio and the cake agree. */}
      <meshPhysicalMaterial
        color={p.colour} side={THREE.DoubleSide}
        roughness={p.roughness} transmission={p.transmission}
        thickness={p.thickness} ior={WAFER_PAPER_MATERIAL.ior}
        sheen={p.sheen} sheenRoughness={WAFER_PAPER_MATERIAL.sheenRoughness}
        sheenColor="#ffffff" specularIntensity={p.specular}
        roughnessMap={p.fibre > 0 ? fibre : null}
        metalness={0} />
    </mesh>
  );
}

export default function WaferPaperStudio() {
  const [preset, setPreset] = useState('White, waved');
  const [shapeKey, setShapeKey] = useState('round');
  const [backdrop, setBackdrop] = useState('Designer (real)');
  /* ⚠️ ON BY DEFAULT, because it is how the technique is used. Sandeep: "usually wafer paper is
     used with same color as the cake." The skirt is a TEXTURE on the cake, not a contrasting trim,
     and pairing white paper with a cream tier — which is what this studio did — judges a cake
     nobody makes. Off when you deliberately want the two-tone look (reference 1 is pink on cream). */
  const [matchCake, setMatchCake] = useState(true);
  const [p, setP] = useState({ ...WAFER_DEFAULTS, ...PRESETS['White, waved'], seed: 7,
                               ...WAFER_PAPER_MATERIAL });
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
        <Row label="Cake">
          <Btn on={matchCake} onClick={() => setMatchCake(true)}>same colour as the paper</Btn>
          <Btn on={!matchCake} onClick={() => setMatchCake(false)}>contrasting</Btn>
        </Row>
        <Row label="Backdrop — for judging, not the product">
          {Object.keys(BACKDROPS).map(k => (
            <Btn key={k} on={backdrop === k} onClick={() => setBackdrop(k)}>{k}</Btn>
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
        <Sl label="Shingle"   v={p.shingle} min={0} max={0.06} step={0.002} on={set('shingle')}
            hint="Each sheet sits a little further out than the last, like roof tiles, so they have a front-to-back order." />
        <Sl label="Nest"      v={p.nest} min={0} max={1} step={0.05} on={set('nest')}
            hint="Ridge into valley. At 0 each sheet creases independently and they pass through one another." />
        <Sl label="Jitter"    v={p.jitter} min={0} max={1} step={0.02} on={set('jitter')}
            hint="How much the strips differ. At 0 the eye finds the repeat." />
        <Sl label="Seed"      v={p.seed}   min={1} max={40} step={1} on={set('seed')} int />

        <H>The paper</H>
        <Sl label="Translucency" v={p.transmission} min={0} max={1} step={0.02} on={set('transmission')}
            hint="At 0 it reads as painted card. This is the control that decides whether it looks like paper." />
        <Sl label="Diffusion"    v={p.thickness} min={0.01} max={0.5} step={0.01} on={set('thickness')}
            hint="How far light travels inside the sheet before it scatters out." />
        <Sl label="Roughness"    v={p.roughness} min={0.2} max={1} step={0.02} on={set('roughness')}
            hint="High, with transmission high, is what makes a glow rather than glass." />
        <Sl label="Sheen"        v={p.sheen} min={0} max={1} step={0.02} on={set('sheen')}
            hint="The cloth lobe — a broad highlight instead of a plastic dot." />
        <Sl label="Specular"     v={p.specular} min={0} max={1} step={0.02} on={set('specular')} />
        <Sl label="Grain"        v={p.fibre} min={0} max={1} step={0.02} on={set('fibre')}
            hint="Pressed starch has a visible fibre." />
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
          <SceneBackground colour={BACKDROPS[backdrop]} />
          <OrbitControls enablePan={false} makeDefault target={[0, 0.35, 0]} />

          {/* The cake, and it is not scenery: these panels are cut to the tier's own height and hang
              from its rim, so there is nothing to judge without the wall they hang on. */}
          {shapeKey === 'round' ? (
            <mesh receiveShadow castShadow>
              <cylinderGeometry args={[TIER.radius, TIER.radius, TIER.height, 72]} />
              <meshStandardMaterial color={matchCake ? p.colour : '#FAF5EE'} roughness={0.92} />
            </mesh>
          ) : (
            <mesh receiveShadow castShadow>
              <boxGeometry args={[SHAPES.sheet.halfW * 2, TIER.height, SHAPES.sheet.halfD * 2]} />
              <meshStandardMaterial color={matchCake ? p.colour : '#FAF5EE'} roughness={0.92} />
            </mesh>
          )}

          <Skirt shape={SHAPES[shapeKey]} p={p} />

          {/* ⚠️ THE FLOOR IS NOT SCENERY — it is the only surface that can RECEIVE the key light's
              shadow, and this studio shipped without one. A lit object casting into nothing reads
              flat however right its colour is, which is the note CardCutoutStudio already carries.
              It is not what caused the glare (measured: the backdrop was), but it was missing. */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -TIER.height / 2, 0]} receiveShadow>
            <circleGeometry args={[7, 48]} />
            <meshStandardMaterial color={BACKDROPS[backdrop]} roughness={1} />
          </mesh>
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
