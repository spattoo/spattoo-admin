import { useState } from 'react';
import { reindexHelp } from '../lib/api.js';

/* ── Rebuilding what the help assistant can answer from ──────────────────────────────────────────
 *
 * Sandeep: *"i dont prefer running such mjs manually. if would be a recurring problem everytime we
 * add questions. and we will keep adding questions. build it in admin, so we can run from there."*
 *
 * ⚠️ THE ARTICLES ARE PICKED FROM DISK, NOT FETCHED. They live in spattoo-docs — *"docs should
 * live in docs repo. not on backend"* — so the deployed API has no checkout to read. Uploading
 * them needs no new credential and matches how element bundles already reach admin.
 *
 * ⚠️ THE DIFF COMES FIRST, ALWAYS. This writes to the table the assistant answers from, and an
 * empty or half-built index is not a visible failure: every question comes back "nothing is
 * written about that yet", which reads like a gap in the articles rather than a database somebody
 * broke. So nothing happens until the plan has been read.
 */

const C = {
  ink: '#2C4433', muted: '#5C7565', faint: '#9BB5A2', line: '#C5D4C8', page: '#EDEAE2',
  addBg: '#D1FAE5', addInk: '#065F46',
  chgBg: '#FEF3C7', chgInk: '#92400E',
  delBg: '#FEE2E2', delInk: '#991B1B',
};

