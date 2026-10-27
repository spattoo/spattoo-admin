import { useState, useEffect, useCallback } from 'react';
import { getHelpQuestions } from '../lib/api.js';

/* ── What bakers asked the assistant, and what we failed to answer ───────────────────────────────
 *
 * ⚠️ THE MISSES ARE THE CONTENT. It is tempting to build this as usage analytics — questions per
 * day, a chart, the popular ones at the top. That would bury the only rows anyone opens this page
 * to find. So "missed" is the default view and the headline is a count of failures.
 *
 * ⚠️ AND THERE ARE TWO KINDS OF MISS, WHICH LOOK NOTHING ALIKE. "Nothing found" is a gap we can
 * see: no section cleared the answer floor and the panel said so. "Did not answer" is a gap only a
 * baker could see — a card that scored well, came from the right article, and did not contain the
 * fact. Measured over twenty factual questions (2026-10-27), nineteen returned something and
 * roughly seven were actually answered; "Does Spattoo work in Hindi?" came back, at 0.384, with
 * the passage explaining why the menu is drawn as a spatula. No score sees that. Only a person
 * pressing the button does, which is why the second kind is shown with the article it wrongly
 * offered: that names the article to go and fix.
 *
 * What to do with a row is written down already — help/INDEX.md says to order the writing by this
 * log "rather than what we imagine they need".
 */

const WINDOWS = [7, 30, 90];

const C = {
  ink: '#2C4433', muted: '#5C7565', faint: '#9BB5A2', line: '#C5D4C8', page: '#EDEAE2',
  alarmInk: '#991B1B', alarmBg: '#FEE2E2',
  warnInk: '#92400E', warnBg: '#FEF3C7',
  okInk: '#065F46', okBg: '#D1FAE5',
};

function Badge({ ink, bg, children }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                   background: bg, color: ink, whiteSpace: 'nowrap' }}>{children}</span>
  );
}

function verdict(q) {
  if (q.result_count === 0) return <Badge ink={C.alarmInk} bg={C.alarmBg}>Nothing found</Badge>;
  if (q.helpful === false)  return <Badge ink={C.warnInk}  bg={C.warnBg}>Did not answer</Badge>;
  return <Badge ink={C.okInk} bg={C.okBg}>Answered</Badge>;
}

export default function HelpQuestions() {
  const [days, setDays] = useState(30);
  const [missedOnly, setMissedOnly] = useState(true);
  const [rows, setRows] = useState(null);
  const [summary, setSummary] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    setErr(null);
    getHelpQuestions({ days, filter: missedOnly ? 'missed' : '' })
      .then((r) => { setRows(r?.questions ?? []); setSummary(r?.summary ?? null); })
      .catch((e) => setErr(e?.message ?? 'Could not load'));
  }, [days, missedOnly]);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ padding: 24, background: C.page, minHeight: '100vh', fontFamily: "'Quicksand', sans-serif" }}>
      <h1 style={{ fontSize: 20, color: C.ink, margin: '0 0 4px' }}>Help questions</h1>
      <p style={{ fontSize: 13, color: C.muted, margin: '0 0 18px', maxWidth: 680 }}>
        What bakers asked the assistant. <strong>Nothing found</strong> means no article cleared the
        answer floor. <strong>Did not answer</strong> means a baker pressed “this did not answer my
        question” — the article named beside it is the one that was wrongly offered, which is
        usually the one to fix.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        {WINDOWS.map(d => (
          <button key={d} type="button" onClick={() => setDays(d)}
                  style={{ fontFamily: 'inherit', fontSize: 12, fontWeight: 700, padding: '7px 14px',
                           borderRadius: 8, cursor: 'pointer',
                           border: `1px solid ${days === d ? C.ink : C.line}`,
                           background: days === d ? C.ink : '#fff',
                           color: days === d ? '#fff' : C.muted }}>
            {d} days
          </button>
        ))}
        <label style={{ fontSize: 12, color: C.muted, display: 'flex', alignItems: 'center', gap: 6, marginLeft: 6 }}>
          <input type="checkbox" checked={missedOnly} onChange={e => setMissedOnly(e.target.checked)} />
          Only what we missed
        </label>
        <button type="button" onClick={load}
                style={{ fontFamily: 'inherit', fontSize: 12, padding: '7px 14px', borderRadius: 8,
                         border: `1px solid ${C.line}`, background: '#fff', color: C.muted, cursor: 'pointer' }}>
          Refresh
        </button>
      </div>

      {summary && (
        <div style={{ fontSize: 13, color: C.ink, marginBottom: 14 }}>
          <strong>{summary.nothingFound}</strong> found nothing
          {' · '}<strong>{summary.saidUnhelpful}</strong> told us it did not answer
          {' · '}{summary.asked} shown, last {summary.days} days
        </div>
      )}

      {err && <div style={{ color: C.alarmInk, fontSize: 13 }}>{err}</div>}
      {rows == null && !err && <div style={{ color: C.muted, fontSize: 13 }}>Loading…</div>}

      {rows?.length === 0 && (
        /* ⚠️ "Nothing yet" and "nothing missed" are opposite news and must not share a sentence. */
        <div style={{ color: C.muted, fontSize: 13, background: '#fff', border: `1px solid ${C.line}`,
                      borderRadius: 10, padding: 16 }}>
          {missedOnly
            ? 'Nothing missed in this window — either the articles are covering it, or nobody has asked yet. Untick the filter to tell which.'
            : 'No questions asked in this window.'}
        </div>
      )}

      {rows?.length > 0 && (
        <div style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: 10, overflow: 'hidden' }}>
          {rows.map((q, i) => (
            <div key={q.id} style={{ padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'flex-start',
                                     borderTop: i ? `1px solid ${C.page}` : 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, color: C.ink, fontWeight: 600 }}>{q.question}</div>
                <div style={{ fontSize: 11, color: C.faint, marginTop: 3 }}>
                  {new Date(q.asked_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                  {q.top_doc_slug && (
                    <> {' · '}we showed <span style={{ color: C.muted }}>{q.top_doc_slug}
                      {q.top_heading ? ` § ${q.top_heading}` : ''}</span>
                      {q.top_score != null && ` (${Number(q.top_score).toFixed(3)})`}</>
                  )}
                </div>
              </div>
              {verdict(q)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
