import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import fs from 'fs';
import path from 'path';

// Source-map upload to Sentry runs ONLY when SENTRY_AUTH_TOKEN is set (a build-time
// secret). Without it the plugin is omitted and the build is unchanged — so local
// dev/builds never need the token. Set it (+ build) to de-minify admin traces.
// Core's source, resolved RELATIVE to this file rather than hardcoded to one machine. Present on a
// developer box with both repos checked out side by side; absent on any build server.
const CORE_SRC = path.resolve(import.meta.dirname, '../spattoo-core/src/index.js');
/* ⚠️ ONE BOOLEAN, TWO CONSEQUENCES, SO THEY CANNOT DRIFT. The same check that decides whether to
   alias the designer to core's SOURCE also decides whether this build may stamp a template with a
   renderer floor — because running source means `BUILD.version` names the last RELEASE, not the
   code actually executing, and a floor stamped from it would be a confident lie.
   Core cannot work this out for itself: pack-vendor.mjs requires the tarball's src/ to match
   `git archive HEAD src` byte for byte, so nothing injected at pack time survives, and a committed
   flag cannot tell a tarball from a working tree that has moved past the same commit. Admin is the
   only place that knows, and it knows it HERE. See spattoo-docs/plans/renderer-version-floor.md. */
const CORE_FROM_SOURCE = fs.existsSync(CORE_SRC);

const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;

// Dev-only: accept a POSTed PNG data URL from the Texture Calibrator's "Save snapshot" and write it
// into .snapshots/ in the project (which tooling can read — unlike ~/Downloads, which macOS blocks).
function snapshotSaver() {
  return {
    name: 'snapshot-saver',
    configureServer(server) {
      server.middlewares.use('/__snapshot', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            const data = String(body).replace(/^data:image\/png;base64,/, '');
            const dir = path.resolve(process.cwd(), 'snapshots');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'rustic-snapshot.png'), Buffer.from(data, 'base64'));
            res.statusCode = 200; res.end('ok');
          } catch (e) {
            res.statusCode = 500; res.end(String(e?.message || e));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    snapshotSaver(),
    ...(sentryAuthToken
      ? [sentryVitePlugin({
          org: 'feelingsflavours', project: 'spattoo-admin', authToken: sentryAuthToken,
          /* ⚠️ UPLOAD THE MAPS, THEN DELETE THEM FROM THE DEPLOY. Without this the build emitted 63
             .map files — 15.1 MB — straight into dist/, and nothing removed them. The largest,
             index-*.js.map at 11 MB, carried 223 spattoo-core source files with their ORIGINAL text,
             comments included. Anyone who guessed the URL could download the designer.
             Sentry still gets readable stack traces: it has the maps, the browser does not. */
          sourcemaps: { filesToDeleteAfterUpload: ['dist/**/*.map'] },
        })]
      : []),
  ],
  build: { sourcemap: !!sentryAuthToken },   // emit maps only when we'll upload them
  server: {
    port: 5174,
    /* ⚠️ THE ASSETS ORIGIN, PROXIED, SO A STUDIO IS LIT LIKE A CAKE. `src/scene.js` points
       `configureEnvMap` at `/cdn`; without this proxy that is a 404 and SceneEnv falls back to
       drei's indoor preset, which is the fault scene.js exists to end. Proxied rather than fetched
       straight from the CDN because its CORS allowlist holds the app's origins, not this one, and a
       WebGL texture load with no `access-control-allow-origin` fails silently — straight back into
       the same fallback. Same target, same reasoning, as spattoo-core's own harness proxy. */
    proxy: {
      '/cdn': {
        target: 'https://dev.spattoocdn.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/cdn/, ''),
      },
    },
  },
  /* Exposed so the catalogue action can refuse to stamp a renderer floor from an unreleased
     build. Not an env var and not a mode: it is the filesystem fact above, handed through. */
  define: { __CORE_FROM_SOURCE__: JSON.stringify(CORE_FROM_SOURCE) },
  appType: 'spa',
  resolve: {
    // ── Core from SOURCE when it is next door, from the vendored tarball otherwise ────────────
    // Admin used to alias @spattoo/designer to an ABSOLUTE path on one laptop. That is what made
    // the studios quick to build — an edit in core shows up here on save, no pack, no install —
    // and it is also why admin could not be deployed: no build server has that directory.
    //
    // The filesystem decides. Core checked out beside admin → alias wins → source, instant. A
    // build server → no such directory → the `file:vendor/…tgz` in package.json resolves instead.
    // No env var, no mode to remember, and nobody has to know which they are in.
    //
    // Consequence worth knowing: locally you are NOT running the vendored tarball, so a stale
    // vendor cannot be noticed by using the app. That is what makes vendoring into admin part of
    // `npm run release` rather than a thing to remember — see scripts/release.mjs in core.
    alias: {
      ...(CORE_FROM_SOURCE ? { '@spattoo/designer': CORE_SRC } : {}),
    },
    dedupe: ['react', 'react-dom', 'three', '@react-three/fiber', '@react-three/drei'],
  },
});
