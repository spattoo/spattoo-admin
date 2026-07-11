// ── Text slots ────────────────────────────────────────────────────────────────
// The ONE renderer for "template artwork + editable text placeholders". A template element carries
// `placement_config.text_slots` — an array of named slots ({number}, {name}, …) — and the customer's
// values are rendered INTO the artwork on a 2D canvas at design time. Consequences of that choice:
//   • assets are O(1) per template — a value is never an asset, so "2", "47" and "Amara" cost nothing;
//   • nothing branches on element type or slug (INVARIANTS #1) — a template with 0 slots is a plain
//     sticker, 1 slot is a number plaque, 2 is a "Happy 5th, Amara" banner.
//
// The data↔code seam mirrors cake_textures: `style.algorithm` KEYS into ALGORITHMS below. A brand-new
// look needs a new strategy here; tuning an existing one is pure config (a DB `text_styles` row).
//
// Geometry is NORMALIZED (0..1 of the artwork square) so a slot survives any raster size.
// This module is pure canvas-2D + framework-free ON PURPOSE: admin previews with it today and the
// designer's StickerTexture will render with the SAME module, so the two cannot drift.

// The ONE CORS qualifier (spattoo-core/src/designer/utils/assetUrl.js) — imported, never re-inlined.
// A webfont is always fetched in CORS mode, so it is exposed to the same R2 cache-poisoning failure as
// a texture: a cached no-ACAO response would block the FontFace load and the topper would silently
// fall back to sans-serif. When this module is ported into core, this import becomes '../utils/assetUrl.js'.
import { corsUrl } from '@spattoo/designer';

export const TEXT_SLOT_KINDS = Object.freeze({ NUMBER: 'number', TEXT: 'text' });

// A style's tunable params. `algorithm` picks the strategy; everything else is config.
export const DEFAULT_TEXT_STYLE = Object.freeze({
  algorithm: 'scribble',
  font: { family: 'sans-serif', url: null, weight: 800 },
  fill: '#5A3410',
  hatch: { color: '#F3E3C8', angle: -35, gap: 0.055, width: 0.014 }, // gap/width are fractions of glyph height
  outline: { color: '#3F230A', width: 0.05, wobble: 0.35 },          // width is a fraction of glyph height
  tracking: 0,      // extra letter-spacing, fraction of glyph height
  fit: 0.92,        // how much of the slot the text fills
});

// Deep-merge a style preset with a per-slot override, so a slot can tweak one field (e.g. fill) without
// restating the whole preset. One level of nesting is all the shape has.
export function resolveStyle(preset, override) {
  const out = { ...DEFAULT_TEXT_STYLE, ...(preset || {}), ...(override || {}) };
  for (const k of ['font', 'hatch', 'outline']) {
    out[k] = { ...DEFAULT_TEXT_STYLE[k], ...(preset?.[k] || {}), ...(override?.[k] || {}) };
  }
  return out;
}

// Load a style's webfont so canvas can shape with it. A style's font is DATA (an uploaded woff2), not a
// hardcoded family — so a new art style never needs a code change. Idempotent + cached per family+url.
const _fontCache = new Map();
export function loadStyleFont(font) {
  const family = font?.family;
  if (!family || !font?.url) return Promise.resolve(family || 'sans-serif');
  const ck = `${family}|${font.url}`;
  if (_fontCache.has(ck)) return _fontCache.get(ck);
  const p = (async () => {
    const face = new FontFace(family, `url(${JSON.stringify(corsUrl(font.url))})`, { weight: String(font.weight ?? 800) });
    await face.load();
    document.fonts.add(face);
    return family;
  })().catch(() => 'sans-serif'); // a dead font URL degrades to the default face, never a blank topper
  _fontCache.set(ck, p);
  return p;
}
export function loadSlotFonts(slots, styleOf) {
  return Promise.all((slots || []).map(sl => loadStyleFont(resolveStyle(styleOf(sl), sl.style_override).font)));
}

function cssFont(style, px) {
  const f = style.font || {};
  return `${f.weight ?? 800} ${px}px ${JSON.stringify(f.family || 'sans-serif')}, sans-serif`;
}

