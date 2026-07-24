import React, { useCallback, useEffect, useRef, useState } from 'react';
// The SAME renderer the designer inks a customer's number with, and the same one Text Topper Studio
// previews — imported, never copied. `renderTextSlot` takes a NORMALIZED rect and any 2D context, so it
// composites onto a photograph exactly as it composites onto a 1024² plaque, with no adapter between.
import { DEFAULT_TEXT_STYLE, resolveTextStyle, renderTextSlot } from '@spattoo/designer';
import { floodSelect, boxMask, growMask, featherMask, maskBounds, inkColor, inpaintMasked, paintDisc } from './photoEdit.js';

// ── Topper Swap Studio (sandbox) ───────────────────────────────────────────────
// A baker has a reference photo the customer loved and wants ONE thing on it changed: the "A" topper
// should be a "P", the "1" should be a "3". This is the studio for that edit, and it is deliberately
// NOT an image generator: select the region, erase it, composite the replacement from the renderer and
// the element library we already own. Deterministic, free, instant, and it cannot hallucinate a glyph.
//
// It is the photo-space counterpart to Text Topper Studio. That one authors a REUSABLE TEMPLATE in a
// normalized square asset frame, where the surface behind the value is uniform and `applyPatches`'
// clone-stamp is the right erase. This one edits ONE photograph in perspective, where the region behind
// a topper is a boundary between backdrop and cake — hence photoEdit.js's diffusion fill instead.
//
// SANDBOX: nothing is saved. It proves the pipeline reads as convincing before any of it moves into
// spattoo-core or grows a data model. The two open questions it exists to answer are (1) does an erased
// region look erased, and (2) does a composited glyph sit in a photo without looking pasted on.

const MAX_WORK = 1600;   // working resolution cap — flood fill and the fill are O(pixels)
// The canvas BACKING resolution. Not the displayed size — CSS fits the element to whatever box the
// viewport leaves, and zoom scales it from there, which is safe because every pointer maps through
// getBoundingClientRect. Kept well under the work resolution for the reason Text Topper Studio gives:
// the glyph previews at backing size and fondant builds ~11 layer canvases with gaussian blurs at
// O(size²), so a backing raster sized to the photo would cost ~2s of main thread per drag frame.
const MAX_VIEW = 900;
const UNDO_DEPTH = 8;
// A wand flood that escapes its subject swallows the whole photo — cream backdrop and white fondant sit
// well within any tolerance that is loose enough to catch a shaded numeral. Past this share of the frame
// we still SHOW the selection (you need to see what it did) but refuse to adopt it as the replacement's
// box: a full-frame rect means a full-frame glyph, and fondant builds ~11 layer canvases at O(size²).
const MAX_SELECT_SHARE = 0.4;
const MAX_GLYPH = 0.9;   // a replacement never sensibly spans the whole photo

const FAMILIES = ['Impact', 'Arial Black', 'Georgia', 'Trebuchet MS', 'Verdana', 'sans-serif', 'serif'];

const PANEL  = { background: '#fff', border: '1px solid #DCE7E0', borderRadius: 10, padding: 14, marginBottom: 12 };
const LABEL  = { fontSize: 12, fontWeight: 700, color: '#2C4433', display: 'block', marginBottom: 4 };
const HINT   = { fontSize: 11, color: '#7C9686', lineHeight: 1.45, margin: '6px 0 0' };
const BTN    = { padding: '7px 12px', borderRadius: 8, border: '1px solid #BFD5C7', background: '#fff', color: '#2C4433', fontWeight: 700, fontSize: 12, cursor: 'pointer' };
const BTN_ON = { ...BTN, background: '#2C4433', color: '#fff', borderColor: '#2C4433' };

const clampRect = (r) => ({
  ...r,
  w: Math.max(0.02, Math.min(MAX_GLYPH, r.w)),
  h: Math.max(0.02, Math.min(MAX_GLYPH, r.h)),
});

function Slider({ label, value, onChange, min, max, step = 1, suffix = '' }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={LABEL}>{label} <span style={{ fontWeight: 500, color: '#7C9686' }}>{value}{suffix}</span></label>
      <input type="range" min={min} max={max} step={step} value={value}
             onChange={(e) => onChange(Number(e.target.value))} style={{ width: '100%' }} />
    </div>
  );
}

