/* ── A login-free probe for the photo-edit pipeline ──────────────────────────────────────────────
 *
 * Topper Swap Studio can only be reached past the admin sign-in, and its own comment says the two
 * questions it exists to answer are whether an erased region looks erased and whether a composited
 * glyph sits in a photo without looking pasted on. Those are questions about `photoEdit.js` and the
 * shared text renderer — not about React, the router or the sign-in — and `photoEdit.js` says in its
 * header that it is framework-free precisely so it can be exercised on its own.
 *
 * So this puts the pipeline on `window` and nothing else. It is the same reasoning dev/piping-drag
 * gives in spattoo-core: "seeing that in the real designer costs a baker login ... which is why the
 * gap survived so long". A thing that can only be judged behind a password does not get judged.
 *
 * ⚠️ DEV ONLY BY CONSTRUCTION, not by convention: nothing imports this module, so the bundler never
 * reaches it and it cannot ship. It is loaded by URL from a driver script. What it exposes is two
 * pure image/text functions that are already in the admin bundle — no secrets, no network, no state.
 *
 * What it found, 2026-09-11, on a real customer reference photo (a plaque reading "OUR LITTLE /
 * Goose / IS ON THE WAY!"):
 *   • The ERASE is convincing. The script word went, the plaque's surface and its gold border
 *     survived, and the two lines above and below were untouched. A faint patch of different grain
 *     is visible at 2x if you look for it.
 *   • The COMPOSITE only convinces in a SCRIPT face — and `FAMILIES` in TopperSwapStudio has none.
 *     That list (Impact, Arial Black, Georgia, Trebuchet, Verdana) is right for the job the studio
 *     was written for, swapping one LETTER or NUMBER on a topper, and wrong for a handwritten name
 *     on a plaque. In Georgia 900 with the default outline it reads as a sticker; in Snell Roundhand
 *     it reads as the cake.
 *   • `textSlots.js` already loads an arbitrary webfont (`font: { family, url }` → `FontFace`), so
 *     the gap is the LIST, not the renderer. */
import { DEFAULT_TEXT_STYLE, resolveTextStyle, renderTextSlot } from '@spattoo/designer';
import * as photoEdit from './photoEdit.js';

window.__probe = { ...photoEdit, DEFAULT_TEXT_STYLE, resolveTextStyle, renderTextSlot };
