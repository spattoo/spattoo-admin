import { useState, useEffect, useMemo } from 'react';
import { CREAM_STYLES, STYLE_ORDER } from '@spattoo/designer';
import { fetchAdminTextures, fetchAdminMaterials, updateMaterial } from '../lib/api.js';

// ── Material → Styles editor (admin master-data) ───────────────────────────────
//
// The material (frosting type) is the PARENT and owns an ORDERED list of the styles it offers — a
// direct lookup, never a scan of all styles (scales to many styles: only a material's own listed keys
// are resolved). `smooth` is the implicit, always-first default for every material, so it is never
// stored; an empty list = "smooth only" (fondant today).
//
// Persisted to the `materials` table (config.styles) via /api/admin/materials. The designer overlays
// these rows onto the in-code frostings seed (applyMaterialConfig), same seed-in-code + DB-overlay
// pattern as cake_textures.

export default function MaterialStyles() {
  const [materials, setMaterials] = useState(null);   // [{ id, key, label, styles:[...] }]
  const [dbTextures, setDbTextures] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function load() {
    const [mats, texs] = await Promise.all([
      fetchAdminMaterials().catch(() => []),
      fetchAdminTextures().catch(() => []),
    ]);
    setDbTextures(texs ?? []);
    setMaterials((mats ?? []).map(m => ({
      id: m.id, key: m.key, label: m.label,
      styles: Array.isArray(m.config?.styles) ? m.config.styles : [],
    })));
  }
  useEffect(() => { load(); }, []);

  // Assignable style catalog = code seeds + DB textures + local prototypes, deduped by key, smooth
  // excluded (it's the implicit default). { key → label }.
  const catalog = useMemo(() => {
    const byKey = new Map();
    for (const k of STYLE_ORDER) if (k !== 'smooth') byKey.set(k, CREAM_STYLES[k]?.label ?? k);
    for (const r of dbTextures) if (r.key && r.key !== 'smooth') byKey.set(r.key, r.label ?? r.key);
    return byKey;
  }, [dbTextures]);
  const labelFor = (key) => catalog.get(key) ?? key;

  if (!materials) return <div style={s.wrap}><div style={s.hint}>Loading…</div></div>;

  if (materials.length === 0) return (
    <div style={s.wrap}>
      <div style={s.title}>Material → Styles</div>
      <div style={s.warn}>No materials found. Apply <code>spattoo-api/migrations/materials.sql</code> to seed the table, then reload.</div>
    </div>
  );

  const patch = (key, mut) => setMaterials(ms => ms.map(m => m.key === key ? mut(m) : m));
  const move = (key, i, dir) => patch(key, m => {
    const list = [...m.styles]; const j = i + dir;
    if (j < 0 || j >= list.length) return m;
    [list[i], list[j]] = [list[j], list[i]];
    return { ...m, styles: list };
  });
  const remove = (key, sk) => patch(key, m => ({ ...m, styles: m.styles.filter(x => x !== sk) }));
  const add = (key, sk) => patch(key, m => sk && !m.styles.includes(sk) ? { ...m, styles: [...m.styles, sk] } : m);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      // PATCH each material's style list. Small closed set — a handful of rows.
      for (const m of materials) {
        await updateMaterial(m.id, { config: { styles: m.styles } });
      }
      await load();
      setMsg({ ok: true, text: 'Saved to materials table.' });
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <div style={s.title}>Material → Styles</div>
        <div style={s.sub}>Each material owns an ordered list of the styles it offers. <b>Smooth</b> is always available and first. Empty list = smooth only.</div>
      </div>

      <div style={s.grid}>
        {materials.map(({ key: mat, label, styles: list }) => {
          const available = [...catalog.keys()].filter(k => !list.includes(k));
          return (
            <div key={mat} style={s.card}>
              <div style={s.cardTitle}>{label} <span style={s.code}>{mat}</span></div>

              <div style={s.lockRow}>
                <span style={s.lockChip}>Smooth</span>
                <span style={s.lockNote}>always available · first</span>
              </div>

              {list.length === 0 && <div style={s.empty}>No extra styles — smooth only.</div>}

              {list.map((sk, i) => (
                <div key={sk} style={s.row}>
                  <span style={s.order}>{i + 2}</span>
                  <span style={s.rowLabel}>{labelFor(sk)} <span style={s.code}>{sk}</span></span>
                  <div style={s.rowBtns}>
                    <button style={s.iconBtn} disabled={i === 0} onClick={() => move(mat, i, -1)}>↑</button>
                    <button style={s.iconBtn} disabled={i === list.length - 1} onClick={() => move(mat, i, 1)}>↓</button>
                    <button style={s.removeBtn} onClick={() => remove(mat, sk)}>✕</button>
                  </div>
                </div>
              ))}

              {available.length > 0 && (
                <select style={s.addSel} value="" onChange={e => { add(mat, e.target.value); e.target.value = ''; }}>
                  <option value="">+ add style…</option>
                  {available.map(k => <option key={k} value={k}>{labelFor(k)}</option>)}
                </select>
              )}
            </div>
          );
        })}
      </div>

      <div style={s.actions}>
        <button style={s.saveBtn(busy)} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save mapping'}</button>
        {msg && <span style={{ ...s.msg, color: msg.ok ? '#3D5A44' : '#b23' }}>{msg.text}</span>}
      </div>
    </div>
  );
}

