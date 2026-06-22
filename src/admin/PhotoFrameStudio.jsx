import React, { useEffect, useRef, useState } from 'react';
import { fetchElementTypes, getSignedUploadUrl, uploadToR2, createGlobalElement } from '../lib/api.js';

// ── Photo Frame Studio ─────────────────────────────────────────────────────────
// Authors a "photo cake" frame as ONE cake_elements row. The SHAPE MASK is the core asset (the
// window/outline — heart, circle, square…): it clips the customer's photo AND drives a procedural
// border (a colour ring of adjustable width, 0 = none). An optional decorative overlay PNG (glitter,
// piped cream) can supply fancy border art instead. Data model:
//   image_url                       = the mask (shape)
//   placement_config.photo.mask     = the mask (same key)
//   placement_config.photo.overlay  = optional decorative border art
//   placement_config.photo.border   = { width }  (default thin; customer adjusts/recolours in designer)
// Reuses createGlobalElement + the upload helpers — not a parallel element-creation path.

const FRAME_PLACEMENT = { top_surface: 'hug', side: 'hug' };
const FRAME_ZONES = ['top_surface', 'side'];
const FRAME_ACTIONS = { resize: true, duplicate: true, color: true, gradient: false, delete: true, move: false, tilt: false };
const DEFAULT_BORDER_WIDTH = 0.06;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(img); URL.revokeObjectURL(url); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

// Cover-fit a source image into an S×S square (fill, crop overflow, never distort).
function drawCover(ctx, img, S) {
  const ar = (img.width || 1) / (img.height || 1);
  let dw, dh;
  if (ar >= 1) { dh = S; dw = S * ar; } else { dw = S; dh = S / ar; }
  ctx.drawImage(img, (S - dw) / 2, (S - dh) / 2, dw, dh);
}

// The mask silhouette filled with one colour (its alpha = the shape).
function tintedMask(maskImg, S, color) {
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const x = c.getContext('2d');
  x.fillStyle = color || '#ffffff'; x.fillRect(0, 0, S, S);
  x.globalCompositeOperation = 'destination-in'; x.drawImage(maskImg, 0, 0, S, S);
  return c;
}

// The photo (or a placeholder) clipped to the mask shape.
function clippedPhoto(photoImg, maskImg, S) {
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const x = c.getContext('2d');
  if (photoImg) {
    drawCover(x, photoImg, S);
  } else {
    const g = x.createLinearGradient(0, 0, S, S);
    g.addColorStop(0, '#bcd3e6'); g.addColorStop(1, '#f2d9c4');
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    x.fillStyle = 'rgba(255,255,255,0.55)';
    x.beginPath(); x.arc(S * 0.5, S * 0.42, S * 0.16, 0, Math.PI * 2); x.fill();
    x.beginPath(); x.ellipse(S * 0.5, S * 0.86, S * 0.30, S * 0.22, 0, Math.PI, 0); x.fill();
  }
  if (maskImg) { x.globalCompositeOperation = 'destination-in'; x.drawImage(maskImg, 0, 0, S, S); }
  return c;
}

// Mirrors the designer render: border (procedural ring or decorative overlay) + photo clipped to mask.
function composite(S, photoImg, maskImg, overlayImg, borderColor, borderW) {
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  if (maskImg && !overlayImg && borderW > 0) {
    const bc = tintedMask(maskImg, S, borderColor);
    const sw = S * (1 + borderW), off = (S - sw) / 2;
    ctx.drawImage(bc, off, off, sw, sw);     // colour ring, scaled up, behind the photo
  }
  if (maskImg) ctx.drawImage(clippedPhoto(photoImg, maskImg, S), 0, 0);
  if (overlayImg) ctx.drawImage(overlayImg, 0, 0, S, S);
  return c;
}

function Drop({ label, hint, accept, file, onChange }) {
  return (
    <label style={s.fileBox}>
      <input type="file" accept={accept} style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onChange(f); }} />
      <div style={{ fontSize: 12, fontWeight: 700, color: '#2C4433' }}>{file ? file.name : label}</div>
      {hint && <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 2 }}>{hint}</div>}
    </label>
  );
}

