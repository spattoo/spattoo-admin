#!/usr/bin/env node
//
// ── Every screen actually OPENS ─────────────────────────────────────────────────────────────────
//
// Every other gate reads source as text. `check:bindings` looks for names nothing declares,
// `check:dup` for copied blocks, and the unit tests exercise pure functions. Not one of them ever
// renders a component or opens a route — so "the screen is blank" is invisible to all of them, by
// construction.
//
// Which is not a theoretical hole. In one week:
//
//   • `export default` ended up attached to the wrong function in ManageTemplates. Perfectly legal
//     JavaScript, so the build passed, the lint passed, 1137 unit tests passed, and the whole screen
//     white-screened for every visitor. check:bindings was built for exactly this class of bug and
//     could not see it: nothing was undeclared.
//   • Vite served dep URLs stamped with a hash whose files had been cleared, so Manage Elements died
//     on `Failed to fetch dynamically imported module`. No source file was wrong at all.
//
// A browser finds both in about a second each. So this opens all 49 routes and fails on anything
// that would have made a person say "it's broken".
//
// ── WHAT COUNTS AS BROKEN ───────────────────────────────────────────────────────────────────────
//   · an uncaught exception on the page
//   · a console error
//   · a failed request for the app's own assets (a 4xx/5xx from our own origin)
//   · the error boundary's "Something went wrong"
//
// Requests to OTHER origins are not our business — a flaky third party is not a broken screen, and
// a gate that fails on someone else's outage gets switched off within a week.
//
// ── AUTHENTICATION: log in yourself, once ───────────────────────────────────────────────────────
// Every screen is behind a login, so the gate needs a session. It can get one two ways, and the
// FIRST is the one to use:
//
//   npm run check:smoke -- --login
//       Opens a real browser window. You sign in by hand — captcha, one-time code, whatever the
//       login asks for — and the session is saved to .smoke-session.json. No password is typed
//       into this script, stored by it, or seen by it.
//
//   npm run check:smoke
//       Uses that saved session. It carries a refresh token, so the app renews it on load and one
//       manual login lasts until Supabase expires the refresh — weeks, typically, not hours.
//
// The saved file holds a LIVE session for whatever account you signed in as. It is gitignored, and
// it should be an account that exists only in dev.
//
// SMOKE_EMAIL / SMOKE_PASSWORD in .env.local still work and are what an unattended CI run would
// use, signing in through Supabase's token endpoint rather than the form — a form can carry a
// captcha, and a gate a captcha can block is a gate that stops running. Nothing logs or echoes them.
//
// With neither, it SKIPS loudly and says so. Failing the build over a missing local file is how a
// gate gets deleted.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = new URL('..', import.meta.url).pathname;

// ── The routes, read from the app rather than listed here ───────────────────────────────────────
// A second list would go stale the first time somebody adds a screen, and a smoke test that misses
// the new screen is worse than none: it reports green over the thing most likely to be broken.
function routes() {
  const src = readFileSync(join(ROOT, 'src/main.jsx'), 'utf8');
  const block = src.match(/const ROUTES = \{([\s\S]*?)\n\};/);
  if (!block) die('could not find ROUTES in src/main.jsx — if it moved, update this script');
  return [...block[1].matchAll(/^\s*'([^']+)':/gm)].map(m => m[1]);
}

