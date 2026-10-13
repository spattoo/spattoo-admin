#!/usr/bin/env node
/* ── A hook must be called unconditionally, and nothing else here can tell ───────────────────────
 *
 * This studio folder's Gypsophila Studio shipped with
 * `geometry={useMemo(() => buildGypSprig(p), [p])}` inside a JSX ternary. Picking the "One sprig"
 * arrangement therefore rendered one more hook than the render before it, and React threw the whole
 * screen away: "Rendered more hooks than during the previous render."
 *
 * ⚠️ EVERY GATE WAS GREEN ON IT. The build compiles it, `check:bindings` resolves it, and
 * `check:smoke` opens all 49 routes — including that one, at its DEFAULT arrangement, which does
 * not take the branch. A smoke test cannot press every button on every screen, so the branch nobody
 * clicked was the branch that was broken.
 *
 * ⚠️ THIS IS WHAT `eslint-plugin-react-hooks` IS FOR. Neither repo has eslint, and adding one is a
 * bigger decision than this bug. This is that one rule, as a gate, in the shape `scripts/` already
 * uses. If eslint ever lands, delete this file. A copy lives in spattoo-admin for the same reason
 * `check-bindings.mjs` does: the repos keep their own scripts and neither can import the other's.
 *
 * ── WHAT IT LOOKS FOR, AND WHAT IT DOES NOT ─────────────────────────────────────────────────────
 * A DENYLIST, not a whitelist of good positions — tried that first and it flagged nineteen correct
 * lines, because `const refs = [useRef(), useRef()]` and `const useIsMobile = () => useNarrow(768)`
 * are both fine and neither looks like a plain statement. What makes a hook call CONDITIONAL is
 * visible: it sits in a JSX attribute, after a `?` or `&&`, or inside a callback that is not a
 * custom hook's own one-line body.
 *
 * ⚠️ IT DOES NOT CATCH A HOOK INSIDE A MULTI-LINE `if` BLOCK. Doing that needs brace tracking
 * across a 17,000-line file, and a gate that is wrong occasionally is worse than one with a stated
 * limit. Every instance of this bug so far has been the one-line JSX form, which is caught.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIRS = ['src'].map(d => join(ROOT, d));

/* A hook call: `useFoo(`, not preceded by a dot — `vi.useFakeTimers()` and `THREE.useX` are method
   calls on something else and have nothing to do with React's hook counter. */
const HOOK = /(?<![.\w$])use[A-Z][\w$]*\s*\(/g;

/* What, in the text BEFORE the call on its own line, makes the call conditional. */
const CONDITIONAL = [
  { re: /=\{/,            why: 'inside a JSX attribute' },
  { re: /\?/,             why: 'inside a ternary branch' },
  { re: /&&|\|\|/,        why: 'behind a short-circuit' },
  { re: /\.(map|forEach|filter|find|some|every|reduce)\s*\(/, why: 'inside a list callback' },
  { re: /=>/,             why: 'inside a callback' },
];

/* ⚠️ A CUSTOM HOOK WRITTEN AS A ONE-LINE ARROW is the `=>` case that is FINE, and there are four of
   them in this repo: `export const useIsMobile = () => useNarrow(768)`. The body runs exactly once
   per call of the hook, which is what the rule asks. Recognised by the NAME it declares. */
const CUSTOM_HOOK_ARROW = /^\s*(export\s+)?(const|let|var)\s+use[A-Z][\w$]*\s*=\s*\(?[^)]*\)?\s*=>/;

/* ⚠️ NAMED LIKE A HOOK, NOT A HOOK. `usePreset(pre)` means "use this preset" — an ordinary
 * callback. React's own rules-of-hooks would flag it for the same reason, and the real fix is a
 * rename (`applyPreset`), which belongs to whoever owns that screen rather than to this gate. An
 * entry here is a judgement recorded with its reason, not a hole: each names one call site. */
const ALLOW = new Set([
  'src/admin/TopperComposer.jsx:867',   // usePreset — applies a preset, not a React hook
]);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(jsx?|tsx?)$/.test(name) && !/\.(test|spec)\.[jt]sx?$/.test(name)) out.push(p);
  }
  return out;
}

const bad = [];
for (const dir of DIRS) {
  for (const file of walk(dir)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    let inBlockComment = false;
    lines.forEach((line, i) => {
      const t = line.trim();
      /* Several files explain this rule at length, quoting the very code they warn against —
         reading those as violations would make the gate flag its own documentation. */
      if (inBlockComment) { if (t.includes('*/')) inBlockComment = false; return; }
      if (t.startsWith('/*')) { if (!t.includes('*/')) inBlockComment = true; return; }
      if (t.startsWith('//') || t.startsWith('*')) return;
      if (CUSTOM_HOOK_ARROW.test(line)) return;

      HOOK.lastIndex = 0;
      let m, flagged = false;
      while ((m = HOOK.exec(line)) && !flagged) {
        const before = line.slice(0, m.index);
        const hit = CONDITIONAL.find(c => c.re.test(before));
        if (!hit) continue;
        const where = `${relative(ROOT, file)}:${i + 1}`;
        if (ALLOW.has(where)) continue;
        bad.push({ where, why: hit.why, text: t.slice(0, 110) });
        flagged = true;   // one report per line, not one per call on it
      }
    });
  }
}

if (bad.length) {
  console.error('\n✗ check:conditional-hooks — a hook is called somewhere its call can be skipped:\n');
  for (const b of bad) console.error(`  ${b.where}  (${b.why})\n    ${b.text}\n`);
  console.error('  React counts hooks per render. A hook that runs on some renders and not others');
  console.error('  throws the screen away the moment the count changes — on the branch nobody');
  console.error('  clicked, which is the branch that breaks.');
  console.error('  Fix: hoist it to the top level of the component and use the value in the branch.\n');
  process.exit(1);
}
console.log('✓ check:conditional-hooks — every hook call is unconditional');
