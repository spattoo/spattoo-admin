import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchAdminCakeShapes, createCakeShape, updateCakeShape, uploadAsset,
} from '../lib/api.js';
// The catalog + the REAL cake renderer, both imported from core — never re-implemented here. The
// preview below is the same component the customer's designer draws with (CakePreview → toCanvasConfig
// → CakeTier), so a starter that looks right in this studio looks right on a real cake, by construction.
import {
  CakePreview, applyCakeShapeConfig, cakeShapeDef, cakeShapeList,
  TIER_RADII, BOTTOM_H, TIER_HEIGHT_STEP, SHEET_SIZES, SHEET_DEFAULT_KEY,
  shapeView, captureThumbnailBlob, CAMERA_FOV, CAMERA_POSITION,
} from '@spattoo/designer';

// ── Cake Shape Studio ──────────────────────────────────────────────────────────
// Composes the STARTER CAKES a customer picks from "New" — each a NAMED cake stored as a self-contained
// `design` (the same shape a template has). A starter is one or more tiers, and — because geometry is
// self-contained PER TIER — each tier can be ANY shape: a round base under a heart top is just two tiers
// with different families. That is the whole reason this is a composer and not a "pick one curve" form:
// the old studio could only make single-family shapes and couldn't even start from Round.
//
// A tier's SHAPE is a FAMILY (an outline generator shipped in core: circle | rounded_rect | heart |
// butterfly | polygon | oval) plus a `config` of proportions — the curve is code, its proportions are
// data. FUTURE: a tier will also carry a TYPE (cake | spacer | board); it slots in beside Shape with no
// rework, because a tier is already an independent, self-describing unit.
//
// Save captures a FRONT VIEW through the real renderer and stores it in R2 — the picture the customer's
// New grid shows, so the tile is a photograph of the cake she gets, not a drawing of a footprint.

// The families a tier can be, and the knobs each parametric one exposes. Data, so a new curve in core is
// a row here, not a branch in the JSX. Circle/oval have no knobs (sized entirely by the tier).
const FAMILIES = {
  circle:       { label: 'Round',     params: [] },
  rounded_rect: { label: 'Rectangle', params: [] },   // + the "square" toggle, handled inline
  heart:        { label: 'Heart',     params: [['Plumpness', 'plump', 0.4, 2, 0.05], ['Cleft depth', 'cleft', 0.2, 2.5, 0.05], ['Tip roundness', 'tip', 0, 0.35, 0.01]] },
  butterfly:    { label: 'Butterfly', params: [['Wing spread', 'wing', 0.4, 2, 0.05]] },
  polygon:      { label: 'Polygon',   params: [['Sides', 'sides', 3, 16, 1], ['Rotation', 'rotation', -180, 180, 1]] },
  oval:         { label: 'Oval',      params: [] },
  number:       { label: 'Number',    params: [] },   // config is the typed digits, not sliders (see below)
};

// Where a tier's proportions START when you pick a family. Not an opinion about the shape — a legible
// starting point to drag away from.
const NEW_CONFIG = {
  heart:     { plump: 1, cleft: 1, tip: 0.12 },
  butterfly: { wing: 1 },
  polygon:   { sides: 6, rotation: 0 },
  oval:      {},
  rounded_rect: { square: false },
  circle:    {},
  number:    { digits: '1' },
};

// A tier stores its own shape KEY too (for cakeShapeOf + the legacy 'rect' checks); it follows the family.
const keyForFamily = f => (f === 'circle' ? 'round' : f === 'rounded_rect' ? 'rect' : f);

const RESERVED = ['round', 'rect'];   // keys existing designs already store — never re-key / retire
const DRAFT_KEY = '__draft';
const MAX_TIERS = 4;
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// Core's default sizes — the honest yardstick each slider measures against (the designer opens with these).
const roundTier = i => ({ width: (TIER_RADII[i] ?? 0.45) * 2, depth: (TIER_RADII[i] ?? 0.45) * 2, height: BOTTOM_H - i * TIER_HEIGHT_STEP });
const sheetTier = i => {
  const sz = SHEET_SIZES[SHEET_DEFAULT_KEY];
  const shrink = 1 - i * 0.26;   // upper tiers step in, as a stacked sheet cake does
  return { width: sz.w * shrink, depth: sz.d * shrink, height: BOTTOM_H - i * TIER_HEIGHT_STEP };
};
const baseSize = (family, i) => (family === 'rounded_rect' ? sheetTier(i) : roundTier(i));

