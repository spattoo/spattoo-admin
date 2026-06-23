import { useState, useEffect, useMemo } from 'react';
import { CakePreview } from '@spattoo/designer';
import { analyzeInspiration, matchInspiration } from '../lib/api.js';
import { inspirationToDesign } from './inspirationToDesign.js';

// Build from Inspiration. Upload a cake photo → GPT-4o validates + reads it into a tier-wise
// reconstruction spec → match each decoration to a library element (placement-aware), shown with
// a swap dropdown + a coverage banner. The image is analysed via base64 (no R2 upload).

const MAX_DIM = 1536;
// Decoration types that aren't library elements (cake-level / special) — surfaced as a note.
const NON_MATCHED = ['drip', 'lettering'];

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

// Best + alternatives, de-duped by id (the candidates the swap dropdown offers).
function candidatesOf(m) {
  const seen = new Set();
  return [m.match, ...(m.alternatives || [])].filter(c => c && !seen.has(c.id) && seen.add(c.id));
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

// One decoration + its chosen library element (with a swap dropdown over the alternatives).
function MatchChip({ m, chosenId, onChoose }) {
  const d = m.decoration;
  const cands = candidatesOf(m);
  const chosen = cands.find(c => c.id === chosenId) || null;
  return (
    <div style={S.decoRow}>
      <div style={{ fontWeight: 800, color: '#2C4433', fontSize: 13 }}>
        {[d.type, d.subtype].filter(Boolean).join(' · ').replace(/_/g, ' ')}{d.text ? ` — “${d.text}”` : ''}
      </div>
      <div style={{ display: 'flex', gap: 10, fontSize: 11.5, color: '#6B8C74', flexWrap: 'wrap', alignItems: 'center', margin: '2px 0 6px' }}>
        {d.placement && <span>@ {d.placement.replace(/_/g, ' ')}{d.rim_side ? ` (${d.rim_side})` : ''}</span>}
        {d.color_hex && <Swatch hex={d.color_hex} />}
        {d.count && <span>×{d.count}</span>}
      </div>
      {chosen ? (
        <div style={S.matchRow}>
          {chosen.thumbnail_url
            ? <img src={chosen.thumbnail_url} alt="" style={S.matchThumb} />
            : <div style={{ ...S.matchThumb, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9BB5A2', fontSize: 9 }}>no img</div>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, color: '#2C4433', fontSize: 13 }}>
              {chosen.name} <span style={{ color: '#9BB5A2', fontWeight: 600, fontSize: 11 }}>[{chosen.element_type}]</span>
            </div>
            <div style={{ fontSize: 11, color: '#6B8C74', fontWeight: 600 }}>
              {Math.round((chosen.score || 0) * 100)}% match · placed at {chosen.matchedZone || '—'}
            </div>
          </div>
        </div>
      ) : (
        <div style={S.gap}>No confident match{cands[0] ? ` — closest: ${cands[0].name}` : ''}</div>
      )}
      {cands.length > 0 && (
        <select value={chosenId ?? ''} onChange={e => onChoose(e.target.value)} style={S.swap}>
          {cands.map(c => <option key={c.id} value={c.id}>{c.name} ({Math.round((c.score || 0) * 100)}%)</option>)}
          <option value="">— no element —</option>
        </select>
      )}
    </div>
  );
}

export default function BuildFromInspiration() {
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [rejection, setRejection] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [matching, setMatching] = useState(false);
  const [matchResult, setMatchResult] = useState(null);
  const [matchError, setMatchError] = useState(null);
  const [overrides, setOverrides] = useState({});   // "tier:idx" → chosen element id ('' = none)
  const [copied, setCopied] = useState(false);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  function resetResults() {
    setError(null); setRejection(null); setAnalysis(null);
    setMatchResult(null); setMatchError(null); setOverrides({});
  }

  function pick(f) {
    if (!f) return;
    resetResults();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(f); setPreviewUrl(URL.createObjectURL(f));
  }

  async function analyze() {
    if (!file) return;
    setBusy(true); resetResults();
    try {
      const blob = await downscaleToJpeg(file);
      const res = await analyzeInspiration(blob);
      if (!res.ok) { setRejection({ reason: res.reason, category: res.category }); return; }
      setAnalysis(res.analysis);
      // Auto-match the decorations to library elements.
      setMatching(true);
      try { setMatchResult(await matchInspiration(res.analysis)); }
      catch (e) { setMatchError(e.message); }
      finally { setMatching(false); }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const chosenIdFor = (i, j, m) => {
    const key = `${i}:${j}`;
    return overrides[key] !== undefined ? overrides[key] : (m.match?.id ?? '');
  };
  function liveCoverage() {
    let matched = 0, total = 0; const gaps = [];
    (matchResult?.tiers || []).forEach((mt, i) => (mt.matches || []).forEach((m, j) => {
      total++;
      const id = chosenIdFor(i, j, m);
      if (id && candidatesOf(m).some(c => c.id === id)) matched++;
      else gaps.push(m.decoration);
    }));
    return { matched, total, gaps };
  }

  function copyJson() {
    navigator.clipboard?.writeText(JSON.stringify(analysis, null, 2)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }

  const cake = analysis?.cake;
  const cov = matchResult ? liveCoverage() : null;
  // Tier-wise 3D reconstruction from the read spec (count + order + per-tier colour + shape) plus
  // cream piping from the matched library elements (and any swaps the user made).
  const design = useMemo(() => inspirationToDesign(analysis, matchResult, overrides), [analysis, matchResult, overrides]);

  return (
    <div style={S.page}>
      <div style={S.title}>Build from Inspiration</div>
      <div style={S.sub}>Upload a cake photo. We read it into a tier-wise spec and match each decoration to your element library — swap any pick, and the coverage shows what's missing.</div>

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
            {busy ? 'Reading…' : 'Read & match'}
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

        {/* RIGHT — 3D preview */}
        <div style={S.colCard}>
          <div style={S.sectionTitle}>3D preview</div>
          {design ? (
            <div style={S.previewStage}><CakePreview design={design} /></div>
          ) : (
            <div style={{ ...S.previewStage, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ ...S.hint, marginTop: 0, textAlign: 'center', padding: '0 24px' }}>Your 3D cake builds here from the read tiers &amp; colours.</span>
            </div>
          )}
          {design && <div style={S.hint}>Reconstructed from the read tiers, colours &amp; shape. Decorations come next.</div>}
        </div>
      </div>

      {/* results — full width, below the image + preview */}
      {analysis && (
        <div style={S.resultsCard}>
          <>
              {/* coverage / matching status */}
              {matching && <div style={{ ...S.hint, marginTop: 0 }}>Matching elements from your library…</div>}
              {matchError && <div style={S.err}>Match failed: {matchError}</div>}
              {cov && (
                <div style={S.coverage(cov.matched === cov.total && cov.total > 0)}>
                  <b>Matched {cov.matched}/{cov.total}</b>
                  {cov.gaps.length > 0 && <span> · gaps: {cov.gaps.map(g => `${g.type}${g.placement ? '@' + g.placement : ''}`).join(', ')}</span>}
                </div>
              )}

              {/* summary */}
              <div style={S.section}>
                <div style={S.sectionTitle}>Cake</div>
                <Field label="Tiers">{cake?.tier_count}</Field>
                <Field label="Shape">{cake?.shape}</Field>
                <Field label="Style">{cake?.style}</Field>
                {cake?.board?.present && <Field label="Board"><Swatch hex={cake.board.color_hex} /></Field>}
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
              {(analysis.tiers || []).map((t, i) => {
                const mt = matchResult?.tiers?.[i];
                const nonMatched = (t.decorations || []).filter(d => NON_MATCHED.includes(d.type));
                return (
                  <div key={i} style={S.tierCard}>
                    <div style={S.tierHead}>{t.position ? t.position[0].toUpperCase() + t.position.slice(1) : `Tier ${t.index ?? i}`} tier</div>
                    {t.frosting && (
                      <div style={{ marginBottom: 8 }}>
                        <Field label="Frosting">{[t.frosting.type, t.frosting.finish].filter(Boolean).join(', ')}</Field>
                        <Field label="Base colour"><Swatch hex={t.frosting.base_color_hex} name={t.frosting.color_name} /></Field>
                      </div>
                    )}
                    <div style={{ ...S.sectionTitle, marginTop: 4 }}>Decorations → elements</div>

                    {mt ? (
                      <>
                        {(mt.matches || []).map((m, j) => (
                          <MatchChip key={j} m={m} chosenId={chosenIdFor(i, j, m)}
                            onChoose={v => setOverrides(o => ({ ...o, [`${i}:${j}`]: v }))} />
                        ))}
                        {nonMatched.map((d, j) => (
                          <div key={'nm' + j} style={S.decoRow}>
                            <div style={{ fontWeight: 800, color: '#2C4433', fontSize: 13 }}>
                              {[d.type, d.subtype].filter(Boolean).join(' · ').replace(/_/g, ' ')}{d.text ? ` — “${d.text}”` : ''}
                            </div>
                            <div style={S.cakeLevel}>cake-level — applied directly (not a library element)</div>
                          </div>
                        ))}
                        {(mt.matches || []).length === 0 && nonMatched.length === 0 && <div style={S.hint}>None observed on this tier.</div>}
                      </>
                    ) : (
                      // pre-match (analysis only)
                      (t.decorations || []).map((d, j) => (
                        <div key={j} style={S.decoRow}>
                          <div style={{ fontWeight: 800, color: '#2C4433', fontSize: 13 }}>
                            {[d.type, d.subtype].filter(Boolean).join(' · ').replace(/_/g, ' ')}{d.text ? ` — “${d.text}”` : ''}
                          </div>
                          <Field label="Placement">{d.placement?.replace(/_/g, ' ')}</Field>
                          <Field label="Colour"><Swatch hex={d.color_hex} /></Field>
                        </div>
                      ))
                    )}
                  </div>
                );
              })}

              {/* raw json */}
              <div style={{ ...S.section, marginBottom: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={S.sectionTitle}>Reconstruction JSON</div>
                  <button style={S.copyBtn} onClick={copyJson}>{copied ? 'Copied ✓' : 'Copy'}</button>
                </div>
                <pre style={S.json}>{JSON.stringify(analysis, null, 2)}</pre>
              </div>
          </>
        </div>
      )}
    </div>
  );
}

const S = {
  page: { minHeight: '100vh', background: '#EDEAE2', fontFamily: 'Quicksand, sans-serif', padding: '32px 24px' },
  title: { fontSize: 22, fontWeight: 800, color: '#2C4433', marginBottom: 6 },
  sub: { fontSize: 13, color: '#6B8C74', fontWeight: 600, marginBottom: 24, maxWidth: 760 },
  layout: { display: 'grid', gridTemplateColumns: '360px minmax(0, 1fr)', gap: 20, maxWidth: 1200, margin: '0 auto', alignItems: 'start' },
  colCard: { background: '#fff', borderRadius: 18, border: '1.5px solid #C5D4C8', padding: 22 },
  previewStage: { width: '100%', height: 360, borderRadius: 14, border: '1.5px solid #E2E8E4', background: 'linear-gradient(180deg, #F7FAF8 0%, #EEF4EF 100%)', overflow: 'hidden' },
  resultsCard: { background: '#fff', borderRadius: 18, border: '1.5px solid #C5D4C8', padding: 22, maxWidth: 1200, margin: '20px auto 0' },
  section: { marginBottom: 22 },
  sectionTitle: { fontSize: 11, fontWeight: 700, color: '#6B8C74', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 },
  drop: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 220, borderRadius: 14, border: '2px dashed #C5D4C8', background: '#F4F8F5', cursor: 'pointer', overflow: 'hidden' },
  preview: { maxWidth: '100%', maxHeight: 280, borderRadius: 12, objectFit: 'contain' },
  primaryBtn: (d) => ({ width: '100%', padding: '13px 0', borderRadius: 10, border: 'none', background: d ? '#9BB5A2' : '#3D5A44', color: '#fff', fontFamily: 'Quicksand, sans-serif', fontSize: 15, fontWeight: 800, cursor: d ? 'not-allowed' : 'pointer', marginTop: 14 }),
  coverage: (full) => ({ padding: '10px 14px', borderRadius: 10, fontSize: 13, fontWeight: 700, marginBottom: 18, background: full ? '#E8F5E9' : '#FFF8E6', color: full ? '#2E7D32' : '#8A6D1A', border: `1.5px solid ${full ? '#A5D6A7' : '#EAD9A0'}` }),
  tierCard: { border: '1.5px solid #E2E8E4', borderRadius: 12, padding: '12px 14px', marginBottom: 12, background: '#F9FBFA' },
  tierHead: { fontSize: 14, fontWeight: 800, color: '#2C4433', marginBottom: 8 },
  decoRow: { borderTop: '1px solid #ECF1ED', padding: '10px 0', display: 'flex', flexDirection: 'column', gap: 3 },
  matchRow: { display: 'flex', alignItems: 'center', gap: 10, background: '#fff', border: '1.5px solid #E2E8E4', borderRadius: 10, padding: 8 },
  matchThumb: { width: 44, height: 44, borderRadius: 8, objectFit: 'cover', background: '#EEF4EF', border: '1px solid #E2E8E4', flexShrink: 0 },
  gap: { fontSize: 12, fontWeight: 700, color: '#B26A00', background: '#FFF4E0', borderRadius: 8, padding: '6px 10px' },
  cakeLevel: { fontSize: 11, color: '#9BB5A2', fontWeight: 600 },
  swap: { marginTop: 6, width: '100%', padding: '6px 8px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, color: '#2C4433', background: '#fff' },
  warn: { marginTop: 12, padding: '12px 14px', borderRadius: 10, fontSize: 12.5, fontWeight: 600, background: '#FFF8E6', color: '#8A6D1A', border: '1.5px solid #EAD9A0' },
  err: { marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, background: '#FFF0F0', color: '#C0392B' },
  hint: { fontSize: 11, color: '#9BB5A2', fontWeight: 600, marginTop: 8 },
  copyBtn: { padding: '4px 12px', borderRadius: 6, border: '1.5px solid #C5D4C8', background: '#fff', color: '#3D5A44', fontFamily: 'Quicksand, sans-serif', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
  json: { background: '#1f2a22', color: '#d6e6d8', borderRadius: 10, padding: 14, fontSize: 11.5, lineHeight: 1.5, overflow: 'auto', maxHeight: 380, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
};
