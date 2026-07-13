import React, { useEffect, useMemo, useState } from 'react';
import {
  fetchAdminCakeShapes, createCakeShape, updateCakeShape,
} from '../lib/api.js';
// The catalog + the REAL cake renderer, both imported from core — never re-implemented here. The
// preview below is the same component the customer's designer draws with (CakePreview → toCanvasConfig
// → CakeTier), so a shape that looks right in this studio looks right on a real cake, by construction.
import {
  CakePreview, applyCakeShapeConfig, cakeShapeDef, cakeShapeList,
  TIER_RADII, BOTTOM_H, TIER_HEIGHT_STEP, SHEET_SIZES, SHEET_DEFAULT_KEY,
} from '@spattoo/designer';

// ── Cake Shape Studio ──────────────────────────────────────────────────────────
// Authors the CATALOG of cake footprints — `cake_shapes` master data. A shape is a FAMILY (an outline
// generator in core: circle | rounded_rect | heart | butterfly | polygon | oval) plus a `config` of
// proportions. That split is the whole design: a curve has to be drawn by code, but its proportions are
// data, so a new shape is very often just new config against an existing family (an octagon IS a
// polygon with sides=8) and needs no deploy.
//
// The tier sliders are NOT saved with the shape. A shape has no size of its own — its outline is
// normalised, and the tier's width/depth scale it. The sliders exist so the shape can be judged at the
// sizes a real cake uses, which is the only way to know whether it holds up.

// The knobs each family exposes — data, so a new family adds a row here, not a branch in the JSX.
const FAMILIES = {
  circle:       { label: 'Circle (round cake)', params: [], note: 'The analytic round tier — the cylinder path, with its cream wall styles and finishes.' },
  rounded_rect: { label: 'Rounded rectangle (sheet cake)', params: [], note: 'The analytic sheet prism. Width and depth come from the tier; "square" locks them equal.' },
  heart:        { label: 'Heart',     params: [['Plumpness', 'plump', 0.4, 2, 0.05], ['Cleft depth', 'cleft', 0.2, 2.5, 0.05]] },
  butterfly:    { label: 'Butterfly', params: [['Wing spread', 'wing', 0.4, 2, 0.05]] },
  polygon:      { label: 'Polygon',   params: [['Sides', 'sides', 3, 16, 1], ['Rotation', 'rotation', -180, 180, 1]] },
  oval:         { label: 'Oval',      params: [], note: 'A circle the tier\'s width and depth stretch.' },
};

const RESERVED = ['round', 'rect'];               // what existing designs already store — never re-key
const MAX_TIERS = 4;
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// ── The cake we tune AGAINST is core's own default cake ────────────────────────
// Not invented numbers. A world unit has no honest size in inches (core's only inch↔world constant is
// a sheet-cake fudge — applied to a round tier it calls the default cake 20 inches across), so a shape
// is judged the only way that means anything: next to the cake the designer actually opens with.
//
//   round / any outline → core's default round stack (TIER_RADII, BOTTOM_H, TIER_HEIGHT_STEP)
//   rounded_rect        → the sheet sizes core already ships (the square and rectangle cakes)
//
// So a heart starts at exactly the footprint of the default round cake, and you tune from there.
const roundTier = i => ({
  width:  (TIER_RADII[i] ?? 0.45) * 2,
  depth:  (TIER_RADII[i] ?? 0.45) * 2,
  height: BOTTOM_H - i * TIER_HEIGHT_STEP,
});

const sheetTier = (i, sizeKey) => {
  const sz = SHEET_SIZES[sizeKey] ?? SHEET_SIZES[SHEET_DEFAULT_KEY];
  const shrink = 1 - i * 0.26;                    // upper tiers step in, as a stacked sheet cake does
  return { width: sz.w * shrink, depth: sz.d * shrink, height: BOTTOM_H - i * TIER_HEIGHT_STEP };
};

const defaultTiers = (family, count, sizeKey) =>
  Array.from({ length: count }, (_, i) => (family === 'rounded_rect' ? sheetTier(i, sizeKey) : roundTier(i)));