// A fresh tier of `family` at stack index `i`, at that family's default size + starting proportions.
function newTier(family = 'circle', i = 0) {
  const b = baseSize(family, i);
  // A number cake is a flat slab, not a tall block — default it thinner (the customer/admin can raise it).
  const height = family === 'number' ? 0.7 : b.height;
  return { family, config: { ...(NEW_CONFIG[family] ?? {}) }, width: b.width, depth: b.depth, height };
}

// A saved design's tiers → the editable rows this studio drives (family + config + world sizes).
function tiersFromDesign(design) {
  const arr = design?.tiers ?? [];
  if (!arr.length) return [newTier('circle', 0)];
  return arr.map((t, i) => {
    const family = t.shapeFamily ?? 'circle';
    const width = t.width ?? (t.radius != null ? t.radius * 2 : baseSize(family, i).width);
    return {
      family,
      config: { ...(t.shapeConfig ?? {}) },
      width,
      depth: t.depth ?? width,
      height: t.height ?? (BOTTOM_H - i * TIER_HEIGHT_STEP),
    };
  });
}

// The editable rows for a catalog key. A row with a stored design loads exactly as saved; a seed key with
// no design (the code's round/rect fallback) loads as one tier of its family.
function tiersFor(key) {
  const def = cakeShapeDef(key);
  return def.design?.tiers?.length ? tiersFromDesign(def.design) : [newTier(def.family ?? 'circle', 0)];
}

