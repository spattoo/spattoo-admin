import React, { useMemo, useRef, useState, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment, Lightformer } from '@react-three/drei';
import * as THREE from 'three';
import { applyBands, bandColors, bandBoundaries, blendWidth, MAX_BANDS } from './bandFrosting.js';
import { getCreamGrainNormalMap } from '../lib/creamWaveTexture.js';

/* ── Band Frosting Studio ────────────────────────────────────────────────────────────────────────
 *
 * Prove multi-colour horizontal bands on a frosted wall BEFORE porting to core.
 *
 * The designer can already do a two/three-stop ombre (gradientMaterial's `vertical` mode) and it can
 * do ribbed piping — but ribbing is a piping TEXTURE, not colour, so neither reaches the look in the
 * reference photos: several colours stacked up the side of the cake, scraped smooth.
 *
 * ── WHAT THIS IS ACTUALLY FOR ───────────────────────────────────────────────────────────────────
 * Not "does a shader work" — that was never in doubt. The open questions are the ones only an eye
 * can answer, and each has a control here rather than a number baked into the source:
 *
 *   · Where does `softness` stop reading as "bands" and start reading as "ombre", and is there a
 *     usable range in between? If not, the two really are separate features and this design is wrong.
 *   · Do hard edges survive the cake's own grain normal map, or does the join fizz?
 *   · Does a wall need the wobble to look iced rather than printed — and at what amount does it stop
 *     looking hand-scraped and start looking like a fault?
 *   · How many bands before it turns to mud on a real tier height?
 *
 * The four presets are the four reference photos. If the studio can reproduce all four, the design
 * covers the brief; if a preset needs a control that is not here, that IS the finding.
 *
 * Nothing is saved. A frosting treatment is code, not a cake_element, so the output is the config
 * block at the bottom — the same shape TierBody will take.
 */

// The cake, matching GlazeStudio so the two studios are looking at the same object.
const R = 1.2, WALL_H = 1.45, BOARD_H = 0.1, BOARD_R = 1.6;
// CakeTier.jsx's own constant. Copied, not chosen — see the grain map below.
const GRAIN_TILES_PER_UNIT = 16;

/* Core's buttercream, copied from spattoo-core/src/designer/frostings.js.
 *
 * ⚠️ Copied ON PURPOSE and it matters: bands are judged by eye, and judging them under a prettier
 * material than the designer actually uses would approve a look that then arrives dull. Buttercream
 * is deliberately matte (roughness 0.95, no sheen, no clearcoat) — that is a measured decision over
 * there about decal saturation, not an oversight to improve on here. */
const BUTTERCREAM = {
  roughness: 0.95, metalness: 0, sheen: 0, sheenRoughness: 0.55, sheenColor: '#fff3e0',
  clearcoat: 0, clearcoatRoughness: 0.45, envMapIntensity: 0.65,
};

/* The four reference photos, as configs. Colours sampled from the images; listed BASE → TOP, which is
 * the direction the shader reads and the direction a baker ices in. */
const PRESETS = {
  pastel: {
    label: 'Pastel rainbow',
    /* ⚠️ 0.5, not 0.95, and this is the studio earning its keep.
     * It was set to 0.95 on the reasoning that a pastel cake is "soft". Rendered next to the photo
     * that is plainly wrong: at 0.95 the bands stop existing and it becomes a single wash, whereas
     * the reference has six clearly separate colours whose joins happen to be gentle. Soft COLOURS
     * are not a soft BLEND, and no amount of reading the source would have caught that. */
    note: 'Six pastels with gentle joins. The bands stay countable — soft colours, not a soft blend. Set this above ~0.7 and it collapses into one wash, which is a different cake.',
    palette: ['#C9AEE0', '#A9C8E8', '#B9E3C6', '#F6EAA8', '#F9C9A3', '#F3AEC0'], count: 6,
    softness: 0.5, wobble: 0.25, weights: [1, 1, 1, 1, 1, 1],
  },
  unicorn: {
    label: 'Unicorn (soft joins)',
    note: 'Six colours, scraped so the joins are visible but soft. The middle of the range, and the look most bakers will actually reach for.',
    palette: ['#C9A9D6', '#9FC7DE', '#BFE0C0', '#F5E3A1', '#F2B98A', '#D9646B'], count: 6,
    softness: 0.45, wobble: 0.3, weights: [1, 1, 1, 1, 1, 1],
  },
  sunset: {
    label: 'Sunset ombre (3)',
    note: 'Three colours, fully blended — the classic ombre, and the far end of the slider. Proves the existing vertical gradient is just this with count 3 and softness 1, which is the case for merging the two rather than shipping both.',
    palette: ['#F7DE8E', '#F4A98C', '#EE9BB0'], count: 3,
    softness: 1, wobble: 0.15, weights: [1, 1, 1],
  },
  stripes: {
    label: 'Football stripes (2)',
    /* The case that broke the original model. Two colours and sixteen bands — a "repeat" multiplier
     * could reach 16, but not 15 or 17, and an ODD count is what puts the same colour top and bottom
     * on a striped cake. The palette cycles into a count instead. */
    note: 'Two colours, sixteen thin stripes. Try an odd count — 15 or 17 — to get the same colour at the top and the bottom, which a repeat multiplier cannot express.',
    palette: ['#FFFFFF', '#A8D96B'], count: 16,
    softness: 0.18, wobble: 0.3, weights: [1, 1],
  },
  rainbow: {
    label: 'Rainbow (hard edges)',
    note: 'Six saturated stripes, crisp. The case that breaks if the blend maths cannot reach a true zero — watch the joins for fizz against the grain normal.',
    palette: ['#8E5AA8', '#3F6FD0', '#3FA55B', '#F2D33F', '#EE8B2E', '#D8392F'], count: 6,
    softness: 0.04, wobble: 0.08, weights: [1, 1, 1, 1, 1, 1],
  },
};