// Largest font size at which `text` fits the slot box, so a 1-char "2" and a 9-char name both sit right.
// Binary search on the real measured metrics — never a guessed ratio.
function fitFontSize(ctx, text, style, boxW, boxH) {
  const track = t => (style.tracking || 0) * t;
  let lo = 1, hi = Math.ceil(boxH * 2), best = 1;
  for (let i = 0; i < 24 && lo <= hi; i++) {
    const mid = (lo + hi) / 2;
    ctx.font = cssFont(style, mid);
    const m = ctx.measureText(text);
    const w = m.width + track(mid) * Math.max(0, text.length - 1);
    const asc = m.actualBoundingBoxAscent || mid * 0.72;
    const desc = m.actualBoundingBoxDescent || mid * 0.22;
    const h = asc + desc;
    if (w <= boxW && h <= boxH) { best = mid; lo = mid + 0.5; } else { hi = mid - 0.5; }
  }
  return best;
}

// Draw `text` centred at the origin, letter by letter, so `tracking` is honoured. `draw` does the ink.
function eachGlyph(ctx, text, size, style, draw) {
  const track = (style.tracking || 0) * size;
  const widths = [...text].map(ch => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + track * Math.max(0, text.length - 1);
  let x = -total / 2;
  [...text].forEach((ch, i) => {
    draw(ch, x + widths[i] / 2);
    x += widths[i] + track;
  });
}

// ── Strategies ────────────────────────────────────────────────────────────────
// A strategy inks ONE slot's text into `ctx`, already translated+rotated to the slot centre with the
// font size resolved. Adding a look = adding a key here (+ its params to the style config).

// 'scribble' — the hand-drawn plaque look: a solid glyph with light hairlines CARVED through it
// (the "scribble" is the gaps, not the strokes) under a darker, slightly wobbly outline.
function inkScribble(ctx, text, size, style) {
  const { fill, hatch, outline } = style;
  const ow = (outline.width || 0) * size;

  // The outline ring: stroke UNDER the fill so only its outer half survives. Re-stroked at small
  // offsets to fake the wobble of a hand-drawn line.
  if (ow > 0) {
    ctx.save();
    ctx.strokeStyle = outline.color;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const jitter = (outline.wobble || 0) * ow * 0.5;
    const passes = jitter > 0
      ? [[0, 0], [jitter, jitter * 0.6], [-jitter * 0.7, jitter * 0.4], [jitter * 0.3, -jitter * 0.8]]
      : [[0, 0]];
    for (const [dx, dy] of passes) {
      ctx.lineWidth = ow * 2; // half sits inside the glyph and is covered by the fill below
      eachGlyph(ctx, text, size, style, (ch, cx) => ctx.strokeText(ch, cx + dx, dy));
    }
    ctx.restore();
  }

  // The glyph interior, drawn on its own layer so the hatch can be clipped to it (`source-atop`)
  // without ever touching the outline ring.
  const pad = Math.ceil(ow * 3 + size * 0.5);
  const w = Math.ceil(ctx.measureText(text).width + (style.tracking || 0) * size * text.length) + pad * 2;
  const h = Math.ceil(size * 2) + pad * 2;
  const lay = document.createElement('canvas');
  lay.width = Math.max(1, w); lay.height = Math.max(1, h);
  const lx = lay.getContext('2d');
  lx.font = ctx.font;
  lx.textAlign = 'center';
  lx.textBaseline = 'middle';
  lx.translate(w / 2, h / 2);

  lx.fillStyle = fill;
  eachGlyph(lx, text, size, style, (ch, cx) => lx.fillText(ch, cx, 0));

  // Carve the hairlines: they exist ONLY where the glyph already is.
  const gap = (hatch?.gap || 0) * size;
  if (gap > 0.4) {
    lx.save();
    lx.globalCompositeOperation = 'source-atop';
    lx.strokeStyle = hatch.color;
    lx.lineWidth = Math.max(0.5, (hatch.width || 0) * size);
    lx.lineCap = 'round';
    lx.rotate(((hatch.angle || 0) * Math.PI) / 180);
    const span = Math.hypot(w, h);
    lx.beginPath();
    for (let y = -span / 2; y <= span / 2; y += gap) {
      lx.moveTo(-span / 2, y);
      lx.lineTo(span / 2, y);
    }
    lx.stroke();
    lx.restore();
  }

  ctx.drawImage(lay, -w / 2, -h / 2);
}

// 'flat' — the plain look: solid fill + optional outline, no hatch. The baseline every style degrades to.
function inkFlat(ctx, text, size, style) {
  const ow = (style.outline?.width || 0) * size;
  if (ow > 0) {
    ctx.strokeStyle = style.outline.color;
    ctx.lineJoin = 'round';
    ctx.lineWidth = ow * 2;
    eachGlyph(ctx, text, size, style, (ch, cx) => ctx.strokeText(ch, cx, 0));
  }
  ctx.fillStyle = style.fill;
  eachGlyph(ctx, text, size, style, (ch, cx) => ctx.fillText(ch, cx, 0));
}

export const ALGORITHMS = Object.freeze({ scribble: inkScribble, flat: inkFlat });

// Render one slot's value into an S×S canvas context. `rect` is normalized (0..1).
export function renderTextSlot(ctx, S, slot, text, style) {
  const value = String(text ?? '').trim();
  if (!value) return;
  const r = slot.rect || {};
  const boxW = (r.w ?? 0.4) * S;
  const boxH = (r.h ?? 0.4) * S;
  if (boxW < 1 || boxH < 1) return;

  ctx.save();
  ctx.translate((r.x ?? 0.5) * S, (r.y ?? 0.5) * S);
  ctx.rotate(((r.rot || 0) * Math.PI) / 180);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const fit = style.fit ?? 0.92;
  const size = fitFontSize(ctx, value, style, boxW * fit, boxH * fit);
  ctx.font = cssFont(style, size);

  const ink = ALGORITHMS[style.algorithm] || inkFlat;
  ink(ctx, value, size, style);
  ctx.restore();
}

// The whole topper: artwork + every slot's value inked in. This is what the admin preview shows and
// what the designer will turn into a CanvasTexture — ONE function, so they cannot disagree.
export function composeTextTopper(S, artworkImg, slots, values, styleOf) {
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  if (artworkImg) ctx.drawImage(artworkImg, 0, 0, S, S);
  for (const slot of slots || []) {
    const style = resolveStyle(styleOf(slot), slot.style_override);
    const v = values?.[slot.key] ?? slot.default ?? '';
    renderTextSlot(ctx, S, slot, v, style);
  }
  return c;
}

// ── Clean plate (authoring-time only) ─────────────────────────────────────────
// Stock artwork usually has a value BAKED IN (the "2"). A patch clone-stamps a clean region of the same
// artwork over it, so existing art works without being re-sourced. Patches are baked into the uploaded
// image at SAVE time — the designer never sees them, so there is no runtime patch path to maintain.
// `patch = { rect:{x,y,w,h}, from:{x,y,s} }`, all normalized. `from` is a SMALL clean SAMPLE (centre +
// side `s`) that is mirror-tiled to fill `rect` — NOT a same-size copy of the region. That distinction
// is the whole trick: a same-size clone needs a clean area as big as the text box, and on a
// background-removed plaque no such area exists (the disc is barely bigger than the box), so the search
// finds nothing and you end up cloning transparency. A small sample always has somewhere to come from,
// and mirroring hides the tile seams on near-uniform paper/fondant.
export function applyPatches(canvas, patches) {
  const ctx = canvas.getContext('2d');
  const S = canvas.width;
  for (const p of patches || []) {
    const r = p.rect || {};
    const w = (r.w ?? 0) * S, h = (r.h ?? 0) * S;
    if (w < 1 || h < 1) continue;
    const dx = ((r.x ?? 0.5) * S) - w / 2;
    const dy = ((r.y ?? 0.5) * S) - h / 2;
    const fx = (p.from?.x ?? 0.5) * S;
    const fy = (p.from?.y ?? 0.5) * S;
    const side = Math.max(2, Math.round((p.from?.s ?? 0.08) * S));

    // Cut the sample out first — drawing a canvas onto itself with overlapping rects is undefined.
    const cut = document.createElement('canvas');
    cut.width = side; cut.height = side;
    cut.getContext('2d').drawImage(canvas, fx - side / 2, fy - side / 2, side, side, 0, 0, side, side);

    // A 2×2 mirrored block tiles seamlessly in both axes.
    const tile = document.createElement('canvas');
    tile.width = side * 2; tile.height = side * 2;
    const tx = tile.getContext('2d');
    tx.drawImage(cut, 0, 0);
    tx.save(); tx.translate(side * 2, 0); tx.scale(-1, 1); tx.drawImage(cut, 0, 0); tx.restore();
    tx.save(); tx.translate(0, side * 2); tx.scale(1, -1); tx.drawImage(cut, 0, 0); tx.restore();
    tx.save(); tx.translate(side * 2, side * 2); tx.scale(-1, -1); tx.drawImage(cut, 0, 0); tx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, w, h);
    ctx.clip();
    ctx.fillStyle = ctx.createPattern(tile, 'repeat');
    ctx.translate(dx, dy);
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
  return canvas;
}

// A slot that COVERS what it replaces is just a patch on the slot's own rect — same one mechanism, so
// there is no second clone path to keep in step. This is what makes dropping a placeholder onto a
// baked-in "2" erase it, instead of drawing "23".
export function coverPatches(slots) {
  return (slots || [])
    .filter(sl => sl.cover?.from)
    .map(sl => ({ rect: sl.rect, from: sl.cover.from }));
}

// The artwork with every patch baked in — the image uploaded as the element's image_url. Covers bake in
// too, so the designer only ever sees clean artwork and never replays a clone.
export function bakeArtwork(S, artworkImg, patches, slots) {
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  c.getContext('2d').drawImage(artworkImg, 0, 0, S, S);
  return applyPatches(c, [...(patches || []), ...coverPatches(slots)]);
}

// Auto-pick a SMALL clean SAMPLE to tile over the slot: the flattest fully-opaque square on the artwork
// — bare plaque/paper, never a glyph, a leaf or an animal. Flatness = low luminance variance. The square
// is deliberately small (a fraction of the box, not its size) so that one actually EXISTS: on a
// background-removed plaque there is no clean area as large as the text box.
//
// Rejects any candidate that (a) touches a transparent pixel — that's off the artwork — or (b) overlaps
// the slot, which would sample the very value we're covering. Runs on a small analysis raster, so cost
// is independent of the artwork's real resolution. Returns { x, y, s } (centre + side, normalized).
export function findCleanSource(img, rect, { A = 200, grid = 44 } = {}) {
  // Sample side: small enough to find, big enough to carry the paper's grain.
  const s = Math.min(0.10, Math.max(0.04, Math.min(rect.w, rect.h) / 3));
  const fallback = { x: rect.x, y: Math.min(0.95, rect.y + rect.h / 2 + s), s };

  const c = document.createElement('canvas');
  c.width = A; c.height = A;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0, A, A);
  let d;
  try { d = x.getImageData(0, 0, A, A).data; } catch { return fallback; }  // CORS-tainted → don't guess

  const side = Math.max(3, Math.round(s * A));
  const half = side / 2;

  // Search the RING around the slot first, widening only if nothing clean is there. We want the surface
  // the text SITS ON (the plaque), and that is by definition right next to the box. Searching the whole
  // artwork for the globally flattest patch is wrong: a flat pastel cartoon fill (an elephant's body) is
  // smoother than textured paper, so "flattest" happily picks the elephant.
  const reach = Math.max(rect.w, rect.h);
  for (const radius of [reach * 1.15, reach * 1.6, Infinity]) {
    let best = null;
    for (let gy = 0; gy <= grid; gy++) {
      for (let gx = 0; gx <= grid; gx++) {
        const cx = half + (gx / grid) * (A - side);
        const cy = half + (gy / grid) * (A - side);
        const nx = cx / A, ny = cy / A;

        if (Math.hypot(nx - rect.x, ny - rect.y) > radius) continue;
        // Overlap with the slot (AABB, sample vs box) → it would sample the value being covered.
        if (Math.abs(nx - rect.x) < (rect.w + s) / 2 && Math.abs(ny - rect.y) < (rect.h + s) / 2) continue;

        let n = 0, sum = 0, sumSq = 0, opaque = true;
        for (let py = Math.round(cy - half); py < cy + half && opaque; py++) {
          for (let px = Math.round(cx - half); px < cx + half; px++) {
            const i = ((py * A) + px) * 4;
            if (d[i + 3] < 250) { opaque = false; break; }          // transparent → off the artwork
            const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            sum += l; sumSq += l * l; n++;
          }
        }
        if (!opaque || n < 4) continue;
        const variance = sumSq / n - (sum / n) ** 2;
        if (!best || variance < best.variance) best = { variance, x: nx, y: ny, s };
      }
    }
    if (best) return best;
  }
  return fallback;
}
