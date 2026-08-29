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
 *
 * ONE RULE, not three: Import is live only while a fresh, UNCONSUMED plan for the file now loaded
 * exists. Everything else falls out of it — choosing a file clears the plan, so does choosing a
 * different one, and a successful import consumes it. The last of those is what stops a second press
 * re-running a plan that has already happened, where every "4 new" has quietly become an update and
 * the screen is still describing the first run.
 */
export default function ImportElements() {
  const [bundle, setBundle] = useState(null);
  const [fileName, setFileName] = useState('');
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  // WHICH of the two is running. It used to be inferred from `plan` — "busy and no plan" meant the
  // dry run — and that was wrong the second time you pressed Dry run: a plan already existed, so the
  // label stayed "Dry run" and the screen gave no sign anything was happening.
  const [mode, setMode] = useState(null);   // 'dry' | 'import' | null
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
      // One format covers both kinds of export, so the message must not say "element" — it would
      // read as "wrong screen" to somebody holding a template bundle, which is the right screen.
      if (parsed?.format !== 'spattoo-element-bundle') throw new Error('Not a Spattoo bundle');
      setBundle(parsed);
    } catch (e2) {
      setErr(e2.message || 'Could not read that file');
    }
  }

  async function run(dryRun) {
    if (!bundle) return;
    setBusy(true); setMode(dryRun ? 'dry' : 'import'); setErr(null);
    try {
      const res = await importElements(bundle, { dryRun });
      if (dryRun) { setPlan(res.plan); setResult(null); }
      // A successful import CONSUMES the plan. Leaving it set left the button live over a plan that
      // had already happened — press it again and every "4 new" is now an update, so the second run
      // did something the screen was still describing as the first. Clearing it puts the button back
      // behind a dry run, which is the same rule as before the first press rather than a new one.
      //
      // A FAILED import deliberately keeps the plan, so a retry after a network blip is one click and
      // not a re-check of a bundle nothing was written from.
      else { setResult(res); setPlan(null); }
    } catch (e) {
      // A 409 is the vocabulary collision — same slug, different id. It is the one failure a human
      // has to resolve, so it is shown as-is rather than flattened into "import failed".
      setErr(e?.message ?? 'Import failed');
    } finally {
      setBusy(false); setMode(null);
    }
  }

  const counts = bundle && {
    templates: bundle.cake_templates?.length ?? 0,
    elements: bundle.elements?.length ?? 0,
    element_types: bundle.element_types?.length ?? 0,
    tags: bundle.tags?.length ?? 0,
    element_tags: bundle.element_tags?.length ?? 0,
    element_craft_guide: bundle.element_craft_guide?.length ?? 0,
    element_categories: bundle.element_categories?.length ?? 0,
    cake_shapes: bundle.cake_shapes?.length ?? 0,
    assets: bundle.assets?.length ?? 0,
  };

  return (
    <div style={s.page}>
      <h2 style={s.h2}>Import bundle</h2>
      <p style={s.blurb}>
        A bundle exported from another environment — elements, or templates, which arrive with the
        elements their designs reference. Rows keep their ids, and every asset it names is
        re-uploaded here under the same key.
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
          {/* Categories were missing from both panels while the backend was planning them all along.
              A category is the difference between an element a customer can browse to and one only
              findable by typing its name — so it is exactly the line you want to read before
              importing, not the one to leave out. */}
          <Row k="Categories" v={counts.element_categories} />
          {/* ⚠️ SAME OMISSION AS CATEGORIES, and a quieter failure. A template names its shape by
              KEY, and `cakeShapeDef` deliberately falls back to ROUND for a key it does not know
              ("a design whose shape row was deactivated must still show a cake") — so a template
              promoted WITHOUT its shape renders as a plain round cake. Nothing thrown, nothing
              logged, and it looks like a cake. The backend has carried and planned these all
              along; only the two panels were silent, which made the dry run unable to answer the
              one question worth asking before promoting a new shape. */}
          {counts.cake_shapes > 0 && <Row k="Cake shapes" v={counts.cake_shapes} />}
          <Row k="Tags" v={counts.tags} />
          <Row k="Tag links" v={counts.element_tags} />
          <Row k="Craft guides" v={counts.element_craft_guide} />
          <Row k="Assets" v={counts.assets} />
          <Row k="Exported" v={(bundle.exported_at || '').slice(0, 19).replace('T', ' ')} />
          <Row k="From" v={bundle.source?.r2_public_url ?? '—'} />
        </div>
      )}

      {bundle && (
        <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
          <button onClick={() => run(true)} disabled={busy} style={dim(s.secondary, busy)}>
            {busy && mode === 'dry' ? 'Checking…' : (plan || result ? 'Dry run again' : 'Dry run')}
          </button>
          {/* Gated on a dry run having reported, and the gate has to be VISIBLE. `disabled` alone
              does nothing here: s.primary sets its own background and cursor inline, and an inline
              style wins over the browser's disabled appearance — so the button looked and felt
              exactly as clickable as a live one and simply ignored the click. A control that is off
              must look off, or the only thing it teaches is that the screen is broken. */}
          <button onClick={() => run(false)} disabled={busy || !plan} style={dim(s.primary, busy || !plan)}
                  title={plan ? 'Apply the plan shown below'
                             : result ? 'Already imported — run a dry run to import again'
                                      : 'Run a dry run first'}>
            {busy && mode === 'import' ? 'Importing…' : 'Import'}
          </button>
          <span style={s.hint}>
            {busy ? '' : plan ? 'Read the plan below, then import.'
                  : result ? 'Imported. Run a dry run again to import once more.'
                           : 'Run a dry run to see what this will do.'}
          </span>
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
          {/* `reused`, not `updated`: a category arrives WITHOUT an id and is matched by slug, so an
              existing one is joined rather than rewritten. Guarded because an older backend's plan
              has no such key. */}
          {plan.element_categories && (
            <Row k="Categories"  v={`${plan.element_categories.create} new, ${plan.element_categories.reused} reused`} />
          )}
          {/* ⚠️ THE LINE TO READ BEFORE PROMOTING A NEW SHAPE. `reused`, not `updated`: a shape is
              matched by KEY and an existing one is joined rather than rewritten, so an environment
              that already has `round` shows it as reused and only a genuinely new shape counts as
              new. Rendered whenever the plan carries the key — including at 0 new, 0 reused, which
              is itself the answer to "did my template bring its shape?" and the case a
              `> 0` guard would hide. Guarded only for an older backend whose plan has no such
              key. */}
          {plan.cake_shapes && (
            <Row k="Cake shapes" v={`${plan.cake_shapes.create} new, ${plan.cake_shapes.reused} reused`} />
          )}
          <Row k="Tags"          v={`${plan.tags.create} new, ${plan.tags.update} updated`} />
          <Row k="Elements"      v={`${plan.elements.create} new, ${plan.elements.update} updated`} />
          {plan.cake_templates && (
            <Row k="Templates"   v={`${plan.cake_templates.create} new, ${plan.cake_templates.update} updated`} />
          )}
          <Row k="Tag links"     v={plan.element_tags.rows} />
          <Row k="Craft guides"  v={plan.element_craft_guide.rows} />
          {/* `copy` is absent from a plan an older backend produced — fall back to the total
              rather than rendering "undefined to copy". */}
          <Row k="Assets to copy" v={plan.assets.copy ?? plan.assets.count} />
          {plan.assets.present > 0 && (
            <Row k="Already here" v={`${plan.assets.present} skipped`} />
          )}
        </div>
      )}

      {result && (
        <div style={s.card}>
          <div style={s.cardTitle}>{result.ok ? 'Imported' : 'Finished with problems'}</div>
          <Row k="Elements" v={`${result.plan.elements.create} new, ${result.plan.elements.update} updated`} />
          <Row k="Assets" v={`${result.plan.assets.copy ?? result.plan.assets.count} copied, ${result.plan.assets.present ?? 0} already here`} />
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

// An inline `background` and `cursor` beat the browser's own disabled rendering, so a button styled
// from this file has to say for itself that it is off. Applied to both, because "the dry run is
// still running" and "there is no plan to apply" both need to look unavailable rather than ignored.
const dim = (base, off) => (off
  ? { ...base, opacity: 0.42, cursor: 'not-allowed', filter: 'saturate(0.6)' }
  : base);

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
  // Says WHY the button is off, beside the button. A disabled control with no explanation is a
  // puzzle, and the title attribute only helps somebody who already suspected there was a rule.
  hint: { fontSize: 12, color: '#6B8C74', fontWeight: 600, lineHeight: 1.4 },
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
