import { useState } from 'react';
// FULL ("max") metadata — the default "min" bundle only length-checks and wrongly
// accepts junk like "123123123" for IN. "max" enforces real per-country patterns.
import { isValidPhoneNumber, getCountries, getCountryCallingCode } from 'libphonenumber-js/max';
import { createBaker, getSignedUploadUrl, uploadToR2 } from '../lib/api.js';

// Note: no subscription/tier picker here — every baker starts on the one-time Spark trial
// automatically (api bakerProvisioning). Plan changes happen in the Baker Subscriptions screen.

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Full ISO-3166 country list (from libphonenumber-js) for the phone-region select —
// international-ready from day one. Names via Intl.DisplayNames; sorted A→Z.
const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
const COUNTRY_OPTIONS = getCountries()
  .map(code => ({ code, calling: getCountryCallingCode(code), name: REGION_NAMES.of(code) || code }))
  .sort((a, b) => a.name.localeCompare(b.name));

const EMPTY_FORM = {
  name: '',
  slug: '',
  email: '',
  tagline: '',
  instagram_handle: '',
  website_url: '',
  primary_color: '#3D5A44',
  accent_color: '#C5D4C8',
  currency_code: 'INR',
  timezone: 'Asia/Kolkata',
  user_first_name: '',
  user_last_name: '',
  user_email: '',
  user_phone_country: 'IN',
  user_phone: '',
  user_whatsapp: '',
};

