// Shared GLB cost-stat UI — the budget chips, the ingest review banner, and the per-metric cap rows.
// One source for these so AddElement, RecomposeEditor, GLB Studio and ManageElements stay in sync
// (ASSET_OPTIMIZATION_PLAN.md §3). All take the camelCase stats shape (see lib/glb.js measureForSave /
// statsFromElement). Cost is FLAGGED here, never blocked.
import { fmtSize, CAPS } from '../lib/glb.js';

const Dot = () => <span style={{ color: '#C5D4C8' }}>·</span>;

// Compact one-line cost summary: size · tris · decoded GPU mem · class. Used in lists and banners.
export function GlbStatChips({ stats, style }) {
  if (!stats) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 11, fontWeight: 700, color: '#3D5A44', ...style }}>
      <span>{fmtSize(stats.sizeKB)}</span><Dot />
      <span>{(stats.tris ?? 0).toLocaleString()} tris</span><Dot />
      <span>{fmtSize(stats.decodedMemKB)} GPU</span><Dot />
      <span>{CAPS[stats.assetClass]?.label ?? stats.assetClass ?? '—'}</span>
    </div>
  );
}

// Small amber/green "over budget (allowed)" / "within budget" pill — for list rows.
export function OverCapBadge({ stats, style }) {
  if (!stats) return null;
  const over = stats.overCap;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 5,
      background: over ? '#FFE3B0' : '#DDEEDF', color: over ? '#8a6d1a' : '#2E7D32', ...style }}>
      {over ? '⚠ over budget' : '✓ in budget'}
    </span>
  );
}

const reviewBtn = (d) => ({ width: '100%', padding: '10px 0', borderRadius: 8, border: 'none',
  background: d ? '#9BB5A2' : '#3D5A44', color: '#fff', fontFamily: "'Quicksand',sans-serif", fontSize: 13,
  fontWeight: 700, cursor: d ? 'not-allowed' : 'pointer' });

// The mandatory "pass this GLB through GLB Studio" banner shared by AddElement and RecomposeEditor.
// Pre-review: a prompt + the open button. Post-review: the budget verdict + chips, plus whatever the
// caller renders as `children` (e.g. RecomposeEditor's own Save button). `onReview` opens the Studio.
export function GlbReviewBanner({ reviewed, busy, disabled, onReview, title = 'Review the GLB before saving',
  promptText = 'See its real cost on phones and optimize if needed — required before saving.', children }) {
  const over = reviewed?.stats?.overCap;
  return (
    <div style={{ padding: '12px 14px', borderRadius: 10,
      border: `1.5px solid ${reviewed ? (over ? '#E0B341' : '#9BCBA5') : '#C5D4C8'}`,
      background: reviewed ? (over ? '#FFF6E5' : '#F0F8F1') : '#F4F8F5' }}>
      {!reviewed ? (
        <>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#2C4433', marginBottom: 6 }}>{title}</div>
          <div style={{ fontSize: 11.5, color: '#6B8C74', fontWeight: 600, marginBottom: 10 }}>{promptText}</div>
          <button style={reviewBtn(busy || disabled)} onClick={onReview} disabled={busy || disabled}>
            {busy ? 'Preparing…' : 'Review & optimize in GLB Studio →'}
          </button>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: over ? '#8a6d1a' : '#2E7D32' }}>
              {over ? '⚠ Over budget (allowed)' : '✓ Within budget'}
            </span>
            <button onClick={onReview} style={{ background: 'none', border: 'none', color: '#3D5A44', fontWeight: 700, fontSize: 11, cursor: 'pointer', padding: 0 }}>re-open studio</button>
          </div>
          <GlbStatChips stats={reviewed.stats} style={{ marginBottom: children ? 10 : 0 }} />
          {children}
        </>
      )}
    </div>
  );
}

// GLB Studio's per-metric rows (value / cap, red when over) + the verdict line. `capEval` is the
// output of evaluateCaps().
export function GlbBudgetRows({ capEval }) {
  if (!capEval) return <div style={{ fontSize: 11, color: '#9BB5A2', fontWeight: 600 }}>Measuring…</div>;
  const show = (r, v) => r.unit === 'KB' ? fmtSize(v) : r.unit === 'px' ? `${v}px` : (v ?? 0).toLocaleString();
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {capEval.rows.map(r => (
          <div key={r.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: r.over ? '#FFF0F0' : '#F4F8F5', borderRadius: 8, padding: '7px 10px' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433' }}>{r.label}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: r.over ? '#C0392B' : '#3D5A44' }}>
              {show(r, r.value)} <span style={{ color: '#9BB5A2', fontWeight: 600 }}>/ {show(r, r.cap)}{r.over ? ' ⚠' : ''}</span>
            </span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 11.5, fontWeight: 700,
        background: capEval.anyOver ? '#FFF6E5' : '#E8F5E9', color: capEval.anyOver ? '#8a6d1a' : '#2E7D32' }}>
        {capEval.anyOver
          ? `Over the ${capEval.capLabel} budget on phones. Optimize below, or keep it if this piece truly needs the detail — it's allowed, just flagged.`
          : `Within the ${capEval.capLabel} budget. Good to go.`}
      </div>
    </>
  );
}
