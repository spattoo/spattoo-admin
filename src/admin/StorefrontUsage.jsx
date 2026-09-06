import { useState, useEffect, useCallback } from 'react';
import { getStorefrontUsage } from '../lib/api.js';

// Storefront usage — "is this baker's shop being visited, or is nobody finding it?"
//
// ⚠️ THE DORMANT BAKERS ARE THE CONTENT. It is tempting to build this as a leaderboard, because
// that is what an analytics screen usually looks like — busiest first, the quiet tail below the
// fold. That would bury the only rows anyone opens this page to find. So the default order is
// QUIETEST FIRST, never-visited above merely-dormant, and the headline is a count of shops nobody
// visited rather than a total of visits.
//
// The numbers come from our own storefront_views table, not Google Analytics — see
// spattoo-docs/features/storefront-usage.md for why. Practically it means these counts are exact:
// no ad-blocker undercount, no sampling, and a zero genuinely means zero.

const WINDOWS = [7, 30, 90];

const C = {
  ink: '#2C4433',
  muted: '#5C7565',
  faint: '#9BB5A2',
  line: '#C5D4C8',
  page: '#EDEAE2',
  alarmInk: '#991B1B',
  alarmBg: '#FEE2E2',
  warnInk: '#92400E',
  warnBg: '#FEF3C7',
  okInk: '#065F46',
  okBg: '#D1FAE5',
};

