import { useState, useEffect } from 'react';
import { get, patch, post } from '../lib/api.js';

const s = {
  page:    { minHeight: '100vh', background: '#EDEAE2', fontFamily: "'Quicksand', sans-serif", padding: 32 },
  title:   { fontSize: 20, fontWeight: 800, color: '#2C4433', marginBottom: 24 },
  grid:    { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 20 },
  card:    { background: '#fff', borderRadius: 16, border: '1.5px solid #C5D4C8', overflow: 'hidden' },
  cardHdr: { padding: '16px 20px', borderBottom: '1px solid #E8EFE9', display: 'flex', alignItems: 'center', gap: 10 },
  cardBdy: { padding: '20px' },
  label:   { fontSize: 10, fontWeight: 700, color: '#9BB5A2', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4, display: 'block' },
  inp:     { width: '100%', padding: '9px 12px', borderRadius: 10, border: '1.5px solid #C5D4C8', fontSize: 13, fontFamily: "'Quicksand', sans-serif", color: '#2C4433', outline: 'none', boxSizing: 'border-box' },
  btn:     { padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: "'Quicksand', sans-serif" },
  featRow:   { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #F0F4F1' },
  featLabel: { fontSize: 13, color: '#2C4433', fontWeight: 600 },
};

function fmt(paise) {
  if (!paise) return '—';
  return '₹' + (paise / 100).toLocaleString('en-IN');
}

// Build a COMPLETE features object: keep existing keys (incl. any not in the schema, so
// nothing is silently dropped), then fill any missing schema key with its fallback.
function initFeatures(features, schema) {
  const out = { ...(features ?? {}) };
  if (schema) {
    for (const f of [...schema.entitlements, ...schema.config]) {
      if (!(f.key in out)) out[f.key] = f.fallback;
    }
  }
  return out;
}

// Typed editor for plan features, generated from the registry schema (no hand-typed JSON
// → no typos / wrong types). bool → checkbox, int → number + "∞" (null = unlimited).
function FeatureFields({ schema, values, onChange }) {
  if (!schema) return <div style={{ fontSize: 12, color: '#9BB5A2' }}>Loading fields…</div>;
  const field = (f) => {
    const v = values[f.key];
    if (f.type === 'bool') {
      return (
        <label key={f.key} style={{ ...s.featRow, cursor: 'pointer' }}>
          <input type="checkbox" checked={v === true} onChange={e => onChange(f.key, e.target.checked)} />
          <span style={s.featLabel}>{f.label}</span>
        </label>
      );
    }
    const unlimited = v === null;
    return (
      <div key={f.key} style={s.featRow}>
        <span style={s.featLabel}>{f.label}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
          <input
            type="number" min="0"
            style={{ ...s.inp, width: 84, padding: '6px 8px', background: unlimited ? '#F4F8F5' : '#fff' }}
            value={unlimited ? '' : (v ?? '')}
            disabled={unlimited}
            placeholder={unlimited ? '∞' : ''}
            onChange={e => onChange(f.key, e.target.value === '' ? f.fallback : Math.max(0, Number(e.target.value)))}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#2C4433', cursor: 'pointer' }}>
            <input type="checkbox" checked={unlimited}
              onChange={e => onChange(f.key, e.target.checked ? null : (f.fallback ?? 0))} />
            ∞
          </label>
        </div>
      </div>
    );
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={s.label}>Entitlements</div>
      {schema.entitlements.map(field)}
      {schema.config?.length > 0 && (
        <>
          <div style={{ ...s.label, marginTop: 10 }}>Plan config</div>
          {schema.config.map(field)}
        </>
      )}
    </div>
  );
}

// Read-only feature summary using the same schema labels (falls back to raw JSON if the
// schema hasn't loaded yet).
function FeatureSummary({ schema, features }) {
  if (!schema) {
    return (
      <pre style={{ fontSize: 11, color: '#555', background: '#F4F8F5', borderRadius: 8, padding: '10px 12px', margin: 0, overflow: 'auto' }}>
        {JSON.stringify(features ?? {}, null, 2)}
      </pre>
    );
  }
  const val = (f) => {
    const v = features?.[f.key];
    if (f.type === 'bool') return v ? '✓' : '—';
    return v === null ? '∞' : (v ?? '—');
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {[...schema.entitlements, ...schema.config].map(f => (
        <div key={f.key} style={{ display: 'flex', fontSize: 12, color: '#555' }}>
          <span style={{ flex: 1 }}>{f.label}</span>
          <span style={{ fontWeight: 700, color: f.type === 'bool' && !features?.[f.key] ? '#9BB5A2' : '#2C4433' }}>{val(f)}</span>
        </div>
      ))}
    </div>
  );
}

function PlanCard({ plan, schema, onSave }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    display_name:  plan.display_name,
    price_monthly: plan.price_monthly / 100,
    price_yearly:  plan.price_yearly / 100,
    is_active:     plan.is_active,
    features:      initFeatures(plan.features, schema),
    tagline:        plan.tagline ?? '',
    feature_bullets: (plan.feature_bullets ?? []).join('\n'),   // one bullet per line in the editor
    is_popular:     !!plan.is_popular,
    has_storefront: plan.has_storefront !== false,
  });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState(null);

  function startEdit() {
    // Re-materialise features + marketing fields from the plan each time we open the editor.
    setForm(f => ({
      ...f,
      features: initFeatures(plan.features, schema),
      tagline: plan.tagline ?? '',
      feature_bullets: (plan.feature_bullets ?? []).join('\n'),
      is_popular: !!plan.is_popular,
      has_storefront: plan.has_storefront !== false,
    }));
    setEditing(true);
  }

  const setFeature = (key, value) => setForm(f => ({ ...f, features: { ...f.features, [key]: value } }));

  async function handleSave() {
    setSaving(true); setError(null);
    try {
      await patch(`/api/admin/subscription-plans/${plan.id}`, {
        display_name:  form.display_name,
        price_monthly: Math.round(form.price_monthly * 100),
        price_yearly:  Math.round(form.price_yearly  * 100),
        is_active:     form.is_active,
        features:      form.features,
        tagline:        form.tagline.trim() || null,
        feature_bullets: form.feature_bullets.split('\n').map(s => s.trim()).filter(Boolean),
        is_popular:     form.is_popular,
        has_storefront: form.has_storefront,
      });
      onSave();
      setEditing(false);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div style={s.card}>
      <div style={s.cardHdr}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#2C4433' }}>{plan.display_name}</div>
          <div style={{ fontSize: 11, color: '#9BB5A2', fontWeight: 600, marginTop: 2 }}>{plan.name}</div>
        </div>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
          background: plan.is_active ? '#D1FAE5' : '#F3F4F6',
          color:      plan.is_active ? '#065F46' : '#6B7280',
        }}>{plan.is_active ? 'Active' : 'Inactive'}</span>
        <button onClick={() => (editing ? setEditing(false) : startEdit())} style={{ ...s.btn, background: '#F4F8F5', color: '#2C4433', padding: '7px 14px' }}>
          {editing ? 'Cancel' : 'Edit'}
        </button>
      </div>

      <div style={s.cardBdy}>
        {!editing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 24 }}>
              <div><div style={s.label}>Monthly</div><div style={{ fontSize: 18, fontWeight: 800, color: '#2C4433' }}>{fmt(plan.price_monthly)}</div></div>
              <div><div style={s.label}>Yearly</div><div style={{ fontSize: 18, fontWeight: 800, color: '#2C4433' }}>{fmt(plan.price_yearly)}</div></div>
            </div>
            <div>
              <div style={s.label}>Features</div>
              <FeatureSummary schema={schema} features={plan.features} />
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={s.label}>Display Name</label>
              <input style={s.inp} value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))} />
            </div>
            <div>
              <label style={s.label}>Tagline (short — shown collapsed)</label>
              <input style={s.inp} value={form.tagline} onChange={e => setForm(f => ({ ...f, tagline: e.target.value }))} placeholder="e.g. Public storefront · unlimited orders" />
            </div>
            <div>
              <label style={s.label}>Feature bullets (one per line — shown expanded)</label>
              <textarea style={{ ...s.inp, minHeight: 96, resize: 'vertical', fontFamily: 'inherit' }}
                value={form.feature_bullets}
                onChange={e => setForm(f => ({ ...f, feature_bullets: e.target.value }))}
                placeholder={"Everything in Spark\nPublic storefront\nUnlimited orders"} />
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={s.label}>Monthly Price (₹)</label>
                <input style={s.inp} type="number" value={form.price_monthly} onChange={e => setForm(f => ({ ...f, price_monthly: e.target.value }))} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={s.label}>Yearly Price (₹)</label>
                <input style={s.inp} type="number" value={form.price_yearly} onChange={e => setForm(f => ({ ...f, price_yearly: e.target.value }))} />
              </div>
            </div>
            <FeatureFields schema={schema} values={form.features} onChange={setFeature} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" id={`active-${plan.id}`} checked={form.is_active}
                  onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} />
                <label htmlFor={`active-${plan.id}`} style={{ fontSize: 13, fontWeight: 600, color: '#2C4433', cursor: 'pointer' }}>Active</label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" id={`popular-${plan.id}`} checked={form.is_popular}
                  onChange={e => setForm(f => ({ ...f, is_popular: e.target.checked }))} />
                <label htmlFor={`popular-${plan.id}`} style={{ fontSize: 13, fontWeight: 600, color: '#2C4433', cursor: 'pointer' }}>Most popular</label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" id={`storefront-${plan.id}`} checked={form.has_storefront}
                  onChange={e => setForm(f => ({ ...f, has_storefront: e.target.checked }))} />
                <label htmlFor={`storefront-${plan.id}`} style={{ fontSize: 13, fontWeight: 600, color: '#2C4433', cursor: 'pointer' }}>Includes storefront</label>
              </div>
            </div>
            {error && <div style={{ fontSize: 12, color: '#DC2626', fontWeight: 600 }}>{error}</div>}
            <button onClick={handleSave} disabled={saving} style={{ ...s.btn, background: '#2C4433', color: '#fff' }}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AddPlanModal({ schema, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: '', display_name: '', price_monthly: '', price_yearly: '', sort_order: 0,
    features: initFeatures({}, schema),
  });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState(null);

  const setFeature = (key, value) => setForm(f => ({ ...f, features: { ...f.features, [key]: value } }));

  async function handleCreate() {
    setSaving(true); setError(null);
    try {
      await post('/api/admin/subscription-plans', {
        name:          form.name.trim().toLowerCase(),
        display_name:  form.display_name.trim(),
        price_monthly: Math.round(parseFloat(form.price_monthly || 0) * 100),
        price_yearly:  Math.round(parseFloat(form.price_yearly  || 0) * 100),
        features:      form.features,
        sort_order:    Number(form.sort_order),
      });
      onSaved();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 460, maxWidth: 'calc(100vw - 40px)', maxHeight: 'calc(100vh - 40px)', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 800, color: '#2C4433' }}>Add Plan</div>
        {[['name','Slug (e.g. starter)'],['display_name','Display Name'],['price_monthly','Monthly Price (₹)'],['price_yearly','Yearly Price (₹)']].map(([key, label]) => (
          <div key={key}>
            <label style={s.label}>{label}</label>
            <input style={s.inp} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} />
          </div>
        ))}
        <FeatureFields schema={schema} values={form.features} onChange={setFeature} />
        {error && <div style={{ fontSize: 12, color: '#DC2626', fontWeight: 600 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ ...s.btn, background: '#F4F8F5', color: '#2C4433', flex: 1 }}>Cancel</button>
          <button onClick={handleCreate} disabled={saving} style={{ ...s.btn, background: '#2C4433', color: '#fff', flex: 1 }}>
            {saving ? 'Creating…' : 'Create Plan'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ManagePlans() {
  const [plans,   setPlans]   = useState([]);
  const [schema,  setSchema]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  async function load() {
    setLoading(true);
    try { setPlans(await get('/api/admin/subscription-plans')); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    load();
    // The registry-driven form's schema (keys/types/labels). Best-effort: the editor
    // falls back to a read-only JSON view if this fails.
    get('/api/admin/entitlements-schema').then(setSchema).catch(() => {});
  }, []);

  return (
    <div style={s.page}>
      <link href="https://fonts.googleapis.com/css2?family=Quicksand:wght@400;600;700;800&display=swap" rel="stylesheet" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
        <div style={s.title}>Subscription Plans</div>
        <button onClick={() => setShowAdd(true)} style={{ ...s.btn, background: '#2C4433', color: '#fff', marginLeft: 'auto' }}>
          + Add Plan
        </button>
      </div>

      {loading && <div style={{ color: '#9BB5A2', fontSize: 14 }}>Loading…</div>}

      {!loading && (
        <div style={s.grid}>
          {plans.map(p => <PlanCard key={p.id} plan={p} schema={schema} onSave={load} />)}
          {plans.length === 0 && <div style={{ fontSize: 14, color: '#9BB5A2' }}>No plans yet. Add one to get started.</div>}
        </div>
      )}

      {showAdd && <AddPlanModal schema={schema} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} />}
    </div>
  );
}
