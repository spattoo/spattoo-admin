import * as THREE from 'three';

// ── Isomalt "glass" material ─────────────────────────────────────────────────────────────────────
// Two looks, tuned side-by-side in the studio:
//   • PHYSICAL  — real refraction, via drei's <MeshTransmissionMaterial backside>. The reference look,
//                 heavy — DESKTOP/admin only. It lives in the studio JSX, not here, because it is a
//                 component (it needs a per-frame FBO pass), not a plain material instance.
//   • STYLIZED  — the MOBILE-targeted look we'll actually ship (below): env reflections + clearcoat
//                 sheen + a fresnel rim glow, no transmission pass. Tune it to read like the physical.
//
// Why NOT MeshPhysicalMaterial+transmission for the physical look: three renders transmissive meshes by
// sampling a render target that EXCLUDES transmissive meshes, so the crown cannot refract its own far
// side — the very thing that makes the reference read as glass. drei's material does a backside pass.

// Stylized amber glass — cheap enough for mobile. Transparency + env reflections + clearcoat, plus a
// fresnel rim brightening injected into the emissive term (edges glow like lit glass). No transmission.
export function makeStylizedGlass({ color = '#e8850c', roughness = 0.12, opacity = 0.72, rim = 0.9, rimPower = 2.5 } = {}) {
  const m = new THREE.MeshPhysicalMaterial({
    color, roughness, metalness: 0,
    clearcoat: 1, clearcoatRoughness: 0.08,
    // envMapIntensity scales the DIFFUSE irradiance too, so a bright studio env washes the amber toward
    // pale yellow. Keep it below 1 and let clearcoat carry the specular — the saturation must survive.
    envMapIntensity: 0.85,
    transparent: true, opacity, transmission: 0,
    side: THREE.DoubleSide, depthWrite: false,
  });
  m.userData.rim = rim; m.userData.rimPower = rimPower;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uRim = { value: m.userData.rim };
    shader.uniforms.uRimPow = { value: m.userData.rimPower };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uRim;\nuniform float uRimPow;')
      // vViewPosition = frag→camera (view space); `normal` is the shaded view-space normal. The facing
      // ratio → a fresnel edge term added to emissive so rims glow (the "lit glass edge" cue).
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float fres = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), uRimPow);
        totalEmissiveRadiance += diffuseColor.rgb * fres * uRim;`,
      );
    m.userData.shader = shader;
  };
  return m;
}

// Push live slider values into a stylized material's fresnel uniforms without rebuilding it.
export function updateStylizedRim(m, rim, rimPower) {
  m.userData.rim = rim; m.userData.rimPower = rimPower;
  const sh = m.userData.shader;
  if (sh) { sh.uniforms.uRim.value = rim; sh.uniforms.uRimPow.value = rimPower; }
}