function Badge({ ink, bg, children }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
      background: bg, color: ink, whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

// How long since the last visit, in the words someone would actually use.
function sinceLabel(lastSeen) {
  if (!lastSeen) return 'Never';
  const days = Math.round((Date.now() - new Date(`${lastSeen}T00:00:00Z`).getTime()) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 31) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months === 1 ? 'A month ago' : `${months} months ago`;
}

export default function StorefrontUsage() {
  const [days, setDays] = useState(30);
  const [busiestFirst, setBusiestFirst] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (window) => {
    setLoading(true);
    setError('');
    try {
      setData(await getStorefrontUsage(window));
    } catch (e) {
      setError(e.message || 'Could not load storefront usage.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(days); }, [days, load]);

  const rows = [...(data?.rows ?? [])].sort((a, b) => {
    // Drafts last either way: an unpublished storefront 404s to the world, so it having no visits
    // is correct behaviour rather than something to act on.
    if (a.storefront_published !== b.storefront_published) return a.storefront_published ? -1 : 1;
    if (busiestFirst) return b.views - a.views;
    if (a.views !== b.views) return a.views - b.views;
    // Same number of visits (usually zero): never-seen is the more urgent of the two.
    if (!a.last_seen && b.last_seen) return -1;
    if (a.last_seen && !b.last_seen) return 1;
    return (a.last_seen ?? '').localeCompare(b.last_seen ?? '');
  });

  const s = data?.summary;

  return (
    <div style={{ minHeight: '100vh', background: C.page, fontFamily: "'Quicksand', sans-serif", padding: '28px 20px 60px' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>

        <h1 style={{ fontSize: 22, fontWeight: 800, color: C.ink, margin: '0 0 4px' }}>Storefront Usage</h1>
        <p style={{ fontSize: 13, color: C.muted, margin: '0 0 20px', lineHeight: 1.5 }}>
          How many people opened each baker&rsquo;s shop. Counted by us, not by Google &mdash; so a zero
          here is a real zero, not an ad blocker.
        </p>

        {/* The control sits directly above what it changes (INVARIANTS #11). */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: C.faint, letterSpacing: 1, textTransform: 'uppercase' }}>
            Last
          </span>
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setDays(w)}
              aria-pressed={days === w}
              style={{
                padding: '7px 14px', borderRadius: 20, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                fontFamily: "'Quicksand', sans-serif", minHeight: 36,
                border: `1.5px solid ${days === w ? C.ink : C.line}`,
                background: days === w ? C.ink : '#fff',
                color: days === w ? '#fff' : C.muted,
              }}
            >
              {w} days
            </button>
          ))}
          <button
            onClick={() => setBusiestFirst((v) => !v)}
            aria-pressed={busiestFirst}
            style={{
              marginLeft: 'auto', padding: '7px 14px', borderRadius: 20, fontSize: 12, fontWeight: 700,
              cursor: 'pointer', fontFamily: "'Quicksand', sans-serif", minHeight: 36,
              border: `1.5px solid ${C.line}`, background: '#fff', color: C.muted,
            }}
          >
            {busiestFirst ? 'Busiest first' : 'Quietest first'}
          </button>
        </div>

        {/* The headline answers the question the page exists for, before any table is read. */}
        {s && !loading && (
          <div style={{
            background: s.dormant ? C.alarmBg : C.okBg,
            color: s.dormant ? C.alarmInk : C.okInk,
            borderRadius: 12, padding: '14px 18px', marginBottom: 18,
            fontSize: 14, fontWeight: 700, lineHeight: 1.5,
          }}>
            {s.dormant === 0
              ? `Every published storefront (${s.published}) had at least one visit in the last ${data.days} days.`
              : `${s.dormant} of ${s.published} published storefronts had no visits in the last ${data.days} days.`}
            {s.never_seen > 0 && (
              <span style={{ display: 'block', fontWeight: 600, marginTop: 4 }}>
                {s.never_seen} {s.never_seen === 1 ? 'has' : 'have'} never been visited at all.
              </span>
            )}
          </div>
        )}

        {loading && <p style={{ fontSize: 13, color: C.muted }}>Loading&hellip;</p>}

        {error && (
          <div style={{ background: C.alarmBg, color: C.alarmInk, borderRadius: 12, padding: '14px 18px', fontSize: 13, fontWeight: 600 }}>
            {error}
          </div>
        )}

        {/* Scrolls inside itself so the page never scrolls sideways on a phone. */}
        {!loading && !error && (
          <div style={{ background: '#fff', borderRadius: 14, border: `1px solid ${C.line}`, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
              <thead>
                <tr>
                  {['Baker', 'Visits', 'Days with visits', 'Last visit'].map((h, i) => (
                    <th key={h} style={{
                      textAlign: i === 0 ? 'left' : 'right', padding: '12px 16px',
                      fontSize: 10, fontWeight: 700, color: C.faint, letterSpacing: 1,
                      textTransform: 'uppercase', borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap',
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const draft = !r.storefront_published;
                  const silent = !draft && r.views === 0;
                  return (
                    <tr key={r.baker_id} style={{ borderBottom: `1px solid ${C.page}`, opacity: draft ? 0.55 : 1 }}>
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          {r.name || r.slug}
                          {draft && <Badge ink={C.muted} bg={C.page}>Draft</Badge>}
                          {silent && !r.last_seen && <Badge ink={C.alarmInk} bg={C.alarmBg}>Never visited</Badge>}
                          {silent && r.last_seen && <Badge ink={C.warnInk} bg={C.warnBg}>Quiet</Badge>}
                        </div>
                        <div style={{ fontSize: 11, color: C.faint, marginTop: 2 }}>{r.slug}</div>
                      </td>
                      <td style={{ padding: '12px 16px', textAlign: 'right', fontSize: 15, fontWeight: 800, color: silent ? C.alarmInk : C.ink }}>
                        {r.views}
                      </td>
                      <td style={{ padding: '12px 16px', textAlign: 'right', fontSize: 13, color: C.muted }}>
                        {r.active_days}
                      </td>
                      <td style={{ padding: '12px 16px', textAlign: 'right', fontSize: 13, color: r.last_seen ? C.muted : C.alarmInk, whiteSpace: 'nowrap' }}>
                        {sinceLabel(r.last_seen)}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ padding: '24px 16px', textAlign: 'center', fontSize: 13, color: C.muted }}>
                      No active bakers yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* "Last visit" looks at ALL history, so it distinguishes "never" from "not lately" — the
            window only governs the two count columns. Saying so beats someone deducing it wrong. */}
        {!loading && !error && rows.length > 0 && (
          <p style={{ fontSize: 11, color: C.faint, margin: '12px 2px 0', lineHeight: 1.6 }}>
            Visits and days with visits cover the last {data.days} days. Last visit looks at all time,
            so &ldquo;Never&rdquo; means never. Link previews (WhatsApp, Facebook) and search crawlers
            are not counted as visits. Drafts are not published, so nobody can reach them.
          </p>
        )}
      </div>
    </div>
  );
}
