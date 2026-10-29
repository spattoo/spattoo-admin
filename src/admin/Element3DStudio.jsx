import { useState, useRef, useEffect, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { startAi3dGeneration, getAi3dGeneration, splitAi3dGeneration } from '../lib/api.js';
import { measureGlbRoot, evaluateCaps, ASSET_CLASSES, CAPS } from '../lib/glb.js';
import { SceneLights, SceneEnv } from '@spattoo/designer';

/* ── 3D Element Studio — Tripo and Meshy, side by side ───────────────────────────────────────────
 *
 * Sandeep: *"explore meshy.ai, tripo.ai or any other 3d generators that can fit into spattoo"*,
 * then *"build a studio in admin, where we can switch between tripo and meshy"*, and on where it
 * should live: *"build it in admin than harnes. so tha it can be reused by staff in future."*
 *
 * ⚠️ THE QUESTION THIS ANSWERS IS NOT "CAN AI MAKE A 3D MODEL". It plainly can. The question is
 * whether either vendor returns something a Spattoo element can be made of, and that has one hard
 * test: a decoration is only RECOLOURABLE when it arrives as separate meshes carrying no texture
 * map — `CakeCanvas` does `if (!mat.map) mat.color = …` keyed on `userData.group`. A fused,
 * texture-atlased model is a fixed-colour element, which is second class beside our catalogue.
 * Carving one by hand is what `RecomposeEditor` already does, per element, and that manual step is
 * the cost this is trying to remove.
 *
 * ⚠️ SO THE PANEL REPORTS PARTS AND TEXTURES FIRST, not beauty. Mesh count, how many carry a map,
 * and the part names — those decide whether a model can become an element at all. The render is
 * there to catch the obvious failures the numbers miss.
 *
 * ⚠️ IT MEASURES AGAINST OUR OWN CAPS, not generic advice. `lib/glb.js` already carries them —
 * scatter 250KB / decor 1MB / topper 2MB — and they exist because load time is dominated by
 * distinct assets. Judging a vendor against anything else would be inventing a second standard.
 *
 * ⚠️ IT SAVES NOTHING, AND THAT IS NOT AN OVERSIGHT. Anything worth keeping goes through
 * `RecomposeEditor` / `GlbStudio`, which already do Save-as-Element properly — thumbnail, R2 copy,
 * element row. A second save path here would be the drift INVARIANTS #15 is about.
 */

const PROVIDERS = {
  tripo: {
    label: 'Tripo',
    note: 'Splits at generation — "Generate Parts" is an add-on on the same task.',
    price: '1 credit = $0.01 · text 10 untextured / 20 textured · parts +20',
  },
  meshy: {
    label: 'Meshy',
    note: 'Splits afterwards — Auto Split runs as a second task on a finished model.',
    price: '≈$0.015–0.02 a credit · text preview 20 · Auto Split 10',
  },
};
const POLL_MS = 4000;
const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELED'];

function Model({ url, onMeasured }) {
  const [root, setRoot] = useState(null);
  useEffect(() => {
    if (!url) { setRoot(null); return undefined; }
    let live = true;
    new GLTFLoader().load(url, (gltf) => {
      if (!live) return;
      setRoot(gltf.scene);
      /* What the model IS, read off the parsed scene rather than guessed from the vendor's blurb. */
      const parts = [];
      let textured = 0;
      gltf.scene.traverse(o => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        if (mats.some(m => m?.map)) textured += 1;
        parts.push({ name: o.name || '(unnamed)', textured: mats.some(m => m?.map) });
      });
      onMeasured?.({ ...measureGlbRoot(gltf.scene), parts, texturedMeshes: textured });
    }, undefined, () => { if (live) onMeasured?.({ error: 'could not load the GLB' }); });
    return () => { live = false; };
  }, [url, onMeasured]);
  return root ? <primitive object={root} /> : null;
}

