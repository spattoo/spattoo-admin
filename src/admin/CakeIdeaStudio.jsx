import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CakePreview, useCakeDesign, planFromSpec, validateSpec, arrangeOnSlot, placementSlots,
  tierShapeAt, tierShape, boardOf, BOTTOM_H,
} from '@spattoo/designer';
import { composeIdea, placeFromInstruction } from '../lib/api.js';

/* ── Cake Idea Studio — a written brief becomes a cake you can look at ───────────────────────────
 *
 * Sandeep: *"make them part of admin. i dont prefer running these mjs"* — the same note that put
 * every other POC behind a door rather than behind a URL somebody has to still have: *"if tomorrow
 * i want to visit it, i wont have this url."* The scripts (`compose-idea.mjs`, `eval-ideas.mjs`)
 * still exist for a tight loop and for batch runs; this is the door.
 *
 * ⚠️ IT IMPORTS THE PLANNER, IT DOES NOT CARRY A COPY. `planFromSpec` and the seat it calls are
 * exported from `@spattoo/designer`, so the cake this screen draws is seated by exactly the code
 * the baker app seats with — root CLAUDE.md: "THE STUDIO IMPORTS THE GEOMETRY, IT DOES NOT CARRY A
 * COPY OF IT". A second implementation of "where does this go" would look right here and disagree
 * with the designer the first time a baker moved anything.
 *
 * ⚠️ AND IT APPLIES THROUGH `addSticker`, NEVER BY WRITING `design.stickers`. A placed sticker
 * reads nine fields off `placement_config`, de-overlaps against coincident siblings, and resolves
 * a sheet's size against the tier it lands on. A screen that assembled the array itself would be a
 * second answer to "what is a placed sticker" — right here, wrong in the app.
 *
 * ⚠️ THE TWO ABSENCES ARE SHOWN APART, and that is the most useful thing on the page. `wanted` is
 * what the composer could not find in the catalogue at all — that commissions a new element.
 * `refused` is what it named and the cake would not take — that fixes a prompt or a row. A single
 * "missing" list would lose which of the two you are reading, and today the first one is worth
 * more than any cake this produces.
 */

/* One-instruction placements. The arrangement is the half a whole-cake composer was losing, so
   these exist to exercise it on its own — Sandeep: *"i want to first check if we build this
   capability"*. Each asks for a different arrangement on a different surface. */
const ASKS = [
  'add a coral on the board',
  'put a ring of shells around the bottom tier',
  'scatter some stars on the top',
  'add a peacock on the side',
  'a pair of butterflies on the top',
];

const BRIEFS = [
  'krishna theme cake for a 5 year old boy',
  'mermaid cake for an 8 year old girl',
  'cricket theme cake for a 10 year old boy',
  'diwali cake with diyas and rangoli',
  'farewell cake for a boss leaving the office',
  '25th wedding anniversary cake for my parents',
  'first birthday cake for a baby girl, pastel',
  'space and rocket cake for a 7 year old boy',
];

const C = {
  ink: '#2C4433', dim: '#5C7565', faint: '#9BB5A2', line: '#C5D4C8',
  warn: '#92400E', warnBg: '#FEF3C7', okBg: '#D1FAE5', okInk: '#065F46',
};

function Group({ title, items, tone, render }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: tone, marginBottom: 6,
                    letterSpacing: '0.08em', textTransform: 'uppercase' }}>
        {title} ({items.length})
      </div>
      {items.length
        ? <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: C.dim }}>
            {items.map((it, i) => <li key={i}>{render(it)}</li>)}
          </ul>
        : <div style={{ fontSize: 13, color: C.faint }}>none</div>}
    </div>
  );
}

/* The seat's world, assembled exactly as the placement chooser assembles it. `baseShape` is the
   RAW bottom tier — not `shapeAt(0)` — because the board clamp was always handed the tier without
   tierRadius's override, and collapsing the two moves every board seat. Shared by both doors so a
   piece lands in the same place whether a whole cake planned it or one sentence asked for it. */
function seatCtxOn(a) {
  const tiers = a.canvasConfig?.tiers ?? a.design.tiers;
  return (_tierIndex, el) => ({
    pc: el?.placement_config ?? {},
    tierHeights: tiers.map(t => t?.height ?? BOTTOM_H),
    shapeAt: i => tierShapeAt(a.design.tiers, i),
    baseShape: tierShape(a.design.tiers[0] ?? {}),
    board: tiers[0] ? boardOf(tiers[0]) : null,
  });
}

