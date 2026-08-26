#!/usr/bin/env node
//
// ── Every name a file CALLS is declared somewhere in it ─────────────────────────────────────────
//
// A "binding" is the link between a name and a declaration: `const set = …` binds `set`. Call
// `set(...)` with nothing declaring it and you get a ReferenceError — at RUN time, when somebody
// opens the page, because an undeclared name is perfectly legal JavaScript until it executes.
//
// That is why this exists rather than a lint rule nobody runs. Three crashes in one week, all the
// same shape, none caught by a build:
//
//   • `set is not defined` — GrassStudio. Extracting the shared save hook removed the block that
//     held two local helpers, leaving eight callers of a name that no longer existed. The studio
//     threw on render, so its Save button was unreachable from the day it was added, and nobody
//     knew until somebody finally opened the page.
//   • `selectedGenerated is not defined` — a prop declared on the wrong component, two levels up
//     from where it was used. It shipped, and every template with a rainbow crashed on open.
//   • A TDZ crash from a `const` read above its own declaration.
//
// ── WHAT IT DOES AND DOES NOT CATCH ─────────────────────────────────────────────────────────────
// It asks one question per file: is this name declared ANYWHERE in here? Not "is it in scope at
// this point" — that needs a real parser and a scope chain, and the bug worth catching is the
// deleted declaration, not the subtle shadow. A name declared in the wrong function still passes,
// which is honest: this is a smoke alarm, not a type checker.
//
// Comments and strings are blanked before scanning, with their length preserved so line numbers
// stay true. Without that, prose reads as code — a first version flagged 123 problems, every one of
// them a phrase like "the designer (…)" inside a comment.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIRS = ['src/admin', 'src/lib'];

// ── Getting to something scannable ──────────────────────────────────────────────────────────────
// esbuild parses the file and hands back plain JS: JSX text becomes a STRING ARGUMENT, so prose
// stops looking like code. That matters more than it sounds. A regex stripper got this wrong three
// ways in a row — the `>` of an arrow starting a "JSX text" match and eating the parameters after
// it; an apostrophe in "don't" opening a string that swallowed the next fifty lines; `asset(s)` in
// a sentence reading as a call. Every one produced a confident report about working code.
//
// The cost is line numbers: the output is not the input. So a finding names the file and the
// identifier, which is enough to grep for, and does not pretend to a precision it does not have.
import { transformSync } from 'esbuild';

const blank = m => m.replace(/[^\n]/g, ' ');

