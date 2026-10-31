import { useState, useEffect, useMemo } from 'react';
import { REQUIRED_TAG_CATEGORIES } from '@spattoo/designer';

/* ── THE grouped chip picker and THE tag editor, with two callers each ───────────────────────────
 *
 * Moved out of ManageTemplates.jsx, which already carries the lesson in its own comment: that
 * screen "had two tag pickers", one grouped and one filtered to occasions, same data and same save
 * call, and only one of them was right. Elements were about to become the third — Sandeep: *"in
 * manage elements - we dont have option to tag them. this is becoming a prob when we clone an
 * element and create a new one."*
 *
 * ⚠️ NO CATEGORY FILTER, DELIBERATELY (kept from the original). An "intent categories" subset would
 * be yet another hardcoded list of categories. This renders what the tags carry, so a category
 * added in admin appears with no code change.
 *
 * ⚠️ THE READ AND THE WRITE ARE INJECTED. Templates and elements have different endpoints
 * (`template_tags` / `element_tags`) and the element one can also ask the model for suggestions.
 * Passing the three functions in keeps one editor instead of one per entity — which is what the
 * duplication above actually was.
 */

const CHIP = (on) => ({
  padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 700, cursor: 'pointer',
  fontFamily: "'Quicksand', sans-serif",
  border: `1.5px solid ${on ? '#3D5A44' : '#C5D4C8'}`,
  background: on ? '#E8EDE9' : '#fff', color: on ? '#2C4433' : '#6B8C74',
});
const BTN = (kind = 'primary', disabled = false) => ({
  padding: '7px 14px', borderRadius: 9, fontSize: 12.5, fontWeight: 800, fontFamily: 'inherit',
  cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
  border: `1.5px solid ${kind === 'primary' ? '#2C4433' : '#C5D4C8'}`,
  background: kind === 'primary' ? '#2C4433' : '#fff',
  color: kind === 'primary' ? '#fff' : '#2C4433',
});
const HINT = { fontSize: 11.5, color: '#6B8C74' };

export function TagChipPicker({ allTags, chosen, onToggle }) {
  const groups = useMemo(() => {
    const by = new Map();
    for (const t of allTags) {
      const k = t.category ?? 'other';
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(t);
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [allTags]);

  return (
    <>
      {groups.map(([category, tags]) => (
        <div key={category} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
                        color: '#6B8C74', marginBottom: 5 }}>
            {category.replace(/_/g, ' ')}{REQUIRED_TAG_CATEGORIES.includes(category) ? ' *' : ''}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {tags.map(tag => {
              const on = chosen.has(tag.id);
              return (
                <button key={tag.id} type="button" style={CHIP(on)} aria-pressed={on}
                        onClick={() => onToggle(tag.id)}>
                  {tag.name}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * @param {object}   p
 * @param {string}   p.entityId
 * @param {Array}    p.allTags       the whole vocabulary
 * @param {Function} p.fetchTags     (id) => join rows  [{ tag_id, source, tags: {…} }]
 * @param {Function} p.saveTags      (id, tagIds) => void   — REPLACES the whole set
 * @param {Function} [p.suggestTags] (id) => join rows — asks the model; ADDS, never replaces
 * @param {string}   [p.noun]        'element' | 'template', for the sentences
 */
export default function TagEditor({
  entityId, allTags, fetchTags, saveTags, suggestTags = null, noun = 'element',
  onClose = null, onSaved = null,
}) {
  const [chosen, setChosen] = useState(null);   // null = still loading
  const [busy, setBusy]     = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [err, setErr]       = useState(null);
  const [note, setNote]     = useState(null);

  useEffect(() => {
    let cancelled = false;
    setChosen(null); setErr(null); setNote(null);
    /* The route returns join rows — { tag_id, source, tags: {…} } — so the id wanted is tag_id.
       AI-assigned ones come back here too, and that is deliberate: a save REPLACES the whole set
       (the PUT deletes then inserts), so anything not shown would be silently dropped. */
    fetchTags(entityId)
      .then(rows => { if (!cancelled) setChosen(new Set((rows ?? []).map(r => r.tag_id ?? r.id))); })
      /* A failed read must not look like "this has no tags" — that reads as a fact, and would be
         saved back as one, wiping whatever is really there. */
      .catch(e => { if (!cancelled) setErr(`Could not read its tags: ${e.message}`); });
    return () => { cancelled = true; };
  }, [entityId, fetchTags]);

  const toggle = (id) => setChosen(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  async function save() {
    setBusy(true); setErr(null);
    try {
      await saveTags(entityId, [...chosen]);
      setNote(`Saved ${chosen.size} tag${chosen.size === 1 ? '' : 's'}.`);
      onSaved?.();
      onClose?.();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function suggest() {
    setSuggesting(true); setErr(null); setNote(null);
    try {
      const rows = await suggestTags(entityId);
      const got  = new Set((rows ?? []).map(r => r.tag_id ?? r.id));
      /* ⚠️ UNION, NEVER REPLACE, AND THAT IS THE REQUIREMENT NOT A NICETY. Sandeep: *"if i already
         type some tags, it should not override them."* Two ways that could break and this closes
         both. Server-side the upsert is `ignoreDuplicates`, so the model can only ADD — but it
         answers against what is SAVED, and anything ticked here and not yet saved is invisible to
         it. Taking the response as the new truth would therefore quietly discard exactly the tags
         somebody just chose by hand. So the two sets are merged and nothing is ever removed by
         asking. */
      const added = [...got].filter(id => !chosen.has(id)).length;
      setChosen(prev => new Set([...prev, ...got]));
      setNote(added
        ? `Added ${added} suggested tag${added === 1 ? '' : 's'} — nothing was removed. Save to keep them.`
        : 'Nothing new to suggest — your tags are unchanged.');
    } catch (e) { setErr(e.message); }
    finally { setSuggesting(false); }
  }

  if (err && !chosen) return <div style={{ ...HINT, color: '#C0392B' }}>{err}</div>;
  if (!chosen)        return <div style={HINT}>Reading its tags…</div>;

  return (
    <div style={{ marginTop: 10, padding: 12, background: '#F4F8F5', borderRadius: 10 }}>
      <TagChipPicker allTags={allTags} chosen={chosen} onToggle={toggle} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
        <button type="button" style={BTN('primary', busy)} onClick={save} disabled={busy}>
          {busy ? 'Saving…' : `Save ${chosen.size} tag${chosen.size === 1 ? '' : 's'}`}
        </button>
        {suggestTags && (
          <button type="button" style={BTN('secondary', suggesting)} onClick={suggest} disabled={suggesting}>
            {suggesting ? 'Asking…' : 'Suggest tags'}
          </button>
        )}
        {onClose && (
          <button type="button" style={BTN('secondary', busy)} onClick={onClose} disabled={busy}>Cancel</button>
        )}
        <span style={HINT}>Saving replaces every tag on this {noun}.</span>
        {note && <span style={{ ...HINT, color: '#2C4433', fontWeight: 700 }}>{note}</span>}
        {err  && <span style={{ ...HINT, color: '#C0392B' }}>{err}</span>}
      </div>
    </div>
  );
}
