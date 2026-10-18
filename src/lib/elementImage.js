import { removeBg } from './api.js';
import { normalizeArtwork } from '@spattoo/designer';

// Turn a raw 2D image (an upload, or a 3D-preview capture) into an element's master image: optionally
// background-removed, then normalized (cropped to content + centred at 80% of a square). The result is
// used as BOTH image_url (the rendered sticker) and thumbnail_url — the server bakes the small picker
// (thumb_key) from it. The ONE 2D-image pipeline, shared by AddElement (create) and ManageElements
// (replace) so the two screens can't drift. A cut-out failure falls back to the original, still
// normalized, and now SAYS SO — see below. 1024 keeps placed stickers crisp; the picker still loads the server's 256 bake.
//
// The normalizer itself is CORE's (@spattoo/designer → shared/image.js) — the very same function the
// designer's Uploads path runs when a baker uploads a decoration of his own. An element authored here
// and a decoration uploaded there are therefore the same pixels out of the same code. It used to be a
// second copy in this repo, and the copy had already drifted: no EXIF orientation (a portrait phone
// photo came out sideways) and no decode-failure path (an undecodable file hung the save forever).
export const ELEMENT_IMAGE_DIM = 1024;   // element master (image_url + thumbnail_url)
export const PATTERN_THUMB_DIM = 512;    // picker thumbnail baked from a 3D capture (piping patterns)

/* ⚠️ THE FAILURE USED TO BE SWALLOWED WHOLE — `catch { }`, no log, no caller. Keeping the original
   image is right (a vendor outage must not block authoring), but SAYING NOTHING is not: the screen
   then shows the picture with its background still on and no reason anywhere, which reads as "the
   feature is broken" rather than "the vendor refused this call". Sandeep hit exactly that on the
   first real Leonardo attempt, and the only place the answer existed was the Network tab.

   So the fallback stays and the reason comes out: `onBgError` for the screen, console for whoever
   has devtools open. */
export async function prepareElementImage(blob, { removeBgEnabled = true, onBgError = null } = {}) {
  let processed = blob;
  if (removeBgEnabled) {
    try {
      processed = await removeBg(blob);
    } catch (err) {
      console.warn('background removal failed — using the original image:', err.message);
      onBgError?.(err);
    }
  }
  return normalizeArtwork(processed, { size: ELEMENT_IMAGE_DIM });
}
