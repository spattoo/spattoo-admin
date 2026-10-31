import { useCallback, useEffect, useState } from 'react';
import {
  getAdminPromptQuestions, createPromptQuestion, updatePromptQuestion,
  addPromptOption, updatePromptOption, deletePromptOption,
  getAdminDecorationMediums, updateDecorationMediumPhrase,
  getPromptFrame, updatePromptFrame,
} from '../lib/api.js';

// ── What we ask before generating a 3D decoration ───────────────────────────────────────────────
//
// The questions came out of guesswork and will keep moving as real generations come back wrong, so
// they are rows rather than code (migrations 149/151) and this is where they are edited. Root
// CLAUDE.md rule 3: if an admin cannot change it without a deploy, it is in the wrong place.
//
// ⚠️ THERE ARE ONLY TWO QUESTIONS, AND THAT IS THE DESIGN RATHER THAN A GAP. The first version
// keyed a question set to each element category — a lion was asked how it sits, a rose how open it
// is. Sandeep, on trying it: *"i think making these categories does not making any sense to me.. we
// can only ask generic questions. if they type bat- how do you know which bat is it? there are many
// sports use bat."* Nothing can classify "bat" from one word, and a category picker only moves the
// guess onto the operator. The baker's own description settles it — "cricket bat, worn willow with
// a taped handle" is not ambiguous — which is why the second question is a box and not chips.
//
// Everything else that makes a run fail is OURS and is applied every time without asking:
// cake-topper scale, a flat base, untextured (so parts stay recolourable), and the triangle cap.
// Sandeep, on the detail question that used to be here: *"i did not [mean] the number of traingles
// or any technical detail. its the detail on how they want it to look."* Nobody wants "Simple".
//
// ⚠️ AND THE MATERIALS ARE NOT QUESTION OPTIONS. "Made of" reads decoration_mediums — the one home
// for that vocabulary (migration 101), after admin was caught carrying a fifth hand-kept copy that
// offered a material which cannot be modelled at all. What IS authorable is how each material reads
// to a generator, which is the second panel below.

const C = {
  ink: '#2C4433', muted: '#5C7565', faint: '#9BB5A2', line: '#C5D4C8',
  page: '#EDEAE2', card: '#FFFFFF', warnBg: '#FEF3C7', warnInk: '#92400E',
  okBg: '#D1FAE5', okInk: '#065F46', alarmInk: '#991B1B',
};

const S = {
  input: { padding: '7px 10px', borderRadius: 9, fontFamily: 'inherit', fontSize: 12.5,
           border: `1.5px solid ${C.line}`, background: '#fff', color: C.ink },
  btn:   { appearance: 'none', font: 'inherit', fontSize: 12, fontWeight: 700, padding: '6px 12px',
           borderRadius: 9, cursor: 'pointer', background: '#fff', color: C.ink,
           border: `1px solid ${C.line}`, whiteSpace: 'nowrap' },
  card:  { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, marginBottom: 12 },
};

function Badge({ bg, ink, children }) {
  return <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 20,
                        background: bg, color: ink, whiteSpace: 'nowrap' }}>{children}</span>;
}

/* One stored option. The PHRASE is the only field that costs money to get wrong — it is what
   reaches the generator — so it is shown as an editable field rather than hidden behind the label. */
function OptionRow({ option, onSave, onRemove, onMakeDefault }) {
  const [label, setLabel] = useState(option.label);
  const [phrase, setPhrase] = useState(option.phrase ?? '');
  const dirty = label !== option.label || phrase !== (option.phrase ?? '');

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
      <input value={label} onChange={e => setLabel(e.target.value)}
             style={{ ...S.input, width: 150 }} placeholder="Label" />
      <input value={phrase} onChange={e => setPhrase(e.target.value)}
             style={{ ...S.input, flex: '1 1 300px', minWidth: 200 }}
             placeholder="what the generator is told — blank adds nothing" />
      {option.is_default
        ? <button type="button" style={{ ...S.btn, background: C.okBg, color: C.okInk, borderColor: C.okBg }}
                  title="Click to clear — the question then adds nothing unless answered"
                  onClick={() => onSave(option, { is_default: false })}>default ✕</button>
        : <button type="button" style={S.btn} onClick={() => onMakeDefault(option)}>Make default</button>}
      {dirty && (
        <button type="button" style={{ ...S.btn, background: C.ink, color: '#fff', borderColor: C.ink }}
                onClick={() => onSave(option, { label, phrase })}>Save</button>
      )}
      <button type="button" style={{ ...S.btn, color: C.alarmInk }} onClick={() => onRemove(option)}>Remove</button>
    </div>
  );
}