export default function TopperSwapStudio() {
  const viewRef = useRef(null);      // the on-screen canvas
  const workRef = useRef(null);      // full-resolution working image — every accepted edit bakes here
  const origRef = useRef(null);      // the untouched original, for "hold to compare"
  const maskRef = useRef(null);      // Uint8Array(W*H)
  const undoRef = useRef([]);
  const dragRef = useRef(null);      // in-flight pointer gesture
  const wrapRef = useRef(null);      // the box the canvas has to fit inside

  const [dims, setDims]   = useState(null);          // { W, H, vw, vh } — work + view size
  const [tool, setTool]   = useState('box');         // box | wand | brush | unbrush | place
  const [tol, setTol]     = useState(14);
  const [reach, setReach] = useState(20);            // wand's max radius, % of the photo's long edge
  const [drawBox, setDrawBox] = useState(null);      // live box drag, in work pixels
  const [grow, setGrow]   = useState(3);
  const [feather, setFeather] = useState(2);
  const [grain, setGrain] = useState(1);             // match the photo's own noise into the fill
  const [brush, setBrush] = useState(28);
  const [hasMask, setHasMask] = useState(false);
  const [compare, setCompare] = useState(false);
  const [busy, setBusy]   = useState('');
  const [warn, setWarn]   = useState('');
  const [zoom, setZoom]   = useState(1);             // 1 = fit the whole photo in the box
  const [box, setBox]     = useState({ w: 0, h: 0 }); // measured, so "fit" means fit what's actually there
  const [placed, setPlaced] = useState(false);       // the glyph only draws once you ASK for it
  const [tick, setTick]   = useState(0);             // forces a redraw after an imperative canvas edit

  // The replacement glyph.
  const [text, setText]   = useState('3');
  const [algo, setAlgo]   = useState('fondant');
  const [fill, setFill]   = useState('#D6242B');
  const [family, setFamily] = useState('Impact');
  const [fit, setFit]     = useState(0.92);
  const [rot, setRot]     = useState(0);
  const [light, setLight] = useState(135);
  const [bevel, setBevel] = useState(0.5);
  const [gloss, setGloss] = useState(0.55);
  const [shadow, setShadow] = useState(0.35);
  // DEFAULT_TEXT_STYLE carries a dark brown outline at 5% of glyph height, because a topper on a CAKE
  // usually has one. A topper in a PHOTO has whatever the real one had, and the numeral we are matching
  // here has no dark edge at all — so this studio defaults it OFF and lets you dial it back in.
  const [outlineW, setOutlineW] = useState(0);
  const [outlineC, setOutlineC] = useState(DEFAULT_TEXT_STYLE.outline.color);
  const [rect, setRect]   = useState(null);          // normalized centre+size, from the selection

  const style = resolveTextStyle(DEFAULT_TEXT_STYLE, {
    algorithm: algo,
    fill,
    fit,
    font: { family, url: null, weight: 900 },
    outline: { ...DEFAULT_TEXT_STYLE.outline, color: outlineC, width: outlineW },
    fondant: { ...DEFAULT_TEXT_STYLE.fondant, light, bevel, gloss, shadow_alpha: shadow },
  });

  // ── load ────────────────────────────────────────────────────────────────────
  const loadFile = useCallback(async (file) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url;
      });
      const s = Math.min(1, MAX_WORK / Math.max(img.width, img.height));
      const W = Math.round(img.width * s), H = Math.round(img.height * s);
      const work = document.createElement('canvas'); work.width = W; work.height = H;
      work.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, W, H);
      const orig = document.createElement('canvas'); orig.width = W; orig.height = H;
      orig.getContext('2d').drawImage(work, 0, 0);

      const v = Math.min(1, MAX_VIEW / Math.max(W, H));
      workRef.current = work; origRef.current = orig;
      maskRef.current = new Uint8Array(W * H);
      undoRef.current = [];
      setHasMask(false); setRect(null); setPlaced(false); setWarn(''); setZoom(1);
      setDims({ W, H, vw: Math.round(W * v), vh: Math.round(H * v) });
      setTick((t) => t + 1);
    } finally { URL.revokeObjectURL(url); }
  }, []);

  // Measure the box rather than assuming it. "Fit" has to mean fit the room the window actually left
  // after the nav, the toolbar and the page padding — a fixed pixel cap is what pushed the photo off
  // the bottom of the screen.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setBox({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [dims]);

  // Scale to fit BOTH axes (never past 1:1 of the backing raster), then apply zoom on top. The canvas
  // is CSS-scaled, which is only safe because toWork() maps pointers through getBoundingClientRect.
  const fitScale = dims && box.w && box.h
    ? Math.min(box.w / dims.vw, box.h / dims.vh, 1)
    : 1;
  const cssW = dims ? Math.max(1, Math.round(dims.vw * fitScale * zoom)) : 0;
  const cssH = dims ? Math.max(1, Math.round(dims.vh * fitScale * zoom)) : 0;

  // ── draw ────────────────────────────────────────────────────────────────────
  // The glyph previews at VIEW resolution and bakes at WORK resolution. Same normalized rect, same
  // renderer — the reason Text Topper Studio does this is that fondant builds ~11 layer canvases with
  // gaussian blurs at O(size²), so previewing at the size actually displayed is the same picture for a
  // fraction of the pixels, and a drag stays interactive.
  useEffect(() => {
    if (!dims) return;
    const { W, H, vw, vh } = dims;
    const c = viewRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, vw, vh);
    ctx.drawImage(compare ? origRef.current : workRef.current, 0, 0, vw, vh);

    // The selection is drawn as an OUTLINE, never as a tint. A translucent fill covers the very pixels
    // you are trying to judge — whether the erase is clean, whether the replacement's colour matches —
    // which makes the one tool that has to show you the truth the one thing hiding it.
    //
    // Sampled down to view resolution first: rebuilding a multi-megapixel overlay on every brush move is
    // what makes a mask tool feel broken. Inside/outside goes into a flat array so the edge test reads it
    // directly rather than re-sampling the work-resolution mask five times per pixel.
    const mask = maskRef.current;
    if (mask && !compare) {
      const ins = new Uint8Array(vw * vh);
      let any = false;
      for (let y = 0; y < vh; y++) {
        const sy = Math.min(H - 1, Math.floor((y / vh) * H));
        for (let x = 0; x < vw; x++) {
          const sx = Math.min(W - 1, Math.floor((x / vw) * W));
          if (mask[sy * W + sx] >= 128) { ins[y * vw + x] = 1; any = true; }
        }
      }
      if (any) {
        const od = ctx.createImageData(vw, vh);
        for (let y = 0; y < vh; y++) {
          for (let x = 0; x < vw; x++) {
            const i = y * vw + x;
            if (!ins[i]) continue;
            const edge = x === 0 || y === 0 || x === vw - 1 || y === vh - 1
              || !ins[i - 1] || !ins[i + 1] || !ins[i - vw] || !ins[i + vw];
            if (!edge) continue;
            // 2px stamp so the line survives being CSS-scaled down to fit the viewport
            for (let dy = 0; dy <= 1; dy++) {
              for (let dx = 0; dx <= 1; dx++) {
                const xx = x + dx, yy = y + dy;
                if (xx >= vw || yy >= vh) continue;
                const p = (yy * vw + xx) * 4;
                od.data[p] = 255; od.data[p + 1] = 45; od.data[p + 2] = 85; od.data[p + 3] = 255;
              }
            }
          }
        }
        const tmp = document.createElement('canvas'); tmp.width = vw; tmp.height = vh;
        tmp.getContext('2d').putImageData(od, 0, 0);
        ctx.drawImage(tmp, 0, 0);
      }
    }

    if (drawBox && !compare) {
      const sx = vw / W, sy = vh / H;
      ctx.save();
      ctx.strokeStyle = '#FF4060'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.strokeRect(drawBox.x0 * sx, drawBox.y0 * sy, (drawBox.x1 - drawBox.x0) * sx, (drawBox.y1 - drawBox.y0) * sy);
      ctx.restore();
    }

    if (placed && rect && text.trim() && !compare) {
      renderTextSlot(ctx, vw, vh, { rect: { ...rect, rot } }, text, style);
      const bx = (rect.x - rect.w / 2) * vw, by = (rect.y - rect.h / 2) * vh;
      const bw = rect.w * vw, bh = rect.h * vh;
      ctx.save();
      ctx.strokeStyle = '#2C4433'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.strokeRect(bx, by, bw, bh);
      ctx.setLineDash([]); ctx.fillStyle = '#2C4433';
      ctx.fillRect(bx + bw - 5, by + bh - 5, 10, 10);
      ctx.restore();
    }
  }, [dims, tick, compare, rect, placed, text, rot, style, drawBox]);

  // ── history ─────────────────────────────────────────────────────────────────
  const snapshot = () => {
    const { W, H } = dims;
    const ctx = workRef.current.getContext('2d', { willReadFrequently: true });
    undoRef.current.push(ctx.getImageData(0, 0, W, H));
    if (undoRef.current.length > UNDO_DEPTH) undoRef.current.shift();
  };
  const undo = () => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    workRef.current.getContext('2d').putImageData(prev, 0, 0);
    setTick((t) => t + 1);
  };

  // ── pointer ─────────────────────────────────────────────────────────────────
  // Map a pointer to WORK pixels off the canvas's RENDERED size, not its attribute size. The two differ
  // the moment CSS scales the element — browser zoom, or the max-width that keeps it inside a narrow
  // window — and dividing by the attribute size silently offsets every click from what you aimed at.
  const toWork = (e) => {
    const r = viewRef.current.getBoundingClientRect();
    const { W, H } = dims;
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  const onDown = (e) => {
    if (!dims) return;
    viewRef.current.setPointerCapture(e.pointerId);
    const { W, H } = dims;
    const p = toWork(e);

    if (tool === 'box') {
      dragRef.current = { kind: 'box', start: p };
      setDrawBox({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      return;
    }

    if (tool === 'wand') {
      setBusy('selecting…');
      // Defer so the label paints before a synchronous multi-megapixel flood fill locks the thread.
      setTimeout(() => {
        const ctx = workRef.current.getContext('2d', { willReadFrequently: true });
        const img = ctx.getImageData(0, 0, W, H);
        const maxRadius = (reach / 100) * Math.max(W, H);
        const { mask: raw, escaped, share } = floodSelect(img.data, W, H, p.x, p.y, tol, {
          maxRadius, maxShare: MAX_SELECT_SHARE,
        });
        const m = grow ? growMask(raw, W, H, grow) : raw;
        maskRef.current = m;
        const b = maskBounds(m, W, H);
        if (b && !escaped) {
          setRect(clampRect(b.rect));
          setFill(inkColor(img.data, m, W, H));
          setWarn('');
        } else if (b) {
          setWarn(`The flood escaped past ${Math.round(share * 100)}% of the photo and was stopped. Lower Tolerance or Reach, or drag a Box instead — the erase rebuilds the background, so a generous box is fine.`);
        }
        setHasMask(!!b); setBusy(''); setTick((t) => t + 1);
      }, 0);
      return;
    }

    if (tool === 'brush' || tool === 'unbrush') {
      dragRef.current = { kind: tool };
      paintDisc(maskRef.current, W, H, p.x, p.y, brush, tool === 'unbrush');
      setHasMask(true); setTick((t) => t + 1);
      return;
    }

    if (tool === 'place' && rect) {
      const r = viewRef.current.getBoundingClientRect();
      const hx = r.left + (rect.x + rect.w / 2) * r.width;
      const hy = r.top + (rect.y + rect.h / 2) * r.height;
      const near = Math.hypot(e.clientX - hx, e.clientY - hy) < 14;
      dragRef.current = { kind: near ? 'resize' : 'move', start: p, rect: { ...rect } };
    }
  };

  const onMove = (e) => {
    const d = dragRef.current;
    if (!d || !dims) return;
    const { W, H } = dims;
    const p = toWork(e);
    if (d.kind === 'box') {
      setDrawBox({ x0: d.start.x, y0: d.start.y, x1: p.x, y1: p.y });
      return;
    }
    if (d.kind === 'brush' || d.kind === 'unbrush') {
      paintDisc(maskRef.current, W, H, p.x, p.y, brush, d.kind === 'unbrush');
      setTick((t) => t + 1);
      return;
    }
    if (d.kind === 'move') {
      setRect({ ...d.rect, x: d.rect.x + (p.x - d.start.x) / W, y: d.rect.y + (p.y - d.start.y) / H });
    } else if (d.kind === 'resize') {
      setRect(clampRect({
        ...d.rect,
        w: d.rect.w + (2 * (p.x - d.start.x)) / W,
        h: d.rect.h + (2 * (p.y - d.start.y)) / H,
      }));
    }
  };

  const onUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.kind !== 'box' || !drawBox || !dims) { setDrawBox(null); return; }
    const { W, H } = dims;
    // A stray click rather than a drag — ignore it instead of selecting a single pixel.
    if (Math.abs(drawBox.x1 - drawBox.x0) < 4 || Math.abs(drawBox.y1 - drawBox.y0) < 4) { setDrawBox(null); return; }
    const m = boxMask(W, H, drawBox.x0, drawBox.y0, drawBox.x1, drawBox.y1);
    maskRef.current = m;
    const b = maskBounds(m, W, H);
    if (b) {
      setRect(clampRect(b.rect));
      const ctx = workRef.current.getContext('2d', { willReadFrequently: true });
      setFill(inkColor(ctx.getImageData(0, 0, W, H).data, m, W, H));
    }
    setHasMask(!!b); setWarn(''); setDrawBox(null); setTick((t) => t + 1);
  };

  // ── actions ─────────────────────────────────────────────────────────────────
  // A selection is a NOUN; removing and replacing are two different VERBS applied to it. Removing is a
  // complete job on its own and the more common one — the old number gone, a name gone, the
  // photographer's watermark gone — so it must never imply that something gets put back. `andPlace` is
  // passed only by Replace, and it is the ONLY thing that ever puts a glyph on screen.
  const eraseSelection = (andPlace) => {
    if (!hasMask) {
      // Already removed and now they want something in its place: no second erase to do.
      if (andPlace && rect) setPlaced(true);
      return;
    }
    setBusy(andPlace ? 'replacing…' : 'removing…');
    setTimeout(() => {
      const { W, H } = dims;
      snapshot();
      const ctx = workRef.current.getContext('2d', { willReadFrequently: true });
      const img = ctx.getImageData(0, 0, W, H);
      const m = feather ? featherMask(maskRef.current, W, H, feather) : maskRef.current;
      inpaintMasked(img.data, m, W, H, { grain });
      ctx.putImageData(img, 0, 0);
      maskRef.current = new Uint8Array(W * H);
      if (andPlace && rect) setPlaced(true);
      setHasMask(false); setBusy(''); setWarn(''); setTick((t) => t + 1);
    }, 0);
  };

  // One "get me out of this" that drops everything in flight: the selection, a half-dragged box, and any
  // replacement being positioned. There was no way to do this from the canvas at all — the only exits
  // lived in the right-hand panel, which is off-screen the moment the window is narrow or zoomed.
  const clearSelection = useCallback(() => {
    if (!dims) return;
    maskRef.current = new Uint8Array(dims.W * dims.H);
    dragRef.current = null;
    setHasMask(false); setPlaced(false); setDrawBox(null); setWarn(''); setTick((t) => t + 1);
  }, [dims]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'SELECT') return;
      if (e.key === 'Escape') { e.preventDefault(); clearSelection(); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clearSelection]);

  const bake = () => {
    if (!placed || !rect || !text.trim()) return;
    const { W, H } = dims;
    snapshot();
    renderTextSlot(workRef.current.getContext('2d'), W, H, { rect: { ...rect, rot } }, text, style);
    setTick((t) => t + 1);
  };

  const download = () => {
    workRef.current.toBlob((b) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = 'topper-swap.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  };

  // ── ui ──────────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: 20, maxWidth: 1180, margin: '0 auto' }}>
      <h1 style={{ fontSize: 20, color: '#2C4433', margin: '0 0 4px' }}>Topper Swap Studio</h1>
      <p style={{ ...HINT, marginBottom: 16 }}>
        Sandbox — nothing saves. Select a topper on a reference photo, erase it, and composite a
        replacement with the designer&apos;s own text renderer. No image generation, no API call.
      </p>

      {/* minmax(0,…) — a plain `1fr` takes the canvas's intrinsic width as its floor, so the column
          refuses to shrink and pushes the controls off the right of a narrow window. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 18, alignItems: 'start' }}>
        <div>
          <div style={{ ...PANEL, padding: 10 }}
               onDragOver={(e) => e.preventDefault()}
               onDrop={(e) => { e.preventDefault(); loadFile(e.dataTransfer.files?.[0]); }}>
            {/* Height is viewport-relative so the whole photo is visible without scrolling the page;
                when zoomed past fit, THIS box scrolls, not the document. */}
            <div ref={wrapRef}
                 style={{ height: 'calc(100vh - 300px)', minHeight: 320, overflow: zoom > 1 ? 'auto' : 'hidden',
                          display: 'flex' }}>
              {dims ? (
                <canvas ref={viewRef} width={dims.vw} height={dims.vh}
                        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
                        // `margin:auto`, not justify/align-center: a centred flex child that overflows
                        // its scroll container clips its own top-left and cannot be scrolled back to.
                        style={{ display: 'block', borderRadius: 6, flex: 'none', margin: 'auto',
                                 width: cssW ? `${cssW}px` : undefined, height: cssH ? `${cssH}px` : undefined,
                                 cursor: tool === 'place' ? 'move' : 'crosshair', touchAction: 'none' }} />
              ) : (
                <label style={{ ...BTN, display: 'inline-block', margin: 'auto' }}>
                  Choose a cake photo — or drop one here
                  <input type="file" accept="image/*" hidden onChange={(e) => loadFile(e.target.files?.[0])} />
                </label>
              )}
            </div>
          </div>
          {dims && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', marginRight: 4 }}>
                <button style={BTN} onClick={() => setZoom((z) => Math.max(1, +(z - 0.5).toFixed(2)))} disabled={zoom <= 1}>−</button>
                <button style={zoom > 1 ? BTN_ON : BTN} onClick={() => setZoom(1)} title="Fit the whole photo">
                  {zoom > 1 ? `${Math.round(zoom * 100)}%` : 'Fit'}
                </button>
                <button style={BTN} onClick={() => setZoom((z) => Math.min(6, +(z + 0.5).toFixed(2)))} disabled={zoom >= 6}>+</button>
              </span>
              <button style={BTN} onClick={undo}>Undo</button>
              <button style={BTN}
                      onPointerDown={() => setCompare(true)} onPointerUp={() => setCompare(false)}
                      onPointerLeave={() => setCompare(false)}>Hold to compare</button>
              <button style={BTN} onClick={download}>Download PNG</button>
              <label style={{ ...BTN, display: 'inline-block' }}>
                Replace photo
                <input type="file" accept="image/*" hidden onChange={(e) => loadFile(e.target.files?.[0])} />
              </label>
              {busy && <span style={{ ...HINT, alignSelf: 'center', margin: 0 }}>{busy}</span>}
            </div>
          )}
        </div>

        <div>
          <div style={PANEL}>
            <label style={LABEL}>1 · Select</label>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
              {[['box', 'Box'], ['wand', 'Wand'], ['brush', 'Brush +'], ['unbrush', 'Brush −'], ['place', 'Move glyph']].map(([k, l]) => (
                <button key={k} style={tool === k ? BTN_ON : BTN} onClick={() => setTool(k)}>{l}</button>
              ))}
            </div>
            {tool === 'wand' && <Slider label="Tolerance" value={tol} onChange={setTol} min={2} max={60} />}
            {tool === 'wand' && <Slider label="Reach" value={reach} onChange={setReach} min={5} max={60} suffix="%" />}
            {tool === 'wand' && <Slider label="Grow" value={grow} onChange={setGrow} min={0} max={10} suffix="px" />}
            {(tool === 'brush' || tool === 'unbrush') && <Slider label="Brush size" value={brush} onChange={setBrush} min={4} max={120} suffix="px" />}
            {warn && (
              <p style={{ ...HINT, color: '#9A3412', background: '#FEF3E7', border: '1px solid #F5D9BC',
                          borderRadius: 8, padding: '7px 9px', marginTop: 8 }}>{warn}</p>
            )}
            <p style={HINT}>
              {tool === 'wand'
                ? <><b>Reach</b> caps how far the flood can travel from your click — without it, any
                    tolerance loose enough to hold a shaded topper together also steps off into the
                    backdrop and takes the whole photo.</>
                : <><b>Box</b> is the selection that cannot run away. The erase rebuilds what was behind
                    the region, so a box a little larger than the topper costs you nothing.</>}
              {' '}Either way the selection sets the replacement&apos;s colour and position.
            </p>
          </div>

          <div style={PANEL}>
            <label style={LABEL}>2 · What to do with it</label>
            <Slider label="Edge feather" value={feather} onChange={setFeather} min={0} max={8} suffix="px" />
            <Slider label="Grain match" value={grain} onChange={setGrain} min={0} max={2} step={0.1} />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button style={hasMask ? BTN_ON : BTN} onClick={() => eraseSelection(false)} disabled={!hasMask}>
                Remove it
              </button>
              <button style={BTN} onClick={() => eraseSelection(true)} disabled={!hasMask && !rect}>
                Replace with text…
              </button>
              <button style={BTN} onClick={clearSelection} disabled={!hasMask && !placed}>Deselect · Esc</button>
            </div>
            <p style={HINT}>
              <b>Remove it</b> takes it out and leaves the photo clean — a whole job on its own when the
              baker just wants the old number, a name or the photographer&apos;s watermark gone, with
              nothing put back. <b>Replace</b> removes it and then puts something in its place. Either
              way the fill reconstructs the background: reliable against backdrop and plain fondant, but
              against the striped tier it blurs rather than rebuilding stripes.
            </p>
          </div>

          {/* Only exists once Replace was chosen — see eraseSelection(). A removal never summons it. */}
          {placed && <div style={PANEL}>
            <label style={LABEL}>3 · Replacement</label>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="3" autoFocus
                     style={{ flex: 1, padding: '7px 9px', borderRadius: 8, border: '1px solid #DCE7E0', fontSize: 14 }} />
              <input type="color" value={fill} onChange={(e) => setFill(e.target.value)}
                     style={{ width: 40, height: 34, padding: 0, border: '1px solid #DCE7E0', borderRadius: 8 }} />
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <select value={algo} onChange={(e) => setAlgo(e.target.value)} style={{ flex: 1, padding: 6, borderRadius: 8, border: '1px solid #DCE7E0' }}>
                <option value="fondant">fondant</option>
                <option value="scribble">scribble</option>
                <option value="flat">flat</option>
              </select>
              <select value={family} onChange={(e) => setFamily(e.target.value)} style={{ flex: 1, padding: 6, borderRadius: 8, border: '1px solid #DCE7E0' }}>
                {FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <Slider label="Fill box" value={fit} onChange={setFit} min={0.4} max={1} step={0.01} />
            <Slider label="Rotation" value={rot} onChange={setRot} min={-30} max={30} suffix="°" />
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <Slider label="Outline" value={outlineW} onChange={setOutlineW} min={0} max={0.12} step={0.005} />
              </div>
              <input type="color" value={outlineC} onChange={(e) => setOutlineC(e.target.value)}
                     title="Outline colour" disabled={!outlineW}
                     style={{ width: 40, height: 34, padding: 0, border: '1px solid #DCE7E0', borderRadius: 8,
                              marginBottom: 10, opacity: outlineW ? 1 : 0.4 }} />
            </div>
            {algo === 'fondant' && <>
              <Slider label="Light from" value={light} onChange={setLight} min={0} max={360} suffix="°" />
              <Slider label="Bevel"  value={bevel}  onChange={setBevel}  min={0} max={1} step={0.05} />
              <Slider label="Gloss"  value={gloss}  onChange={setGloss}  min={0} max={1} step={0.05} />
              <Slider label="Shadow" value={shadow} onChange={setShadow} min={0} max={1} step={0.05} />
            </>}
            <div style={{ display: 'flex', gap: 6 }}>
              <button style={BTN_ON} onClick={bake}>Bake into photo</button>
              <button style={BTN} onClick={() => setPlaced(false)}>Cancel replacement</button>
            </div>
            <p style={HINT}>
              Sized to what you selected. Switch to <b>Move glyph</b> to drag it, or drag the
              bottom-right handle to resize. Baking is permanent on the working image; undo is the way
              back. <b>Cancel</b> drops the replacement and leaves the removal as it is.
            </p>
          </div>}
        </div>
      </div>
    </div>
  );
}
