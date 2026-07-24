// ── Photo region edit ─────────────────────────────────────────────────────────
// Select a region of a PHOTOGRAPH, erase it, and put something else in its place. This is the half
// that textSlots.js does not have: its clone-stamp (`applyPatches`) mirror-tiles ONE small clean
// sample over the old value, which is exactly right on a background-removed plaque — a uniform disc
// of fondant — and exactly wrong on a photo, where the region behind a topper spans a backdrop, the
// cake's own edge, and whatever else was there. So erasing here is a fill that RECONSTRUCTS the
// boundary rather than repeating one patch of it.
//
// Everything is framework-free and operates on a raw RGBA byte array + a Uint8Array mask, for the same
// reason textSlots.js is pure canvas-2D: this is the piece that ports to spattoo-core once the studio
// proves out, and it must not drag React or the admin's DOM along with it.
//
// A mask is Uint8Array(W*H), 0 = keep, 255 = selected. Partial values are a feathered edge and are
// honoured on composite, so a selection never leaves a hard seam.

// Perceptual-ish squared distance between two RGB triples: the luma weights, so a hue shift at equal
// brightness still separates (a red numeral from cream paper) without a full Lab conversion.
function dist2(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return 0.30 * dr * dr + 0.59 * dg * dg + 0.11 * db * db;
}

// Contiguous flood select from a seed pixel — the "magic wand". Compares every candidate against the
// SEED colour (not against its own neighbour), so the region cannot creep down a gradient across the
// whole photo the way a neighbour-relative fill does.
//
// BOUNDED, because on a real cake photo an unbounded colour flood is not usable. A topper stands
// against a smooth backdrop that touches everything in frame, so any tolerance loose enough to hold a
// shaded numeral together is also loose enough to step off it into the backdrop and take the whole
// picture. It gets worse after an erase: the fill leaves the erased region continuous with the backdrop
// by construction, so the next click there floods all of it.
//
// Two bounds, both needed. `maxRadius` (in pixels, 0 = off) keeps the region local to where you clicked
// — a topper is a small thing and the backdrop is not. `maxShare` aborts outright once the region grows
// past that fraction of the frame, and reports `escaped` so the caller can say so rather than silently
// hand back a selection of everything.
//
// `tolerance` is 0..100 and maps to the same 0..255 scale the distance is measured on.
export function floodSelect(data, W, H, sx, sy, tolerance = 18, { maxRadius = 0, maxShare = 0.4 } = {}) {
  const N = W * H;
  const mask = new Uint8Array(N);
  sx = Math.max(0, Math.min(W - 1, Math.round(sx)));
  sy = Math.max(0, Math.min(H - 1, Math.round(sy)));

  const seed = (sy * W + sx) * 4;
  const sr = data[seed], sg = data[seed + 1], sb = data[seed + 2];
  const thr = (tolerance / 100) * 255;
  const thr2 = thr * thr;
  const r2max = maxRadius > 0 ? maxRadius * maxRadius : Infinity;
  const budget = Math.max(1, Math.floor(N * maxShare));

  // An explicit typed-array stack: a JS array of 2.5M pushes reallocates its way through the heap.
  const stack = new Int32Array(N);
  let sp = 0;
  stack[sp++] = sy * W + sx;
  const seen = new Uint8Array(N);
  seen[sy * W + sx] = 1;

  let covered = 0;
  let escaped = false;

  while (sp > 0) {
    const i = stack[--sp];
    const x = i % W, y = (i / W) | 0;

    const dx = x - sx, dy = y - sy;
    if (dx * dx + dy * dy > r2max) continue;

    const p = i * 4;
    if (dist2(data[p], data[p + 1], data[p + 2], sr, sg, sb) > thr2) continue;

    mask[i] = 255;
    if (++covered > budget) { escaped = true; break; }

    if (x > 0     && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
    if (x < W - 1 && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
    if (y > 0     && !seen[i - W]) { seen[i - W] = 1; stack[sp++] = i - W; }
    if (y < H - 1 && !seen[i + W]) { seen[i + W] = 1; stack[sp++] = i + W; }
  }
  return { mask, escaped, share: covered / N };
}

// A filled rectangle as a mask. The selection that cannot run away: you drag a box round the topper and
// that is the box. Crude on purpose — the erase RECONSTRUCTS what was behind the region, so a box a
// little larger than the thing costs nothing, and against a smooth backdrop it is often the better
// selection anyway. Coordinates are work pixels, in any corner order.
export function boxMask(W, H, x0, y0, x1, y1) {
  const mask = new Uint8Array(W * H);
  const ax = Math.max(0, Math.min(W - 1, Math.round(Math.min(x0, x1))));
  const bx = Math.max(0, Math.min(W - 1, Math.round(Math.max(x0, x1))));
  const ay = Math.max(0, Math.min(H - 1, Math.round(Math.min(y0, y1))));
  const by = Math.max(0, Math.min(H - 1, Math.round(Math.max(y0, y1))));
  for (let y = ay; y <= by; y++) mask.fill(255, y * W + ax, y * W + bx + 1);
  return mask;
}

// Dilate by `r` passes of a 3×3 max — approximates a disc closely enough and stays O(N·r).
// This is not cosmetic: a flood select stops at the anti-aliased rim of the thing it selected, and
// erasing without growing leaves a one-pixel ghost of the old topper's colour tracing its outline.
export function growMask(mask, W, H, r = 2) {
  let cur = mask;
  for (let pass = 0; pass < r; pass++) {
    const out = new Uint8Array(cur.length);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let m = cur[i];
        if (x > 0)     m = Math.max(m, cur[i - 1]);
        if (x < W - 1) m = Math.max(m, cur[i + 1]);
        if (y > 0)     m = Math.max(m, cur[i - W]);
        if (y < H - 1) m = Math.max(m, cur[i + W]);
        out[i] = m;
      }
    }
    cur = out;
  }
  return cur;
}