export default function PromptQuestions() {
  const [questions, setQuestions] = useState([]);
  const [mediums, setMediums]     = useState([]);
  const [frame, setFrame]         = useState([]);
  const [error, setError]         = useState('');
  const [loading, setLoading]     = useState(true);
  const [adding, setAdding]       = useState({});   // questionId -> typed label

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [qs, ms, fr] = await Promise.all([getAdminPromptQuestions(), getAdminDecorationMediums(), getPromptFrame()]);
      setQuestions(qs ?? []);
      setMediums(ms ?? []);
      setFrame(fr ?? []);
    } catch (e) {
      setError(e.message || 'Could not load the questions.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn) => { try { await fn(); await load(); } catch (e) { setError(e.message || 'That did not work.'); } };

  return (
    <div style={{ padding: '22px 16px 60px', maxWidth: 940, margin: '0 auto' }}>
      <h1 style={{ fontSize: 20, fontWeight: 800, color: C.ink, margin: '0 0 6px' }}>Generation Questions</h1>
      <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.55, margin: '0 0 18px', maxWidth: 640 }}>
        What a baker is asked before we generate a 3D decoration. Deliberately generic — nothing here
        can know whether &ldquo;bat&rdquo; means cricket, baseball or the animal, so the free-text
        answer is what settles it. Scale, flat base, untextured and the triangle cap are applied
        every time and are not asked.
      </p>

      {loading && <div style={{ fontSize: 13, color: C.muted }}>Loading…</div>}
      {error && <div style={{ fontSize: 13, color: C.alarmInk, marginBottom: 12 }}>{error}</div>}

      {questions.map(q => (
        <div key={q.id} style={S.card}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 14, color: C.ink }}>{q.label}</strong>
            <Badge bg={C.page} ink={C.muted}>{q.source}</Badge>
            {!q.is_active && <Badge bg={C.warnBg} ink={C.warnInk}>hidden</Badge>}
            {q.category_id && <Badge bg={C.warnBg} ink={C.warnInk}>category-scoped</Badge>}
            <button type="button" style={{ ...S.btn, marginLeft: 'auto' }}
                    onClick={() => run(() => updatePromptQuestion(q.id, { is_active: !q.is_active }))}>
              {q.is_active ? 'Hide' : 'Show'}
            </button>
          </div>
          {q.help && <div style={{ fontSize: 11.5, color: C.faint, marginTop: 4, lineHeight: 1.5 }}>{q.help}</div>}

          {/* A question that reads another table has nothing to author here, and saying so beats
              showing an empty list that looks like a loading bug. */}
          {q.source === 'mediums' && (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
              Answered from the materials below — there is nothing to edit here.
            </div>
          )}
          {q.source === 'free_text' && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: C.faint, marginBottom: 4 }}>
                Placeholder — the example shown inside the empty box
              </div>
              <PlaceholderField q={q} onSave={(placeholder) => run(() => updatePromptQuestion(q.id, { placeholder }))} />
            </div>
          )}

          {q.source === 'options' && (
            <>
              {/* ⚠️ A DEFAULT ON A GENERIC QUESTION IS APPLIED TO EVERY ELEMENT, including the ones
                  it makes no sense for. Found by driving it: a "Form" question defaulting to
                  Sitting produced *"cricket bat, worn willow with a taped handle, sitting upright
                  with a flat base"*. That is the same failure the categories were removed for,
                  arriving through the back door — so the warning sits next to the button that
                  causes it rather than in a doc nobody opens. No default is the safe state: the
                  question then contributes nothing until somebody picks an answer. */}
              {q.options.some(o => o.is_default) && (
                <div style={{ fontSize: 11, color: C.warnInk, background: C.warnBg, padding: '6px 10px',
                              borderRadius: 8, marginTop: 8, lineHeight: 1.5 }}>
                  This question has a default, so its answer is added to <strong>every</strong>{' '}
                  element — a bat would be told it is &ldquo;
                  {q.options.find(o => o.is_default)?.phrase || '—'}&rdquo;. Leave a question with no
                  default unless the answer is true of everything.
                </div>
              )}
              {q.options.map(o => (
                <OptionRow key={o.id} option={o}
                  onSave={(opt, changes) => run(() => updatePromptOption(opt.id, changes))}
                  onRemove={(opt) => run(() => deletePromptOption(opt.id))}
                  onMakeDefault={(opt) => run(() => updatePromptOption(opt.id, { is_default: true }))} />
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input value={adding[q.id] ?? ''} placeholder="add an option — e.g. Sleeping"
                       onChange={e => setAdding(a => ({ ...a, [q.id]: e.target.value }))}
                       style={{ ...S.input, flex: '1 1 240px' }} />
                <button type="button" style={S.btn} disabled={!(adding[q.id] ?? '').trim()}
                        onClick={() => run(async () => {
                          await addPromptOption(q.id, { label: adding[q.id].trim() });
                          setAdding(a => ({ ...a, [q.id]: '' }));
                        })}>Add</button>
              </div>
            </>
          )}
        </div>
      ))}

      {/* ── The frame ───────────────────────────────────────────────────────────────────────── */}
      <h2 style={{ fontSize: 15, fontWeight: 800, color: C.ink, margin: '26px 0 6px' }}>
        Always said, whatever they answer
      </h2>
      <p style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.55, margin: '0 0 12px', maxWidth: 640 }}>
        Two questions cannot carry what we know and a baker should never have to type — that this is
        sugarcraft someone has to <em>make</em>, that it must stand on a cake, that thin parts snap
        in fondant. <strong>Some of these were expensive to learn</strong>; the note says which.
      </p>
      <div style={S.card}>
        {['always', 'recolourable', 'ready'].map(scope => {
          const rows = frame.filter(f => f.applies_to === scope);
          if (!rows.length) return null;
          return (
            <div key={scope} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: C.faint, letterSpacing: 0.4,
                            textTransform: 'uppercase', marginBottom: 6 }}>
                {scope === 'always' ? 'every prompt'
                  : scope === 'recolourable' ? 'only when asking for parts'
                  : 'only when asking for a textured, ready-to-use model'}
              </div>
              {rows.map(f => (
                <FrameRow key={f.id} row={f}
                          onSave={(changes) => run(() => updatePromptFrame(f.id, changes))} />
              ))}
            </div>
          );
        })}
      </div>

      {/* ── Adding one ──────────────────────────────────────────────────────────────────────── */}
      <NewQuestion onCreate={(q) => run(() => createPromptQuestion(q))} />

      {/* ── The materials ────────────────────────────────────────────────────────────────────── */}
      <h2 style={{ fontSize: 15, fontWeight: 800, color: C.ink, margin: '26px 0 6px' }}>
        How each material reads to a generator
      </h2>
      <p style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.55, margin: '0 0 12px', maxWidth: 640 }}>
        Authored, never derived from the label — deriving it produced &ldquo;wafer paper (shaped)
        finish&rdquo;. <strong>Leave it blank to stop offering that material for generation</strong>,
        which is a different thing from whether a human can hand-make it.
      </p>
      <div style={S.card}>
        {mediums.map(m => (
          <MediumRow key={m.key} medium={m}
                     onSave={(phrase) => run(() => updateDecorationMediumPhrase(m.key, phrase))} />
        ))}
      </div>
    </div>
  );
}

