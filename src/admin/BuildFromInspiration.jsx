import { useState, useEffect } from 'react';
import { analyzeInspiration } from '../lib/api.js';

// Build from Inspiration (Phase 1: understand + display). Upload a cake photo → GPT-4o validates
// it's a cake, then returns a TIER-WISE reconstruction spec which we render as a human-readable
// breakdown + the raw JSON. No element matching / composition yet — this just produces the spec.
// The image is analysed via base64 (downscaled client-side), so there's no R2 upload.

const MAX_DIM = 1536;

// Shrink + re-encode to JPEG so the base64 payload stays small and the API's json limit is safe.
async function downscaleToJpeg(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
  } finally { URL.revokeObjectURL(url); }
}

function Swatch({ hex, name, big }) {
  if (!hex) return <span style={{ fontSize: 12, color: '#9BB5A2' }}>—</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, verticalAlign: 'middle' }}>
      <span style={{ width: big ? 20 : 14, height: big ? 20 : 14, borderRadius: 4, background: hex, border: '1px solid rgba(0,0,0,0.18)', flexShrink: 0 }} />
      <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433' }}>{hex}{name ? ` · ${name}` : ''}</span>
    </span>
  );
}

function Field({ label, children }) {
  if (children == null || children === '' || children === '—') return null;
  return <div style={{ fontSize: 12.5, color: '#3D5A44' }}><span style={{ color: '#6B8C74', fontWeight: 700 }}>{label}: </span>{children}</div>;
}

