import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { fetchElementTypes, uploadThumbnail, createGlobalElement } from '../lib/api.js';
// The geometry lives in spattoo-core and is IMPORTED, not copied: the designer will cut the
// customer's word with these exact functions, so this preview and the cake cannot drift. The face
// and finish lists come from there too — creamFonts.json is already in this repo as a copy, and a
// topper does not get a second copy of anything.
import {
  topperShapes, components, bridgeLoose, SizeDial,
  TOPPER_FACES, DEFAULT_TOPPER_FACE, loadTopperFace, isMonoline, faceFit,
  TOPPER_FINISHES, DEFAULT_TOPPER_FINISH, topperFinish,
} from '@spattoo/designer';

/* ── Acrylic Topper Studio ───────────────────────────────────────────────────────────────────────
 *
 * Authors a topper whose TEXT IS THE CUSTOMER'S. Nothing here is a picture and nothing is uploaded:
 * the word is cut from a font at render time, so one element serves "Amelia", "Happy Birthday" and
 * "Happy 1st Birthday Amelia". What the admin fixes is everything EXCEPT the word — the face, how
 * much of the cake it crosses, the sheet it is cut from, the base and legs, and which finishes are
 * on offer.
 *
 *   placement_config.acrylic  = { face, stroke, weight, thickness, minDetail, bar, legs, bridge,
 *                                 lineGap, maxLines, finishes[], defaultFinish, text{} }
 *   placement_config.scale    = { min, max, step }   the SizeDial's bounds (placement.js)
 *   placement_config.r        = the default size within them
 *
 * ── WHAT THE PANEL IS REALLY FOR ──
 * Two of these numbers decide whether the object can exist, and neither can be judged by eye:
 *
 *   PIECES   A topper is cut from one sheet. Anything that comes back as 2 is that many objects in
 *            a bag, and the customer finds out after it is cut — on screen a floating letter looks
 *            exactly like an attached one. Loose parts are painted RED here rather than counted at
 *            you, because a number sends an author hunting and a red letter does not.
 *   THINNEST The narrowest piece of acrylic in the design, measured off the outline. Under the
 *            cutter's minimum it snaps in the post. An outline face's hairline is whatever the type
 *            designer drew — Weight is the only lever; a monoline's stroke is set directly.
 *
 * Both are checked against a SAMPLE WORD, and the sample matters: a name fits on one row and
 * exercises none of the stacking, nesting or bridging that a phrase does. Hence two samples, and a
 * save is refused while either is broken — an element that cannot be cut is not a preview problem.
 *
 * Reuses createGlobalElement + uploadThumbnail, not a parallel element-creation path.
 */

const TOPPER_ZONES   = ['top_surface'];
const TOPPER_ACTIONS = { resize: true, duplicate: false, color: true, gradient: false, delete: true, move: true, tilt: false };
const PLACEMENT      = { top_surface: 'stand' };

// A 6-inch cake, so every number on the panel is a real millimetre rather than a scene unit. Both
// questions above are questions about millimetres and scene units answer neither.
const CAKE_R = 1.6, CAKE_H = 0.55;
const MM = (6 * 25.4) / (CAKE_R * 2);
const mm = (u) => `${(u * MM).toFixed(1)}mm`;

/* ⚠️ Two samples, and both are checked.
 *
 * A single name sits on one row, so it never stacks, never nests and is rarely bridged — authoring
 * against it alone passes a topper that falls apart the moment somebody types a phrase. The long one
 * is the real test and the short one catches the opposite case, where a name set at the same span
 * comes out with letters too big to fit.
 */
const SAMPLES = ['Happy Birthday', 'Amelia'];

