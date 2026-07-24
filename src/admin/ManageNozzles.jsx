import { useState, useEffect } from 'react';
import { fetchNozzles, createNozzle, updateNozzle, deleteNozzle, bulkCreateNozzles } from '../lib/api.js';

// Parse pasted bulk rows. One nozzle per line, fields split by TAB or `|`:
//   brand | number | name | category | common(y/n) | description
// Lines that are blank or start with # are ignored. Returns parsed rows with a
// per-row `_error` string when invalid (so the preview can flag them).
function parseBulkRows(text, validCategories) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  return lines.map(line => {
    const delim = line.includes('\t') ? '\t' : '|';
    const parts = line.split(delim).map(p => p.trim());
    const [brand, number, name, category, common, ...rest] = parts;
    const description = rest.join(delim).trim();
    const is_common = /^(y|yes|true|1|★|common)$/i.test(common ?? '');

    let _error = null;
    if (!brand) _error = 'missing brand';
    else if (!number) _error = 'missing number';
    else if (!category) _error = 'missing category';
    else if (!validCategories.includes(category)) _error = `unknown category "${category}"`;

    return { brand, number, name: name || '', category, is_common, description, _error };
  });
}

// Categories mirror the nozzles.category values seeded server-side. The label
// map keeps the UI readable without changing the stored slugs.
const CATEGORIES = [
  'open_star', 'closed_star', 'round', 'writing', 'petal', 'leaf',
  'drop_flower', 'french', 'basketweave', 'grass', 'specialty', 'ruffle',
];
const CAT_LABEL = {
  open_star: 'Open Star', closed_star: 'Closed Star', round: 'Round', writing: 'Writing',
  petal: 'Petal', leaf: 'Leaf', drop_flower: 'Drop Flower', french: 'French',
  basketweave: 'Basketweave', grass: 'Grass', specialty: 'Specialty', ruffle: 'Ruffle',
};
const BRAND_SUGGESTIONS = ['Wilton', 'Ateco', 'PME', 'JEM', 'Loyal', 'Generic'];

