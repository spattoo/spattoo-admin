import { useState, useMemo, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
/* The surface is built by CORE's function, not by a copy living here. CakeTier will build the
 * customer's own tier top with this exact call, so this preview and the cake cannot drift
 * (INVARIANTS #15). The older studios in this folder each carry a prototype copy of their geometry
 * with a note saying it "ports to spattoo-core verbatim"; that is the pattern this one does not
 * follow, because the geometry already exists in core with its own tests. */
import {
  buildTopSurface, CAVITY_DEFAULTS, SPIRAL_DEFAULTS, SPIRAL_RISE, SizeDial,
  SceneLights, SceneEnv, SceneBackground, DESIGNER_GROUND,
} from '@spattoo/designer';

/* ── The tier top: a scraped edge and a turntable spiral — PROOF OF CONCEPT ──────────────────────
 *
 * Two things a baker does to the top of a finished cake, chosen independently:
 *
 *   Scraped edge — cream pushed up into a rounded ridge all the way round the rim, leaving the
 *                  middle lower. Works on any footprint; a scraper walks any perimeter.
 *   Spiral       — the mark a palette knife leaves when it is set in the middle of a smoothed top
 *                  and the turntable is spun, ploughing cream into a raised coil. Round tiers only,
 *                  because a turntable cannot spin a rectangle.
 *
 * Sandeep: *"so spiral is an option user can select separately. so both edge elevation, spiral can
 * individually be selected."*
 *
 * ⚠️ TWO SELECTIONS, ONE MESH, and that is not a contradiction. They are two tools on one sheet of
 * cream — the spiral runs across the floor the ridge encloses. Built as separate meshes they would
 * z-fight wherever both were chosen, and the spiral could not meet the ridge's inner edge without
 * gaps, because that edge wobbles by design and a disc does not. `buildTopSurface` takes both and
 * returns one geometry; see topCavity.js in core for the whole argument.
 *
 * ⚠️ WHAT THIS IS NOT, YET. It does not save anything — it is a place to look at the geometry and
 * turn its knobs. The scraped edge is already wired into the real tier panel (STYLE → TOP EDGE);
 * the spiral is not yet.
 *
 * ⚠️ AND IT IS THE SAME COLOUR AS THE TIER, WHICH IS NOT A DETAIL. This is not a decoration sitting
 * on a cake, it is the cake's own cream pushed about. One material, or the ring reads as a separate
 * object balanced on the rim.
 */

/* The designer's own bottom tier, so everything is judged at the scale a customer sees — the same
   numbers ChocolateDripStudio and SecondCreamLayerStudio use. */
const R = 1.2, BOTTOM_H = 1.45, BOARD_H = 0.1, BOARD_R = 1.6;
const TOP_Y = BOARD_H + BOTTOM_H;

const ROUND = { kind: 'round', radius: R };
const RECT = { kind: 'rect', halfW: 1.35, halfD: 0.92, cornerR: 0.24 };

function Switch({ on, onChange, label, hint, disabled = false }) {
  return (
    <button type="button" onClick={() => !disabled && onChange(!on)} aria-pressed={on}
      disabled={disabled}
      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
               padding: '10px 12px', marginBottom: 10, borderRadius: 10, minHeight: 44,
               cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1,
               fontFamily: 'inherit',
               border: `1.5px solid ${on ? '#2C4433' : '#D8D3CA'}`,
               background: on ? '#2C4433' : '#fff' }}>
      <span style={{ width: 15, height: 15, borderRadius: 4, flexShrink: 0,
                     border: `1.5px solid ${on ? '#fff' : '#B9B3A8'}`,
                     background: on ? '#fff' : 'transparent' }} />
      <span>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 800, color: on ? '#fff' : '#2C4433' }}>{label}</span>
        <span style={{ display: 'block', fontSize: 10.5, color: on ? '#C9D6CE' : '#8a8a8a' }}>{hint}</span>
      </span>
    </button>
  );
}