/* ⚠️ A NEW QUESTION IS A CHIP ROW OR A BOX, AND NOTHING ELSE. 'mediums' is not offered: there is
   exactly one material question and it already exists, so a second would be two chip rows reading
   the same table — a confusing screen rather than a useful one. */
function NewQuestion({ onCreate }) {
  const [label, setLabel] = useState('');
  const [source, setSource] = useState('options');
  return (
    <div style={{ ...S.card, borderStyle: 'dashed' }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, marginBottom: 8 }}>Add a question</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. How it sits"
               style={{ ...S.input, flex: '1 1 240px' }} />
        <select value={source} onChange={e => setSource(e.target.value)} style={S.input}>
          <option value="options">Chips — a few fixed answers</option>
          <option value="free_text">A box — they type it</option>
        </select>
        <button type="button" style={{ ...S.btn, background: C.ink, color: '#fff', borderColor: C.ink }}
                disabled={!label.trim()}
                onClick={() => { onCreate({ label: label.trim(), source }); setLabel(''); }}>Add</button>
      </div>
      <div style={{ fontSize: 11, color: C.faint, marginTop: 6, lineHeight: 1.5 }}>
        A chip question starts with no options — add them here, or from the 3D studio when you hit a
        gap mid-generation. Everything you add is asked of <strong>every</strong> element.
      </div>
    </div>
  );
}

