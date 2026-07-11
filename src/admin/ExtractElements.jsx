import { useState, useEffect, useRef } from 'react';
import { uploadAsset, identifyDecorations, generateDecorations, getExtractJob, updateCandidate } from '../lib/api.js';
import { downscaleToJpeg } from '../lib/thumbnail.js';

// Extract Elements. Upload a cake photo → GPT-4o vision finds each decoration and we crop it out →
// the admin ticks the ones worth having → each is REGENERATED as a clean, isolated, transparent
// asset (an image model conditioned on the real crop, not on a text description of it) → the good
// ones become library elements via Add Element.
//
// The two-phase split is deliberate and is the whole shape of this screen. Identification is one
// cheap vision call, so it runs immediately and shows everything we found. Regeneration costs an
// image generation per decoration, so it only ever runs on what the admin actually ticked. Selection
// therefore happens at BOTH ends: before generating (don't pay for what you don't want) and after
// (don't ship what came back wrong).
//
// The inverse of Build from Inspiration, which matches a photo to elements we already have.

// The source photo is what every crop is cut from, so it keeps more pixels than the Inspiration
// analysis does — the crop is a reference image for regeneration, not just something to look at.
const SOURCE_MAX_DIM = 2048;
const POLL_MS = 3000;

// Poll while the job is still running. 'done' means every candidate reached a terminal state
// (each row carries its own ready/failed), so there is nothing left to wait for.
const isRunning = (s) => s === 'pending' || s === 'processing';

function Swatch({ hex }) {
  if (!hex) return null;
  return <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3, background: hex, border: '1px solid rgba(0,0,0,0.18)', verticalAlign: 'middle' }} />;
}

