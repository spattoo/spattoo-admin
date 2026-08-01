import { useState, useEffect } from 'react';
import { getDecorationGuide, buildDecorationGuide, deleteDecorationGuide } from '../lib/api.js';

// ── The decoration guide, as an admin sees it ───────────────────────────────────────
// The "how do I make this by hand" guide for a flat decoration — steps, colours, and the generated
// build-sequence picture. The sibling of CraftGuideEditor, which authors the NOZZLE guide for a
// piping element: two rows on the same sidecar table answering different questions.
//
// READ-ONLY for now, deliberately. Refining a guide by hand is worth doing and is not built; what
// is needed first is the ability to LOOK at what we generated and judge whether it is any good.
// Shipping an editor before anyone has read one would be guessing at which fields need editing.
//
// A catalogue element's guide is generated at publish (routes/elements.js) and costs a baker
// nothing, ever. Rebuild exists because publish-time generation only helps elements published from
// now on, and because a prompt change should be re-runnable against a bad result.

const c = {
  panel: { marginBottom: 20, padding: 16, borderRadius: 12, border: '1.5px solid #D9CFE0', background: '#FAF7FC' },
  head: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, fontSize: 11, fontWeight: 800, color: '#5B4A6B', letterSpacing: 1, textTransform: 'uppercase' },
  hint: { fontSize: 11, color: '#8B7C99', marginBottom: 12, fontFamily: "'Quicksand', sans-serif", lineHeight: 1.5 },
  btn: (busy) => ({
    padding: '9px 14px', borderRadius: 10, border: 'none', background: '#5B4A6B', color: '#fff',
    fontSize: 12, fontWeight: 800, fontFamily: "'Quicksand', sans-serif",
    cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
  }),
  danger: { padding: '9px 14px', borderRadius: 10, border: '1.5px solid #E0C4C4', background: '#fff', color: '#A33', fontSize: 12, fontWeight: 800, fontFamily: "'Quicksand', sans-serif", cursor: 'pointer' },
  ghost: { padding: '9px 14px', borderRadius: 10, border: '1.5px solid #D9CFE0', background: '#fff', color: '#5B4A6B', fontSize: 12, fontWeight: 800, fontFamily: "'Quicksand', sans-serif", cursor: 'pointer' },
  msg: (ok) => ({ fontSize: 12, fontWeight: 600, color: ok ? '#5B4A6B' : '#c00', marginTop: 10 }),
  label: { fontSize: 10, fontWeight: 800, color: '#8B7C99', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 5 },
  step: { fontSize: 12.5, color: '#2C2A26', marginBottom: 8, lineHeight: 1.5 },
  swatch: (hex) => ({ width: 16, height: 16, borderRadius: 4, background: hex, border: '1px solid rgba(0,0,0,0.15)', display: 'inline-block', verticalAlign: 'middle', marginRight: 6 }),
  // auto-fill rather than a fixed column count: the panel sits in a narrow admin sidebar and in a
  // wide one, and a hardcoded 3-up would be unreadable in the first and wasteful in the second.
  tag: { display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: '#EFE9F4', color: '#5B4A6B', fontSize: 11, fontWeight: 700, marginRight: 6 },
};

// Steps carry ROLE TOKENS ({body}, {mane}) rather than colour names, so one guide serves every
// colour the decoration is ever made in. Rendered as the role word.
const readable = (t) => String(t ?? '').replace(/\{(\w+)\}/g, (_, r) => r.replace(/_/g, ' '));