export default function CakeShapeStudio() {
  const [shapes, setShapes]   = useState([]);
  const [selKey, setSelKey]   = useState(null);
  const [dirty, setDirty]     = useState([]);      // keys edited but not yet saved
  const [tiers, setTiers]     = useState(() => defaultTiers('circle', 1));
  const [sizeKey, setSizeKey] = useState(SHEET_DEFAULT_KEY);   // which sheet size a rect shape starts at
  const [spin, setSpin]       = useState(false);               // turntable off by default: a shape is
                                                               // judged from a held angle, not a moving one
  const [busy, setBusy]       = useState(null);
  const [msg, setMsg]         = useState(null);

  // SEED first, DB second — the same contract the designer renders under (applyCakeShapeConfig overlays
  // rows onto core's in-code seed). So the studio works with no `cake_shapes` table at all: the shapes
  // are the ones the code knows, tunable and previewable, just not yet SAVEABLE. When the table lands,
  // its rows overlay the seed and Save lights up — no other change.
  useEffect(() => {
    const seeded = cakeShapeList();                       // [{ key, label, family, config }] — no id
    setShapes(seeded);
    setSelKey(k => k ?? seeded[0]?.key ?? null);

    fetchAdminCakeShapes()
      .then(rows => {
        if (!rows?.length) return;
        applyCakeShapeConfig(rows);
        // Rows WIN over the seed (they carry an id, which is what makes a shape saveable); seeded
        // shapes with no row stay in the list so nothing the code can render disappears from the picker.
        setShapes(list => {
          const byKey = new Map(list.map(s => [s.key, s]));
          for (const row of rows) byKey.set(row.key, row);
          return [...byKey.values()];
        });
      })
      .catch(() => {/* no table yet — the seed is the catalog, and that is a supported state */});
  }, []);

  const sel = shapes.find(s => s.key === selKey) || null;
  const fam = FAMILIES[sel?.family] || FAMILIES.circle;

  // Switching shape re-seats the cake on the DEFAULT size for that family — a heart lands on the round
  // cake's footprint, a sheet on its sheet size — so the comparison is always like-for-like.
  const reset = (count = tiers.length, key = sizeKey) => setTiers(defaultTiers(sel?.family, count, key));
  useEffect(() => {
    if (sel) setTiers(t => defaultTiers(sel.family, t.length, sizeKey));
  }, [sel?.family, sizeKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  const isDraft = !!sel && dirty.includes(sel.key);
  const isReserved = RESERVED.includes(sel?.key);
  // A shape is saveable only once it is a ROW. Until the `cake_shapes` table exists, this studio tunes
  // the code seed: real shapes, real renderer, nothing persisted. Saying so is better than a Save button
  // that quietly fails.
  const persisted = !!sel?.id;

  // Every edit re-overlays the catalog, so the 3D preview reflects the knob the operator is dragging
  // RIGHT NOW — not the last saved row.
  function edit(patch) {
    if (!sel) return;
    const next = { ...sel, ...patch, config: { ...sel.config, ...(patch.config || {}) } };
    applyCakeShapeConfig([next]);
    setShapes(list => list.map(s => (s.key === sel.key ? next : s)));
    setDirty(d => (d.includes(sel.key) ? d : [...d, sel.key]));
  }

  // The design fed to the REAL renderer. Each tier wears the shape being authored, so a 3-tier heart
  // cake is previewed as a 3-tier heart cake — with the default buttercream the designer opens with.
  const design = useMemo(() => ({
    tiers: tiers.map(t => ({
      shape: selKey ?? 'round',
      width: t.width,
      depth: t.depth,
      radius: t.width / 2,            // the round path is sized by radius; keep the two in step
      height: t.height,
      color: '#f5b8c8',
      topPipings: [], bottomPipings: [], creamLayers: [],
    })),
    texts: [], ages: [], stickers: [], writing: null, piping: [],
  }), [tiers, selKey, shapes]);       // `shapes` in deps: a config edit must re-render the cake

  async function addShape() {
    const label = window.prompt('New shape name (e.g. Octagon):', '');
    if (!label?.trim()) return;
    setBusy('Creating…');
    try {
      const created = await createCakeShape({
        key: slug(label), label: label.trim(), family: 'polygon',
        config: { sides: 8, rotation: 0 }, sort_order: shapes.length + 1,
      });
      applyCakeShapeConfig([created]);
      setShapes(list => [...list, created]);
      setSelKey(created.key);
      setMsg({ ok: true, text: `"${created.label}" created — tune it below, then Save.` });
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Could not create the shape.' });
    } finally { setBusy(null); }
  }

  async function save() {
    if (!sel || !persisted) return;
    setBusy('Saving…');
    setMsg(null);
    try {
      const saved = await updateCakeShape(sel.id, {
        label: sel.label, family: sel.family, config: sel.config, sort_order: sel.sort_order,
      });
      applyCakeShapeConfig([saved]);
      setShapes(list => list.map(s => (s.key === saved.key ? saved : s)));
      setDirty(d => d.filter(k => k !== saved.key));
      setMsg({ ok: true, text: `"${saved.label}" saved. Every cake using it follows.` });
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Save failed.' });
    } finally { setBusy(null); }
  }

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Cake Shape Studio</h1>
      <p style={s.sub}>
        The catalog of cake <b>footprints</b>. A shape is a <b>family</b> (the curve) plus its
        <b> proportions</b> (data) — so an octagon is just a polygon with 8 sides, and needs no release.
        The preview is the real designer renderer, so what you see here is what a customer gets.
      </p>

      <div style={s.grid}>
        <div style={s.col}>
          <label style={s.label}>Shape</label>
          <select style={s.select} value={selKey ?? ''} onChange={e => setSelKey(e.target.value)}>
            {shapes.map(sh => <option key={sh.id} value={sh.key}>{sh.label}{sh.is_active ? '' : ' (inactive)'}</option>)}
          </select>
          <button style={{ ...s.btnSm, marginTop: 8 }} onClick={addShape} disabled={!!busy || !shapes.some(sh => sh.id)}>
            + New shape
          </button>

          {sel && (
            <div style={s.card}>
              <div style={s.cardHead}>
                <b style={{ fontSize: 12, color: '#7A5E1F' }}>{sel.label}</b>
                <span style={{ fontSize: 11, color: isDraft ? '#7A5E1F' : '#9a8a63', fontWeight: isDraft ? 700 : 400 }}>
                  {isDraft ? 'edited — not saved' : 'every cake using it shares this'}
                </span>
              </div>

              <div style={s.mini}>Family</div>
              <select style={s.select} value={sel.family}
                onChange={e => edit({ family: e.target.value, config: {} })} disabled={isReserved}>
                {Object.entries(FAMILIES).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
              </select>
              {fam.note && <div style={s.hint}>{fam.note}</div>}
              {isReserved && (
                <div style={s.hint}>
                  “{sel.key}” is what existing designs already store, so its family is fixed — changing it
                  would reshape every cake that uses it.
                </div>
              )}

              {sel.family === 'rounded_rect' && (
                <label style={s.check}>
                  <input type="checkbox" checked={!!sel.config?.square}
                    onChange={e => edit({ config: { square: e.target.checked || undefined } })} />
                  Square (depth follows width)
                </label>
              )}

              {fam.params.map(([label, key, min, max, step]) => (
                <Slider key={key} label={label} min={min} max={max} step={step}
                  value={sel.config?.[key] ?? cakeShapeDef(sel.key).config?.[key] ?? min}
                  onChange={v => edit({ config: { [key]: v } })} />
              ))}

              {persisted ? (
                <button style={{ ...s.btn, opacity: busy || !isDraft ? 0.55 : 1 }}
                  disabled={!!busy || !isDraft} onClick={save}>
                  {busy || (isDraft ? 'Save shape' : 'Saved')}
                </button>
              ) : (
                <div style={s.notice}>
                  <b>Tuning the code seed.</b> The <code>cake_shapes</code> table isn&apos;t wired yet, so
                  nothing here persists — reload and it&apos;s back to what core ships. Dial a shape in,
                  tell me the numbers, and they go into the seed; when the table lands, these same controls
                  save straight to it.
                </div>
              )}
            </div>
          )}

          {msg && <div style={{ ...s.msg, color: msg.ok ? '#2e7d32' : '#c0392b' }}>{msg.text}</div>}

          <div style={s.card}>
            <div style={s.cardHead}>
              <b style={{ fontSize: 12, color: '#2C4433' }}>Tiers</b>
              <span style={{ fontSize: 11, color: '#6B8C74' }}>not saved with the shape — for judging it</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
              <button style={s.btnSm} disabled={tiers.length >= MAX_TIERS}
                onClick={() => setTiers(t => [...t, defaultTiers(sel?.family, t.length + 1, sizeKey)[t.length]])}>+ Tier</button>
              <button style={s.btnSm} disabled={tiers.length <= 1}
                onClick={() => setTiers(t => t.slice(0, -1))}>− Tier</button>
              <button style={s.btnSm} onClick={() => reset()}>Reset to core&apos;s default cake</button>
            </div>

            {sel?.family === 'rounded_rect' && (
              <>
                <div style={s.mini}>Sheet size (the ones core already ships)</div>
                <select style={s.select} value={sizeKey} onChange={e => setSizeKey(e.target.value)}>
                  {Object.entries(SHEET_SIZES).map(([k, sz]) => (
                    <option key={k} value={k}>{sz.label} — {sz.inches}"</option>
                  ))}
                </select>
              </>
            )}

            {tiers.map((t, i) => {
              const base = (sel?.family === 'rounded_rect' ? sheetTier(i, sizeKey) : roundTier(i));
              return (
                <div key={i} style={s.tier}>
                  <div style={s.mini}>Tier {i + 1}{i === 0 ? ' (bottom)' : ''}</div>
                  <Slider label="Width"  min={0.4} max={3.6} step={0.02} value={t.width}  base={base.width}
                    onChange={v => setTiers(l => l.map((x, j) => (j === i ? { ...x, width: v } : x)))} />
                  <Slider label="Depth"  min={0.4} max={3.6} step={0.02} value={t.depth}  base={base.depth}
                    onChange={v => setTiers(l => l.map((x, j) => (j === i ? { ...x, depth: v } : x)))} />
                  <Slider label="Height" min={0.3} max={2.2} step={0.02} value={t.height} base={base.height}
                    onChange={v => setTiers(l => l.map((x, j) => (j === i ? { ...x, height: v } : x)))} />
                </div>
              );
            })}
            <div style={s.hint}>
              Sizes are <b>world units</b>, and each slider shows how far you are from <b>core&apos;s default
              cake</b> — the one the designer opens with. That is the only honest yardstick here: core&apos;s
              single inch↔world constant is a sheet-cake fudge (applied to a round tier it calls the
              default cake 20&quot; across), so “×1.0 of the default” means something and “1.62 inches”
              would not. A shape carries no size of its own — its outline is normalised and the tier
              stretches it — so one shape serves every cake size.
            </div>
          </div>
        </div>

        <div style={s.stage}>
          <label style={s.label}>
            Preview — the real designer renderer{' '}
            <span style={{ fontWeight: 400, color: '#8fae98' }}>· drag to orbit, scroll to zoom</span>
          </label>
          <div style={s.canvas}>
            <CakePreview design={design} autoRotate={spin} enableZoom />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button style={{ ...s.btnSm, ...(spin ? s.btnSmOn : null) }} onClick={() => setSpin(v => !v)}>
              {spin ? 'Stop turntable' : 'Spin'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// `base` = core's default for this control. Shown as a MULTIPLE, because that is the comparison an
// operator can actually act on ("a tenth bigger than the default cake"), where a raw world unit is not.
function Slider({ label, min, max, step, value, onChange, base }) {
  const rel = base ? value / base : null;
  const off = rel != null && Math.abs(rel - 1) > 0.005;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={s.mini}>
        {label} — {step >= 1 ? Math.round(value) : (+value).toFixed(2)}
        {rel != null && (
          <span style={{ fontWeight: 400, color: off ? '#7A5E1F' : '#8fae98' }}>
            {'  '}{off ? `×${rel.toFixed(2)} of core's default` : '= core\'s default'}
          </span>
        )}
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(+e.target.value)} style={{ width: '100%' }} />
    </div>
  );
}

const s = {
  page:    { maxWidth: 1720, margin: '0 auto', padding: '24px 20px 64px', fontFamily: "'Quicksand', sans-serif" },
  h1:      { fontSize: 22, fontWeight: 800, color: '#2C4433', margin: '0 0 6px' },
  sub:     { fontSize: 13, color: '#5C7565', lineHeight: 1.6, margin: '0 0 16px', maxWidth: 860 },
  grid:    { display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' },
  // A fixed control RAIL and a big STAGE. The stage sticks, so the cake stays in view while the tier
  // sliders are dragged — you cannot tune a shape you have scrolled off the screen.
  col:     { flex: '0 0 380px', minWidth: 340, display: 'flex', flexDirection: 'column' },
  stage:   { flex: '1 1 640px', minWidth: 520, position: 'sticky', top: 16, display: 'flex', flexDirection: 'column' },
  label:   { fontSize: 12, fontWeight: 700, color: '#2C4433', margin: '12px 0 4px' },
  mini:    { fontSize: 11, fontWeight: 700, color: '#6B8C74', margin: '6px 0 3px' },
  hint:    { fontSize: 11, color: '#9a8a63', marginTop: 6, lineHeight: 1.5 },
  select:  { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontSize: 13, fontFamily: 'inherit', background: '#fff' },
  card:    { marginTop: 12, padding: '10px 12px', borderRadius: 10, border: '1.5px solid #E6D9BE', background: '#FBF7EF' },
  cardHead:{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  tier:    { marginTop: 8, paddingTop: 8, borderTop: '1px solid #EDE3CC' },
  check:   { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12, fontWeight: 700, color: '#2C4433' },
  canvas:  { width: '100%', height: 'min(78vh, 900px)', minHeight: 520, borderRadius: 12, border: '1.5px solid #C5D4C8', background: '#F7FAF8', overflow: 'hidden' },
  btn:     { marginTop: 14, padding: '11px 16px', borderRadius: 10, border: 'none', background: '#3D5A44', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', width: '100%' },
  btnSm:   { padding: '7px 12px', borderRadius: 8, border: '1.5px solid #C5D4C8', background: '#fff', color: '#2C4433', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnSmOn: { borderColor: '#3D5A44', background: '#EEF5F0', color: '#3D5A44' },
  msg:     { marginTop: 10, fontSize: 13, fontWeight: 700 },
  notice:  { marginTop: 14, padding: '10px 12px', borderRadius: 8, background: '#fff', border: '1px dashed #D6C79E', fontSize: 12, color: '#7A5E1F', lineHeight: 1.6 },
};
