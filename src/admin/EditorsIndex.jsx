import React, { useMemo, useRef, useState } from 'react';

// Every word's first letter: "Photo Frame Studio" → "pfs". One definition, used twice — the tile
// badge shows the first two, and search matches against the whole thing.
function acronym(label) {
  return String(label).replace(/[^a-zA-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
    .map(w => w[0].toLowerCase()).join('');
}

// First letters of up to two significant words, e.g. "Photo Frame Studio" → "PF".
// Derived purely from the tool's own label — no per-tool content is authored here.
function initials(label) {
  return (acronym(label).slice(0, 2) || '?').toUpperCase();
}

// ── What counts as a match, and in what order ────────────────────────────────────────────────────
// Four ways in, because with this many tools the thing you remember varies: sometimes the name,
// sometimes only a word inside it, sometimes just the shape of the abbreviation.
//
//   0  the label starts with what you typed        "iso"   → Isomalt Studio
//   1  a WORD in the label starts with it          "drip"  → Chocolate Drip
//   2  the label contains it anywhere              "cream" → Second Cream Layer
//   3  the acronym starts with it                  "pf"    → Photo Frame Studio
//   4  the URL contains it                         "glb"   → GLB Studio, GLB Recompose
//
// The URL is in there because a label and its route do not always share words, and the route is
// what you have when you arrived from a bookmark or a link somebody sent you.
//
// Returning a RANK rather than a boolean is what makes Enter useful: the best match has to be
// first, or "type three letters and press Enter" opens the wrong studio. Lower is better;
// null is no match.
function rank(item, needle) {
  const label = item.label.toLowerCase();
  if (label.startsWith(needle)) return 0;
  const words = label.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.some(w => w.startsWith(needle))) return 1;
  if (label.includes(needle)) return 2;
  // Two letters minimum: one letter matches a third of the list and ranks them above real
  // substring hits, which makes Enter feel random.
  const compact = needle.replace(/\s+/g, '');
  if (compact.length >= 2 && acronym(item.label).startsWith(compact)) return 3;
  if (item.href.toLowerCase().includes(compact.replace(/-+/g, '-'))) return 4;
  return null;
}

// Tiles landing page for the Editors group. The flyout menu became hard to scan once
// the tool count grew, so clicking "Editors" lands here. `items` is passed straight
// from NAV_GROUPS (single source of truth) by the router — this file owns no list.
export default function EditorsIndex({ items = [] }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);

  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!needle) return items;
    // Stable within a rank, so equal matches keep the order the nav declares them in rather than
    // shuffling as you type.
    return items
      .map((it, i) => ({ it, r: rank(it, needle), i }))
      .filter(x => x.r !== null)
      .sort((a, b) => (a.r - b.r) || (a.i - b.i))
      .map(x => x.it);
  }, [items, needle]);

  // Enter opens the best match, so finding a studio is one line of typing rather than typing and
  // then reaching for the mouse. Escape clears rather than blurs — with the box focused on arrival,
  // blurring would leave a filter applied and no obvious way back to the full list.
  function onKeyDown(e) {
    if (e.key === 'Enter' && shown.length) { window.location.href = shown[0].href; return; }
    if (e.key === 'Escape') { setQ(''); e.stopPropagation(); }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#EDEAE2', fontFamily: 'Quicksand, sans-serif' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '40px 24px 56px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: '#2C4433', margin: '0 0 4px' }}>Editors</h1>
        <p style={{ fontSize: 14, color: '#5C7565', margin: '0 0 18px' }}>
          {needle
            ? `${shown.length} of ${items.length} ${items.length === 1 ? 'tool' : 'tools'} match “${q.trim()}”.`
            : `${items.length} tools for authoring elements, finishes and calibration. Pick one to open.`}
        </p>

        {/* Focused on arrival: this page exists to be searched, and the alternative is landing on a
            grid of thirty-odd tiles with the cursor nowhere.

            The lens sits INSIDE the field rather than beside it, so the box reads as a search box
            before it is read at all — the placeholder says so too, but only once you look. It is
            pointer-events:none, or clicking the icon would land on the icon instead of putting the
            cursor in the field, which is the one thing everybody tries. */}
        <div style={{ position: 'relative', width: '100%', maxWidth: 460, marginBottom: 22 }}>
          <svg
            aria-hidden focusable="false" width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="#6B8C74" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"
            style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}
          >
            <circle cx="10.5" cy="10.5" r="6.5" />
            <line x1="15.4" y1="15.4" x2="20.5" y2="20.5" />
          </svg>
          <input
            ref={inputRef}
            autoFocus
            type="search"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search editors — name, word or initials (press Enter to open)"
            aria-label="Search editors"
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '10px 14px 10px 38px',
              border: '1.5px solid #C5D4C8', borderRadius: 10,
              background: '#fff', color: '#2C4433',
              fontFamily: "'Quicksand', sans-serif", fontSize: 14, fontWeight: 600,
              outline: 'none',
            }}
          />
        </div>

        {shown.length === 0 ? (
          <div style={{ fontSize: 14, color: '#5C7565', fontWeight: 600, lineHeight: 1.5 }}>
            No editor matches “{q.trim()}”.{' '}
            <button
              type="button"
              onClick={() => { setQ(''); inputRef.current?.focus(); }}
              style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: '#2C4433', fontFamily: 'inherit', fontSize: 14, fontWeight: 800,
                textDecoration: 'underline',
              }}>
              Show all {items.length}
            </button>
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 14,
          }}>
            {shown.map((it, idx) => {
              // The one Enter would open, marked so the key is predictable rather than a guess.
              const first = !!needle && idx === 0;
              return (
                <a
                  key={it.href}
                  href={it.href}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = '#9BB5A2'; e.currentTarget.style.boxShadow = '0 6px 18px rgba(44,68,51,0.10)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = first ? '#9BB5A2' : '#DCE6DE'; e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'none'; }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    background: '#fff', border: '1.5px solid', borderColor: first ? '#9BB5A2' : '#DCE6DE',
                    borderRadius: 14,
                    padding: '16px', textDecoration: 'none', color: '#2C4433',
                    transition: 'border-color .15s, box-shadow .15s, transform .08s',
                  }}
                >
                  <div style={{
                    width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                    background: '#F4F8F5', border: '1.5px solid #DCE6DE',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 14, fontWeight: 800, color: '#6B8C74',
                  }}>
                    {initials(it.label)}
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.3 }}>{it.label}</span>
                  {first && (
                    <span style={{
                      marginLeft: 'auto', fontSize: 9, fontWeight: 800, color: '#6B8C74',
                      border: '1.5px solid #DCE6DE', borderRadius: 6, padding: '2px 5px',
                    }}>↵</span>
                  )}
                </a>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
