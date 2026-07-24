import { useState, useEffect, useMemo } from 'react';
import { fetchRbac, setRoleCapabilities, createCapability } from '../lib/api.js';

const CATEGORY_LABELS = { design: 'Design', baker: 'Baker', platform: 'Platform' };
const CATEGORY_ORDER = ['design', 'baker', 'platform'];

export default function RolesCapabilities() {
  const [roles, setRoles]               = useState([]);
  const [capabilities, setCapabilities] = useState([]);
  const [grants, setGrants]             = useState({});   // { roleKey: Set(capKey) } — editable
  const [dirty, setDirty]               = useState(new Set());
  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState(false);
  const [msg, setMsg]                   = useState(null);

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm]       = useState({ resource: '', action: '', label: '', description: '', category: 'baker', is_sensitive: false });

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const { roles, capabilities, matrix } = await fetchRbac();
      setRoles(roles);
      setCapabilities(capabilities);
      const g = {};
      for (const r of roles) g[r.key] = new Set(matrix[r.key] ?? []);
      setGrants(g);
      setDirty(new Set());
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setLoading(false);
    }
  }

  // Capabilities grouped by category, in a stable order.
  const grouped = useMemo(() => {
    const by = {};
    for (const c of capabilities) (by[c.category] ??= []).push(c);
    return CATEGORY_ORDER
      .filter(cat => by[cat]?.length)
      .map(cat => [cat, by[cat]])
      .concat(Object.entries(by).filter(([cat]) => !CATEGORY_ORDER.includes(cat)));
  }, [capabilities]);

  function toggle(roleKey, capKey) {
    setGrants(prev => {
      const set = new Set(prev[roleKey]);
      set.has(capKey) ? set.delete(capKey) : set.add(capKey);
      return { ...prev, [roleKey]: set };
    });
    setDirty(prev => new Set(prev).add(roleKey));
  }

  async function handleSave() {
    setSaving(true);
    setMsg(null);
    try {
      for (const roleKey of dirty) {
        await setRoleCapabilities(roleKey, [...grants[roleKey]]);
      }
      setDirty(new Set());
      setMsg({ ok: true, text: 'Capabilities saved.' });
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleAddCapability(e) {
    e.preventDefault();
    const key = `${form.resource.trim()}:${form.action.trim()}`;
    if (!form.resource.trim() || !form.action.trim() || !form.label.trim()) {
      return setMsg({ ok: false, text: 'Resource, action, and label are required' });
    }
    setSaving(true);
    setMsg(null);
    try {
      await createCapability({
        key,
        label: form.label.trim(),
        description: form.description.trim() || null,
        category: form.category,
        is_sensitive: form.is_sensitive,
      });
      setForm({ resource: '', action: '', label: '', description: '', category: 'baker', is_sensitive: false });
      setShowAdd(false);
      await load();
      setMsg({ ok: true, text: `Capability "${key}" added. Assign it to roles below, then wire requireCapability('${key}') onto its routes.` });
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div style={s.page}>
        <div style={s.header}>
          <div>
            <div style={s.title}>Roles &amp; Capabilities</div>
            <div style={s.subtitle}>Toggle which capabilities each role holds. Enforcement happens server-side.</div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button style={s.secondaryBtn} onClick={() => { setShowAdd(a => !a); setMsg(null); }}>
              {showAdd ? 'Cancel' : '+ Capability'}
            </button>
            <button style={s.saveBtn(saving || dirty.size === 0)} disabled={saving || dirty.size === 0} onClick={handleSave}>
              {saving ? 'Saving…' : dirty.size ? `Save (${dirty.size})` : 'Saved'}
            </button>
          </div>
        </div>

        {msg && <div style={s.msg(msg.ok)}>{msg.text}</div>}

        {showAdd && (
          <div style={s.card}>
            <form onSubmit={handleAddCapability}>
              <div style={s.formRow}>
                <div style={{ flex: 1 }}>
                  <label style={s.label}>Resource *</label>
                  <input style={s.input} value={form.resource} placeholder="e.g. refund"
                    onChange={e => setForm(f => ({ ...f, resource: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') }))} />
                </div>
                <div style={{ alignSelf: 'flex-end', padding: '0 4px 10px', fontWeight: 800, color: '#9BB5A2' }}>:</div>
                <div style={{ flex: 1 }}>
                  <label style={s.label}>Action *</label>
                  <input style={s.input} value={form.action} placeholder="e.g. issue"
                    onChange={e => setForm(f => ({ ...f, action: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') }))} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={s.label}>Category</label>
                  <select style={s.input} value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                    {CATEGORY_ORDER.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>Label *</label>
                <input style={s.input} value={form.label} placeholder="e.g. Issue refunds"
                  onChange={e => setForm(f => ({ ...f, label: e.target.value }))} />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={s.label}>Description</label>
                <input style={s.input} value={form.description} placeholder="What this capability allows"
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: '#2C4433', marginBottom: 16 }}>
                <input type="checkbox" style={{ accentColor: '#3D5A44', width: 16, height: 16 }}
                  checked={form.is_sensitive} onChange={e => setForm(f => ({ ...f, is_sensitive: e.target.checked }))} />
                Sensitive (money / governance — keep super-admin only)
              </label>
              <button type="submit" style={s.saveBtn(saving)} disabled={saving}>Add capability</button>
            </form>
          </div>
        )}

        <div style={s.card}>
          {loading ? (
            <div style={s.empty}>Loading…</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={{ ...s.th, ...s.thCap }}>Capability</th>
                    {roles.map(r => (
                      <th key={r.key} style={s.th} title={r.description}>
                        <div style={s.roleName}>{r.label}</div>
                        {r.is_super && <div style={s.superTag}>all</div>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grouped.map(([cat, caps]) => (
                    <CategoryBlock
                      key={cat}
                      cat={cat}
                      caps={caps}
                      roles={roles}
                      grants={grants}
                      onToggle={toggle}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div style={s.footnote}>
          Super-admin (<b>all</b>) holds every capability — present and future — and can't be edited here.
          Unknown identities get nothing (deny-by-default). Hiding a UI control is cosmetic;
          the real boundary is <code>requireCapability()</code> on each API route.
        </div>
      </div>
    </>
  );
}

function CategoryBlock({ cat, caps, roles, grants, onToggle }) {
  return (
    <>
      <tr>
        <td colSpan={roles.length + 1} style={s.catRow}>{CATEGORY_LABELS[cat] ?? cat}</td>
      </tr>
      {caps.map(c => (
        <tr key={c.key}>
          <td style={s.tdCap}>
            <div style={s.capLabel}>
              {c.label}
              {c.is_sensitive && <span style={s.sensitive}>sensitive</span>}
            </div>
            <div style={s.capKey}>{c.key}</div>
            {c.description && <div style={s.capDesc}>{c.description}</div>}
          </td>
          {roles.map(r => {
            const checked = r.is_super || grants[r.key]?.has(c.key);
            return (
              <td key={r.key} style={s.tdCell}>
                <input
                  type="checkbox"
                  checked={!!checked}
                  disabled={r.is_super}
                  onChange={() => onToggle(r.key, c.key)}
                  style={{ accentColor: '#3D5A44', width: 17, height: 17, cursor: r.is_super ? 'not-allowed' : 'pointer', opacity: r.is_super ? 0.5 : 1 }}
                />
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

const s = {
  page:       { minHeight: '100vh', background: '#EDEAE2', fontFamily: 'Quicksand, sans-serif', padding: '32px 24px' },
  header:     { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', maxWidth: 980, margin: '0 auto 20px', gap: 16 },
  title:      { fontSize: 22, fontWeight: 800, color: '#2C4433' },
  subtitle:   { fontSize: 13, fontWeight: 600, color: '#6B8C74', marginTop: 4 },
  card:       { background: '#fff', borderRadius: 18, border: '1.5px solid #C5D4C8', padding: 24, maxWidth: 980, margin: '0 auto 16px' },
  table:      { borderCollapse: 'collapse', width: '100%', minWidth: 720 },
  th:         { padding: '8px 10px', textAlign: 'center', fontSize: 11, fontWeight: 800, color: '#2C4433', borderBottom: '2px solid #E8EFE9', verticalAlign: 'bottom' },
  thCap:      { textAlign: 'left', minWidth: 260, color: '#9BB5A2', textTransform: 'uppercase', letterSpacing: 0.5 },
  roleName:   { fontSize: 12, fontWeight: 800, color: '#2C4433' },
  superTag:   { fontSize: 9, fontWeight: 800, color: '#2C7A4B', background: '#E8F5E9', borderRadius: 8, padding: '1px 6px', marginTop: 3, display: 'inline-block' },
  catRow:     { fontSize: 10, fontWeight: 800, color: '#9BB5A2', textTransform: 'uppercase', letterSpacing: 1, padding: '16px 10px 6px', background: '#FAFCFA' },
  tdCap:      { padding: '10px', borderBottom: '1px solid #EDF0EC', verticalAlign: 'top' },
  capLabel:   { fontSize: 13, fontWeight: 700, color: '#2C4433', display: 'flex', alignItems: 'center', gap: 8 },
  capKey:     { fontSize: 11, fontWeight: 600, color: '#9BB5A2', fontFamily: 'monospace', marginTop: 2 },
  capDesc:    { fontSize: 11, fontWeight: 600, color: '#6B8C74', marginTop: 3, maxWidth: 240 },
  sensitive:  { fontSize: 9, fontWeight: 800, color: '#C0392B', background: '#FFF0F0', borderRadius: 8, padding: '1px 6px' },
  tdCell:     { padding: '10px', borderBottom: '1px solid #EDF0EC', textAlign: 'center' },
  formRow:    { display: 'flex', gap: 10, marginBottom: 14, alignItems: 'flex-start' },
  label:      { fontSize: 11, fontWeight: 700, color: '#4A7459', letterSpacing: 0.3, display: 'block', marginBottom: 5 },
  input:      { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontFamily: 'Quicksand, sans-serif', fontSize: 13, fontWeight: 600, color: '#2C4433', background: '#FAFCFA', boxSizing: 'border-box', outline: 'none' },
  saveBtn:    (disabled) => ({ padding: '10px 22px', borderRadius: 10, border: 'none', background: disabled ? '#9BB5A2' : '#3D5A44', color: '#fff', fontFamily: 'Quicksand, sans-serif', fontSize: 14, fontWeight: 800, cursor: disabled ? 'not-allowed' : 'pointer' }),
  secondaryBtn:{ padding: '10px 18px', borderRadius: 10, border: '1.5px solid #C5D4C8', background: '#fff', color: '#3D5A44', fontFamily: 'Quicksand, sans-serif', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  empty:      { textAlign: 'center', color: '#9BB5A2', fontWeight: 600, padding: '32px 0' },
  msg:        (ok) => ({ padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: ok ? '#E8F5E9' : '#FFF0F0', color: ok ? '#2E7D32' : '#C0392B', maxWidth: 980, margin: '0 auto 16px' }),
  footnote:   { maxWidth: 980, margin: '8px auto 0', fontSize: 12, fontWeight: 600, color: '#6B8C74', lineHeight: 1.6 },
};
