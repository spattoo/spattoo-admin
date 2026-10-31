import { useState, useRef, useEffect, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { startAi3dGeneration, getAi3dGeneration, splitAi3dGeneration, fetchAi3dModel } from '../lib/api.js';
import { evaluateCaps, ASSET_CLASSES, CAPS } from '../lib/glb.js';
import { buildDecorationPrompt, promptWarnings, defaultAnswers } from '../lib/decorationPrompt.js';
import { getDecorationPromptQuestions, addPromptOption } from '../lib/api.js';
/* ⚠️ `ColorWheel`, NOT A ROW OF SWATCHES OR `<input type=color>`. Root CLAUDE.md names it THE colour
   control for every colour anyone picks, "and that applies in spattoo-admin too" — which is exactly
   why it is exported from core rather than living where only the designer can reach it. */
import { SceneLights, SceneEnv, ColorWheel, SizeDial, GenerationWizard,
         TIER_RADII, BOTTOM_H, NOMINAL_MM_PER_UNIT } from '@spattoo/designer';

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

/* ── Reading the file, not the render ────────────────────────────────────────────────────────────
 *
 * ⚠️ THE NUMBERS MUST NOT DEPEND ON THE PREVIEW SUCCEEDING, and the first real run proved why: a
 * 12 MB Tripo model arrived, the canvas showed nothing, and the panel therefore showed nothing
 * either — at exactly the moment the numbers mattered most. A model too heavy to draw is a model
 * you most want the triangle count for.
 *
 * So the file is fetched ONCE as bytes, and everything is read from it directly: glTF-binary is a
 * 12-byte header then a JSON chunk, so mesh count, materials, images and triangle counts come out
 * of that JSON without three.js having to succeed at anything. The same buffer is then handed to
 * GLTFLoader.parse for the picture — one download, and the preview can fail without taking the
 * verdict with it.
 */
function readGlb(buf) {
  const dv = new DataView(buf);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, dv.getUint32(12, true))));
  /* ⚠️ NAME EACH PART BY ITS NODE, NOT ITS MESH, AND THE DIFFERENCE IS NOT PEDANTIC. glTF names the
     two separately — Tripo returns meshes called `tripo_mesh_N` and nodes called `tripo_part_N` —
     and `GLTFLoader` names the Object3D after the NODE. Keying this list by the mesh name produced
     a list that looked perfect, swatches that filled in, a counter that said "4 of 13 parts
     recoloured", and a bear that stayed stubbornly white: nothing ever matched. Found by looking
     at the render instead of trusting the counter. */
  const nodeNameForMesh = new Map();
  for (const n of json.nodes ?? []) {
    if (n.mesh != null && !nodeNameForMesh.has(n.mesh)) nodeNameForMesh.set(n.mesh, n.name);
  }
  let tris = 0;
  const parts = [];
  (json.meshes ?? []).forEach((m, i) => {
    let t = 0;
    for (const p of m.primitives ?? []) {
      const idx = p.indices != null ? json.accessors[p.indices].count : 0;
      const pos = p.attributes?.POSITION != null ? json.accessors[p.attributes.POSITION].count : 0;
      t += idx ? idx / 3 : pos / 3;
    }
    tris += t;
    parts.push({ name: nodeNameForMesh.get(i) || m.name || `part ${i}`, tris: Math.round(t) });
  });
  return {
    sizeKB: Math.round(buf.byteLength / 1024),
    tris: Math.round(tris),
    meshes: (json.meshes ?? []).length,
    materials: (json.materials ?? []).length,
    images: (json.images ?? []).length,
    parts: parts.sort((a, b) => b.tris - a.tris),
  };
}

/* ── Colouring the parts, which is the whole thesis under test ───────────────────────────────────
 *
 * ⚠️ THIS IS THE MEASUREMENT, NOT A TOY. A Spattoo decoration is recolourable only when its meshes
 * carry no texture map and can be addressed one at a time — `CakeCanvas` keys on `userData.group`
 * and does `if (!mat.map) mat.color = …`. Tripo returned 13 untextured parts; whether each can be
 * given its own colour is what decides if a generated model can become a first-class element
 * rather than a fixed-colour one. Doing it here, in the same way the renderer does it, is the
 * cheapest honest test there is.
 *
 * ⚠️ IT WRITES `mat.color` ON A CLONED MATERIAL, exactly as `StickerModel` does. Tripo hands back
 * meshes with NO material at all, so three.js assigns one shared default — colouring that would
 * paint every part at once. Each mesh gets its own material the first time it is touched.
 *
 * ⚠️ AND HOVER PAINTS THE PART, because `tripo_mesh_7` tells you nothing. Thirteen generically
 * named parts are unusable until you can see which is which, and that is also the work a human
 * still has to do before these map to real group names.
 */