export default function Element3DStudio() {
  const [provider, setProvider] = useState('tripo');
  const [mode, setMode] = useState('text');
  const [prompt, setPrompt] = useState('a fondant monkey sitting, cake topper, simple shapes');
  const [parts, setParts] = useState(true);
  const [texture, setTexture] = useState(false);
  const [assetClass, setAssetClass] = useState('decor');
  const [row, setRow] = useState(null);
  const [stats, setStats] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pollInFlight = useRef(false);

  const onMeasured = useCallback((s) => setStats(s), []);

  async function generate() {
    setBusy(true); setError(null); setRow(null); setStats(null);
    try {
      const r = await startAi3dGeneration({ provider, mode, prompt, parts, texture });
      setRow(r);
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  }

  async function split() {
    if (!row) return;
    setBusy(true); setError(null);
    try { setRow(await splitAi3dGeneration(row.id, { mode: 'auto' })); setStats(null); }
    catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  }

  /* Poll while the vendor works. One request in flight at a time — a slow vendor must not stack. */
  useEffect(() => {
    if (!row?.id || TERMINAL.includes(row.status)) return undefined;
    const id = setInterval(async () => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      try { setRow(await getAi3dGeneration(row.id)); }
      catch { /* a poll that fails is not a run that failed — try again */ }
      finally { pollInFlight.current = false; }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [row?.id, row?.status]);

  const modelUrl = row?.vendorModelUrl ?? row?.glbUrl ?? null;
  const caps = stats && !stats.error
    ? evaluateCaps({ tris: stats.tris, textureMaxDim: stats.textureMaxDim,
                     decodedMemKB: stats.decodedMemKB, sizeKB: stats.sizeKB }, assetClass)
    : null;

  const S = {
    page:  { padding: 24, fontFamily: "'Quicksand', sans-serif", background: '#F7F9F7', minHeight: '100vh' },
    row:   { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 },
    btn:   { padding: '9px 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
             background: '#2C4433', color: '#fff', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' },
    ghost: { padding: '9px 14px', borderRadius: 10, cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
             border: '1.5px solid #D8E0DA', background: '#fff', color: '#2C4433' },
    card:  { background: '#fff', border: '1px solid #E3EAE5', borderRadius: 12, padding: 14, fontSize: 12.5 },
  };
  const pill = (on) => ({ ...S.ghost, fontWeight: 800,
    background: on ? '#2C4433' : '#fff', color: on ? '#fff' : '#2C4433', borderColor: on ? '#2C4433' : '#D8E0DA' });

  return (
    <div style={S.page}>
      <h1 style={{ fontSize: 20, margin: '0 0 4px', color: '#2C4433' }}>3D Element Studio</h1>
      <p style={{ fontSize: 13, color: '#6B8C74', margin: '0 0 16px', maxWidth: 760, lineHeight: 1.6 }}>
        Generate a decoration with <strong>Tripo</strong> or <strong>Meshy</strong> and see whether what
        comes back can become a Spattoo element. The test that matters is not how it looks — it is
        whether it arrives as <strong>separate parts with no baked texture</strong>, because that is
        the only shape a baker can recolour.
      </p>

      {/* ⚠️ The switch is the point of the screen, so it is the first control and it is labelled
          with what actually differs between the two — not just their names. */}
      <div style={S.row}>
        {Object.entries(PROVIDERS).map(([k, p]) => (
          <button key={k} type="button" style={pill(provider === k)} onClick={() => setProvider(k)}>{p.label}</button>
        ))}
        <span style={{ fontSize: 11.5, color: '#6B8C74' }}>{PROVIDERS[provider].note}</span>
      </div>
      <div style={{ fontSize: 11, color: '#9BB5A2', margin: '-4px 0 14px' }}>{PROVIDERS[provider].price}</div>

      <div style={S.row}>
        <button type="button" style={pill(mode === 'text')} onClick={() => setMode('text')}>Text → 3D</button>
        <button type="button" style={pill(mode === 'image')} onClick={() => setMode('image')}>Image → 3D</button>
        <label style={{ fontSize: 12, color: '#6B8C74', display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={parts} onChange={e => setParts(e.target.checked)} /> ask for parts
        </label>
        <label style={{ fontSize: 12, color: '#6B8C74', display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={texture} onChange={e => setTexture(e.target.checked)} /> bake a texture
        </label>
        <label style={{ fontSize: 12, color: '#6B8C74', display: 'flex', alignItems: 'center', gap: 6 }}>
          judge as
          <select value={assetClass} onChange={e => setAssetClass(e.target.value)}
                  style={{ ...S.ghost, padding: '6px 8px' }}>
            {ASSET_CLASSES.map(c => <option key={c} value={c}>{CAPS[c].label}</option>)}
          </select>
        </label>
      </div>
      <p style={{ fontSize: 11, color: '#9BB5A2', margin: '-6px 0 12px' }}>
        A texture is the expensive option <em>and</em> the one we cannot recolour — leave it off unless
        you are deliberately testing a fixed-colour element.
      </p>

      {mode === 'text' && (
        <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={2}
          style={{ width: '100%', maxWidth: 760, padding: 10, borderRadius: 10, fontFamily: 'inherit',
                   fontSize: 13, border: '1.5px solid #D8E0DA', marginBottom: 12 }} />
      )}
      {mode === 'image' && (
        <p style={{ ...S.card, maxWidth: 760, marginBottom: 12 }}>
          Image → 3D needs a source image already on R2. The shipped{' '}
          <strong>Editors ▸ Image → 3D Cake</strong> wizard does that upload and the GPT-4o gate;
          this screen is for comparing vendors from a prompt. Not wired here yet.
        </p>
      )}

      <div style={S.row}>
        <button type="button" style={S.btn} disabled={busy || (mode === 'image')} onClick={generate}>
          {busy ? 'Working…' : `Generate with ${PROVIDERS[provider].label}`}
        </button>
        {row?.provider === 'meshy' && row?.status === 'SUCCEEDED' && (
          <button type="button" style={S.ghost} onClick={split}>Auto Split this model</button>
        )}
      </div>

      {error && <div style={{ ...S.card, borderColor: '#E7B9B0', color: '#9A3B2A', maxWidth: 760 }}>{error}</div>}

      {row && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', marginTop: 8 }}>
          <div style={{ width: 'min(560px, 100%)', height: 420, borderRadius: 14, overflow: 'hidden',
                        border: '1px solid #E3EAE5', background: '#fff' }}>
            <Canvas camera={{ position: [0, 1.2, 3.2], fov: 42 }} dpr={[1, 2]}>
              <SceneLights shadows={false} />
              <SceneEnv />
              {modelUrl && <Model url={modelUrl} onMeasured={onMeasured} />}
              <OrbitControls enablePan={false} />
            </Canvas>
          </div>

          <div style={{ ...S.card, width: 'min(380px, 100%)' }}>
            <div style={{ fontWeight: 800, color: '#2C4433', marginBottom: 6 }}>
              {PROVIDERS[row.provider].label} · {row.mode} · {row.status}
              {row.progress ? ` · ${row.progress}%` : ''}
            </div>
            {row.error && <div style={{ color: '#9A3B2A', marginBottom: 6 }}>{row.error}</div>}
            {row.credits != null && <div style={{ color: '#6B8C74' }}>credits spent: {row.credits}</div>}

            {stats?.error && <div style={{ color: '#9A3B2A' }}>{stats.error}</div>}
            {stats && !stats.error && (
              <>
                {/* ⚠️ THE TWO LINES THAT DECIDE IT. Everything below is detail. */}
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #EDF2EE' }}>
                  <div style={{ fontWeight: 800, color: stats.parts.length > 1 ? '#2C6E49' : '#9A3B2A' }}>
                    {stats.parts.length} mesh{stats.parts.length === 1 ? '' : 'es'}
                    {stats.parts.length === 1 ? ' — fused, needs carving by hand' : ' — separate parts'}
                  </div>
                  <div style={{ fontWeight: 800, color: stats.texturedMeshes ? '#9A3B2A' : '#2C6E49' }}>
                    {stats.texturedMeshes
                      ? `${stats.texturedMeshes} carry a texture — not recolourable as-is`
                      : 'no texture maps — recolourable'}
                  </div>
                </div>
                <div style={{ marginTop: 8, maxHeight: 130, overflowY: 'auto', color: '#6B8C74' }}>
                  {stats.parts.map((p, i) => (
                    <div key={i}>• {p.name}{p.textured ? ' (textured)' : ''}</div>
                  ))}
                </div>
                {caps && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #EDF2EE' }}>
                    {caps.rows.map(r => (
                      <div key={r.key} style={{ color: r.over ? '#9A3B2A' : '#6B8C74' }}>
                        {r.label}: {Math.round(r.value)}{r.unit} / {r.cap}{r.unit}{r.over ? ' — over' : ''}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            {modelUrl && (
              <a href={modelUrl} target="_blank" rel="noreferrer"
                 style={{ display: 'inline-block', marginTop: 10, color: '#2C4433', fontWeight: 700 }}>
                open the raw GLB
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
