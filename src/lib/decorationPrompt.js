// ── Turning what a baker says into what a generator needs ────────────────────────────────────────
//
// Sandeep: *"Not every baker can prompt better, and it burns credits for them. we should be able to
// convert their vague input to a good prompt and save their credits and time. when they want to
// create a new model, lets ask few questions - like is it made of fondant etc."*
//
// ⚠️ EVERY CLAUSE HERE WAS PAID FOR, which is the only reason to encode them rather than let people
// type freely. Measured against Tripo on 2026-10-29:
//
//   • "with fur" — fur cannot exist without a texture, and we generate UNTEXTURED because a Spattoo
//     element only recolours when it carries no map. Asked for anyway, it becomes geometry, and
//     geometry is what put the first run at 501,326 triangles against a 25,000 cap.
//   • "simple rounded shapes" — the run that kept its parts AND hit budget had it.
//   • "sitting" / "standing" — gives the model a flat base. Without one it floats, and a decoration
//     that cannot sit on a cake is not a decoration.
//   • "cake topper" — sets the scale. Vendors otherwise return something sized like a statue.
//
// ⚠️ IT DOES NOT ASK FOR COLOURS, AND THAT IS DELIBERATE. The whole point of generating untextured
// parts is that the baker colours them afterwards, per part, in the designer. A colour in the
// prompt would be baked into geometry we then recolour anyway — paying for something we discard.
//
// ⚠️ A PURE FUNCTION, SO IT CAN MOVE. This lives in admin because that is where the studio is, but
// the baker-facing version will need the same sentence — and two copies of the vocabulary is the
// drift INVARIANTS #15 is about. When bakers get this, the function moves to core and admin imports
// it; nothing about its shape has to change.

/** What a decoration is made of. The word matters: vendors render "fondant" smoother than "clay". */
export const MATERIALS = [
  { key: 'fondant',     label: 'Fondant',      phrase: 'smooth fondant finish' },
  { key: 'buttercream', label: 'Buttercream',  phrase: 'piped buttercream texture' },
  { key: 'chocolate',   label: 'Chocolate',    phrase: 'moulded chocolate finish' },
  { key: 'sugar',       label: 'Sugar paste',  phrase: 'matte sugar paste finish' },
  { key: 'wafer',       label: 'Wafer paper',  phrase: 'thin wafer paper, flat layered shapes' },
];

/** How it sits on the cake. Each gives the model a base to stand on. */
export const POSES = [
  { key: 'sitting',  label: 'Sitting',       phrase: 'sitting upright with a flat base' },
  { key: 'standing', label: 'Standing',      phrase: 'standing upright with a flat base' },
  { key: 'lying',    label: 'Lying flat',    phrase: 'lying flat, low profile' },
  { key: 'none',     label: 'No preference', phrase: '' },
];

/** How much detail to ask for. More detail is more triangles, and triangles are the budget. */
export const DETAIL = [
  { key: 'simple',   label: 'Simple',   phrase: 'simple rounded shapes, few separate pieces' },
  { key: 'moderate', label: 'Moderate', phrase: 'clean shapes with a few distinct pieces' },
  { key: 'detailed', label: 'Detailed', phrase: 'detailed sculpted shapes' },
];

/**
 * Compose the prompt.
 *
 * `subject` is whatever the baker typed, however vague — "a bear", "bear with bow". Everything else
 * is a chip they picked. Returns a single sentence, or '' when there is no subject yet.
 */
export function buildDecorationPrompt({ subject, material = 'fondant', pose = 'sitting',
                                        detail = 'simple', parts = [] } = {}) {
  const trimmed = String(subject ?? '').trim();
  if (!trimmed) return '';

  const phrase = (list, key) => list.find(x => x.key === key)?.phrase ?? '';
  const bits = [
    trimmed,
    phrase(POSES, pose),
    phrase(MATERIALS, material),
    phrase(DETAIL, detail),
  ];

  /* ⚠️ NAMING THE PARTS IS NOT DECORATION, IT IS THE POINT. Tripo returns parts called
     `tripo_part_0…12` — carved correctly, named uselessly — so a human still has to say which is
     which. Asking for them by name up front is the one lever that might fix that, and it is free. */
  if (parts.length) bits.push(`separate ${parts.map(p => p.trim()).filter(Boolean).join(', ')}`);

  bits.push('cake topper');
  return bits.filter(Boolean).join(', ');
}

/**
 * Things a baker might ask for that cost credits and come back unusable. Returned as plain
 * sentences so the UI can warn BEFORE the spend rather than explain after it.
 */
export function promptWarnings({ subject, detail } = {}) {
  const t = String(subject ?? '').toLowerCase();
  const out = [];
  /* Fur, hair, grass and lace are all "many thin strands", which untextured means geometry. */
  if (/\b(fur|furry|hair|hairy|grass|lace|feathers?)\b/.test(t)) {
    out.push('Fur, hair and lace have to be modelled as geometry when there is no texture — that is '
           + 'what took one run to 501,326 triangles against a 25,000 cap. Say "smooth" instead.');
  }
  if (/\b(realistic|photorealistic|lifelike)\b/.test(t)) {
    out.push('Realistic subjects come back heavy and fiddly. Cake decorations read better stylised.');
  }
  if (/\b(thin|wire|string|whisker|antenna)\b/.test(t)) {
    out.push('Very thin parts tend to arrive broken or fused to whatever they touch.');
  }
  if (detail === 'detailed') {
    out.push('Detailed costs triangles, and the budget is 25,000 for a decoration.');
  }
  return out;
}
