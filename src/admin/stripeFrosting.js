import * as THREE from 'three';

/* ── Horizontal colour bands on a frosted wall ───────────────────────────────────────────────────
 *
 * The look in the reference photos: a cake iced in several colours stacked up the side, scraped
 * smooth so the joins either stay crisp (a rainbow cake) or melt into each other (a pastel ombre).
 *
 * ── ONE CONTROL SPANS ALL OF IT ─────────────────────────────────────────────────────────────────
 * Those two looks are not two features. They are the same bands with a different blend width, which
 * is why `softness` is a single 0..1 and not a mode:
 *
 *   softness 0    hard edges — the six-stripe rainbow cake
 *   softness ~0.5 scraped, slightly melted joins — the unicorn cake
 *   softness 1    each join blends across a whole band — the pastel cake, indistinguishable from a
 *                 multi-stop ombre
 *
 * Building "bands" and "ombre" as separate things would have meant two shaders, two sets of controls
 * and a baker having to know which one their cake is. It is one thing with a slider.
 *
 * ── WHY A SHADER AND NOT A BAKED TEXTURE ────────────────────────────────────────────────────────
 * The colour depends only on HEIGHT, so there is nothing a texture buys: no UVs to author, no wrap
 * seam to hide, no resolution to pick, and no re-bake when a colour changes — it updates live from a
 * uniform. GlazeStudio bakes a CanvasTexture because marble is a 2D flow field with no closed form;
 * bands have one.
 *
 * ⚠️ This deliberately copies gradientMaterial.js's seam — inject into `<color_fragment>` via
 * onBeforeCompile, read object-local position from a varying, take the bbox from the caller. Same
 * shape, so all of the material's lighting survives untouched, and the port into core is a move
 * rather than a rewrite. The two may well merge there: a band set with softness 1 and no weights IS
 * the existing `vertical` gradient, and that is worth settling before this ships.
 *
 * PHASE 0: lives here for hot-reload while the look is settled.
 * PHASE 1: moves to spattoo-core/src/designer/shared/color/bandMaterial.js, and TierBody applies it
 *          next to applyGradient/applyGlaze.
 */

/* ⚠️ 24, not 8. A two-colour striped cake — white/green, the football cake — runs to sixteen or
 * more thin stripes, and the first cut of this capped at eight because it assumed one colour meant
 * one band. The cap is a shader array size, so it costs uniforms whether used or not; 24 is chosen
 * as "more than any cake anyone has shown us" rather than as a limit anybody should hit. */
export const MAX_STRIPES = 24;

/* ── Palette × count, not one-colour-one-band ────────────────────────────────────────────────────
 *
 * The palette CYCLES to fill `count` bands. Two colours and twelve bands is white/green stripes;
 * six colours and six bands is the rainbow. `count === palette.length` is one band per colour, which
 * is what this used to do and every existing preset still means.
 *
 * ⚠️ A count, not a "repeat" multiplier. A multiplier can only produce whole turns of the palette —
 * two colours would give 2, 4, 6, 8 — and it cannot express the case bakers actually want on a
 * striped cake, which is the SAME colour top and bottom. That needs an odd count from an even
 * palette (green, white, green), and no multiplier reaches it.
 */
export function expandPalette(palette, count) {
  const p = (palette ?? []).filter(Boolean);
  if (!p.length) return [];
  const n = Math.max(2, Math.min(MAX_STRIPES, Math.round(count || p.length)));
  return Array.from({ length: n }, (_, i) => p[i % p.length]);
}

/* Bands only render once there are two of them; one colour is just a solid wall, which the material
 * already does perfectly well on its own.
 *
 * Accepts either shape: `{ palette, count }` or a literal `{ colors }`. The studio speaks the first,
 * and the second is what the shader ultimately needs — keeping both readable here means callers do
 * not each have to remember to expand. */
export function stripeColors(stripes) {
  if (!stripes) return [];
  if (Array.isArray(stripes.palette) && stripes.palette.filter(Boolean).length) {
    return expandPalette(stripes.palette, stripes.count ?? stripes.palette.length);
  }
  return (stripes.colors ?? []).filter(Boolean).slice(0, MAX_STRIPES);
}