export default function OnboardBaker() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [logoFile, setLogoFile] = useState(null);
  const [slugManual, setSlugManual] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErr, setFieldErr] = useState({});
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }));
  }

  function handleNameChange(e) {
    const value = e.target.value;
    set('name', value);
    if (!slugManual) set('slug', slugify(value));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    // Phone required + valid (E.164 for form.user_phone_country); WhatsApp valid if given.
    // Server re-validates + enforces one-phone-per-baker; this is just fast UX.
    const fe = {};
    if (!form.user_phone.trim()) fe.phone = 'Phone is required';
    else if (!isValidPhoneNumber(form.user_phone, form.user_phone_country)) fe.phone = 'Enter a valid phone number';
    if (form.user_whatsapp.trim() && !isValidPhoneNumber(form.user_whatsapp, form.user_phone_country)) fe.whatsapp = 'Enter a valid WhatsApp number';
    setFieldErr(fe);
    if (Object.keys(fe).length) return;

    setSaving(true);
    try {
      const { user_first_name, user_last_name, user_email, user_phone_country, user_phone, user_whatsapp, ...baker } = form;

      if (logoFile) {
        const ext = logoFile.name.split('.').pop();
        const filename = `${crypto.randomUUID()}.${ext}`;
        const { url, key } = await getSignedUploadUrl('logos', filename, logoFile.type);
        await uploadToR2(url, logoFile);
        baker.logo_url = key;
      }

      const data = await createBaker({
        ...baker,
        primaryUser: {
          first_name:      user_first_name,
          last_name:       user_last_name,
          email:           user_email,
          phone:           user_phone,
          phone_country:   user_phone_country,
          whatsapp_number: user_whatsapp || null,
        },
      });
      setResult(data);
    } catch (err) {
      // A phone-uniqueness conflict (409) reads best under the phone field.
      if (/phone/i.test(err.message)) setFieldErr({ phone: err.message });
      else setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function copyPassword() {
    navigator.clipboard.writeText(result.tempPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (result) {
    return (
      <div style={s.page}>
        <div style={s.card}>
          <div style={s.successTitle}>Baker created!</div>
          <div style={s.successSub}>Share these login details with the primary user.</div>

          <div style={s.credBox}>
            <div style={s.credRow}>
              <span style={s.credLabel}>Name</span>
              <span style={s.credValue}>{form.user_first_name} {form.user_last_name}</span>
            </div>
            <div style={s.credRow}>
              <span style={s.credLabel}>Login email</span>
              <span style={s.credValue}>{form.user_email}</span>
            </div>
            <div style={s.credRow}>
              <span style={s.credLabel}>Temp password</span>
              <span style={s.credValue}>{result.tempPassword}</span>
            </div>
          </div>

          <button style={s.copyBtn} onClick={copyPassword}>
            {copied ? 'Copied' : 'Copy password'}
          </button>

          <button style={s.anotherBtn} onClick={() => {
            setResult(null);
            setForm(EMPTY_FORM);
            setLogoFile(null);
            setSlugManual(false);
          }}>
            + Onboard another baker
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <div style={s.card}>
        <div style={s.pageTitle}>Onboard Baker</div>

        <form onSubmit={handleSubmit} style={s.form}>

          {/* ── Bakery ── */}
          <div style={s.sectionLabel}>Bakery</div>

          <label style={s.label}>Business name *</label>
          <input
            style={s.input}
            value={form.name}
            onChange={handleNameChange}
            placeholder="Sweet Dreams Bakery"
            required
          />

          <label style={s.label}>Slug * <span style={s.hint}>used in URLs</span></label>
          <input
            style={s.input}
            value={form.slug}
            onChange={e => { setSlugManual(true); set('slug', slugify(e.target.value)); }}
            placeholder="sweet-dreams-bakery"
            required
          />

          <label style={s.label}>Tagline</label>
          <input
            style={s.input}
            value={form.tagline}
            onChange={e => set('tagline', e.target.value)}
            placeholder="Baked with love, served with joy"
          />

          {/* ── Primary User ── */}
          <div style={{ ...s.sectionLabel, marginTop: 20 }}>Primary User</div>

          <div style={s.twoCol}>
            <div>
              <label style={s.label}>First name *</label>
              <input
                style={s.input}
                value={form.user_first_name}
                onChange={e => set('user_first_name', e.target.value)}
                placeholder="Jane"
                required
              />
            </div>
            <div>
              <label style={s.label}>Last name *</label>
              <input
                style={s.input}
                value={form.user_last_name}
                onChange={e => set('user_last_name', e.target.value)}
                placeholder="Smith"
                required
              />
            </div>
          </div>

          <label style={s.label}>Login email *</label>
          <input
            style={s.input}
            type="email"
            value={form.user_email}
            onChange={e => set('user_email', e.target.value)}
            placeholder="jane@sweetdreams.com"
            required
          />

          <label style={s.label}>Country <span style={s.hint}>region for phone numbers</span></label>
          <select
            style={s.input}
            value={form.user_phone_country}
            onChange={e => set('user_phone_country', e.target.value)}
          >
            {COUNTRY_OPTIONS.map(c => (
              <option key={c.code} value={c.code}>{c.name} (+{c.calling})</option>
            ))}
          </select>

          <div style={s.twoCol}>
            <div>
              <label style={s.label}>Phone *</label>
              <input
                style={{ ...s.input, ...(fieldErr.phone ? s.inputError : null) }}
                type="tel"
                value={form.user_phone}
                onChange={e => set('user_phone', e.target.value)}
                placeholder="98765 43210"
                required
              />
              {fieldErr.phone && <div style={s.fieldError}>{fieldErr.phone}</div>}
            </div>
            <div>
              <label style={s.label}>WhatsApp</label>
              <input
                style={{ ...s.input, ...(fieldErr.whatsapp ? s.inputError : null) }}
                type="tel"
                value={form.user_whatsapp}
                onChange={e => set('user_whatsapp', e.target.value)}
                placeholder="98765 43210"
              />
              {fieldErr.whatsapp && <div style={s.fieldError}>{fieldErr.whatsapp}</div>}
            </div>
          </div>

          {/* ── Business Contact ── */}
          <div style={{ ...s.sectionLabel, marginTop: 20 }}>Business Contact</div>

          <label style={s.label}>Business email</label>
          <input
            style={s.input}
            type="email"
            value={form.email}
            onChange={e => set('email', e.target.value)}
            placeholder="hello@sweetdreams.com"
          />

          <label style={s.label}>Instagram handle</label>
          <div style={s.prefixWrap}>
            <span style={s.prefix}>@</span>
            <input
              style={{ ...s.input, borderRadius: '0 8px 8px 0', flex: 1 }}
              value={form.instagram_handle}
              onChange={e => set('instagram_handle', e.target.value)}
              placeholder="sweetdreamsbakery"
            />
          </div>

          <label style={s.label}>Website</label>
          <input
            style={s.input}
            type="url"
            value={form.website_url}
            onChange={e => set('website_url', e.target.value)}
            placeholder="https://sweetdreams.com"
          />

          {/* ── Branding ── */}
          <div style={{ ...s.sectionLabel, marginTop: 20 }}>Branding</div>

          <div style={s.twoCol}>
            <div>
              <label style={s.label}>Primary color</label>
              <div style={s.colorWrap}>
                <input type="color" value={form.primary_color}
                  onChange={e => set('primary_color', e.target.value)}
                  style={s.colorSwatch} />
                <input style={{ ...s.input, flex: 1, fontFamily: 'monospace', fontSize: 12 }}
                  value={form.primary_color}
                  onChange={e => set('primary_color', e.target.value)} />
              </div>
            </div>
            <div>
              <label style={s.label}>Accent color</label>
              <div style={s.colorWrap}>
                <input type="color" value={form.accent_color}
                  onChange={e => set('accent_color', e.target.value)}
                  style={s.colorSwatch} />
                <input style={{ ...s.input, flex: 1, fontFamily: 'monospace', fontSize: 12 }}
                  value={form.accent_color}
                  onChange={e => set('accent_color', e.target.value)} />
              </div>
            </div>
          </div>

          <label style={s.label}>Logo</label>
          <label style={s.fileBox}>
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={e => setLogoFile(e.target.files[0] ?? null)}
            />
            {logoFile ? (
              <img
                src={URL.createObjectURL(logoFile)}
                alt="logo preview"
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            ) : (
              <span style={{ fontSize: 12, color: '#6B8C74' }}>Click to choose logo image</span>
            )}
          </label>
          {logoFile && (
            <button
              type="button"
              style={{ ...s.clearBtn, marginTop: 6 }}
              onClick={() => setLogoFile(null)}
            >
              Remove
            </button>
          )}

          {/* ── Locale ── */}
          <div style={{ ...s.sectionLabel, marginTop: 20 }}>Locale</div>

          <div style={s.twoCol}>
            <div>
              <label style={s.label}>Currency</label>
              <input style={s.input} value={form.currency_code}
                onChange={e => set('currency_code', e.target.value.toUpperCase())}
                placeholder="INR" maxLength={3} />
            </div>
            <div>
              <label style={s.label}>Timezone</label>
              <input style={s.input} value={form.timezone}
                onChange={e => set('timezone', e.target.value)}
                placeholder="Asia/Kolkata" />
            </div>
          </div>

          {error && <div style={s.errorMsg}>{error}</div>}

          <button type="submit" style={{ ...s.submitBtn, opacity: saving ? 0.7 : 1 }} disabled={saving}>
            {saving ? 'Creating baker…' : 'Create baker'}
          </button>
        </form>
      </div>
    </div>
  );
}

const s = {
  page: {
    minHeight: '100vh', background: '#EDEAE2',
    fontFamily: 'Quicksand, sans-serif',
    display: 'flex', justifyContent: 'center',
    padding: '40px 20px',
  },
  card: {
    background: '#fff', borderRadius: 16,
    padding: '32px 36px', width: '100%', maxWidth: 540,
    boxShadow: '0 4px 24px rgba(0,0,0,0.07)',
    border: '1.5px solid #C5D4C8',
    alignSelf: 'flex-start',
  },
  pageTitle: {
    fontSize: 20, fontWeight: 800, color: '#2C4433',
    marginBottom: 24, letterSpacing: 0.3,
  },
  sectionLabel: {
    fontSize: 10, fontWeight: 700, color: '#6B8C74',
    letterSpacing: 1.5, textTransform: 'uppercase',
    marginBottom: 10, paddingBottom: 6,
    borderBottom: '1px solid #E8EDE9',
  },
  form:  { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 11, fontWeight: 700, color: '#4A7459', letterSpacing: 0.3, marginTop: 8 },
  hint:  { fontSize: 10, fontWeight: 500, color: '#9BB5A3', marginLeft: 4 },
  input: {
    padding: '9px 12px', border: '1.5px solid #C5D4C8', borderRadius: 8,
    fontSize: 13, color: '#2C4433', outline: 'none',
    fontFamily: 'Quicksand, sans-serif', background: '#FAFCFA',
    width: '100%', boxSizing: 'border-box',
  },
  twoCol: { display: 'flex', gap: 12 },
  prefixWrap: { display: 'flex', alignItems: 'stretch' },
  prefix: {
    background: '#E8EDE9', border: '1.5px solid #C5D4C8',
    borderRight: 'none', borderRadius: '8px 0 0 8px',
    padding: '9px 10px', fontSize: 13, color: '#6B8C74', fontWeight: 700,
  },
  fileBox: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    width: 120, height: 120, border: '1.5px dashed #C5D4C8', borderRadius: 10,
    background: '#F4F8F5', cursor: 'pointer', overflow: 'hidden', flexShrink: 0,
  },
  clearBtn: {
    padding: '5px 12px', border: '1.5px solid #C5D4C8', borderRadius: 6,
    background: '#fff', color: '#6B8C74', fontSize: 11, fontWeight: 700,
    cursor: 'pointer', fontFamily: 'Quicksand, sans-serif',
  },
  colorWrap:   { display: 'flex', alignItems: 'center', gap: 8 },
  colorSwatch: {
    width: 36, height: 36, border: '1.5px solid #C5D4C8',
    borderRadius: 8, cursor: 'pointer', padding: 2, background: 'none',
  },
  errorMsg: {
    background: '#FFF0F0', border: '1.5px solid #F5C0C0',
    borderRadius: 8, padding: '10px 14px',
    color: '#C0392B', fontSize: 12, fontWeight: 600, marginTop: 8,
  },
  inputError:  { borderColor: '#E39B9B', background: '#FFF7F7' },
  fieldError:  { fontSize: 11, fontWeight: 600, color: '#C0392B', marginTop: 4 },
  submitBtn: {
    marginTop: 20, padding: '13px',
    background: '#3D5A44', color: '#fff',
    border: 'none', borderRadius: 10,
    fontSize: 14, fontWeight: 700, cursor: 'pointer',
    fontFamily: 'Quicksand, sans-serif',
    boxShadow: '0 4px 14px rgba(61,90,68,0.25)',
  },
  successTitle: { fontSize: 22, fontWeight: 800, color: '#2C4433', marginBottom: 6 },
  successSub:   { fontSize: 13, color: '#6B8C74', marginBottom: 24 },
  credBox: {
    background: '#F4F8F5', border: '1.5px solid #C5D4C8',
    borderRadius: 10, padding: '14px 18px',
    display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16,
  },
  credRow:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  credLabel: { fontSize: 11, fontWeight: 700, color: '#6B8C74', letterSpacing: 0.3, minWidth: 100 },
  credValue: { fontSize: 13, fontWeight: 700, color: '#2C4433', fontFamily: 'monospace', wordBreak: 'break-all' },
  copyBtn: {
    width: '100%', padding: '11px',
    background: '#3D5A44', color: '#fff',
    border: 'none', borderRadius: 10,
    fontSize: 13, fontWeight: 700, cursor: 'pointer',
    fontFamily: 'Quicksand, sans-serif', marginBottom: 10,
  },
  anotherBtn: {
    width: '100%', padding: '11px',
    background: '#fff', color: '#3D5A44',
    border: '1.5px solid #C5D4C8', borderRadius: 10,
    fontSize: 13, fontWeight: 700, cursor: 'pointer',
    fontFamily: 'Quicksand, sans-serif',
  },
};
