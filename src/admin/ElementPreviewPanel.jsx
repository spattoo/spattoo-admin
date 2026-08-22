import { useEffect, useState } from 'react';
import { ElementPreview } from '@spattoo/designer';
import { fetchElementForPreview } from '../lib/api.js';
import { zoneValueModes } from '../lib/placementSeat.js';

/* ── The saved element, on a cake, as a baker will see it ────────────────────────────────────────
 *
 * Phase 1 of spattoo-docs/plans/element-preview-and-publish.md.
 *
 * ── WHY IT PREVIEWS THE SAVED ROW, NOT THE FORM ─────────────────────────────────────────────────
 * The editor's fields become `placement_config` inside the SAVE handler — zones, modes, seats,
 * inserts, full-ring, all assembled there. Previewing unsaved form state would mean assembling it a
 * second time, here, and the two would diverge the first time either changed. So this fetches what
 * was actually stored, and says plainly that a save is what refreshes it. Slightly less convenient,
 * and it cannot lie to you.
 *
 * ── WHY A SEPARATE ENDPOINT ─────────────────────────────────────────────────────────────────────
 * `/admin/elements/:id` returns placement_config with RAW R2 keys, on purpose, because this form has
 * to write them back. The renderer needs public URLs — a photo frame previewed from the raw shape
 * comes out with no mask, silently, and only for that one element type. `/preview` is the same row
 * shaped the way the designer receives it.
 *
 * The rendering itself is ElementPreview from @spattoo/designer, which places the element with the
 * designer's own `addSticker` and draws it with the designer's own scene. Nothing here knows how a
 * decoration is seated, and nothing here should.
 */
export default function ElementPreviewPanel({ elementId, savedAt }) {
  const [el, setEl]       = useState(null);
  const [err, setErr]     = useState(null);
  const [zone, setZone]   = useState(null);
  const [pose, setPose]   = useState(null);
  const [tiers, setTiers] = useState(1);
  const [tierIndex, setTierIndex] = useState(0);

  // Re-fetches when the id changes OR when the parent reports a save (`savedAt`), which is what
  // makes "save, then look" a loop rather than a page reload.
  useEffect(() => {
    let cancelled = false;
    if (!elementId) { setEl(null); return undefined; }
    setErr(null);
    fetchElementForPreview(elementId)
      .then(row => { if (!cancelled) { setEl(row); setZone(null); setPose(null); setTierIndex(0); } })
      .catch(e => { if (!cancelled) setErr(e?.message ?? 'Could not load the element'); });
    return () => { cancelled = true; };
  }, [elementId, savedAt]);

  if (!elementId) return null;

  const zones = el?.allowed_zones ?? [];
  const shownZone = zone ?? zones[0] ?? null;
  // The poses THIS zone offers, default first. Switching zone drops the pose back to that zone's
  // default rather than carrying it: the poses of one surface are not the poses of another.
  const poses = shownZone ? zoneValueModes(el?.placement_config?.[shownZone]) : [];
  const shownPose = poses.includes(pose) ? pose : (poses[0] ?? null);

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <label style={s.label}>Preview</label>
        <span style={s.hint}>The saved element — save to refresh</span>
      </div>

      {err && <div style={s.err}>{err}</div>}

      {!err && (
        <>
          <div style={s.controls}>
            {/* An element that allows several zones has to be looked at in each: a placement rule
                that only works in the zone it was authored against is the bug this screen is for. */}
            {zones.length > 1 && (
              <div style={s.group}>
                <span style={s.groupLabel}>Zone</span>
                {zones.map(z => (
                  <button key={z} type="button" onClick={() => { setZone(z); setPose(null); }}
                          style={{ ...s.chip, ...(shownZone === z ? s.chipOn : {}) }}>{z}</button>
                ))}
              </div>
            )}
            {/* A zone offering two poses (`modes`) is a PROMISE to the customer that both look
                right, and the only way to know the second one does is to look at it. Shown only when
                there is a choice, so a single-pose element grows no control. */}
            {poses.length > 1 && (
              <div style={s.group}>
                <span style={s.groupLabel}>Pose</span>
                {poses.map(m => (
                  <button key={m} type="button" onClick={() => setPose(m)}
                          style={{ ...s.chip, ...(shownPose === m ? s.chipOn : {}) }}>{m}</button>
                ))}
              </div>
            )}
            {/* Tier radius comes from the tier's index, so a different size means a different cake —
                which is also the honest question: does this still work on a small top tier? */}
            <div style={s.group}>
              <span style={s.groupLabel}>Tiers</span>
              {[1, 2, 3].map(n => (
                <button key={n} type="button"
                        onClick={() => { setTiers(n); setTierIndex(Math.min(tierIndex, n - 1)); }}
                        style={{ ...s.chip, ...(tiers === n ? s.chipOn : {}) }}>{n}</button>
              ))}
              {tiers > 1 && <span style={s.groupLabel}>on</span>}
              {tiers > 1 && Array.from({ length: tiers }, (_, i) => (
                <button key={i} type="button" onClick={() => setTierIndex(i)}
                        style={{ ...s.chip, ...(tierIndex === i ? s.chipOn : {}) }}>{i}</button>
              ))}
            </div>
          </div>

          <div style={s.stage}>
            {el
              ? <ElementPreview element={el} zone={shownZone} mode={shownPose} tierCount={tiers} tierIndex={tierIndex} />
              : <div style={s.loading}>Loading…</div>}
          </div>

          {el && (
            <div style={s.foot}>
              {/* Read through the same helper the renderer uses. This used to look up
                  `placement_config.zones[zone].mode` — a path that does not exist in the schema
                  (zones are TOP-LEVEL keys) — so it printed "stand" for every element regardless of
                  what the element actually did. */}
              {shownZone ?? 'no zone'} · pose <b>{shownPose ?? poses[0] ?? 'stand'}</b>
              {poses.length > 1 && <> (of {poses.join(', ')})</>}
              {' '}· tier {tierIndex} of {tiers}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const s = {
  wrap:  { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 },
  head:  { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
  label: { fontSize: 12, fontWeight: 700, color: '#2C4433', letterSpacing: 0.3 },
  hint:  { fontSize: 11, color: '#8AA391', fontWeight: 600 },
  err:   { fontSize: 12, color: '#b3261e', fontWeight: 600 },
  controls: { display: 'flex', flexDirection: 'column', gap: 6 },
  group: { display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' },
  groupLabel: { fontSize: 10.5, fontWeight: 700, color: '#8AA391', textTransform: 'uppercase', letterSpacing: 0.5 },
  chip: {
    borderWidth: 1.5, borderStyle: 'solid', borderColor: '#C5D4C8',
    background: '#fff', color: '#6B8C74', borderRadius: 999, padding: '3px 10px',
    fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: "'Quicksand', sans-serif",
  },
  chipOn: { background: '#2C4433', borderColor: '#2C4433', color: '#fff' },
  stage: {
    width: '100%', height: 300, background: '#F7F5F0',
    borderWidth: 1.5, borderStyle: 'solid', borderColor: '#E3EAE4', borderRadius: 10, overflow: 'hidden',
  },
  loading: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 12, color: '#8AA391', fontWeight: 600 },
  foot: { fontSize: 11, color: '#6B8C74', fontWeight: 600 },
};
