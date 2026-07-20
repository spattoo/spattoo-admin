import React, { useMemo, useRef, useState, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment, Lightformer, MeshTransmissionMaterial, ContactShadows } from '@react-three/drei';
import * as THREE from 'three';
import { buildSplashCrown, SPLASH_DEFAULTS } from './isomalt/splashCrown.js';
import { makeStylizedGlass, updateStylizedRim } from './isomalt/isomaltGlass.js';

// Isomalt Studio — tune the procedural splash-crown shape + amber-glass finish before porting to core.
// STYLIZED is the mobile-targeted look we'll ship; PHYSICAL is the reference to match. Pure look-tuning
// (persists no config) — the allowed admin-local calibrator exception. "Copy JSON" grabs the tuned set.

const S = {
  page:  { minHeight: '100vh', background: '#EDEAE2', fontFamily: 'Quicksand, sans-serif', padding: '28px 24px' },
  title: { fontSize: 22, fontWeight: 800, color: '#2C4433' },
  sub:   { fontSize: 13, color: '#7A8F80', marginBottom: 18 },
  layout:{ display: 'grid', gridTemplateColumns: '340px minmax(0,1fr)', gap: 20, maxWidth: 1320, alignItems: 'start' },
  card:  { background: '#fff', borderRadius: 18, border: '1.5px solid #C5D4C8', padding: 22 },
  label: { fontSize: 11, fontWeight: 800, color: '#3D5A44', textTransform: 'uppercase', letterSpacing: 0.6, margin: '14px 0 6px', display: 'block' },
  row:   { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7 },
  rowLabel: { fontSize: 12, fontWeight: 700, color: '#3D5A44', minWidth: 92 },
  val:   { fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 42, textAlign: 'right' },
  btn:   { marginTop: 12, padding: '10px 14px', borderRadius: 8, border: 'none', background: '#3D5A44', color: '#fff', fontFamily: 'Quicksand, sans-serif', fontSize: 13, fontWeight: 700, cursor: 'pointer', width: '100%' },
  ghost: { marginTop: 8, padding: '8px 14px', borderRadius: 8, border: '1.5px solid #C5D4C8', background: '#fff', color: '#3D5A44', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, cursor: 'pointer', width: '100%' },
  seg:   { display: 'flex', gap: 6, marginBottom: 4 },
  segBtn:(on) => ({ flex: 1, padding: '8px', borderRadius: 8, border: `1.5px solid ${on ? '#3D5A44' : '#C5D4C8'}`, background: on ? '#3D5A44' : '#fff', color: on ? '#fff' : '#3D5A44', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, cursor: 'pointer' }),
  colorInput: { width: 44, height: 32, padding: 0, border: '1.5px solid #C5D4C8', borderRadius: 8, background: '#fff', cursor: 'pointer' },
  hint:  { fontSize: 11, color: '#9BB5A2', marginTop: 8, lineHeight: 1.5 },
};

function Slider({ label, value, min, max, step, onChange, fmt = v => v }) {
  return (
    <div style={S.row}>
      <span style={S.rowLabel}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)} style={{ flex: 1, accentColor: '#3D5A44' }} />
      <span style={S.val}>{fmt(value)}</span>
    </div>
  );
}

// Self-contained studio reflections built from in-scene lightformers — NO external HDR fetch (drei's
// preset HDRs come from a CDN that can fail offline). Gives glass bright shapes to reflect + IBL for
// the physical transmission. `intensity` scales the whole rig.
function StudioEnv({ intensity = 1.4 }) {
  return (
    <Environment resolution={256}>
      {/* Mid-grey, not near-black: the reference is shot on white with big softboxes, so the glass has a
          BRIGHT surround to refract. A dark env made the amber read as a heavy, unlit solid. */}
      <color attach="background" args={['#bdbdbd']} />
      <Lightformer form="rect" intensity={intensity * 3} position={[0, 5, 3]} scale={[8, 8, 1]} rotation={[-Math.PI / 4, 0, 0]} />
      <Lightformer form="rect" intensity={intensity} position={[-5, 1, 3]} scale={[3, 8, 1]} rotation={[0, Math.PI / 6, 0]} />
      <Lightformer form="rect" intensity={intensity} position={[5, 1, 3]} scale={[3, 8, 1]} rotation={[0, -Math.PI / 6, 0]} />
      <Lightformer form="ring" intensity={intensity * 1.4} position={[0, 2, -7]} scale={5} />
    </Environment>
  );
}