function scannable(src, loader) {
  // minifyWhitespace drops COMMENTS, which the plain transform keeps — and a comment is where prose
  // lives. minifyIdentifiers stays off, or every local would be renamed to a single letter and there
  // would be nothing left to check.
  const { code } = transformSync(src, {
    loader, jsx: 'transform', minifyWhitespace: true, minifyIdentifiers: false, minifySyntax: false,
  });
  // Strings survive the transform — including every piece of JSX text. Blank them.
  // ONE pass, not three. Blanking backticks, then single quotes, then doubles lets an apostrophe
  // inside a double-quoted string — `"don't"` — open a phantom single-quoted string that swallows
  // the next real declaration. Alternation takes whichever quote opens first, which is what a
  // tokeniser does.
  return code.replace(/`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, blank);
}

// Things that exist without being declared here.
const AMBIENT = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new', 'do',
  'async', 'yield', 'void', 'delete', 'in', 'of', 'instanceof',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask',
  'alert', 'confirm', 'prompt', 'fetch', 'btoa', 'atob',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'structuredClone',
  // Browser globals. The call-only rule never needed these — nobody writes `document(…)` — but
  // reading `document.body` is the commonest value reference there is.
  'window', 'document', 'console', 'navigator', 'location', 'history', 'localStorage',
  'sessionStorage', 'performance', 'crypto', 'screen', 'URL', 'URLSearchParams', 'FormData',
  'Blob', 'File', 'FileReader', 'Image', 'Audio', 'Event', 'CustomEvent', 'AbortController',
  'import', 'globalThis', 'self', 'process',
]);

// Every name this file DECLARES, gathered once.
//
// Collecting is better than testing each name against a pattern, which was the first attempt and
// missed the commonest declaration in the codebase: a destructured prop in a component signature —
// `function Slider({ label, onChange, fmt })`. That version reported 84 problems, all of them props.
//
// It deliberately over-collects. A default value inside a parameter list contributes its identifiers
// too, so a few names are counted as declared when they are not. That bias is the right way round:
// this is a smoke alarm for a DELETED declaration, and a false alarm costs more trust than a missed
// one costs safety.
function declaredNames(src) {
  const names = new Set();
  const add = chunk => { for (const m of chunk.matchAll(/[A-Za-z_$][\w$]*/g)) names.add(m[0]); };

  for (const m of src.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // EVERY declarator in a comma-separated declaration, not just the first. `const pos = [], idx = []`
  // declares two names and this only ever collected `pos` — a gap the call-only rule never exposed,
  // because nobody writes `idx(…)`, and which lit up the moment reads were checked too.
  for (const m of src.matchAll(/(?:const|let|var)\s+([^;\n]{0,400})/g)) {
    for (const d of m[1].matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?==[^=]|,|$)/g)) names.add(d[1]);
  }
  // Destructuring that is assigned: `const { a, b } = …`, `let [x, y] = …`
  for (const m of src.matchAll(/(?:const|let|var)\s*([{[][\s\S]{0,800}?[}\]])\s*=/g)) add(m[1]);
  // Parameter lists — `(…) =>` and `(…) {` — which is where props and callbacks are bound.
  // One level of nesting allowed, because a default value is often a call: `fmt = v => v.toFixed(2)`
  // sits inside the very parameter list that declares `fmt`.
  for (const m of src.matchAll(/\(((?:[^()]|\([^()]*\)){0,800})\)\s*(?:=>|\{)/g)) add(m[1]);
  // A lone arrow parameter: `x => …`
  for (const m of src.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
  // \`import{a,b}from"x"\` — minified whitespace means the spaces are gone.
  for (const m of src.matchAll(/import\s*([\s\S]*?)\s*from/g)) add(m[1]);
  for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // Object and class METHOD shorthand — `capture(error, ctx) { … }` declares `capture`, it does not
  // call it. Without this, every method in a plain-object module reads as an undefined function.
  for (const m of src.matchAll(/(?:^|[,{]\s*)([A-Za-z_$][\w$]*)\s*\([^()]{0,200}\)\s*\{/gm)) names.add(m[1]);
  return names;
}

const files = DIRS.flatMap(d => {
  let names = [];
  try { names = readdirSync(join(ROOT, d)); } catch { return []; }
  return names.filter(f => /\.(jsx?|mjs)$/.test(f)).map(f => join(d, f));
});

const problems = [];
for (const rel of files) {
  const raw = readFileSync(join(ROOT, rel), 'utf8');
  let src;
  try {
    src = scannable(raw, rel.endsWith('.jsx') ? 'jsx' : 'js');
  } catch (e) {
    // A file that will not parse is a bigger problem than an unbound name, and saying so beats
    // skipping it quietly.
    console.error(`✗ check:bindings — ${rel} does not parse: ${e.message}`);
    process.exit(1);
  }
  const declared = declaredNames(src);
  // ── Called, OR read ───────────────────────────────────────────────────────────────────────────
  // It only ever looked at CALL sites — `name(` — and that missed the very crash it exists for.
  // GrassStudio read `tris` as a value: `tris > 400_000`, `tris.toLocaleString()`. Never called, so
  // never inspected, and the studio threw 'tris is not defined' on render with this gate green.
  //
  // A read is matched narrowly, and the narrowness is the point — a name followed by `.`, or by a
  // comparison. Those two shapes are where a missing value actually bites (`x.foo` throws on
  // undefined; `x > n` is silently false), and they are rare enough in prose-inside-code to keep the
  // false alarms down. Anything looser flagged dozens of legitimate object keys and locals from
  // outer scopes, and a gate that cries wolf is a gate that gets deleted.
  const sites = [
    /[^A-Za-z0-9_.$]([a-z][A-Za-z0-9_$]*)\s*\(/g,              // name(
    // Not after a `/`, or a regex's own flags read as a name: `/phone/i.test(x)` is `i.test`.
    /[^A-Za-z0-9_.$'"`/]([a-z][A-Za-z0-9_$]*)\s*\.[a-zA-Z]/g,  // name.foo
    /[^A-Za-z0-9_.$]([a-z][A-Za-z0-9_$]*)\s*[<>]=?\s*[\d'"`]/g, // name > 4, name <= '…'
  ];
  for (const re of sites) {
    for (const m of src.matchAll(re)) {
      const name = m[1];
      if (AMBIENT.has(name)) continue;
      if (declared.has(name)) continue;
      problems.push({ rel, name });
    }
  }
}

// One report per name per file: a deleted declaration has as many call sites as it had callers, and
// eight identical lines is not eight problems.
const seen = new Set();
const unique = problems.filter(p => {
  const k = `${p.rel}:${p.name}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

if (!unique.length) {
  console.log(`✓ check:bindings — every name called is declared (${files.length} files)`);
  process.exit(0);
}

console.error('✗ check:bindings — a name is called but nothing declares it.\n');
console.error('  This is a ReferenceError at RUN time. It builds, it deploys, and it throws when');
console.error('  somebody opens the page.\n');
for (const p of unique) console.error(`   • ${relative('', p.rel)}  →  ${p.name}(…)`);
console.error('\n  If one of these is a false positive, the check is too crude — widen declaredNames,');
console.error('  do not silence the line.');
process.exit(1);