function env() {
  const out = {};
  for (const f of ['.env.local', '.env']) {
    let raw;
    try { raw = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (m && !(m[1] in out)) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return { ...out, ...process.env };
}

const die = m => { console.error(`✗ check:smoke — ${m}`); process.exit(1); };

const E = env();
const need = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'];
for (const k of need) if (!E[k]) die(`${k} is not set — it lives in .env.local`);

const SESSION_FILE = join(ROOT, '.smoke-session.json');
const LOGIN = process.argv.includes('--login');
const haveSaved = existsSync(SESSION_FILE);

if (!LOGIN && !haveSaved && !(E.SMOKE_EMAIL && E.SMOKE_PASSWORD)) {
  console.log('• check:smoke — SKIPPED: nothing to sign in with.\n');
  console.log('  Every screen here is behind a login, so without a session this gate can only');
  console.log('  prove the login page renders. Log in once, by hand:\n');
  console.log('      npm run check:smoke -- --login\n');
  console.log('  A browser opens, you sign in, and the SESSION is saved (no password is stored).');
  console.log('  After that, plain `npm run check:smoke` opens all', routes().length, 'screens and');
  console.log('  fails on any that break.');
  process.exit(0);
}

// ── A session, without touching the login form ──────────────────────────────────────────────────
async function session() {
  const r = await fetch(`${E.VITE_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: E.VITE_SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: E.SMOKE_EMAIL, password: E.SMOKE_PASSWORD }),
  });
  if (!r.ok) {
    // The message, never the credentials.
    die(`could not sign in as SMOKE_EMAIL (${r.status}). If the account or password changed, `
      + 'update .env.local. This gate failing is itself worth knowing: the login is broken.');
  }
  return r.json();
}

// ── The server ──────────────────────────────────────────────────────────────────────────────────
// Its OWN dev server on its OWN port, never a server that happens to be running. Reusing one means
// the gate reports on whatever state that process is in — which is exactly how a stale Vite cache
// went unnoticed for eleven days.
const PORT = 5199;
const AUTH_KEY = 'spattoo-admin-auth';   // the key src/lib/supabase.js stores its session under
function serve() {
  const p = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('vite did not start within 60s')), 60_000);
    p.stdout.on('data', d => {
      if (String(d).includes('ready in')) { clearTimeout(t); res(p); }
    });
    p.stderr.on('data', d => process.stderr.write(d));
    p.on('exit', c => { clearTimeout(t); rej(new Error(`vite exited with ${c}`)); });
  });
}

// Credentials, if there are any, before paying for a dev server to discover they are wrong.
const creds = (!LOGIN && !haveSaved) ? await session() : null;

const server = await serve();
const stop = () => { try { server.kill('SIGTERM'); } catch {} };
process.on('exit', stop);

const browser = await chromium.launch({ headless: !LOGIN });
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  // A session saved from a previous `--login`. It carries the refresh token, so the app renews
  // itself on load and one manual sign-in lasts until Supabase expires the refresh.
  ...(!LOGIN && haveSaved ? { storageState: SESSION_FILE } : {}),
});

if (creds) {
  // Written before any script on the page runs, so the app boots already signed in.
  await ctx.addInitScript(([key, value]) => {
    window.localStorage.setItem(key, value);
  }, [AUTH_KEY, JSON.stringify({
    access_token: creds.access_token, refresh_token: creds.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (creds.expires_in ?? 3600),
    expires_in: creds.expires_in, token_type: 'bearer', user: creds.user,
  })]);
}

// ── Signing in by hand ──────────────────────────────────────────────────────────────────────────
// A real window, and it waits. Whatever the login asks for — a captcha, a one-time code, a provider
// redirect — a person can answer it and this script does not have to know any of it ever happened.
// It watches for the app's own auth key to appear, which is the app saying "signed in" in its own
// words rather than this script guessing from the URL or from what is on screen.
if (LOGIN) {
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/`);
  console.log('\n  A browser window is open. Sign in there.');
  console.log('  Use an account that exists ONLY in dev — the session is saved to disk.\n');
  try {
    await page.waitForFunction(
      key => !!window.localStorage.getItem(key), AUTH_KEY, { timeout: 5 * 60_000 });
  } catch {
    await browser.close(); stop();
    die('no sign-in within five minutes — nothing was saved');
  }
  // A moment for the app to finish writing the session, then keep it.
  await page.waitForTimeout(1500);
  await ctx.storageState({ path: SESSION_FILE });
  await browser.close();
  stop();
  console.log(`✓ check:smoke — signed in, session saved to ${SESSION_FILE.replace(ROOT, '')}`);
  console.log('  Run `npm run check:smoke` from now on. No password was stored.');
  process.exit(0);
}

const all = routes();
const broken = [];
let ignored = 0;   // third-party console noise, reported at the end rather than hidden
const page = await ctx.newPage();

for (const route of all) {
  const problems = [];
  let foreign = 0;
  // ── Ours, or somebody else's? ─────────────────────────────────────────────────────────────────
  // The login page logs two console errors when it is perfectly healthy, and they come from
  // challenges.cloudflare.com — the captcha widget talking to itself. A gate that fails on those
  // fails on every screen from the first run, and a gate that cries wolf gets switched off.
  //
  // So the same rule the network check uses: a script we did not ship is not our screen breaking.
  // Counted rather than swallowed, and reported, so this cannot quietly grow into a way of hiding
  // real errors. An error with NO location is treated as ours — better to over-report our own.
  const mine = loc => !loc?.url || loc.url.includes(`localhost:${PORT}`);
  const onConsole = m => {
    if (m.type() !== 'error') return;
    if (mine(m.location())) problems.push(`console: ${m.text()}`);
    else foreign++;
  };
  const onError = e => problems.push(`uncaught: ${e.message}`);
  const onResponse = r => {
    if (r.status() >= 400 && r.url().includes(`localhost:${PORT}`)) {
      problems.push(`${r.status()} ${r.url().replace(`http://localhost:${PORT}`, '')}`);
    }
  };
  page.on('console', onConsole);
  page.on('pageerror', onError);
  page.on('response', onResponse);

  try {
    await page.goto(`http://localhost:${PORT}${route}`, { waitUntil: 'networkidle', timeout: 30_000 });
    // Long enough for a lazy route's chunk to arrive and for React to have thrown if it is going to.
    await page.waitForTimeout(1200);
    if (await page.getByText('Something went wrong').count()) {
      problems.push('the error boundary caught a render failure');
    }
  } catch (e) {
    problems.push(`did not load: ${e.message.split('\n')[0]}`);
  }

  page.off('console', onConsole);
  page.off('pageerror', onError);
  page.off('response', onResponse);

  if (problems.length) broken.push({ route, problems: [...new Set(problems)].slice(0, 4) });
  ignored += foreign;
  process.stdout.write(problems.length ? '✗' : '.');
}

await browser.close();
stop();
console.log('');

if (!broken.length) {
  console.log(`✓ check:smoke — all ${all.length} screens open clean`
    + (ignored ? `  (${ignored} console errors ignored from third-party scripts)` : ''));
  process.exit(0);
}

console.error(`\n✗ check:smoke — ${broken.length} of ${all.length} screens are broken.\n`);
console.error('  These are the failures no amount of reading the source finds: a build that');
console.error('  compiles, tests that pass, and a blank page.\n');
for (const b of broken) {
  console.error(`   • ${b.route}`);
  for (const p of b.problems) console.error(`       ${p}`);
}
process.exit(1);