function Tier({ shape, rim, spiral, lip, turns, rise, seed, colour }) {
  const surface = useMemo(() => buildTopSurface(shape, BOTTOM_H, {
    cavity: rim ? { ...CAVITY_DEFAULTS, lip, seed } : null,
    spiral: spiral ? { ...SPIRAL_DEFAULTS, turns, rise, seed: seed + 511 } : null,
  }), [shape, rim, spiral, lip, turns, rise, seed]);
  useEffect(() => () => surface?.dispose(), [surface]);

  const body = useMemo(() => (shape.kind === 'rect'
    ? new THREE.BoxGeometry(shape.halfW * 2, BOTTOM_H, shape.halfD * 2).translate(0, BOTTOM_H / 2, 0)
    : new THREE.CylinderGeometry(R, R, BOTTOM_H, 160).translate(0, BOTTOM_H / 2, 0)), [shape]);
  useEffect(() => () => body?.dispose(), [body]);

  /* ⚠️ ONE MATERIAL DESCRIPTOR, TWO MESHES. Two `meshStandardMaterial` tags with the same props are
     two materials, and they drift the moment either is tuned — which is exactly the failure this is
     meant to avoid, a ring that reads as a separate object. */
  const mat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: colour, roughness: 0.9, metalness: 0 }), [colour]);
  useEffect(() => () => mat?.dispose(), [mat]);

  return (
    <group position={[0, BOARD_H, 0]}>
      <mesh geometry={body} material={mat} castShadow receiveShadow />
      {surface && (
        <mesh geometry={surface} material={mat} position={[0, BOTTOM_H, 0]} castShadow receiveShadow />
      )}
    </group>
  );
}

