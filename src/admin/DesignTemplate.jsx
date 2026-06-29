import { useState, useEffect, useMemo } from 'react';
import { CakeDesigner } from '@spattoo/designer';
import { supabase } from '../lib/supabase.js';
import { fetchAdminBakers, getSignedUploadUrl, uploadToR2, createTemplate } from '../lib/api.js';

const BASE_URL = import.meta.env.VITE_API_URL;

function createAdminApiClient(bakerId = null) {
  async function authFetch(path, opts = {}) {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`${BASE_URL}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        ...(opts.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
    return res.json();
  }

  return {
    fetchElementTypes: () => authFetch('/api/element-types'),
    fetchTextures: () => authFetch('/api/textures'),
    fetchMaterials: () => authFetch('/api/materials'),
    fetchElements: (opts = {}) => {
      const p = new URLSearchParams();
      if (opts.parentsOnly)    p.set('parents_only', 'true');
      if (opts.elementTypeId)  p.set('element_type_id', opts.elementTypeId);
      const qs = p.toString();
      return authFetch(`/api/elements${qs ? `?${qs}` : ''}`);
    },
    // When scoped to a baker, pass baker_id so the templates panel shows
    // what that baker sees (global + their own), matching the baker's designer.
    fetchTemplates: () => {
      const qs = bakerId ? `?baker_id=${bakerId}` : '';
      return authFetch(`/api/templates${qs}`);
    },
    fetchTemplate:      (id) => authFetch(`/api/templates/${id}`),
    getSignedUploadUrl: (folder, filename, contentType) =>
      authFetch('/api/storage/sign-upload', {
        method: 'POST',
        body: JSON.stringify({ folder, filename, contentType }),
      }),
    fetchBakerProfile:   () => Promise.resolve({ baker: null, user: null }),
    fetchBakerSettings:  () => Promise.resolve({}),
    updateBakerSettings: () => Promise.resolve({ ok: true }),
    updateBakerProfile:  () => Promise.resolve({ ok: true }),
    fetchBillingStatus:       () => Promise.resolve({ tier: 'trial', status: 'trial', trial_ends_at: null }),
    fetchBillingPeriods:      () => Promise.resolve([]),
    fetchSubscriptionHistory: () => Promise.resolve([]),
    activateSparkPlan:   () => Promise.resolve({ ok: true }),
    createSubscription:  () => Promise.resolve({}),
    cancelSubscription:  () => Promise.resolve({ ok: true }),
    signOut:             () => supabase.auth.signOut(),
    changePassword:      (pw) => supabase.auth.updateUser({ password: pw }),
  };
}

const s = {
  page:    { minHeight: '100vh', background: '#EDEAE2', fontFamily: "'Quicksand', sans-serif" },
  header:  { padding: '16px 28px', background: '#fff', borderBottom: '1.5px solid #C5D4C8', display: 'flex', alignItems: 'center', gap: 12 },
  title:   { fontSize: 16, fontWeight: 800, color: '#2C4433' },
  setup:   { maxWidth: 480, margin: '60px auto', padding: '0 24px' },
  card:    { background: '#fff', borderRadius: 16, border: '1.5px solid #C5D4C8', padding: 32 },
  label:   { display: 'block', fontSize: 11, fontWeight: 700, color: '#3D5A44', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 },
  option:  (active) => ({
    display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 16px',
    border: `1.5px solid ${active ? '#3D5A44' : '#C5D4C8'}`,
    borderRadius: 12, cursor: 'pointer', marginBottom: 10,
    background: active ? '#E8EDE9' : '#fff', transition: 'all 0.15s',
  }),
  radio:   (active) => ({
    width: 18, height: 18, borderRadius: '50%', border: `2px solid ${active ? '#3D5A44' : '#C5D4C8'}`,
    background: active ? '#3D5A44' : '#fff', flexShrink: 0, marginTop: 1,
    boxShadow: active ? 'inset 0 0 0 3px #fff' : 'none',
  }),
  optionTitle: { fontSize: 14, fontWeight: 700, color: '#2C4433', marginBottom: 2 },
  optionDesc:  { fontSize: 12, color: '#6B8C74', fontWeight: 500 },
  select: {
    width: '100%', padding: '10px 12px', border: '1.5px solid #C5D4C8', borderRadius: 10,
    fontSize: 13, fontFamily: "'Quicksand', sans-serif", color: '#2C4433', background: '#fff',
    outline: 'none', marginTop: 16,
  },
  btn: {
    width: '100%', padding: '12px 0', marginTop: 24, border: 'none', borderRadius: 12,
    background: '#3D5A44', color: '#fff', fontSize: 14, fontWeight: 700,
    fontFamily: "'Quicksand', sans-serif", cursor: 'pointer',
  },
  btnDisabled: { opacity: 0.45, cursor: 'not-allowed' },
};

export default function DesignTemplate() {
  const [mode, setMode]       = useState('global');
  const [bakers, setBakers]   = useState([]);
  const [bakerId, setBakerId] = useState('');
  const [loading, setLoading] = useState(false);
  const [started, setStarted] = useState(false);

  const apiClient = useMemo(
    () => createAdminApiClient(mode === 'baker' ? bakerId : null),
    [started], // freeze when designer launches
  );

  useEffect(() => {
    fetchAdminBakers()
      .then(data => setBakers(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  async function handleSaveTemplate({ name, offering, tierCount, designJson, thumbnailBlob }) {
    let thumbnailKey = null;
    if (thumbnailBlob) {
      // Extension + content type follow the captured blob (WebP, or PNG on browsers that
      // can't encode WebP via canvas) so the R2 signed PUT signature stays consistent.
      const ext = thumbnailBlob.type === 'image/webp' ? 'webp' : 'png';
      const filename = `${crypto.randomUUID()}.${ext}`;
      const { url, key } = await getSignedUploadUrl('templates/thumbnails', filename, thumbnailBlob.type);
      await uploadToR2(url, thumbnailBlob);
      thumbnailKey = key;
    }
    await createTemplate({
      name,
      shape:      'round',
      tier_count: tierCount,
      type:       'custom',
      offering,
      baker_id:   mode === 'baker' ? (bakerId || null) : null,
      design:     designJson,
      thumbnail_url: thumbnailKey,
      sort_order: 0,
    });
  }

  if (started) {
    return (
      <CakeDesigner
        apiClient={apiClient}
        onSaveTemplate={handleSaveTemplate}
        onOrder={() => {}}
      />
    );
  }

  const canStart = mode === 'global' || (mode === 'baker' && bakerId);

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Quicksand:wght@400;600;700;800&display=swap" rel="stylesheet" />
      <div style={s.page}>
        <div style={s.header}>
          <span style={s.title}>Design Template</span>
        </div>

        <div style={s.setup}>
          <div style={s.card}>
            <div style={{ ...s.label, marginBottom: 16 }}>Template scope</div>

            <div style={s.option(mode === 'global')} onClick={() => setMode('global')}>
              <div style={s.radio(mode === 'global')} />
              <div>
                <div style={s.optionTitle}>Design global template</div>
                <div style={s.optionDesc}>Available to all bakers on the platform</div>
              </div>
            </div>

            <div style={s.option(mode === 'baker')} onClick={() => setMode('baker')}>
              <div style={s.radio(mode === 'baker')} />
              <div>
                <div style={s.optionTitle}>Design template for baker</div>
                <div style={s.optionDesc}>Only visible to a specific baker's storefront</div>
              </div>
            </div>

            {mode === 'baker' && (
              <select
                style={s.select}
                value={bakerId}
                onChange={e => setBakerId(e.target.value)}
              >
                <option value="">— Select a baker —</option>
                {bakers.map(b => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            )}

            <button
              style={{ ...s.btn, ...(!canStart ? s.btnDisabled : {}) }}
              disabled={!canStart}
              onClick={() => setStarted(true)}
            >
              Start Designing
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