const DEFAULTS = {
  face: DEFAULT_TOPPER_FACE,
  stroke: 0.12,          // centreline faces only: about a tenth of the letter, as the market sets it
  tracking: faceFit(DEFAULT_TOPPER_FACE),   // the fit at which this face joins itself
  weight: 0,             // outline faces: thickens every stroke, the one lever on a hairline
  thickness: 0.063,      // the sheet, ~3mm
  minDetail: 1.0,        // mm the cutter will hold — the number that decides if a design ships
  span: 0.55,            // share of the cake at size 1
  lineGap: 1.2,          // the LOOSEST setting; rows are nested tighter until they meet
  maxLines: 3,
  bar: true, barRatio: 0.13,
  legs: 2, legLen: 0.42, bury: 0.21,
  bridge: true,
  finishes: ['gold', 'silver', 'rose', 'black'],
  defaultFinish: DEFAULT_TOPPER_FINISH,
  scale: { min: 0.5, max: 1.7, step: 0.05 },
};

/* A local environment, generated in-process.
 *
 * Mirror gold is nothing but reflections: with no environment map a metalness-1 surface has nothing
 * to reflect and renders as flat paint, which would condemn the finish for want of a reflection
 * rather than for how it looks. RoomEnvironment needs no network and no assets host, so the studio
 * works the same on a laptop with no config as it does deployed.
 */
function LocalEnv() {
  const { scene, gl } = useThree();
  useMemo(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    return () => pmrem.dispose();
  }, [scene, gl]);
  return null;
}

// Build the parts once, and derive the meshes, the piece count and the measurements from that same
// build — a separately-computed number is a number that can disagree with the picture beside it.
function buildTopper(font, text, cfg, span) {
  if (!font) return null;
  const probe = topperShapes(font, text, {
    height: 1, weight: cfg.weight, stroke: cfg.stroke, lineGap: cfg.lineGap, tracking: cfg.tracking,
    maxLines: cfg.maxLines, fitAspect: (CAKE_R * 2 * span * MM) / Math.max(0.1, cfg.minDetail),
  });
  if (!probe.width) return null;
  const height = (CAKE_R * 2 * span) / probe.width;

  const t = topperShapes(font, text, {
    height, weight: cfg.weight, stroke: cfg.stroke, lineGap: cfg.lineGap, tracking: cfg.tracking,
    maxLines: cfg.maxLines,
    fitAspect: (CAKE_R * 2 * span * MM) / Math.max(0.1, cfg.minDetail),
    baseline: cfg.bar ? { thickness: probe.capHeight * height * cfg.barRatio } : null,
    legs: cfg.legs > 0 ? { count: cfg.legs, length: cfg.legLen } : null,
  });
  if (!t.parts?.length) return null;

  const bridges = cfg.bridge ? bridgeLoose(t.parts, { width: height * 0.022 }) : [];
  const parts = [...t.parts, ...bridges];
  const groups = components(parts);
  const loose = new Set(groups.slice(1).flat());
  // How long the worst bridge is, because "1 piece" hides the difference between an invisible
  // millimetre tab and a stem ruled across the design.
  const worst = bridges.reduce((m, b) => {
    const xs = b.outer.map(q => q.x), ys = b.outer.map(q => q.y);
    return Math.max(m, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)));
  }, 0);
  return { t, parts, loose, pieces: groups.length, height, bridges: bridges.length, worst };
}

function Topper({ build, cfg, finish }) {
  const geos = useMemo(() => {
    if (!build) return [];
    return build.parts.map((p, i) => {
      const shape = new THREE.Shape(p.outer.map(q => new THREE.Vector2(q.x, q.y)));
      shape.holes = (p.holes ?? []).map(h => new THREE.Path(h.map(q => new THREE.Vector2(q.x, q.y))));
      const g = new THREE.ExtrudeGeometry(shape, { depth: cfg.thickness, bevelEnabled: false });
      g.translate(0, 0, -cfg.thickness / 2);
      return { geo: g, loose: build.loose.has(i) };
    });
  }, [build, cfg.thickness]);

  if (!build) return null;
  const f = topperFinish(finish);

  /* Planted by the bottom of the LEGS, sunk by `bury`, not by the bar.
   * Sitting the bar on the icing buries the legs completely and the word reads as glued to the
   * surface — which hides the part a baker pushes in and whether the prongs are long enough to hold
   * anything up. With no legs the baseline meets the surface, which is how one without them is used. */
  const lowest = Math.min(...build.parts.flatMap(p => p.outer.map(q => q.y)));
  const foot = build.t.legs.length ? lowest + Math.min(cfg.bury, cfg.legLen) : build.t.baselineY;

  return (
    <group position={[0, CAKE_H - foot, 0]}>
      {geos.map(({ geo, loose }, i) => (
        <mesh key={i} geometry={geo} castShadow>
          {loose
            ? <meshStandardMaterial color="#d33" metalness={0.1} roughness={0.5} />
            : <meshStandardMaterial color={f.color} metalness={f.metalness}
                                    roughness={f.roughness} envMapIntensity={f.envIntensity} />}
        </mesh>
      ))}
    </group>
  );
}