// One decoration. Before generation it shows the CROP (so the admin can see whether the box is any
// good before spending on it); after, the regenerated cut-out.
function CandidateCard({ c, picked, onToggle, onCreate, onReject, phase }) {
  const img = c.status === 'ready' ? c.outputUrl : c.cropUrl;
  const selectable = phase === 'review' && c.status !== 'rejected';

  return (
    <div style={S.card(picked && selectable)}>
      <div style={S.thumbWrap} onClick={selectable ? onToggle : undefined}>
        {img
          ? <img src={img} alt={c.label || 'decoration'} style={S.thumb} />
          : <div style={S.noThumb}>no crop</div>}
        {c.status === 'generating' && <div style={S.overlay}>Regenerating…</div>}
        {c.status === 'failed'     && <div style={{ ...S.overlay, background: 'rgba(192,57,43,0.86)' }}>Failed</div>}
        {c.status === 'rejected'   && <div style={S.overlay}>Rejected</div>}
        {selectable && (
          <div style={S.checkbox(picked)}>
            {picked && (
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2 6.5 L4.8 9 L10 3.2" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </div>
        )}
      </div>

      <div style={S.cardBody}>
        <div style={S.cardName}>{c.label || c.elementKind || 'Decoration'}</div>
        <div style={S.cardMeta}>
          <Swatch hex={c.colorHex} />
          <span>{[c.material, c.elementKind].filter(Boolean).join(' · ') || '—'}</span>
        </div>
        {c.status === 'failed' && c.error && <div style={S.cardErr}>{c.error}</div>}

        {c.status === 'ready' && (
          c.elementId ? (
            <div style={S.savedTag}>Saved as an element</div>
          ) : (
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button style={S.createBtn} onClick={onCreate}>Create element</button>
              <button style={S.rejectBtn} onClick={onReject} title="Not good enough to keep">Reject</button>
            </div>
          )
        )}
      </div>
    </div>
  );
}

export default function ExtractElements() {
  const [file, setFile]             = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [busy, setBusy]             = useState(false);
  const [error, setError]           = useState(null);
  const [rejection, setRejection]   = useState(null);

  const [candidates, setCandidates] = useState([]);
  const [picked, setPicked]         = useState({});     // candidate id → ticked
  const [jobId, setJobId]           = useState(null);
  const [jobStatus, setJobStatus]   = useState(null);

  const pollRef = useRef(null);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  useEffect(() => () => clearInterval(pollRef.current), []);

  // 'upload' (nothing found yet) → 'review' (tick what to regenerate) → 'results' (a job has run).
  const phase = jobId ? 'results' : (candidates.length ? 'review' : 'upload');
  const pickedIds = candidates.filter(c => picked[c.id] && c.status !== 'rejected').map(c => c.id);

  function reset() {
    clearInterval(pollRef.current);
    setError(null); setRejection(null);
    setCandidates([]); setPicked({}); setJobId(null); setJobStatus(null);
  }

  function pick(f) {
    if (!f) return;
    reset();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
  }

  // Phase 1 — upload the photo, then find + crop the decorations. Nothing is generated here, so
  // this costs one vision call and no image generations.
  async function findDecorations() {
    if (!file) return;
    setBusy(true); reset();
    try {
      const shrunk = await downscaleToJpeg(file, SOURCE_MAX_DIM);
      const sourceKey = await uploadAsset('elements/candidates', new File([shrunk], 'cake.jpg', { type: 'image/jpeg' }));

      const res = await identifyDecorations(sourceKey);
      if (!res.ok) { setRejection({ reason: res.reason }); return; }

      setCandidates(res.candidates);
      // Tick everything by default — the admin unticks what they don't want, which is the common case.
      setPicked(Object.fromEntries(res.candidates.map(c => [c.id, true])));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Phase 2 — regenerate ONLY the ticked decorations, as a background job we poll.
  async function regenerate() {
    if (!pickedIds.length) return;
    setBusy(true); setError(null);
    try {
      const { jobId: id } = await generateDecorations(pickedIds);
      setJobId(id);
      setJobStatus('pending');
      // Show the picked ones as in-flight immediately, rather than waiting a poll tick to react.
      setCandidates(cs => cs.filter(c => pickedIds.includes(c.id)).map(c => ({ ...c, status: 'generating' })));
      startPolling(id);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function startPolling(id) {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await getExtractJob(id);
        setJobStatus(res.status);
        setCandidates(res.candidates);
        if (!isRunning(res.status)) clearInterval(pollRef.current);
      } catch (e) {
        clearInterval(pollRef.current);
        setError(`Lost track of the job: ${e.message}`);
      }
    }, POLL_MS);
  }

  // Hand off to Add Element with this decoration preloaded. The candidate id travels in the URL (not
  // the image), so the target reloads cleanly and the API stays the only thing that expands keys.
  function createElement(c) {
    window.location.href = `/elements/add?candidate=${encodeURIComponent(c.id)}`;
  }

  async function reject(c) {
    setCandidates(cs => cs.map(x => (x.id === c.id ? { ...x, status: 'rejected' } : x)));
    try {
      await updateCandidate(c.id, { status: 'rejected' });
    } catch (e) {
      // Put it back — a rejection we failed to persist must not look persisted.
      setCandidates(cs => cs.map(x => (x.id === c.id ? { ...x, status: 'ready' } : x)));
      setError(`Could not reject that one: ${e.message}`);
    }
  }

  const running = isRunning(jobStatus);
  const readyCount = candidates.filter(c => c.status === 'ready').length;

  return (
    <div style={S.page}>
      <div style={S.title}>Extract Elements</div>
      <div style={S.sub}>
        Upload a cake photo. We find each decoration on it, then regenerate the ones you pick as clean,
        isolated images you can save straight into the element library.
      </div>

      <div style={S.layout}>
        {/* LEFT — the source photo */}
        <div style={S.colCard}>
          <div style={S.sectionTitle}>Cake photo</div>
          <label style={S.drop}>
            {previewUrl
              ? <img src={previewUrl} alt="preview" style={S.preview} />
              : <span style={{ color: '#6B8C74', fontWeight: 700 }}>Click to choose a cake photo (PNG / JPG)</span>}
            <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; pick(f); }} />
          </label>

          <button style={S.primaryBtn(!file || busy)} onClick={findDecorations} disabled={!file || busy}>
            {busy && phase === 'upload' ? 'Looking…' : 'Find decorations'}
          </button>

          {rejection && (
            <div style={S.warn}>
              <div style={{ fontWeight: 800, marginBottom: 4 }}>This image isn&rsquo;t a good fit</div>
              <div>{rejection.reason}</div>
            </div>
          )}
          {error && <div style={S.err}>{error}</div>}
          <div style={S.hint}>
            We check it&rsquo;s a single cake before reading it. Finding decorations is cheap — regenerating
            them is what costs, so nothing is generated until you choose.
          </div>
        </div>

        {/* RIGHT — decorations */}
        <div style={S.colCard}>
          <div style={S.headRow}>
            <div style={S.sectionTitle}>
              {phase === 'results' ? 'Regenerated decorations' : 'Decorations found'}
            </div>
            {phase === 'review' && (
              <button style={S.primaryBtnInline(!pickedIds.length || busy)} onClick={regenerate} disabled={!pickedIds.length || busy}>
                Regenerate {pickedIds.length} selected
              </button>
            )}
          </div>

          {phase === 'upload' && (
            <div style={S.empty}>
              Nothing yet. Choose a photo and we&rsquo;ll pick out the decorations that would make good
              reusable elements.
            </div>
          )}

          {phase === 'review' && (
            <div style={S.note}>
              Each one below was cropped straight out of your photo — that crop is what the regeneration
              is based on, so if a crop has cut a decoration in half, untick it. Untick anything you
              don&rsquo;t want; only the ticked ones are generated.
            </div>
          )}

          {phase === 'results' && running && (
            <div style={S.note}>Regenerating {candidates.length} decoration{candidates.length === 1 ? '' : 's'}. This takes a while — they run one at a time.</div>
          )}
          {phase === 'results' && !running && (
            <div style={S.coverage(readyCount > 0)}>
              <b>{readyCount} of {candidates.length} regenerated.</b>
              {readyCount > 0 && ' Pick the ones worth keeping and save them as elements.'}
            </div>
          )}

          {candidates.length > 0 && (
            <div style={S.grid}>
              {candidates.map(c => (
                <CandidateCard
                  key={c.id}
                  c={c}
                  phase={phase}
                  picked={!!picked[c.id]}
                  onToggle={() => setPicked(p => ({ ...p, [c.id]: !p[c.id] }))}
                  onCreate={() => createElement(c)}
                  onReject={() => reject(c)}
                />
              ))}
            </div>
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
  headRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 },
  sectionTitle: { fontSize: 11, fontWeight: 700, color: '#6B8C74', letterSpacing: 1, textTransform: 'uppercase' },
  drop: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 220, borderRadius: 14, border: '2px dashed #C5D4C8', background: '#F4F8F5', cursor: 'pointer', overflow: 'hidden' },
  preview: { maxWidth: '100%', maxHeight: 280, borderRadius: 12, objectFit: 'contain' },
  primaryBtn: (d) => ({ width: '100%', padding: '13px 0', borderRadius: 10, border: 'none', background: d ? '#9BB5A2' : '#3D5A44', color: '#fff', fontFamily: 'Quicksand, sans-serif', fontSize: 15, fontWeight: 800, cursor: d ? 'not-allowed' : 'pointer', marginTop: 14 }),
  primaryBtnInline: (d) => ({ padding: '9px 16px', borderRadius: 9, border: 'none', background: d ? '#9BB5A2' : '#3D5A44', color: '#fff', fontFamily: 'Quicksand, sans-serif', fontSize: 13, fontWeight: 800, cursor: d ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }),

  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gap: 14, marginTop: 14 },
  card: (on) => ({ borderRadius: 14, border: `2px solid ${on ? '#3D5A44' : '#E2E8E4'}`, background: on ? '#F4F8F5' : '#fff', overflow: 'hidden', transition: 'border-color .12s, background .12s' }),
  thumbWrap: { position: 'relative', height: 150, background: 'linear-gradient(180deg, #F7FAF8 0%, #EEF4EF 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
  thumb: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' },
  noThumb: { color: '#9BB5A2', fontSize: 11, fontWeight: 700 },
  overlay: { position: 'absolute', inset: 0, background: 'rgba(44,68,51,0.72)', color: '#fff', fontSize: 12, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  checkbox: (on) => ({ position: 'absolute', top: 8, right: 8, width: 20, height: 20, borderRadius: 6, border: `2px solid ${on ? '#3D5A44' : '#C5D4C8'}`, background: on ? '#3D5A44' : 'rgba(255,255,255,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center' }),
  cardBody: { padding: '10px 12px 12px' },
  cardName: { fontWeight: 800, color: '#2C4433', fontSize: 12.5, lineHeight: 1.3 },
  cardMeta: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#6B8C74', fontWeight: 600, marginTop: 4 },
  cardErr: { fontSize: 10.5, color: '#C0392B', fontWeight: 600, marginTop: 6, lineHeight: 1.35 },
  createBtn: { flex: 1, padding: '7px 0', borderRadius: 8, border: 'none', background: '#3D5A44', color: '#fff', fontFamily: 'Quicksand, sans-serif', fontSize: 11.5, fontWeight: 800, cursor: 'pointer' },
  rejectBtn: { padding: '7px 10px', borderRadius: 8, border: '1.5px solid #C5D4C8', background: '#fff', color: '#6B8C74', fontFamily: 'Quicksand, sans-serif', fontSize: 11.5, fontWeight: 700, cursor: 'pointer' },
  savedTag: { marginTop: 8, padding: '6px 10px', borderRadius: 8, background: '#E8F5E9', color: '#2E7D32', border: '1.5px solid #A5D6A7', fontSize: 11, fontWeight: 700, textAlign: 'center' },

  empty: { padding: '48px 24px', textAlign: 'center', color: '#9BB5A2', fontSize: 12.5, fontWeight: 600, lineHeight: 1.6, border: '2px dashed #E2E8E4', borderRadius: 14 },
  note: { fontSize: 12, color: '#6B8C74', fontWeight: 600, lineHeight: 1.5, background: '#F4F8F5', border: '1.5px solid #E2E8E4', borderRadius: 10, padding: '10px 12px' },
  coverage: (ok) => ({ padding: '10px 14px', borderRadius: 10, fontSize: 13, fontWeight: 700, background: ok ? '#E8F5E9' : '#FFF8E6', color: ok ? '#2E7D32' : '#8A6D1A', border: `1.5px solid ${ok ? '#A5D6A7' : '#EAD9A0'}` }),
  warn: { marginTop: 12, padding: '12px 14px', borderRadius: 10, fontSize: 12.5, fontWeight: 600, background: '#FFF8E6', color: '#8A6D1A', border: '1.5px solid #EAD9A0' },
  err: { marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, background: '#FFF0F0', color: '#C0392B' },
  hint: { fontSize: 11, color: '#9BB5A2', fontWeight: 600, marginTop: 8, lineHeight: 1.5 },
};
