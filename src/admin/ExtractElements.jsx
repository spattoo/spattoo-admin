import { useState, useRef, useEffect, useCallback } from 'react';
import { uploadBlob, identifyCandidates, generateCandidates, fetchExtractJob, updateCandidate } from '../lib/api.js';

// Extract Elements — build catalogue elements from a reference cake photo.
//
// The reference is CONTEXT, not a source to cut from. Point at a makeup-themed cake and the model
// lists what is on it (nail polish, lipstick, mirror…); each one is then REGENERATED as an isolated
// image at high input fidelity, so the output is a clean asset rather than a crop of somebody's
// photograph.
//
// ── Why the intent picker is the important control ──────────────────────────────────────────────
// The same subject needs a different image depending on what it becomes, and the differences are
// opposites rather than degrees:
//
//   sticker  printed flat on edible paper — flat IS the finished thing
//   relief   a fondant cut-out — the ALPHA becomes an extruded silhouette and LUMINANCE bakes the
//            normal map, so shading turns into bumps and a dark outline halos the wall
//   model    the input to image-to-3D — needs the depth cues (three-quarter view, soft shadow,
//            matte surface) that the other two deliberately remove
//
// Picking it here is the whole point: admin knows which it is, so nobody has to remember a prompt.
// Settable only BEFORE generating — a finished image cannot be re-purposed by relabelling it.
//
// Async model: generation is a background job (gpt-image is rate-limited per minute, so the worker
// runs candidates sequentially). We poll the job and refresh the candidate list from it.
const POLL_MS = 4000;

const INTENTS = [
  { key: 'sticker', label: 'Sticker',  hint: 'Printed flat on edible paper' },
  { key: 'relief',  label: 'Fondant',  hint: 'Raised cut-out — alpha becomes the extruded shape' },
  { key: 'model',   label: '3D model', hint: 'Input for image-to-3D — needs depth cues' },
];

