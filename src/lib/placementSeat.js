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

// Serialize a zone's authoring controls back to its stored value: the object form
// `{ mode, seat }` only for a wall-hug zone with an explicit proud/flush seat,
// otherwise the plain mode string.
export function serializeZone(mode, seat) {
  const m = mode || 'hug';
  return (m === 'hug' && (seat === 'proud' || seat === 'flush')) ? { mode: m, seat } : m;
}