export default function CakeIdeaStudio() {
  const api = useCakeDesign();
  const apiRef = useRef(api);
  apiRef.current = api;

  const [brief, setBrief] = useState(BRIEFS[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [res, setRes] = useState(null);     // { spec, elements, rejected, usage }
  const [plan, setPlan] = useState(null);
  const applied = useRef(null);

  const [ask, setAsk] = useState(ASKS[0]);
  const [placing, setPlacing] = useState(false);
  const [placed, setPlaced] = useState(null);   // { group, elements, rejected, reason }

  /* ⚠️ ONE SENTENCE, PLACED STRAIGHT — no spec, no plan, no whole cake. This is the arrangement
     under test on its own: the route says WHICH rows and HOW they sit together, `arrangeOnSlot`
     says where, and `addSticker` makes each one. If this looks right, the composer's job is only
     ever to choose well. */
  async function place() {
    setPlacing(true); setPlaced(null);
    try {
      const out = await placeFromInstruction(ask);
      if (!out.ok) { setPlaced({ reason: out.reason, rejected: out.rejected ?? [] }); return; }

      const a = apiRef.current;
      const ctxFor = seatCtxOn(a);
      const byId = new Map((out.elements ?? []).map(e => [e.id, e]));
      const first = byId.get(out.group.elementIds[0]);
      if (!first) { setPlaced({ reason: 'the route named a row it did not send' }); return; }

      /* The slot comes from the FIRST row, and every row in the group was already checked against
         the same zone by the route — so one slot serves the whole group, which is what makes it
         one arrangement rather than several overlapping ones. */
      const tierCount = (a.design.tiers ?? []).length || 1;
      const slot = placementSlots(first, tierCount).find(sl => sl.zone === out.group.zone);
      if (!slot) { setPlaced({ reason: `nothing on this cake offers ${out.group.zone}` }); return; }

      const laid = arrangeOnSlot(slot, {
        count: out.group.count, arrangement: out.group.arrangement,
      }, ctxFor(slot.tierIndex, first));

      /* ⚠️ CYCLE THE ROWS, DO NOT REPEAT THE FIRST. Four coral rows exist and two share a name
         character for character — which is how six copies of one coral happened. Walking the list
         is what turns that duplication into variety. */
      const ids = out.group.elementIds;
      const stamp = Date.now();
      laid.positions.forEach((pos, i) => {
        const el = byId.get(ids[i % ids.length]);
        if (el) a.addSticker(el, out.group.zone, slot.tierIndex, laid.mode, pos, { id: stamp + i });
      });
      setPlaced({ ...out, laid: laid.positions.length });
    } catch (e) {
      setPlaced({ reason: e?.message ?? 'place failed' });
    } finally {
      setPlacing(false);
    }
  }

  async function run() {
    setErr(null); setBusy(true); setRes(null); setPlan(null); applied.current = null;
    try {
      const out = await composeIdea(brief);
      if (!out.ok) { setErr(out.reason ?? 'the composer returned nothing'); return; }
      const check = validateSpec(out.spec);
      if (!check.ok) { setErr(`the spec did not validate: ${check.problems.join('; ')}`); return; }
      setRes(out);
    } catch (e) {
      setErr(e?.message ?? 'compose failed');
    } finally {
      setBusy(false);
    }
  }

  /* Build the cake once per result. Keyed on the object rather than a boolean so asking twice for
     the same brief still rebuilds — a second idea for one brief is the whole point of the thing. */
  useEffect(() => {
    if (!res || applied.current === res) return;
    applied.current = res;
    const a = apiRef.current;
    a.resetDesign();

    const seatCtxFor = seatCtxOn(a);

    const p = planFromSpec(res.spec, { elements: res.elements, seatCtxFor });
    p.tiers.forEach(t => { if (t.color) a.setTierColor(t.index, t.color); });

    /* ⚠️ ONE AT A TIME THROUGH THE REAL ADD PATH, AND EACH WITH ITS OWN ID. `addSticker` defaults
       to `extra.id ?? Date.now()`, so placements made in the same millisecond share an id — React
       warns about duplicate keys and two stickers become indistinguishable to every later update.
       It has never mattered because the only caller is a human tapping; it matters every time a
       cake is COMPOSED. Worked around here rather than changed in the hook: that is shared state
       and a wider change than this screen. */
    const byId = new Map(res.elements.map(e => [e.id, e]));
    p.placements.forEach((pl, i) => {
      const el = byId.get(pl.elementId);
      if (el) a.addSticker(el, pl.zone, pl.tierIndex, pl.placementMode, pl.position, { id: Date.now() + i });
    });

    if (p.message) {
      a.addWriting({
        text: p.message.text,
        style: p.message.look ?? 'cream',
        surface: p.message.surface ?? 'top',
        ...(p.message.color ? { color: p.message.color } : {}),
      });
    }
    if (p.age) a.addAge({ value: p.age.number });
    setPlan(p);
  }, [res]);

  const nameOf = useMemo(() => {
    const m = new Map((res?.elements ?? []).map(e => [e.id, e.name]));
    return id => m.get(id) ?? id;
  }, [res]);

  return (
    /* ⚠️ calc(100vh - 56px), matching every other studio: the admin shell's nav sits ABOVE this, so
       a plain 100% is 56px too tall and the whole page gains a scrollbar — the cake's board ends up
       below the fold and the panel's footer with it. Caught by opening it, not by a gate. */
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', color: C.ink }}>
      <div style={{ flex: 1, minWidth: 0, background: '#111', position: 'relative' }}>
        {/* ⚠️ NO CAMERA PROPS, DELIBERATELY. A composed cake is one to three tiers and nobody knows
            which until the model answers, so the framing has to adapt — and `CakePreview` already
            does it, aiming with `cakeAimTarget` (geometry/framing.js), the same rule the editor
            uses. `shapeView` is the shape PICKER's answer to a different question and overriding
            with it framed every cake as a tile. The file says so: "An explicit `target` still
            wins: the shape picker frames for a different question." */}
        <CakePreview design={api.design} autoRotate enableZoom />
        {busy && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
                        background: 'rgba(0,0,0,0.45)', color: '#EDEAE3', fontSize: 14 }}>
            composing…
          </div>
        )}
      </div>

      <aside style={{ width: 420, padding: 20, borderLeft: `1px solid ${C.line}`,
                      overflowY: 'auto', background: '#fff' }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 17 }}>Cake Idea Studio</h2>
        <p style={{ margin: '0 0 14px', fontSize: 12.5, color: C.dim, lineHeight: 1.5 }}>
          A written brief, composed from the catalogue and built with the designer&rsquo;s own
          placement rules. Every part is one we actually have.
        </p>

        <textarea value={brief} onChange={e => setBrief(e.target.value)} rows={2}
          placeholder="krishna theme cake for a 5 year old boy"
          style={{ width: '100%', boxSizing: 'border-box', padding: '9px 11px', fontSize: 13.5,
                   border: `1px solid ${C.line}`, borderRadius: 8, fontFamily: 'inherit',
                   resize: 'vertical' }} />

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0 12px' }}>
          {BRIEFS.map(b => (
            <button key={b} type="button" onClick={() => setBrief(b)}
              style={{ padding: '4px 9px', borderRadius: 12, cursor: 'pointer', fontSize: 11,
                       border: `1px solid ${brief === b ? C.ink : C.line}`,
                       background: brief === b ? C.ink : '#fff',
                       color: brief === b ? '#fff' : C.dim, fontFamily: 'inherit' }}>
              {b.split(' ').slice(0, 3).join(' ')}
            </button>
          ))}
        </div>

        <button type="button" onClick={run} disabled={busy || !brief.trim()}
          style={{ width: '100%', padding: '11px 0', borderRadius: 9, border: 'none',
                   background: busy ? C.faint : C.ink, color: '#fff', fontSize: 14,
                   fontWeight: 700, cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit' }}>
          {busy ? 'Composing…' : 'Compose an idea'}
        </button>

        {/* ── One instruction, placed ───────────────────────────────────────────────────────
            Above the composer deliberately: it is the narrower, more trustworthy door, and the
            one to reach for when the question is "did the arrangement work" rather than "is this
            a good cake". It ADDS to whatever is already on the cake, so asks can be stacked. */}
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${C.line}` }}>
          <h3 style={{ margin: '0 0 4px', fontSize: 13, letterSpacing: '0.06em',
                       textTransform: 'uppercase', color: C.dim }}>Place one thing</h3>
          <p style={{ margin: '0 0 9px', fontSize: 12.5, color: C.dim, lineHeight: 1.5 }}>
            Ask for a decoration and a surface. It adds to the cake that is already there, so you
            can stack a few.
          </p>

          <input value={ask} onChange={e => setAsk(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && ask.trim() && !placing) place(); }}
            placeholder="add a coral on the board"
            style={{ width: '100%', boxSizing: 'border-box', padding: '9px 11px', fontSize: 13.5,
                     border: `1px solid ${C.line}`, borderRadius: 8, fontFamily: 'inherit' }} />

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0 10px' }}>
            {ASKS.map(a => (
              <button key={a} type="button" onClick={() => setAsk(a)}
                style={{ padding: '4px 9px', borderRadius: 12, cursor: 'pointer', fontSize: 11,
                         border: `1px solid ${ask === a ? C.ink : C.line}`,
                         background: ask === a ? C.ink : '#fff',
                         color: ask === a ? '#fff' : C.dim, fontFamily: 'inherit' }}>
                {a.replace(/^(add|put|a) /, '').split(' ').slice(0, 3).join(' ')}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={place} disabled={placing || !ask.trim()}
              style={{ flex: 1, padding: '10px 0', borderRadius: 9, border: `1px solid ${C.ink}`,
                       background: placing ? C.faint : '#fff', color: placing ? '#fff' : C.ink,
                       fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit',
                       cursor: placing ? 'default' : 'pointer' }}>
              {placing ? 'Placing…' : 'Place it'}
            </button>
            <button type="button" onClick={() => { apiRef.current.resetDesign(); setPlaced(null); setPlan(null); }}
              style={{ padding: '10px 14px', borderRadius: 9, border: `1px solid ${C.line}`,
                       background: '#fff', color: C.dim, fontSize: 13, fontFamily: 'inherit',
                       cursor: 'pointer' }}>
              Clear cake
            </button>
          </div>

          {placed && (placed.group ? (
            <div style={{ marginTop: 11, padding: '9px 11px', background: C.okBg, color: C.okInk,
                          borderRadius: 7, fontSize: 12.5, lineHeight: 1.6 }}>
              <b>{placed.laid}</b> piece{placed.laid === 1 ? '' : 's'} in a <b>{placed.group.arrangement}</b>
              {' '}on the <b>{placed.group.zone.replace('_', ' ')}</b>, drawn from{' '}
              <b>{placed.group.elementIds.length}</b> row{placed.group.elementIds.length === 1 ? '' : 's'}:{' '}
              {(placed.elements ?? []).map(e => e.name).join(', ')}
              {placed.group.why ? <div style={{ marginTop: 4, fontStyle: 'italic' }}>{placed.group.why}</div> : null}
            </div>
          ) : (
            <div style={{ marginTop: 11, padding: '9px 11px', background: C.warnBg, color: C.warn,
                          borderRadius: 7, fontSize: 12.5, lineHeight: 1.6 }}>
              {placed.reason}
              {(placed.rejected ?? []).length
                ? <ul style={{ margin: '5px 0 0', paddingLeft: 16 }}>
                    {placed.rejected.map((r, i) => <li key={i}>{r.name ?? `index ${r.i}`} — {r.why}</li>)}
                  </ul>
                : null}
            </div>
          ))}
        </div>

        {err && (
          <pre style={{ marginTop: 14, padding: 10, background: C.warnBg, color: C.warn,
                        borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap' }}>{err}</pre>
        )}

        {plan && <div style={{ marginTop: 18 }}>
          {plan.why && (
            <p style={{ fontSize: 13, fontStyle: 'italic', color: C.dim, margin: '0 0 14px',
                        lineHeight: 1.5 }}>{plan.why}</p>
          )}

          <Group title="Placed" tone={C.okInk} items={plan.placements}
            render={p => <>{nameOf(p.elementId)} <span style={{ color: C.faint }}>
              — {p.zone}, {p.prominence}, ×{p.scale.toFixed(2)}</span></>} />

          <Group title="Wanted, not in the catalogue" tone={C.warn} items={plan.wanted}
            render={w => w} />

          <Group title="Asked for, could not be placed" tone={C.warn}
            items={[...(res?.rejected ?? []), ...plan.dropped]}
            render={d => <>{d.name ?? d.elementId ?? `index ${d.i}`} <span style={{ color: C.faint }}>
              — {d.why}</span></>} />

          <p style={{ fontSize: 11.5, color: C.faint, marginTop: 16 }}>
            {res?.pool} parts offered · {res?.usage?.prompt_tokens ?? '?'} in / {res?.usage?.completion_tokens ?? '?'} out
          </p>
        </div>}
      </aside>
    </div>
  );
}
