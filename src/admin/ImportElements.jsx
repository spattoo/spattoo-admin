import { useState } from 'react';
import { importElements } from '../lib/api.js';

/* ── Import an element bundle ────────────────────────────────────────────────────────────────────
 *
 * The receiving half of dev → prod promotion (spattoo-docs/plans/element-preview-and-publish.md).
 * Open the bundle exported from the other environment, look at what it is about to do, then apply.
 *
 * ── DRY RUN IS NOT OPTIONAL HERE ────────────────────────────────────────────────────────────────
 * The button that writes is only enabled once a dry run has reported. An import upserts on the
 * primary key, so it is safe in the sense that it cannot duplicate anything — but "safe" and
 * "expected" are different, and "this will overwrite 12 rows you already have" is worth reading
 * before it happens rather than after.
 */
export default function ImportElements() {
  const [bundle, setBundle] = useState(null);
  const [fileName, setFileName] = useState('');
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  function reset() {
    setPlan(null); setResult(null); setErr(null);
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    reset(); setBundle(null); setFileName(file.name);
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed?.format !== 'spattoo-element-bundle') throw new Error('Not an element bundle');
      setBundle(parsed);
    } catch (e2) {
      setErr(e2.message || 'Could not read that file');
    }
  }

  async function run(dryRun) {
    if (!bundle) return;
    setBusy(true); setErr(null);
    try {
      const res = await importElements(bundle, { dryRun });
      if (dryRun) { setPlan(res.plan); setResult(null); }
      else { setResult(res); }
    } catch (e) {
      // A 409 is the vocabulary collision — same slug, different id. It is the one failure a human
      // has to resolve, so it is shown as-is rather than flattened into "import failed".
      setErr(e?.message ?? 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  const counts = bundle && {
    templates: bundle.cake_templates?.length ?? 0,
    elements: bundle.elements?.length ?? 0,
    element_types: bundle.element_types?.length ?? 0,
    tags: bundle.tags?.length ?? 0,
    element_tags: bundle.element_tags?.length ?? 0,
    element_craft_guide: bundle.element_craft_guide?.length ?? 0,
    assets: bundle.assets?.length ?? 0,
  };

  return (
    <div style={s.page}>
      <h2 style={s.h2}>Import elements</h2>
      <p style={s.blurb}>
        A bundle exported from another environment — elements, or templates with the elements their
        designs reference. Rows keep their ids, and every asset it names is re-uploaded here under
        the same key.
      </p>

      <input type="file" accept="application/json,.json" onChange={onFile} style={s.file} />
      {fileName && <div style={s.fileName}>{fileName}</div>}

      {err && <div style={s.err}>{err}</div>}

      {bundle && (
        <div style={s.card}>
          <div style={s.cardTitle}>In this bundle</div>
          {counts.templates > 0 && <Row k="Templates" v={counts.templates} />}
          <Row k="Elements" v={counts.elements} />
          <Row k="Element types" v={counts.element_types} />
          <Row k="Tags" v={counts.tags} />
          <Row k="Tag links" v={counts.element_tags} />
          <Row k="Craft guides" v={counts.element_craft_guide} />
          <Row k="Assets" v={counts.assets} />
          <Row k="Exported" v={(bundle.exported_at || '').slice(0, 19).replace('T', ' ')} />
          <Row k="From" v={bundle.source?.r2_public_url ?? '—'} />
        </div>
      )}

      {bundle && (
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button onClick={() => run(true)} disabled={busy} style={s.secondary}>
            {busy && !plan ? 'Checking…' : 'Dry run'}
          </button>
          {/* Deliberately gated on a dry run having reported. */}
          <button onClick={() => run(false)} disabled={busy || !plan} style={s.primary}
                  title={plan ? '' : 'Run a dry run first'}>
            {busy && plan ? 'Importing…' : 'Import'}
          </button>
        </div>
      )}

      {plan && !result && (
        <div style={s.card}>
          <div style={s.cardTitle}>What this will do</div>
          {plan.same_environment && (
            <div style={s.warn}>
              This bundle was exported from THIS environment — importing it will simply rewrite the
              rows with what they already contain.
            </div>
          )}
          <Row k="Element types" v={`${plan.element_types.create} new, ${plan.element_types.update} updated`} />
          <Row k="Tags"          v={`${plan.tags.create} new, ${plan.tags.update} updated`} />
          <Row k="Elements"      v={`${plan.elements.create} new, ${plan.elements.update} updated`} />
          {plan.cake_templates && (
            <Row k="Templates"   v={`${plan.cake_templates.create} new, ${plan.cake_templates.update} updated`} />
          )}
          <Row k="Tag links"     v={plan.element_tags.rows} />
          <Row k="Craft guides"  v={plan.element_craft_guide.rows} />
          <Row k="Assets to copy" v={plan.assets.count} />
        </div>
      )}

      {result && (
        <div style={s.card}>
          <div style={s.cardTitle}>{result.ok ? 'Imported' : 'Finished with problems'}</div>
          <Row k="Elements" v={`${result.plan.elements.create} new, ${result.plan.elements.update} updated`} />
          <Row k="Assets" v={result.plan.assets.count} />
          {result.assetErrors?.length > 0 && (
            <div style={s.warn}>
              {result.assetErrors.length} asset(s) failed to copy. The rows are in place but those
              objects are missing here, so anything using them renders broken:
              <ul style={{ margin: '6px 0 0 16px' }}>
                {result.assetErrors.slice(0, 8).map(a => <li key={a.key}>{a.key} — {a.error}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const Row = ({ k, v }) => (
  <div style={s.row}><span>{k}</span><b>{String(v)}</b></div>
);

const s = {
  page: { padding: 24, maxWidth: 620, fontFamily: "'Quicksand',sans-serif", color: '#2C4433' },
  h2: { fontSize: 20, fontWeight: 800, marginBottom: 6 },
  blurb: { fontSize: 13, color: '#6B8C74', lineHeight: 1.6, marginBottom: 16 },
  file: { fontSize: 13, fontFamily: "'Quicksand',sans-serif" },
  fileName: { marginTop: 8, fontSize: 12, color: '#6B8C74', fontWeight: 700 },
  err: {
    marginTop: 14, padding: '10px 12px', borderRadius: 10, fontSize: 12.5, lineHeight: 1.5,
    background: '#FDEDEC', color: '#B3261E', fontWeight: 600,
  },
  warn: {
    marginTop: 8, padding: '9px 11px', borderRadius: 9, fontSize: 12, lineHeight: 1.5,
    background: '#FFF6E5', color: '#8a6d1a', fontWeight: 600,
  },
  card: {
    marginTop: 16, padding: '12px 14px', borderRadius: 12,
    borderWidth: 1.5, borderStyle: 'solid', borderColor: '#C5D4C8', background: '#fff',
  },
  cardTitle: { fontSize: 12, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: '#6B8C74', marginBottom: 8 },
  row: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5, padding: '3px 0', color: '#4a6b55' },
  primary: {
    padding: '9px 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
    background: '#2C4433', color: '#fff', fontSize: 13, fontWeight: 700, fontFamily: "'Quicksand',sans-serif",
  },
  secondary: {
    padding: '9px 18px', borderRadius: 10, cursor: 'pointer',
    borderWidth: 1.5, borderStyle: 'solid', borderColor: '#C5D4C8',
    background: '#fff', color: '#2C4433', fontSize: 13, fontWeight: 700, fontFamily: "'Quicksand',sans-serif",
  },
};
