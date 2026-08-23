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

export const MAX_BANDS = 8;

/* Bands only render once there are two of them; one colour is just a solid wall, which the material
 * already does perfectly well on its own. */
export function areBandsActive(bands) {
  return !!bands && Array.isArray(bands.colors) && bands.colors.filter(Boolean).length >= 2;
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
export function bandBoundaries(count, weights) {
  const w = [];
  for (let i = 0; i < count; i++) {
    const v = Number(weights?.[i]);
    w.push(Number.isFinite(v) && v > 0 ? v : 1);
  }
  const total = w.reduce((a, b) => a + b, 0);
  const out = [];
  let acc = 0;
  for (let i = 0; i < count - 1; i++) { acc += w[i]; out.push(acc / total); }
  return out;
}

/* The blend width, in the same 0..1 height units as the boundaries.
 *
 * Scaled by the THINNEST band rather than by a constant: with eight bands each is an eighth of the
 * wall, and a blend width that looked gentle across three bands would wash all eight into mud. Tying
 * it to the narrowest band means `softness` means the same thing — "how much of a band does the join
 * eat" — whatever the count.
 */
export function blendWidth(softness, count, weights) {
  const bounds = bandBoundaries(count, weights);
  let thinnest = 1;
  let prev = 0;
  for (const b of [...bounds, 1]) { thinnest = Math.min(thinnest, b - prev); prev = b; }
  return Math.max(0, Math.min(1, softness)) * thinnest;
}

const VERT_COMMON = '#include <common>\nvarying vec3 vBandLocal;';
const VERT_BEGIN  = '#include <begin_vertex>\nvBandLocal = position;';

const FRAG_COMMON = [
  '#include <common>',
  'varying vec3 vBandLocal;',
  `uniform vec3  uBColors[${MAX_BANDS}];`,
  `uniform float uBEdges[${MAX_BANDS}];`,   // count - 1 used
  'uniform int   uBCount;',
  'uniform float uBBlend;',
  'uniform float uBWobble;',
  'uniform vec3  uBMin;',
  'uniform vec3  uBSize;',
  'uniform vec3  uBCenter;',
].join('\n');

/* Progressive mix, band by band.
 *
 * Each boundary blends the accumulated colour into the next one with a smoothstep. Walking them in
 * order means a pixel below every boundary keeps colour 0, a pixel above them all ends on the last,
 * and in between only the nearby boundaries contribute — which is exactly the "poured one on top of
 * the other" look, and needs no branching or sorting.
 *
 * ⚠️ `uBBlend` can be 0 (hard edges). smoothstep with equal endpoints is undefined, hence the
 * epsilon — without it the crisp rainbow, the very look someone reaches for first, renders as
 * garbage on some drivers while looking fine on others.
 */
const FRAG_COLOR = `#include <color_fragment>
{
  float bt = (vBandLocal.y - uBMin.y) / max(uBSize.y, 1e-4);

  // Scraper wobble: a real cake's joins are not spirit-levelled. Two harmonics of the angle around
  // the cake, so the waver reads as a hand rather than a sine wave.
  if (uBWobble > 0.0) {
    float ang = atan(vBandLocal.z - uBCenter.z, vBandLocal.x - uBCenter.x);
    bt += uBWobble * (sin(ang * 3.0) * 0.6 + sin(ang * 5.0 + 1.7) * 0.4) * 0.05;
  }
  bt = clamp(bt, 0.0, 1.0);

  vec3 bcol = uBColors[0];
  float half_ = max(uBBlend, 1e-5) * 0.5;
  for (int i = 0; i < ${MAX_BANDS} - 1; i++) {
    if (i >= uBCount - 1) break;
    float e = uBEdges[i];
    bcol = mix(bcol, uBColors[i + 1], smoothstep(e - half_, e + half_, bt));
  }
  diffuseColor.rgb = bcol;
}`;

/* Apply (or remove) bands on an existing MeshStandard/MeshPhysical material.
 *
 * `bbox` is the geometry's local-space bounds — { min, size, center } — because the shader reads the
 * `position` attribute and needs to know what the bottom and top of THIS wall are. The caller owns
 * it; the material has no idea what geometry it is on.
 */
export function applyBands(material, bands, bbox) {
  if (!material) return;
  const active = areBandsActive(bands) && !!bbox;

  if (!active) {
    // Put the material back exactly as it was. A stale onBeforeCompile keeps injecting long after
    // the bands are gone, and the wall stays striped with nothing in the config to explain it.
    if (material.userData.__bandsPatched) {
      material.onBeforeCompile = material.userData.__bandsPrevOBC ?? (() => {});
      delete material.userData.__bandsPrevOBC;
      material.userData.__bandsPatched = false;
      material.userData.__bandUniforms = null;
      material.needsUpdate = true;
    }
    return;
  }

  const colors = bands.colors.filter(Boolean).slice(0, MAX_BANDS);
  const count = colors.length;
  const edges = bandBoundaries(count, bands.weights);
  const blend = blendWidth(bands.softness ?? 0.35, count, bands.weights);

  const u = material.userData.__bandUniforms;
  // Already patched: just push the new values. Recompiling on every colour tweak is what makes a
  // colour picker feel like it is chewing through treacle.
  if (u && material.userData.__bandsPatched) {
    for (let i = 0; i < MAX_BANDS; i++) u.uBColors.value[i].set(colors[Math.min(i, count - 1)]);
    for (let i = 0; i < MAX_BANDS; i++) u.uBEdges.value[i] = edges[i] ?? 1;
    u.uBCount.value  = count;
    u.uBBlend.value  = blend;
    u.uBWobble.value = bands.wobble ?? 0;
    u.uBMin.value.copy(bbox.min);
    u.uBSize.value.copy(bbox.size);
    u.uBCenter.value.copy(bbox.center);
    return;
  }

  const uniforms = {
    uBColors: { value: Array.from({ length: MAX_BANDS }, (_, i) => new THREE.Color(colors[Math.min(i, count - 1)])) },
    uBEdges:  { value: Array.from({ length: MAX_BANDS }, (_, i) => edges[i] ?? 1) },
    uBCount:  { value: count },
    uBBlend:  { value: blend },
    uBWobble: { value: bands.wobble ?? 0 },
    uBMin:    { value: bbox.min.clone() },
    uBSize:   { value: bbox.size.clone() },
    uBCenter: { value: bbox.center.clone() },
  };

  const prev = material.onBeforeCompile;
  material.userData.__bandsPrevOBC = prev;
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
  material.userData.__bandUniforms = uniforms;
  material.userData.__bandsPatched = true;
  material.needsUpdate = true;
}