export function areStripesActive(stripes) {
  return stripeColors(stripes).length >= 2;
}

/* Where each join sits, as a fraction of the wall's height.
 *
 * Weights let a band be thicker than its neighbours — real cakes are rarely even, and the pastel
 * reference has a wide lilac base under narrower stripes. Equal weights is the default and gives
 * evenly divided bands.
 *
 * Returned as cumulative boundaries (count - 1 of them), which is what the shader wants: boundary i
 * is where colour i hands over to colour i+1.
 */
export function stripeBoundaries(count, weights) {
  const src = (weights ?? []).filter(v => Number.isFinite(Number(v)) && Number(v) > 0);
  const w = [];
  for (let i = 0; i < count; i++) {
    // Weights CYCLE with the palette, so a thick/thin alternation is one pair of numbers rather than
    // twelve. Indexing straight into `weights` would leave every band past the palette at 1 and the
    // alternation would quietly stop a third of the way up.
    w.push(src.length ? Number(src[i % src.length]) : 1);
  }
  const total = w.reduce((a, b) => a + b, 0);
  const out = [];
  let acc = 0;
  for (let i = 0; i < count - 1; i++) { acc += w[i]; out.push(acc / total); }
  return out;
}

/* How far a join is allowed to wander, in the same 0..1 height units.
 *
 * ⚠️ Proportional to the thinnest band, for the same reason the blend is. The wobble used to be a
 * flat 0.05 of the wall: harmless across six bands, but a sixteen-stripe cake has bands 0.0625 tall,
 * so at any real wobble the joins CROSS each other and the stripes visibly braid. Tied to band
 * height it means "how far does the join wander across its own band", which holds at any count.
 *
 * The 0.3 keeps existing presets looking as they did — at six even bands it reproduces the old flat
 * amplitude almost exactly. */
export function wobbleAmplitude(wobble, count, weights) {
  return Math.max(0, Math.min(1, wobble ?? 0)) * thinnestStripe(count, weights) * 0.3;
}

/* The blend width, in the same 0..1 height units as the boundaries.
 *
 * Scaled by the THINNEST band rather than by a constant: with eight bands each is an eighth of the
 * wall, and a blend width that looked gentle across three bands would wash all eight into mud. Tying
 * it to the narrowest band means `softness` means the same thing — "how much of a band does the join
 * eat" — whatever the count.
 */
export function thinnestStripe(count, weights) {
  const bounds = stripeBoundaries(count, weights);
  let thinnest = 1, prev = 0;
  for (const b of [...bounds, 1]) { thinnest = Math.min(thinnest, b - prev); prev = b; }
  return thinnest;
}

export function blendWidth(softness, count, weights) {
  return Math.max(0, Math.min(1, softness)) * thinnestStripe(count, weights);
}

const VERT_COMMON = '#include <common>\nvarying vec3 vStripeLocal;';
const VERT_BEGIN  = '#include <begin_vertex>\nvStripeLocal = position;';

const FRAG_COMMON = [
  '#include <common>',
  'varying vec3 vStripeLocal;',
  `uniform vec3  uSColors[${MAX_STRIPES}];`,
  `uniform float uSEdges[${MAX_STRIPES}];`,   // count - 1 used
  'uniform int   uSCount;',
  'uniform float uSBlend;',
  'uniform float uSWobble;',
  'uniform vec3  uSMin;',
  'uniform vec3  uSSize;',
  'uniform vec3  uSCenter;',
].join('\n');

/* Progressive mix, band by band.
 *
 * Each boundary blends the accumulated colour into the next one with a smoothstep. Walking them in
 * order means a pixel below every boundary keeps colour 0, a pixel above them all ends on the last,
 * and in between only the nearby boundaries contribute — which is exactly the "poured one on top of
 * the other" look, and needs no branching or sorting.
 *
 * ⚠️ `uSBlend` can be 0 (hard edges). smoothstep with equal endpoints is undefined, hence the
 * epsilon — without it the crisp rainbow, the very look someone reaches for first, renders as
 * garbage on some drivers while looking fine on others.
 */