const clamp01 = v => Math.max(0, Math.min(1, v));

// ── The cake ────────────────────────────────────────────────────────────────────────────────────
function BandedCake({ bands, topColor, grain }) {
  const wallRef = useRef();
  const matRef  = useRef();

  const wallGeo = useMemo(() => {
    // openEnded: the top is its own disc so it can stay a single colour, the way a real cake's top is
    // iced separately from its sides.
    const g = new THREE.CylinderGeometry(R, R, WALL_H, 128, 64, true);
    g.translate(0, WALL_H / 2, 0);
    g.computeBoundingBox();
    return g;
  }, []);

  const bbox = useMemo(() => {
    const bb = wallGeo.boundingBox;
    const size = new THREE.Vector3();   bb.getSize(size);
    const center = new THREE.Vector3(); bb.getCenter(center);
    return { min: bb.min.clone(), size, center };
  }, [wallGeo]);

  /* The REAL cream grain, so hard edges are judged against the surface they will actually sit on.
   *
   * ⚠️ This was a hand-rolled noise function with a `sin(y * 7.3)` term in it, and it produced a
   * regular comb ripple right across the wall — corduroy, not buttercream. It looked like a defect in
   * the band shader and was nothing of the kind; the bands underneath were clean the whole time.
   *
   * The lesson is the one this studio is built on: invent nothing that already exists. Core ices its
   * walls with getCreamGrainNormalMap, admin already carries it for cream-preview.html, and a grain
   * made up for the studio can only mislead about a look the studio exists to judge.
   *
   * Toggleable, because a crisp join on a mirror-smooth cylinder always looks clean and the question
   * is whether it survives a bumpy one. */
  const grainMap = useMemo(() => {
    const t = getCreamGrainNormalMap().clone();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    /* ⚠️ 16 tiles per world unit — CakeTier's GRAIN_TILES_PER_UNIT, not a number of my own.
     * I first put 2.2 here, which is seven times coarser: the grain blobs came out big enough to
     * smear the joins, and the wall read as blurry. Twice now the studio has misled by inventing a
     * material constant instead of reading the one core uses. */
    t.repeat.set(
      Math.max(4, Math.round(2 * Math.PI * R * GRAIN_TILES_PER_UNIT)),
      Math.max(3, Math.round(WALL_H * GRAIN_TILES_PER_UNIT)),
    );
    /* Anisotropic filtering, because this is a CURVED wall.
     * At 120 tiles around the cake the grain is heavily minified towards the silhouette, where each
     * screen pixel covers many texels. Trilinear alone picks an over-blurred mip there and the
     * texture turns to mush across exactly the part of the cake you are looking at edge-on. */
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  }, []);

  useEffect(() => { applyBands(matRef.current, bands, bbox); }, [bands, bbox]);

  return (
    <group>
      <mesh position={[0, BOARD_H - BOARD_H / 2, 0]}>
        <cylinderGeometry args={[BOARD_R, BOARD_R, BOARD_H, 72]} />
        <meshStandardMaterial color="#d9b44a" metalness={0.5} roughness={0.4} />
      </mesh>

      {/* ⚠️ castShadow but NOT receiveShadow, and this was the "comb ripples".
          A cylinder lit from above self-shadows against its own triangulation, and with 128×64
          segments the acne lands as a fine diagonal moiré right across the wall. It looked for all
          the world like a defect in the band shader — it survived turning the bands off, the wobble
          off and the grain off, which is how it was finally cornered.
          The wall still casts onto the board, which is the only shadow that reads anyway. */}
      <mesh ref={wallRef} position={[0, BOARD_H, 0]} geometry={wallGeo} castShadow>
        <meshPhysicalMaterial ref={matRef} color="#ffffff" side={THREE.DoubleSide}
          {...BUTTERCREAM}
          normalMap={grain > 0 ? grainMap : null}
          normalScale={[grain, grain]} />
      </mesh>

      {/* The top, iced separately — a single colour, as in every reference photo. */}
      <mesh position={[0, BOARD_H + WALL_H, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[R, 128]} />
        <meshPhysicalMaterial color={topColor} {...BUTTERCREAM} />
      </mesh>
    </group>
  );
}

// ── Controls ────────────────────────────────────────────────────────────────────────────────────
const lbl = { fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', color: '#9b7f88', marginBottom: 6 };
const card = { background: '#fff', border: '1px solid #eadfe3', borderRadius: 12, padding: 14, marginBottom: 12 };

function Slider({ label, value, onChange, min = 0, max = 1, step = 0.01, hint }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={lbl}>{label}</span>
        <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: '#7a6069' }}>{value.toFixed(2)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
             onChange={e => onChange(parseFloat(e.target.value))} style={{ width: '100%' }} />
      {hint && <div style={{ fontSize: 11, color: '#9b8189', lineHeight: 1.5, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

export default function BandFrostingStudio() {
  const [presetKey, setPresetKey] = useState('unicorn');
  const [palette, setPalette] = useState(PRESETS.unicorn.palette);
  const [count, setCount]     = useState(PRESETS.unicorn.count);
  const [weights, setWeights] = useState(PRESETS.unicorn.weights);
  const [softness, setSoftness] = useState(PRESETS.unicorn.softness);
  const [wobble, setWobble]     = useState(PRESETS.unicorn.wobble);
  /* ⚠️ DEFAULT 0 — no grain at all.
   *
   * The brief was multi-colour bands. The grain was my own addition, on the reasoning that hard
   * edges should be judged against a bumpy wall rather than a mirror — which is a fair thought and
   * still available on the slider, but it was never asked for and it dominated the render. At 120
   * tiles around the cake it also streaks: the horizontal detail falls far below pixel size and
   * filtering blurs it away, leaving the vertical tiling as a fine comb across the wall.
   *
   * So it starts OFF and it is a dial, not a checkbox. The bands are the feature; the surface it sits
   * on is a separate judgement, and the person making it should be the one who sets it. */
  const [grain, setGrain] = useState(0);
  const [topFromTopBand, setTopFromTopBand] = useState(true);
  const [topColor, setTopColor] = useState('#FFFFFF');

  const loadPreset = key => {
    const p = PRESETS[key];
    setPresetKey(key);
    setPalette(p.palette); setCount(p.count); setWeights(p.weights);
    setSoftness(p.softness); setWobble(p.wobble);
  };

  const bands = useMemo(
    () => ({ palette, count, weights, softness, wobble }),
    [palette, count, weights, softness, wobble],
  );

  const expanded = bandColors(bands);
  const edges = bandBoundaries(count, weights);
  const blend = blendWidth(softness, count, weights);
  const resolvedTop = topFromTopBand ? expanded[expanded.length - 1] : topColor;

  const setColorAt = (i, v) => setPalette(cs => cs.map((c, j) => (j === i ? v : c)));
  const setWeightAt = (i, v) => setWeights(ws => ws.map((w, j) => (j === i ? v : w)));
  const addColor = () => {
    if (palette.length >= 8) return;
    setPalette(cs => [...cs, cs[cs.length - 1]]);
    setWeights(ws => [...ws, 1]);
    // Keep one-band-per-colour while the palette is small, so adding a colour to the rainbow does
    // what it looks like it should. Once somebody has deliberately set a bigger count, leave it be.
    setCount(c => (c === palette.length ? c + 1 : c));
  };
  const removeColor = () => {
    if (palette.length <= 2) return;
    setPalette(cs => cs.slice(0, -1));
    setWeights(ws => ws.slice(0, -1));
    setCount(c => (c === palette.length ? c - 1 : c));
  };

  const config = JSON.stringify({ bands: { palette, count, weights, softness: +softness.toFixed(2), wobble: +wobble.toFixed(2) } }, null, 2);

  return (
    <div style={{ minHeight: '100vh', background: '#f7f2f4', fontFamily: "'Quicksand', system-ui, sans-serif", color: '#3b2b31' }}>
      <div style={{ padding: '18px 22px 8px' }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>Band Frosting Studio</h1>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: '#7a6069', maxWidth: 780, lineHeight: 1.6 }}>
          Several colours stacked up the side of the cake, scraped smooth. <b>Softness</b> is the whole
          idea: at 0 the joins are crisp stripes, at 1 each join blends across a full band and it
          becomes an ombre. Bands and ombre are one feature, not two.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 380px) 1fr', gap: 16, padding: 16, alignItems: 'start' }}>
        <div>
          <div style={card}>
            <div style={lbl}>Start from a reference cake</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {Object.entries(PRESETS).map(([k, p]) => (
                <button key={k} onClick={() => loadPreset(k)}
                  style={{ padding: '7px 11px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                           fontFamily: 'inherit',
                           border: `1.5px solid ${presetKey === k ? '#9b5f72' : '#e2d5da'}`,
                           background: presetKey === k ? '#9b5f72' : '#fff',
                           color: presetKey === k ? '#fff' : '#6b5058' }}>
                  {p.label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11.5, color: '#9b8189', lineHeight: 1.55, marginTop: 10 }}>
              {PRESETS[presetKey]?.note}
            </div>
          </div>

          <div style={card}>
            <Slider label="Softness" value={softness} onChange={setSoftness}
                    hint="How much of a band each join eats. Scaled by the THINNEST band, so it means the same thing whether there are three colours or eight." />
            <Slider label="Scraper wobble" value={wobble} onChange={setWobble}
                    hint="Real joins are not spirit-levelled. Enough of this reads as hand-iced; too much reads as a mistake." />
            <Slider label="Frosting grain" value={grain} onChange={setGrain}
                    hint="Off by default — the bands are the feature and this is only the surface under them. Dial it up to judge how hard edges hold against a textured wall; past about 0.3 the tiling starts to read as a comb across the cake." />
          </div>

          <div style={card}>
            <div style={lbl}>Palette — first entry is the BOTTOM of the cake</div>
            <div style={{ fontSize: 11.5, color: '#9b8189', lineHeight: 1.5, marginBottom: 8 }}>
              The palette repeats up the cake to fill the band count below. Two colours and sixteen
              bands is a striped cake; six and six is one band per colour.
            </div>
            {palette.map((c, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: '#9b8189', width: 52 }}>
                  {i === 0 ? 'base' : `#${i + 1}`}
                </span>
                <input type="color" value={c} onChange={e => setColorAt(i, e.target.value)}
                       style={{ width: 44, height: 30, border: '1px solid #e2d5da', borderRadius: 6, background: '#fff', cursor: 'pointer' }} />
                <input type="text" value={c} onChange={e => setColorAt(i, e.target.value)}
                       style={{ width: 84, fontFamily: 'inherit', fontSize: 12, padding: '5px 7px', border: '1px solid #e2d5da', borderRadius: 6 }} />
                <input type="range" min={0.4} max={3} step={0.1} value={weights[i] ?? 1}
                       onChange={e => setWeightAt(i, parseFloat(e.target.value))}
                       title="How thick this band is relative to the others" style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: '#9b8189', width: 26, fontVariantNumeric: 'tabular-nums' }}>
                  {(weights[i] ?? 1).toFixed(1)}
                </span>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button onClick={addColor} disabled={palette.length >= 8}
                style={{ flex: 1, padding: '7px', borderRadius: 8, border: '1px solid #e2d5da', background: '#fff', cursor: palette.length >= 8 ? 'default' : 'pointer', opacity: palette.length >= 8 ? 0.5 : 1, fontFamily: 'inherit', fontWeight: 700, fontSize: 12 }}>
                Add colour
              </button>
              <button onClick={removeColor} disabled={palette.length <= 2}
                style={{ flex: 1, padding: '7px', borderRadius: 8, border: '1px solid #e2d5da', background: '#fff', cursor: palette.length <= 2 ? 'default' : 'pointer', opacity: palette.length <= 2 ? 0.5 : 1, fontFamily: 'inherit', fontWeight: 700, fontSize: 12 }}>
                Remove colour
              </button>
            </div>

            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #f0e6ea' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={lbl}>How many bands</span>
                <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: '#7a6069' }}>{count}</span>
              </div>
              <input type="range" min={2} max={MAX_BANDS} step={1} value={count}
                     onChange={e => setCount(parseInt(e.target.value, 10))} style={{ width: '100%' }} />
              <div style={{ fontSize: 11, color: '#9b8189', lineHeight: 1.5, marginTop: 4 }}>
                {count === palette.length
                  ? 'One band per colour.'
                  : `The ${palette.length} colours repeat ${(count / palette.length).toFixed(1)}× up the cake.`}
                {' '}An <b>odd</b> count with an even palette puts the same colour top and bottom.
              </div>
            </div>

            <div style={{ fontSize: 11, color: '#9b8189', marginTop: 10, lineHeight: 1.5 }}>
              joins at {edges.length > 6 ? `${edges.length} evenly spaced` : (edges.map(e => e.toFixed(2)).join(', ') || '—')} · blend width {blend.toFixed(3)}
            </div>
            {/* The swatch strip IS the cake, read bottom-up. Faster to check than counting joins on
                the render, and it catches a palette that cycles to the wrong colour at the top. */}
            <div style={{ display: 'flex', flexDirection: 'column-reverse', height: 54, marginTop: 8, borderRadius: 6, overflow: 'hidden', border: '1px solid #eadfe3' }}>
              {expanded.map((c, i) => <div key={i} style={{ flex: weights[i % weights.length] ?? 1, background: c }} />)}
            </div>
          </div>

          <div style={card}>
            <div style={lbl}>The top</div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={topFromTopBand} onChange={e => setTopFromTopBand(e.target.checked)} />
              Match the top band
            </label>
            {!topFromTopBand && (
              <input type="color" value={topColor} onChange={e => setTopColor(e.target.value)}
                     style={{ marginTop: 8, width: 44, height: 30, border: '1px solid #e2d5da', borderRadius: 6, background: '#fff', cursor: 'pointer' }} />
            )}
            <div style={{ fontSize: 11, color: '#9b8189', marginTop: 6, lineHeight: 1.5 }}>
              A real cake's top is iced separately from its sides, so it is a flat colour rather than a
              continuation of the bands.
            </div>
          </div>

          <div style={card}>
            <div style={lbl}>Config for core</div>
            <pre style={{ margin: 0, fontSize: 11, background: '#faf6f7', border: '1px solid #eee2e6', borderRadius: 8, padding: 10, overflowX: 'auto', lineHeight: 1.5 }}>{config}</pre>
            <button onClick={() => navigator.clipboard?.writeText(config)}
              style={{ marginTop: 8, width: '100%', padding: '8px', borderRadius: 8, border: 'none', background: '#9b5f72', color: '#fff', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700, fontSize: 12.5 }}>
              Copy config
            </button>
          </div>
        </div>

        <div style={{ position: 'sticky', top: 16, height: 'calc(100vh - 32px)', background: '#efe7ea', borderRadius: 14, overflow: 'hidden' }}>
          <Canvas gl={{ preserveDrawingBuffer: true }} shadows camera={{ position: [0, 2.6, 4.6], fov: 40 }}>
            <color attach="background" args={['#efe7ea']} />
            <ambientLight intensity={0.5} />
            {/* normalBias as well as the receiveShadow removal above: belt and braces, since anything
                added to this scene later will otherwise inherit the same acne. */}
            <directionalLight position={[3, 6, 4]} intensity={1.1} castShadow
                              shadow-normalBias={0.04} shadow-bias={-0.0005} />
            <Environment resolution={256}>
              <Lightformer form="ring" intensity={2.0} position={[0, 8, 1]} rotation={[-Math.PI / 2, 0, 0]} scale={[14, 14, 1]} />
              <Lightformer form="rect" intensity={2.2} position={[2.8, 3.6, 5]} scale={[2.4, 8, 1]} color="#ffffff" />
              <Lightformer form="rect" intensity={2.0} position={[-3.4, 3.6, 3.6]} scale={[2.2, 8, 1]} color="#ffffff" />
            </Environment>
            <BandedCake bands={bands} topColor={resolvedTop} grain={grain} />
            <OrbitControls target={[0, 0.85, 0]} enablePan={false} minDistance={2.4} maxDistance={9} />
          </Canvas>
        </div>
      </div>
    </div>
  );
}
