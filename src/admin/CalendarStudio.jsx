import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchElementTypes, uploadThumbnail, createGlobalElement } from '../lib/api.js';
// The renderer lives in spattoo-core and is IMPORTED, never copied — the same rule the Text Topper
// Studio states: this preview and the cake must draw from one function or they will drift. When the
// designer and the X-Ray print sheet are wired, they call these too.
import {
  CALENDAR_DEFAULTS, composeCalendar, resolveDate, daysInMonth, CALENDAR_MONTH_NAMES,
  calendarSheet,
} from '@spattoo/designer';

// ── Calendar Studio ────────────────────────────────────────────────────────────────────────────
// Authors a calendar whose DATE is the customer's. Sandeep's two references: a piped freehand month
// with "15" circled in red gel, and a printed disc reading "October 2025" with a heart round the 15th.
//
//   placement_config.calendar = { layout, medium, ink, accent, paper, ringStyle, rect, … }
//   the DATE                  = an instance value, chosen in the designer, never authored here
//
// ⚠️ NO ARTWORK IS UPLOADED, and that is the point. A calendar is a RECIPE: 12 months × 31 dates ×
// 2 layouts is a per-value asset explosion, so nothing is stored but the numbers that describe it.
// `image_url` and `thumbnail_url` are both nullable (the POST guard requires only name + type), but
// a thumbnail IS baked — from a sample date — because the decorations picker reads `thumb_key ??
// thumbnail_url` with no fallback, and an element with neither shows an empty tile.
//
// ⚠️ TOP SURFACE ONLY. Sandeep: "this goes only on top zone of the cake." It lies flat on the lid
// (`top_surface: 'hug'`), unlike a plaque topper which stands — which is also what makes the round
// layout meaningful, since that one is sized to a round cake top.

const S = 1024;          // the baked asset/thumbnail frame
const PREVIEW = 460;     // what the operator looks at — same frame the Text Topper Studio uses
const CAL_ZONES = ['top_surface'];
const CAL_ACTIONS = { resize: true, duplicate: false, color: false, gradient: false, delete: true, move: true, tilt: false };

const LAYOUTS = [
  { value: 'grid',  label: 'Grid — a rectangular month, piped or printed straight onto the lid' },
  { value: 'round', label: 'Round — the same grid inside a circle outline, sized to a round cake top' },
];
const MEDIA = [
  { value: 'printed', label: 'Printed — an edible sheet laid on the cake' },
  { value: 'piped',   label: 'Piped — drawn in gel with a writing tip' },
];
const RINGS = [
  { value: 'circle', label: 'Circle round the date' },
  { value: 'heart',  label: 'Heart round the date' },
];

