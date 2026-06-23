import { makePipingLayer } from '@spattoo/designer';

// inspirationToDesign — pure mapper: an inspiration ANALYSIS (the tier-wise spec GPT reads from a
// photo) + the element MATCH result → a canonical @spattoo/designer DESIGN config that CakePreview
// can render. This is the ONE place that speaks the analysis/match shapes; core stays generic and
// never learns "inspiration" exists.
//
// Scope: tier COUNT + ORDER (bottom→top), per-tier frosting COLOUR/TYPE, cake SHAPE, and cream
// PIPING rings (rim/board) reconstructed from matched Cream Piping library elements. Other
// decorations (toppers/flowers/sprinkles → stickers/scatter) are a deliberate follow-on.

// Designer enums we must emit valid values for (mirrors core: frostings.js FROSTING_ORDER).
const FROSTING_TYPES = ['buttercream', 'whipped', 'fondant'];

// Analysis frosting.type → a designer frosting type. ganache/naked have no designer equivalent yet,
// so they fall back to the closest opaque coating; anything unknown → buttercream (the default).
const FROSTING_TYPE_MAP = {
  buttercream: 'buttercream',
  whipped:     'whipped',
  fondant:     'fondant',
  ganache:     'fondant',      // smooth glossy coating — fondant is the nearest smooth wall
  naked:       'buttercream',
};

// Cake-level shape → per-tier designer shape. The designer supports round + rect (rectangular/sheet);
// square maps to rect, everything else (round/heart/number/sculpted/other) renders as round for now.
function shapeToTierShape(shape) {
  return shape === 'square' ? 'rect' : 'round';
}

// A usable hex colour, else null.
function hex(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim() : null;
}

// Bottom→top sort key. design.tiers[0] is the bottom tier, so we order by cake position first
// (bottom < middle < top, single = bottom), breaking ties by the analysis index.
const POSITION_RANK = { bottom: 0, single: 0, middle: 1, top: 2 };
function tierSortKey(t, i) {
  const rank = POSITION_RANK[t.position] ?? 1;   // unknown position sits with the middles
  return rank * 1000 + (Number.isFinite(t.index) ? t.index : i);
}

// The chosen candidate for a match: the swap override if set, else the best match. Mirrors the
// coverage logic in BuildFromInspiration so the preview reflects exactly what the user picked.
function chosenElement(m, i, j, overrides) {
  const cands = [m.match, ...(m.alternatives || [])].filter(Boolean);
  const key = `${i}:${j}`;
  const id = overrides?.[key] !== undefined ? overrides[key] : (m.match?.id ?? '');
  return id ? cands.find(c => c.id === id) ?? null : null;
}

// A matched element is renderable as piping when it carries a GLB + config and lives on a piping
// zone (rim/board). Config-driven — no branch on element-type name or decoration type.
function pipingZones(el) {
  const zones = Array.isArray(el?.allowed_zones) ? el.allowed_zones : [];
  return zones.filter(z => z === 'rim' || z === 'board');
}
function isPipingElement(el) {
  return !!(el && el.image_url && el.placement_config && pipingZones(el).length > 0);
}

// Which rim a piping ring sits on: the decoration's rim_side, clamped to what the element allows.
function pipingIsTop(decoration, el) {
  const zones = pipingZones(el);
  const canTop = zones.includes('rim');
  const canBottom = zones.includes('board');
  let isTop = decoration?.rim_side === 'bottom' ? false : true;   // default to top rim
  if (isTop && !canTop && canBottom) isTop = false;               // element only goes on the board
  if (!isTop && !canBottom && canTop) isTop = true;               // element only goes on the rim
  return isTop;
}

export function inspirationToDesign(analysis, matchResult = null, overrides = {}) {
  if (!analysis || !Array.isArray(analysis.tiers) || analysis.tiers.length === 0) return null;

  const tierShape = shapeToTierShape(analysis.cake?.shape);
  // Photo-wide fallback colour so a tier with no read colour still renders sensibly.
  const paletteFallback = hex(analysis.palette?.[0]?.hex) ?? '#ffffff';

  const ordered = analysis.tiers
    .map((t, i) => ({ t, i }))
    .sort((a, b) => tierSortKey(a.t, a.i) - tierSortKey(b.t, b.i));

  // Build the design tiers (bottom→top) and a map from the ORIGINAL analysis index → its design
  // tier, so matched piping (keyed by analysis-tier order) lands on the right reordered tier.
  const byAnalysisIndex = new Map();
  const tiers = ordered.map(({ t, i }) => {
    const f = t.frosting ?? {};
    const type = FROSTING_TYPE_MAP[f.type] ?? 'buttercream';
    const tier = {
      color:         hex(f.base_color_hex) ?? paletteFallback,
      frostingType:  FROSTING_TYPES.includes(type) ? type : 'buttercream',
      frostingStyle: 'smooth',   // finish (matte/satin/glossy) is a material/gloss nuance, not a wall
                                 // texture — left for a later phase; smooth is always valid.
      ...(tierShape === 'rect' ? { shape: 'rect' } : null),
      topPipings: [],
      bottomPipings: [],
    };
    byAnalysisIndex.set(i, tier);
    return tier;
  });

  // Attach cream piping from matched library elements. matchResult.tiers[i] aligns with
  // analysis.tiers[i] by array order; we route each ring to the design tier via byAnalysisIndex.
  (matchResult?.tiers || []).forEach((mt, i) => {
    const tier = byAnalysisIndex.get(i);
    if (!tier) return;
    (mt.matches || []).forEach((m, j) => {
      const el = chosenElement(m, i, j, overrides);
      if (!isPipingElement(el)) return;
      const isTop = pipingIsTop(m.decoration, el);
      const layer = makePipingLayer(el, {
        isTop,
        glbUrl: el.image_url,
        altGlbUrl: el.placement_config?.[isTop ? 'top_alt_glb_url' : 'bottom_alt_glb_url'] ?? null,
        color: hex(m.decoration?.color_hex) ?? el.default_color ?? undefined,
      });
      (isTop ? tier.topPipings : tier.bottomPipings).push(layer);
    });
  });

  return { tiers, texts: [], ages: [], stickers: [], writing: null, piping: [] };
}
