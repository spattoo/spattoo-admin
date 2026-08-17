import { useState, useEffect } from 'react';
import { fetchAdminElementCategories, createElementCategory, updateElementCategory } from '../lib/api.js';

// ── Element categories — the customer's decorations menu, in order ─────────────────────────────
//
// Categories can be CREATED from either element form, because that is where you notice one is
// missing. Everything else needs a screen of its own:
//
//   ORDER. sort_order is the order customers see, and a new category always lands at the end. Left
//   alone, the menu becomes a record of the sequence someone happened to add things in. This is the
//   only place it can be changed.
//
//   NAME. What the customer reads. It gets settled after you have seen the decorations in it —
//   "Party & Shapes" was a guess made before anyone looked at what fell into it.
//
//   RETIRE. Hides a category from customers while every element keeps its category_id, so switching
//   it back restores the memberships. There is no delete, deliberately: the FK is ON DELETE SET
//   NULL, so deleting would quietly strip the category off every element it held, with no way back.
//
// The COUNT is why retiring is safe to offer. It answers "how many decorations would this strand?"
// at the moment you are deciding.

const s = {
  wrap:   { padding: 24, maxWidth: 720, margin: '0 auto', fontFamily: "'Quicksand', sans-serif" },
  h1:     { fontSize: 20, fontWeight: 800, margin: '0 0 4px', color: '#2C4433' },
  sub:    { fontSize: 13, color: '#6B8C74', margin: '0 0 20px' },
  row:    (dim) => ({
    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
    border: '1.5px solid #C5D4C8', borderRadius: 10, background: '#fff', marginBottom: 8,
    opacity: dim ? 0.5 : 1,
  }),
  input:  { flex: 1, minWidth: 0, padding: '7px 10px', border: '1.5px solid #C5D4C8', borderRadius: 8,
            fontSize: 13, fontWeight: 700, color: '#2C4433', fontFamily: 'inherit', outline: 'none', background: '#fff' },
  count:  { fontSize: 11, fontWeight: 800, color: '#8aa091', minWidth: 58, textAlign: 'right' },
  arrow:  (off) => ({ width: 26, height: 26, borderRadius: 7, border: '1.5px solid #C5D4C8', background: '#fff',
                      color: off ? '#ccd8ce' : '#3D5A44', fontWeight: 800, fontSize: 13, lineHeight: 1,
                      cursor: off ? 'default' : 'pointer', flexShrink: 0 }),
  btn:    { padding: '9px 16px', borderRadius: 9, border: 'none', background: '#3D5A44', color: '#fff',
            fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' },
  ghost:  { padding: '5px 11px', borderRadius: 7, border: '1.5px solid #C5D4C8', background: '#fff',
            color: '#3D5A44', fontWeight: 700, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 },
  err:    { background: '#FEF3F2', border: '1px solid #FECDCA', color: '#B42318', borderRadius: 10,
            padding: '10px 14px', fontSize: 13, fontWeight: 600, marginBottom: 14 },
  hint:   { fontSize: 12, color: '#8aa091', marginTop: 16, lineHeight: 1.5 },
};

export default function ElementCategories() {
  const [cats, setCats]   = useState([]);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    try { setCats(await fetchAdminElementCategories()); }
    catch (e) { setError(e.message); }
  }

  // Optimistic, then reconciled. The rename field would fight the user otherwise — every keystroke
  // waits on a round trip and the caret jumps.
  function patchLocal(id, fields) {
    setCats(cs => cs.map(c => (c.id === id ? { ...c, ...fields } : c)));
  }

  async function save(id, fields) {
    try { await updateElementCategory(id, fields); }
    catch (e) { setError(e.message); load(); }   // reload so the screen stops showing what did not save
  }

  // Reorder by SWAPPING sort_order with the neighbour, rather than renumbering the list. Two writes
  // instead of eleven, and any gaps the admin left between numbers survive.
  async function move(idx, dir) {
    const a = cats[idx], b = cats[idx + dir];
    if (!a || !b) return;
    setBusy(true);
    const next = [...cats];
    next[idx] = { ...a, sort_order: b.sort_order };
    next[idx + dir] = { ...b, sort_order: a.sort_order };
    next.sort((x, y) => x.sort_order - y.sort_order);
    setCats(next);
    try {
      await Promise.all([
        updateElementCategory(a.id, { sort_order: b.sort_order }),
        updateElementCategory(b.id, { sort_order: a.sort_order }),
      ]);
    } catch (e) { setError(e.message); load(); }
    finally { setBusy(false); }
  }

  async function add() {
    const name = adding.trim();
    if (!name) return;
    setBusy(true);
    try {
      const created = await createElementCategory(name);
      setCats(cs => [...cs, { ...created, count: 0 }].sort((a, b) => a.sort_order - b.sort_order));
      setAdding('');
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={s.wrap}>
      <h1 style={s.h1}>Element Categories</h1>
      <p style={s.sub}>
        How customers browse for decorations. This order is the order they see.
      </p>

      {error && <div style={s.err}>{error}</div>}

      {cats.map((c, i) => (
        <div key={c.id} style={s.row(!c.is_active)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <button style={s.arrow(i === 0)} disabled={i === 0 || busy} onClick={() => move(i, -1)} title="Move up">↑</button>
            <button style={s.arrow(i === cats.length - 1)} disabled={i === cats.length - 1 || busy} onClick={() => move(i, 1)} title="Move down">↓</button>
          </div>

          <input
            style={s.input}
            value={c.name}
            onChange={e => patchLocal(c.id, { name: e.target.value })}
            // Saved on blur, not per keystroke — this is a name customers read, and a PATCH per
            // character would write a dozen half-typed versions of it.
            onBlur={e => e.target.value.trim() && save(c.id, { name: e.target.value.trim() })}
            onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
          />

          <div style={s.count}>{c.count} item{c.count === 1 ? '' : 's'}</div>

          <button
            style={s.ghost}
            disabled={busy}
            onClick={() => { patchLocal(c.id, { is_active: !c.is_active }); save(c.id, { is_active: !c.is_active }); }}
            title={c.is_active ? 'Hide from customers — elements keep their category' : 'Show to customers again'}>
            {c.is_active ? 'Retire' : 'Restore'}
          </button>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <input
          style={s.input}
          placeholder="New category name"
          value={adding}
          onChange={e => setAdding(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
        />
        <button style={s.btn} onClick={add} disabled={!adding.trim() || busy}>Add</button>
      </div>

      <p style={s.hint}>
        A new category goes to the end of the menu — move it with the arrows.
        Retiring hides a category from customers but keeps every element in it, so restoring brings
        them all back. Categories cannot be deleted: that would strip the category off the
        decorations it holds, with no way to undo it.
      </p>
    </div>
  );
}