export default function DecorationGuidePanel({ elementId }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy]       = useState(false);
  const [msg, setMsg]         = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setMsg(null);
    getDecorationGuide(elementId)
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setMsg({ ok: false, text: e.message }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [elementId]);

  async function remove() {
    if (busy) return;
    // The guide is not recoverable from here — the picture goes to the bin, the row does not.
    // Worth a confirm, and worth saying where the picture goes so this does not feel destructive
    // when it is not.
    if (!window.confirm('Delete this guide? The row is removed and the picture is moved to the deleted/ folder in storage, not destroyed.')) return;
    setBusy(true); setMsg(null);
    try {
      await deleteDecorationGuide(elementId);
      setData(d => ({ ...(d ?? {}), guide: null }));
      setMsg({ ok: true, text: 'Deleted. The picture is in deleted/ if you need it back.' });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally { setBusy(false); }
  }

  async function build(force) {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const res = await buildDecorationGuide(elementId, { force });
      // Not a failure: the model looked and judged this printed or pre-made. Worth saying plainly,
      // because it usually means the MEDIUM is wrong rather than that anything broke.
      if (res?.notModelled) {
        setMsg({ ok: true, text: 'The model says this is printed or pre-made, not hand-modelled. Check the medium.' });
      } else {
        setData(d => ({ ...(d ?? {}), guide: res.guide }));
        setMsg({ ok: true, text: 'Generated.' });
      }
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally { setBusy(false); }
  }

  if (loading) return <div style={c.panel}><div style={c.head}>Decoration guide</div><div style={c.hint}>Loading…</div></div>;

  const guide     = data?.guide?.guide ?? null;
  const policy    = data?.policy ?? {};
  const stagesUrl = data?.guide?.stages_url ?? null;

  return (
    <div style={c.panel}>
      <div style={c.head}>Decoration guide — how to make it by hand</div>
      <div style={c.hint}>
        Generated for the catalogue at publish, so a baker never pays for it. This is what they see
        in X-Ray.
      </div>

      {/* An ABSENT guide has two very different causes and they must not look alike: nothing has
          been generated yet, or this decoration is not something anyone hand-makes. */}
      {!guide && (
        policy.modelling === false ? (
          <div style={c.hint}>
            No guide, and that is correct — <b>{policy.reason}</b>.
            {policy.print && ' Bakers can still print it at actual size.'}
          </div>
        ) : (
          <div style={c.hint}>No guide yet for this decoration.</div>
        )
      )}

      {guide && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 10 }}>
            <span style={c.tag}>{data.guide.status === 'approved' ? 'approved' : 'AI draft'}</span>
            {guide.medium && <span style={c.tag}>{guide.medium}</span>}
            {guide.set_time && <span style={c.tag}>sets in {guide.set_time}</span>}
          </div>

          {/* THE SHEET. One image, one generation, complete with its own panels and captions —
              the artefact a baker prints and follows. Shown whole and full width because that is
              what it is: not an illustration beside the guide, but the guide. */}
          {stagesUrl && (
            <div style={{ marginBottom: 14 }}>
              <img src={stagesUrl} alt="" style={{ width: '100%', borderRadius: 8, border: '1px solid #E5DEEC', display: 'block' }} />
            </div>
          )}

          {/* Colours come from OUR gel table, never off the sheet — the model is told not to print
              hex values for exactly this reason. A misread code costs a baker a batch. */}
          {guide.colours?.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={c.label}>Colours</div>
              {guide.colours.map((col, i) => (
                <div key={i} style={{ fontSize: 12, marginBottom: 3 }}>
                  <span style={c.swatch(col.hex)} />
                  {readable(col.role)} · {col.hex}
                </div>
              ))}
            </div>
          )}

          {/* The written steps, kept alongside the sheet rather than replaced by it: the sheet's
              own captions are the model's words and cannot be corrected, translated or read aloud.
              These are ours. */}
          <div style={c.label}>Steps</div>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {(guide.steps ?? []).map((st, i) => (
              <li key={st.n ?? i} style={c.step}>
                <b>{readable(st.title)}</b>
                {(st.instructions ?? []).map((line, j) => <div key={j}>{readable(line)}</div>)}
                {st.tools?.length > 0 && <div style={{ color: '#8B7C99', fontSize: 11.5 }}>{st.tools.join(' · ')}</div>}
              </li>
            ))}
          </ol>

          {guide.tips?.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={c.label}>Tips</div>
              {guide.tips.map((t, i) => <div key={i} style={{ ...c.step, marginBottom: 4 }}>· {readable(t)}</div>)}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!guide && policy.modelling !== false && (
          <button type="button" style={c.btn(busy)} disabled={busy} onClick={() => build(false)}>
            {busy ? 'Generating…' : 'Generate guide'}
          </button>
        )}
        {/* Rebuild is behind `force` server-side so nobody replaces an approved guide by accident;
            confirming here as well because the old one is not recoverable. */}
        {guide && (
          <button type="button" style={c.ghost} disabled={busy} onClick={() => {
            if (window.confirm('Replace this guide with a freshly generated one? The current picture moves to the deleted/ folder.')) build(true);
          }}>{busy ? 'Generating…' : 'Rebuild'}</button>
        )}
        {/* Delete is for a decoration that should have NO guide — the medium was wrong, or nobody
            models this. Rebuilding such a thing only produces a better wrong answer. */}
        {guide && (
          <button type="button" style={c.danger} disabled={busy} onClick={remove}>Delete guide</button>
        )}
      </div>

      {msg && <div style={c.msg(msg.ok)}>{msg.text}</div>}
    </div>
  );
}
