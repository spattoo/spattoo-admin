// ── Re-capture GLOBAL template thumbnails against the current renderer ────────────────────────────
//
// A thumbnail is not re-rendered when it is shown. It is captured from an off-screen canvas at SAVE
// time, uploaded, and displayed afterwards as a plain <img>. So every template saved before the
// colour model landed (0.1.513) carries a frozen picture of the old, over-exposed colours while
// OPENING that same template renders the corrected ones. The design data is untouched — only the
// snapshot is stale.
//
// ⚠️ IT REUSES THE PRODUCT'S OWN CAPTURE, deliberately. `CakeThumbnailCanvas` + `captureThumbnailBlob`
// are exactly what `CakeDesigner` uses when a baker saves, so a regenerated thumbnail is identical in
// kind to a freshly-saved one. A second renderer written for the batch would be a second thing to
// keep in step, which is the failure INVARIANTS #15 exists to prevent — and this admin screen already
// has its own `canvas.toBlob()` in ManageTemplates that crops differently, which is precisely how the
// two drifted apart in the first place.
//
// ⚠️ AND `captureThumbnailBlob` REFUSES AN UNDRAWN FRAME, which is the whole safety of doing this in
// bulk. Saving only ever captures a cake already on screen; a batch renders each one COLD, so GLB
// decorations and the HDRI may not have arrived. The shared capture returns null rather than a
// plausible white rectangle, so a template that was not ready is SKIPPED instead of being quietly
// replaced by a picture of nothing.
//
// ⚠️ AN INCOMPLETE FRAME IS REFUSED THE SAME WAY. A decoration whose GLB has been deleted from
// storage is caught inside the canvas and drawn as nothing — which is right on screen, where one
// dead asset must never take the designer down with it, and wrong here, where the result would be a
// thumbnail silently missing its border written over the good one. So `clearAssetFailures()` runs
// before each design and `assetFailures()` is read after: anything caught means SKIP, and the row
// names the asset so the broken element can be fixed.
//
// ── What it does NOT do ─────────────────────────────────────────────────────────────────────────
// · Orders are left alone. An order's thumbnail is a record of what the customer agreed to; silently
//   redrawing it rewrites history. Templates are previews and should show what you would get today.
// · Bakers' own templates are left alone — GLOBAL only (`baker_id` null). Tenant data is a different
//   risk profile and was not asked for.
// · Nothing is overwritten. `uploadBlob` mints a fresh UUID key every time, so the OLD image stays in
//   storage untouched. The mapping is what makes that useful, so old → new is recorded per template
//   and downloadable as JSON: a kept file you cannot find is not kept.
import { useState, useRef, useCallback } from 'react';
import { CakeThumbnailCanvas, captureThumbnailBlob, toCanvasConfig,
         assetFailures, clearAssetFailures } from '@spattoo/designer';
import { fetchAdminTemplates, updateTemplate, uploadBlob } from '../lib/api.js';

/* How long to let a cake settle before capturing. ⚠️ Not a guess dressed as a constant: a cold render
 * has to fetch the HDRI and every GLB the design references, and `FitCakeCamera` then frames it. The
 * capture REFUSES an empty frame, so being too quick costs a skip rather than a bad thumbnail — but a
 * skip still means a template did not get done, so this is generous on purpose. */
const SETTLE_MS = 2600;

