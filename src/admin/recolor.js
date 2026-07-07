// Shared image recolour for the element studios (butterfly wings, relief stickers, …).
//
// Luminance-preserving hue replacement: repaint a "tintable region" of a canvas to the picked colour while
// keeping each pixel's brightness deviation, so shading + highlights survive (the pick becomes the region's
// overall tone, not a flat fill). The region is chosen by a per-pixel predicate, so each asset decides what
// to recolour — a whole saturated body (single-colour stickers) or one specific fill (a butterfly wing).
//
// This is the "tintable region" concept that ports to core: an element the designer can recolour per instance.

export function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

export function hslToRgb(h, s, l) {
  h /= 360;
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)].map(x => Math.round(x * 255));
}

// Recolour, in place, every pixel where isRegion(data, i) is true → targetHex, preserving brightness.
// `data` is the RGBA byte array, `i` the pixel's base index. Pass 1 finds the region's average lightness;
// pass 2 repaints with the target hue/sat and re-adds each pixel's lightness deviation from that average,
// so shadows/highlights are kept and only the tone shifts to the pick. No-op if the region is empty.
export function recolorRegion(canvas, targetHex, isRegion) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width: w, height: h } = canvas;
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;
  const [tH, tS, tL] = rgbToHsl(...hexToRgb(targetHex));

  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (!isRegion(d, i)) continue;
    sum += rgbToHsl(d[i], d[i + 1], d[i + 2])[2]; n++;
  }
  if (!n) { ctx.putImageData(id, 0, 0); return; }
  const refL = sum / n;

  for (let i = 0; i < d.length; i += 4) {
    if (!isRegion(d, i)) continue;
    const ll = rgbToHsl(d[i], d[i + 1], d[i + 2])[2];
    const nl = Math.min(1, Math.max(0, tL + (ll - refL)));
    const [r, g, b] = hslToRgb(tH, tS, nl);
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  ctx.putImageData(id, 0, 0);
}

// Predicate for single-colour stickers: opaque pixels whose saturation exceeds `minSat` (0..1). Recolours
// the coloured body while leaving near-grey pixels — whites, blacks, highlights (eyes, toes, outlines) —
// untouched, with no per-asset tuning.
export function regionBySaturation(minSat = 0.18, minAlpha = 8) {
  return (d, i) => d[i + 3] >= minAlpha && rgbToHsl(d[i], d[i + 1], d[i + 2])[1] >= minSat;
}

export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(x => Math.max(0, Math.min(255, x | 0)).toString(16).padStart(2, '0')).join('');
}
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

// ── Multi-region recolour (extract the distinct colours, recolour each independently) ─────────────
// Cluster the saturated pixels by HUE and return one region per dominant colour: { hue, hex, share }.
// `hex` is the region's average colour (the swatch to show). Clustering is by hue, so same-hue/different-
// lightness areas group together (e.g. brown spikes fold into the orange body). Sorted by share desc.
export function extractRegions(canvas, { minSat = 0.18, minAlpha = 8, maxRegions = 5, minShare = 0.02 } = {}) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width: w, height: h } = canvas;
  const d = ctx.getImageData(0, 0, w, h).data;
  const BINS = 36, span = 360 / BINS;                     // 10° hue bins
  const hist = new Float64Array(BINS);
  let total = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < minAlpha) continue;
    const [hue, sat] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    if (sat < minSat) continue;
    hist[Math.min(BINS - 1, Math.floor(hue / span))]++; total++;
  }
  if (!total) return [];
  // Peaks on the RAW histogram — deliberately NOT smoothed. Smoothing spreads a dominant colour's skirt into
  // the neighbouring bins and buries an adjacent minority colour: a yellow belly next to a huge orange body
  // reads as the DOWNSLOPE of orange, never its own local maximum. A peak must hold ≥2% of the COLOURED
  // pixels (an absolute floor, so a minority colour survives a dominant one). One colour spread across two
  // adjacent bins is consolidated by the 16° merge below.
  const thresh = total * 0.02;
  const peaks = [];
  for (let b = 0; b < BINS; b++) {
    if (hist[b] < thresh) continue;
    if (hist[b] >= hist[(b + BINS - 1) % BINS] && hist[b] >= hist[(b + 1) % BINS]) peaks.push({ hue: (b + 0.5) * span, weight: hist[b] });
  }
  peaks.sort((a, b) => b.weight - a.weight);
  const hues = [];                                        // keep the strongest peaks ≥16° apart (distinct hues)
  for (const p of peaks) { if (hues.every(h => hueDist(h, p.hue) >= 16)) hues.push(p.hue); if (hues.length >= maxRegions) break; }
  if (!hues.length) return [];

  const sr = new Float64Array(hues.length), sg = new Float64Array(hues.length), sb = new Float64Array(hues.length), cnt = new Uint32Array(hues.length);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < minAlpha) continue;
    const [hue, sat] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    if (sat < minSat) continue;
    const k = nearestHue(hue, hues);
    sr[k] += d[i]; sg[k] += d[i + 1]; sb[k] += d[i + 2]; cnt[k]++;
  }
  return hues
    .map((hue, k) => ({ hue, hex: rgbToHex(sr[k] / Math.max(cnt[k], 1), sg[k] / Math.max(cnt[k], 1), sb[k] / Math.max(cnt[k], 1)), share: cnt[k] / total }))
    .filter(r => r.share >= minShare)
    .sort((a, b) => b.share - a.share);
}

const nearestHue = (hue, hues) => { let k = 0, bd = Infinity; for (let j = 0; j < hues.length; j++) { const dd = hueDist(hue, hues[j]); if (dd < bd) { bd = dd; k = j; } } return k; };

// Recolour each hue cluster to its target. Pixel→region labels are computed ONCE from the current pixels,
// so recolouring one region can't re-capture another's already-changed pixels. Luminance-preserving per
// region (same as recolorRegion). `peakHues[k]` ↔ `targetsHex[k]` (from extractRegions, in order).
export function recolorRegions(canvas, peakHues, targetsHex, { minSat = 0.18, minAlpha = 8 } = {}) {
  if (!peakHues.length) return;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width: w, height: h } = canvas;
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data, K = peakHues.length, n = d.length / 4;
  const label = new Int16Array(n).fill(-1), sumL = new Float64Array(K), cnt = new Uint32Array(K);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (d[i + 3] < minAlpha) continue;
    const [hue, sat, li] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    if (sat < minSat) continue;
    const k = nearestHue(hue, peakHues);
    label[p] = k; sumL[k] += li; cnt[k]++;
  }
  const refL = Array.from({ length: K }, (_, k) => (cnt[k] ? sumL[k] / cnt[k] : 0.5));
  const t = targetsHex.map(hex => rgbToHsl(...hexToRgb(hex)));
  for (let p = 0; p < n; p++) {
    const k = label[p]; if (k < 0) continue;
    const i = p * 4;
    const ll = rgbToHsl(d[i], d[i + 1], d[i + 2])[2];
    const nl = Math.min(1, Math.max(0, t[k][2] + (ll - refL[k])));
    const [r, g, b] = hslToRgb(t[k][0], t[k][1], nl);
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  ctx.putImageData(id, 0, 0);
}
