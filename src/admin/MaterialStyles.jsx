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

// The decoration-finish (config.surface) editor schema — maps 1:1 to MeshPhysicalMaterial. Kept in sync
// with SURFACE_KEYS in the api and DECOR_MATERIALS in core. sheenColor is edited separately (a colour).
const SURFACE_FIELDS = [
  { k: 'roughness', min: 0, max: 1, step: 0.01 },
  { k: 'metalness', min: 0, max: 1, step: 0.01 },
  { k: 'anisotropy', min: 0, max: 1, step: 0.01 },
  { k: 'anisotropyRotation', min: 0, max: 3.15, step: 0.01 },
  { k: 'sheen', min: 0, max: 1, step: 0.01 },
  { k: 'sheenRoughness', min: 0, max: 1, step: 0.01 },
  { k: 'clearcoat', min: 0, max: 1, step: 0.01 },
  { k: 'clearcoatRoughness', min: 0, max: 1, step: 0.01 },
  { k: 'envMapIntensity', min: 0, max: 2, step: 0.05 },
];
// Seeded when a material is first marked usable on elements — the satin values (a sensible starting finish).
const DEFAULT_SURFACE = {
  roughness: 0.28, metalness: 0, anisotropy: 1, anisotropyRotation: 1.57,
  sheen: 0.35, sheenColor: '#ffffff', sheenRoughness: 0.28, clearcoat: 0.12, clearcoatRoughness: 0.4, envMapIntensity: 0.45,
};

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
      // where the material may be used (body = cake frosting, element = placed decoration); surface = the
      // MeshPhysical finish a decoration wears (only meaningful for element materials).
      applies_to: Array.isArray(m.config?.applies_to) ? m.config.applies_to : ['body'],
      surface: (m.config?.surface && typeof m.config.surface === 'object') ? m.config.surface : null,
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

  // Toggle a usage context; enabling 'element' the first time seeds a default surface so there's something
  // to tune (the seed already renders satin even with an empty surface, but a starting finish is friendlier).
  const toggleContext = (key, ctx) => patch(key, m => {
    const has = m.applies_to.includes(ctx);
    const applies_to = has ? m.applies_to.filter(c => c !== ctx) : [...m.applies_to, ctx];
    const surface = (!has && ctx === 'element' && !m.surface) ? { ...DEFAULT_SURFACE } : m.surface;
    return { ...m, applies_to, surface };
  });
  const setSurface = (key, field, val) => patch(key, m => ({ ...m, surface: { ...(m.surface ?? DEFAULT_SURFACE), [field]: val } }));

  async function save() {
    setBusy(true); setMsg(null);
    try {
      // PATCH each material's full config. Small closed set — a handful of rows. Only element materials carry
      // a surface; body-only materials omit it. The api normalizes/gates (styles, applies_to, surface).
      for (const m of materials) {
        const config = { styles: m.styles, applies_to: m.applies_to };
        if (m.applies_to.includes('element') && m.surface) config.surface = m.surface;
        await updateMaterial(m.id, { config });
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
        <div style={s.title}>Materials</div>
        <div style={s.sub}>Each material declares where it can be used — <b>Cake body</b> (its cream styles) and/or <b>Decoration</b> (its surface finish, e.g. satin). Fondant can be both. <b>Smooth</b> is always available and first for body styles.</div>
      </div>

      <div style={s.grid}>
        {materials.map(({ key: mat, label, styles: list, applies_to, surface }) => {
          const available = [...catalog.keys()].filter(k => !list.includes(k));
          const isBody = applies_to.includes('body');
          const isElement = applies_to.includes('element');
          return (
            <div key={mat} style={s.card}>
              <div style={s.cardTitle}>{label} <span style={s.code}>{mat}</span></div>

              {/* Usage context — a decoration finish (satin) is NOT a cake-body material, and vice versa */}
              <div style={s.ctxRow}>
                {['body', 'element'].map(ctx => (
                  <button key={ctx} onClick={() => toggleContext(mat, ctx)} style={s.ctxChip(applies_to.includes(ctx))}>
                    {ctx === 'body' ? 'Cake body' : 'Decoration'}
                  </button>
                ))}
              </div>

              {/* BODY axis → cream styles */}
              {isBody && <>
                <div style={s.sectionLabel}>Styles</div>
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
              </>}

              {/* ELEMENT axis → decoration surface finish (PBR), what a placed GLB decoration wears */}
              {isElement && <>
                <div style={s.sectionLabel}>Decoration finish</div>
                <div style={s.surfGrid}>
                  {SURFACE_FIELDS.map(({ k, min, max, step }) => (
                    <label key={k} style={s.surfField}>
                      <span style={s.surfKey}>{k}</span>
                      <input type="number" min={min} max={max} step={step} style={s.surfInput}
                        value={surface?.[k] ?? ''}
                        onChange={e => setSurface(mat, k, e.target.value === '' ? undefined : Number(e.target.value))} />
                    </label>
                  ))}
                  <label style={s.surfField}>
                    <span style={s.surfKey}>sheenColor</span>
                    <input type="color" style={s.surfColor}
                      value={surface?.sheenColor ?? '#ffffff'} onChange={e => setSurface(mat, 'sheenColor', e.target.value)} />
                  </label>
                </div>
                <div style={s.empty}>Anisotropy needs the GLB to carry a baked TANGENT attribute (the silk streak).</div>
              </>}
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
  ctxRow: { display: 'flex', gap: 6, marginBottom: 12 },
  ctxChip: (on) => ({ padding: '5px 12px', borderRadius: 16, border: `1.5px solid ${on ? '#3D5A44' : '#C5D4C8'}`, background: on ? '#3D5A44' : '#fff', color: on ? '#fff' : '#6B8C74', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }),
  sectionLabel: { fontSize: 11, fontWeight: 800, color: '#6B8C74', textTransform: 'uppercase', letterSpacing: 0.5, margin: '10px 0 6px' },
  surfGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  surfField: { display: 'flex', flexDirection: 'column', gap: 2 },
  surfKey: { fontSize: 10, color: '#9bb3a1', fontFamily: 'monospace' },
  surfInput: { padding: '5px 8px', borderRadius: 6, border: '1px solid #C5D4C8', fontSize: 13, fontFamily: 'inherit', color: '#3D5A44', width: '100%' },
  surfColor: { width: '100%', height: 30, padding: 0, border: '1px solid #C5D4C8', borderRadius: 6, background: '#fff', cursor: 'pointer' },
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
