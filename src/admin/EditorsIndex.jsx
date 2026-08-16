import React from 'react';

// First letters of up to two significant words, e.g. "Photo Frame Studio" → "PF".
// Derived purely from the tool's own label — no per-tool content is authored here.
function initials(label) {
  const words = String(label).replace(/[^a-zA-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).map(w => w[0]).join('') || '?').toUpperCase();
}

// Tiles landing page for the Editors group. The flyout menu became hard to scan once
// the tool count grew, so clicking "Editors" lands here. `items` is passed straight
// from NAV_GROUPS (single source of truth) by the router — this file owns no list.
export default function EditorsIndex({ items = [] }) {
  return (
    <div style={{ minHeight: '100vh', background: '#EDEAE2', fontFamily: 'Quicksand, sans-serif' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '40px 24px 56px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: '#2C4433', margin: '0 0 4px' }}>Editors</h1>
        <p style={{ fontSize: 14, color: '#5C7565', margin: '0 0 28px' }}>
          {items.length} tools for authoring elements, finishes and calibration. Pick one to open.
        </p>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 14,
        }}>
          {items.map(it => (
            <a
              key={it.href}
              href={it.href}
              onMouseEnter={e => { e.currentTarget.style.borderColor = '#9BB5A2'; e.currentTarget.style.boxShadow = '0 6px 18px rgba(44,68,51,0.10)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#DCE6DE'; e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'none'; }}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                background: '#fff', border: '1.5px solid #DCE6DE', borderRadius: 14,
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
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