export default function TopEdgeStudio() {
  const [round, setRound] = useState(true);
  const [rim, setRim] = useState(true);
  const [spiral, setSpiral] = useState(true);
  const [lip, setLip] = useState(CAVITY_DEFAULTS.lip);
  const [turns, setTurns] = useState(SPIRAL_DEFAULTS.turns);
  const [rise, setRise] = useState(SPIRAL_DEFAULTS.rise);
  /* A fresh number, not the next one. "Seed 8 after seed 7" invites the idea that they are ordered
     and that somewhere further along is a better one; they are just different hands. */
  const [seed, setSeed] = useState(CAVITY_DEFAULTS.seed);
  const [colour, setColour] = useState('#EFE3EA');

  const shape = round ? ROUND : RECT;
  const cap = { fontSize: 11, fontWeight: 800, color: '#6B8C74', letterSpacing: 0.4,
                textTransform: 'uppercase', margin: '18px 0 12px' };
  const row = { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 };

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'Quicksand, sans-serif',
                  background: '#EDEAE2' }}>
      <div style={{ width: 260, padding: '22px 20px', overflowY: 'auto', background: '#fff',
                    borderRight: '1.5px solid #E8E4DC' }}>
        <h1 style={{ fontSize: 17, fontWeight: 800, color: '#2C4433', margin: '0 0 4px' }}>Top Edge</h1>
        <p style={{ fontSize: 12, color: '#5C7565', margin: '0 0 18px', lineHeight: 1.5 }}>
          What a scraper and a palette knife leave on a finished top. Each is chosen on its own.
        </p>

        <Switch on={rim} onChange={setRim} label="Scraped edge" hint="cream heaped at the rim" />
        {/* ⚠️ THE SWITCH TELLS THE TRUTH ABOUT THE SHAPE. A turntable cannot spin a rectangle, so
            the spiral is round-tier only — and a control that turns on while nothing happens is
            worse than one that says why it cannot (root CLAUDE.md rule 7, and its converse). */}
        <Switch on={spiral && round} onChange={setSpiral} disabled={!round}
                label="Spiral" hint={round ? 'the turntable knife mark' : 'needs a round tier'} />

        <div style={{ ...cap, opacity: rim ? 1 : 0.35 }}>Scraped edge</div>
        <div style={{ ...row, opacity: rim ? 1 : 0.35, pointerEvents: rim ? 'auto' : 'none' }}>
          {/* The shared dial, not a range input — the root CLAUDE.md names it "THE size control". */}
          <SizeDial size={lip} min={0} max={0.18} step={0.005} onChange={setLip}
                    fmt={v => (v === 0 ? 'flat' : `${Math.round(v * 1000) / 10}`)} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: '#2C4433' }}>Height</div>
            <div style={{ fontSize: 11, color: '#8a8a8a' }}>how proud the ridge stands</div>
          </div>
        </div>

        <div style={{ ...cap, opacity: spiral && round ? 1 : 0.35 }}>Spiral</div>
        <div style={{ ...row, opacity: spiral && round ? 1 : 0.35,
                      pointerEvents: spiral && round ? 'auto' : 'none' }}>
          <SizeDial size={turns} min={2} max={10} step={1} onChange={setTurns} fmt={v => `${v}`} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: '#2C4433' }}>Turns</div>
            <div style={{ fontSize: 11, color: '#8a8a8a' }}>rings from the middle out</div>
          </div>
        </div>
        {/* ⚠️ A NARROW RANGE ON PURPOSE, and the ends are core's, not this screen's. Sandeep:
            *"usually there wont be too high spirals, so the range would be small. but adjustable."*
            SPIRAL_RISE comes from the same sweep that chose the default — under its floor the ridge
            is invisible, over its ceiling it stops reading as a knife mark. A dial that can reach a
            setting no cake has is not more useful, it is a way to get a worse cake. */}
        <div style={{ ...row, opacity: spiral && round ? 1 : 0.35,
                      pointerEvents: spiral && round ? 'auto' : 'none' }}>
          <SizeDial size={rise} min={SPIRAL_RISE.min} max={SPIRAL_RISE.max} step={SPIRAL_RISE.step}
                    onChange={setRise} fmt={v => `${Math.round(v * 1000) / 10}`} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: '#2C4433' }}>Height</div>
            <div style={{ fontSize: 11, color: '#8a8a8a' }}>how proud the coil stands</div>
          </div>
        </div>

        <div style={cap}>Both</div>
        {/* ⚠️ HEIGHT IS A DIAL AND IRREGULARITY IS A BUTTON, and the asymmetry is the point. Height
            is a quantity with a direction — more, less, and a baker knows which way they want it.
            The irregularity is not: nobody wants "seed 7" over "seed 8", they want to see another
            one. A dial over a seed would be a control whose numbers carry no meaning. */}
        <div style={row}>
          <button type="button" onClick={() => setSeed(1 + Math.floor(Math.random() * 9999))}
            style={{ padding: '11px 16px', minHeight: 44, borderRadius: 9, border: '1px solid #2C4433',
                     background: '#2C4433', color: '#fff', fontWeight: 800, fontSize: 12,
                     cursor: 'pointer', fontFamily: 'inherit' }}>
            Shuffle
          </button>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: '#2C4433' }}>Irregularity</div>
            <div style={{ fontSize: 11, color: '#8a8a8a' }}>one Shuffle moves both &middot; #{seed}</div>
          </div>
        </div>

        <div style={cap}>Tier</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {[['Round', true], ['Sheet', false]].map(([t, v]) => (
            <button key={t} type="button" onClick={() => setRound(v)} aria-pressed={round === v}
              style={{ flex: 1, minHeight: 44, borderRadius: 9, fontFamily: 'inherit', fontSize: 12,
                       fontWeight: 800, cursor: 'pointer',
                       border: `1.5px solid ${round === v ? '#2C4433' : '#D8D3CA'}`,
                       background: round === v ? '#2C4433' : '#fff',
                       color: round === v ? '#fff' : '#2C4433' }}>{t}</button>
          ))}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, fontSize: 12.5,
                        fontWeight: 700, color: '#3D5A44' }}>
          <input type="color" value={colour} onChange={e => setColour(e.target.value)}
                 style={{ width: 38, height: 30, border: 'none', background: 'none', padding: 0 }} />
          Cream colour
        </label>

        <p style={{ fontSize: 10.5, color: '#b29aa2', lineHeight: 1.5, marginTop: 14 }}>
          Width, crest, swells, wobble and the spiral&rsquo;s groove width were each chosen
          against the reference photographs — they are what make it read as cream rather than as a
          moulding, and they belong to an admin row rather than to a baker.
        </p>
      </div>

      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        {/* ⚠️ `shadows`, because the designer's canvas has it and SceneLights only casts when asked.
            A lit object with no shadow reads as flat however correct its colour is — and a raised
            ridge judged without the shadow under it is the one thing this screen exists to judge. */}
        <Canvas shadows camera={{ position: [0, 2.6, 3.4], fov: 34 }}
          gl={{ preserveDrawingBuffer: true }} style={{ position: 'absolute', inset: 0 }}>
          {/* ⚠️ THE DESIGNER'S OWN RIG AND GROUND, not a hand-rolled pair. A finish judged under a
              light no cake has ever had is a judgement about the wrong variable (INVARIANTS #17),
              and core sets its ground as a scene BACKGROUND, so it is in the render rather than
              being a colour painted behind a transparent canvas. The environment matches as well
              now — `src/scene.js` configures the assets base, so SceneEnv gets the self-hosted
              outdoor map rather than drei's indoor preset. */}
          <SceneLights shadows />
          <SceneEnv />
          <SceneBackground colour={DESIGNER_GROUND} />
          {/* Looking DOWN, because the subject is the TOP. A camera at eye level photographs the
              wall: the ridge shows as a hairline against the sky and the spiral not at all. */}
          <OrbitControls enablePan={false} makeDefault target={[0, TOP_Y * 0.62, 0]} />
          <mesh position={[0, BOARD_H / 2, 0]} receiveShadow castShadow>
            <cylinderGeometry args={[BOARD_R, BOARD_R, BOARD_H, 72]} />
            <meshStandardMaterial color="#d9b44a" metalness={0.5} roughness={0.4} />
          </mesh>
          <Tier shape={shape} rim={rim} spiral={spiral && round} lip={lip} turns={turns}
                rise={rise} seed={seed} colour={colour} />
        </Canvas>
      </div>
    </div>
  );
}