export default function PhotoFrameStudio() {
  const [elementTypes, setElementTypes] = useState([]);
  const [name, setName]                 = useState('');
  const [elementTypeId, setTypeId]      = useState('');
  const [maskFile, setMaskFile]         = useState(null);   // shape (required)
  const [overlayFile, setOverlayFile]   = useState(null);   // decorative border art (optional)
  const [sampleFile, setSampleFile]     = useState(null);   // sample photo for the thumbnail (optional)
  const [borderColor, setBorderColor]   = useState('#ffffff');
  const [maskImg, setMaskImg]           = useState(null);
  const [overlayImg, setOverlayImg]     = useState(null);
  const [sampleImg, setSampleImg]       = useState(null);
  const [saving, setSaving]             = useState(false);
  const [msg, setMsg]                   = useState(null);
  const previewRef = useRef(null);

  useEffect(() => { fetchElementTypes().then(setElementTypes).catch(() => setElementTypes([])); }, []);
  useEffect(() => { if (maskFile)    loadImage(maskFile).then(setMaskImg).catch(() => setMaskImg(null));       else setMaskImg(null); }, [maskFile]);
  useEffect(() => { if (overlayFile) loadImage(overlayFile).then(setOverlayImg).catch(() => setOverlayImg(null)); else setOverlayImg(null); }, [overlayFile]);
  useEffect(() => { if (sampleFile)  loadImage(sampleFile).then(setSampleImg).catch(() => setSampleImg(null)); else setSampleImg(null); }, [sampleFile]);

  useEffect(() => {
    const cv = previewRef.current;
    if (!cv) return;
    const S = cv.width, ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, S, S);
    const t = 16;
    for (let y = 0; y < S; y += t) for (let x = 0; x < S; x += t) {
      ctx.fillStyle = ((x / t + y / t) % 2 === 0) ? '#eceff1' : '#dfe4e7';
      ctx.fillRect(x, y, t, t);
    }
    if (maskImg) ctx.drawImage(composite(S, sampleImg, maskImg, overlayImg, borderColor, DEFAULT_BORDER_WIDTH), 0, 0);
  }, [maskImg, overlayImg, sampleImg, borderColor]);

  async function uploadOne(folder, file, contentType) {
    const ext = (file.name?.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    const filename = `${crypto.randomUUID()}.${ext}`;
    const { url, key } = await getSignedUploadUrl(folder, filename, contentType);
    await uploadToR2(url, file);
    return key;
  }

  async function handleSave() {
    if (!name.trim())   { setMsg({ ok: false, text: 'Name is required.' }); return; }
    if (!elementTypeId) { setMsg({ ok: false, text: 'Pick an element type.' }); return; }
    if (!maskFile)      { setMsg({ ok: false, text: 'Upload the frame shape (window mask).' }); return; }
    setSaving(true); setMsg(null);
    try {
      const maskKey = await uploadOne('elements/files/2D', maskFile, maskFile.type || 'image/png');
      const overlayKey = overlayFile ? await uploadOne('elements/files/2D', overlayFile, overlayFile.type || 'image/png') : null;
      // Thumbnail = the composited frame (border + photo + optional overlay) so the tile reads right.
      const thumbBlob = await new Promise(res => composite(512, sampleImg, maskImg, overlayImg, borderColor, DEFAULT_BORDER_WIDTH).toBlob(res, 'image/png'));
      const thumbKey  = await uploadOne('elements/thumbnails', new File([thumbBlob], 'thumb.png', { type: 'image/png' }), 'image/png');

      const photo = { mask: maskKey, border: { width: DEFAULT_BORDER_WIDTH } };
      if (overlayKey) photo.overlay = overlayKey;

      await createGlobalElement({
        name:             name.trim(),
        description:      null,
        element_type_id:  elementTypeId,
        parent_id:        null,
        image_url:        maskKey,                       // the mask IS the shape asset for a frame
        thumbnail_url:    thumbKey,
        file_size:        maskFile.size ?? null,
        allowed_zones:    FRAME_ZONES,
        placement_config: { ...FRAME_PLACEMENT, photo },
        allowed_actions:  FRAME_ACTIONS,
        default_color:    borderColor,                   // default border colour (customer can recolour)
        sort_order:       0,
      });

      setMsg({ ok: true, text: 'Photo frame element saved!' });
      setName(''); setMaskFile(null); setOverlayFile(null); setSampleFile(null);
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Save failed.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Photo Frame Studio</h1>
      <p style={s.sub}>
        Author a "photo cake" frame in one element. Upload the <b>frame shape</b> (a white window
        silhouette on transparent — heart, circle, square…). The customer's photo is clipped to it,
        and a <b>border</b> is drawn around it (adjustable width &amp; colour in the designer; 0 = none).
        Optionally add a <b>decorative border overlay</b> for fancy art (glitter, piped cream).
      </p>

      <div style={s.grid}>
        <div style={s.col}>
          <label style={s.label}>Name</label>
          <input style={s.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Heart Photo Frame" />

          <label style={s.label}>Element type</label>
          <select style={s.select} value={elementTypeId} onChange={e => setTypeId(e.target.value)}>
            <option value="">Select type…</option>
            {elementTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>

          <Drop label="Frame shape — window mask (PNG: white window on transparent)" hint="Required. The photo's shape + the border's shape. → image_url / placement_config.photo.mask" accept="image/png" file={maskFile} onChange={setMaskFile} />
          <Drop label="Decorative border overlay (PNG, optional)" hint="Fancy border art (glitter, piping) drawn on top. If set, it replaces the procedural border. → placement_config.photo.overlay" accept="image/*" file={overlayFile} onChange={setOverlayFile} />
          <Drop label="Sample photo (optional — for the thumbnail)" hint="Shown behind the frame in the preview/tile. A placeholder is used if omitted." accept="image/*" file={sampleFile} onChange={setSampleFile} />

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433' }}>Default border colour</span>
            <input type="color" value={borderColor} onChange={e => setBorderColor(e.target.value)}
              style={{ width: 40, height: 32, border: '1.5px solid #C5D4C8', borderRadius: 6, cursor: 'pointer', padding: 2 }} />
            <span style={{ fontSize: 11, color: '#6B8C74' }}>customer can recolour &amp; resize it</span>
          </div>

          <div style={s.infoBox}>
            Auto-config: placed on <b>Top + Side</b>, lies flat (<b>hug</b>), thin default border, one photo per placed frame.
          </div>

          <button style={{ ...s.btn, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={handleSave}>
            {saving ? 'Saving…' : 'Save photo frame element'}
          </button>
          {msg && <div style={{ ...s.msg, color: msg.ok ? '#2e7d32' : '#c0392b' }}>{msg.text}</div>}
        </div>

        <div style={s.col}>
          <label style={s.label}>Live preview</label>
          <canvas ref={previewRef} width={420} height={420} style={s.canvas} />
          <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 6 }}>
            Photo clipped to the shape, with the default border around it (overlay on top if provided).
            The checkerboard is transparent area (the cake shows there).
          </div>
        </div>
      </div>
    </div>
  );
}

const s = {
  page:   { maxWidth: 960, margin: '0 auto', padding: '24px 20px 64px', fontFamily: "'Quicksand', sans-serif" },
  h1:     { fontSize: 22, fontWeight: 800, color: '#2C4433', margin: '0 0 6px' },
  sub:    { fontSize: 13, color: '#5C7565', lineHeight: 1.6, margin: '0 0 20px' },
  grid:   { display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-start' },
  col:    { flex: '1 1 360px', minWidth: 320, display: 'flex', flexDirection: 'column' },
  label:  { fontSize: 12, fontWeight: 700, color: '#2C4433', margin: '12px 0 4px' },
  input:  { padding: '9px 12px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontSize: 13, fontFamily: 'inherit', outline: 'none' },
  select: { padding: '9px 12px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontSize: 13, fontFamily: 'inherit', background: '#fff' },
  fileBox:{ display: 'block', marginTop: 8, padding: '12px 14px', borderRadius: 10, border: '1.5px dashed #C5D4C8', background: '#F7FAF8', cursor: 'pointer' },
  infoBox:{ marginTop: 14, padding: '10px 12px', borderRadius: 8, background: '#EEF5F0', border: '1px solid #D6E3DA', fontSize: 12, color: '#3D5A44', lineHeight: 1.5 },
  btn:    { marginTop: 16, padding: '11px 16px', borderRadius: 10, border: 'none', background: '#3D5A44', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  msg:    { marginTop: 10, fontSize: 13, fontWeight: 700 },
  canvas: { width: 420, height: 420, maxWidth: '100%', borderRadius: 12, border: '1.5px solid #C5D4C8', background: '#fff' },
};
