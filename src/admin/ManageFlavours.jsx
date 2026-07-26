import { useState, useEffect } from 'react';
import { fetchDietaryRequirements, fetchFlavourDietaryConflicts, updateFlavourDietaryConflicts } from '../lib/api.js';

export default function ManageFlavours({ supabase }) {
  const [flavours, setFlavours]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [msg, setMsg]             = useState(null);
  const [editingId, setEditingId] = useState(null);

  const [form, setForm] = useState({ name: '', description: '' });

  // ── The global dietary baseline ─────────────────────────────────────────────
  // What a flavour cannot be made as, for EVERY baker. Authored here so it is stated
  // once instead of 25,000 times — "hazelnut praline is not nut-free" is a fact about
  // the flavour, not about anyone's kitchen. Whether a given baker does an eggless
  // version of their tiramisu is theirs to say, in their own settings, and their answer
  // always wins over this one.
  //
  // Via the API (not the direct supabase client the rest of this screen still uses),
  // because it is authored master data and the resolution rule lives server-side.
  const [diet,     setDiet]     = useState([]);
  const [baseline, setBaseline] = useState({});   // { [flavourId]: ['nut_free', ...] }
  const [busyKey,  setBusyKey]  = useState(null); // `${flavourId}|${key}` while in flight

  useEffect(() => {
    fetchDietaryRequirements().then(setDiet).catch(() => {});
    fetchFlavourDietaryConflicts().then(setBaseline).catch(() => {});
  }, []);

  // Saved on click, one flavour at a time — no Save button to forget. The chip shows
  // the truth only once the server has accepted it, so a failed write cannot leave the
  // screen claiming a default that was never stored.
  async function toggleBaseline(flavourId, key) {
    const id = `${flavourId}|${key}`;
    if (busyKey) return;
    const current = baseline[flavourId] ?? [];
    const next = current.includes(key) ? current.filter(k => k !== key) : [...current, key];
    setBusyKey(id); setMsg(null);
    try {
      await updateFlavourDietaryConflicts(flavourId, next);
      setBaseline(b => ({ ...b, [flavourId]: next }));
    } catch (e) {
      setMsg(e.message || 'Could not save that.');
    } finally {
      setBusyKey(null);
    }
  }

  function toTitleCase(str) {
    return str.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  }

  function setField(key, val) {
    setForm(f => ({ ...f, [key]: key === 'name' ? toTitleCase(val) : val }));
  }

  useEffect(() => { loadFlavours(); }, []);

  async function loadFlavours() {
    setLoading(true);
    const { data, error } = await supabase
      .from('flavours')
      .select('id, name, description, sort_order, is_active')
      .order('sort_order')
      .order('name');
    if (!error) setFlavours(data ?? []);
    setLoading(false);
  }

  function startEdit(f) {
    setEditingId(f.id);
    setForm({ name: toTitleCase(f.name), description: f.description ?? '' });
    setMsg(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm({ name: '', description: '' });
    setMsg(null);
  }

  async function handleSave() {
    if (!form.name.trim()) { setMsg({ ok: false, text: 'Name is required.' }); return; }
    setSaving(true);
    setMsg(null);

    if (editingId) {
      const { error } = await supabase
        .from('flavours')
        .update({ name: form.name.trim(), description: form.description.trim() || null })
        .eq('id', editingId);
      setSaving(false);
      if (error) { setMsg({ ok: false, text: error.message }); return; }
      setMsg({ ok: true, text: 'Flavour updated.' });
      setEditingId(null);
      setForm({ name: '', description: '' });
    } else {
      const { error } = await supabase
        .from('flavours')
        .insert({ name: form.name.trim(), description: form.description.trim() || null });
      setSaving(false);
      if (error) { setMsg({ ok: false, text: error.message }); return; }
      setMsg({ ok: true, text: 'Flavour added.' });
      setForm({ name: '', description: '' });
    }

    await loadFlavours();
    setTimeout(() => setMsg(null), 2500);
  }

  async function toggleActive(f) {
    await supabase.from('flavours').update({ is_active: !f.is_active }).eq('id', f.id);
    await loadFlavours();
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this flavour?')) return;
    await supabase.from('flavours').delete().eq('id', id);
    if (editingId === id) cancelEdit();
    await loadFlavours();
  }

  const isEditing = !!editingId;
  const canSave   = form.name.trim() && !saving;

  return (
    <div style={s.page}>
      <div style={{ width: '100%', maxWidth: 640 }}>
        <h1 style={s.title}>Cake Flavours</h1>

        {/* ── Add / Edit form ── */}
        <div style={s.card}>
          <div style={s.cardTitle}>{isEditing ? 'Edit Flavour' : 'Add Flavour'}</div>

          <div style={s.field}>
            <label style={s.label}>Name *</label>
            <input
              style={s.input}
              placeholder="e.g. Chocolate Truffle"
              value={form.name}
              onChange={e => setField('name', e.target.value)}
              autoFocus
            />
          </div>

          <div style={s.field}>
            <label style={s.label}>Description</label>
            <textarea
              style={{ ...s.input, resize: 'vertical', minHeight: 72 }}
              placeholder="Optional — rich dark chocolate with truffle cream…"
              value={form.description}
              onChange={e => setField('description', e.target.value)}
            />
          </div>

          {msg && (
            <div style={{ fontSize: 13, fontWeight: 700, color: msg.ok ? '#2C7A4B' : '#C0392B', marginBottom: 12 }}>
              {msg.text}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              style={{ ...s.btn, opacity: canSave ? 1 : 0.5 }}
              disabled={!canSave}
              onClick={handleSave}
            >
              {saving ? 'Saving…' : isEditing ? 'Update Flavour' : 'Add Flavour'}
            </button>
            {isEditing && (
              <button style={s.cancelBtn} onClick={cancelEdit}>Cancel</button>
            )}
          </div>
        </div>

        {/* ── Flavours list ── */}
        <div style={{ marginTop: 24 }}>
          {loading && <div style={s.empty}>Loading…</div>}
          {!loading && flavours.length === 0 && (
            <div style={s.empty}>No flavours yet. Add one above.</div>
          )}
          {flavours.map(f => (
            <div key={f.id} style={{ ...s.row, opacity: f.is_active ? 1 : 0.45, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={s.rowName}>{f.name}</div>
                {f.description && <div style={s.rowDesc}>{f.description}</div>}
              </div>
              <div style={s.rowActions}>
                <button style={s.actionBtn} onClick={() => startEdit(f)} title="Edit">Edit</button>
                <button
                  style={{ ...s.actionBtn, color: f.is_active ? '#6B8C74' : '#9BB5A2' }}
                  onClick={() => toggleActive(f)}
                  title={f.is_active ? 'Deactivate' : 'Activate'}
                >
                  {f.is_active ? 'Active' : 'Inactive'}
                </button>
                <button style={{ ...s.actionBtn, color: '#C0392B' }} onClick={() => handleDelete(f.id)} title="Delete">Delete</button>
              </div>

              {/* Worded as a DEFAULT, not a verdict — a baker can overturn any of these,
                  and the label has to say so or an admin will read it as a ruling. */}
              {diet.length > 0 && (
                <div style={s.dietRow}>
                  <span style={s.dietLabel}>USUALLY CAN'T BE MADE</span>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {diet.map(d => {
                      const on   = (baseline[f.id] ?? []).includes(d.key);
                      const busy = busyKey === `${f.id}|${d.key}`;
                      return (
                        <button
                          key={d.key}
                          type="button"
                          onClick={() => toggleBaseline(f.id, d.key)}
                          disabled={!!busyKey}
                          style={{ ...s.dietChip, ...(on ? s.dietChipOn : null), opacity: busy ? 0.5 : 1 }}
                          title={`Default for every baker — each can override "${d.label}" for ${f.name}`}
                        >
                          {d.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const s = {
  page: {
    minHeight: '100vh', background: '#EDEAE2',
    fontFamily: "'Quicksand', sans-serif",
    padding: '40px 24px', display: 'flex', justifyContent: 'center',
  },
  title: { fontSize: 22, fontWeight: 800, color: '#2C4433', marginBottom: 24, margin: '0 0 24px' },
  card: {
    background: '#fff', borderRadius: 16,
    border: '1.5px solid #C5D4C8', padding: '24px 28px',
  },
  cardTitle: { fontSize: 14, fontWeight: 800, color: '#2C4433', marginBottom: 20, letterSpacing: 0.3 },
  dietRow:   { width: '100%', display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' },
  dietLabel: { fontSize: 9, fontWeight: 800, color: '#9BB5A2', letterSpacing: 0.6, flexShrink: 0 },
  dietChip: {
    padding: '4px 10px', borderRadius: 9, cursor: 'pointer',
    border: '1.5px solid #C5D4C8', background: 'transparent',
    fontSize: 11, fontWeight: 700, color: '#6B8C74', fontFamily: 'inherit',
  },
  dietChipOn: { borderColor: '#2C4433', background: '#EDF3EE', color: '#2C4433' },
  field:  { marginBottom: 16 },
  label: {
    display: 'block', fontSize: 11, fontWeight: 700,
    color: '#3D5A44', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6,
  },
  input: {
    width: '100%', padding: '9px 12px',
    border: '1.5px solid #C5D4C8', borderRadius: 8,
    fontSize: 13, fontFamily: "'Quicksand', sans-serif", color: '#2C4433',
    outline: 'none', boxSizing: 'border-box',
  },
  btn: {
    background: '#2C4433', color: '#fff', border: 'none',
    borderRadius: 8, padding: '10px 20px',
    fontSize: 13, fontWeight: 700, cursor: 'pointer',
    fontFamily: "'Quicksand', sans-serif",
  },
  cancelBtn: {
    background: '#fff', color: '#6B8C74',
    border: '1.5px solid #C5D4C8', borderRadius: 8,
    padding: '10px 20px', fontSize: 13, fontWeight: 700,
    cursor: 'pointer', fontFamily: "'Quicksand', sans-serif",
  },
  row: {
    background: '#fff', borderRadius: 12,
    border: '1.5px solid #C5D4C8',
    padding: '14px 16px', marginBottom: 8,
    display: 'flex', alignItems: 'center', gap: 12,
  },
  rowName: { fontSize: 14, fontWeight: 700, color: '#2C4433' },
  rowDesc: { fontSize: 12, color: '#6B8C74', marginTop: 2 },
  rowActions: { display: 'flex', gap: 8, flexShrink: 0 },
  actionBtn: {
    background: 'none', border: '1px solid #C5D4C8', borderRadius: 6,
    padding: '5px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
    color: '#3D5A44', fontFamily: "'Quicksand', sans-serif",
  },
  empty: { fontSize: 13, color: '#9BB5A2', textAlign: 'center', padding: '32px 0' },
};
