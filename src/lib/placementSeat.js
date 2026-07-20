// Per-zone seat helpers — the ONE place that translates between a zone's authoring
// controls (a mode string + a seat choice) and its stored `placement_config[zone]`
// value. Shared by AddElement (create) and ManageElements (edit) so the two screens
// can't drift. Pure — no React, no side effects.
//
// A zone value is EITHER a bare mode string ('hug' | 'verge' | …) OR the object form
// `{ mode, seat }`. The object form is used only when a WALL-hug zone carries a
// non-default seat depth (proud/flush); everything else stays a plain string so the
// config reads cleanly. This mirrors core's `zoneCfg`/`zoneSeat` READ side
// (spattoo-core/src/designer/placement.js) — this module is the WRITE/inverse.
//
// Seat depth (proud = solid body stands ON the wall; flush = centred, back tucks in)
// applies only to a wall hug (side / middle_tier). verge/stand/perch seat by their own
// logic; 'auto' means "no override" → core's config-driven default (scatter ? flush : proud).

// Zones whose wall-hug placement supports a seat-depth override.
const WALL_HUG_ZONES = ['side', 'middle_tier'];

// Seat select only shows for a wall-hug zone that is actually in 'hug' mode.
export function zoneShowsSeat(zone, mode) {
  return WALL_HUG_ZONES.includes(zone) && mode === 'hug';
}

// Insert (base sunk INTO the surface, standing at an angle) is a MODIFIER, not a position — it rides
// the zone object alongside `seat` and composes with an UPRIGHT base pose: `stand` on a flat surface,
// `hug` against a wall. It does NOT compose with perch/verge (they seat on the rim edge). The ONE
// predicate for "offer the insert toggle", shared by both authoring screens. Mirrors core's
// `zoneInsert` composition (spattoo-core placement.js) — this module is the WRITE/inverse side.
export function zoneShowsInsert(mode) {
  return mode === 'stand' || mode === 'hug';
}

// Read the placement mode from a stored zone value (string or { mode, seat }).
export function zoneValueMode(value, fallback = 'hug') {
  if (value && typeof value === 'object') return value.mode ?? fallback;
  return value ?? fallback;
}

// Read the seat choice from a stored zone value → 'proud' | 'flush' | 'auto'.
// A bare string (or any non-proud/flush seat) reads as 'auto' (no override).
export function zoneValueSeat(value) {
  if (value && typeof value === 'object' && (value.seat === 'proud' || value.seat === 'flush')) {
    return value.seat;
  }
  return 'auto';
}

// Read the insert modifier from a stored zone value → its params object ({ depth, lean_deg,
// jitter_deg }, any subset — {} means "on, all defaults") or null (off). Only the object form carries
// it; the legacy `mode:"insert"` string is promoted by `splitZoneValue` (which has the shared global
// params to fold in).
export function zoneValueInsert(value) {
  if (value && typeof value === 'object' && value.insert && typeof value.insert === 'object') {
    return value.insert;
  }
  return null;
}

// Split a stored zone value into the authoring controls { mode, seat, insert }, promoting the LEGACY
// `insert` POSITION (`mode:"insert"` + shared global `placement_config.insert`) into
// { mode:<stand|hug>, insert:{…} } — insert is a MODIFIER now, not a position. `globalInsert` is the
// legacy shared `placement_config.insert`. The pose insert composes with is the zone's natural
// upright base: `stand` on a flat surface, `hug` against a wall (geometry-driven, no element-type
// branch). Mirrors core's `zoneCfg` promotion. Pure.
export function splitZoneValue(value, zone, globalInsert = null) {
  let mode = zoneValueMode(value);
  let insert = zoneValueInsert(value);
  if (mode === 'insert') {
    mode = WALL_HUG_ZONES.includes(zone) ? 'hug' : 'stand';
    if (insert == null) insert = globalInsert ?? {};
  }
  return { mode, seat: zoneValueSeat(value), insert };
}

// Serialize a zone's authoring controls back to its stored value. Modifiers ride the object form
// `{ mode, seat, insert }`: `seat` only for a wall-hug zone with an explicit proud/flush; `insert`
// only when the pose supports it (zoneShowsInsert) and the toggle is on (a non-null object — `{}`
// means on-with-defaults and IS written). With no modifiers it stays the plain mode string so the
// config reads cleanly.
export function serializeZone(mode, seat, insert = null) {
  const m = mode || 'hug';
  const extra = {};
  if (m === 'hug' && (seat === 'proud' || seat === 'flush')) extra.seat = seat;
  if (insert && typeof insert === 'object' && zoneShowsInsert(m)) extra.insert = insert;
  return Object.keys(extra).length ? { mode: m, ...extra } : m;
}