export default function CakeShapeStudio() {
  const [shapes, setShapes] = useState([]);        // the catalog list (left rail)
  const [selKey, setSelKey] = useState('round');   // selected starter key, or DRAFT_KEY
  const [name, setName]     = useState('');        // the edited name
  const [tiers, setTiers]   = useState(() => [newTier('circle', 0)]);
  const [dirty, setDirty]   = useState(false);     // unsaved edits to the current selection
  const [spin, setSpin]     = useState(false);     // turntable off by default: judge from a held angle
  const [lens, setLens]     = useState('customer');// 'customer' | 'silhouette' — see the preview comment
  const [busy, setBusy]     = useState(null);
  const [msg, setMsg]       = useState(null);
  const shotRef = useRef(null);

  const sel = shapes.find(s => s.key === selKey) || null;
  const isNew = selKey === DRAFT_KEY;
  const isReserved = RESERVED.includes(selKey);

  // Load a selection into the editable rows. Kept a plain function (not an effect) so a click is the only
  // thing that ever replaces the rows — dragging a slider never gets clobbered by a re-render.
  function loadInto(key) {
    if (key === DRAFT_KEY) { setName(''); setTiers([newTier('circle', 0)]); setDirty(false); return; }
    setName(cakeShapeDef(key).label ?? '');
    setTiers(tiersFor(key));
    setDirty(false);
  }

  // SEED first, DB second — same contract the designer renders under. The studio works with no table at
  // all (the code's seed is the catalog, just not yet SAVEABLE); when rows land they overlay the seed and
  // carry the id that makes Save an update.
  useEffect(() => {
    setShapes(cakeShapeList());
    loadInto('round');
    fetchAdminCakeShapes()
      .then(rows => {
        if (!rows?.length) return;
        applyCakeShapeConfig(rows);
        // Keep the DERIVED entry (family/config/tiers unpacked from the design) + the row's id/sort_order,
        // so the list and the editor read one field shape whether a shape came from seed or DB.
        setShapes(list => {
          const byKey = new Map(list.map(s => [s.key, s]));
          for (const row of rows) byKey.set(row.key, { ...cakeShapeDef(row.key), key: row.key, id: row.id, sort_order: row.sort_order });
          return [...byKey.values()].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
        });
        // Re-load the initial selection now its real (DB) design exists — but only if the user hasn't
        // navigated away or started editing in the meantime.
        setSelKey(cur => { if (cur === 'round') loadInto('round'); return cur; });
      })
      .catch(() => {/* no table yet — the seed is the catalog, and that is a supported state */});
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // ── Selection / creation ──────────────────────────────────────────────────────
  function guardDirty() { return !dirty || window.confirm('Discard unsaved changes to this starter?'); }
  function selectStarter(key) {
    if (key === selKey || !guardDirty()) return;
    setSelKey(key); loadInto(key); setMsg(null);
  }
  function startNew() {
    if (!guardDirty()) return;
    setSelKey(DRAFT_KEY); setName(''); setTiers([newTier('circle', 0)]); setDirty(false); setMsg(null);
  }
  function discard() { setDirty(false); setSelKey('round'); loadInto('round'); setMsg(null); }

  // ── Tier edits (every one marks the selection dirty) ──────────────────────────
  const editName = v => { setName(v); setDirty(true); };
  const setTierFamily = (i, family) => { setTiers(ts => ts.map((t, j) => j === i ? { ...t, family, config: { ...(NEW_CONFIG[family] ?? {}) } } : t)); setDirty(true); };
  const setTierConfig = (i, patch) => { setTiers(ts => ts.map((t, j) => j === i ? { ...t, config: { ...t.config, ...patch } } : t)); setDirty(true); };
  const setTierSize   = (i, patch) => { setTiers(ts => ts.map((t, j) => j === i ? { ...t, ...patch } : t)); setDirty(true); };
  const addTier = () => { setTiers(ts => ts.length >= MAX_TIERS ? ts : [...ts, newTier(ts[ts.length - 1]?.family ?? 'circle', ts.length)]); setDirty(true); };
  const removeTier = i => { setTiers(ts => ts.length <= 1 ? ts : ts.filter((_, j) => j !== i)); setDirty(true); };

  // The design fed to the REAL renderer AND saved — self-contained per tier (shapeFamily/shapeConfig), so
  // the preview renders the way a customer's cake will, and this object is the save payload verbatim.
  const design = useMemo(() => ({
    tiers: tiers.map(t => {
      const square = t.family === 'rounded_rect' && t.config?.square;
      return {
        shape: keyForFamily(t.family),
        shapeFamily: t.family,
        shapeConfig: t.config ?? {},
        width: t.width,
        depth: square ? t.width : t.depth,
        radius: t.width / 2,      // the round path is sized by radius; keep the two in step
        height: t.height,
        color: '#f5b8c8', topPipings: [], bottomPipings: [], creamLayers: [],
      };
    }),
    texts: [], ages: [], stickers: [], writing: null, piping: [],
  }), [tiers]);

  // The picture the customer's grid shows — captured off the HIDDEN stage below (a display:none canvas has
  // no WebGL frame to read back), framed by core's ONE shape camera so every tile is shot the same way. A
  // failed capture is NON-FATAL: the starter saves without a picture and the picker renders it live.
  async function captureThumb() {
    try {
      const canvas = shotRef.current?.querySelector('canvas');
      if (!canvas) return null;
      const blob = await captureThumbnailBlob(canvas);
      return blob ? await uploadAsset('shapes/thumbnails', blob) : null;
    } catch { return null; }
  }

  // The ONE save. A draft becomes a row (POST); an existing starter is updated (PATCH). Reserved round/rect
  // keep their key (the API refuses to re-key them); everything else keys off the name.
  async function save() {
    const label = name.trim();
    if (!label) return setMsg({ ok: false, text: 'Name the starter before saving it.' });
    const key = isNew ? slug(label) : selKey;
    if (isNew && !key) return setMsg({ ok: false, text: 'That name has no letters or numbers to key on.' });

    setBusy('Saving…'); setMsg(null);
    try {
      const thumbnail_key = await captureThumb();
      const saved = isNew
        ? await createCakeShape({ key, label, design, thumbnail_key, sort_order: shapes.length + 1 })
        : await updateCakeShape(sel.id, { label, design, thumbnail_key, sort_order: sel.sort_order });

      applyCakeShapeConfig([saved]);
      const entry = { ...cakeShapeDef(saved.key), key: saved.key, id: saved.id, sort_order: saved.sort_order };
      setShapes(list => [...list.filter(s => s.key !== selKey && s.key !== saved.key), entry].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)));
      setSelKey(saved.key); setName(saved.label ?? label); setDirty(false);
      setMsg({ ok: true, text: isNew ? `"${label}" saved.` : `"${label}" updated. Every cake using it follows.` });
    } catch (err) {
      // 409 = the key (from the name) collides with an existing starter.
      setMsg({ ok: false, text: /409|exist|dupli/i.test(err.message || '') ? 'A starter with that name already exists — pick another.' : (err.message || 'Save failed.') });
    } finally { setBusy(null); }
  }

  // Soft-delete: the row stays, it just stops being offered. A hard delete would strand any design already
  // storing the key (the designer degrades an unknown shape to round — a cake silently changing shape).
  async function retire() {
    if (!sel?.id || isReserved) return;
    if (!window.confirm(`Retire "${sel.label}"? It stops being offered; cakes already using it keep it.`)) return;
    setBusy('Retiring…');
    try {
      const saved = await updateCakeShape(sel.id, { is_active: false });
      setShapes(list => list.filter(s => s.key !== saved.key));
      discard();
      setMsg({ ok: true, text: `"${saved.label}" retired.` });
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Could not retire the starter.' });
    } finally { setBusy(null); }
  }

  const canSave = isNew || dirty;

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Cake Shape Studio</h1>
      <p style={s.sub}>
        The <b>starter cakes</b> a customer picks from <b>New</b>. Each is a named cake — <b>one or more
        tiers</b>, and <b>every tier can be any shape</b> (a round base under a heart top is just two
        tiers). Pick one on the left to edit it, or <b>+ New starter</b> to compose one. Only <b>Round</b>
        and <b>Rectangle</b> are reserved. The preview is the real designer renderer, so what you see here
        is what a customer gets.
      </p>

      <div style={s.grid}>
        {/* ── Left rail: the starter list + create ── */}
        <div style={s.listCol}>
          <button style={s.btn} disabled={!!busy} onClick={startNew}>+ New starter</button>
          <div style={s.list}>
            {isNew && (
              <div style={{ ...s.listItem, ...s.listItemSel }}>
                <div style={s.thumbPh}>✎</div>
                <span>{name.trim() || 'New starter'} <span style={s.unsaved}>· unsaved</span></span>
              </div>
            )}
            {shapes.map(sh => (
              <button key={sh.key} style={{ ...s.listItem, ...(sh.key === selKey ? s.listItemSel : null) }}
                onClick={() => selectStarter(sh.key)}>
                {sh.thumbnailKey
                  ? <img src={sh.thumbnailKey} alt="" width={34} height={34} style={s.thumb} />
                  : <div style={s.thumbPh}>{(sh.label || '?')[0]}</div>}
                <span>{sh.label}{RESERVED.includes(sh.key) && <span style={s.reserved}> · reserved</span>}</span>
              </button>
            ))}
          </div>
        </div>

        {/* ── Middle: the editor ── */}
        <div style={s.col}>
          <div style={s.mini}>Name</div>
          <input style={{ ...s.input, ...(isReserved ? s.inputDisabled : null) }} value={name}
            placeholder="e.g. 3 Tier Classic" disabled={isReserved || !!busy}
            onChange={e => editName(e.target.value)} />
          {isReserved && <div style={s.hint}>“{selKey}” is a reserved key existing designs store — its tiers are editable, its name and key are not.</div>}

          <div style={{ ...s.cardHead, marginTop: 14 }}>
            <b style={{ fontSize: 12, color: '#2C4433' }}>Tiers</b>
            <span style={{ fontSize: 11, color: '#6B8C74' }}>bottom → top · the cake a customer starts with</span>
          </div>

          {tiers.map((t, i) => {
            const fam = FAMILIES[t.family] || FAMILIES.circle;
            const b = baseSize(t.family, i);
            const square = t.family === 'rounded_rect' && t.config?.square;
            const pos = i === 0 ? ' (bottom)' : i === tiers.length - 1 ? ' (top)' : '';
            return (
              <div key={i} style={s.tier}>
                <div style={s.cardHead}>
                  <b style={{ fontSize: 12, color: '#7A5E1F' }}>Tier {i + 1}{pos}</b>
                  {tiers.length > 1 && (
                    <button style={s.linkBtn} disabled={!!busy} onClick={() => removeTier(i)}>Remove</button>
                  )}
                </div>

                <div style={s.mini}>Shape</div>
                <select style={s.select} value={t.family} disabled={!!busy}
                  onChange={e => setTierFamily(i, e.target.value)}>
                  {Object.entries(FAMILIES).map(([f, def]) => <option key={f} value={f}>{def.label}</option>)}
                </select>

                {t.family === 'rounded_rect' && (
                  <label style={s.check}>
                    <input type="checkbox" checked={!!square}
                      onChange={e => setTierConfig(i, { square: e.target.checked || undefined })} />
                    Square (depth follows width)
                  </label>
                )}

                {t.family === 'number' && (
                  <>
                    <div style={s.mini}>Number (the customer edits this on their cake)</div>
                    <input style={s.select} value={t.config?.digits ?? ''} placeholder="e.g. 4"
                      inputMode="numeric" maxLength={4}
                      onChange={e => setTierConfig(i, { digits: e.target.value.replace(/[^0-9]/g, '').slice(0, 4) })} />
                  </>
                )}

                {fam.params.map(([label, key, min, max, step]) => (
                  <Slider key={key} label={label} min={min} max={max} step={step}
                    value={t.config?.[key] ?? NEW_CONFIG[t.family]?.[key] ?? min}
                    onChange={v => setTierConfig(i, { [key]: v })} />
                ))}

                <Slider label="Width" min={0.4} max={3.6} step={0.02} value={t.width} base={b.width}
                  onChange={v => setTierSize(i, { width: v })} />
                {/* A number's depth is set by the digit's own aspect (it must not distort), like a square rect. */}
                {!square && t.family !== 'number' && (
                  <Slider label="Depth" min={0.4} max={3.6} step={0.02} value={t.depth} base={b.depth}
                    onChange={v => setTierSize(i, { depth: v })} />
                )}
                <Slider label="Height" min={0.3} max={2.2} step={0.02} value={t.height} base={b.height}
                  onChange={v => setTierSize(i, { height: v })} />
              </div>
            );
          })}

          <button style={{ ...s.btnSm, marginTop: 10 }} disabled={tiers.length >= MAX_TIERS || !!busy} onClick={addTier}>
            + Add tier
          </button>

          <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
            {canSave ? (
              <button style={{ ...s.btn, marginTop: 0, flex: 1 }} disabled={!!busy} onClick={save}>
                {busy || (isNew ? 'Save starter' : 'Save changes')}
              </button>
            ) : (
              <div style={{ flex: 1, fontSize: 12, color: '#8fae98', fontWeight: 700 }}>Up to date</div>
            )}
            {isNew
              ? <button style={s.btnSm} disabled={!!busy} onClick={discard}>Discard</button>
              : !isReserved && <button style={{ ...s.btnSm, color: '#c0392b', border: '1.5px solid #e8c4bd' }} disabled={!!busy} onClick={retire}>Retire</button>}
          </div>

          {msg && <div style={{ ...s.msg, color: msg.ok ? '#2e7d32' : '#c0392b' }}>{msg.text}</div>}

          <div style={s.hint}>
            Sizes are <b>world units</b>; each slider shows how far you are from <b>core&apos;s default
            cake</b> — the only honest yardstick, since core&apos;s single inch↔world constant is a
            sheet-cake fudge. A shape carries no size of its own — its outline is normalised and the tier
            stretches it — so one shape serves every cake size.
          </div>
        </div>

        {/* ── Right: the live preview ── */}
        <div style={s.stage}>
          <label style={s.label}>
            Preview — {lens === 'customer' ? "the customer's view" : 'silhouette lens'}{' '}
            <span style={{ fontWeight: 400, color: '#8fae98' }}>· drag to orbit, scroll to zoom</span>
          </label>
          <div style={s.canvas}>
            {/* DEFAULT: the camera the CUSTOMER looks through (core's CAMERA_FOV/CAMERA_POSITION) — the only
                honest way to judge how TALL a cake reads. SILHOUETTE: a long lens that removes perspective
                splay, for judging the CURVE rather than the height. */}
            <CakePreview
              design={design} autoRotate={spin} enableZoom
              {...(lens === 'customer'
                ? { fov: CAMERA_FOV, cameraPosition: CAMERA_POSITION, target: [0, 0.9, 0] }
                : { fov: 18, cameraPosition: [0, 7.5, 20], target: [0, 0.9, 0] })}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button style={{ ...s.btnSm, ...(spin ? s.btnSmOn : null) }} onClick={() => setSpin(v => !v)}>
              {spin ? 'Stop turntable' : 'Spin'}
            </button>
            <button style={{ ...s.btnSm, ...(lens === 'silhouette' ? s.btnSmOn : null) }}
              onClick={() => setLens(l => (l === 'customer' ? 'silhouette' : 'customer'))}>
              {lens === 'customer' ? 'Silhouette lens' : "Customer's view"}
            </button>
          </div>
          <div style={s.hint}>
            <b>Customer&apos;s view</b> is the designer&apos;s own camera — the cake as she actually sees it.
            The <b>silhouette lens</b> removes perspective splay; use it to judge the CURVE, not the height.
          </div>
        </div>
      </div>

      {/* The capture stage — REALLY RENDERED off-screen (a display:none canvas has no WebGL frame to read
          back), framed by core's shapeView() so every tile is shot the same way and a 2- or 3-tier stack is
          FITTED, not decapitated. */}
      <div ref={shotRef} style={s.shot} aria-hidden="true">
        <CakePreview design={design} autoRotate={false} {...shapeView(design)} />
      </div>
    </div>
  );
}