const s = {
  wrap:   { padding: 20, fontFamily: 'Quicksand, sans-serif', maxWidth: 900 },
  h1:     { fontSize: 20, margin: '0 0 4px' },
  sub:    { fontSize: 13, color: '#666', margin: '0 0 18px', lineHeight: 1.6 },
  bar:    { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' },
  btn:    { padding: '8px 16px', fontSize: 13, fontWeight: 700, borderRadius: 8, cursor: 'pointer',
            border: '1.5px solid #1a1a1a', background: '#1a1a1a', color: '#fff', fontFamily: 'inherit' },
  ghost:  { padding: '8px 16px', fontSize: 13, fontWeight: 700, borderRadius: 8, cursor: 'pointer',
            border: '1.5px solid #1a1a1a', background: '#fff', color: '#1a1a1a', fontFamily: 'inherit' },
  row:    { display: 'grid', gridTemplateColumns: '1fr 92px 92px 120px', gap: 12, alignItems: 'center',
            padding: '8px 0', borderBottom: '1px solid #eee', fontSize: 13 },
  head:   { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: 0.4 },
  thumb:  { width: 84, height: 66, objectFit: 'contain', background: '#fafafa', borderRadius: 5,
            border: '1px solid #eee' },
  note:   { fontSize: 12, color: '#666', background: '#fafafa', borderLeft: '3px solid #ddd',
            padding: '10px 12px', marginBottom: 16, lineHeight: 1.6 },
};

export default function RegenerateThumbnails() {
  const [rows, setRows] = useState([]);          // { t, before, after, status }
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState(null);    // the design currently mounted off-screen
  const [msg, setMsg] = useState(null);
  const containerRef = useRef(null);
  const renderNowRef = useRef(null);

  const load = useCallback(async () => {
    setMsg(null);
    try {
      const all = await fetchAdminTemplates();
      /* GLOBAL only — a template with a `baker_id` belongs to a tenant. */
      const globals = all.filter(t => !t.baker_id);
      setRows(globals.map(t => ({ t, before: t.thumbnail_url ?? null, after: null, status: 'pending' })));
      setMsg({ ok: true, text: `${globals.length} global template(s). ${all.length - globals.length} baker-owned skipped.` });
    } catch (e) {
      setMsg({ ok: false, text: `Could not load templates: ${e.message}` });
    }
  }, []);

  /* One template: mount it off-screen, let it settle, capture, upload, PATCH. Sequential on purpose —
   * every template renders into the SAME off-screen canvas, and running them concurrently would have
   * them overwrite each other's frame. It is also kinder to the GPU on a long run. */
  const regenerateOne = useCallback(async (idx) => {
    const row = rows[idx];
    setRows(r => r.map((x, i) => i === idx ? { ...x, status: 'rendering' } : x));
    clearAssetFailures();                        // anything recorded from here on belongs to THIS design
    setConfig(toCanvasConfig(row.t.design ?? { tiers: [] }));
    await new Promise(res => setTimeout(res, SETTLE_MS));
    renderNowRef.current?.();                    // force a frame before reading pixels back

    const canvas = containerRef.current?.querySelector('canvas');
    const blob = await captureThumbnailBlob(canvas);
    if (!blob) {
      /* The shared capture refused — nothing was drawn. Skip rather than store a white rectangle. */
      setRows(r => r.map((x, i) => i === idx ? { ...x, status: 'skipped — nothing rendered' } : x));
      return false;
    }
    const missing = assetFailures();
    if (missing.length) {
      /* Something drew, but not all of it. Same call as above: an incomplete picture must not
         replace a complete one. The message carries the failing URL straight from the loader. */
      setRows(r => r.map((x, i) => i === idx
        ? { ...x, status: `skipped — asset missing: ${missing[0].message}` } : x));
      return false;
    }
    try {
      const ext = blob.type === 'image/webp' ? 'webp' : 'png';
      const { key } = await uploadBlob('templates/thumbnails', `${crypto.randomUUID()}.${ext}`, blob);
      await updateTemplate(row.t.id, { thumbnail_url: key });
      setRows(r => r.map((x, i) => i === idx
        ? { ...x, after: URL.createObjectURL(blob), afterKey: key, status: 'done' } : x));
      return true;
    } catch (e) {
      setRows(r => r.map((x, i) => i === idx ? { ...x, status: `failed — ${e.message}` } : x));
      return false;
    }
  }, [rows]);

  const runAll = useCallback(async () => {
    setBusy(true); setMsg(null);
    let done = 0, skipped = 0;
    for (let i = 0; i < rows.length; i++) {
      const ok = await regenerateOne(i);
      ok ? done++ : skipped++;
    }
    setConfig(null);
    setBusy(false);
    setMsg({ ok: true, text: `Regenerated ${done}. ${skipped} skipped or failed — re-run to retry those.` });
  }, [rows, regenerateOne]);

  /* ⚠️ THE MAPPING IS THE POINT. The old images are never overwritten (a fresh UUID key each upload),
   * but an old file nobody can locate is not a kept file — this is what makes a revert possible. */
  const downloadMapping = () => {
    const done = rows.filter(r => r.afterKey);
    const blob = new Blob([JSON.stringify(done.map(r => ({
      id: r.t.id, name: r.t.name, old_thumbnail_url: r.before, new_thumbnail_url: r.afterKey,
    })), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `template-thumbnails-${done.length}.json`;
    a.click();
  };

  return (
    <div style={s.wrap}>
      <h1 style={s.h1}>Regenerate template thumbnails</h1>
      <p style={s.sub}>
        A thumbnail is captured when a template is saved, not when it is shown — so templates saved
        before the colour model landed still picture the old, washed-out colours while opening them
        renders the corrected ones. This re-captures them through the same canvas the designer uses.
      </p>
      <div style={s.note}>
        <b>Global templates only.</b> Baker-owned templates and all order thumbnails are left alone —
        an order&rsquo;s thumbnail is a record of what the customer agreed to.<br />
        <b>Old images are kept.</b> Each upload gets a new key, so nothing is overwritten. Download the
        mapping to keep old&nbsp;→&nbsp;new, which is what makes a revert possible.
      </div>

      <div style={s.bar}>
        <button style={s.ghost} onClick={load} disabled={busy}>Load global templates</button>
        <button style={s.btn} onClick={runAll} disabled={busy || !rows.length}>
          {busy ? 'Regenerating…' : `Regenerate ${rows.length || ''}`}
        </button>
        <button style={s.ghost} onClick={downloadMapping} disabled={!rows.some(r => r.afterKey)}>
          Download mapping
        </button>
        {msg && <span style={{ fontSize: 12, color: msg.ok ? '#2e7d32' : '#c62828' }}>{msg.text}</span>}
      </div>

      {rows.length > 0 && (
        <>
          <div style={{ ...s.row, ...s.head, borderBottom: '2px solid #ddd' }}>
            <div>Template</div><div>Before</div><div>After</div><div>Status</div>
          </div>
          {rows.map((r, i) => (
            <div key={r.t.id} style={s.row}>
              <div>{r.t.name}</div>
              <div>{r.before && <img src={r.before} alt="" style={s.thumb} />}</div>
              <div>{r.after && <img src={r.after} alt="" style={s.thumb} />}</div>
              <div style={{ fontSize: 11.5, color: r.status === 'done' ? '#2e7d32'
                : r.status.startsWith('pending') ? '#999' : '#c62828' }}>{r.status}</div>
            </div>
          ))}
        </>
      )}

      {/* The off-screen canvas the capture reads. Same component the designer mounts. */}
      {config && <CakeThumbnailCanvas config={config} containerRef={containerRef} renderNowRef={renderNowRef} />}
    </div>
  );
}