// Separable box blur — a soft mask edge, so the fill blends into the photo instead of butting against it.
export function featherMask(mask, W, H, r = 2) {
  if (r <= 0) return mask;
  const tmp = new Float32Array(mask.length);
  const out = new Uint8Array(mask.length);
  const win = r * 2 + 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += mask[y * W + Math.max(0, Math.min(W - 1, x + k))];
      tmp[y * W + x] = s / win;
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.max(0, Math.min(H - 1, y + k)) * W + x];
      out[y * W + x] = s / win;
    }
  }
  return out;
}

// Tight bounds of the selection, returned BOTH in pixels and in the normalized centre+size form that
// renderTextSlot() takes — so "what did I just select" becomes "where does the replacement go" with no
// conversion at the call site. Returns null for an empty mask.
export function maskBounds(mask, W, H) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x] < 128) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  return {
    px: { x: x0, y: y0, w, h },
    rect: { x: (x0 + w / 2) / W, y: (y0 + h / 2) / H, w: w / W, h: h / H },
  };
}

// Modal colour over whatever pixels `accept` admits: bucket a coarse quantization, take the fullest
// bucket, average within it. The averaging is inside ONE bucket for the reason findInkColor() gives in
// textSlots.js — a mean over every pixel blends a glyph's highlight and its shadow into a muddy midtone
// that appears nowhere in the photo.
function modalFrom(data, N, accept) {
  const bins = new Map();
  for (let i = 0; i < N; i++) {
    if (!accept(i)) continue;
    const p = i * 4;
    const key = ((data[p] >> 4) << 8) | ((data[p + 1] >> 4) << 4) | (data[p + 2] >> 4);
    let b = bins.get(key);
    if (!b) bins.set(key, (b = { n: 0, r: 0, g: 0, b: 0 }));
    b.n++; b.r += data[p]; b.g += data[p + 1]; b.b += data[p + 2];
  }
  let best = null;
  for (const b of bins.values()) if (!best || b.n > best.n) best = b;
  return best ? { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n, n: best.n } : null;
}

