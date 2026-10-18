import { useState, useRef, useCallback } from 'react';
import { removeBackground } from '../lib/removeBgLocal.js';

// ── Background Remover (admin tool) ────────────────────────────────────────────
//
// Strips image backgrounds in-browser with the isnet-general-use model (the same one rembg uses) via
// onnxruntime-web — no remove.bg API cost. Drop an image, get a transparent PNG, tune the edge, save.
// The removal lives in lib/removeBgLocal.js so other admin screens can swap the paid removeBg() for it.

const CHECKER = 'repeating-conic-gradient(#e7e3da 0% 25%, #f4f1ea 0% 50%) 50% / 22px 22px';

export default function BackgroundRemover() {
  const [srcUrl, setSrcUrl] = useState(null);
  const [srcName, setSrcName] = useState('');
  const [outUrl, setOutUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dlPct, setDlPct] = useState(null);   // model download progress (first run only)
  const [threshold, setThreshold] = useState(0.35);
  const [feather, setFeather] = useState(0.04);
  const [fillHoles, setFillHoles] = useState(true);
  const [err, setErr] = useState(null);
  const imgRef = useRef(null);          // decoded HTMLImageElement of the source
  const fileRef = useRef(null);

  const loadFile = useCallback((file) => {
    if (!file || !file.type.startsWith('image/')) return;
    setErr(null); setOutUrl(null);
    setSrcName(file.name.replace(/\.[^.]+$/, ''));
    const url = URL.createObjectURL(file);
    setSrcUrl(url);
    const img = new Image();
    img.onload = () => { imgRef.current = img; };
    img.src = url;
  }, []);

  async function run() {
    if (!imgRef.current) return;
    setBusy(true); setErr(null);
    try {
      const { blob } = await removeBackground(imgRef.current, {
        threshold, feather, fillInteriorHoles: fillHoles,
        onProgress: (p) => setDlPct(p < 1 ? Math.round(p * 100) : null),
      });
      setDlPct(null);
      setOutUrl(URL.createObjectURL(blob));
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!outUrl) return;
    const a = document.createElement('a');
    a.href = outUrl; a.download = `${srcName || 'cutout'}-nobg.png`; a.click();
  }

  const onDrop = (e) => { e.preventDefault(); loadFile(e.dataTransfer.files?.[0]); };

  return (
    <div style={s.wrap}>
      <div style={s.panel}>
        <div style={s.title}>Background Remover</div>
        <div style={s.hint}>In-browser cutouts (isnet model) — nothing is sent to a paid vendor.</div>

        <button style={s.fileBtn} onClick={() => fileRef.current?.click()}>Choose image…</button>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
          onChange={e => loadFile(e.target.files?.[0])} />

        <button style={s.runBtn(busy || !srcUrl)} disabled={busy || !srcUrl} onClick={run}>
          {busy ? (dlPct != null ? `Loading model… ${dlPct}%` : 'Removing…') : 'Remove background'}
        </button>
        {dlPct != null && <div style={s.note}>First run downloads the model once (~170 MB, then cached).</div>}

        <div style={s.divider} />
        <div style={s.lbl}>Edge cleanup</div>
        <Slider label="Threshold" value={threshold} min={0.1} max={0.9} step={0.02} onChange={setThreshold} />
        <Slider label="Feather" value={feather} min={0} max={0.15} step={0.005} onChange={setFeather} />
        <label style={s.check}>
          <input type="checkbox" checked={fillHoles} onChange={e => setFillHoles(e.target.checked)} />
          <span>Fill interior holes</span>
        </label>
        <div style={s.note}>Low-contrast subject (e.g. white cake on white)? Lower the threshold (~0.25) and re-run.</div>

        <div style={s.divider} />
        <button style={s.dlBtn(!outUrl)} disabled={!outUrl} onClick={download}>Download PNG</button>
        {err && <div style={s.err}>{err}</div>}
      </div>

      <div style={s.stage}
        onDrop={onDrop} onDragOver={e => e.preventDefault()}>
        {!srcUrl && <div style={s.drop}>Drop an image here, or “Choose image…”.</div>}
        {srcUrl && (
          <div style={s.compare}>
            <figure style={s.fig}>
              <div style={s.figCap}>Original</div>
              <div style={s.imgBox}><img src={srcUrl} alt="original" style={s.img} /></div>
            </figure>
            <figure style={s.fig}>
              <div style={s.figCap}>Cutout</div>
              <div style={{ ...s.imgBox, background: CHECKER }}>
                {outUrl
                  ? <img src={outUrl} alt="cutout" style={s.img} />
                  : <div style={s.placeholder}>{busy ? 'Working…' : 'Run “Remove background”.'}</div>}
              </div>
            </figure>
          </div>
        )}
      </div>
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#3D5A44' }}>{label}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#6B8C74' }}>{Number(value).toFixed(3)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        style={{ width: '100%', accentColor: '#3D5A44' }} onChange={e => onChange(+e.target.value)} />
    </div>
  );
}

const s = {
  wrap: { display: 'flex', height: 'calc(100vh - 56px)', fontFamily: "'Quicksand', sans-serif" },
  panel: { width: 320, flexShrink: 0, overflowY: 'auto', padding: 20, background: '#fff', borderRight: '1.5px solid #C5D4C8' },
  stage: { flex: 1, minWidth: 0, background: '#EDEAE2', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { fontSize: 18, fontWeight: 700, color: '#3D5A44', marginBottom: 4 },
  hint: { fontSize: 12, color: '#999', marginBottom: 16 },
  fileBtn: { width: '100%', padding: '10px', borderRadius: 10, border: '1.5px solid #C5D4C8', background: '#fff', color: '#3D5A44', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginBottom: 10 },
  runBtn: (d) => ({ width: '100%', padding: '11px', borderRadius: 10, border: 'none', background: d ? '#9bb3a1' : '#3D5A44', color: '#fff', fontSize: 15, fontWeight: 700, cursor: d ? 'default' : 'pointer', fontFamily: 'inherit' }),
  dlBtn: (d) => ({ width: '100%', padding: '10px', borderRadius: 10, border: '1.5px solid #C5D4C8', background: d ? '#f3f3f0' : '#fff', color: d ? '#aaa' : '#3D5A44', fontSize: 14, fontWeight: 600, cursor: d ? 'default' : 'pointer', fontFamily: 'inherit' }),
  note: { fontSize: 11, color: '#999', marginTop: 6 },
  check: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#3D5A44', fontWeight: 600, marginTop: 8, cursor: 'pointer' },
  divider: { height: 1, background: '#E2E8E3', margin: '16px 0' },
  lbl: { fontSize: 11, fontWeight: 700, color: '#6B8C74', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 },
  err: { marginTop: 10, fontSize: 12, fontWeight: 600, color: '#b23' },
  drop: { color: '#8a958d', fontSize: 14, fontWeight: 600 },
  compare: { display: 'flex', gap: 20, width: '100%', height: '100%', maxWidth: 1100 },
  fig: { flex: 1, minWidth: 0, margin: 0, display: 'flex', flexDirection: 'column' },
  figCap: { fontSize: 11, fontWeight: 700, color: '#6B8C74', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8, textAlign: 'center' },
  imgBox: { flex: 1, minHeight: 0, borderRadius: 12, border: '1.5px solid #C5D4C8', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  img: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' },
  placeholder: { color: '#8a958d', fontSize: 13, fontWeight: 600 },
};
