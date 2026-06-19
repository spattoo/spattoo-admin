import { useState, useEffect, useMemo, useRef } from 'react';
import { HexColorPicker } from 'react-colorful';
import { recolorImageData, RECOLOR_METHODS } from '@spattoo/designer';

// ─────────────────────────────────────────────────────────────────────────────
// 2D image recolour tester — upload an asset, pick a recolour METHOD + its param +
// a target colour, and see original vs recoloured side by side. It runs the EXACT
// `recolorImageData` the designer runs (imported from @spattoo/designer), so what you
// see here is what customers get. Use it to choose the right method per asset, then
// author that method on the element (Add/Manage Elements → Recolourable area).
// ─────────────────────────────────────────────────────────────────────────────

// Edge flood-fill white→transparent — convenience so you can test the "Whole image"
// method on a white-background image without removing the bg first. (Real assets are
// already background-removed by the Remove.bg pipeline.)
function removeWhiteBg(ctx, w, h, thr) {
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;
  const seen = new Uint8Array(w * h);
  const stack = [];
  const isWhite = p => d[p * 4] >= thr && d[p * 4 + 1] >= thr && d[p * 4 + 2] >= thr;
  const push = (x, y) => { const p = y * w + x; if (!seen[p]) { seen[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const p = stack.pop();
    if (!isWhite(p)) continue;
    d[p * 4 + 3] = 0;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) push(x - 1, y); if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1); if (y < h - 1) push(x, y + 1);
  }
  ctx.putImageData(id, 0, 0);
}

const CHECKER = 'repeating-conic-gradient(#e8e8e8 0% 25%, #fff 0% 50%) 50% / 18px 18px';

function Slider({ label, value, min, max, step, onChange, color = '#3D5A44' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 96 }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))} style={{ flex: 1, accentColor: color }} />
      <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433', minWidth: 40, textAlign: 'right' }}>
        {Number.isInteger(value) ? value : value.toFixed(2)}
      </span>
    </div>
  );
}

