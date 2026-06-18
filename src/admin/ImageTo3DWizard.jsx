import { useState, useRef, useEffect, useCallback } from 'react';
import { getSignedUploadUrl, uploadToR2, startMeshyGeneration, getMeshyGeneration } from '../lib/api.js';
import RecomposeEditor from './RecomposeEditor.jsx';

// Image → 3D Cake wizard. Chains: upload a 2D image → GPT-4o validation gate → Meshy.ai
// image-to-3D → hand the generated GLB to the shared <RecomposeEditor> for part segmentation,
// grouping and Save-as-Element. The gate runs server-side BEFORE Meshy credits are spent.
//
// Async model: the API owns a durable meshy_generations row. We poll GET /admin/meshy/:id, which
// (since the account-global webhook can't reach localhost) live-polls Meshy and advances the row.
// Built admin-first; intended to ship baker-facing once solid.

const POLL_MS = 4000;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export default function ImageTo3DWizard() {
  // 'upload' → 'generating' → 'editor'
  const [step, setStep] = useState('upload');
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [rejection, setRejection] = useState(null); // { reason, category } from the gate
  const [gen, setGen] = useState(null);             // the meshy_generations row
  const [glbBuffer, setGlbBuffer] = useState(null);

  const editorRef = useRef(null);
  const pollInFlight = useRef(false);
  const loadedRef = useRef(false);

  // ----- step 1: pick a source image
  function pickFile(f) {
    if (!f) return;
    setError(null); setRejection(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
    setName(f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').trim());
  }
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  // ----- step 2: upload to R2, run the gate, create the Meshy task
  async function generate(force = false) {
    if (!file) return;
    setBusy(true); setError(null); setRejection(null);
    try {
      const ext = EXT[file.type] || 'png';
      const { url, key } = await getSignedUploadUrl('meshy/source', `${crypto.randomUUID()}.${ext}`, file.type || 'image/png');
      await uploadToR2(url, file);

      const res = await startMeshyGeneration(key, force);
      if (!res.ok) {
        // Gate rejected the image — no task, no credits. Let the admin swap it or force.
        setRejection({ reason: res.reason, category: res.category });
        return;
      }
      setGen(res);
      setStep('generating');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // ----- step 3: poll the generation row until terminal
  const poll = useCallback(async (id) => {
    if (pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      const row = await getMeshyGeneration(id);
      setGen(row);
      if (row.status === 'SUCCEEDED' && row.glb_url) {
        const buf = await (await fetch(row.glb_url)).arrayBuffer();
        setGlbBuffer(buf);
        setStep('editor');
      } else if (row.status === 'FAILED') {
        setError(row.error || 'Generation failed');
      }
    } catch (e) {
      // transient — keep the last-known row, try again next tick
      console.warn('poll error:', e.message);
    } finally {
      pollInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (step !== 'generating' || !gen?.id) return;
    poll(gen.id); // immediate first tick
    const t = setInterval(() => poll(gen.id), POLL_MS);
    return () => clearInterval(t);
  }, [step, gen?.id, poll]);

  // ----- step 4: once the editor is mounted, feed it the Meshy GLB (once)
  useEffect(() => {
    if (step !== 'editor' || !glbBuffer || loadedRef.current) return;
    if (!editorRef.current) return;
    loadedRef.current = true;
    editorRef.current.loadFromArrayBuffer(glbBuffer, name);
  }, [step, glbBuffer, name]);

  function startOver() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setStep('upload'); setFile(null); setPreviewUrl(null);
    setGen(null); setGlbBuffer(null); setError(null); setRejection(null);
    loadedRef.current = false;
  }

  // ===== editor step — full shared editor with a wizard-specific import slot =====
  if (step === 'editor') {
    return (
      <RecomposeEditor
        ref={editorRef}
        title="Image → 3D Cake"
        subtitle="Generated from your image — separate the colours into parts, group them, then save as an element."
        importSlot={
          <div>
            {previewUrl && <img src={previewUrl} alt="source" style={S.thumb} />}
            <div style={S.hint}>Generated from your uploaded image.</div>
            <button style={S.linkBtn} onClick={startOver}>← Start over with a new image</button>
          </div>
        }
      />
    );
  }

  // ===== upload + generating steps =====
  const progress = gen?.progress ?? 0;
  return (
    <div style={S.page}>
      <div style={S.title}>Image → 3D Cake</div>
      <div style={S.sub}>Upload a clean photo of a single cake or cake decoration. We turn it into a 3D model you can split into recolourable parts.</div>

      <div style={S.card}>
        <Steps step={step} />

        {step === 'upload' && (
          <>
            <label style={S.drop}>
              {previewUrl
                ? <img src={previewUrl} alt="preview" style={S.preview} />
                : <span style={{ color: '#6B8C74', fontWeight: 700 }}>Click to choose an image (PNG / JPG)</span>}
              <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; pickFile(f); }} />
            </label>

            {file && (
              <div style={{ marginTop: 14 }}>
                <label style={S.label}>Name</label>
                <input style={S.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Unicorn Topper" />
              </div>
            )}

            {rejection && (
              <div style={S.warn}>
                <div style={{ fontWeight: 800, marginBottom: 4 }}>This image isn't a good fit</div>
                <div>{rejection.reason}</div>
                <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button style={S.ghostBtn} onClick={() => { setRejection(null); setFile(null); setPreviewUrl(null); }}>Choose another image</button>
                  <button style={S.ghostBtn} onClick={() => generate(true)} disabled={busy}>Generate anyway (admin)</button>
                </div>
              </div>
            )}

            {error && <div style={S.err}>{error}</div>}

            <button style={S.primaryBtn(!file || busy)} onClick={() => generate(false)} disabled={!file || busy}>
              {busy ? 'Validating…' : 'Validate & generate 3D'}
            </button>
            <div style={S.hint}>We first check the image qualifies (no people or busy scenes) before generating — this avoids wasting a generation.</div>
          </>
        )}

        {step === 'generating' && (
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            {gen?.thumbnail_url
              ? <img src={gen.thumbnail_url} alt="generating" style={S.preview} />
              : previewUrl && <img src={previewUrl} alt="source" style={{ ...S.preview, opacity: 0.5 }} />}
            <div style={{ marginTop: 16 }}>
              <div style={S.barTrack}><div style={{ ...S.barFill, width: `${Math.max(6, progress)}%` }} /></div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#3D5A44', marginTop: 8 }}>
                Building your 3D model… {progress}%
              </div>
              <div style={S.hint}>This takes a couple of minutes. You can leave this page open; we'll drop you into the editor when it's ready.</div>
            </div>
            {error && (
              <div style={S.err}>
                {error}
                <div style={{ marginTop: 8 }}><button style={S.ghostBtn} onClick={startOver}>Start over</button></div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Steps({ step }) {
  const items = [['upload', 'Upload'], ['generating', 'Generate'], ['editor', 'Refine & save']];
  const order = items.findIndex(([k]) => k === step);
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
      {items.map(([k, l], i) => (
        <div key={k} style={{
          flex: 1, textAlign: 'center', padding: '8px 6px', borderRadius: 8, fontSize: 12, fontWeight: 700,
          background: i <= order ? '#3D5A44' : '#E8EDE9', color: i <= order ? '#fff' : '#6B8C74',
        }}>{i + 1}. {l}</div>
      ))}
    </div>
  );
}

const S = {
  page: { minHeight: '100vh', background: '#EDEAE2', fontFamily: 'Quicksand, sans-serif', padding: '32px 24px' },
  title: { fontSize: 22, fontWeight: 800, color: '#2C4433', marginBottom: 6 },
  sub: { fontSize: 13, color: '#6B8C74', fontWeight: 600, marginBottom: 24 },
  card: { background: '#fff', borderRadius: 18, border: '1.5px solid #C5D4C8', padding: 28, maxWidth: 560, margin: '0 auto' },
  drop: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 220, borderRadius: 14, border: '2px dashed #C5D4C8', background: '#F4F8F5', cursor: 'pointer', overflow: 'hidden' },
  preview: { maxWidth: '100%', maxHeight: 260, borderRadius: 12, objectFit: 'contain' },
  thumb: { width: '100%', borderRadius: 10, marginBottom: 8, border: '1.5px solid #E2E8E4' },
  label: { fontSize: 12, fontWeight: 700, color: '#6B8C74', display: 'block', marginBottom: 6 },
  input: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontFamily: 'Quicksand, sans-serif', fontSize: 14, fontWeight: 600, color: '#2C4433', background: '#fff', boxSizing: 'border-box', outline: 'none' },
  primaryBtn: (d) => ({ width: '100%', padding: '13px 0', borderRadius: 10, border: 'none', background: d ? '#9BB5A2' : '#3D5A44', color: '#fff', fontFamily: 'Quicksand, sans-serif', fontSize: 15, fontWeight: 800, cursor: d ? 'not-allowed' : 'pointer', marginTop: 16 }),
  ghostBtn: { padding: '8px 14px', borderRadius: 8, border: '1.5px solid #C5D4C8', background: '#fff', color: '#3D5A44', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  linkBtn: { background: 'none', border: 'none', padding: 0, marginTop: 8, color: '#3D5A44', fontFamily: 'Quicksand, sans-serif', fontSize: 12, fontWeight: 700, textDecoration: 'underline', cursor: 'pointer' },
  warn: { marginTop: 14, padding: '12px 14px', borderRadius: 10, fontSize: 12.5, fontWeight: 600, background: '#FFF8E6', color: '#8A6D1A', border: '1.5px solid #EAD9A0' },
  err: { marginTop: 14, padding: '10px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, background: '#FFF0F0', color: '#C0392B' },
  hint: { fontSize: 11, color: '#9BB5A2', fontWeight: 600, marginTop: 8 },
  barTrack: { width: '100%', height: 10, borderRadius: 6, background: '#E8EDE9', overflow: 'hidden' },
  barFill: { height: '100%', background: '#3D5A44', borderRadius: 6, transition: 'width 0.4s ease' },
};
