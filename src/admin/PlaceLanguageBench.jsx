import { useRef, useState } from 'react';
import { placeFromInstruction } from '../lib/api.js';

/* ── Does free text become the right action? ─────────────────────────────────────────────────────
 *
 * Sandeep: *"i wanted to check if a user natural language text can be turned into action. just a
 * predefined actions can definitely be made. why would i ask this?"* — said of a harness I built
 * with dropdowns and chips, which validates the GEOMETRY and answers none of that. This page is
 * the other half: a column of SENTENCES, run one at a time, with what each one actually did
 * beside it.
 *
 * ⚠️ THE SENTENCES ARE EDITABLE, AND THAT IS THE WHOLE POINT. A fixed list of phrasings I wrote is
 * the same mistake one step removed — a model that handles only the sentences its author imagined
 * has not been tested. The seed set is deliberately awkward (no zone named, quantity in words, a
 * misspelling, a mood instead of an object, two asks in one breath, nonsense), and the box is
 * there so the next awkward sentence is somebody else's.
 *
 * ⚠️ IT DOES NOT MARK ITS OWN HOMEWORK. There is no pass/fail column, because a rule written by
 * the same hand as the prompt would only ever agree with it. The `expect` note sits beside the
 * result for a person to read down. And a clean sweep would be the bug, not the win — two of the
 * seed lines SHOULD place nothing.
 *
 * ⚠️ IT SPENDS REAL MONEY, ONE CALL A LINE, so it runs on a button and reports the tally rather
 * than firing on load. ~1.3k input tokens each at the time of writing.
 */

/* Each line is `text` and the `want` a person would call right — prose, never asserted. */
const SEED = [
  { t: 'add a coral on the board',                    w: 'several coral rows, on the board' },
  { t: 'add some peacocks',                           w: 'peacock — it has to pick a surface itself' },
  { t: 'put a few stars on top',                      w: '"a few" should be a small count' },
  { t: 'cover the sides in butterflies',              w: '"cover" should be a big one' },
  { t: 'line the bottom of the cake with shells',     w: 'a ring — the word is never used' },
  { t: 'one big lion right in the middle of the top', w: 'single, on the top' },
  { t: 'add a pecock on the side',                    w: 'peacock — retrieval scores Fox higher' },
  { t: 'make the board look like the sea floor',      w: 'a mood, not an object: several sea rows' },
  { t: 'a unicorn on top and stars all around it',    w: 'two asks, one group — it must pick one' },
  { t: 'add a dinosaur on the board',                 w: 'all 3 dinosaurs are side-only: say so, never swap the animal' },
  { t: 'kindly add some flowers on the sides',        w: 'flowers, on the side' },
  { t: 'asdf qwerty',                                 w: 'nothing placed' },
];

const C = {
  ink: '#2C4433', dim: '#5C7565', faint: '#9BB5A2', line: '#C5D4C8', sunk: '#F4F7F3',
  warn: '#92400E', warnBg: '#FEF3C7', okInk: '#065F46', okBg: '#D1FAE5',
};