// `base` = core's default for this control. Shown as a MULTIPLE, the comparison an operator can act on
// ("a tenth bigger than the default cake"), where a raw world unit is not.
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
  shot:    { position: 'absolute', left: -9999, top: 0, width: 320, height: 320, pointerEvents: 'none' },
  page:    { maxWidth: 1760, margin: '0 auto', padding: '24px 20px 64px', fontFamily: "'Quicksand', sans-serif" },
  h1:      { fontSize: 22, fontWeight: 800, color: '#2C4433', margin: '0 0 6px' },
  sub:     { fontSize: 13, color: '#5C7565', lineHeight: 1.6, margin: '0 0 16px', maxWidth: 900 },
  grid:    { display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' },
  listCol: { flex: '0 0 220px', minWidth: 200, display: 'flex', flexDirection: 'column' },
  col:     { flex: '0 0 360px', minWidth: 320, display: 'flex', flexDirection: 'column' },
  stage:   { flex: '1 1 560px', minWidth: 480, position: 'sticky', top: 16, display: 'flex', flexDirection: 'column' },
  list:    { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: '72vh', overflowY: 'auto' },
  listItem:{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderRadius: 9, border: '1.5px solid transparent', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 700, color: '#2C4433', textAlign: 'left', width: '100%' },
  listItemSel:{ border: '1.5px solid #C5D4C8', background: '#F1F6F2' },
  thumb:   { borderRadius: 7, objectFit: 'contain', background: '#F7FAF8', flexShrink: 0 },
  thumbPh: { width: 34, height: 34, borderRadius: 7, background: '#EEF2ED', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: '#9AB0A0', flexShrink: 0 },
  unsaved: { fontWeight: 400, color: '#B08900', fontSize: 11 },
  reserved:{ fontWeight: 400, color: '#9a8a63', fontSize: 11 },
  label:   { fontSize: 12, fontWeight: 700, color: '#2C4433', margin: '12px 0 4px' },
  mini:    { fontSize: 11, fontWeight: 700, color: '#6B8C74', margin: '6px 0 3px' },
  hint:    { fontSize: 11, color: '#9a8a63', marginTop: 8, lineHeight: 1.5 },
  input:   { width: '100%', boxSizing: 'border-box', padding: '9px 11px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontSize: 14, fontFamily: 'inherit', fontWeight: 700, color: '#2C4433', background: '#fff' },
  inputDisabled: { background: '#F3F5F2', color: '#8a9a8e' },
  select:  { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontSize: 13, fontFamily: 'inherit', background: '#fff' },
  cardHead:{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  tier:    { marginTop: 10, padding: '8px 10px', borderRadius: 10, border: '1.5px solid #E6D9BE', background: '#FBF7EF' },
  check:   { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12, fontWeight: 700, color: '#2C4433' },
  canvas:  { width: '100%', height: 'min(78vh, 900px)', minHeight: 520, borderRadius: 12, border: '1.5px solid #C5D4C8', background: '#F7FAF8', overflow: 'hidden' },
  btn:     { marginTop: 12, padding: '11px 16px', borderRadius: 10, border: 'none', background: '#3D5A44', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', width: '100%' },
  btnSm:   { padding: '7px 12px', borderRadius: 8, border: '1.5px solid #C5D4C8', background: '#fff', color: '#2C4433', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnSmOn: { border: '1.5px solid #3D5A44', background: '#EEF5F0', color: '#3D5A44' },
  linkBtn: { border: 'none', background: 'none', color: '#c0392b', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', padding: 0 },
  msg:     { marginTop: 12, fontSize: 13, fontWeight: 700 },
};