export default function BuildFromInspiration() {
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [rejection, setRejection] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  function pick(f) {
    if (!f) return;
    setError(null); setRejection(null); setAnalysis(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(f); setPreviewUrl(URL.createObjectURL(f));
  }

  async function analyze() {
    if (!file) return;
    setBusy(true); setError(null); setRejection(null); setAnalysis(null);
    try {
      const blob = await downscaleToJpeg(file);
      const res = await analyzeInspiration(blob);
      if (!res.ok) { setRejection({ reason: res.reason, category: res.category }); return; }
      setAnalysis(res.analysis);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  function copyJson() {
    navigator.clipboard?.writeText(JSON.stringify(analysis, null, 2)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }

  const cake = analysis?.cake;

  return (
    <div style={S.page}>
      <div style={S.title}>Build from Inspiration</div>
      <div style={S.sub}>Upload a cake photo. We read it and write out everything needed to rebuild it — tiers, colours and decorations — as a reconstruction spec. (Reading only for now; matching to your library comes next.)</div>

      <div style={S.layout}>
        {/* LEFT — upload */}
        <div style={S.colCard}>
          <div style={S.sectionTitle}>Inspiration image</div>
          <label style={S.drop}>
            {previewUrl
              ? <img src={previewUrl} alt="preview" style={S.preview} />
              : <span style={{ color: '#6B8C74', fontWeight: 700 }}>Click to choose a cake photo (PNG / JPG)</span>}
            <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; pick(f); }} />
          </label>
          <button style={S.primaryBtn(!file || busy)} onClick={analyze} disabled={!file || busy}>
            {busy ? 'Reading…' : 'Read the cake'}
          </button>
          {rejection && (
            <div style={S.warn}>
              <div style={{ fontWeight: 800, marginBottom: 4 }}>This image isn't a good fit</div>
              <div>{rejection.reason}</div>
            </div>
          )}
          {error && <div style={S.err}>{error}</div>}
          <div style={S.hint}>We validate it's a single cake before reading. The photo stays as inspiration — nothing is uploaded.</div>
        </div>

        {/* RIGHT — results */}
        <div style={S.colCard}>
          {!analysis && <div style={{ ...S.hint, textAlign: 'center', padding: '40px 0' }}>The cake breakdown will appear here.</div>}
          {analysis && (
            <>
              {/* summary */}
              <div style={S.section}>
                <div style={S.sectionTitle}>Cake</div>
                <Field label="Tiers">{cake?.tier_count}</Field>
                <Field label="Shape">{cake?.shape}</Field>
                <Field label="Style">{cake?.style}</Field>
                {cake?.board?.present && <Field label="Board"><Swatch hex={cake.board.color_hex} /></Field>}
                {typeof analysis.confidence === 'number' && <Field label="Confidence">{Math.round(analysis.confidence * 100)}%</Field>}
                {analysis.observations && <div style={{ ...S.hint, marginTop: 8 }}>{analysis.observations}</div>}
              </div>

              {/* palette */}
              {Array.isArray(analysis.palette) && analysis.palette.length > 0 && (
                <div style={S.section}>
                  <div style={S.sectionTitle}>Palette</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                    {analysis.palette.map((c, i) => <Swatch key={i} hex={c.hex} name={c.name} big />)}
                  </div>
                </div>
              )}

              {/* tiers */}
              {(analysis.tiers || []).map((t, i) => (
                <div key={i} style={S.tierCard}>
                  <div style={S.tierHead}>{t.position ? t.position[0].toUpperCase() + t.position.slice(1) : `Tier ${t.index ?? i}`} tier</div>
                  {t.frosting && (
                    <div style={{ marginBottom: 8 }}>
                      <Field label="Frosting">{[t.frosting.type, t.frosting.finish].filter(Boolean).join(', ')}</Field>
                      <Field label="Base colour"><Swatch hex={t.frosting.base_color_hex} name={t.frosting.color_name} /></Field>
                    </div>
                  )}
                  <div style={{ ...S.sectionTitle, marginTop: 4 }}>Decorations ({(t.decorations || []).length})</div>
                  {(t.decorations || []).length === 0 && <div style={S.hint}>None observed on this tier.</div>}
                  {(t.decorations || []).map((d, j) => (
                    <div key={j} style={S.decoRow}>
                      <div style={{ fontWeight: 800, color: '#2C4433', fontSize: 13 }}>
                        {[d.type, d.subtype].filter(Boolean).join(' · ').replace(/_/g, ' ')}
                        {d.text ? ` — “${d.text}”` : ''}
                      </div>
                      <Field label="Placement">{d.placement?.replace(/_/g, ' ')}</Field>
                      <Field label="Colour"><Swatch hex={d.color_hex} /></Field>
                      <Field label="Material">{d.material}</Field>
                      <Field label="Technique">{d.technique}</Field>
                      <Field label="Count">{d.count}</Field>
                      {d.notes && <Field label="Notes">{d.notes}</Field>}
                    </div>
                  ))}
                </div>
              ))}

              {/* raw json */}
              <div style={{ ...S.section, marginBottom: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={S.sectionTitle}>Reconstruction JSON</div>
                  <button style={S.copyBtn} onClick={copyJson}>{copied ? 'Copied ✓' : 'Copy'}</button>
                </div>
                <pre style={S.json}>{JSON.stringify(analysis, null, 2)}</pre>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const S = {
  page: { minHeight: '100vh', background: '#EDEAE2', fontFamily: 'Quicksand, sans-serif', padding: '32px 24px' },
  title: { fontSize: 22, fontWeight: 800, color: '#2C4433', marginBottom: 6 },
  sub: { fontSize: 13, color: '#6B8C74', fontWeight: 600, marginBottom: 24, maxWidth: 760 },
  layout: { display: 'grid', gridTemplateColumns: '360px minmax(0, 1fr)', gap: 20, maxWidth: 1200, margin: '0 auto', alignItems: 'start' },
  colCard: { background: '#fff', borderRadius: 18, border: '1.5px solid #C5D4C8', padding: 22 },
  section: { marginBottom: 22 },
  sectionTitle: { fontSize: 11, fontWeight: 700, color: '#6B8C74', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 },
  drop: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 220, borderRadius: 14, border: '2px dashed #C5D4C8', background: '#F4F8F5', cursor: 'pointer', overflow: 'hidden' },
  preview: { maxWidth: '100%', maxHeight: 280, borderRadius: 12, objectFit: 'contain' },
  primaryBtn: (d) => ({ width: '100%', padding: '13px 0', borderRadius: 10, border: 'none', background: d ? '#9BB5A2' : '#3D5A44', color: '#fff', fontFamily: 'Quicksand, sans-serif', fontSize: 15, fontWeight: 800, cursor: d ? 'not-allowed' : 'pointer', marginTop: 14 }),
  tierCard: { border: '1.5px solid #E2E8E4', borderRadius: 12, padding: '12px 14px', marginBottom: 12, background: '#F9FBFA' },
  tierHead: { fontSize: 14, fontWeight: 800, color: '#2C4433', marginBottom: 8 },
  decoRow: { borderTop: '1px solid #ECF1ED', padding: '8px 0', display: 'flex', flexDirection: 'column', gap: 3 },
  warn: { marginTop: 12, padding: '12px 14px', borderRadius: 10, fontSize: 12.5, fontWeight: 600, background: '#FFF8E6', color: '#8A6D1A', border: '1.5px solid #EAD9A0' },
  err: { marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, background: '#FFF0F0', color: '#C0392B' },
  hint: { fontSize: 11, color: '#9BB5A2', fontWeight: 600, marginTop: 8 },
  copyBtn: { padding: '4px 12px', borderRadius: 6, border: '1.5px solid #C5D4C8', background: '#fff', color: '#3D5A44', fontFamily: 'Quicksand, sans-serif', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
  json: { background: '#1f2a22', color: '#d6e6d8', borderRadius: 10, padding: 14, fontSize: 11.5, lineHeight: 1.5, overflow: 'auto', maxHeight: 380, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
};