// ONE watertight shell mesh — the rolled lip is part of the geometry, so there is no second mesh whose
// material has to agree with the wall's (the old rim tube inherited `thickness: 1.2` and absorbed to
// near-black, which is what drew the dark outline around every sail).
function SplashCrown({ geo, mode, color, roughness, opacity, rim, rimPower, thickness, attenuation, chroma }) {
  const stylized = useMemo(() => makeStylizedGlass({ color, roughness, opacity, rim, rimPower }), []);

  useEffect(() => {
    if (mode !== 'stylized') return;
    stylized.color.set(color);
    stylized.roughness = roughness;
    stylized.opacity = opacity;
    updateStylizedRim(stylized, rim, rimPower);
    stylized.needsUpdate = true;
  }, [stylized, mode, color, roughness, opacity, rim, rimPower]);

  return (
    <mesh geometry={geo.geometry}>
      {mode === 'physical' ? (
        // backside → a second pass over the shell's far faces, so glass refracts through glass (the
        // whole point of the reference). `thickness` is now physically meaningful: the shell is closed.
        <MeshTransmissionMaterial
          backside
          samples={8}
          resolution={512}
          backsideResolution={256}
          transmission={1}
          thickness={thickness}
          backsideThickness={thickness * 0.4}
          roughness={roughness}
          chromaticAberration={chroma}
          anisotropicBlur={0.1}
          distortion={0}
          temporalDistortion={0}
          ior={1.5}
          // Albedo stays WHITE. three's getIBLVolumeRefraction multiplies the transmitted light by
          // diffuseColor AND by the Beer-Lambert attenuation — colouring both tints the amber twice and
          // crushes blue to ~0.05, which renders as opaque orange plastic. Real coloured glass is a clear
          // medium: all of the colour comes from volume absorption, so `attenuationColor` carries it.
          color="#ffffff"
          attenuationColor={color}
          attenuationDistance={attenuation}
          envMapIntensity={1.2}
          // No `side` override: drei flips FrontSide/BackSide itself per pass, and forcing DoubleSide here
          // defeats the backside pass that makes glass refract through glass.
        />
      ) : (
        <primitive object={stylized} attach="material" />
      )}
    </mesh>
  );
}

const AMBER_PRESETS = ['#e8850c', '#f59e0b', '#d2691e', '#c0392b', '#8e44ad', '#2e86c1', '#27ae60'];

