import { makePipingLayer, TOPPER_FINISHES, DEFAULT_TOPPER_FINISH } from '@spattoo/designer';

// inspirationToDesign — pure mapper: an inspiration ANALYSIS (the tier-wise spec GPT reads from a
// photo) + the element MATCH result → a canonical @spattoo/designer DESIGN config that CakePreview
// can render. This is the ONE place that speaks the analysis/match shapes; core stays generic and
// never learns "inspiration" exists.
//
// Scope: tier COUNT + ORDER (bottom→top), per-tier frosting COLOUR/TYPE, cake SHAPE, cream PIPING
// rings (rim/board) reconstructed from matched Cream Piping library elements, and LETTERING carried
// through as a message. Other decorations (toppers/flowers/sprinkles → stickers/scatter) are a
// deliberate follow-on.
//
// ── ⚠️ WHY LETTERING IS NOT MATCHED AGAINST THE ELEMENT LIBRARY ─────────────────────────────────
// `inspirationMaps.js` lists it in NON_MATCHED_TYPES, and that is right: "Happy Birthday Aarav" is
// not an element anybody stocks. It is a MESSAGE, and the designer already has one — a writing,
// whose text is a string on the design.
//
// That distinction is the whole point of this feature. The industry flow is that a customer sends a
// photo of somebody else's cake and asks for the same thing with a different name on it. Read the
// name into a writing and it becomes DATA: the baker retypes it, the cake re-renders in 3D, and
// nothing is generated, retouched or copied. Read it as pixels and you are editing a photograph of a
// cake that has never been baked — see plans/new-feature-ideas.md, where that route was parked.
//
// The vision pass has always returned the exact text (`"text": "<for lettering, the exact text>"`);
// this mapper used to end `writings: null` and drop it on the floor.

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

// Analysis placement → the designer's writing surface. The analysis names five places, a writing
// has three. `middle_tier` and `rim` are both read from the front as text on a WALL, so they land on
// the side; the designer resolves which tier from the message's height, not from a stored tier.
const WRITING_SURFACE = {
  top_surface: 'top',
  board:       'board',
  side:        'side',
  middle_tier: 'side',
  rim:         'side',
};

// An acrylic topper's colour is a FINISH KEY, not a hex — `acrylicFinish` indexes TOPPER_FINISHES.
// So a read colour has to be resolved to the nearest stocked finish rather than passed through.
function nearestFinish(hexColor) {
  const rgb = hex(hexColor);
  if (!rgb) return DEFAULT_TOPPER_FINISH;
  const to = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [r, g, b] = to(rgb);
  let best = DEFAULT_TOPPER_FINISH, bestD = Infinity;
  for (const [key, f] of Object.entries(TOPPER_FINISHES)) {
    const [fr, fg, fb] = to(f.color);
    // Luma-weighted, so a warm gold separates from a neutral silver at equal brightness.
    const d = 0.30 * (r - fr) ** 2 + 0.59 * (g - fg) ** 2 + 0.11 * (b - fb) ** 2;
    if (d < bestD) { bestD = d; best = key; }
  }
  return best;
}

/* Every lettering the photo carried, as designer messages.
 *
 * ⚠️ ONE PER SURFACE, because a writing IS its surface — the design model's own note says the list
 * exists so a message can belong to a placement. Two letterings read on the same wall would be two
 * messages fighting for one spot, so the first wins and the rest are dropped.
 *
 * ⚠️ AND POSITION IS DELIBERATELY LEFT AT THE DEFAULT. The analysis gives a bbox in PHOTO space; a
 * writing wants an angle round the cake and a height up the wall, and there is no honest conversion
 * without knowing the camera. Guessing would put the message somewhere confidently wrong, which is
 * worse than the default — the baker drags it once. What this feature is FOR is that the text is
 * data, not that the placement is solved. */
function lettering(analysis) {
  const out = [];
  const taken = new Set();
  for (const tier of analysis.tiers ?? []) {
    for (const d of tier.decorations ?? []) {
      if (d?.type !== 'lettering') continue;
      const text = typeof d.text === 'string' ? d.text.trim() : '';
      if (!text) continue;                       // lettering the model could not read
      const surface = WRITING_SURFACE[d.placement] ?? 'top';
      if (taken.has(surface)) continue;
      taken.add(surface);
      const acrylic = d.material === 'acrylic';
      out.push({
        style: acrylic ? 'acrylic' : 'cream',
        text,
        surface,
        // Cream takes the read colour directly; acrylic takes a finish key and ignores `color`.
        ...(acrylic ? { acrylicFinish: nearestFinish(d.color_hex) }
                    : { color: hex(d.color_hex) ?? '#ffffff' }),
      });
    }
  }
  return out;
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

  /* ⚠️ `writings`, PLURAL — the design model's key. This line used to say `writing: null`, which is
   * not a key anything reads: it neither carried a message nor cleared one, it was simply ignored.
   * The defaults for a message (font, fit, softness, curve…) are seeded by the designer when one is
   * created, so only the fields the photo actually told us are set here. */
  return { tiers, texts: [], ages: [], stickers: [], writings: lettering(analysis), piping: [] };
}
