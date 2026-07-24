import { useState, useEffect, useRef, useCallback } from 'react';
import { get, post } from '../lib/api.js';

const STATUS_META = {
  active:    { label: 'Active',    color: '#065F46', bg: '#D1FAE5' },
  pending:   { label: 'Pending',   color: '#92400E', bg: '#FEF9C3' },
  expired:   { label: 'Expired',   color: '#991B1B', bg: '#FEE2E2' },
  past_due:  { label: 'Past Due',  color: '#B45309', bg: '#FEF3C7' },
  paused:    { label: 'Paused',    color: '#1E40AF', bg: '#DBEAFE' },
  cancelled: { label: 'Cancelled', color: '#6B7280', bg: '#F3F4F6' },
  no_subscription: { label: 'None', color: '#9BB5A2', bg: '#F4F8F5' },
};

const EVENT_LABELS = {
  activated:      'Activated',
  upgraded:       'Upgraded',
  downgraded:     'Downgraded',
  cancelled:      'Cancelled',
  reactivated:    'Reactivated',
  expired:        'Expired',
  payment_failed: 'Payment failed',
  admin_override: 'Admin override',
};

const STATUSES = ['active', 'pending', 'paused', 'cancelled', 'expired', 'past_due'];

function Badge({ status }) {
  const m = STATUS_META[status] ?? { label: status, color: '#555', bg: '#f3f4f6' };
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 20, background: m.bg, color: m.color, whiteSpace: 'nowrap' }}>
      {m.label}
    </span>
  );
}

function fmt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

const inp = { width: '100%', padding: '9px 12px', borderRadius: 10, border: '1.5px solid #C5D4C8', fontSize: 13, fontFamily: "'Quicksand', sans-serif", color: '#2C4433', outline: 'none', background: '#fff', boxSizing: 'border-box' };
const sel = { width: '100%', padding: '9px 12px', borderRadius: 10, border: '1.5px solid #C5D4C8', fontSize: 13, fontFamily: "'Quicksand', sans-serif", color: '#2C4433', outline: 'none', background: '#fff' };
const lbl = { fontSize: 10, fontWeight: 700, color: '#9BB5A2', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4, display: 'block' };