const S = {
  wrap:    { padding: 24, maxWidth: 1100, margin: '0 auto', fontFamily: 'inherit' },
  h1:      { fontSize: 20, fontWeight: 800, margin: '0 0 4px' },
  sub:     { fontSize: 13, color: '#666', margin: '0 0 20px' },
  // display:block — a <label> is INLINE by default, so padding, width and text-align silently did
  // nothing and the dashed box collapsed to a sliver beside its own text.
  drop:    { display: 'block', border: '2px dashed #cbd5e1', borderRadius: 14, padding: 36, textAlign: 'center', cursor: 'pointer', background: '#fafafa' },
  preview: { maxWidth: 320, maxHeight: 260, objectFit: 'contain', borderRadius: 10, display: 'block', margin: '0 auto 14px' },
  grid:    { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16, marginTop: 20 },
  card:    { border: '1px solid #e5e7eb', borderRadius: 12, padding: 12, background: '#fff' },
  cardOff: { opacity: 0.45 },
  thumb:   { width: '100%', height: 150, objectFit: 'contain', background: '#f8fafc', borderRadius: 8 },
  label:   { fontWeight: 700, fontSize: 13, margin: '8px 0 2px' },
  meta:    { fontSize: 11.5, color: '#94a3b8' },
  seg:     { display: 'flex', gap: 4, marginTop: 8 },
  segBtn:  (on) => ({ flex: 1, padding: '5px 0', fontSize: 11, fontWeight: 700, borderRadius: 7, cursor: 'pointer',
                      border: `1px solid ${on ? '#2C4433' : '#e2e8f0'}`, background: on ? '#2C4433' : '#fff', color: on ? '#fff' : '#475569' }),
  btn:     { padding: '10px 18px', borderRadius: 10, border: 'none', background: '#2C4433', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  ghost:   { padding: '8px 14px', borderRadius: 9, border: '1px solid #cbd5e1', background: '#fff', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' },
  err:     { background: '#FEF3F2', border: '1px solid #FECDCA', color: '#B42318', borderRadius: 10, padding: '10px 14px', fontSize: 13, fontWeight: 600, marginBottom: 14 },
  note:    { background: '#FFFAEB', border: '1px solid #FEDF89', color: '#B54708', borderRadius: 10, padding: '10px 14px', fontSize: 12.5, marginBottom: 14 },
  bar:     { display: 'flex', gap: 10, alignItems: 'center', marginTop: 20 },
  hint:    { fontSize: 12, color: '#64748b' },
};

export default function ExtractElements() {
  const [step, setStep]         = useState('upload');   // upload → review → generating
  const [previewUrl, setPrev]   = useState(null);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState(null);
  const [rejection, setReject]  = useState(null);       // the validateCakeImage gate said no
  const [cake, setCake]         = useState(null);
  const [candidates, setCands]  = useState([]);
  const [skipped, setSkipped]   = useState(() => new Set());
  const [jobId, setJobId]       = useState(null);
  const pollInFlight = useRef(false);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  async function pickFile(file) {
    if (!file) return;
    setError(null); setReject(null); setBusy(true);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPrev(URL.createObjectURL(file));
    try {
      const { key } = await uploadBlob('elements/candidates', file.name, file, file.type);
      const res = await identifyCandidates(key);
      // The gate answers 200 with ok:false rather than an error, so the UI can explain instead of
      // showing a failure for something that is simply not a cake.
      if (!res.ok) { setReject({ reason: res.reason, category: res.category }); return; }
      setCake(res.cake ?? null);
      setCands(res.candidates ?? []);
      setSkipped(new Set((res.candidates ?? []).filter(c => c.status === 'blocked').map(c => c.id)));
      setStep('review');
    } catch (e) {
      setError(e.message || 'Could not read that image.');
    } finally {
      setBusy(false);
    }
  }

  // Optimistic: the picker should feel like a toggle, not a save. A failure puts the old value back
  // and says so, rather than leaving the UI claiming something the server did not accept.
  async function setIntent(id, intent) {
    const prev = candidates.find(c => c.id === id)?.intent;
    setCands(cs => cs.map(c => (c.id === id ? { ...c, intent } : c)));
    try { await updateCandidate(id, { intent }); }
    catch (e) {
      setCands(cs => cs.map(c => (c.id === id ? { ...c, intent: prev } : c)));
      setError(e.message || 'Could not save that choice.');
    }
  }

  const toggleSkip = (id) => setSkipped(s => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  const chosen = candidates.filter(c => !skipped.has(c.id) && c.status !== 'blocked');

  async function generate() {
    if (!chosen.length) return;
    setBusy(true); setError(null);
    try {
      const res = await generateCandidates(chosen.map(c => c.id));
      setJobId(res.jobId ?? res.job?.id ?? null);
      setStep('generating');
    } catch (e) {
      setError(e.message || 'Could not start generation.');
    } finally {
      setBusy(false);
    }
  }

  const poll = useCallback(async () => {
    if (!jobId || pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      const res = await fetchExtractJob(jobId);
      if (Array.isArray(res.candidates)) setCands(res.candidates);
      // 'done' covers partial success — a candidate that failed carries its own `error`, and the
      // card shows it. One failure should not hold the whole screen in a spinner.
      if (res.job?.status === 'done' || res.job?.status === 'failed') setStep('review');
    } catch { /* transient — the next tick retries */ }
    finally { pollInFlight.current = false; }
  }, [jobId]);

  useEffect(() => {
    if (step !== 'generating') return;
    const t = setInterval(poll, POLL_MS);
    poll();
    return () => clearInterval(t);
  }, [step, poll]);

  function reset() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setStep('upload'); setPrev(null); setCands([]); setSkipped(new Set());
    setJobId(null); setCake(null); setError(null); setReject(null);
  }

  return (
    <div style={S.wrap}>
      <h1 style={S.h1}>Extract Elements</h1>
      <p style={S.sub}>
        Point at a reference cake. Pick what each decoration is for, and regenerate the ones you want
        as isolated images.
      </p>

      {error && <div style={S.err}>{error}</div>}
      {rejection && (
        <div style={S.note}>
          <strong>Not usable as a reference.</strong> {rejection.reason}
          {rejection.category ? ` (${rejection.category})` : ''}
        </div>
      )}

      {step === 'upload' && (
        <label style={S.drop}>
          <input type="file" accept="image/*" style={{ display: 'none' }}
                 onChange={e => pickFile(e.target.files?.[0])} disabled={busy} />
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            {busy ? 'Reading the cake…' : 'Choose a reference cake photo'}
          </div>
          <div style={S.hint}>
            We check it qualifies before spending anything — no people, no busy scenes.
          </div>
        </label>
      )}

      {step !== 'upload' && (
        <>
          {previewUrl && <img src={previewUrl} alt="reference" style={S.preview} />}
          {cake?.theme && <p style={{ ...S.hint, textAlign: 'center' }}>Theme read as: <strong>{cake.theme}</strong></p>}

          <div style={S.grid}>
            {candidates.map(c => {
              const off = skipped.has(c.id) || c.status === 'blocked';
              return (
                <div key={c.id} style={{ ...S.card, ...(off ? S.cardOff : {}) }}>
                  <img src={c.outputUrl || c.cropUrl} alt={c.label ?? 'candidate'} style={S.thumb} />
                  <div style={S.label}>{c.label ?? 'unnamed'}</div>
                  <div style={S.meta}>
                    {c.status}{c.material ? ` · ${c.material}` : ''}{c.outputUrl ? ' · generated' : ''}
                  </div>
                  {c.error && <div style={{ ...S.meta, color: '#B42318', marginTop: 4 }}>{c.error}</div>}

                  {/* Locked once generated — the recipe shaped how the image was drawn, so
                      relabelling it afterwards would describe it wrongly rather than change it. */}
                  <div style={S.seg}>
                    {INTENTS.map(i => (
                      <button key={i.key} title={i.hint}
                              disabled={c.status === 'blocked' || !!c.outputUrl}
                              onClick={() => setIntent(c.id, i.key)}
                              style={S.segBtn((c.intent ?? 'sticker') === i.key)}>
                        {i.label}
                      </button>
                    ))}
                  </div>

                  {c.status !== 'blocked' && (
                    <button style={{ ...S.ghost, marginTop: 8, width: '100%' }} onClick={() => toggleSkip(c.id)}>
                      {skipped.has(c.id) ? 'Include' : 'Skip'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div style={S.bar}>
            <button style={S.btn} onClick={generate}
                    disabled={busy || step === 'generating' || !chosen.length}>
              {step === 'generating' ? 'Generating…' : `Generate ${chosen.length || ''}`.trim()}
            </button>
            <button style={S.ghost} onClick={reset} disabled={busy}>Start over</button>
            <span style={S.hint}>
              {step === 'generating'
                ? 'One at a time — the image API is rate-limited per minute.'
                : 'Blocked candidates are licensed characters and cannot be regenerated.'}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