export default function PlaceLanguageBench() {
  const [lines, setLines] = useState(SEED.map(s => s.t).join('\n'));
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const stop = useRef(false);

  const wantFor = (t) => SEED.find(s => s.t === t)?.w ?? '';

  async function run() {
    const list = lines.split('\n').map(s => s.trim()).filter(Boolean);
    if (!list.length) return;
    setBusy(true); setRows([]); setDone(0); stop.current = false;

    const out = [];
    for (const t of list) {
      if (stop.current) break;
      try {
        const r = await placeFromInstruction(t);
        out.push({ t, ...(r.ok ? { g: r.group, els: r.elements ?? [], usage: r.usage }
                                : { none: r.reason, rejected: r.rejected ?? [] }) });
      } catch (e) {
        out.push({ t, err: e?.message ?? 'failed' });
      }
      /* Rendered as they land. Twelve calls is most of a minute, and a page that shows nothing
         until the last one looks broken for the whole of it. */
      setRows([...out]); setDone(out.length);
    }
    setBusy(false);
  }

  const acted = rows.filter(r => r.g);
  const tokens = rows.reduce((n, r) => n + (r.usage?.prompt_tokens ?? 0), 0);
  const variety = acted.filter(r => r.els.length > 1).length;

  return (
    <div style={{ padding: '22px 26px 70px', color: C.ink, maxWidth: 1180, margin: '0 auto' }}>
      <h2 style={{ margin: '0 0 5px', fontSize: 19 }}>Does free text become the right action?</h2>
      <p style={{ margin: '0 0 16px', fontSize: 13.5, color: C.dim, lineHeight: 1.55, maxWidth: '74ch' }}>
        One sentence per line, each sent to the placer on its own. Awkward phrasings on purpose —
        no surface named, quantities in words, a misspelling, a mood instead of an object, two asks
        in one breath, nonsense. Edit them, or add your own; the ones worth testing are the ones
        nobody thought of. Nothing is scored, because a score written beside the prompt would only
        agree with it.
      </p>

      <textarea value={lines} onChange={e => setLines(e.target.value)} rows={9} spellCheck={false}
        style={{ width: '100%', boxSizing: 'border-box', padding: '11px 13px', fontSize: 13,
                 border: `1px solid ${C.line}`, borderRadius: 8, resize: 'vertical',
                 fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: 1.7 }} />

      <div style={{ display: 'flex', gap: 9, alignItems: 'center', margin: '11px 0 20px' }}>
        <button type="button" onClick={run} disabled={busy}
          style={{ padding: '10px 20px', borderRadius: 9, border: 'none', fontWeight: 700,
                   background: busy ? C.faint : C.ink, color: '#fff', fontSize: 13.5,
                   cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit' }}>
          {busy ? `Running… ${done}` : 'Run every line'}
        </button>
        {busy && (
          <button type="button" onClick={() => { stop.current = true; }}
            style={{ padding: '10px 14px', borderRadius: 9, border: `1px solid ${C.line}`,
                     background: '#fff', color: C.dim, fontSize: 13, cursor: 'pointer',
                     fontFamily: 'inherit' }}>
            Stop
          </button>
        )}
        <span style={{ fontSize: 12, color: C.faint }}>
          one model call per line — about 1.3k input tokens each
        </span>
      </div>

      {rows.length > 0 && (
        <>
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 9, overflow: 'hidden' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
              <thead>
                <tr style={{ background: C.sunk, color: C.dim }}>
                  <th style={th}>What was typed</th>
                  <th style={th}>What it did</th>
                  <th style={th}>Rows it used</th>
                  <th style={th}>What a person would call right</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${C.line}` }}>
                    <td style={{ ...td, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5 }}>{r.t}</td>
                    <td style={td}>
                      {r.err ? <span style={{ color: C.warn }}>error — {r.err}</span>
                       : r.none ? <span style={{ ...pill, background: C.warnBg, color: C.warn }}>nothing placed</span>
                       : <>
                           <span style={{ ...pill, background: C.okBg, color: C.okInk }}>
                             {r.g.count}× {r.g.arrangement}
                           </span>
                           <span style={{ color: C.dim }}> on {r.g.zone.replace('_', ' ')}</span>
                           {r.g.askedZone && (
                             <div style={{ color: C.warn, fontSize: 12, marginTop: 3 }}>
                               asked for {r.g.askedZone.replace('_', ' ')} — re-zoned, not swapped
                             </div>
                           )}
                         </>}
                    </td>
                    <td style={{ ...td, color: C.dim, fontSize: 12.5 }}>
                      {r.els?.length ? r.els.map(e => e.name).join(', ') : '—'}
                    </td>
                    <td style={{ ...td, color: C.faint, fontSize: 12.5 }}>{wantFor(r.t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p style={{ marginTop: 13, fontSize: 12.5, color: C.dim, lineHeight: 1.7 }}>
            <b>{acted.length}</b> of <b>{rows.length}</b> produced an action ·{' '}
            <b>{rows.length - acted.length}</b> placed nothing ·{' '}
            <b>{variety}</b> of {acted.length || 0} drew on more than one row ·{' '}
            {tokens ? <>~<b>{Math.round(tokens / rows.length)}</b> input tokens a line</> : null}
            <br />
            <span style={{ color: C.faint }}>
              A clean sweep is the bug, not the win — nonsense should place nothing.
            </span>
          </p>
        </>
      )}
    </div>
  );
}

const th = { textAlign: 'left', padding: '9px 12px', fontSize: 11, letterSpacing: '0.07em',
             textTransform: 'uppercase', fontWeight: 700 };
const td = { padding: '10px 12px', verticalAlign: 'top', lineHeight: 1.5 };
const pill = { display: 'inline-block', padding: '3px 8px', borderRadius: 5, fontSize: 12,
               fontWeight: 600 };