const s = {
  page:  { minHeight: '100vh', background: '#EDEAE2', fontFamily: "'Quicksand', sans-serif", padding: '40px 32px' },
  title: { fontSize: 20, fontWeight: 800, color: '#2C4433', marginBottom: 28 },
  layout:{ display: 'flex', gap: 24, alignItems: 'flex-start' },

  card:  { background: '#fff', borderRadius: 16, border: '1.5px solid #C5D4C8', overflow: 'hidden', flex: 1 },
  table: { width: '100%', borderCollapse: 'collapse' },
  th:    { textAlign: 'left', padding: '10px 16px', fontSize: 10, fontWeight: 800, color: '#9BB5A2', letterSpacing: 1.2, textTransform: 'uppercase', background: '#F4F8F5', borderBottom: '1px solid #C5D4C8' },
  td:    { padding: '10px 16px', fontSize: 12, color: '#2C4433', borderBottom: '1px solid #EEF0EC', verticalAlign: 'middle' },
  catBadge: { display: 'inline-block', padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700, letterSpacing: 0.3, background: '#EAF1F4', color: '#3A5563' },
  brandTag: { display: 'inline-block', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 800, background: '#F4F8F5', color: '#3D5A44', border: '1px solid #C5D4C8' },

  form:  { width: 320, flexShrink: 0, background: '#fff', borderRadius: 16, border: '1.5px solid #C5D4C8', padding: 24 },
  formTitle: { fontSize: 14, fontWeight: 800, color: '#2C4433', marginBottom: 20 },
  field: { marginBottom: 16 },
  label: { display: 'block', fontSize: 11, fontWeight: 700, color: '#3D5A44', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 5 },
  input: { width: '100%', padding: '8px 10px', border: '1.5px solid #C5D4C8', borderRadius: 8, fontSize: 13, fontFamily: "'Quicksand', sans-serif", color: '#2C4433', outline: 'none', boxSizing: 'border-box' },
  select:{ width: '100%', padding: '8px 10px', border: '1.5px solid #C5D4C8', borderRadius: 8, fontSize: 13, fontFamily: "'Quicksand', sans-serif", color: '#2C4433', background: '#fff', outline: 'none', boxSizing: 'border-box' },
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

const EMPTY = { brand: 'Wilton', number: '', name: '', category: 'open_star', description: '', is_common: false, sort_order: 0, is_active: true };

export default function ManageNozzles() {
  const [nozzles,   setNozzles]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [form,      setForm]      = useState(EMPTY);
  const [editingId, setEditingId] = useState(null);
  const [saving,    setSaving]    = useState(false);
  const [msg,       setMsg]       = useState(null);
  const [filter,    setFilter]    = useState('all');

  // Bulk paste importer
  const [bulkOpen,   setBulkOpen]   = useState(false);
  const [bulkText,   setBulkText]   = useState('');
  const [bulkBusy,   setBulkBusy]   = useState(false);
  const [bulkResult, setBulkResult] = useState(null);

  const parsed = bulkText.trim() ? parseBulkRows(bulkText, CATEGORIES) : [];
  const parsedValid = parsed.filter(r => !r._error);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try { setNozzles(await fetchNozzles()); }
    catch (err) { console.error(err); }
    finally { setLoading(false); }
  }

  function startEdit(n) {
    setEditingId(n.id);
    setForm({
      brand: n.brand, number: n.number, name: n.name ?? '', category: n.category,
      description: n.description ?? '', is_common: n.is_common ?? false,
      sort_order: n.sort_order ?? 0, is_active: n.is_active ?? true,
    });
    setMsg(null);
  }

  function startNew() {
    setEditingId(null);
    setForm(EMPTY);
    setMsg(null);
  }

  async function handleSave() {
    if (!form.brand.trim() || !form.number.trim()) {
      setMsg({ ok: false, text: 'Brand and number are required.' });
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      if (editingId) {
        await updateNozzle(editingId, form);
        setMsg({ ok: true, text: 'Nozzle updated.' });
      } else {
        await createNozzle(form);
        setMsg({ ok: true, text: 'Nozzle created.' });
        setForm(f => ({ ...EMPTY, brand: f.brand, category: f.category })); // keep brand/category for fast entry
      }
      await load();
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(n) {
    if (!confirm(`Delete ${n.brand} ${n.number}?`)) return;
    try {
      await deleteNozzle(n.id);
      await load();
      if (editingId === n.id) startNew();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleBulkImport() {
    if (parsedValid.length === 0) return;
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const payload = parsedValid.map(({ _error, ...row }) => row); // strip _error
      const res = await bulkCreateNozzles(payload);
      setBulkResult({ ok: true, ...res });
      await load();
      if (res.created > 0) setBulkText('');
    } catch (err) {
      setBulkResult({ ok: false, error: err.message });
    } finally {
      setBulkBusy(false);
    }
  }

  const displayed = filter === 'all' ? nozzles : nozzles.filter(n => n.category === filter);

  return (
    <>
      <div style={s.page}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
          <div style={{ ...s.title, marginBottom: 0 }}>Nozzle Catalog</div>
          <button style={s.btn(bulkOpen ? 'secondary' : 'primary')} onClick={() => { setBulkOpen(o => !o); setBulkResult(null); }}>
            {bulkOpen ? 'Close bulk add' : 'Bulk add'}
          </button>
        </div>

        {bulkOpen && (
          <div style={{ background: '#fff', borderRadius: 16, border: '1.5px solid #C5D4C8', padding: 24, marginBottom: 24 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: '#2C4433', marginBottom: 6 }}>Bulk add nozzles</div>
            <div style={{ fontSize: 12, color: '#6B8C74', lineHeight: 1.6, marginBottom: 6 }}>
              One nozzle per line. Fields separated by <b>Tab</b> or <code style={{ background: '#F4F8F5', padding: '1px 5px', borderRadius: 4 }}>|</code> — paste straight from a spreadsheet (Tab) or type with pipes:
              <br />
              <code style={{ fontSize: 11, color: '#3A5563' }}>brand | number | name | category | common (y/n) | description</code>
              <br />
              Blank lines and lines starting with <code>#</code> are ignored. Duplicates (same brand + number) are skipped, not errored.
            </div>
            <div style={{ fontSize: 11, color: '#9BB5A2', marginBottom: 10 }}>
              Valid categories: {CATEGORIES.join(', ')}
            </div>

            <textarea
              value={bulkText}
              onChange={e => setBulkText(e.target.value)}
              spellCheck={false}
              rows={8}
              placeholder={'Wilton | 1M | Open Star | open_star | y | rosette swirls, cupcakes, shells\nAteco | 869 | French Star | french | n | large fine-toothed ribbed swirls'}
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, borderRadius: 8, border: '1.5px solid #C5D4C8', padding: '10px 12px', boxSizing: 'border-box', lineHeight: 1.6, color: '#2C4433', resize: 'vertical' }}
            />

            {parsed.length > 0 && (
              <div style={{ marginTop: 12, border: '1px solid #EEF0EC', borderRadius: 10, overflow: 'hidden', maxHeight: 260, overflowY: 'auto' }}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>#</th><th style={s.th}>Brand</th><th style={s.th}>No.</th>
                      <th style={s.th}>Name</th><th style={s.th}>Category</th><th style={s.th}>Common</th><th style={s.th}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.map((r, i) => (
                      <tr key={i} style={{ background: r._error ? '#FDF3F1' : undefined }}>
                        <td style={{ ...s.td, color: '#9BB5A2' }}>{i + 1}</td>
                        <td style={s.td}>{r.brand}</td>
                        <td style={{ ...s.td, fontWeight: 700 }}>{r.number}</td>
                        <td style={s.td}>{r.name}</td>
                        <td style={s.td}>{r.category}</td>
                        <td style={s.td}>{r.is_common ? '★' : ''}</td>
                        <td style={{ ...s.td, fontWeight: 700, color: r._error ? '#c62828' : '#3D5A44' }}>
                          {r._error ? r._error : 'ok'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
              <button
                style={{ ...s.btn('primary'), opacity: (bulkBusy || parsedValid.length === 0) ? 0.5 : 1 }}
                onClick={handleBulkImport}
                disabled={bulkBusy || parsedValid.length === 0}
              >
                {bulkBusy ? 'Importing…' : `Import ${parsedValid.length} nozzle${parsedValid.length === 1 ? '' : 's'}`}
              </button>
              {parsed.length > 0 && (
                <span style={{ fontSize: 12, color: '#9BB5A2' }}>
                  {parsedValid.length} valid · {parsed.length - parsedValid.length} with errors
                </span>
              )}
              {bulkResult && (
                <span style={{ fontSize: 12, fontWeight: 700, color: bulkResult.ok ? '#3D5A44' : '#c62828' }}>
                  {bulkResult.ok
                    ? `Created ${bulkResult.created}, skipped ${bulkResult.skipped} duplicate${bulkResult.skipped === 1 ? '' : 's'}${bulkResult.errors?.length ? `, ${bulkResult.errors.length} rejected` : ''}.`
                    : bulkResult.error}
                </span>
              )}
            </div>
          </div>
        )}

        <div style={s.layout}>

          {/* ── Table ── */}
          <div style={s.card}>
            <div style={{ display: 'flex', gap: 6, padding: '12px 16px', borderBottom: '1px solid #C5D4C8', flexWrap: 'wrap' }}>
              {['all', ...CATEGORIES].map(cat => (
                <button key={cat} onClick={() => setFilter(cat)} style={{
                  padding: '4px 12px', borderRadius: 20, border: 'none', cursor: 'pointer',
                  fontSize: 11, fontWeight: 700, fontFamily: "'Quicksand', sans-serif",
                  background: filter === cat ? '#3D5A44' : '#EEF0EC',
                  color:      filter === cat ? '#fff'    : '#2C4433',
                }}>
                  {cat === 'all' ? 'All' : CAT_LABEL[cat] ?? cat}
                </button>
              ))}
            </div>

            {loading ? (
              <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: '#9BB5A2' }}>Loading…</div>
            ) : (
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>Brand</th>
                    <th style={s.th}>No.</th>
                    <th style={s.th}>Name</th>
                    <th style={s.th}>Category</th>
                    <th style={s.th}>Description</th>
                    <th style={s.th}></th>
                  </tr>
                </thead>
                <tbody>
                  {displayed.map(n => (
                    <tr key={n.id} style={{ background: editingId === n.id ? '#F4F8F5' : (n.is_active ? undefined : '#FBF7F4'), opacity: n.is_active ? 1 : 0.6 }}>
                      <td style={s.td}><span style={s.brandTag}>{n.brand}</span></td>
                      <td style={{ ...s.td, fontWeight: 800 }}>
                        {n.is_common && <span title="Common go-to tip" style={{ color: '#E8A33D', marginRight: 4 }}>★</span>}
                        {n.number}
                      </td>
                      <td style={s.td}>{n.name}</td>
                      <td style={s.td}><span style={s.catBadge}>{CAT_LABEL[n.category] ?? n.category}</span></td>
                      <td style={{ ...s.td, color: '#6B8C74', maxWidth: 320 }}>{n.description}</td>
                      <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                        <button style={s.editBtn} onClick={() => startEdit(n)}>Edit</button>
                        <button style={s.delBtn}  onClick={() => handleDelete(n)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                  {displayed.length === 0 && (
                    <tr><td colSpan={6} style={{ ...s.td, textAlign: 'center', color: '#9BB5A2' }}>No nozzles</td></tr>
                  )}
                </tbody>
              </table>
            )}
          </div>

          {/* ── Form ── */}
          <div style={s.form}>
            <div style={s.formTitle}>{editingId ? 'Edit Nozzle' : 'New Nozzle'}</div>

            <div style={s.field}>
              <label style={s.label}>Brand</label>
              <input list="nozzle-brand-list" style={s.input} value={form.brand}
                onChange={e => setForm(f => ({ ...f, brand: e.target.value }))} placeholder="e.g. Wilton" />
              <datalist id="nozzle-brand-list">
                {BRAND_SUGGESTIONS.map(b => <option key={b} value={b} />)}
              </datalist>
            </div>

            <div style={s.field}>
              <label style={s.label}>Number</label>
              <input style={s.input} value={form.number}
                onChange={e => setForm(f => ({ ...f, number: e.target.value }))} placeholder="e.g. 1M" />
            </div>

            <div style={s.field}>
              <label style={s.label}>Name</label>
              <input style={s.input} value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Open Star" />
            </div>

            <div style={s.field}>
              <label style={s.label}>Category</label>
              <select style={s.select} value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                {CATEGORIES.map(c => <option key={c} value={c}>{CAT_LABEL[c] ?? c}</option>)}
              </select>
            </div>

            <div style={s.field}>
              <label style={s.label}>Description</label>
              <textarea style={{ ...s.input, resize: 'vertical', lineHeight: 1.5 }} rows={3}
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="What it produces / typical use — also feeds the GPT suggester." />
            </div>

            <div style={s.field}>
              <label style={s.label}>Sort Order</label>
              <input type="number" style={s.input} value={form.sort_order}
                onChange={e => setForm(f => ({ ...f, sort_order: parseInt(e.target.value) || 0 }))} />
            </div>

            <div style={s.field}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" style={{ width: 16, height: 16, accentColor: '#E8A33D', cursor: 'pointer' }}
                  checked={form.is_common}
                  onChange={e => setForm(f => ({ ...f, is_common: e.target.checked }))} />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#2C4433' }}>Common (go-to tip)</span>
              </label>
              <div style={{ fontSize: 11, color: '#9BB5A2', marginTop: 4, paddingLeft: 24 }}>
                Featured first, and preferred by the GPT suggester over obscure equivalents.
              </div>
            </div>

            <div style={{ ...s.field, marginBottom: 20 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" style={{ width: 16, height: 16, accentColor: '#3D5A44', cursor: 'pointer' }}
                  checked={form.is_active}
                  onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#2C4433' }}>Active</span>
              </label>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button style={s.btn('primary')} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : editingId ? 'Update' : 'Create'}
              </button>
              {editingId && <button style={s.btn('secondary')} onClick={startNew}>Cancel</button>}
            </div>
            {msg && <div style={s.msg(msg.ok)}>{msg.text}</div>}
          </div>
        </div>
      </div>
    </>
  );
}
