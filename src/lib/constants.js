// Mirror of spattoo-core's domain enums (src/designer/constants.js). The string
// VALUES are a persisted contract shared with the designer (DB rows / saved
// designs), so they must match core EXACTLY and must never change.
//
// Kept as a local copy on purpose: importing from '@spattoo/designer' would pull
// the entire ~940 KB designer bundle into these admin screens. The values are
// stable canonical identifiers, so a small mirror is the right trade-off.

export const ZONES = Object.freeze({
  TOP_SURFACE: 'top_surface',
  SIDE:        'side',
  MIDDLE_TIER: 'middle_tier',
  BOARD:       'board',
  RIM:         'rim',
  TOP:         'top',
});

// The zones offered as placement chips in the admin element editors.
export const ZONE_LIST = [ZONES.TOP_SURFACE, ZONES.SIDE, ZONES.MIDDLE_TIER, ZONES.BOARD];

export const PLACEMENT_MODES = Object.freeze({
  STAND:            'stand',
  HUG:              'hug',
  FAUX_BALL_SINGLE: 'faux_ball_single',
});

// Element-type slugs with bespoke handling in the designer — reference by name.
export const ELEMENT_SLUGS = Object.freeze({
  SCATTERED_DECOR: 'scattered_decor',
  PICKS:           'picks',
  IMAGE_TOPPER:    'image_topper',
});