/* ⚠️ THE NOTE IS SHOWN, NOT HIDDEN BEHIND A TOOLTIP. Three of these clauses cost a wasted
   generation to discover — one of them 501,326 triangles against a 25,000 cap — and the person most
   likely to delete one is the person who has not met that failure yet. */
function FrameRow({ row, onSave }) {
  const [phrase, setPhrase] = useState(row.phrase);
  const dirty = phrase !== row.phrase;
  const measured = /MEASURED/i.test(row.note ?? '');
  return (
    <div style={{ marginBottom: 10, opacity: row.is_active ? 1 : 0.55 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: C.faint, width: 84 }}>{row.key}</span>
        <input value={phrase} onChange={e => setPhrase(e.target.value)}
               style={{ ...S.input, flex: '1 1 320px' }} />
        {measured && <Badge bg={C.warnBg} ink={C.warnInk}>measured</Badge>}
        {dirty && (
          <button type="button" style={{ ...S.btn, background: C.ink, color: '#fff', borderColor: C.ink }}
                  onClick={() => onSave({ phrase })}>Save</button>
        )}
        <button type="button" style={S.btn} onClick={() => onSave({ is_active: !row.is_active })}>
          {row.is_active ? 'Switch off' : 'Switch on'}
        </button>
      </div>
      {row.note && (
        <div style={{ fontSize: 10.5, color: C.faint, marginTop: 3, marginLeft: 92, lineHeight: 1.5,
                      maxWidth: 620 }}>{row.note}</div>
      )}
    </div>
  );
}

function PlaceholderField({ q, onSave }) {
  const [v, setV] = useState(q.placeholder ?? '');
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <input value={v} onChange={e => setV(e.target.value)} style={{ ...S.input, flex: 1 }} />
      {v !== (q.placeholder ?? '') && (
        <button type="button" style={{ ...S.btn, background: C.ink, color: '#fff', borderColor: C.ink }}
                onClick={() => onSave(v)}>Save</button>
      )}
    </div>
  );
}

function MediumRow({ medium, onSave }) {
  const [v, setV] = useState(medium.prompt_phrase ?? '');
  const dirty = v !== (medium.prompt_phrase ?? '');
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
      <span style={{ fontSize: 12.5, color: C.ink, width: 190, fontWeight: 600 }}>{medium.label}</span>
      {/* can_model = false is why some materials have no phrase: you cannot model a ganache lion.
          Said plainly, so a blank row does not read as something nobody got round to filling in. */}
      {!medium.can_model
        ? <span style={{ fontSize: 11.5, color: C.faint, flex: 1 }}>cannot be modelled — never offered</span>
        : <>
            <input value={v} onChange={e => setV(e.target.value)} style={{ ...S.input, flex: '1 1 260px' }}
                   placeholder="blank = not offered for generation" />
            {dirty && (
              <button type="button" style={{ ...S.btn, background: C.ink, color: '#fff', borderColor: C.ink }}
                      onClick={() => onSave(v)}>Save</button>
            )}
          </>}
    </div>
  );
}