const toHex = (c) => c
  ? `#${[c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
  : '#000000';

// The colour of the SUBJECT inside the selection — not the colour of the selection, which are very
// different things the moment the selection is a dragged box. A box round a numeral is mostly backdrop,
// so a plain modal over it returns the cream the numeral stands against, and the replacement comes out
// the colour of the wall behind it.
//
// So do what findInkColor() does in textSlots.js, adapted to a photo: establish what the BACKGROUND is,
// then take the dominant colour that is not it. The background reference is the ring of pixels just
// OUTSIDE the selection — whatever the subject sits against, sampled where the subject cannot be. Then
// "ink" is every selected pixel far enough from that reference, and its modal bucket wins.
//
// Falls back to a plain modal when the subject fills the selection (no meaningful ring contrast) or when
// too little survives the separation test to be trustworthy.
export function inkColor(data, mask, W, H, { ring = 8, separation = 45, minInk = 0.02 } = {}) {
  const N = W * H;
  const plain = () => toHex(modalFrom(data, N, (i) => mask[i] >= 128));

  const outer = growMask(mask, W, H, ring);
  const bg = modalFrom(data, N, (i) => outer[i] >= 128 && mask[i] < 128);
  if (!bg) return plain();

  const sep2 = separation * separation;
  const isInk = (i) => {
    if (mask[i] < 128) return false;
    const p = i * 4;
    return dist2(data[p], data[p + 1], data[p + 2], bg.r, bg.g, bg.b) > sep2;
  };

  let selected = 0, ink = 0;
  for (let i = 0; i < N; i++) {
    if (mask[i] < 128) continue;
    selected++;
    if (isInk(i)) ink++;
  }
  if (!selected || ink / selected < minInk) return plain();
  return toHex(modalFrom(data, N, isInk));
}

// ── The fill ──────────────────────────────────────────────────────────────────
// Erase the selection: reconstruct what was behind it.
//
// This is a PULL-PUSH pyramid solve, not iterative smoothing, and the difference is the whole quality
// of the result. The obvious implementation — seed the hole with each pixel's nearest surviving colour,
// then relax it with Jacobi iterations — is wrong at any iteration count you can afford: diffusion
// carries information about one pixel per pass, so a hole 200px across needs O(200²) ≈ 40,000 passes to
// actually converge. At the ~40 you can pay for, almost nothing has moved, and what you SEE is the raw
// nearest-neighbour stage: the dark navy of a topper sitting against the hole propagates inward as a
// hard-edged wedge and simply stays there. That was the blocky smear in the erased region.
//
// The pyramid fixes it by changing the cost, not the effort. PULL: build successively halved levels,
// each pixel the weighted average of its four children, weight = how much real photo it drew from — so
// a hole 200px wide is 3px wide seven levels up and is spanned by genuine pixels. PUSH: walk back down,
// and wherever a pixel is short of full weight, blend in the coarser level's estimate underneath what it
// already has. Every hole pixel ends up a smooth, multi-scale interpolation of everything around it,
// weighted by distance, in O(N) total.
//
// Known ceiling, unchanged: this reconstructs COLOUR, not TEXTURE. Against backdrop, sky or plain
// fondant it is convincing. Erase something off the striped tier and you get a smooth gradient where
// stripes should be — no amount of solving invents structure that was never in the boundary. That is
// the point where a generative inpaint earns its cost.

// Bilinear sample of a pyramid level, weighted by each tap's own confidence. Results go to these
// module scratch vars rather than a returned object: this runs once per hole pixel per level, and
// allocating a few million short-lived objects is a GC stall you can watch happen.
let _sr = 0, _sg = 0, _sb = 0, _sw = 0;
function sampleLevel(lv, u, v) {
  const x0 = Math.floor(u), y0 = Math.floor(v);
  const fx = u - x0, fy = v - y0;
  let r = 0, g = 0, b = 0, wsum = 0, conf = 0;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const x = Math.max(0, Math.min(lv.w - 1, x0 + dx));
      const y = Math.max(0, Math.min(lv.h - 1, y0 + dy));
      const bw = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      const i = y * lv.w + x;
      const k = bw * lv.wt[i];
      if (k <= 0) continue;
      const o = i * 3;
      r += lv.c[o] * k; g += lv.c[o + 1] * k; b += lv.c[o + 2] * k;
      wsum += k; conf += bw * lv.wt[i];
    }
  }
  if (wsum <= 0) { _sw = 0; return; }
  _sr = r / wsum; _sg = g / wsum; _sb = b / wsum; _sw = Math.min(1, conf);
}

// How much per-pixel grain the photo carries just outside the selection, as a mean absolute deviation
// from a local average. A solved fill is perfectly smooth, and perfect smoothness is itself a visible
// artefact next to real photographic grain — the patch reads as plastic even when its colour is right.
function ringGrain(data, mask, W, H, ring = 6) {
  const outer = growMask(mask, W, H, ring);
  let sum = 0, n = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (outer[i] < 128 || mask[i] >= 128) continue;
      const p = i * 4;
      let mean = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) mean += data[(i + dy * W + dx) * 4];
      sum += Math.abs(data[p] - mean / 9);
      n++;
    }
  }
  return n ? Math.min(10, (sum / n) * 1.25) : 0;
}

// `data` is mutated in place.
export function inpaintMasked(data, mask, W, H, { polish = 12, grain = 1 } = {}) {
  const N = W * H;
  const holes = [];
  for (let i = 0; i < N; i++) if (mask[i] >= 128) holes.push(i);
  if (!holes.length) return;

  const noise = grain > 0 ? ringGrain(data, mask, W, H) * grain : 0;

  // ── pull: halve until the hole is spanned by real pixels ──
  const levels = [];
  {
    const c = new Float32Array(N * 3), wt = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (mask[i] >= 128) continue;
      const p = i * 4, o = i * 3;
      c[o] = data[p]; c[o + 1] = data[p + 1]; c[o + 2] = data[p + 2];
      wt[i] = 1;
    }
    levels.push({ w: W, h: H, c, wt });
  }
  for (;;) {
    const f = levels[levels.length - 1];
    if (f.w <= 1 && f.h <= 1) break;
    const nw = Math.max(1, f.w >> 1), nh = Math.max(1, f.h >> 1);
    const c = new Float32Array(nw * nh * 3), wt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let sw = 0, r = 0, g = 0, b = 0;
        for (let dy = 0; dy < 2; dy++) {
          const sy = y * 2 + dy;
          if (sy >= f.h) continue;
          for (let dx = 0; dx < 2; dx++) {
            const sx = x * 2 + dx;
            if (sx >= f.w) continue;
            const j = sy * f.w + sx, wj = f.wt[j];
            if (wj <= 0) continue;
            const o = j * 3;
            r += f.c[o] * wj; g += f.c[o + 1] * wj; b += f.c[o + 2] * wj; sw += wj;
          }
        }
        const i = y * nw + x;
        if (sw <= 0) continue;
        const o = i * 3;
        c[o] = r / sw; c[o + 1] = g / sw; c[o + 2] = b / sw;
        wt[i] = Math.min(1, sw / 4);
      }
    }
    levels.push({ w: nw, h: nh, c, wt });
  }

  // ── push: blend each coarser estimate in underneath what a pixel already knows ──
  for (let L = levels.length - 2; L >= 0; L--) {
    const f = levels[L], coarse = levels[L + 1];
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x;
        const a = f.wt[i];
        if (a >= 1) continue;
        // A fine pixel's centre lands at (x+0.5)/2 in coarse space; less the coarse half-pixel.
        sampleLevel(coarse, x * 0.5 - 0.25, y * 0.5 - 0.25);
        if (_sw <= 0) continue;
        const o = i * 3;
        f.c[o]     = f.c[o]     * a + _sr * (1 - a);
        f.c[o + 1] = f.c[o + 1] * a + _sg * (1 - a);
        f.c[o + 2] = f.c[o + 2] * a + _sb * (1 - a);
        f.wt[i]    = a + (1 - a) * _sw;
      }
    }
  }

  // ── polish: a few Jacobi passes purely to soften the seam. Cheap now that the pyramid has already
  // solved the interior — this is cosmetic, not the thing doing the work. ──
  const fine = levels[0];
  const cur = fine.c;
  const next = Float32Array.from(cur);
  for (let iter = 0; iter < polish; iter++) {
    for (const i of holes) {
      const x = i % W, y = (i / W) | 0;
      let n = 0, r = 0, g = 0, b = 0;
      if (x > 0)     { const j = (i - 1) * 3; r += cur[j]; g += cur[j + 1]; b += cur[j + 2]; n++; }
      if (x < W - 1) { const j = (i + 1) * 3; r += cur[j]; g += cur[j + 1]; b += cur[j + 2]; n++; }
      if (y > 0)     { const j = (i - W) * 3; r += cur[j]; g += cur[j + 1]; b += cur[j + 2]; n++; }
      if (y < H - 1) { const j = (i + W) * 3; r += cur[j]; g += cur[j + 1]; b += cur[j + 2]; n++; }
      if (!n) continue;
      const o = i * 3;
      next[o] = r / n; next[o + 1] = g / n; next[o + 2] = b / n;
    }
    for (const i of holes) {
      const o = i * 3;
      cur[o] = next[o]; cur[o + 1] = next[o + 1]; cur[o + 2] = next[o + 2];
    }
  }

  // ── composite by the mask's own alpha, so a feathered edge blends; grain on top ──
  for (let i = 0; i < N; i++) {
    const a = mask[i] / 255;
    if (a <= 0) continue;
    const p = i * 4, o = i * 3;
    const nz = noise > 0 ? (Math.random() - 0.5) * 2 * noise * a : 0;
    data[p]     = data[p]     * (1 - a) + (cur[o]     + nz) * a;
    data[p + 1] = data[p + 1] * (1 - a) + (cur[o + 1] + nz) * a;
    data[p + 2] = data[p + 2] * (1 - a) + (cur[o + 2] + nz) * a;
  }
}

// Paint a disc into a mask — the brush, and the manual escape hatch for everything the wand gets wrong.
export function paintDisc(mask, W, H, cx, cy, radius, erase = false) {
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(W - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(H - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > r2) continue;
      mask[y * W + x] = erase ? 0 : 255;
    }
  }
}
