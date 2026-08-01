import { useState, useEffect } from 'react';
import { getDecorationGuide, buildDecorationGuide } from '../lib/api.js';

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
  ghost: { padding: '9px 14px', borderRadius: 10, border: '1.5px solid #D9CFE0', background: '#fff', color: '#5B4A6B', fontSize: 12, fontWeight: 800, fontFamily: "'Quicksand', sans-serif", cursor: 'pointer' },
  msg: (ok) => ({ fontSize: 12, fontWeight: 600, color: ok ? '#5B4A6B' : '#c00', marginTop: 10 }),
  label: { fontSize: 10, fontWeight: 800, color: '#8B7C99', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 5 },
  step: { fontSize: 12.5, color: '#2C2A26', marginBottom: 8, lineHeight: 1.5 },
  swatch: (hex) => ({ width: 16, height: 16, borderRadius: 4, background: hex, border: '1px solid rgba(0,0,0,0.15)', display: 'inline-block', verticalAlign: 'middle', marginRight: 6 }),
  // auto-fill rather than a fixed column count: the panel sits in a narrow admin sidebar and in a
  // wide one, and a hardcoded 3-up would be unreadable in the first and wasteful in the second.
  stepGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 },
  stepCard: { borderRadius: 10, background: '#fff', border: '1px solid #EFE9F4', overflow: 'hidden' },
  // Square, because stageSize asks the model for a size that makes each CELL square. A different
  // aspect here would crop or stretch the very panel it is meant to show.
  cell: (bg) => ({ width: '100%', aspectRatio: '1 / 1', ...bg }),
  tag: { display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: '#EFE9F4', color: '#5B4A6B', fontSize: 11, fontWeight: 700, marginRight: 6 },
};

// ── One cell of the grid ────────────────────────────────────────────────────────────
// MIRRORS services/decorationPolicy.js stageGrid in spattoo-api, which is where the same numbers
// are given to the image model. Kept in step with it by hand — the alternative is storing the grid
// on every row, and a stored layout can disagree with the picture it describes, which is worse
// than a formula in two places. Same cross-repo mirror pattern as Captcha.jsx.
const MAX_STAGES = 12;
function stageGrid(stepCount) {
  const n = Math.min(MAX_STAGES, Math.max(1, Number(stepCount) || 1));
  const cols = n <= 4 ? 2 : 3;
  return { count: n, cols, rows: Math.ceil(n / cols) };
}

// Frame cell `i` without cutting the image: scale it up by the grid size, then offset so that cell
// lands in the box. The percentage form of background-position is relative to (image - box), which
// is exactly the ratio below — and it degrades to 0 for a single-column or single-row grid, where
// that ratio would divide by zero.
function cellStyle(url, grid, i) {
  const col = i % grid.cols, row = Math.floor(i / grid.cols);
  return {
    backgroundImage: `url(${url})`,
    backgroundSize: `${grid.cols * 100}% ${grid.rows * 100}%`,
    backgroundPosition:
      `${grid.cols > 1 ? (col / (grid.cols - 1)) * 100 : 50}% ` +
      `${grid.rows > 1 ? (row / (grid.rows - 1)) * 100 : 50}%`,
    backgroundRepeat: 'no-repeat',
  };
}

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
  const grid      = stageGrid(guide?.steps?.length ?? 0);

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

          <div style={c.label}>Steps</div>
          {/* CARDS, not a list with thumbnails. The picture is the part that carries a shape — a
              baker checks "is mine supposed to look like that yet" against the image, not the
              prose — so it gets the width, and the words sit under it. Side by side, the way the
              step-by-step sheets bakers actually share are laid out. */}
          <div style={c.stepGrid}>
            {(guide.steps ?? []).map((st, i) => (
              <div key={st.n ?? i} style={c.stepCard}>
                {/* This step's OWN cell of the single generated grid image. background-position
                    frames the cell — no slicing, no second asset, nothing to keep in sync. */}
                {stagesUrl && <div style={c.cell(cellStyle(stagesUrl, grid, i))} />}
                <div style={{ padding: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: '#2C2A26', marginBottom: 4 }}>
                    {i + 1}. {readable(st.title)}
                  </div>
                  {(st.instructions ?? []).map((line, j) => (
                    <div key={j} style={{ fontSize: 12.5, color: '#2C2A26', lineHeight: 1.5, marginBottom: 2 }}>
                      {readable(line)}
                    </div>
                  ))}
                  {st.tools?.length > 0 && (
                    <div style={{ fontSize: 11.5, color: '#8B7C99', marginTop: 5 }}>{st.tools.join(' · ')}</div>
                  )}
                </div>
              </div>
            ))}
          </div>

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
            if (window.confirm('Replace this guide with a freshly generated one? The current one is not kept.')) build(true);
          }}>{busy ? 'Generating…' : 'Rebuild'}</button>
        )}
      </div>

      {msg && <div style={c.msg(msg.ok)}>{msg.text}</div>}
    </div>
  );
}
