import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchAdminCakeShapes, createCakeShape, updateCakeShape, uploadAsset,
} from '../lib/api.js';
// The catalog + the REAL cake renderer, both imported from core — never re-implemented here. The
// preview below is the same component the customer's designer draws with (CakePreview → toCanvasConfig
// → CakeTier), so a shape that looks right in this studio looks right on a real cake, by construction.
import {
  CakePreview, applyCakeShapeConfig, cakeShapeDef, cakeShapeList,
  TIER_RADII, BOTTOM_H, TIER_HEIGHT_STEP, SHEET_SIZES, SHEET_DEFAULT_KEY,
  shapeView, captureThumbnailBlob, CAMERA_FOV, CAMERA_POSITION,
} from '@spattoo/designer';

// ── Cake Shape Studio ──────────────────────────────────────────────────────────
// Authors the CATALOG of cake footprints — `cake_shapes` master data. A shape is a FAMILY (an outline
// generator in core: circle | rounded_rect | heart | butterfly | polygon | oval) plus a `config` of
// proportions. That split is the whole design: a curve has to be drawn by code, but its proportions are
// data, so a new shape is very often just new config against an existing family (an octagon IS a
// polygon with sides=8) and needs no deploy.
//
// The tier sliders ARE saved with the shape. They did not used to be, and that was a hole you could see
// from the customer's side: "Cylinder" and "2T Cylinder" were both family=circle with an empty config, so
// they were the SAME ROW in every respect the catalog could express, and the picker drew the same cake
// twice. A shape is the cake you start with — its outline AND its stack — so the tiers persist. A shape
// saved with no stack still means "one tier at the designer's default", which is what every older row
// meant and still means.
//
// Save also captures a FRONT VIEW of the cake through the real renderer and stores it in R2. That picture
// is what the customer's New-cake grid shows, so the tile is a photograph of the cake she will get, not a
// drawing of its footprint (the first version drew top-down outlines, and every circle-family shape came
// out as the same pink disc — useless on sight).

// The CURVES the code ships, and the knobs each exposes. Data, so a new curve in core adds a row here —
// not a branch in the JSX. `authorable` = you can build new shapes from it; `circle` is not, because
// Round already IS the circle and a second one would just be Round twice in the customer's picker.
const FAMILIES = {
  circle:       { short: 'round',     label: 'Circle (round cake)', authorable: false, params: [],
                  note: 'The analytic round tier — the cylinder path, with its cream wall styles and finishes.' },
  rounded_rect: { short: 'sheet',     label: 'Rounded rectangle (sheet cake)', authorable: true, params: [],
                  note: 'The analytic sheet prism. Width and depth come from the tier; "square" locks them equal.' },
  heart:        { short: 'heart',     label: 'Heart',     authorable: true,
                  params: [['Plumpness', 'plump', 0.4, 2, 0.05], ['Cleft depth', 'cleft', 0.2, 2.5, 0.05],
                           ['Tip roundness', 'tip', 0, 0.35, 0.01]] },
  butterfly:    { short: 'butterfly', label: 'Butterfly', authorable: true,
                  params: [['Wing spread', 'wing', 0.4, 2, 0.05]] },
  polygon:      { short: 'polygon',   label: 'Polygon',   authorable: true,
                  params: [['Sides', 'sides', 3, 16, 1], ['Rotation', 'rotation', -180, 180, 1]] },
  oval:         { short: 'oval',      label: 'Oval',      authorable: true, params: [],
                  note: 'A circle the tier\'s width and depth stretch.' },
};

// Where a new shape STARTS. Not an opinion about what the shape should be — just a legible starting
// point to drag away from; the whole job of this studio is that you decide the numbers.
const NEW_CONFIG = {
  heart:        { plump: 1, cleft: 1, tip: 0.12 },
  butterfly:    { wing: 1 },
  polygon:      { sides: 6, rotation: 0 },
  oval:         {},
  rounded_rect: { square: true },
};

