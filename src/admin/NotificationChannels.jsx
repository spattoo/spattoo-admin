import { useState, useEffect } from 'react';
import {
  fetchNotificationChannels, saveNotificationChannel, sendNotificationChannelTest,
  exportNotificationChannels, importNotificationChannels,
} from '../lib/api.js';

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
  ok:         { padding: '8px 12px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: '#E8F5E9', color: '#2E7D32', marginTop: 10, wordBreak: 'break-word' },
  testBox:    { marginTop: 18, paddingTop: 14, borderTop: '1px solid #DDE6DF' },
  testBtn:    busy => ({ padding: '9px 18px', borderRadius: 10, border: '1.5px solid #3D5A44', background: '#fff', color: busy ? '#9BB5A2' : '#3D5A44', fontFamily: font, fontSize: 14, fontWeight: 800, cursor: busy ? 'not-allowed' : 'pointer' }),
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

  const [testPhone, setTestPhone]   = useState('');
  const [testing, setTesting]       = useState(false);
  const [testResult, setTestResult] = useState(null);   // { ok, text }

  const setVar = (i, pair) => setVars(v => v.map((p, j) => (j === i ? pair : p)));

  // The template as it stands in the editor — what Save stores and what Send test sends.
  const configNow = () => (isSms
    ? { variables: Object.fromEntries(vars.map(([k, field]) => [k.trim(), field])) }
    : { params: vars.map(([, field]) => field), ...(image ? { image_field: image } : {}) });
  const duplicateNames = () => {
    const names = vars.map(([k]) => k.trim());
    return isSms && new Set(names).size !== names.length;
  };

  // What filled the gaps, in words, so the admin can match it against the message on their phone.
  const describe = values => (isSms
    ? Object.entries(values ?? {}).map(([k, v]) => `${k} = ${v}`).join(', ')
    : [...(values?.params ?? []).map((v, i) => `{{${i + 1}}} = ${v}`), values?.image ? 'an image' : null].filter(Boolean).join(', '));

  async function sendTest() {
    if (duplicateNames()) return setTestResult({ ok: false, text: 'Two variables have the same name.' });
    setTesting(true);
    setTestResult(null);
    try {
      const r = await sendNotificationChannelTest(type.id, channel, {
        phone: testPhone, template_ref: ref.trim() || null, config: configNow(),
      });
      const filledWith = describe(r.values);
      setTestResult({ ok: true, text: `Sent to ${r.to}${filledWith ? ` with ${filledWith}` : ''}. It can take a minute to arrive.` });
    } catch (err) {
      setTestResult({ ok: false, text: err.message });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (duplicateNames()) return setError('Two variables have the same name.');
    setSaving(true);
    setError(null);
    const config = configNow();
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

      {/* Beside the template it tests, so a wrong variable is fixed and re-sent without leaving the card. */}
      <div style={s.testBox}>
        <label style={{ ...s.label, marginTop: 0 }}>Send a test to your phone</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input style={{ ...s.input, flex: '1 1 180px', width: 'auto' }} type="tel" inputMode="tel" autoComplete="tel"
            value={testPhone} onChange={e => setTestPhone(e.target.value)} placeholder="+91 98765 43210" />
          <button type="button" style={s.testBtn(testing || !testPhone.trim())} disabled={testing || !testPhone.trim()} onClick={sendTest}>
            {testing ? 'Sending…' : 'Send test'}
          </button>
        </div>
        <div style={s.hint}>
          Sends a real {LABEL[channel]} message using this editor as it is now (saved or not), filled with the
          details of the latest real notification.
        </div>
        {testResult && <div style={testResult.ok ? s.ok : s.error}>{testResult.text}</div>}
      </div>
    </div>
  );
}

// ── Importing settings from the other server ────────────────────────────────────────────────────
// Shown above the cards it will change. The server decides what each row does (preview = a dry run);
// this only lays it out: what is new, what changes and how, and what is skipped and why.
const STATUS_WORD = { new: 'New', changed: 'Changes', same: 'Unchanged', skipped: 'Skipped' };

function ImportPreview({ importing, onCopyOnOff, onApply, onClose }) {
  const { fileName, copyOnOff, preview, busy, error, applied } = importing;
  const rows = preview?.rows ?? [];
  const worth = rows.filter(r => r.status !== 'same');
  const sum = preview?.summary ?? {};
  const toApply = (sum.new ?? 0) + (sum.changed ?? 0);
  const from = preview?.source
    ? `Exported from ${preview.source}${preview.exported_at ? ` on ${new Date(preview.exported_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}` : ''}.`
    : null;

  return (
    <div style={{ ...s.card, borderColor: '#3D5A44' }}>
      <div style={s.name}>{applied ? 'Imported' : 'Import'} · {fileName}</div>
      {from && <div style={s.slug}>{from}</div>}

      <label style={{ ...s.check, marginTop: 12 }}>
        <input type="checkbox" checked={copyOnOff} disabled={busy || applied} onChange={e => onCopyOnOff(e.target.checked)} />
        Also copy which channels are on or off
      </label>
      <div style={s.hint}>
        Left unticked, each setting arrives with this server's on/off unchanged — a new one arrives off — so
        you can Send test before switching it on.
      </div>

      {busy && <div style={{ ...s.note, marginTop: 10 }}>{applied ? 'Importing…' : 'Checking the file…'}</div>}
      {error && <div style={s.error}>{error}</div>}

      {preview && (
        <>
          <div style={{ ...s.summary, marginTop: 12, fontWeight: 800, color: '#2C4433' }}>
            {applied
              ? `Imported ${sum.applied ?? 0} setting${sum.applied === 1 ? '' : 's'}${sum.skipped ? ` · ${sum.skipped} skipped` : ''}.`
              : `${sum.new ?? 0} new · ${sum.changed ?? 0} changed · ${sum.same ?? 0} unchanged · ${sum.skipped ?? 0} skipped`}
          </div>
          {worth.map(r => (
            <div key={`${r.type_slug}:${r.channel}`} style={{ ...s.summary, paddingTop: 6, borderTop: '1px solid #EDF0EC' }}>
              <b style={{ color: '#2C4433' }}>{r.type_label ?? r.type_slug}</b> · {LABEL[r.channel] ?? r.channel} ·{' '}
              <span style={{ color: r.status === 'skipped' ? '#C0392B' : '#3D5A44', fontWeight: 800 }}>{STATUS_WORD[r.status]}</span>
              {r.changes?.length ? ` — ${r.changes.join(', ')}` : ''}
              {r.reason ? ` — ${r.reason}` : ''}
              {r.status !== 'skipped' ? ` · ${r.enabled_after ? 'on' : 'off'} after import` : ''}
            </div>
          ))}
        </>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
        {!applied && (
          <button type="button" style={s.saveBtn(busy || !toApply)} disabled={busy || !toApply} onClick={onApply}>
            {toApply ? `Import ${toApply} setting${toApply === 1 ? '' : 's'}` : 'Nothing to import'}
          </button>
        )}
        <button type="button" style={s.cancelBtn} onClick={onClose}>{applied ? 'Done' : 'Cancel'}</button>
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

  // Moving these settings to another server. `importing` is the file being imported and its preview:
  // { bundle, fileName, copyOnOff, preview, busy, error, applied }.
  const [transferMsg, setTransferMsg] = useState(null);
  const [importing, setImporting]     = useState(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try { setData(await fetchNotificationChannels()); setLoadError(null); }
    catch (err) { setLoadError(err.message); }
    finally { setLoading(false); }
  }

  async function exportSettings() {
    setTransferMsg(null);
    try {
      const bundle = await exportNotificationChannels();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `notification-channels-${bundle.source ?? 'spattoo'}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setTransferMsg({ ok: true, text: `Exported ${bundle.channels.length} channel settings. Import the file on the other server.` });
    } catch (err) {
      setTransferMsg({ ok: false, text: err.message });
    }
  }

  // Always a dry run first: nothing changes until the admin has seen what will.
  async function previewImport(bundle, fileName, copyOnOff) {
    setImporting({ bundle, fileName, copyOnOff, preview: null, busy: true, error: null, applied: false });
    try {
      const preview = await importNotificationChannels({ bundle, copyOnOff, apply: false });
      setImporting({ bundle, fileName, copyOnOff, preview, busy: false, error: null, applied: false });
    } catch (err) {
      setImporting({ bundle, fileName, copyOnOff, preview: null, busy: false, error: err.message, applied: false });
    }
  }

  async function onImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';   // so choosing the same file again still fires
    if (!file) return;
    setTransferMsg(null);
    let bundle;
    try { bundle = JSON.parse(await file.text()); }
    catch { return setTransferMsg({ ok: false, text: `${file.name} is not a notification settings file.` }); }
    previewImport(bundle, file.name, false);
  }

  async function applyImport() {
    const { bundle, copyOnOff } = importing;
    setImporting(s => ({ ...s, busy: true, error: null }));
    try {
      const result = await importNotificationChannels({ bundle, copyOnOff, apply: true });
      // Kept open after applying, so anything skipped still shows its reason.
      setImporting(s => ({ ...s, preview: result, busy: false, applied: true }));
      await load();
    } catch (err) {
      setImporting(s => ({ ...s, busy: false, error: err.message }));
    }
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

        {data?.ready && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
            <button type="button" style={s.testBtn(false)} onClick={exportSettings}>Export settings</button>
            <label style={{ ...s.testBtn(!!importing?.busy), display: 'inline-block' }}>
              Import settings
              <input type="file" accept="application/json,.json" hidden disabled={!!importing?.busy} onChange={onImportFile} />
            </label>
          </div>
        )}
        {data?.ready && (
          <p style={{ ...s.hint, marginTop: 0, marginBottom: 14 }}>
            Set templates up once: export them here and import the file on the other server (dev ↔ production).
          </p>
        )}
        {transferMsg && <div style={transferMsg.ok ? s.ok : s.error}>{transferMsg.text}</div>}

        {importing && <ImportPreview importing={importing}
          onCopyOnOff={checked => previewImport(importing.bundle, importing.fileName, checked)}
          onApply={applyImport} onClose={() => setImporting(null)} />}

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
