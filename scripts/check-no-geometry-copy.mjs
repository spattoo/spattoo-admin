#!/usr/bin/env node
// ── A studio IMPORTS core's geometry; it never carries a copy ───────────────────────────────────
//
// CLAUDE.md states it in its own words: "THE STUDIO IMPORTS THE GEOMETRY, IT DOES NOT CARRY A COPY
// OF IT … or the tuned version and the rendered version drift." INVARIANTS #2 is the same rule from
// the other side: ONE renderer.
//
// ⚠️ IT DRIFTED, AND IT COST A DAY. `PipingCalibrator.jsx` had reimplemented FIVE functions this
// package already owns — buildShellGeo, buildSwagRing, buildFestoons, wallPerimeter, buildWrapBand.
// Two had quietly diverged:
//   · its `buildShellGeo` took no RADIUS, so it never applied `capShellScale` — the cap the cake
//     uses to stop a shell outgrowing its tier. Past ~1.15x the tool showed a size the cake would
//     never render.
//   · its `buildWrapBand` defaulted `heightFrac` to 0.4 against core's 0.33.
// So a rosette tuned to look perfect in the calibrator came out different on the cake. Sandeep:
// *"i loaded this in piping calibrator. and it landed perfectly fine."* The one tool whose entire
// job is to produce trustworthy numbers was the one thing not rendering what a customer sees.
//
// ── WHAT IT CHECKS ──────────────────────────────────────────────────────────────────────────────
// No file under src/admin/ DEFINES a function whose name core exports. Importing it is the point;
// redefining it is the fault, whether or not the bodies currently agree — they agreed once here too.
//
// It reads core's export list rather than a list of its own, so a function newly exported from core
// is covered the day it is exported and nobody has to remember this file exists.
//
// ⚠️ WHAT IT CANNOT SEE: a copy under a DIFFERENT NAME. `buildShellGeo2`, or the same maths inlined
// into a component, both pass. This catches the shape the fault actually took — five functions
// carrying core's own names — and says so rather than claiming more.
//
// Run via `npm run check:no-geometry-copy` (in `npm run verify`).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const CORE = join(ROOT, '../spattoo-core/src');
const ADMIN = join(ROOT, 'src/admin');

if (!existsSync(CORE)) {
  console.log('✓ check:no-geometry-copy — spattoo-core not checked out beside this repo; skipped');
  process.exit(0);
}

const walk = (dir, out = []) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.jsx?$/.test(f) && !/\.test\./.test(f)) out.push(p);
  }
  return out;
};

/* Every name core exports to its consumers. Read from the package entry point and the modules it
   re-exports, so this list is core's own answer rather than a second opinion. */
const coreExports = new Set();
const idx = readFileSync(join(CORE, 'index.js'), 'utf8');
for (const m of idx.matchAll(/export\s*\{([^}]*)\}/g)) {
  for (const part of m[1].split(',')) {
    const name = part.trim().split(/\s+as\s+/)[0].trim();
    if (/^[a-z][A-Za-z0-9]*$/.test(name)) coreExports.add(name);
  }
}

/* Names too generic to mean "core's function" — a studio may legitimately have its own `place` or
   `seat`. Listed rather than guessed at, so adding one is a deliberate act. */
const GENERIC = new Set(['place', 'seat', 'clamp', 'lerp', 'rand', 'noise', 'id']);

const problems = [];
for (const file of walk(ADMIN)) {
  const src = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
  src.split('\n').forEach((line, i) => {
    const m = line.match(/^\s*(?:export\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
           || line.match(/^\s*(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
    if (!m) return;
    const name = m[1];
    if (!coreExports.has(name) || GENERIC.has(name)) return;
    problems.push({ file: relative(ROOT, file), line: i + 1, name });
  });
}

if (problems.length) {
  console.error('✗ check:no-geometry-copy — a studio redefines something core already exports:\n');
  for (const p of problems) {
    console.error(`   • ${p.file}:${p.line}  defines ${p.name}()`);
    console.error(`     core exports ${p.name} from @spattoo/designer. Import it.`);
    console.error('     Two copies agree until one is edited — and then the tool and the cake');
    console.error('     disagree, which is the one thing a calibrator must never do.\n');
  }
  console.error('   CLAUDE.md: "THE STUDIO IMPORTS THE GEOMETRY, IT DOES NOT CARRY A COPY OF IT."');
  process.exit(1);
}

console.log(`✓ check:no-geometry-copy — no studio redefines any of core's ${coreExports.size} exports`);