function Model({ buffer, colours, highlight, onParts, onPick, onHover, onCentre, scale = 1 }) {
  const [root, setRoot] = useState(null);
  useEffect(() => {
    if (!buffer) { setRoot(null); return undefined; }
    let live = true;
    /* `parse`, not `load` — the bytes are already here, so the preview never costs a second
       download and cannot fail on a signed URL expiring between the two. */
    new GLTFLoader().parse(buffer.slice(0), '', (gltf) => {
      if (!live) return;
      /* ⚠️ NORMALISE TO 2 UNITS, WHICH IS WHAT THE REST OF THE PIPELINE DOES. `glbRecomposeCore`
         opens every import with "centre at origin, scale longest side to ~2 units", so a model
         judged here at any other size is judged against a cake it will never meet. Vendors return
         wildly different scales — this is the step that makes them comparable at all.
         ⚠️ AND 2 UNITS IS ENORMOUS: a tier is 2.4 units ACROSS, so a freshly normalised decoration
         is almost as wide as the cake — 16.9 cm tall on an 8-inch cake. That is the number this
         screen now shows, because an admin was otherwise guessing the default scale blind. */
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      const k = 2 / Math.max(size.x, size.y, size.z, 0.0001);
      gltf.scene.scale.setScalar(k);
      /* Sat ON the reference tier, not centred in mid-air: the question is whether it fits a cake. */
      gltf.scene.position.set(-centre.x * k, -(centre.y - size.y / 2) * k, -centre.z * k);
      /* Give every mesh its own material — see the note above on the shared default. */
      gltf.scene.traverse(o => {
        if (!o.isMesh) return;
        o.material = (Array.isArray(o.material) ? o.material[0] : o.material)?.clone()
          ?? new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85 });
      });
      setRoot(gltf.scene);
      /* The centre AFTER the normalise-and-seat transform above, so the camera can look at the
         model rather than at the origin. Reported in world units; the `scale` prop multiplies it. */
      const seated = new THREE.Box3().setFromObject(gltf.scene);
      onCentre?.(seated.getCenter(new THREE.Vector3()));
      onParts?.(gltf.scene.children.flatMap(function names(n) {
        return [...(n.isMesh ? [n.name || n.uuid] : []), ...n.children.flatMap(names)];
      }));
    }, () => { if (live) setRoot(null); });
    return () => { live = false; };
  }, [buffer, onParts, onCentre]);

  /* Repaint whenever a colour changes, or the hover moves. Writing straight onto the live
     materials, which is what the renderer does — no re-parse, no reload. */
  useEffect(() => {
    if (!root) return;
    root.traverse(o => {
      if (!o.isMesh) return;
      const key = o.name || o.uuid;
      const chosen = colours?.[key];
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m => {
        if (!m) return;
        if (!m.map) m.color = new THREE.Color(chosen ?? '#f2efe9');
        /* The highlight is emissive rather than a colour swap, so it reads ON TOP of whatever the
           part has been painted instead of replacing it. */
        if (m.emissive !== undefined) {
          m.emissive = new THREE.Color(highlight === key ? '#2f7d4f' : '#000000');
          m.emissiveIntensity = highlight === key ? 0.55 : 0;
        }
        m.needsUpdate = true;
      });
    });
  }, [root, colours, highlight]);

  /* ⚠️ CLICK THE PART, NOT THE LIST. Sandeep: *"clicking on the mesh part is better i think. i can
     directly go to the part i want to create."* Thirteen rows called `tripo_part_7` are unreadable;
     the model itself is the only place a part has an identity a human can see. R3F raycasts for us,
     so the nearest mesh under the pointer is `e.object` — `stopPropagation` keeps a click from also
     hitting whatever is behind it. */
  return root ? (
    <primitive
      object={root}
      scale={[scale, scale, scale]}
      onClick={(e) => { e.stopPropagation(); onPick?.(e.object?.name || null); }}
      onPointerOver={(e) => { e.stopPropagation(); onHover?.(e.object?.name || null); document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { onHover?.(null); document.body.style.cursor = ''; }}
    />
  ) : null;
}

