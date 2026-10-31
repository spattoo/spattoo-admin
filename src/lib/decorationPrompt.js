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

/**
 * The frame — what goes in EVERY prompt whatever the baker answered.
 *
 * ⚠️ IT IS SERVER DATA NOW, not a constant here. Sandeep: *"its not only about the questions- there
 * could be few things that we always have to append in the prompt to narrow it. likes its for a
 * cake decoration, bakeability etc. and we dont rely on bakers answers alone."* Two questions
 * cannot carry what we know and a baker should never have to type — that this is sugarcraft someone
 * has to MAKE, that it must stand on a cake, that thin parts snap in fondant and blow the triangle
 * cap. See migration 152; each clause carries a `note` saying what it cost to learn.
 *
 * ⚠️ AND IT SPLITS BY PATH, which closes a contradiction this file shipped. The old constant
 * appended "untextured, no fur or hair, separate parts" to every prompt — including the ready-to-use
 * path, which asks Tripo for `texture: true, pbr: true`. We were paying for a textured model and
 * telling it not to texture. `applies_to` makes that unsayable.
 *
 * ⚠️ A LAST-RESORT FALLBACK, used only if the frame could not be fetched. Generating with NO frame
 * is worse than generating with a stale one — it is the bare noun that returned a baluster for
 * "flute" — so an empty server response must not silently mean "no frame".
 */
export const FALLBACK_FRAME = [
  { key: 'kind',       phrase: 'a hand-modelled sugarcraft cake decoration', applies_to: 'always',       position: 'lead' },
  { key: 'scale',      phrase: 'sized to sit on top of a cake',              applies_to: 'always',       position: 'tail' },
  { key: 'bakeable',   phrase: 'simplified rounded forms with soft edges, no thin fragile parts', applies_to: 'always', position: 'tail' },
  { key: 'standable',  phrase: 'a single solid closed shape with a flat base', applies_to: 'always',     position: 'tail' },
  { key: 'no_texture', phrase: 'untextured, plain matte surface',            applies_to: 'recolourable', position: 'tail' },
  { key: 'no_fur',     phrase: 'no fur, hair or feathers',                   applies_to: 'recolourable', position: 'tail' },
  { key: 'parts',      phrase: 'separate parts for each coloured area',      applies_to: 'recolourable', position: 'tail' },
];

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
export function buildDecorationPrompt({ subject, questions = [], answers = {}, parts = [],
                                        frame = null, output = 'recolourable' } = {}) {
  const trimmed = String(subject ?? '').trim();
  if (!trimmed) return '';

  /* `output` picks which half of the frame applies. 'recolourable' is the default because it is the
     stricter one: a prompt that wrongly says "untextured" wastes a generation, while one that
     wrongly omits it produces a model that merely cannot be recoloured. */
  const rows  = (frame?.length ? frame : FALLBACK_FRAME)
    .filter(f => f.applies_to === 'always' || f.applies_to === output);
  const lead  = rows.filter(f => f.position === 'lead').map(f => f.phrase).filter(Boolean);
  const tail  = rows.filter(f => f.position !== 'lead').map(f => f.phrase).filter(Boolean);

  /* ⚠️ A QUESTION IS EITHER CHIPS OR A BOX, AND THE ANSWER SHAPE FOLLOWS. For 'choice' the answer
     is an option key and the phrase is authored; for 'text' the answer IS the phrase, because the
     baker wrote it. That second kind is what makes this work for anything at all — Sandeep: *"if
     they type bat- how do you know which bat is it? there are many sports use bat."* We do not.
     Their own words settle it: "cricket bat, worn willow with a taped handle". */
  const phrases = [];
  for (const q of questions) {
    if (q.kind === 'text') {
      const typed = String(answers[q.key] ?? '').trim();
      if (typed) phrases.push(typed);
      continue;
    }
    const chosen = pickOption(q, answers[q.key]);
    // An empty phrase is legitimate — it is what a "No preference" option stores — and must not
    // become the string "undefined" or drop the separator it sits between.
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

  return [...lead, trimmed, ...phrases, partClause, ...tail]
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
    // A text box has no default. Pre-filling one would put words in the baker's mouth and then
    // charge them for it — the placeholder shows the example instead, and stays unsent.
    if (q.kind === 'text') continue;
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

/**
 * Warnings for everything the baker typed. Never blocking — a warning that refuses is a rule in
 * disguise, and the baker may have a reason we do not know.
 *
 * ⚠️ IT READS THE FREE-TEXT ANSWERS TOO, NOT JUST THE SUBJECT. This checked `subject` alone, and
 * the subject is the one place these words do NOT appear: nobody types "fluffy lion" as the
 * subject, they type "lion" and then "sitting, with a big fluffy mane" in the look box. So the
 * warning fired on the half nobody uses, and the prompt went out asking for a fluffy mane while the
 * frame appended "no fur or hair" — a contradiction we paid for and the baker was never told about.
 */
export function promptWarnings({ subject, questions = [], answers = {} } = {}) {
  const typed = [String(subject ?? '')];
  for (const q of questions) {
    if (q.kind === 'text') typed.push(String(answers[q.key] ?? ''));
  }
  const text = typed.join(' ');
  if (!text.trim()) return [];
  return COSTLY.filter(c => c.re.test(text)).map(c => c.say);
}
