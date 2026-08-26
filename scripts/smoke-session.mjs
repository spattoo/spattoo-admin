#!/usr/bin/env node
//
// ── Give check:smoke a session of its own ───────────────────────────────────────────────────────
//
//   npm run smoke:session
//
// Prints a one-line snippet to paste into a browser console. That browser posts its Supabase
// session here, and it is written to `.smoke-session.json` (gitignored). Nothing is typed into this
// script and no password is stored.
//
// ── WHY A COPY AND NOT A LOGIN ──────────────────────────────────────────────────────────────────
// Supabase enforces a captcha server-side, and a captcha exists to tell a person from a script. So
// a gate cannot sign itself in — a person has to, once, and hand over the result.
//
// ── WHY ITS OWN ACCOUNT, AND NOT YOURS ──────────────────────────────────────────────────────────
// Refresh tokens are SINGLE USE: spending one issues a fresh pair and kills the old. Two clients
// sharing a chain therefore knock each other out, and that is not theoretical — copying a working
// session out of the admin tab meant the first smoke run signed that tab out.
//
// So the session this stores should belong to a user that exists ONLY in dev and that nobody sits
// logged in as. Then the gate's chain is its own and the two never meet.
//
// ── WHAT IT HOLDS ───────────────────────────────────────────────────────────────────────────────
// A live session for whoever pasted it. `.smoke-session.json` is gitignored and should stay that
// way. check:smoke renews it on every run, so one copy lasts until Supabase stops renewing.

import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, '.smoke-session.json');
const KEY = 'spattoo-admin-auth';       // the key src/lib/supabase.js stores its session under
const PORT = 5178;

const snippet =
  `fetch('http://localhost:${PORT}/',{method:'POST',body:localStorage.getItem('${KEY}')})`
  + `.then(r=>r.text()).then(console.log)`;

console.log(`
  1. Sign in to the admin AS THE SMOKE USER — a separate browser profile or a private
     window, so your own session is left alone.

  2. Open its console on any admin page and paste this:

     ${snippet}

  3. It prints "ok" and this exits. Waiting…
`);

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.end();

  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    if (req.method !== 'POST' || !body) { res.end('no'); return; }
    let email = '(unknown)';
    try { email = JSON.parse(body)?.user?.email ?? email; } catch { /* stored verbatim regardless */ }
    writeFileSync(OUT, JSON.stringify({ key: KEY, value: body }, null, 2));
    res.end('ok');
    // The EMAIL, never the token. Enough to catch the commonest mistake — pasting from the tab you
    // are working in — and nothing that is worth anything if it ends up in a terminal log.
    console.log(`  ✓ saved a session for ${email} → .smoke-session.json`);
    if (!/smoke/i.test(email)) {
      console.log('  ! that does not look like the smoke user. If it is the account you work in,');
      console.log('    the first check:smoke run will sign you out of it.');
    }
    server.close();
    process.exit(0);
  });
});

server.listen(PORT);
setTimeout(() => {
  console.error('\n  ✗ nothing pasted within five minutes — nothing was written.');
  process.exit(1);
}, 5 * 60_000);