function Group({ title, items, bg, ink, render }) {
  if (!items?.length) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: ink, marginBottom: 6 }}>
        {title} ({items.length})
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {items.map((a, i) => (
          <span key={i} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, background: bg, color: ink }}>
            {render(a)}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function HelpIndex() {
  const [files, setFiles] = useState([]);
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(null);     // 'reading' | 'planning' | 'applying'
  const [err, setErr] = useState(null);

  /* Reading happens in the browser: the picker hands back File objects and the server only ever
     sees `{ filename, text }`. A folder pick is `webkitdirectory`, which every browser we support
     has had for years — and selecting the files by hand works identically. */
  async function onPick(e) {
    setErr(null); setPlan(null); setResult(null);
    const picked = [...(e.target.files ?? [])].filter(f => f.name.endsWith('.md'));
    if (!picked.length) { setErr('No .md files in that selection.'); setFiles([]); return; }
    setBusy('reading');
    try {
      const read = await Promise.all(picked.map(async f => ({ filename: f.name, text: await f.text() })));
      setFiles(read);
      setBusy('planning');
      const r = await reindexHelp(read, { dryRun: true });
      setPlan(r.plan);
    } catch (e2) {
      setErr(e2?.message ?? 'Could not read those files');
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    setErr(null); setBusy('applying');
    try {
      /* ⚠️ `pruneMissing` is TRUE only because the picker takes the whole folder. An article
         missing from a PARTIAL upload has not been removed, and deleting it would empty the index
         one upload at a time — which is why the server will not decide this for itself. */
      const r = await reindexHelp(files, { pruneMissing: true });
      if (!r.ok) { setErr(r.reason ?? 'The rebuild was refused'); return; }
      setResult(r);
      setPlan(null);
    } catch (e2) {
      setErr(e2?.message ?? 'The rebuild failed');
    } finally {
      setBusy(null);
    }
  }

  const nothingToDo = plan && !plan.changed.length && !plan.added.length && !plan.removed.length;

  return (
    <div style={{ padding: 24, background: C.page, minHeight: '100vh', fontFamily: "'Quicksand', sans-serif" }}>
      <h1 style={{ fontSize: 20, color: C.ink, margin: '0 0 4px' }}>Help index</h1>
      <p style={{ fontSize: 13, color: C.muted, margin: '0 0 18px', maxWidth: 700, lineHeight: 1.6 }}>
        What the assistant answers from. Pick your <strong>spattoo-docs/help</strong> folder — the
        articles are read here in the browser and only their text is sent. You will see what changed
        before anything is written, and only the articles that changed are re-embedded.
      </p>

      <label style={{ display: 'inline-block', marginBottom: 16 }}>
        <input type="file" multiple webkitdirectory="" directory="" accept=".md" onChange={onPick}
               style={{ fontSize: 13 }} />
      </label>

      {busy && (
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
          {busy === 'reading' ? 'Reading the files…'
            : busy === 'planning' ? 'Working out what changed…'
            : 'Embedding and writing — this takes a couple of seconds per changed article…'}
        </div>
      )}

      {err && <div style={{ color: C.delInk, fontSize: 13, marginBottom: 12 }}>{err}</div>}

      {plan && (
        <div style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: 10, padding: 16, maxWidth: 820 }}>
          <div style={{ fontSize: 13, color: C.ink, marginBottom: 12 }}>
            {files.length} file(s) picked · <strong>{plan.articles}</strong> indexable article(s)
            · <strong>{plan.rows}</strong> section(s)
          </div>

          {/* ⚠️ "59 new" and "59 changed" mean very different things to somebody about to press go. */}
          {/* The one-time state after 145: rows exist, hashes do not, so everything reads as
              changed. Saying "59 changed" to somebody who edited nothing is the kind of first
              impression that makes a tool look untrustworthy. */}
          {!plan.firstRun && plan.unhashed && (
            <div style={{ fontSize: 13, color: C.chgInk, background: C.chgBg, padding: '8px 12px',
                          borderRadius: 8, marginBottom: 14, lineHeight: 1.55 }}>
              This index was built before change-tracking existed, so every article reads as
              changed. One rebuild records them; after that only real edits appear here.
            </div>
          )}
          {plan.firstRun && (
            <div style={{ fontSize: 13, color: C.chgInk, background: C.chgBg, padding: '8px 12px',
                          borderRadius: 8, marginBottom: 14 }}>
              The index is empty here — this is a first run, not a diff.
            </div>
          )}

          <Group title="Changed"    items={plan.changed} bg={C.chgBg} ink={C.chgInk} render={a => a.filename} />
          <Group title="New"        items={plan.added}   bg={C.addBg} ink={C.addInk} render={a => a.filename} />
          <Group title="No longer here — will be removed" items={plan.removed} bg={C.delBg} ink={C.delInk}
                 render={a => `${a.doc_slug} (${a.sections} sections)`} />
          <Group title="Skipped — not a live baker or faq article" items={plan.skipped} bg={C.page} ink={C.muted}
                 render={a => `${a.filename}: ${a.why}`} />

          <div style={{ fontSize: 12, color: C.faint, marginBottom: 14 }}>
            {plan.unchanged.length} article(s) unchanged and will not be touched
            {' · '}{plan.embeddingsNeeded} embedding(s) needed
          </div>

          {nothingToDo ? (
            <div style={{ fontSize: 13, color: C.addInk }}>
              The index already matches these articles. Nothing to do.
            </div>
          ) : (
            <button type="button" onClick={apply} disabled={busy === 'applying'}
                    style={{ fontFamily: 'inherit', fontSize: 13, fontWeight: 700, padding: '10px 18px',
                             borderRadius: 8, border: 'none', cursor: 'pointer',
                             background: C.ink, color: '#fff', opacity: busy ? 0.6 : 1 }}>
              Rebuild {plan.changed.length + plan.added.length} article(s)
              {plan.removed.length ? `, remove ${plan.removed.length}` : ''}
            </button>
          )}
        </div>
      )}

      {result && (
        <div style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: 10, padding: 16, maxWidth: 820 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.addInk, marginBottom: 8 }}>Index rebuilt.</div>
          <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.7 }}>
            {result.embedded} section(s) embedded across {result.articlesWritten} article(s).<br />
            {result.pruned?.length ? <>Removed: {result.pruned.join(', ')}.<br /></> : null}
            {result.untouched} article(s) were already up to date and were not touched.
          </div>
        </div>
      )}
    </div>
  );
}