export default function CalendarStudio() {
  const [elementTypes, setElementTypes] = useState([]);
  const [name, setName]     = useState('');
  const [typeId, setTypeId] = useState('');
  const [cfg, setCfg]       = useState({ ...CALENDAR_DEFAULTS });
  const [busy, setBusy]     = useState(null);
  const [msg, setMsg]       = useState(null);
  /* The last colour the operator picked, kept while the background is switched OFF. Without it,
     `paper: null` loses the choice and re-ticking silently falls back to the default — so the swatch
     would be showing a colour that is not the one that comes back. */
  const [lastPaper, setLastPaper] = useState(CALENDAR_DEFAULTS.paper);

  /* The SAMPLE date drives the preview and the baked thumbnail only. It is never saved: the real
     date is the customer's, chosen in the designer and stored on the instance. Defaulted to today
     so a freshly opened studio draws a real month rather than an empty frame. */
  const now = useMemo(() => new Date(), []);
  const [sample, setSample] = useState(() => ({
    year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(),
  }));

  const canvasRef = useRef(null);

  useEffect(() => { fetchElementTypes().then(setElementTypes).catch(() => setElementTypes([])); }, []);

  const date = useMemo(() => resolveDate(sample, now), [sample, now]);

  // Draw straight into the on-screen canvas at PREVIEW. Normalized geometry means this is the same
  // picture the 1024 bake produces, just cheaper — no compose-then-downscale.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, PREVIEW, PREVIEW);
    // A 'grid' calendar draws no background of its own (it sits on buttercream), so the preview
    // paints a cake-ish field behind it — otherwise the operator judges dark ink on white paper and
    // gets the contrast wrong for the surface it will actually be piped onto.
    // Simulate the cake's own surface behind anything that does NOT carry its own paper — otherwise
    // the operator judges contrast against white and gets it wrong for buttercream. Keyed on `paper`
    // rather than on the layout, now that a grid can have a background too.
    if (!cfg.paper) {
      ctx.fillStyle = '#F3EDE4';
      ctx.fillRect(0, 0, PREVIEW, PREVIEW);
    }
    composeCalendarInto(ctx, PREVIEW, date, cfg);
  }, [date, cfg]);

  function set(k, v) { setCfg(p => ({ ...p, [k]: v })); }

  async function handleSave() {
    if (!name.trim()) return setMsg({ ok: false, text: 'Name is required.' });
    if (!typeId)      return setMsg({ ok: false, text: 'Pick an element type.' });

    setBusy('Saving…');
    setMsg(null);
    try {
      /* The thumbnail is the calendar at a SAMPLE date — the same trick the Text Topper Studio uses
         (it bakes its tile from the slots' defaults) so the picker shows a real calendar rather than
         an empty grid. Nothing else is uploaded: there is no master artwork to store. */
      const thumbCanvas = composeCalendar(S, date, cfg);
      const thumbBlob = await new Promise(res => thumbCanvas.toBlob(res, 'image/png'));
      const thumbKey = await uploadThumbnail('elements/thumbnails', thumbBlob);

      await createGlobalElement({
        name: name.trim(),
        description: null,
        element_type_id: typeId,
        parent_id: null,
        // No master artwork — the calendar IS the recipe below. Nullable in the schema, and the
        // POST guard requires only name + element_type_id.
        image_url: null,
        thumbnail_url: thumbKey,
        file_size: null,
        allowed_zones: CAL_ZONES,
        placement_config: {
          // Lies flat on the lid; a calendar is not a plaque that stands.
          top_surface: 'hug',
          r: 1,
          /* ⚠️ FIT TO THE CAKE, NOT TO A NUMBER — placement.js surfaceFit. Without this the calendar
           * seeds at STICKER_SIZE (0.28 world units) and renders as a postage stamp in the middle of
           * the lid; measured on a real render before it was added. `calendarSheet` derives the extent
           * from what the renderer actually paints (the disc's inset, or the paper, or the grid rect),
           * so the studio cannot come to disagree with the cake about how big a calendar is. An
           * invented 0.92 hung the printed sheet off the edge. */
          sheet: calendarSheet(cfg),
          calendar: {
            layout: cfg.layout,
            medium: cfg.medium,
            ink: cfg.ink,
            accent: cfg.accent,
            paper: cfg.paper,
            ringStyle: cfg.ringStyle,
            showDayHeader: cfg.showDayHeader,
            showMonthName: cfg.showMonthName,
            rect: cfg.rect,
            fontScale: cfg.fontScale,
          },
        },
        allowed_actions: CAL_ACTIONS,
        default_color: null,
        sort_order: 0,
      });

      setMsg({ ok: true, text: 'Calendar saved. The customer picks the date on the cake; this recipe decides how it is drawn.' });
      setName('');
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Save failed.' });
    } finally {
      setBusy(null);
    }
  }

  const maxDay = daysInMonth(date.year, date.month);

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Calendar Studio</h1>
      <p style={s.sub}>
        Author a calendar whose <b>date is the customer's</b>. The month grid is generated, so a date is
        never an asset — twelve months and thirty-one days cost nothing. Goes on the cake top only.
      </p>

      <div style={s.specBox}>
        <div style={s.specTitle}>How it works</div>
        <ul style={s.specList}>
          <li><b>No artwork.</b> Nothing is uploaded — this saves a <i>recipe</i> (<code>placement_config.calendar</code>), and the drawing is generated from it.</li>
          <li><b>The date is not authored here.</b> The sample below only drives this preview and the picker thumbnail. The customer chooses the real date in the designer.</li>
          <li><b>Grid vs Round.</b> Round is the same month grid inside a circle outline, sized to a round cake top — not the dates arranged in a ring.</li>
          <li><b>Medium is stated, never guessed.</b> A piped calendar and a printed one are made completely differently, and X-Ray must not have to infer which.</li>
        </ul>
      </div>

      <div style={s.grid}>
        <div style={s.col}>
          <label style={s.label}>Name</label>
          <input style={s.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Month calendar — round" />

          <label style={s.label}>Element type</label>
          <select style={s.select} value={typeId} onChange={e => setTypeId(e.target.value)}>
            <option value="">Select type…</option>
            {elementTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>

          <label style={s.label}>Layout</label>
          <select style={s.select} value={cfg.layout} onChange={e => set('layout', e.target.value)}>
            {LAYOUTS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>

          <label style={s.label}>How it is made</label>
          <select style={s.select} value={cfg.medium} onChange={e => set('medium', e.target.value)}>
            {MEDIA.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>

          <label style={s.label}>Ring round the chosen date</label>
          <select style={s.select} value={cfg.ringStyle} onChange={e => set('ringStyle', e.target.value)}>
            {RINGS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>

          <div style={s.row}>
            <div style={{ flex: 1 }}>
              <div style={s.mini}>Numbers</div>
              <input type="color" style={s.colour} value={cfg.ink} onChange={e => set('ink', e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={s.mini}>Month name + ring</div>
              <input type="color" style={s.colour} value={cfg.accent} onChange={e => set('accent', e.target.value)} />
            </div>
            {/* Offered on BOTH layouts now. It was round-only, on the assumption that a grid is always
                piped onto the lid — which Sandeep's own printed-disc reference disproves. `null` is
                how a calendar says it has no field at all, which is what a piped one wants. */}
            <div style={{ flex: 1 }}>
              <div style={s.mini}>Background</div>
              <input type="color" style={{ ...s.colour, ...(cfg.paper ? null : s.colourOff) }}
                     value={cfg.paper || lastPaper}
                     onChange={e => { setLastPaper(e.target.value); set('paper', e.target.value); }} />
            </div>
          </div>

          <div style={s.row}>
            <label style={{ ...s.mini, display: 'flex', alignItems: 'center', gap: 6, marginTop: 12 }}>
              <input type="checkbox" checked={cfg.showMonthName} onChange={e => set('showMonthName', e.target.checked)} />
              Month name
            </label>
            <label style={{ ...s.mini, display: 'flex', alignItems: 'center', gap: 6, marginTop: 12 }}>
              <input type="checkbox" checked={cfg.showDayHeader} onChange={e => set('showDayHeader', e.target.checked)} />
              S M T W T F S header
            </label>
            {/* Off = drawn straight onto the cake, no paper. A piped calendar wants this; a printed
                sheet does not. Deliberately NOT derived from the medium — see calendarArt.js. */}
            <label style={{ ...s.mini, display: 'flex', alignItems: 'center', gap: 6, marginTop: 12 }}>
              <input type="checkbox" checked={!!cfg.paper}
                     onChange={e => set('paper', e.target.checked ? lastPaper : null)} />
              Background
            </label>
          </div>

          <div style={s.sampleBox}>
            <div style={s.specTitle}>Sample date — preview + thumbnail only</div>
            <div style={s.row}>
              <select style={s.select} value={sample.month} onChange={e => setSample(p => ({ ...p, month: Number(e.target.value) }))}>
                {CALENDAR_MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
              <select style={s.select} value={Math.min(sample.day, maxDay)} onChange={e => setSample(p => ({ ...p, day: Number(e.target.value) }))}>
                {Array.from({ length: maxDay }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              <input style={s.input} type="number" value={sample.year}
                     onChange={e => setSample(p => ({ ...p, year: Number(e.target.value) || p.year }))} />
            </div>
          </div>

          <button style={{ ...s.btn, ...(busy ? s.btnOff : null) }} onClick={handleSave} disabled={!!busy}>
            {busy || 'Save calendar'}
          </button>
          {msg && <div style={{ ...s.msg, color: msg.ok ? '#2E7D32' : '#c0392b' }}>{msg.text}</div>}
        </div>

        <div style={s.col}>
          <div style={s.mini}>Preview — {CALENDAR_MONTH_NAMES[date.month - 1]} {date.year}, {date.day} ringed</div>
          <canvas ref={canvasRef} width={PREVIEW} height={PREVIEW} style={s.canvas} />
          <div style={s.note}>
            {cfg.paper
              ? 'The background is part of the artwork — a printed sheet. The preview shows it exactly as it will be drawn.'
              : 'No background: this is drawn straight onto the cake, so the cream field behind it here is the lid, not part of the artwork.'}
          </div>
        </div>
      </div>
    </div>
  );
}

/* composeCalendar makes its own canvas; for the live preview we want to draw INTO the one already on
   screen (and, for 'grid', on top of the cream field painted behind it). Drawing the composed canvas
   is one blit and keeps a single code path — the alternative is exporting drawCalendar separately
   and letting this file re-implement the background rule. */
function composeCalendarInto(ctx, size, date, cfg) {
  ctx.drawImage(composeCalendar(size, date, cfg), 0, 0);
}

const s = {
  page:    { maxWidth: 1080, margin: '0 auto', padding: '24px 20px 64px', fontFamily: "'Quicksand', sans-serif" },
  h1:      { fontSize: 22, fontWeight: 800, color: '#2C4433', margin: '0 0 6px' },
  sub:     { fontSize: 13, color: '#5C7565', lineHeight: 1.6, margin: '0 0 16px' },
  specBox: { marginBottom: 22, padding: '12px 16px', borderRadius: 10, background: '#FBF7EF', border: '1px solid #E6D9BE' },
  specTitle: { fontSize: 11, fontWeight: 800, color: '#7A5E1F', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 },
  specList: { margin: 0, paddingLeft: 18, fontSize: 12, color: '#5b5340', lineHeight: 1.7 },
  grid:    { display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-start' },
  col:     { flex: '1 1 380px', minWidth: 340, display: 'flex', flexDirection: 'column' },
  label:   { fontSize: 12, fontWeight: 700, color: '#2C4433', margin: '12px 0 4px' },
  mini:    { fontSize: 11, fontWeight: 700, color: '#6B8C74', margin: '6px 0 3px' },
  input:   { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontSize: 13, fontFamily: 'inherit' },
  select:  { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontSize: 13, fontFamily: 'inherit' },
  colour:  { width: '100%', height: 34, padding: 2, borderRadius: 8, border: '1.5px solid #C5D4C8', background: '#fff', cursor: 'pointer' },
  // The swatch still shows its colour when the background is off, so turning it back on is not a
  // guess — it is dimmed rather than hidden, which is the rule a disabled control should follow.
  colourOff: { opacity: 0.35 },
  row:     { display: 'flex', gap: 8, alignItems: 'flex-end' },
  sampleBox: { marginTop: 18, paddingTop: 12, borderTop: '1px solid #E6D9BE' },
  btn:     { marginTop: 18, padding: '11px 16px', borderRadius: 10, border: 'none', background: '#3D5A44', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnOff:  { background: '#9AB3A1', cursor: 'default' },
  msg:     { marginTop: 10, fontSize: 13, fontWeight: 700 },
  note:    { marginTop: 8, fontSize: 11, color: '#6B8C74', lineHeight: 1.6, maxWidth: 460 },
  canvas:  { width: PREVIEW, height: PREVIEW, maxWidth: '100%', borderRadius: 12, border: '1.5px solid #C5D4C8', background: '#fff' },
};