const RESERVED = ['round', 'rect'];               // what existing designs already store — never re-key
const DRAFT_KEY = '__draft';                      // a shape being authored; local only, never a row
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
  // Which lens the big preview looks through. Defaults to the CUSTOMER's — see the preview comment below.
  const [lens, setLens]       = useState('customer');           // 'customer' | 'silhouette'
  const [adding, setAdding]   = useState(false);               // the "which curve?" step
  const [busy, setBusy]       = useState(null);
  const [msg, setMsg]         = useState(null);
  const shotRef = useRef(null);        // the off-screen capture stage (see the bottom of the render)

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

  // Selecting a shape loads the CAKE IT WAS SAVED AS — its own stack, at its own sizes. A row with no
  // stack (every row authored before shapes could be multi-tier) falls back to the family default, which
  // is precisely what it has always rendered as, so nothing that exists changes.
  //
  // Reset re-seats the cake on the DEFAULT size for the family — a heart lands on the round cake's
  // footprint, a sheet on its sheet size — so a like-for-like comparison is always one click away.
  const reset = (count = tiers.length, key = sizeKey) => editTiers(defaultTiers(sel?.family, count, key));
  useEffect(() => {
    if (!sel) return;
    setTiers(prev => (sel.tiers?.length
      ? sel.tiers.map(t => ({ ...t }))
      : defaultTiers(sel.family, prev.length, sizeKey)));
  }, [selKey, sel?.family, sizeKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  // The stack is part of the shape now, so moving a tier slider makes the shape DIRTY — the same as
  // dragging a proportion knob. Before, the sliders were a scratch pad and Save ignored them.
  function editTiers(next) {
    setTiers(next);
    if (sel) setDirty(d => (d.includes(sel.key) ? d : [...d, sel.key]));
  }
  const isDraft = !!sel && dirty.includes(sel.key);
  const isReserved = RESERVED.includes(sel?.key);
  const isNew = !!sel && !sel.id;                 // a draft: authored here, not yet in the catalog

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

  // A new shape starts as a DRAFT — local only. Nothing is written to the catalog until you decide the
  // proportions are right and press Save. Creating the row up front would put a shape nobody has looked
  // at into the database, which is the whole thing this studio exists to prevent.
  //
  // The CURVE is chosen here because it is the one thing that cannot change afterwards: a different
  // curve is a different cake, not a tweak. Everything after this is proportions.
  function startDraft(family) {
    setAdding(false);
    const draft = {
      key: DRAFT_KEY, id: null, family,
      label: '', config: { ...(NEW_CONFIG[family] ?? {}) },
    };
    applyCakeShapeConfig([draft]);            // so the preview renders it immediately
    setShapes(list => [...list.filter(s => s.key !== DRAFT_KEY), draft]);
    setSelKey(DRAFT_KEY);
    setMsg(null);
  }

  function discardDraft() {
    setShapes(list => list.filter(s => s.key !== DRAFT_KEY));
    setSelKey('round');
  }

  // Soft-delete: the row stays, it just stops being offered. A hard delete would strand any design that
  // already stores the key (the designer degrades an unknown shape to round — a cake silently changing
  // shape is the worst possible outcome).
  async function retire() {
    if (!sel?.id || isReserved) return;
    if (!window.confirm(`Retire "${sel.label}"? It stops being offered; cakes already using it keep it.`)) return;
    setBusy('Retiring…');
    try {
      const saved = await updateCakeShape(sel.id, { is_active: false });
      setShapes(list => list.filter(s => s.key !== saved.key));
      setSelKey('round');
      setMsg({ ok: true, text: `"${saved.label}" retired.` });
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Could not retire the shape.' });
    } finally { setBusy(null); }
  }

  // The picture the customer's New-cake grid shows. Captured off the HIDDEN preview below, not the big
  // one you have been orbiting: a thumbnail has to be the same view for every shape or the grid becomes a
  // row of cakes photographed from wherever each author happened to leave the camera. So it renders the
  // same cake through shapeView() — core's one shape camera, which fits the cake and which the picker's live tile also uses.
  //
  // A failed capture is NON-FATAL: the shape saves without a picture and the picker renders it live
  // instead. Losing the photograph must never cost you the shape you just authored.
  async function captureThumb() {
    try {
      const canvas = shotRef.current?.querySelector('canvas');
      if (!canvas) return null;
      const blob = await captureThumbnailBlob(canvas);
      if (!blob) return null;
      return await uploadAsset('shapes/thumbnails', blob);
    } catch {
      return null;
    }
  }

  // The ONE save. A draft becomes a row here (POST); an existing shape is updated (PATCH). Either way,
  // this is the only moment anything reaches the database — which is what makes the numbers above YOURS.
  async function save() {
    if (!sel) return;
    const isNew = !sel.id;
    const label = (sel.label || '').trim();
    if (isNew && !label) return setMsg({ ok: false, text: 'Name the shape before saving it.' });

    setBusy('Saving…');
    setMsg(null);
    try {
      const thumbnail_key = await captureThumb();
      const saved = isNew
        ? await createCakeShape({
            key: slug(label), label, family: sel.family,
            config: sel.config, tiers, thumbnail_key, sort_order: shapes.length + 1,
          })
        : await updateCakeShape(sel.id, {
            label, family: sel.family, config: sel.config, tiers, thumbnail_key,
            sort_order: sel.sort_order,
          });

      applyCakeShapeConfig([saved]);
      setShapes(list => [...list.filter(s => s.key !== sel.key && s.key !== saved.key), saved]);
      setDirty(d => d.filter(k => k !== sel.key && k !== saved.key));
      setSelKey(saved.key);
      setMsg({ ok: true, text: isNew
        ? `"${saved.label}" saved to the catalog.`
        : `"${saved.label}" updated. Every cake using it follows.` });
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Save failed.' });
    } finally { setBusy(null); }
  }

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Cake Shape Studio</h1>
      <p style={s.sub}>
        The catalog of cake <b>footprints</b> — the shapes a customer can pick from. The code ships the
        <b> curves</b> (heart, butterfly, polygon, oval); <b>you author the shapes</b>: start one from a
        curve, tune its proportions against a real cake, and save it when it looks right. Only
        <b> Round</b> and <b>Rectangle</b> come ready-made, because existing designs already use them.
        The preview is the real designer renderer, so what you see here is what a customer gets.
      </p>

      <div style={s.grid}>
        <div style={s.col}>
          <label style={s.label}>Shape</label>
          <select style={s.select} value={selKey ?? ''} onChange={e => setSelKey(e.target.value)}>
            {shapes.map(sh => (
              <option key={sh.key} value={sh.key}>
                {sh.key === DRAFT_KEY ? `${sh.label || 'New shape'} (unsaved)` : sh.label}
              </option>
            ))}
          </select>
          <button style={{ ...s.btnSm, marginTop: 8 }} onClick={() => setAdding(a => !a)} disabled={!!busy}>
            + New shape
          </button>

          {adding && (
            <div style={s.card}>
              <div style={s.mini}>Build it from which curve?</div>
              <div style={s.hint}>
                The curve is code and cannot be changed afterwards — a different curve is a different
                cake. The proportions are yours to tune.
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {Object.entries(FAMILIES).filter(([, f]) => f.authorable).map(([k, f]) => (
                  <button key={k} style={s.btnSm} onClick={() => startDraft(k)}>{f.label}</button>
                ))}
              </div>
            </div>
          )}

          {sel && (
            <div style={s.card}>
              <div style={s.cardHead}>
                <b style={{ fontSize: 12, color: '#7A5E1F' }}>{sel.label || 'New shape'}</b>
                <span style={{ fontSize: 11, color: isNew || isDraft ? '#7A5E1F' : '#9a8a63', fontWeight: isNew || isDraft ? 700 : 400 }}>
                  {isNew ? 'draft — nothing saved yet'
                    : isDraft ? 'edited — not saved'
                    : 'every cake using it shares this'}
                </span>
              </div>

              {isNew && (
                <>
                  <div style={s.mini}>Name</div>
                  <input style={s.input} autoFocus value={sel.label} placeholder="e.g. Heart"
                    onChange={e => edit({ label: e.target.value })} />
                </>
              )}

              {/* The curve is fixed at creation — changing it would make this a different cake, not a
                  tuned one, and every design already storing the key would silently change shape. */}
              <div style={s.mini}>Built from the {fam.label.toLowerCase()} curve</div>
              {fam.note && <div style={s.hint}>{fam.note}</div>}
              {isReserved && (
                <div style={s.hint}>
                  “{sel.key}” is what existing designs already store, so it can&apos;t be renamed or retired.
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

              <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
                {(isNew || isDraft) ? (
                  <button style={{ ...s.btn, marginTop: 0, flex: 1 }} disabled={!!busy} onClick={save}>
                    {busy || (isNew ? 'Save to the catalog' : 'Save changes')}
                  </button>
                ) : (
                  <div style={{ flex: 1, fontSize: 12, color: '#8fae98', fontWeight: 700 }}>Up to date</div>
                )}
                {isNew && (
                  <button style={s.btnSm} disabled={!!busy} onClick={discardDraft}>Discard</button>
                )}
                {!isNew && !isReserved && (
                  <button style={{ ...s.btnSm, color: '#c0392b', borderColor: '#e8c4bd' }}
                    disabled={!!busy} onClick={retire}>Retire</button>
                )}
              </div>
              {isNew && (
                <div style={s.hint}>
                  Nothing has been written to the catalog. Tune it against the cake, name it, and save it
                  when the proportions are right.
                </div>
              )}
            </div>
          )}

          {msg && <div style={{ ...s.msg, color: msg.ok ? '#2e7d32' : '#c0392b' }}>{msg.text}</div>}

          <div style={s.card}>
            <div style={s.cardHead}>
              <b style={{ fontSize: 12, color: '#2C4433' }}>Tiers</b>
              <span style={{ fontSize: 11, color: '#6B8C74' }}>saved with the shape — this is the cake a customer starts with</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
              <button style={s.btnSm} disabled={tiers.length >= MAX_TIERS}
                onClick={() => editTiers(t => [...t, defaultTiers(sel?.family, t.length + 1, sizeKey)[t.length]])}>+ Tier</button>
              <button style={s.btnSm} disabled={tiers.length <= 1}
                onClick={() => editTiers(t => t.slice(0, -1))}>− Tier</button>
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
                    onChange={v => editTiers(l => l.map((x, j) => (j === i ? { ...x, width: v } : x)))} />
                  <Slider label="Depth"  min={0.4} max={3.6} step={0.02} value={t.depth}  base={base.depth}
                    onChange={v => editTiers(l => l.map((x, j) => (j === i ? { ...x, depth: v } : x)))} />
                  <Slider label="Height" min={0.3} max={2.2} step={0.02} value={t.height} base={base.height}
                    onChange={v => editTiers(l => l.map((x, j) => (j === i ? { ...x, height: v } : x)))} />
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
            Preview — {lens === 'customer' ? "the customer's view" : 'silhouette lens'}{' '}
            <span style={{ fontWeight: 400, color: '#8fae98' }}>· drag to orbit, scroll to zoom</span>
          </label>
          <div style={s.canvas}>
            {/* DEFAULT: the camera the CUSTOMER looks through — core's own CAMERA_FOV/CAMERA_POSITION, not
                numbers invented here. This studio exists to judge a cake's PROPORTIONS, and proportions are
                a property of the lens as much as the mesh: the old preview used a long 18° lens from a much
                lower angle, which shows the side wall and foreshortens the top, so every cake read TALLER
                here than on the cake it was authoring. Height was tuned against a picture the customer
                never sees. The geometry was always right; the camera was a second opinion.

                SILHOUETTE: the long lens, kept and made explicit. A wide lens splays the near bottom edge
                outward and a vertical wall reads as bulging at its base, which is a bad way to judge a
                CURVE. Both views are legitimate — the mistake was making the analytic one the default and
                calling it "what a customer gets". */}
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
            <b>Customer&apos;s view</b> is the designer&apos;s own camera — the cake as she will actually see
            it, which is the only honest way to judge how TALL it looks. The <b>silhouette lens</b> is a long
            lens that removes perspective splay; use it to judge the CURVE, not the height.
          </div>
        </div>
      </div>

      {/* The capture stage — what the customer's picker will show. Off-screen but REALLY RENDERED (a
          display:none canvas has no WebGL frame to read back), framed by core's shapeView() so every shape
          is photographed the same way — and so a 2- or 3-tier stack is FITTED rather than decapitated by a
          camera placed for a single tier. Kept separate from the big preview above precisely
          BECAUSE that one is orbitable: capturing whatever angle the author drifted to would give the
          customer a grid of cakes shot from a dozen different cameras. */}
      <div ref={shotRef} style={s.shot} aria-hidden="true">
        <CakePreview design={design} autoRotate={false} {...shapeView(design)} />
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
  // Off-screen, but on-screen enough to RENDER: WebGL needs a real, laid-out canvas to produce a frame we
  // can read back, so this is parked outside the viewport rather than display:none'd away.
  shot: { position: 'absolute', left: -9999, top: 0, width: 320, height: 320, pointerEvents: 'none' },
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