const Cake = () => (
  <mesh position={[0, CAKE_H / 2, 0]} receiveShadow>
    <cylinderGeometry args={[CAKE_R, CAKE_R, CAKE_H, 96]} />
    <meshStandardMaterial color="#f3ece2" roughness={0.85} />
  </mesh>
);

// ── panel chrome ───────────────────────────────────────────────────────────────
const s = {
  page:   { display: 'flex', height: '100%', fontFamily: "'Quicksand', sans-serif" },
  panel:  { width: 330, padding: 18, background: '#fff', borderRight: '1.5px solid #E8E4DC', overflowY: 'auto' },
  h1:     { fontSize: 16, fontWeight: 800, color: '#1a1a1a', marginBottom: 4 },
  lead:   { fontSize: 11.5, color: '#6E8577', lineHeight: 1.5, marginBottom: 16 },
  row:    { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 },
  lab:    { fontSize: 11, fontWeight: 800, color: '#6E8577', width: 82, letterSpacing: 0.3, flexShrink: 0 },
  val:    { fontSize: 11, fontWeight: 700, color: '#3D5A44', width: 52, textAlign: 'right' },
  input:  { width: '100%', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', border: '1.5px solid #D8E0DA', borderRadius: 8 },
  select: { flex: 1, padding: '5px 8px', fontFamily: 'inherit', fontSize: 12, border: '1.5px solid #D8E0DA', borderRadius: 7 },
  head:   { fontSize: 10, fontWeight: 800, color: '#9aa8a0', letterSpacing: 0.6, textTransform: 'uppercase', margin: '16px 0 8px' },
  save:   { width: '100%', padding: '10px 14px', fontFamily: 'inherit', fontSize: 13, fontWeight: 800, borderRadius: 9, border: 0, color: '#fff', cursor: 'pointer' },
};

export default function AcrylicTopperStudio() {
  const [cfg, setCfg]   = useState(DEFAULTS);
  const [size, setSize] = useState(1);
  const [finish, setFin] = useState(DEFAULTS.defaultFinish);
  const [sample, setSample] = useState(SAMPLES[0]);
  const [font, setFont] = useState(null);

  const [name, setName] = useState('');
  const [types, setTypes] = useState([]);
  const [typeId, setTypeId] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const glRef = useRef(null);

  const set = (k) => (v) => setCfg(c => ({ ...c, [k]: v }));

  useEffect(() => { fetchElementTypes().then(setTypes).catch(() => setTypes([])); }, []);
  // A face is ~100KB fetched on demand (see loadTopperFace), so this is a load, not a lookup.
  useEffect(() => { let live = true; loadTopperFace(cfg.face).then(f => { if (live) setFont(f); }); return () => { live = false; }; }, [cfg.face]);

  const span = cfg.span * size;
  const shown = useMemo(() => buildTopper(font, sample, cfg, span), [font, sample, cfg, span]);

  /* ⚠️ Checked on BOTH samples, at the authored size — not on whatever happens to be on screen.
   *
   * The preview is one word at one size and says nothing about the other. A save gate that trusts it
   * would pass a topper that cuts cleanly as "Amelia" and comes apart as "Happy Birthday", which is
   * exactly the pair that differs: one stacks and one does not. */
  const audit = useMemo(() => SAMPLES.map(text => {
    const b = buildTopper(font, text, cfg, cfg.span);
    return {
      text,
      pieces: b?.pieces ?? 0,
      feature: b ? b.t.feature * MM : 0,
      rows: b?.t.rows ?? [],
      bridges: b?.bridges ?? 0,
      worst: b ? b.worst * MM : 0,
      ok: !!b && b.pieces === 1 && b.t.feature * MM >= cfg.minDetail,
    };
  }), [font, cfg]);
  const blocked = audit.some(a => !a.ok);

  const slider = (label, key, min, max, step, fmt) => (
    <div style={s.row}>
      <span style={s.lab}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={cfg[key]}
             onChange={e => set(key)(+e.target.value)} style={{ flex: 1, accentColor: '#3D5A44' }} />
      <span style={s.val}>{fmt ? fmt(cfg[key]) : cfg[key].toFixed(2)}</span>
    </div>
  );

  async function save() {
    if (!name.trim()) return setMsg({ ok: false, text: 'Give it a name.' });
    if (!typeId)      return setMsg({ ok: false, text: 'Pick an element type.' });
    if (!cfg.finishes.length) return setMsg({ ok: false, text: 'Offer at least one finish.' });
    setSaving(true); setMsg(null);
    try {
      // The thumbnail is the preview itself, so the picker shows exactly what was authored. Canvas is
      // created with preserveDrawingBuffer, without which this reads back blank.
      const blob = await new Promise(res => glRef.current.domElement.toBlob(res, 'image/png'));
      const thumb = await uploadThumbnail('elements/thumbnails', blob);

      await createGlobalElement({
        name: name.trim(),
        description: null,
        element_type_id: typeId,
        parent_id: null,
        image_url: null,                       // nothing is uploaded: the word is cut at render time
        thumbnail_url: thumb,
        file_size: null,
        allowed_zones: TOPPER_ZONES,
        allowed_actions: TOPPER_ACTIONS,
        default_color: TOPPER_FINISHES[cfg.defaultFinish]?.color ?? null,
        sort_order: 0,
        placement_config: {
          ...PLACEMENT,
          r: cfg.span,
          scale: cfg.scale,
          acrylic: {
            face: cfg.face, stroke: cfg.stroke, weight: cfg.weight, tracking: cfg.tracking,
            thickness: cfg.thickness, minDetail: cfg.minDetail,
            lineGap: cfg.lineGap, maxLines: cfg.maxLines,
            bar: cfg.bar ? { ratio: cfg.barRatio } : null,
            legs: cfg.legs > 0 ? { count: cfg.legs, length: cfg.legLen, bury: cfg.bury } : null,
            bridge: cfg.bridge,
            finishes: cfg.finishes,
            defaultFinish: cfg.defaultFinish,
            text: { default: 'Happy Birthday', maxLen: 24 },
          },
        },
      });
      setMsg({ ok: true, text: 'Acrylic topper saved.' });
      setName('');
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Save failed.' });
    } finally { setSaving(false); }
  }

  return (
    <div style={s.page}>
      <div style={s.panel}>
        <h1 style={s.h1}>Acrylic topper</h1>
        <p style={s.lead}>
          The customer types the word; everything else is set here. The cake is 6 inches, so every
          measurement is the real one. Anything that would arrive as a loose piece is red.
        </p>

        <input style={s.input} value={name} onChange={e => setName(e.target.value)}
               placeholder="Element name (e.g. Script topper — gold)" />

        <div style={{ ...s.row, marginTop: 10 }}>
          <span style={s.lab}>Type</span>
          <select style={s.select} value={typeId} onChange={e => setTypeId(e.target.value)}>
            <option value="">Pick an element type…</option>
            {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>

        <div style={s.head}>The letters</div>
        <div style={s.row}>
          <span style={s.lab}>Face</span>
          {/* Changing the face brings its own fit: -0.16 is what Parisienne needs and is nothing
              like what Elfin needs (-0.39), so carrying the old number over would silently un-join
              the word the moment somebody tried a different face. */}
          <select style={s.select} value={cfg.face}
                  onChange={e => setCfg(c => ({ ...c, face: e.target.value, tracking: faceFit(e.target.value) }))}>
            {Object.entries(TOPPER_FACES).map(([k, f]) =>
              <option key={k} value={k}>{f.label}{f.kind === 'centreline' ? ' (mono)' : ''}</option>)}
          </select>
        </div>
        {/* The stroke is a control only where it is one — off the face's `kind`, never its name. */}
        {isMonoline(cfg.face)
          ? slider('Stroke', 'stroke', 0.05, 0.45, 0.005, () => mm((shown?.t.feature) ?? 0))
          : slider('Weight', 'weight', 0, 0.03, 0.002, x => x.toFixed(3))}
        {slider('Fit', 'tracking', -0.45, 0.05, 0.01, x => x === 0 ? 'as drawn' : `${x.toFixed(2)} em`)}
        {slider('Rows max', 'maxLines', 1, 3, 1, x => String(x))}
        {slider('· gap', 'lineGap', 0.7, 1.6, 0.05,
          x => (shown && Math.abs(shown.t.lineGap - x) > 0.005 ? `${shown.t.lineGap.toFixed(2)} nested` : x.toFixed(2)))}

        <div style={s.head}>The sheet</div>
        {slider('Thickness', 'thickness', 0.004, 0.16, 0.002, mm)}
        {slider('Min detail', 'minDetail', 0.4, 4, 0.1, x => `${x.toFixed(1)}mm`)}

        <div style={s.head}>Standing up</div>
        <div style={s.row}>
          <span style={s.lab}>Base bar</span>
          <input type="checkbox" checked={cfg.bar} onChange={e => set('bar')(e.target.checked)} />
          <span style={{ fontSize: 11, color: '#8a8a8a' }}>a bar the letters sit on</span>
        </div>
        {cfg.bar && slider('· thickness', 'barRatio', 0.05, 0.3, 0.01,
          x => mm((shown?.t.capHeight ?? 0) * x))}
        {slider('Legs', 'legs', 0, 4, 1, x => String(x))}
        {cfg.legs > 0 && slider('· length', 'legLen', 0.15, 0.9, 0.02, mm)}
        {cfg.legs > 0 && slider('· buried', 'bury', 0, 0.9, 0.01, mm)}
        <div style={s.row}>
          <span style={s.lab}>Bridge</span>
          <input type="checkbox" checked={cfg.bridge} onChange={e => set('bridge')(e.target.checked)} />
          <span style={{ fontSize: 11, color: '#8a8a8a' }}>join floating bits</span>
        </div>

        <div style={s.head}>Size the customer gets</div>
        <div style={s.row}>
          <span style={s.lab}>Default</span>
          {/* THE size dial, the one the customer will use — not a slider that happens to set a size. */}
          <SizeDial size={size} min={cfg.scale.min} max={cfg.scale.max} step={cfg.scale.step} onChange={setSize} />
          <span style={{ fontSize: 11, color: '#8a8a8a' }}>
            {mm(CAKE_R * 2 * span)} across
            {Math.abs(size - 1) > 0.001 && (
              <button onClick={() => { set('span')(span); setSize(1); }}
                      style={{ marginLeft: 6, fontFamily: 'inherit', fontSize: 10, fontWeight: 800,
                               border: '1.5px solid #D8E0DA', borderRadius: 6, background: '#fff',
                               padding: '2px 6px', cursor: 'pointer' }}>
                make this the default
              </button>)}
          </span>
        </div>
        <div style={s.row}>
          <span style={s.lab}>Range</span>
          <span style={{ fontSize: 11, color: '#8a8a8a' }}>
            {mm(CAKE_R * 2 * cfg.span * cfg.scale.min)} – {mm(CAKE_R * 2 * cfg.span * cfg.scale.max)}
          </span>
        </div>

        <div style={s.head}>Finishes on offer</div>
        {Object.entries(TOPPER_FINISHES).map(([k, f]) => (
          <div key={k} style={s.row}>
            <input type="checkbox" checked={cfg.finishes.includes(k)}
                   onChange={e => set('finishes')(e.target.checked
                     ? [...cfg.finishes, k] : cfg.finishes.filter(x => x !== k))} />
            <span style={{ width: 16, height: 16, borderRadius: 4, background: f.color,
                           border: '1px solid #00000022', flexShrink: 0 }} />
            <span style={{ fontSize: 12, flex: 1 }}>{f.label}</span>
            <button onClick={() => { set('defaultFinish')(k); setFin(k); }}
                    disabled={!cfg.finishes.includes(k)}
                    style={{ fontFamily: 'inherit', fontSize: 10, fontWeight: 800, padding: '2px 6px',
                             borderRadius: 6, cursor: 'pointer',
                             border: `1.5px solid ${cfg.defaultFinish === k ? '#3D5A44' : '#D8E0DA'}`,
                             background: cfg.defaultFinish === k ? '#3D5A44' : '#fff',
                             color: cfg.defaultFinish === k ? '#fff' : '#6E8577',
                             opacity: cfg.finishes.includes(k) ? 1 : 0.35 }}>
              default
            </button>
          </div>
        ))}

        {/* ── Can it be cut? ───────────────────────────────────────────────────
            Both samples, at the authored size, whichever one is on screen. */}
        <div style={s.head}>Can it be cut?</div>
        {audit.map(a => (
          <div key={a.text} style={{ padding: '8px 10px', borderRadius: 8, marginBottom: 6, fontSize: 11.5,
                                     lineHeight: 1.45, cursor: 'pointer',
                                     background: a.ok ? '#EDF2EE' : '#FDF3E3',
                                     border: `1px solid ${a.ok ? '#D6E2DA' : '#F0DCB8'}`,
                                     color: a.ok ? '#3D5A44' : '#8A5A1E',
                                     outline: sample === a.text ? '2px solid #3D5A44' : 'none' }}
               onClick={() => setSample(a.text)}>
            <b>{a.text}</b> — {a.pieces === 1 ? 'one piece' : `${a.pieces} pieces`}, {a.feature.toFixed(1)}mm thinnest
            {a.rows.length > 1 && <div style={{ color: '#8a8a8a' }}>{a.rows.join(' / ')}</div>}
            {/* ⚠️ Bridges are shown even when the piece count is a clean 1, because 1 is exactly what
                they buy — and a face that needs five stems ruled through it counts the same as one
                that needs a millimetre tab on an i. The number was invisible while the tabs were
                not, which is the wrong way round. */}
            <div style={{ color: a.bridges > 2 ? '#8A5A1E' : '#8a8a8a' }}>
              {a.bridges === 0
                ? 'joins itself — no bridges'
                : `${a.bridges} bridge${a.bridges > 1 ? 's' : ''}, longest ${a.worst.toFixed(1)}mm`}
              {a.bridges > 2 && ' — this face does not join itself; try another'}
            </div>
            {!a.ok && <div>{a.pieces !== 1
              ? 'would arrive in pieces — turn on Bridge or add the bar'
              : `under the ${cfg.minDetail.toFixed(1)}mm the cutter holds — ${isMonoline(cfg.face) ? 'widen the stroke' : 'raise Weight'} or the size`}</div>}
          </div>
        ))}

        <button style={{ ...s.save, marginTop: 8, background: blocked ? '#c9c4bc' : '#3D5A44',
                         cursor: blocked || saving ? 'not-allowed' : 'pointer' }}
                disabled={blocked || saving} onClick={save}>
          {saving ? 'Saving…' : blocked ? 'Fix the warnings above' : 'Save element'}
        </button>
        {msg && <p style={{ marginTop: 8, fontSize: 12, fontWeight: 700,
                            color: msg.ok ? '#3D5A44' : '#b3261e' }}>{msg.text}</p>}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <Canvas shadows camera={{ position: [0, 1.95, 6.2], fov: 32 }}
                gl={{ preserveDrawingBuffer: true }}
                onCreated={({ gl }) => { glRef.current = gl; }}>
          <color attach="background" args={['#EDEAE3']} />
          <ambientLight intensity={0.5} />
          <directionalLight position={[3, 6, 4]} intensity={1.1} castShadow />
          <LocalEnv />
          <Cake />
          <Topper build={shown} cfg={cfg} finish={finish} />
          <OrbitControls target={[0, 0.9, 0]} />
        </Canvas>
      </div>
    </div>
  );
}
