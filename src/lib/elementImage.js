import { removeBg } from './api.js';
import { normalizeArtwork } from '@spattoo/designer';

// Turn a raw 2D image (an upload, or a 3D-preview capture) into an element's master image: optionally
// background-removed, then normalized (cropped to content + centred at 80% of a square). The result is
// used as BOTH image_url (the rendered sticker) and thumbnail_url — the server bakes the small picker
// (thumb_key) from it. The ONE 2D-image pipeline, shared by AddElement (create) and ManageElements
// (replace) so the two screens can't drift. remove.bg failure falls back to the original, still
// normalized. 1024 keeps placed stickers crisp; the picker still loads the server's 256 bake.
//
// The normalizer itself is CORE's (@spattoo/designer → shared/image.js) — the very same function the
// designer's Uploads path runs when a baker uploads a decoration of his own. An element authored here
// and a decoration uploaded there are therefore the same pixels out of the same code. It used to be a
// second copy in this repo, and the copy had already drifted: no EXIF orientation (a portrait phone
// photo came out sideways) and no decode-failure path (an undecodable file hung the save forever).
export const ELEMENT_IMAGE_DIM = 1024;   // element master (image_url + thumbnail_url)
export const PATTERN_THUMB_DIM = 512;    // picker thumbnail baked from a 3D capture (piping patterns)

export async function prepareElementImage(blob, { removeBgEnabled = true } = {}) {
  let processed = blob;
  if (removeBgEnabled) {
    try { processed = await removeBg(blob); } catch { /* keep original on remove.bg failure */ }
  }
  return normalizeArtwork(processed, { size: ELEMENT_IMAGE_DIM });
}
