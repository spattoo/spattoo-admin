import { useState, useEffect } from 'react';
import { fetchNotificationChannels, saveNotificationChannel } from '../lib/api.js';

// ── Notifications: which channels each one goes out on ───────────────────────────────────────────
// One card per notification type. Email and push switch straight on or off — their text is written
// in code. SMS and WhatsApp open an editor on the card itself, because each needs a template
// approved outside Spattoo (MSG91 on DLT, AiSensy on Meta) and its gaps mapped to the fields the
// notification carries. The rules are enforced by the API; this screen explains them.

const ORDER = ['email', 'push', 'sms', 'whatsapp'];
const LABEL = { email: 'Email', push: 'Push', sms: 'SMS', whatsapp: 'WhatsApp' };
const PHONE = new Set(['sms', 'whatsapp']);

const font = 'Quicksand, sans-serif';
const s = {
  page:       { minHeight: '100vh', background: '#EDEAE2', fontFamily: font, padding: '32px 16px' },
  wrap:       { maxWidth: 760, margin: '0 auto' },
  title:      { fontSize: 22, fontWeight: 800, color: '#2C4433' },
  intro:      { fontSize: 13, fontWeight: 600, color: '#6B8C74', margin: '6px 0 20px', lineHeight: 1.5 },
  section:    { fontSize: 11, fontWeight: 800, color: '#6B8C74', letterSpacing: 1, textTransform: 'uppercase', margin: '24px 0 8px' },
  note:       { fontSize: 12, fontWeight: 600, color: '#6B8C74', margin: '0 0 10px' },
  card:       { background: '#fff', borderRadius: 14, border: '1.5px solid #C5D4C8', padding: '16px 18px', marginBottom: 10 },
  name:       { fontSize: 15, fontWeight: 700, color: '#2C4433' },
  slug:       { fontSize: 12, fontWeight: 600, color: '#9BB5A2', marginTop: 2, wordBreak: 'break-all' },
  chips:      { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  chip:       (on, open, disabled) => ({
    padding: '7px 14px', borderRadius: 20, fontFamily: font, fontSize: 12, fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
    border: `1.5px ${disabled ? 'dashed' : 'solid'} ${on || open ? '#3D5A44' : '#C5D4C8'}`,
    background: on ? '#3D5A44' : '#fff', color: on ? '#fff' : '#6B8C74',
    boxShadow: open ? '0 0 0 3px #E8EDE9' : 'none',
  }),
  summary:    { fontSize: 12, fontWeight: 600, color: '#6B8C74', marginTop: 8, wordBreak: 'break-word' },
  editor:     { marginTop: 14, padding: 14, borderRadius: 10, background: '#F4F8F5' },
  label:      { fontSize: 12, fontWeight: 700, color: '#6B8C74', display: 'block', margin: '14px 0 6px' },
  input:      { width: '100%', padding: '9px 11px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontFamily: font, fontSize: 14, fontWeight: 600, color: '#2C4433', background: '#fff', boxSizing: 'border-box', outline: 'none' },
  hint:       { fontSize: 11, fontWeight: 600, color: '#9BB5A2', marginTop: 5, lineHeight: 1.4 },
  varRow:     { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  slot:       { flex: '0 0 44px', fontSize: 13, fontWeight: 800, color: '#2C4433' },
  check:      { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: '#2C4433', cursor: 'pointer' },
  linkBtn:    { border: 'none', background: 'none', padding: '4px 0', fontFamily: font, fontSize: 12, fontWeight: 800, color: '#3D5A44', cursor: 'pointer' },
  saveBtn:    busy => ({ padding: '9px 22px', borderRadius: 10, border: 'none', background: busy ? '#9BB5A2' : '#3D5A44', color: '#fff', fontFamily: font, fontSize: 14, fontWeight: 800, cursor: busy ? 'not-allowed' : 'pointer' }),
  cancelBtn:  { padding: '9px 18px', borderRadius: 10, border: '1.5px solid #C5D4C8', background: '#fff', color: '#6B8C74', fontFamily: font, fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  banner:     ok => ({ padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, lineHeight: 1.45, background: ok ? '#E8F5E9' : '#FFF6E5', color: ok ? '#2E7D32' : '#8A5A00', marginBottom: 12 }),
  error:      { padding: '8px 12px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: '#FFF0F0', color: '#C0392B', marginTop: 10 },
};

// What a channel row becomes when saved: only the fields the API reads.
const bodyOf = row => ({
  enabled: !!row?.enabled, template_ref: row?.template_ref ?? null, config: row?.config ?? {}, fallback_for: row?.fallback_for ?? null,
});

/* A payload field. A list when the type has been sent before and its fields are known; a text box when
   it has not, because there is nothing to list yet. */
function FieldPicker({ fields, value, onChange, empty = 'Choose a field…', placeholder = 'field name' }) {
  if (!fields.length) {
    return <input style={s.input} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />;
  }
  return (
    <select style={s.input} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {fields.map(f => <option key={f} value={f}>{f}</option>)}
      {value && !fields.includes(value) && <option value={value}>{value} (not in the latest notification)</option>}
    </select>
  );
}

function PhoneChannelEditor({ type, channel, providers, onCancel, onSaved }) {
  const isSms = channel === 'sms';
  const row = type.channels[channel];
  const other = isSms ? 'whatsapp' : 'sms';

  const [enabled, setEnabled] = useState(!!row?.enabled);
  const [ref, setRef]         = useState(row?.template_ref ?? '');
  // [variable name, field] pairs. WhatsApp's names are just their position: {{1}}, {{2}} …
  const [vars, setVars] = useState(() => isSms
    ? Object.entries(row?.config?.variables ?? {})
    : (row?.config?.params ?? []).map((field, i) => [String(i + 1), field]));
  const [image, setImage]       = useState(row?.config?.image_field ?? '');
  const [fallback, setFallback] = useState(row?.fallback_for === other);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState(null);

  const setVar = (i, pair) => setVars(v => v.map((p, j) => (j === i ? pair : p)));

  async function save() {
    const names = vars.map(([k]) => k.trim());
    if (isSms && new Set(names).size !== names.length) return setError('Two variables have the same name.');
    setSaving(true);
    setError(null);
    const config = isSms
      ? { variables: Object.fromEntries(vars.map(([k, field]) => [k.trim(), field])) }
      : { params: vars.map(([, field]) => field), ...(image ? { image_field: image } : {}) };
    try {
      onSaved(await saveNotificationChannel(type.id, channel, {
        enabled, template_ref: ref.trim() || null, config, fallback_for: fallback ? other : null,
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={s.editor}>
      <label style={s.check}>
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        Send this notification by {LABEL[channel]}
      </label>
      {!providers[channel] && (
        <div style={{ ...s.hint, color: '#8A5A00' }}>
          {isSms ? 'MSG91' : 'AiSensy'} is not set up on this server yet, so these messages will be skipped until it is.
        </div>
      )}

      <label style={s.label}>{isSms ? 'MSG91 template ID' : 'AiSensy campaign name'}</label>
      <input style={s.input} value={ref} onChange={e => setRef(e.target.value)}
        placeholder={isSms ? 'From MSG91 → SMS → Templates' : 'e.g. trial_ending'} />
      <div style={s.hint}>
        {isSms
          ? 'The template must be approved on DLT and added in MSG91.'
          : 'An API campaign set to Live in AiSensy, on a template Meta has approved.'}
      </div>

      <label style={s.label}>{isSms ? 'Template variables' : 'Template variables, in order'}</label>
      {!type.fields.length && (
        <div style={{ ...s.hint, marginTop: 0, marginBottom: 8 }}>
          This notification has not been sent yet, so its fields are not known. Type each field name exactly.
        </div>
      )}
      {vars.map(([name, field], i) => (
        <div key={i} style={s.varRow}>
          {isSms
            ? <input style={{ ...s.input, flex: '0 0 96px' }} value={name} onChange={e => setVar(i, [e.target.value, field])} placeholder="VAR1" />
            : <span style={s.slot}>{`{{${i + 1}}}`}</span>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <FieldPicker fields={type.fields} value={field} onChange={f => setVar(i, [name, f])} />
          </div>
          <button type="button" style={s.linkBtn} onClick={() => setVars(v => v.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <button type="button" style={s.linkBtn}
        onClick={() => setVars(v => [...v, [isSms ? `VAR${v.length + 1}` : String(v.length + 1), '']])}>
        + Add variable
      </button>

      {!isSms && (
        <>
          <label style={s.label}>Header image (optional)</label>
          <FieldPicker fields={type.fields} value={image} onChange={setImage} empty="No image" placeholder="e.g. thumbnailUrl" />
          <div style={s.hint}>Only for a template approved with an image header — for example the cake picture.</div>
        </>
      )}

      {type.channels[other]?.enabled && (
        <label style={{ ...s.check, marginTop: 14 }}>
          <input type="checkbox" checked={fallback} onChange={e => setFallback(e.target.checked)} />
          Only send if {LABEL[other]} doesn't deliver
        </label>
      )}

      {error && <div style={s.error}>{error}</div>}
      <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
        <button type="button" style={s.saveBtn(saving)} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" style={s.cancelBtn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// One line under the chips for each phone channel that is on, so what it sends is visible unopened.
function phoneSummary(channel, row) {
  const n = channel === 'sms' ? Object.keys(row.config?.variables ?? {}).length : (row.config?.params ?? []).length;
  const parts = [
    `${LABEL[channel]}: ${row.template_ref ?? 'no template set'}`,
    `${n} variable${n === 1 ? '' : 's'}`,
    row.config?.image_field ? `image from ${row.config.image_field}` : null,
    row.fallback_for ? `only if ${LABEL[row.fallback_for]} doesn't deliver` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

export default function NotificationChannels() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [open, setOpen]       = useState(null);    // `${typeId}:${channel}` — the editor showing
  const [busy, setBusy]       = useState(null);    // `${typeId}:${channel}` — a toggle saving
  const [cardError, setCardError] = useState({});  // typeId → message, shown on that card

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try { setData(await fetchNotificationChannels()); setLoadError(null); }
    catch (err) { setLoadError(err.message); }
    finally { setLoading(false); }
  }

  function applySaved(saved) {
    setData(d => ({
      ...d,
      types: d.types.map(t => (t.id === saved.type_id ? { ...t, channels: { ...t.channels, [saved.channel]: saved } } : t)),
    }));
    setCardError(e => ({ ...e, [saved.type_id]: null }));
  }

  async function toggle(type, channel) {
    const key = `${type.id}:${channel}`;
    const row = type.channels[channel];
    setBusy(key);
    try {
      applySaved(await saveNotificationChannel(type.id, channel, { ...bodyOf(row), enabled: !row?.enabled }));
    } catch (err) {
      setCardError(e => ({ ...e, [type.id]: `${LABEL[channel]}: ${err.message}` }));
    } finally {
      setBusy(null);
    }
  }

  // Why a chip cannot be switched ON. A channel that is already on can always be switched off.
  function blockedReason(type, channel) {
    if (!data.ready) return 'Run migration 095 on this database first';
    if (type.channels[channel]?.enabled) return null;
    if (channel === 'push' && !type.has_push_text) return 'No push text is written for this notification';
    if (PHONE.has(channel) && type.audience === 'customer' && !data.customer_phone_consent) {
      return 'Customers have not agreed to SMS or WhatsApp messages yet';
    }
    return null;
  }

  function renderCard(type) {
    return (
      <div key={type.id} style={s.card}>
        <div style={s.name}>{type.label}</div>
        <div style={s.slug}>{type.slug}</div>

        <div style={s.chips}>
          {ORDER.map(channel => {
            const key = `${type.id}:${channel}`;
            const on = !!type.channels[channel]?.enabled;
            const reason = blockedReason(type, channel);
            const disabled = !!reason || busy === key;
            return (
              <button key={channel} type="button" title={reason ?? undefined} disabled={disabled}
                aria-pressed={on} style={s.chip(on, open === key, !!reason)}
                onClick={() => (PHONE.has(channel) ? setOpen(o => (o === key ? null : key)) : toggle(type, channel))}>
                {LABEL[channel]} · {busy === key ? '…' : on ? 'On' : 'Off'}
              </button>
            );
          })}
        </div>

        {['sms', 'whatsapp'].filter(c => type.channels[c]?.enabled).map(c => (
          <div key={c} style={s.summary}>{phoneSummary(c, type.channels[c])}</div>
        ))}
        {cardError[type.id] && <div style={s.error}>{cardError[type.id]}</div>}

        {['sms', 'whatsapp'].map(channel => open === `${type.id}:${channel}` && (
          <PhoneChannelEditor key={channel} type={type} channel={channel} providers={data.providers}
            onCancel={() => setOpen(null)}
            onSaved={saved => { applySaved(saved); setOpen(null); }} />
        ))}
      </div>
    );
  }

  const bakers = data?.types.filter(t => t.audience !== 'customer') ?? [];
  const customers = data?.types.filter(t => t.audience === 'customer') ?? [];
  const missing = data ? ['sms', 'whatsapp'].filter(c => !data.providers[c]) : [];

  return (
    <div style={s.page}>
      <div style={s.wrap}>
        <div style={s.title}>Notifications</div>
        <p style={s.intro}>
          Choose how each notification is sent. Email and push text is written in the app. SMS and WhatsApp
          use templates approved outside Spattoo — add the template here and match its gaps to the
          notification's details.
        </p>

        {loading && <div style={s.note}>Loading…</div>}
        {loadError && <div style={s.error}>{loadError}</div>}

        {data && !data.ready && (
          <div style={s.banner(false)}>
            Migration 095 has not run on this database. These are the current defaults, and nothing can be
            changed until it runs.
          </div>
        )}
        {data && missing.length > 0 && (
          <div style={s.banner(false)}>
            {missing.map(c => (c === 'sms' ? 'MSG91' : 'AiSensy')).join(' and ')} {missing.length === 1 ? 'is' : 'are'} not
            set up on this server, so {missing.map(c => LABEL[c]).join(' and ')} messages will be skipped until{' '}
            {missing.length === 1 ? 'it is' : 'they are'}.
          </div>
        )}

        {data && (
          <>
            <div style={s.section}>Sent to bakers</div>
            {bakers.map(renderCard)}

            <div style={s.section}>Sent to customers</div>
            {!data.customer_phone_consent && (
              <p style={s.note}>SMS and WhatsApp stay off for customers until they can agree to receive them.</p>
            )}
            {customers.map(renderCard)}
          </>
        )}
      </div>
    </div>
  );
}