const FRAG_COLOR = `#include <color_fragment>
{
  float bt = (vStripeLocal.y - uSMin.y) / max(uSSize.y, 1e-4);

  // Scraper wobble: a real cake's joins are not spirit-levelled. Two harmonics of the angle around
  // the cake, so the waver reads as a hand rather than a sine wave.
  if (uSWobble > 0.0) {
    float ang = atan(vStripeLocal.z - uSCenter.z, vStripeLocal.x - uSCenter.x);
    // uSWobble is already an AMPLITUDE in t units, scaled to band height on the JS side — see
    // wobbleAmplitude(). A flat fraction of the wall here made sixteen thin stripes braid.
    bt += uSWobble * (sin(ang * 3.0) * 0.6 + sin(ang * 5.0 + 1.7) * 0.4);
  }
  bt = clamp(bt, 0.0, 1.0);

  vec3 bcol = uSColors[0];
  float half_ = max(uSBlend, 1e-5) * 0.5;
  for (int i = 0; i < ${MAX_STRIPES} - 1; i++) {
    if (i >= uSCount - 1) break;
    float e = uSEdges[i];
    bcol = mix(bcol, uSColors[i + 1], smoothstep(e - half_, e + half_, bt));
  }
  diffuseColor.rgb = bcol;
}`;

/* Apply (or remove) bands on an existing MeshStandard/MeshPhysical material.
 *
 * `bbox` is the geometry's local-space bounds — { min, size, center } — because the shader reads the
 * `position` attribute and needs to know what the bottom and top of THIS wall are. The caller owns
 * it; the material has no idea what geometry it is on.
 */
export function applyStripes(material, stripes, bbox) {
  if (!material) return;
  const active = areStripesActive(stripes) && !!bbox;

  if (!active) {
    // Put the material back exactly as it was. A stale onBeforeCompile keeps injecting long after
    // the bands are gone, and the wall stays striped with nothing in the config to explain it.
    if (material.userData.__stripesPatched) {
      material.onBeforeCompile = material.userData.__stripesPrevOBC ?? (() => {});
      delete material.userData.__stripesPrevOBC;
      material.userData.__stripesPatched = false;
      material.userData.__stripeUniforms = null;
      material.needsUpdate = true;
    }
    return;
  }

  const colors = stripeColors(stripes);          // palette cycled into `count` bands
  const count = colors.length;
  const edges = stripeBoundaries(count, stripes.weights);
  const blend = blendWidth(stripes.softness ?? 0.35, count, stripes.weights);
  const wob   = wobbleAmplitude(stripes.wobble, count, stripes.weights);

  const u = material.userData.__stripeUniforms;
  // Already patched: just push the new values. Recompiling on every colour tweak is what makes a
  // colour picker feel like it is chewing through treacle.
  if (u && material.userData.__stripesPatched) {
    for (let i = 0; i < MAX_STRIPES; i++) u.uSColors.value[i].set(colors[Math.min(i, count - 1)]);
    for (let i = 0; i < MAX_STRIPES; i++) u.uSEdges.value[i] = edges[i] ?? 1;
    u.uSCount.value  = count;
    u.uSBlend.value  = blend;
    u.uSWobble.value = wob;
    u.uSMin.value.copy(bbox.min);
    u.uSSize.value.copy(bbox.size);
    u.uSCenter.value.copy(bbox.center);
    return;
  }

  const uniforms = {
    uSColors: { value: Array.from({ length: MAX_STRIPES }, (_, i) => new THREE.Color(colors[Math.min(i, count - 1)])) },
    uSEdges:  { value: Array.from({ length: MAX_STRIPES }, (_, i) => edges[i] ?? 1) },
    uSCount:  { value: count },
    uSBlend:  { value: blend },
    uSWobble: { value: wob },
    uSMin:    { value: bbox.min.clone() },
    uSSize:   { value: bbox.size.clone() },
    uSCenter: { value: bbox.center.clone() },
  };

  const prev = material.onBeforeCompile;
  material.userData.__stripesPrevOBC = prev;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', VERT_COMMON)
      .replace('#include <begin_vertex>', VERT_BEGIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', FRAG_COMMON)
      .replace('#include <color_fragment>', FRAG_COLOR);
  };
  material.userData.__stripeUniforms = uniforms;
  material.userData.__stripesPatched = true;
  material.needsUpdate = true;
}