export default function Element3DStudio() {
  const [provider, setProvider] = useState('tripo');
  const [mode, setMode] = useState('text');
  const [prompt, setPrompt] = useState('a fondant monkey sitting, cake topper, simple shapes');
  /* ⚠️ ONE CHOICE, NOT TWO CHECKBOXES. Tripo refuses parts together with texture/pbr — it accepts
     the request, spends the credits and returns a model missing one half — so two independent
     toggles could only ever express a state the vendor rejects. The fork is also the product
     decision: staff build catalogue elements that get finished by hand, a baker has a customer
     waiting. Sandeep: *"if have to choose between parts vs colored output, i would choose colored
     output... something that bakers can use directly."* */
  const [output, setOutput] = useState('parts');   // 'parts' (catalogue) | 'ready' (baker)
  const parts   = output === 'parts';
  const texture = output === 'ready';
  const pbr     = output === 'ready';
  /* ⚠️ ON BY DEFAULT, BECAUSE THE FIRST REAL RUN WAS 20x OVER BUDGET. Tripo returned a beautifully
     parted, untextured bear at 501,326 triangles and 12.2 MB against caps of 25,000 and 1 MB.
     Low poly is capped by Tripo at 20,000 triangles, which lands under ours by construction. */
  const [lowPoly, setLowPoly] = useState(true);
  /* ⚠️ A SEPARATE LEVER FROM `low poly`, AND THE DIFFERENCE IS THE WHOLE EXPERIMENT. `smart_low_poly`
     RE-MESHES the model with hand-crafted topology — measured 2026-10-29, it returned a lovely
     12,212-triangle 416 KB bear as ONE fused mesh, destroying the 13 parts. `face_limit` is just a
     cap. Whether a cap keeps the parts is what decides if generated elements are viable at all. */
  const [faceLimit, setFaceLimit] = useState('');
  const [assetClass, setAssetClass] = useState('decor');
  const [row, setRow] = useState(null);
  const [stats, setStats] = useState(null);
  const [buffer, setBuffer] = useState(null);
  const [recallId, setRecallId] = useState('');
  /* The guided builder. `subject` is whatever the baker typed, however vague — everything else is a
     chip. `freeform` lets someone who knows what they are doing ignore all of it. */
  /* ⚠️ EMPTY, NOT A SAMPLE. This was pre-filled with 'a bear with a small bow' as a convenience,
     and it cost a real generation: Sandeep typed "fondant flute" into the LOOK box, never touched
     the subject, and 20 credits later got a teddy bear — the prompt read "...decoration, a bear
     with a small bow, smooth fondant finish, fondant flute, ...". A default that is a plausible
     answer is indistinguishable from an answer somebody gave. The placeholder shows the same
     example and is never sent. */
  const [subject, setSubject] = useState('');
  /* ⚠️ THE QUESTIONS COME FROM THE SERVER, KEYED BY CATEGORY. Sandeep: *"if a baker asks for a
     lion, it might give a real lion 3d. but baker usually wants is a fondant lion, and that too in
     seating position... the questions we ask are based on what element baker asks - for flowers it
     could be different."* A flower is never "sitting"; it is a bud or open, one bloom or a spray.
     So this component names no category, material or pose — it renders what it is handed. Adding a
     question for a new category is a row, never a branch here (migration 149). */
  const [questions, setQuestions] = useState([]);
  const [frame, setFrame] = useState([]);
  const [answers, setAnswers] = useState({});
  /* ⚠️ ADDING AN OPTION WHERE THE GAP IS NOTICED. Sandeep asked for this inline rather than only on
     the authoring screen, and he is right about why: the moment you discover none of the chips fit
     is the moment you are mid-generation, and anything that needs a trip to another screen is a
     thing that never gets fixed. Keyed by question id so two rows cannot share a draft. */
  const [newOption, setNewOption] = useState({});
  const [addError, setAddError] = useState('');
  const [partWords, setPartWords] = useState('');
  const [freeform, setFreeform] = useState(false);
  /* Where the wizard is. Sandeep: *"want user to focus at each on how exactly it should shape up.
     if all at one place, easy to skip details."* The step list itself is derived from the questions
     the API returns, so adding one in Admin → Elements → Generation Questions adds a step here with
     no change to this file. */
  const [step, setStep] = useState(0);
  const [questionsReady, setQuestionsReady] = useState(false);
  const [colours, setColours] = useState({});      // mesh name → hex
  const [highlight, setHighlight] = useState(null);
  const [picking, setPicking] = useState(null);    // which part's wheel is open
  const [meshNames, setMeshNames] = useState([]);
  /* ⚠️ THE SCALE A BAKER WOULD GET. `placement_config.scale` is the only statement of how big an
     element may be (check:element-size exists because that rule has been broken four times), and
     an admin authoring a new element has to pick its default. Picking it blind is how a decoration
     ends up the size of the cake. Here it is picked against a real tier, with the centimetres shown. */
  const [scale, setScale] = useState(0.3);
  /* ⚠️ OFF BY DEFAULT. Sandeep: *"remove that white cake from out studio. thats not needed at
     generation. i cant zoom into bear because of this cake. bear goes out of screen."* The tier is
     the SCALE reference he asked for earlier — "we should take care of the size of the model, if
     its too huge or too small for the cakes" — so it stays available, but it is a check you run
     once rather than furniture you look past on every generation. The cm readout beside it does
     not need the tier drawn to be correct. */
  const [showCake, setShowCake] = useState(false);
  /* Where the camera looks. The real cause of "it goes out of screen" was not the cake: OrbitControls
     orbits the ORIGIN, which is the tier's middle, so zooming moved toward the cake and pushed the
     model — which sits ON TOP of it — out of frame. Targeting the model's own centre fixes that
     whether the tier is drawn or not. */
  const [modelCentre, setModelCentre] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pollInFlight = useRef(false);


  async function generate() {
    setBusy(true); setError(null); setRow(null); setStats(null); setBuffer(null); setColours({}); setPicking(null);
    try {
      const r = await startAi3dGeneration({ provider, mode, prompt: effectivePrompt, parts, texture, pbr, lowPoly,
                                           faceLimit: faceLimit === '' ? undefined : Number(faceLimit) });
      setRow(r);
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  }

  /* A run costs money, so it must be revisitable. Every generation is a durable row; without a way
     to open one again, looking at yesterday's model — or merely reloading the page — means paying to
     generate it a second time. The id is printed on every result for exactly this. */
  async function recall() {
    const id = recallId.trim();
    if (!id) return;
    setBusy(true); setError(null); setStats(null); setBuffer(null); setColours({}); setPicking(null);
    try { setRow(await getAi3dGeneration(id)); }
    catch (e) { setError(e.message || String(e)); }
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

  /* The question set, once. It no longer depends on anything the operator picks — see the note by
     the fields below for why categories went. */
  useEffect(() => {
    let alive = true;
    getDecorationPromptQuestions()
      .then(res => {
        if (!alive) return;
        const list = res?.questions ?? [];
        setFrame(res?.frame ?? []);
        setQuestions(list);
        // Defaults fill only unanswered keys, so a reload never overwrites a deliberate choice.
        setAnswers(prev => ({ ...defaultAnswers(list), ...prev }));
        setQuestionsReady(true);
      })
      // A failed fetch is not a loading state: the wizard is complete without the questions (they
      // narrow a prompt that already works), so the count becomes true rather than staying hidden.
      .catch(() => { if (alive) { setQuestions([]); setQuestionsReady(true); } });
    return () => { alive = false; };
  }, []);

  /* `output` decides which half of the frame applies: a recolourable model must be told
     "untextured", a ready-to-use one must NOT be — we ask the vendor for texture on that path. */
  const built = buildDecorationPrompt({ subject, questions, answers, frame,
                                        output: parts ? 'recolourable' : 'ready',
                                        parts: partWords.split(',').map(x => x.trim()).filter(Boolean) });
  const warnings = promptWarnings({ subject, questions, answers });
  /* What is actually sent. The builder writes it; `freeform` hands the pen back. */
  const effectivePrompt = freeform ? prompt : built;

  const modelUrl = row?.vendorModelUrl ?? row?.glbUrl ?? null;

  /* Download once the vendor hands over a URL, then read the bytes. Kept out of the poll effect so
     a re-poll cannot re-download 12 MB. */
  useEffect(() => {
    if (!modelUrl) return undefined;
    let live = true;
    (async () => {
      try {
        /* Through our API, not the vendor's CDN — Meshy's does not send a CORS header, so reading
           it straight from the browser fails for one vendor and works for the other. */
        const buf = await fetchAi3dModel(row.id);
        if (!live) return;
        setBuffer(buf);
        setStats(readGlb(buf));
      } catch (e) {
        if (live) setStats({ error: `could not read the GLB: ${e.message}` });
      }
    })();
    return () => { live = false; };
  }, [modelUrl]);
  const caps = stats && !stats.error
    ? evaluateCaps({ tris: stats.tris, textureMaxDim: 0, decodedMemKB: 0, sizeKB: stats.sizeKB }, assetClass)
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
        the only shape a baker can recolour. <strong>Click a part on the model</strong> to open its
        colour; the list is only there to show what else is in the file.
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
        <button type="button" style={pill(output === 'parts')} onClick={() => setOutput('parts')}
                title="Separate meshes, no maps. A baker picks a colour per part — but somebody has to do that first.">
          Recolourable
        </button>
        <button type="button" style={pill(output === 'ready')} onClick={() => setOutput('ready')}
                title="Textured + PBR, one fused mesh. Keeps its own colours and sheen; cannot be recoloured.">
          Ready to use
        </button>
        <label style={{ fontSize: 12, color: '#6B8C74', display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={lowPoly} onChange={e => setLowPoly(e.target.checked)} /> low poly
        </label>
        <label style={{ fontSize: 12, color: '#6B8C74', display: 'flex', alignItems: 'center', gap: 6 }}>
          face limit
          <input value={faceLimit} onChange={e => setFaceLimit(e.target.value.replace(/[^0-9]/g, ''))}
                 placeholder="none" inputMode="numeric"
                 style={{ width: 76, padding: '6px 8px', borderRadius: 8, fontFamily: 'inherit',
                          fontSize: 12, border: '1.5px solid #D8E0DA' }} />
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
        you are deliberately testing a fixed-colour element. <strong>Low poly</strong> caps the mesh at
        20,000 triangles: without it the first real run came back at 501,326, twenty times our decor cap.
      </p>

      {mode === 'text' && !freeform && (
        /* ⚠️ ONE QUESTION AT A TIME, AND THE STEPS ARE NOT LISTED HERE. Sandeep: *"lets make it like
           a wizard pls... if all at one place, easy to skip details. basically i want to save
           baker's credits as much as possible."* The wizard lives in CORE because the baker's studio
           is where it is going and imports only flow core → admin — building it here would mean
           building it twice. It derives its steps from `questions`, so a question added in Admin →
           Elements → Generation Questions grows a step with no edit to this file.

           What it does NOT own is the sentence: `buildDecorationPrompt` stays in this repo, where
           `check:prompt-vocab` holds it to naming no material, pose or category of its own. The
           wizard receives the finished string. */
        <div style={{ marginBottom: 12 }}>
          <GenerationWizard
            questions={questions} output={parts ? 'recolourable' : 'ready'}
            subject={subject} onSubject={setSubject}
            answers={answers} onAnswer={(k, v) => setAnswers(a => ({ ...a, [k]: v }))}
            partWords={partWords} onPartWords={setPartWords}
            index={step} onIndex={setStep} questionsReady={questionsReady}
            prompt={built} warnings={warnings}
            busy={busy} onGenerate={generate}
            generateLabel={`Generate with ${PROVIDERS[provider].label}`}
            costNote={PROVIDERS[provider].price}
            /* Admin-only, and injected rather than built in: saving an option saves it for EVERY
               baker who opens this wizard, which is a decision staff make and bakers do not. */
            renderQuestionExtra={q => (
              <input value={newOption[q.key] ?? ''} placeholder="+ add an option for everyone"
                     onChange={e => setNewOption(n => ({ ...n, [q.key]: e.target.value }))}
                     onKeyDown={async e => {
                       if (e.key !== 'Enter') return;
                       const label = (newOption[q.key] ?? '').trim();
                       if (!label || !q.id) return;
                       setAddError('');
                       try {
                         await addPromptOption(q.id, { label });
                         setNewOption(n => ({ ...n, [q.key]: '' }));
                         setQuestions((await getDecorationPromptQuestions())?.questions ?? []);
                       } catch (err) {
                         setAddError(err.message || 'Could not save that option.');
                       }
                     }}
                     style={{ width: 170, padding: '7px 10px', borderRadius: 9, fontFamily: 'inherit',
                              fontSize: 12, border: '1px dashed #C5D4C8', color: '#2C4433' }} />
            )}
          />
          {addError && <div style={{ fontSize: 11.5, color: '#991B1B', marginTop: 6 }}>{addError}</div>}
          <label style={{ fontSize: 12, color: '#6B8C74', display: 'flex', alignItems: 'center',
                          gap: 6, marginTop: 10 }}>
            <input type="checkbox" checked={freeform}
                   onChange={e => { if (e.target.checked) setPrompt(built); setFreeform(e.target.checked); }} />
            write it myself
          </label>
        </div>
      )}

      {mode === 'text' && freeform && (
        /* The escape hatch, unchanged in substance: staff comparing vendors need to send an exact
           string, and the wizard's whole job is to compose one. Stepping through questions to reach
           a box you are going to overwrite is worse than no wizard. Unticking restores the steps
           with every answer still there. */
        <div style={{ maxWidth: 760, marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: '#6B8C74', letterSpacing: 0.4,
                        textTransform: 'uppercase', marginBottom: 4 }}>What gets sent</div>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={3}
            style={{ width: '100%', padding: 10, borderRadius: 10, fontFamily: 'inherit',
                     fontSize: 13, border: '1.5px solid #D8E0DA', background: '#fff', color: '#2C4433' }} />
          <div style={S.row}>
            <button type="button" style={S.btn} disabled={busy || !effectivePrompt.trim()} onClick={generate}>
              {busy ? 'Working…' : `Generate with ${PROVIDERS[provider].label}`}
            </button>
            <label style={{ fontSize: 12, color: '#6B8C74', display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={freeform}
                     onChange={e => setFreeform(e.target.checked)} />
              write it myself
            </label>
          </div>
        </div>
      )}

      {mode === 'image' && (
        <p style={{ ...S.card, maxWidth: 760, marginBottom: 12 }}>
          Image → 3D needs a source image already on R2. The shipped{' '}
          <strong>Editors ▸ Image → 3D Cake</strong> wizard does that upload and the GPT-4o gate;
          this screen is for comparing vendors from a prompt. Not wired here yet.
        </p>
      )}

      <div style={S.row}>
        {row?.provider === 'meshy' && row?.status === 'SUCCEEDED' && (
          <button type="button" style={S.ghost} onClick={split}>Auto Split this model</button>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input value={recallId} onChange={e => setRecallId(e.target.value)} placeholder="open a past run by id"
                 style={{ padding: '8px 10px', borderRadius: 10, border: '1.5px solid #D8E0DA',
                          fontSize: 12, fontFamily: 'inherit', width: 260 }} />
          <button type="button" style={S.ghost} onClick={recall}>Open</button>
        </span>
      </div>

      {error && <div style={{ ...S.card, borderColor: '#E7B9B0', color: '#9A3B2A', maxWidth: 760 }}>{error}</div>}

      {row && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', marginTop: 8 }}>
          <div style={{ width: 'min(560px, 100%)', height: 420, borderRadius: 14, overflow: 'hidden',
                        border: '1px solid #E3EAE5', background: '#fff' }}>
            {/* ⚠️ EXPLICIT SIZE. Without it R3F left the canvas at the HTML default 300x150 inside a
                420px box, so the first real model was invisible and looked like a load failure. */}
            <Canvas camera={{ position: [0, 1.1, 4.2], fov: 42 }} dpr={[1, 2]}
                    style={{ width: '100%', height: '100%', display: 'block' }}>
              <SceneLights shadows={false} />
              <SceneEnv />
              {showCake && (
                /* The reference tier: the designer's own bottom-tier radius and height, so "does
                   this fit on a cake" is answered against the cake we actually draw. */
                <mesh position={[0, -BOTTOM_H / 2, 0]} receiveShadow>
                  <cylinderGeometry args={[TIER_RADII[0], TIER_RADII[0], BOTTOM_H, 64]} />
                  <meshStandardMaterial color="#F3EFE6" roughness={0.95} />
                </mesh>
              )}
              {buffer && <Model buffer={buffer} scale={scale} colours={colours} highlight={highlight}
                                onParts={setMeshNames} onHover={setHighlight} onCentre={setModelCentre}
                                onPick={(name) => { setPicking(name); setHighlight(name);
                                  /* bring its row into view, so the wheel that just opened is on screen */
                                  requestAnimationFrame(() => document
                                    .querySelector(`[data-part="${name}"]`)
                                    ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); }} />}
              {/* Pan is ON now: with the tier hidden there is nothing fixed to orbit around, and a
                  tall model still needs nudging into frame. `target` follows the model's centre so
                  the wheel zooms INTO it rather than past it. */}
              <OrbitControls enablePan makeDefault
                             target={modelCentre
                               ? [modelCentre.x, modelCentre.y * scale, modelCentre.z]
                               : [0, 0, 0]} />
            </Canvas>
          </div>

          <div style={{ ...S.card, width: 'min(380px, 100%)' }}>
            <div style={{ fontWeight: 800, color: '#2C4433', marginBottom: 6 }}>
              {PROVIDERS[row.provider].label} · {row.mode} · {row.status}
              {row.progress ? ` · ${row.progress}%` : ''}
            </div>
            {row.error && <div style={{ color: '#9A3B2A', marginBottom: 6 }}>{row.error}</div>}
            {row.credits != null && <div style={{ color: '#6B8C74' }}>credits spent: {row.credits}</div>}
            <div style={{ color: '#9BB5A2', fontSize: 11, wordBreak: 'break-all' }}>id {row.id}</div>

            {/* ── Is it the right size for a cake? ──────────────────────────────────────────
                ⚠️ THE QUESTION AN ADMIN COULD NOT ANSWER BEFORE. Sandeep: "when generating- we
                should take care of the size of the model, if its too huge or too small for the
                cakes." Every import is normalised to 2 units, a tier is 2.4 ACROSS, so a raw
                generated decoration is 16.9 cm tall on an 8-inch cake — taller than the cake is
                wide. The default scale was being guessed; now it is chosen against a real tier
                with the centimetres stated. `NOMINAL_MM_PER_UNIT` is core's own declared
                assumption, imported rather than restated. */}
            {buffer && (() => {
              const cm = (2 * scale * NOMINAL_MM_PER_UNIT) / 10;
              const tierCm = (TIER_RADII[0] * 2 * NOMINAL_MM_PER_UNIT) / 10;
              const tooBig = cm > tierCm * 0.9;
              const tooSmall = cm < 1.5;
              return (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #EDF2EE' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <SizeDial size={scale} min={0.05} max={1} step={0.05}
                              onChange={setScale} fmt={v => v.toFixed(2)} />
                    <div>
                      <div style={{ fontWeight: 800,
                                    color: tooBig || tooSmall ? '#9A3B2A' : '#2C6E49' }}>
                        ≈ {cm.toFixed(1)} cm tall
                      </div>
                      <div style={{ fontSize: 11, color: '#9BB5A2' }}>
                        on an 8-inch cake ({tierCm.toFixed(0)} cm across)
                      </div>
                    </div>
                  </div>
                  {tooBig && <div style={{ fontSize: 11.5, color: '#9A3B2A', marginTop: 4 }}>
                    Wider than the cake it sits on — scale it down before saving.</div>}
                  {tooSmall && <div style={{ fontSize: 11.5, color: '#9A3B2A', marginTop: 4 }}>
                    Under 1.5 cm — detail at this size will not read on a cake.</div>}
                  <label style={{ fontSize: 11.5, color: '#6B8C74', display: 'flex',
                                  alignItems: 'center', gap: 6, marginTop: 6 }}>
                    <input type="checkbox" checked={showCake}
                           onChange={e => setShowCake(e.target.checked)} /> show the cake
                  </label>
                  <div style={{ fontSize: 11, color: '#9BB5A2', marginTop: 4 }}>
                    This is the number to author as <code>placement_config.scale</code>’s default.
                  </div>
                </div>
              );
            })()}

            {stats?.error && <div style={{ color: '#9A3B2A' }}>{stats.error}</div>}
            {stats && !stats.error && (
              <>
                {/* ⚠️ THE TWO LINES THAT DECIDE IT. Everything below is detail. */}
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #EDF2EE' }}>
                  <div style={{ fontWeight: 800, color: stats.meshes > 1 ? '#2C6E49' : '#9A3B2A' }}>
                    {stats.meshes} mesh{stats.meshes === 1 ? '' : 'es'}
                    {stats.meshes === 1 ? ' — fused, needs carving by hand' : ' — separate parts'}
                  </div>
                  <div style={{ fontWeight: 800, color: stats.images ? '#9A3B2A' : '#2C6E49' }}>
                    {stats.images
                      ? `${stats.images} texture image(s) — not recolourable as-is`
                      : 'no texture images — recolourable'}
                  </div>
                  <div style={{ color: '#6B8C74', marginTop: 4 }}>
                    {stats.tris.toLocaleString()} triangles · {stats.sizeKB} KB
                  </div>
                </div>
                {/* ⚠️ THE PART LIST IS THE CONTROL, NOT A READOUT. Hovering paints the part in the
                    preview and tapping opens its wheel, because `tripo_mesh_7` names nothing a
                    human can place — INVARIANTS #11, the control and what it changes visible
                    together. */}
                <div style={{ marginTop: 10, maxHeight: 260, overflowY: 'auto' }}>
                  {stats.parts.map((p) => {
                    const chosen = colours[p.name];
                    const open = picking === p.name;
                    return (
                      <div key={p.name} data-part={p.name}
                           onMouseEnter={() => setHighlight(p.name)}
                           onMouseLeave={() => setHighlight(h => (h === p.name ? null : h))}
                           style={{ borderBottom: '1px solid #F1F5F2', padding: '5px 0' }}>
                        <button type="button" onClick={() => setPicking(open ? null : p.name)}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                                   background: open ? '#F2F7F3' : 'none', border: 'none', padding: '4px 6px',
                                   borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                                   fontSize: 12, color: '#2C4433', textAlign: 'left' }}>
                          <span style={{ width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                                         background: chosen ?? '#f2efe9',
                                         border: '1.5px solid #D8E0DA' }} />
                          <span style={{ flex: 1 }}>{p.name}</span>
                          <span style={{ color: '#9BB5A2' }}>{p.tris.toLocaleString()}</span>
                        </button>
                        {open && (
                          <div style={{ padding: '8px 4px 4px' }}>
                            <ColorWheel compact color={chosen ?? '#f2efe9'}
                              onChange={(hex) => setColours(c => ({ ...c, [p.name]: hex }))} />
                            {chosen && (
                              <button type="button" style={{ ...S.ghost, marginTop: 8, padding: '5px 10px', fontSize: 11 }}
                                onClick={() => setColours(c => { const n = { ...c }; delete n[p.name]; return n; })}>
                                clear this part
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {Object.keys(colours).length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 11.5, color: '#2C6E49', fontWeight: 700 }}>
                    {Object.keys(colours).length} of {stats.parts.length} parts recoloured independently
                    — the model is addressable
                  </div>
                )}
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
            {/* ── The door out of this screen ────────────────────────────────────────────────────
                Until now a finished generation offered a download link and nothing else. That was
                not an oversight — this studio deliberately saves nothing, because Add Element
                already does it properly (thumbnail, R2 copy, row, guide, reindex) and a second save
                path here would be the drift INVARIANTS #15 is about. What was missing was a DOOR:
                the model had to be downloaded by hand and uploaded again on the other side.

                So this is a link, not a save. Add Element fetches the model through our own API,
                and when it saves, it records the generation this element came from. */}
            {row?.status === 'SUCCEEDED' && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
                {row.promotedElementId ? (
                  <a href={`/elements/manage?element=${row.promotedElementId}`}
                     style={{ ...S.btn, textDecoration: 'none', display: 'inline-block' }}>
                    Already an element — open it
                  </a>
                ) : (
                  <a href={`/elements/add?run=${row.id}`}
                     style={{ ...S.btn, textDecoration: 'none', display: 'inline-block' }}>
                    Make this an element
                  </a>
                )}
                {modelUrl && (
                  <a href={modelUrl} target="_blank" rel="noreferrer"
                     style={{ color: '#2C4433', fontWeight: 700, fontSize: 12.5 }}>
                    open the raw GLB
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
