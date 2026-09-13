#!/usr/bin/env node
// ── A studio previewing cake output must be lit like the cake ────────────────────────────────────
//
// An admin studio authors something a customer will see ON A CAKE. If the studio lights its own
// scene, every colour, gloss and finish decision made in it is made under a light no cake has ever
// had — and the studio is where those decisions are made.
//
// ⚠️ A GATE AND NOT A CONVENTION, for the same reason `check-harness-scene.mjs` is one in core: THE
// FAILURE IS SILENT. Nothing throws and nothing looks broken. The preview simply renders a slightly
// different object from the cake, which is invisible until somebody measures it. Core's version of
// this note records what that cost — three parameter sweeps, a set of documented conclusions and a
// shipped scene-wide change, all describing a scene no customer had ever seen.
//
// The rig is `<SceneLights />` and `<SceneEnv />` from @spattoo/designer. They ARE what the designer
// mounts; a hand-rolled ambient + directional is not the same light however close the numbers look.
// The card cutout studio ran ambient 0.72 with no environment map against production's 0.45 and an
// HDRI — sixty percent more fill and no image-based lighting at all.
//
// ── NOT EVERY CANVAS IS A CAKE ──────────────────────────────────────────────────────────────────
// A GLB inspector or a geometry calibrator is looking at a MODEL, not at a decoration in place, and
// neutral even light is the right choice there. Such a screen opts out by saying so:
//
//     // scene-rig: not cake output — <the reason>
//
// The marker is a sentence, not a flag, because the next person needs the reason and not permission.
//
// ── THE BASELINE ────────────────────────────────────────────────────────────────────────────────
// ⚠️ 22 studios predate this gate and are NOT fixed by it. Listed rather than waived silently: the
// list is the debt, it is visible, and it only shrinks. A file in it that has since been fixed is
// reported so the entry can be deleted — a baseline nobody prunes becomes a permanent exemption.
//
// Fixing one is usually three lines (import the two, delete the hand-rolled lights) but it CHANGES
// WHAT THE STUDIO LOOKS LIKE, so each wants doing deliberately and with a look at the result, not in
// a sweep. That is why they are not all done here.
//
//   node scripts/check-studio-scene.mjs
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const DIR = 'src/admin';
const MOUNTS_CANVAS = /<\s*Canvas\b/;
const HAS_LIGHTS = /<\s*SceneLights\b/;
const HAS_ENV = /<\s*SceneEnv\b/;
const OPT_OUT = /scene-rig:\s*not cake output/;

/* Predates the gate. Each still lights itself; none is blessed. Dated so the age of the debt is
 * legible: 2026-09-09. */
const BASELINE = new Set([
  'AcrylicTopperStudio.jsx', 'AddElement.jsx', 'ButterflyStudio.jsx', 'ChocolateDripStudio.jsx',
  'CreamPenStudio.jsx', 'FlowerNailStudio.jsx', 'FreehandPenStudio.jsx', 'GenerateModel.jsx',
  'GenerateShape.jsx', 'GlazeStudio.jsx', 'GlbStudio.jsx', 'IsomaltStudio.jsx',
  'LusterDustStudio.jsx', 'ManageElements.jsx', 'ManageTemplates.jsx', 'PaletteKnifeStudio.jsx',
  'PerchCalibrator.jsx', 'PipingCalibrator.jsx', 'RecomposeEditor.jsx', 'ReliefStickerStudio.jsx',
  'SecondCreamLayerStudio.jsx', 'TextureCalibrator.jsx',
]);

const files = readdirSync(DIR).filter(f => f.endsWith('.jsx'));
const offenders = [];
const fixedButListed = [];

for (const f of files) {
  const src = readFileSync(join(DIR, f), 'utf8');
  if (!MOUNTS_CANVAS.test(src)) continue;
  const lit = HAS_LIGHTS.test(src) && HAS_ENV.test(src);
  const excused = OPT_OUT.test(src);
  if (lit || excused) {
    if (BASELINE.has(f)) fixedButListed.push(f);
  } else if (!BASELINE.has(f)) {
    offenders.push(f);
  }
}

if (fixedButListed.length) {
  console.log(`\n  ${fixedButListed.length} file(s) now light correctly and can leave the baseline in`);
  console.log('  scripts/check-studio-scene.mjs:');
  for (const f of fixedButListed) console.log(`    • ${f}`);
}

if (offenders.length) {
  console.error('\n✗ check:studio-scene — a studio previewing cake output lights its own scene:\n');
  for (const f of offenders) console.error(`   • ${DIR}/${f}`);
  console.error(`
   Mount the designer's rig instead, so what you judge here is what a cake shows:

     import { SceneLights, SceneEnv } from '@spattoo/designer';
     ...
     <SceneLights />
     <SceneEnv />

   …and delete the hand-rolled <ambientLight>/<directionalLight>/<Environment>.

   If this screen is NOT previewing something that goes on a cake — a GLB inspector, a
   geometry calibrator — say so in the file and this will pass:

     // scene-rig: not cake output — <the reason>
`);
  process.exit(1);
}

const checked = files.filter(f => MOUNTS_CANVAS.test(readFileSync(join(DIR, f), 'utf8'))).length;
console.log(`✓ check:studio-scene — ${checked - BASELINE.size} of ${checked} canvas screens use the designer's rig `
          + `(${BASELINE.size} predate the gate)`);
