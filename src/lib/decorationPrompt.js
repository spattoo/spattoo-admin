// ── Turning what a baker says into what a generator needs ────────────────────────────────────────
//
// Sandeep: *"Not every baker can prompt better, and it burns credits for them. we should be able to
// convert their vague input to a good prompt and save their credits and time."* And then, on what
// to ask: *"if a baker asks for a lion, it might give a real lion 3d. but baker usually wants is a
// fondant lion, and that too in seating position. we cant directly send that as prompt - but the
// questions we ask are based on what element baker asks - for flowers it could be different."*
//
// ── THE QUESTIONS ARE DATA, AND THEY LIVE IN THE DATABASE ───────────────────────────────────────
// `decoration_prompt_questions` / `decoration_prompt_options` (migration 149), keyed by
// `element_categories` — the identity axis the catalogue has had since 073. A flower is never
// "sitting"; it is a bud or open, one bloom or a spray. So the question SET comes from the server
// and this file never names a category, a material or a pose.
//
// ⚠️ THIS FILE USED TO HOLD ITS OWN MATERIAL LIST, AND IT WAS WRONG. Five hardcoded entries that
// invented `sugar` and `buttercream` (neither is a key), wrote `wafer` where the key is
// `wafer_paper`, missed marzipan, isomalt, modelling chocolate and royal icing — and offered
// "Buttercream", which maps to `cream`, which has `can_model = false`. An option put in front of
// staff that cannot be modelled at all. Migration 101 made that vocabulary a table precisely to
// stop this, and said so: "admin can no longer hold its own copy". `check:medium-vocab` did not
// catch it because it reads backend files only. The list now arrives from the API, resolved there,
// so there is nothing here to drift. `check:prompt-vocab` guards the absence.
//
// ── WHAT IS STILL HARDCODED, AND WHY ────────────────────────────────────────────────────────────
// The FRAME below. Every clause in it was measured against Tripo on 2026-10-29 and is a fact about
// OUR pipeline, not a matter of taste an admin should tune:
//
//   • "untextured, no fur or hair" — fur cannot exist without a texture, and a Spattoo element only
//     recolours when it carries NO map. Asked for anyway it becomes geometry: one run came back at
//     501,326 triangles against a 25,000 decor cap.
//   • "cake topper" — sets the scale. Vendors otherwise return something sized like a statue.
//   • "separate parts" — what makes per-part recolouring possible at all, which is the entire
//     reason we generate rather than buy.
//
// ⚠️ AND IT NEVER ASKS FOR COLOUR. The point of untextured parts is that the baker colours them per
// part afterwards in the designer. A colour in the prompt is paid-for geometry we then discard.
//
// ⚠️ A PURE FUNCTION, SO IT CAN MOVE. This lives in admin because that is where the studio is, but
// the baker-facing version needs the same sentence — and two copies of the vocabulary is the drift
// INVARIANTS #15 is about. When bakers get this, the function moves to core and admin imports it;
// nothing about its shape has to change, because its inputs are already server data.

/** The non-negotiable frame. Measured, not authored — see the note above. */
export const PROMPT_FRAME = {
  lead:  'cake topper',
  tail:  'untextured, no fur or hair, separate parts for each coloured area',
};

/**
 * Compose the prompt.
 *
 * `subject`   — whatever the baker typed, however vague ("a lion", "lion with a bow").
 * `questions` — exactly what GET /api/decoration-prompt-questions returned for their category.
 * `answers`   — { [question.key]: option.key }. Missing keys fall back to the option marked
 *               `is_default`, so a baker who answers nothing still gets a sane prompt rather than
 *               a bare noun.
 *
 * Returns '' when there is no subject yet — there is nothing to say about nothing.
 */
export function buildDecorationPrompt({ subject, questions = [], answers = {}, parts = [] } = {}) {
  const trimmed = String(subject ?? '').trim();
  if (!trimmed) return '';

  const phrases = [];
  for (const q of questions) {
    const chosen = pickOption(q, answers[q.key]);
    // An empty phrase is legitimate — it is what "No preference" stores — and must not become the
    // string "undefined" or drop the separator it sits between.
    if (chosen?.phrase) phrases.push(chosen.phrase);
  }

  /* ⚠️ NAMED PARTS ARE A SEGMENTATION HINT, NOT DECORATION. Tripo's Smart Segmentation takes a
     `hint`, and a part it can name is a part the baker can recolour on its own — which is the whole
     reason to generate rather than buy. Free text rather than a question, because the useful names
     are whatever THIS subject happens to have ("mane", "bow", "wings") and no stored option list
     could hold them. */
  const named = (Array.isArray(parts) ? parts : [])
    .map(x => String(x).trim()).filter(Boolean);
  const partClause = named.length ? `distinct ${named.join(', ')}` : '';

  return [PROMPT_FRAME.lead, trimmed, ...phrases, partClause, PROMPT_FRAME.tail]
    .filter(Boolean)
    .join(', ');
}

/** The option a question is currently answered with: the explicit pick, else its default, else none. */
export function pickOption(question, answerKey) {
  const options = question?.options ?? [];
  return options.find(o => o.key === answerKey)
      ?? options.find(o => o.is_default)
      ?? null;
}

/** Every question answered with its default — the starting state of a fresh form. */
export function defaultAnswers(questions = []) {
  const out = {};
  for (const q of questions) {
    const d = (q.options ?? []).find(o => o.is_default);
    if (d) out[q.key] = d.key;
  }
  return out;
}

/**
 * What the baker typed that will cost them.
 *
 * ⚠️ THESE ARE THE WORDS THAT MADE A RUN UNUSABLE, not a style guide. Texture words are the
 * expensive ones: we generate untextured so parts stay recolourable, so a texture request is spent
 * entirely on geometry. Colour words are cheaper but still wasted — the baker recolours per part
 * afterwards, so a colour in the prompt is bought and thrown away.
 */
const COSTLY = [
  { re: /\b(fur|furry|hairy|hair|feather|feathers|fluffy)\b/i,
    say: 'Fur and feathers need a texture, and we generate untextured so each part stays recolourable. Asked for anyway it comes back as geometry — one run hit 501,326 triangles against a 25,000 cap.' },
  { re: /\b(red|blue|green|pink|yellow|purple|orange|golden|gold|silver|white|black|brown)\b/i,
    say: 'Colour is set per part in the designer afterwards, so a colour here is paid for and then replaced.' },
  { re: /\b(realistic|photoreal|photo-realistic|lifelike)\b/i,
    say: 'Realistic sends it towards a statue rather than a cake decoration. Use the Look question instead, where it is one word and not the whole brief.' },
];

/** Warnings for the subject line. Never blocking — a warning that refuses is a rule in disguise. */
export function promptWarnings({ subject } = {}) {
  const text = String(subject ?? '');
  if (!text.trim()) return [];
  return COSTLY.filter(c => c.re.test(text)).map(c => c.say);
}