const s = {
  wrap: { padding: 24, fontFamily: "'Quicksand', sans-serif", maxWidth: 1100, margin: '0 auto' },
  head: { marginBottom: 20 },
  title: { fontSize: 22, fontWeight: 700, color: '#3D5A44' },
  sub: { fontSize: 13, color: '#6B8C74', marginTop: 6 },
  hint: { fontSize: 13, color: '#999' },
  warn: { marginTop: 16, padding: 14, borderRadius: 10, background: '#FBF4E9', border: '1px solid #E7D9B8', color: '#8a6d3b', fontSize: 14 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 },
  card: { border: '1.5px solid #C5D4C8', borderRadius: 12, padding: 16, background: '#fff' },
  cardTitle: { fontSize: 16, fontWeight: 700, color: '#3D5A44', marginBottom: 12 },
  lockRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  lockChip: { padding: '4px 12px', borderRadius: 16, background: '#EDEAE2', color: '#6B8C74', fontSize: 13, fontWeight: 700 },
  lockNote: { fontSize: 11, color: '#9bb3a1' },
  empty: { fontSize: 12, color: '#9bb3a1', fontStyle: 'italic', margin: '4px 0 8px' },
  row: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid #F0EFE9' },
  order: { width: 22, height: 22, borderRadius: 11, background: '#3D5A44', color: '#fff', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  rowLabel: { flex: 1, fontSize: 14, color: '#3D5A44', fontWeight: 600 },
  code: { fontSize: 11, color: '#aaa', fontFamily: 'monospace', fontWeight: 400 },
  rowBtns: { display: 'flex', gap: 4 },
  iconBtn: { width: 26, height: 26, borderRadius: 6, border: '1px solid #C5D4C8', background: '#fff', color: '#3D5A44', cursor: 'pointer', fontSize: 13 },
  removeBtn: { width: 26, height: 26, borderRadius: 6, border: '1px solid #E7C3C3', background: '#fff', color: '#b23', cursor: 'pointer', fontSize: 12 },
  addSel: { marginTop: 10, width: '100%', padding: '7px 10px', borderRadius: 8, border: '1.5px dashed #C5D4C8', fontSize: 13, fontFamily: 'inherit', color: '#3D5A44', background: '#fff' },
  actions: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 20 },
  saveBtn: (busy) => ({ padding: '10px 20px', borderRadius: 10, border: 'none', background: busy ? '#9bb3a1' : '#3D5A44', color: '#fff', fontSize: 14, fontWeight: 700, cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit' }),
  msg: { fontSize: 13, fontWeight: 600 },
};
