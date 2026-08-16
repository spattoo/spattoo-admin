import { useState, useEffect } from 'react';
import { fetchAllTags, createTag, updateTag, deleteTag } from '../lib/api.js';

const CATEGORIES = ['occasion', 'style', 'color', 'material', 'theme', 'age_group', 'gender'];

const s = {
  page:  { minHeight: '100vh', background: '#EDEAE2', fontFamily: "'Quicksand', sans-serif", padding: '40px 32px' },
  title: { fontSize: 20, fontWeight: 800, color: '#2C4433', marginBottom: 28 },
  layout:{ display: 'flex', gap: 24, alignItems: 'flex-start' },

  // Table
  card:  { background: '#fff', borderRadius: 16, border: '1.5px solid #C5D4C8', overflow: 'hidden', flex: 1 },
  table: { width: '100%', borderCollapse: 'collapse' },
  th:    { textAlign: 'left', padding: '10px 16px', fontSize: 10, fontWeight: 800, color: '#9BB5A2', letterSpacing: 1.2, textTransform: 'uppercase', background: '#F4F8F5', borderBottom: '1px solid #C5D4C8' },
  td:    { padding: '10px 16px', fontSize: 12, color: '#2C4433', borderBottom: '1px solid #EEF0EC', verticalAlign: 'middle' },
  badge: (cat) => ({
    display: 'inline-block', padding: '2px 8px', borderRadius: 20,
    fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
    background: CAT_COLORS[cat]?.bg ?? '#eee',
    color:      CAT_COLORS[cat]?.fg ?? '#555',
  }),
  aiDot: (on) => ({
    display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
    background: on ? '#3D5A44' : '#ddd', marginRight: 4,
  }),

  // Form panel
  form:  { width: 300, flexShrink: 0, background: '#fff', borderRadius: 16, border: '1.5px solid #C5D4C8', padding: 24 },
  formTitle: { fontSize: 14, fontWeight: 800, color: '#2C4433', marginBottom: 20 },
  field: { marginBottom: 16 },
  label: { display: 'block', fontSize: 11, fontWeight: 700, color: '#3D5A44', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 5 },
  input: { width: '100%', padding: '8px 10px', border: '1.5px solid #C5D4C8', borderRadius: 8, fontSize: 13, fontFamily: "'Quicksand', sans-serif", color: '#2C4433', outline: 'none', boxSizing: 'border-box' },
  select:{ width: '100%', padding: '8px 10px', border: '1.5px solid #C5D4C8', borderRadius: 8, fontSize: 13, fontFamily: "'Quicksand', sans-serif", color: '#2C4433', background: '#fff', outline: 'none', boxSizing: 'border-box' },
  checkRow: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
  checkbox: { width: 16, height: 16, accentColor: '#3D5A44', cursor: 'pointer' },
  checkLabel: { fontSize: 13, fontWeight: 600, color: '#2C4433' },
  btn:   (v) => ({
    padding: '9px 18px', borderRadius: 8, border: 'none', cursor: 'pointer',
    fontSize: 12, fontWeight: 800, fontFamily: "'Quicksand', sans-serif",
    background: v === 'primary' ? '#3D5A44' : v === 'danger' ? '#c62828' : '#EEF0EC',
    color:      v === 'primary' ? '#fff'     : v === 'danger' ? '#fff'    : '#2C4433',
    marginRight: 8,
  }),
  msg:   (ok) => ({ marginTop: 12, fontSize: 12, fontWeight: 700, color: ok ? '#3D5A44' : '#c62828' }),
  editBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#3D5A44', padding: '2px 6px' },
  delBtn:  { background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#c62828', padding: '2px 6px' },
};

const CAT_COLORS = {
  occasion:  { bg: '#FFF3E0', fg: '#E65100' },
  style:     { bg: '#EDE7F6', fg: '#512DA8' },
  color:     { bg: '#FCE4EC', fg: '#880E4F' },
  material:  { bg: '#E8F5E9', fg: '#2E7D32' },
  theme:     { bg: '#E3F2FD', fg: '#1565C0' },
  age_group: { bg: '#FFF8E1', fg: '#F57F17' },
  gender:    { bg: '#F3E5F5', fg: '#6A1B9A' },
};

const EMPTY = { name: '', slug: '', category: 'occasion', ai_assignable: false, sort_order: 0 };

export default function ManageTags() {
  const [tags,      setTags]      = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [form,      setForm]      = useState(EMPTY);
  const [editingId, setEditingId] = useState(null);
  const [saving,    setSaving]    = useState(false);
  const [msg,       setMsg]       = useState(null);
  const [filter,    setFilter]    = useState('all');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try { setTags(await fetchAllTags()); }
    catch (err) { console.error(err); }
    finally { setLoading(false); }
  }

  function startEdit(tag) {
    setEditingId(tag.id);
    setForm({ name: tag.name, slug: tag.slug, category: tag.category, ai_assignable: tag.ai_assignable, sort_order: tag.sort_order });
    setMsg(null);
  }

  function startNew() {
    setEditingId(null);
    setForm(EMPTY);
    setMsg(null);
  }

  // Auto-generate slug from name
  function handleNameChange(val) {
    const slug = val.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    setForm(f => ({ ...f, name: val, ...(editingId ? {} : { slug }) }));
  }

  async function handleSave() {
    if (!form.name.trim() || !form.slug.trim()) {
      setMsg({ ok: false, text: 'Name and slug are required.' });
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      if (editingId) {
        await updateTag(editingId, form);
        setMsg({ ok: true, text: 'Tag updated.' });
      } else {
        await createTag(form);
        setMsg({ ok: true, text: 'Tag created.' });
        setForm(EMPTY);
        setEditingId(null);
      }
      await load();
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(tag) {
    if (!confirm(`Delete "${tag.name}"? This will fail if the tag is in use.`)) return;
    try {
      await deleteTag(tag.id);
      await load();
      if (editingId === tag.id) { setEditingId(null); setForm(EMPTY); }
    } catch (err) {
      alert(err.message);
    }
  }

  const displayed = filter === 'all' ? tags : tags.filter(t => t.category === filter);

  return (
    <>
      <div style={s.page}>
        <div style={s.title}>Manage Tags</div>
        <div style={s.layout}>

          {/* ── Tag table ── */}
          <div style={s.card}>
            {/* Category filter tabs */}
            <div style={{ display: 'flex', gap: 6, padding: '12px 16px', borderBottom: '1px solid #C5D4C8', flexWrap: 'wrap' }}>
              {['all', ...CATEGORIES].map(cat => (
                <button key={cat} onClick={() => setFilter(cat)} style={{
                  padding: '4px 12px', borderRadius: 20, border: 'none', cursor: 'pointer',
                  fontSize: 11, fontWeight: 700, fontFamily: "'Quicksand', sans-serif",
                  background: filter === cat ? '#3D5A44' : '#EEF0EC',
                  color:      filter === cat ? '#fff'    : '#2C4433',
                }}>
                  {cat === 'all' ? 'All' : cat.replace('_', ' ')}
                </button>
              ))}
            </div>

            {loading ? (
              <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: '#9BB5A2' }}>Loading…</div>
            ) : (
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>Name</th>
                    <th style={s.th}>Slug</th>
                    <th style={s.th}>Category</th>
                    <th style={s.th}>AI</th>
                    <th style={s.th}>Order</th>
                    <th style={s.th}></th>
                  </tr>
                </thead>
                <tbody>
                  {displayed.map(tag => (
                    <tr key={tag.id} style={{ background: editingId === tag.id ? '#F4F8F5' : undefined }}>
                      <td style={s.td}><b>{tag.name}</b></td>
                      <td style={{ ...s.td, fontFamily: 'monospace', fontSize: 11, color: '#6B8C74' }}>{tag.slug}</td>
                      <td style={s.td}><span style={s.badge(tag.category)}>{tag.category.replace('_', ' ')}</span></td>
                      <td style={s.td}>
                        <span style={s.aiDot(tag.ai_assignable)} />
                        {tag.ai_assignable ? 'Auto' : 'Manual'}
                      </td>
                      <td style={s.td}>{tag.sort_order}</td>
                      <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                        <button style={s.editBtn} onClick={() => startEdit(tag)}>Edit</button>
                        <button style={s.delBtn}  onClick={() => handleDelete(tag)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                  {displayed.length === 0 && (
                    <tr><td colSpan={6} style={{ ...s.td, textAlign: 'center', color: '#9BB5A2' }}>No tags</td></tr>
                  )}
                </tbody>
              </table>
            )}
          </div>

          {/* ── Form ── */}
          <div style={s.form}>
            <div style={s.formTitle}>{editingId ? 'Edit Tag' : 'New Tag'}</div>

            <div style={s.field}>
              <label style={s.label}>Name</label>
              <input style={s.input} value={form.name} onChange={e => handleNameChange(e.target.value)} placeholder="e.g. Floral" />
            </div>

            <div style={s.field}>
              <label style={s.label}>Slug</label>
              <input style={s.input} value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value }))} placeholder="e.g. floral" />
            </div>

            <div style={s.field}>
              <label style={s.label}>Category</label>
              <select style={s.select} value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                {CATEGORIES.map(c => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
              </select>
            </div>

            <div style={{ ...s.field, marginBottom: 20 }}>
              <label style={s.checkRow}>
                <input type="checkbox" style={s.checkbox} checked={form.ai_assignable}
                  onChange={e => setForm(f => ({ ...f, ai_assignable: e.target.checked }))} />
                <span style={s.checkLabel}>AI-assignable</span>
              </label>
              <div style={{ fontSize: 11, color: '#9BB5A2', marginTop: 4, paddingLeft: 24 }}>
                GPT-4o Vision will auto-assign this tag at upload time
              </div>
            </div>

            <div style={s.field}>
              <label style={s.label}>Sort Order</label>
              <input type="number" style={s.input} value={form.sort_order}
                onChange={e => setForm(f => ({ ...f, sort_order: parseInt(e.target.value) || 0 }))} />
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button style={s.btn('primary')} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : editingId ? 'Update' : 'Create'}
              </button>
              {editingId && (
                <button style={s.btn('secondary')} onClick={startNew}>Cancel</button>
              )}
            </div>
            {msg && <div style={s.msg(msg.ok)}>{msg.text}</div>}
          </div>
        </div>
      </div>
    </>
  );
}
