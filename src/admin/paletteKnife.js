// ── Palette-knife impasto engine (ADMIN-LOCAL, M1) ─────────────────────────────
//
// Lives in admin while we nail the look; ports into core (shared/textures/) for the designer in M2.
// Self-contained (browser canvas + plain math). Direction (agreed): a REAL palette-knife stroke photo
// → extracted into a reusable stamp, then PAINTED many times painter's-style (colour + relief coupled
// per stroke), rendered normal-map-dominant.
//
// Why the photo underperformed before: height was taken from raw luminance, so the GLOSS streaks baked
// in as fake geometry. Fix = extract three layers:
//   • alpha  — soft silhouette from the dark background (the torn stroke shape)
//   • body   — a smooth dome from the silhouette (NOT brightness) → the stroke sits proud
//   • ridge  — a HIGH-PASS of the striations (fine grain only; the broad gloss gradient is discarded)
// height = alpha·(base + body + ridge). Colour is applied per stamp, decoupled so colour edits are cheap.

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const wrap = (a, n) => ((a % n) + n) % n;

// Separable box blur. `tile` = wrap both axes (seamless tile); else clamp at edges (single stamp).
function boxBlur(src, w, h, r, tile = false) {
  if (r <= 0) return src.slice();
  const idx = tile ? (a, n) => wrap(a, n) : (a, n) => (a < 0 ? 0 : a >= n ? n - 1 : a);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; for (let k = -r; k <= r; k++) s += src[y * w + idx(x + k, w)];
    tmp[y * w + x] = s * inv;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; for (let k = -r; k <= r; k++) s += tmp[idx(y + k, h) * w + x];
    out[y * w + x] = s * inv;
  }
  return out;
}

function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => res(img); img.onerror = rej; img.src = url;
  });
}

// Extract a reusable stamp from a palette-knife stroke photo (dark/transparent background, light gloss
// streaks along the grain). Returns { w, h, alpha, height } as Float32 fields in [0,1].
export async function loadStrokeStamp(url, {
  max = 1024, edgeLo = 0.05, edgeHi = 0.14,   // FULL res so the fine striations survive; alpha ramp on luminance
  ridgeAmt = 1.5, bodyAmt = 0.5, basePile = 0.3,
} = {}) {
  const img = await loadImage(url);
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;

  const N = w * h, lum = new Float32Array(N), alpha = new Float32Array(N);
  // Use the PNG alpha channel for the silhouette if the image actually has one; otherwise threshold
  // luminance against the dark background. (This stroke is grayscale-on-black → luminance mode.)
  let hasAlpha = false;
  for (let i = 0; i < N; i++) if (px[4 * i + 3] < 250) { hasAlpha = true; break; }
  for (let i = 0; i < N; i++) {
    const l = (0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2]) / 255;
    lum[i] = l;
    alpha[i] = hasAlpha ? px[4 * i + 3] / 255 : clamp01((l - edgeLo) / (edgeHi - edgeLo));
  }
  // Blur radii scale with resolution so they mean the same thing at any image size.
  const minDim = Math.min(w, h);
  const bodyR = Math.max(2, Math.round(minDim * 0.11));   // big → smooth body dome
  const rFine = Math.max(1, Math.round(minDim * 0.0015)); // tiny → keep the fine striations
  const rWide = Math.max(2, Math.round(minDim * 0.02));   // the broad gloss/shading to subtract out

  // body = smooth dome from the silhouette (blur the mask), kept inside the shape.
  const body0 = boxBlur(alpha, w, h, bodyR);
  let bmax = 1e-6; for (let i = 0; i < N; i++) if (body0[i] > bmax) bmax = body0[i];
  // ridge = high-pass of luminance: fine striations + torn edges kept, broad gloss gradient removed.
  const lumFine = boxBlur(lum, w, h, rFine);
  const lumWide = boxBlur(lum, w, h, rWide);
  const height = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const body = body0[i] / bmax;                 // 0..1 dome
    const ridge = lumFine[i] - lumWide[i];        // signed fine detail (ridges +, grooves −)
    height[i] = clamp01(alpha[i] * (basePile + bodyAmt * body + ridgeAmt * ridge));
  }
  return { w, h, alpha, height };
}

// Tile counts for wrapping the impasto round a tier (each tile ~square: circumference vs wall height).
export function paletteWallTiling(radius, height, tiles = 3) {
  const around = Math.max(1, Math.round(tiles));
  const up = Math.max(1, Math.round(tiles * height / (Math.PI * 2 * radius)));
  return { around, up };
}

// Paint the stamp `count`× into a seamless `size`² tile, painter's-style. Each stamp: dominant `angle`
// ± `spread`, random scale, and an ACCENT flag (prob `accentMix`) → tracked in a tint buffer so colour
// stays decoupled from relief. Height composites "over" with a small `rise` so later strokes sit on
// earlier ones (visible layered edges). Returns detail height + tint accent-ness (both Float32, [0,1]).
export function paintStrokeTile(stamp, {
  size = 768, count = 64, angle = 0, spread = 1.0, scaleMin = 0.5, scaleMax = 0.95,
  seed = 7, accentMix = 0.45, rise = 0.3,
} = {}) {
  const { w: sw, h: sh, alpha: sa, height: shgt } = stamp;
  const H = new Float32Array(size * size);   // detail height (for normal + displacement)
  const T = new Float32Array(size * size);   // accent-ness (0 = base colour, 1 = stroke colour)
  const rnd = mulberry32(seed);
  const longest = Math.max(sw, sh);
  for (let k = 0; k < count; k++) {
    const cx = rnd() * size, cy = rnd() * size;
    const ang = angle + (rnd() - 0.5) * spread;
    const sc = scaleMin + rnd() * (scaleMax - scaleMin);
    const accent = rnd() < accentMix ? 1 : 0;
    const half = sc * longest * 0.55;
    const ca = Math.cos(-ang), sn = Math.sin(-ang);
    for (let ty = Math.floor(cy - half); ty <= cy + half; ty++) {
      for (let tx = Math.floor(cx - half); tx <= cx + half; tx++) {
        const dx = tx - cx, dy = ty - cy;
        const lx = (dx * ca - dy * sn) / sc + sw / 2;
        const ly = (dx * sn + dy * ca) / sc + sh / 2;
        if (lx < 0 || ly < 0 || lx >= sw || ly >= sh) continue;
        const si = (ly | 0) * sw + (lx | 0);
        const a = sa[si];
        if (a <= 0.02) continue;
        const i = wrap(ty, size) * size + wrap(tx, size);
        H[i] = Math.min(1.4, H[i] * (1 - a) + (shgt[si] + H[i] * rise) * a);   // painter's "over" + rise
        T[i] = T[i] * (1 - a) + accent * a;
      }
    }
  }
  return { height: H, tint: T, w: size, h: size };
}

// Blur a tile height field seamlessly (for the modest vertex displacement — mounds only, no ridges).
export function blurTile(field, w, h, r) { return boxBlur(field, w, h, r, true); }

// Two-tone colour bytes (sRGB) from the accent-ness tint: base (cake) ↔ stroke colour. base/stroke =
// [r,g,b] 0-255. Decoupled from the paint pass, so colour edits don't recompute relief.
export function tintToColorField({ tint, w, h }, base, stroke) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const t = tint[i];
    data[4 * i]     = base[0] + (stroke[0] - base[0]) * t;
    data[4 * i + 1] = base[1] + (stroke[1] - base[1]) * t;
    data[4 * i + 2] = base[2] + (stroke[2] - base[2]) * t;
    data[4 * i + 3] = 255;
  }
  return { data, w, h };
}