export default function IsomaltStudio() {
  // geometry
  const [peaks, setPeaks]         = useState(SPLASH_DEFAULTS.peaks);
  const [peakHeight, setPeakH]    = useState(SPLASH_DEFAULTS.peakHeight);
  const [valleyHeight, setValleyH]= useState(SPLASH_DEFAULTS.valleyHeight);
  const [sharpness, setSharp]     = useState(SPLASH_DEFAULTS.sharpness);
  const [sailWidth, setSailW]     = useState(SPLASH_DEFAULTS.sailWidth);
  const [valleyVary, setValleyV]  = useState(SPLASH_DEFAULTS.valleyVary);
  const [valleyWidth, setValleyW] = useState(SPLASH_DEFAULTS.valleyWidth);
  const [baseRadius, setBaseR]    = useState(SPLASH_DEFAULTS.baseRadius);
  const [rimRadius, setRimR]      = useState(SPLASH_DEFAULTS.rimRadius);
  const [flare, setFlare]         = useState(SPLASH_DEFAULTS.flare);
  const [spread, setSpread]       = useState(SPLASH_DEFAULTS.spread);
  const [bowlBody, setBowlBody]   = useState(SPLASH_DEFAULTS.bowlBody);
  const [wallCurve, setWallCurve] = useState(SPLASH_DEFAULTS.wallCurve);
  const [jitter, setJitter]       = useState(SPLASH_DEFAULTS.jitter);
  const [lean, setLean]           = useState(SPLASH_DEFAULTS.lean);
  const [leanOut, setLeanOut]     = useState(SPLASH_DEFAULTS.leanOut);
  const [wall, setWall]           = useState(SPLASH_DEFAULTS.wall);
  const [bead, setBead]           = useState(SPLASH_DEFAULTS.bead);
  const [seed, setSeed]           = useState(SPLASH_DEFAULTS.seed);
  // material
  const [mode, setMode]           = useState('stylized');   // 'stylized' (mobile) | 'physical' (reference)
  const [color, setColor]         = useState('#e8850c');
  const [roughness, setRoughness] = useState(0.05);
  const [opacity, setOpacity]     = useState(0.86);
  const [rim, setRim]             = useState(0.55);
  const [rimPower, setRimPower]   = useState(3.4);
  // `thickness` is the refraction-ray length; `attenuation` is the Beer-Lambert distance the amber tint is
  // measured over. Both are now in SHELL units. (The old 1.2 / 1.6 were the same order as rimRadius, so the
  // shader absorbed ~a full unit of amber and the glass came out near-black.)
  const [thickness, setThickness] = useState(0.30);
  const [attenuation, setAtten]   = useState(0.55);
  const [chroma, setChroma]       = useState(0.05);
  const [envInt, setEnvInt]       = useState(1.4);
  const [bg, setBg]               = useState('#ffffff');

  const geoParams = { peaks, peakHeight, valleyHeight, sharpness, sailWidth, valleyVary, valleyWidth, baseRadius, rimRadius, flare, spread, bowlBody, wallCurve, jitter, lean, leanOut, wall, bead, seed };
  const geo = useMemo(() => buildSplashCrown(geoParams), [peaks, peakHeight, valleyHeight, sharpness, sailWidth, valleyVary, valleyWidth, baseRadius, rimRadius, flare, spread, bowlBody, wallCurve, jitter, lean, leanOut, wall, bead, seed]);

  const canvasWrapRef = useRef(null);
  function copyJson() {
    const json = {
      splash_crown: { ...geoParams },
      glass: mode === 'physical'
        ? { mode, color, roughness: +roughness.toFixed(2), thickness, attenuation, chroma }
        : { mode, color, roughness: +roughness.toFixed(2), opacity, rim, rimPower },
    };
    navigator.clipboard?.writeText(JSON.stringify(json, null, 2));
  }

  return (
    <div style={S.page}>
      <div style={S.title}>Isomalt Studio</div>
      <div style={S.sub}>Tune the splash-crown shape + amber-glass finish, then port to core. Drag to orbit. STYLIZED = the mobile look we ship; PHYSICAL = the reference to match.</div>
      <div style={S.layout}>
        <div style={{ ...S.card, maxHeight: '82vh', overflowY: 'auto' }}>
          <label style={S.label}>Finish</label>
          <div style={S.seg}>
            <button style={S.segBtn(mode === 'stylized')} onClick={() => setMode('stylized')}>Stylized (mobile)</button>
            <button style={S.segBtn(mode === 'physical')} onClick={() => setMode('physical')}>Physical (ref)</button>
          </div>

          <label style={S.label}>Amber colour</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
            <input type="color" value={color} onChange={e => setColor(e.target.value)} style={S.colorInput} />
            {AMBER_PRESETS.map(c => <button key={c} onClick={() => setColor(c)} style={{ width: 24, height: 24, borderRadius: 6, border: color === c ? '2px solid #3D5A44' : '1px solid #C5D4C8', background: c, cursor: 'pointer' }} />)}
          </div>
          <Slider label="Roughness" value={roughness} min={0.02} max={0.5} step={0.01} onChange={setRoughness} fmt={v => v.toFixed(2)} />
          {mode === 'stylized' ? (<>
            <Slider label="Opacity"    value={opacity}  min={0.3} max={1}   step={0.01} onChange={setOpacity}  fmt={v => v.toFixed(2)} />
            <Slider label="Edge glow"  value={rim}      min={0}   max={2}   step={0.05} onChange={setRim}      fmt={v => v.toFixed(2)} />
            <Slider label="Edge focus" value={rimPower} min={1}   max={6}   step={0.1}  onChange={setRimPower} fmt={v => v.toFixed(1)} />
          </>) : (<>
            <Slider label="Thickness"  value={thickness}   min={0.02} max={1.2} step={0.02} onChange={setThickness} fmt={v => v.toFixed(2)} />
            <Slider label="Colour depth" value={attenuation} min={0.2} max={4} step={0.05} onChange={setAtten}   fmt={v => v.toFixed(1)} />
            <Slider label="Dispersion" value={chroma}      min={0}    max={0.2} step={0.005} onChange={setChroma} fmt={v => v.toFixed(3)} />
          </>)}

          <label style={S.label}>Shape</label>
          <Slider label="Peaks"       value={peaks}        min={3}    max={10}  step={1}    onChange={setPeaks} />
          <Slider label="Peak height" value={peakHeight}   min={1}    max={3.5} step={0.05} onChange={setPeakH}     fmt={v => v.toFixed(2)} />
          <Slider label="Valley"      value={valleyHeight} min={0.3}  max={2}   step={0.05} onChange={setValleyH}   fmt={v => v.toFixed(2)} />
          {/* Exponent on (1 − d/halfWidth): 1 = straight-sided cone, >1 = narrow spike with a sharp tip. */}
          <Slider label="Apex sharp"  value={sharpness}    min={1}    max={5}   step={0.1}  onChange={setSharp}     fmt={v => v.toFixed(1)} />
          <Slider label="Sail width"  value={sailWidth}    min={0.4}  max={1}    step={0.02} onChange={setSailW}    fmt={v => v.toFixed(2)} />
          <Slider label="Valley vary" value={valleyVary}   min={0}    max={1.6}  step={0.05} onChange={setValleyV}  fmt={v => v.toFixed(2)} />
          <Slider label="Valley width" value={valleyWidth} min={0.3}  max={1}    step={0.02} onChange={setValleyW}  fmt={v => v.toFixed(2)} />
          <Slider label="Base radius" value={baseRadius}   min={0.1}  max={0.8} step={0.02} onChange={setBaseR}     fmt={v => v.toFixed(2)} />
          <Slider label="Rim radius"  value={rimRadius}    min={0.6}  max={1.6} step={0.02} onChange={setRimR}      fmt={v => v.toFixed(2)} />
          <Slider label="Flare"       value={flare}        min={0}    max={0.8}  step={0.02} onChange={setFlare}    fmt={v => v.toFixed(2)} />
          <Slider label="Tip splay"   value={spread}       min={-0.6} max={1.6}  step={0.05} onChange={setSpread}   fmt={v => v.toFixed(2)} />
          <Slider label="Bowl body"   value={bowlBody}     min={0.2}  max={1.6}  step={0.02} onChange={setBowlBody} fmt={v => v.toFixed(2)} />
          <Slider label="Wall curve"  value={wallCurve}    min={0.5}  max={2}   step={0.05} onChange={setWallCurve} fmt={v => v.toFixed(2)} />
          <Slider label="Jitter"      value={jitter}       min={0}    max={0.6}  step={0.02} onChange={setJitter}   fmt={v => v.toFixed(2)} />
          <Slider label="Tip lean"    value={lean}         min={0}    max={0.5}  step={0.02} onChange={setLean}     fmt={v => v.toFixed(2)} />
          <Slider label="Lean out"    value={leanOut}      min={0}    max={1}    step={0.05} onChange={setLeanOut}  fmt={v => v.toFixed(2)} />

          <label style={S.label}>Shell</label>
          <Slider label="Wall"        value={wall}         min={0.01} max={0.10} step={0.005} onChange={setWall}    fmt={v => v.toFixed(3)} />
          <Slider label="Rim bead"    value={bead}         min={1}    max={5}    step={0.1}  onChange={setBead}     fmt={v => v.toFixed(1)} />

          <label style={S.label}>Scene</label>
          <Slider label="Env light" value={envInt} min={0.2} max={4} step={0.1} onChange={setEnvInt} fmt={v => v.toFixed(1)} />
          <div style={S.row}>
            <span style={S.rowLabel}>Background</span>
            <input type="color" value={bg} onChange={e => setBg(e.target.value)} style={S.colorInput} />
          </div>

          <button style={S.btn} onClick={() => setSeed(s => s + 1)}>Reroll jitter</button>
          <button style={S.ghost} onClick={copyJson}>Copy JSON</button>
          <div style={S.hint}>Look-tuning only (no save). Tune the STYLIZED look to read like PHYSICAL; that's what ships to mobile. Copy JSON grabs the tuned params for porting to core.</div>
        </div>

        <div style={{ ...S.card, padding: 0, overflow: 'hidden' }} ref={canvasWrapRef}>
          <div style={{ height: '82vh', background: bg }}>
            <Canvas gl={{ preserveDrawingBuffer: true, alpha: true, antialias: true }} camera={{ position: [0, 1.4, 6], fov: 40 }}>
              <color attach="background" args={[bg]} />
              {/* Glass is lit by its ENVIRONMENT, not by lambert fill. A strong ambient + directional pair
                  adds a flat diffuse term to every facet, which is exactly what washed the deep amber out
                  to pale yellow. Keep a whisper of fill so the unlit side isn't black; the StudioEnv
                  lightformers do the real work (and are what the glass reflects/refracts). */}
              <ambientLight intensity={0.12} />
              <directionalLight position={[4, 6, 5]} intensity={0.3} />
              <directionalLight position={[-5, 3, -4]} intensity={0.12} />
              <StudioEnv intensity={envInt} />
              <group position={[0, -0.6, 0]}>
                <SplashCrown geo={geo} mode={mode} color={color} roughness={roughness} opacity={opacity} rim={rim} rimPower={rimPower} thickness={thickness} attenuation={attenuation} chroma={chroma} />
                {/* Glass is only glass if there is something BEHIND it to bend. Without a floor + shadow the
                    transmission buffer is a uniform white void, every refracted ray samples the same white,
                    and the crown renders as flat plastic no matter how the material is tuned. The reference
                    is a studio photo: seamless floor, soft contact shadow, big softboxes (the Lightformers). */}
                <ContactShadows position={[0, -0.085, 0]} scale={9} blur={2.2} far={2.4} opacity={0.42} resolution={512} color="#7a4a10" />
              </group>
              <OrbitControls target={[0, 0.6, 0]} makeDefault enablePan />
            </Canvas>
          </div>
        </div>
      </div>
    </div>
  );
}