// ── Baker search dropdown ──────────────────────────────────────────────────────
function BakerPicker({ bakers, value, onChange }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = e => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [open]);

  const filtered = bakers.filter(b =>
    b.name.toLowerCase().includes(q.toLowerCase()) ||
    (b.email ?? '').toLowerCase().includes(q.toLowerCase())
  ).slice(0, 8);

  const selected = bakers.find(b => b.id === value);

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          ...inp, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderColor: open ? '#2C4433' : '#C5D4C8',
        }}
      >
        <span style={{ color: selected ? '#2C4433' : '#aaa' }}>
          {selected ? `${selected.name}${selected.email ? ` — ${selected.email}` : ''}` : 'Search baker…'}
        </span>
        <span style={{ fontSize: 10, color: '#aaa' }}>▼</span>
      </div>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 999,
          background: '#fff', borderRadius: 10, border: '1.5px solid #C5D4C8',
          boxShadow: '0 8px 24px rgba(0,0,0,0.12)', overflow: 'hidden',
        }}>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #F3F4F6' }}>
            <input
              autoFocus
              placeholder="Type to search…"
              value={q} onChange={e => setQ(e.target.value)}
              style={{ ...inp, border: 'none', padding: '4px 6px', fontSize: 13 }}
            />
          </div>
          {filtered.length === 0 && (
            <div style={{ padding: '12px 14px', fontSize: 13, color: '#bbb' }}>No bakers found</div>
          )}
          {filtered.map(b => (
            <div
              key={b.id}
              onPointerDown={() => { onChange(b.id); setOpen(false); setQ(''); }}
              style={{
                padding: '10px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                color: b.id === value ? '#2C4433' : '#333',
                background: b.id === value ? '#F4F8F5' : 'transparent',
                borderTop: '1px solid #F3F4F6',
              }}
            >
              {b.name}
              {b.email && <span style={{ fontSize: 11, color: '#aaa', marginLeft: 8 }}>{b.email}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Subscription form (shared by Add and Manage panels) ───────────────────────
function SubscriptionForm({ plans, periods, form, setForm, saving, error, success, onSave, submitLabel = 'Assign Subscription' }) {
  const isSpark = form.plan_name === 'spark';

  // Auto-set monthly period whenever Spark is the selected plan and periods are loaded
  useEffect(() => {
    if (isSpark && periods.length > 0 && !form.billing_period_id) {
      const monthly = periods.find(p => p.name === 'monthly');
      if (monthly) setForm(f => ({ ...f, billing_period_id: monthly.id }));
    }
  }, [isSpark, periods]);

  function handlePeriodChange(periodId) {
    const period = periods.find(p => p.id === periodId);
    const newForm = { ...form, billing_period_id: periodId };
    if (period?.months) {
      const d = new Date();
      d.setMonth(d.getMonth() + period.months);
      newForm.end_date = d.toISOString().slice(0, 10);
    }
    setForm(newForm);
  }

  function handlePlanChange(planName) {
    const newForm = { ...form, plan_name: planName };
    if (planName === 'spark') {
      const monthly = periods.find(p => p.name === 'monthly');
      newForm.billing_period_id = monthly?.id ?? '';
      const d = new Date();
      d.setMonth(d.getMonth() + 1);
      newForm.end_date = d.toISOString().slice(0, 10);
    } else {
      newForm.billing_period_id = '';
      newForm.end_date = '';
    }
    setForm(newForm);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <label style={lbl}>Plan</label>
          <select style={sel} value={form.plan_name} onChange={e => handlePlanChange(e.target.value)}>
            {plans.map(p => <option key={p.id} value={p.name}>{p.display_name}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={lbl}>Status</label>
          <select style={sel} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
            {STATUSES.map(v => <option key={v} value={v}>{STATUS_META[v]?.label ?? v}</option>)}
          </select>
        </div>
      </div>

      {/* Billing period — only for paid plans */}
      {!isSpark && periods.length > 0 && (
        <div>
          <label style={lbl}>Billing Period</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {periods.map(p => {
              const isSelected = form.billing_period_id === p.id;
              return (
                <button key={p.id} type="button" onClick={() => handlePeriodChange(p.id)} style={{
                  flex: 1, padding: '9px 8px', borderRadius: 10, cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 12, fontWeight: 700,
                  border: `1.5px solid ${isSelected ? '#2C4433' : '#C5D4C8'}`,
                  background: isSelected ? '#2C4433' : '#fff',
                  color: isSelected ? '#fff' : '#666',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                }}>
                  {p.display_name}
                  {p.discount_pct > 0 && (
                    <span style={{ fontSize: 9, fontWeight: 800, color: isSelected ? 'rgba(255,255,255,0.8)' : '#059669' }}>
                      -{p.discount_pct}%
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <label style={lbl}>End Date {isSpark ? '(30 days for Spark)' : '(auto-filled from period)'}</label>
        <input type="date" style={inp} value={form.end_date}
          onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} />
      </div>

      <div>
        <label style={lbl}>Note</label>
        <input style={inp} placeholder="e.g. Complimentary, promotional offer…"
          value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
      </div>

      {error   && <div style={{ fontSize: 12, color: '#DC2626', fontWeight: 600 }}>{error}</div>}
      {success && <div style={{ fontSize: 12, color: '#065F46', fontWeight: 700 }}>Subscription assigned</div>}

      <button onClick={onSave} disabled={saving} style={{
        padding: '12px', borderRadius: 10, border: 'none',
        cursor: saving ? 'not-allowed' : 'pointer',
        background: saving ? '#C5D4C8' : '#2C4433',
        color: '#fff', fontSize: 13, fontWeight: 800, fontFamily: 'inherit',
      }}>
        {saving ? 'Saving…' : submitLabel}
      </button>
    </div>
  );
}

// ── Add Subscription modal ────────────────────────────────────────────────────
function AddSubscriptionModal({ bakers, plans, periods, onClose, onSaved }) {
  const sparkEnd = new Date(); sparkEnd.setDate(sparkEnd.getDate() + 30);
  const [form, setForm] = useState({ baker_id: '', plan_name: 'spark', billing_period_id: '', status: 'active', end_date: sparkEnd.toISOString().slice(0,10), note: '' });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState(null);
  const [success, setSuccess] = useState(false);

  async function handleSave() {
    if (!form.baker_id) { setError('Please select a baker'); return; }
    setSaving(true); setError(null); setSuccess(false);
    try {
      await post(`/api/admin/bakers/${form.baker_id}/subscription`, {
        plan_name:         form.plan_name,
        billing_period_id: form.billing_period_id || undefined,
        status:            form.status,
        end_date:          form.end_date || null,
        note:              form.note    || undefined,
      });
      setSuccess(true);
      onSaved();
      setTimeout(onClose, 1200);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 20, width: 460, maxWidth: 'calc(100vw - 32px)', maxHeight: '90vh', overflowY: 'auto', fontFamily: "'Quicksand', sans-serif", boxShadow: '0 8px 40px rgba(0,0,0,0.18)' }}
        onClick={e => e.stopPropagation()}>

        <div style={{ padding: '20px 24px', borderBottom: '1px solid #F3F4F6', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: '#2C4433' }}>Add Subscription</div>
          <button onClick={onClose} style={{ background: '#F4F8F5', border: 'none', borderRadius: 8, width: 30, height: 30, cursor: 'pointer', fontSize: 14, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
        </div>

        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={lbl}>Baker</label>
            <BakerPicker bakers={bakers} value={form.baker_id} onChange={id => setForm(f => ({ ...f, baker_id: id }))} />
          </div>
          <SubscriptionForm plans={plans} periods={periods} form={form} setForm={setForm} saving={saving} error={error} success={success} onSave={handleSave} submitLabel="Assign Subscription" />
        </div>
      </div>
    </div>
  );
}

// ── Manage panel (existing baker) ─────────────────────────────────────────────
function ManagePanel({ bakerId, onClose, onSaved }) {
  const [data,    setData]    = useState(null);
  const [plans,   setPlans]   = useState([]);
  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form,    setForm]    = useState({ plan_name: 'spark', billing_period_id: '', status: 'active', end_date: '', note: '' });
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState(null);
  const [success, setSuccess] = useState(false);

  async function load() {
    setLoading(true);
    const [d, p, per] = await Promise.all([
      get(`/api/admin/bakers/${bakerId}/subscription`),
      get('/api/admin/subscription-plans'),
      get('/api/billing/periods'),
    ]);
    setData(d);
    setPlans(p);
    setPeriods(per);
    const currentStatus = d.current?.status;
    setForm(f => ({
      ...f,
      plan_name:        d.current?.plan?.name ?? 'spark',
      billing_period_id: '',
      status:           STATUSES.includes(currentStatus) ? currentStatus : 'active',
      end_date:         d.current?.end_date ?? '',
    }));
    setLoading(false);
  }

  useEffect(() => { load(); }, [bakerId]);

  async function handleSave() {
    setSaving(true); setError(null); setSuccess(false);
    try {
      await post(`/api/admin/bakers/${bakerId}/subscription`, {
        plan_name:         form.plan_name,
        billing_period_id: form.billing_period_id || undefined,
        status:            form.status,
        end_date:          form.end_date || null,
        note:              form.note    || undefined,
      });
      setSuccess(true);
      onSaved();
      await load();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex' }} onClick={onClose}>
      <div style={{ flex: 1 }} />
      <div style={{ width: 480, background: '#F4F8F5', height: '100%', overflowY: 'auto', boxShadow: '-4px 0 32px rgba(0,0,0,0.14)', fontFamily: "'Quicksand', sans-serif", display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}>

        <div style={{ padding: '20px 24px', background: '#2C4433', display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: '#fff', fontFamily: 'inherit' }}>Back</button>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: '#fff' }}>{data?.baker?.name ?? '…'}</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>Subscription Management</div>
          </div>
        </div>

        {loading && <div style={{ padding: 24, color: '#9BB5A2', fontSize: 14 }}>Loading…</div>}

        {data && (
          <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>

            {/* Current status */}
            <div style={{ background: '#fff', borderRadius: 14, padding: 18, border: '1.5px solid #E8EFE9' }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: '#9BB5A2', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 }}>Current Subscription</div>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                <div><div style={lbl}>Plan</div><div style={{ fontSize: 15, fontWeight: 800, color: '#2C4433', textTransform: 'capitalize' }}>{data.current?.plan?.display_name ?? '—'}</div></div>
                <div><div style={lbl}>Status</div><Badge status={data.current?.status} /></div>
                <div><div style={lbl}>End Date</div><div style={{ fontSize: 13, color: '#555', fontWeight: 600 }}>{fmt(data.current?.end_date)}</div></div>
              </div>
            </div>

            {/* Override form */}
            <div style={{ background: '#fff', borderRadius: 14, padding: 18, border: '1.5px solid #E8EFE9' }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: '#9BB5A2', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 14 }}>Update Subscription</div>
              <SubscriptionForm plans={plans} periods={periods} form={form} setForm={setForm} saving={saving} error={error} success={success} onSave={handleSave} submitLabel="Update Subscription" />
            </div>

            {/* Event history */}
            {data.events?.length > 0 && (
              <div style={{ background: '#fff', borderRadius: 14, padding: 18, border: '1.5px solid #E8EFE9' }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: '#9BB5A2', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 14 }}>History</div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {data.events.map((ev, i) => (
                    <div key={ev.id} style={{ display: 'flex', gap: 12, paddingBottom: 14 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, width: 16 }}>
                        <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#2C4433', marginTop: 3, flexShrink: 0 }} />
                        {i < data.events.length - 1 && <div style={{ width: 2, flex: 1, background: '#E8EFE9', marginTop: 4 }} />}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: '#1a1a1a' }}>{EVENT_LABELS[ev.event] ?? ev.event}</span>
                          {ev.new_status && <Badge status={ev.new_status} />}
                        </div>
                        {ev.new_tier && <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{ev.previous_tier && `${ev.previous_tier} → `}{ev.new_tier}</div>}
                        {ev.note && <div style={{ fontSize: 11, color: '#888', marginTop: 2, fontStyle: 'italic' }}>"{ev.note}"</div>}
                        <div style={{ fontSize: 10, color: '#bbb', marginTop: 3 }}>{fmt(ev.created_at)} · {ev.changed_by}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────
export default function BakerSubscriptions() {
  const [bakers,   setBakers]   = useState([]);
  const [plans,    setPlans]    = useState([]);
  const [periods,  setPeriods]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [selected, setSelected] = useState(null);
  const [showAdd,  setShowAdd]  = useState(false);
  const [search,   setSearch]   = useState('');

  async function load() {
    setLoading(true);
    try {
      const [b, p, per] = await Promise.all([
        get('/api/admin/bakers/subscriptions'),
        get('/api/admin/subscription-plans'),
        get('/api/billing/periods'),
      ]);
      setBakers(b);
      setPlans(p);
      setPeriods(per);
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  const filtered = bakers.filter(b =>
    b.name.toLowerCase().includes(search.toLowerCase()) ||
    (b.email ?? '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ minHeight: '100vh', background: '#EDEAE2', fontFamily: "'Quicksand', sans-serif", padding: 32 }}>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: '#2C4433' }}>Baker Subscriptions</div>
        <input
          placeholder="Search baker…"
          value={search} onChange={e => setSearch(e.target.value)}
          style={{ padding: '8px 14px', borderRadius: 10, border: '1.5px solid #C5D4C8', fontSize: 13, fontFamily: 'inherit', outline: 'none', width: 220, background: '#fff' }}
        />
        <button
          onClick={() => setShowAdd(true)}
          style={{ marginLeft: 'auto', padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer', background: '#2C4433', color: '#fff', fontSize: 13, fontWeight: 800, fontFamily: 'inherit' }}
        >
          + Add Subscription
        </button>
      </div>

      {loading && <div style={{ color: '#9BB5A2', fontSize: 14 }}>Loading…</div>}

      {!loading && (
        <div style={{ background: '#fff', borderRadius: 16, border: '1.5px solid #C5D4C8', overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: 16, padding: '12px 20px', borderBottom: '1.5px solid #E8EFE9', fontSize: 10, fontWeight: 800, color: '#9BB5A2', letterSpacing: 1, textTransform: 'uppercase' }}>
            <span>Baker</span><span>Plan</span><span>Status</span><span>End Date</span><span></span>
          </div>

          {filtered.map((b, i) => (
            <div key={b.id} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: 16, padding: '14px 20px', alignItems: 'center', borderTop: i === 0 ? 'none' : '1px solid #F4F8F5' }}
              onMouseEnter={e => e.currentTarget.style.background = '#F4F8F5'}
              onMouseLeave={e => e.currentTarget.style.background = ''}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#1a1a1a' }}>{b.name}</div>
                {b.email && <div style={{ fontSize: 11, color: '#aaa', marginTop: 1 }}>{b.email}</div>}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#2C4433', textTransform: 'capitalize' }}>{b.subscription_plan ?? '—'}</div>
              <Badge status={b.subscription_status} />
              <div style={{ fontSize: 12, color: '#666', fontWeight: 600 }}>{fmt(b.end_date)}</div>
              <button onClick={() => setSelected(b.id)} style={{ padding: '7px 14px', borderRadius: 8, border: '1.5px solid #C5D4C8', background: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', color: '#2C4433', fontFamily: 'inherit' }}>
                Manage
              </button>
            </div>
          ))}

          {filtered.length === 0 && (
            <div style={{ padding: '32px 20px', textAlign: 'center', color: '#bbb', fontSize: 14 }}>No bakers found.</div>
          )}
        </div>
      )}

      {showAdd && (
        <AddSubscriptionModal
          bakers={bakers}
          plans={plans}
          periods={periods}
          onClose={() => setShowAdd(false)}
          onSaved={() => { load(); setShowAdd(false); }}
        />
      )}

      {selected && (
        <ManagePanel bakerId={selected} onClose={() => setSelected(null)} onSaved={load} />
      )}
    </div>
  );
}
