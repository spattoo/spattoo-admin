// ── Light an admin studio the way production lights a cake ───────────────────────────────────────
//
// Imported once, for its side effect, from `main.jsx`:
//
//     import './scene.js';
//
// ⚠️ WHY THIS EXISTS. Every studio here already mounts the designer's own `SceneLights`/`SceneEnv`
// (INVARIANTS #17), and `check:studio-scene` holds them to it. That matched the LAMPS and left the
// ENVIRONMENT behind: `SceneEnv` asks `envProps()` for a map, `envProps` returns one only when a
// host has called `configureEnvMap`, and admin never did. So every studio fell back to drei's INDOOR
// `apartment` preset while every deployed cake is lit by the self-hosted OUTDOOR map.
//
// Three studios carry a note admitting it and calling it "a separate, wider fix" — CardCutoutStudio,
// ManeStudio, TopEdgeStudio. This is that fix. Sandeep, of a brushstroke render: *"I see too much
// exposure of light on this screenshot."* An indoor HDRI is brighter and flatter than the sky our
// cakes stand under, and a studio is where colour gets decided.
//
// It is the same file, for the same reason, as `dev/scene.js` in spattoo-core — which lists what the
// divergence has already cost over there: three parameter sweeps run and reported against the wrong
// environment, and a scene-wide HDRI swap shipped and reverted on their conclusions.
//
// ⚠️ IT GOES THROUGH THE VITE PROXY IN DEV, NOT STRAIGHT TO THE CDN. The CDN's CORS allowlist holds
// the app's origins, and a WebGL texture load with no `access-control-allow-origin` fails — which
// `SafeEnvironment` then swallows, putting us back in the silent fallback this file exists to
// prevent. `/cdn` is proxied in vite.config.js, so the request is same-origin and there is no CORS
// to satisfy.
//
// ⚠️ AND DEPLOYED ADMIN NEEDS `VITE_ASSETS_BASE`, which is stated rather than assumed: the proxy is a
// dev-server feature and does not exist in a build, so without that variable a deployed admin asks
// for `/cdn/...`, gets the SPA's own index.html back, and falls through to the preset exactly as it
// does today. No regression, and the console warning from `envProps` says so out loud. Studios are
// used in dev, which is where this matters; setting the variable makes the deployed ones right too.
//
// ⚠️ IT DELIBERATELY DOES NOT PIN A MAP OR AN INTENSITY. Which HDRI, and how strong, live in core
// (`SCENE_ENV`, `ENV_HDR_PATH`) and are shared with production by construction. The only thing admin
// was missing is the assets base, so that is the only thing this supplies — a second place to
// configure the scene is a second place for it to drift.
import { configureEnvMap } from '@spattoo/designer';

export const ADMIN_ASSETS_BASE = import.meta.env.VITE_ASSETS_BASE || '/cdn';

configureEnvMap(ADMIN_ASSETS_BASE);