export default function RecolorTester() {
  const [imageUrl, setImageUrl] = useState('');
  const [removeBg, setRemoveBg] = useState(true);
  const [bgThreshold, setBgThreshold] = useState(235);
  const [method, setMethod] = useState('saturated');
  const [guard, setGuard] = useState(12);
  const [sat, setSat] = useState(0.25);
  const [color, setColor] = useState('#e0444e');
  const [base, setBase] = useState(null);   // { canvas, w, h }
  const fileRef = useRef(null);

  // Load + optional background removal — re-runs only on source/bg change.
  useEffect(() => {
    if (!imageUrl) { setBase(null); return; }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      const w = img.naturalWidth, h = img.naturalHeight;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      if (removeBg) removeWhiteBg(ctx, w, h, bgThreshold);
      setBase({ canvas: c, w, h });
    };
    img.onerror = () => { if (!cancelled) setBase(null); };
    img.src = imageUrl;
    return () => { cancelled = true; };
  }, [imageUrl, removeBg, bgThreshold]);

  const region = useMemo(() => (
    method === 'blue_gt_green' ? { method, guard }
    : method === 'saturated'   ? { method, sat }
    : { method }
  ), [method, guard, sat]);

  // Recoloured preview — the cheap step; re-runs on method/param/colour change.
  const recoloredUrl = useMemo(() => {
    if (!base) return null;
    const c = document.createElement('canvas');
    c.width = base.w; c.height = base.h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(base.canvas, 0, 0);
    const id = ctx.getImageData(0, 0, base.w, base.h);
    recolorImageData(id.data, base.w, base.h, color, region);
    ctx.putImageData(id, 0, 0);
    return c.toDataURL();
  }, [base, region, color]);

  const originalUrl = base ? base.canvas.toDataURL() : null;
  const descriptor = JSON.stringify({ recolor: region }, null, 2);
  const activeParam = RECOLOR_METHODS.find(m => m.value === method)?.param;

  const onFile = e => { const f = e.target.files?.[0]; if (f) setImageUrl(URL.createObjectURL(f)); };

  const panel = { background: '#fff', border: '1.5px solid #E8EFE9', borderRadius: 12, padding: 16, marginBottom: 14 };
  const heading = { fontSize: 11, fontWeight: 800, color: '#9B5F72', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 };
  const tile = { flex: 1, minWidth: 0, borderRadius: 12, border: '1px solid #E8EFE9', background: CHECKER, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, minHeight: 320 };

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', fontFamily: "'Quicksand', sans-serif", background: '#EDEAE2' }}>
      {/* Controls */}
      <div style={{ width: 340, overflowY: 'auto', padding: 18, borderRight: '1px solid #DCE5DD' }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, color: '#2C4433', margin: '0 0 4px' }}>Recolour Tester</h2>
        <p style={{ fontSize: 11, color: '#9BB5A2', margin: '0 0 16px', lineHeight: 1.5 }}>
          Runs the designer's exact recolour code. Try methods on an asset, then author the winner on
          the element (<b>Recolourable area</b>).
        </p>

        <div style={panel}>
          <div style={heading}>Image</div>
          <button onClick={() => fileRef.current?.click()}
            style={{ width: '100%', padding: 10, fontSize: 13, fontWeight: 700, color: '#fff', background: '#3D5A44', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
            Choose image…
          </button>
          <input ref={fileRef} type="file" accept="image/*" onChange={onFile} style={{ display: 'none' }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 12, fontWeight: 700, color: '#2C4433' }}>
            <input type="checkbox" checked={removeBg} onChange={e => setRemoveBg(e.target.checked)} />
            Remove white background (test convenience)
          </label>
          {removeBg && <Slider label="White cutoff" value={bgThreshold} min={180} max={252} step={1} onChange={setBgThreshold} color="#7ab0d6" />}
        </div>

        <div style={panel}>
          <div style={heading}>Method</div>
          <select value={method} onChange={e => setMethod(e.target.value)}
            style={{ width: '100%', padding: '9px 10px', fontSize: 13, fontWeight: 700, color: '#2C4433', border: '1.5px solid #C5D4C8', borderRadius: 8, background: '#fff' }}>
            {RECOLOR_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          {activeParam === 'guard' && <Slider label="Edge protect" value={guard} min={0} max={50} step={1} onChange={setGuard} color="#e0a052" />}
          {activeParam === 'sat'   && <Slider label="Saturation min" value={sat} min={0} max={0.8} step={0.01} onChange={setSat} color="#c47ad6" />}
          <p style={{ fontSize: 10, color: '#9BB5A2', margin: '8px 0 0', lineHeight: 1.5 }}>
            <b>Whole image</b>: every pixel. <b>Coloured fill</b>: vivid pixels only (keeps black/white
            lines, any hue). <b>Blue-dominant</b>: blue-leaning fill only (keeps gold/white).
          </p>
        </div>

        <div style={panel}>
          <div style={heading}>Target colour</div>
          <HexColorPicker color={color} onChange={setColor} style={{ width: '100%', height: 130 }} />
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            {['#e0444e', '#3a7bd5', '#2bb673', '#9b59b6', '#f4a9c8', '#f4d58d', '#111111'].map(c => (
              <button key={c} onClick={() => setColor(c)}
                style={{ width: 26, height: 26, borderRadius: '50%', background: c, cursor: 'pointer', border: color.toLowerCase() === c ? '2px solid #2C4433' : '1px solid #C5D4C8' }} />
            ))}
          </div>
        </div>

        <div style={panel}>
          <div style={heading}>placement_config.recolor</div>
          <pre style={{ fontSize: 11, color: '#2C4433', margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', lineHeight: 1.5 }}>{descriptor}</pre>
        </div>
      </div>

      {/* Before / after */}
      <div style={{ flex: 1, padding: 24, overflow: 'auto' }}>
        {!base ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6B8C74', fontWeight: 700 }}>
            ← Choose an image to begin
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 280 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: '#6B8C74', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>Original</div>
              <div style={tile}><img src={originalUrl} alt="original" style={{ maxWidth: '100%', maxHeight: 480, objectFit: 'contain' }} /></div>
            </div>
            <div style={{ flex: 1, minWidth: 280 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: '#9B5F72', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>Recoloured</div>
              <div style={tile}><img src={recoloredUrl} alt="recoloured" style={{ maxWidth: '100%', maxHeight: 480, objectFit: 'contain' }} /></div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
