import { useEffect } from 'react';

// ── A centred dialog over a scrim ────────────────────────────────────────────────────────────────
//
// Extracted the first time a fifth one was about to be written, not before. There were already four
// hand-rolled copies across ManagePlans, BakerSubscriptions, AddElement and RecomposeEditor, and
// they had ALREADY DRIFTED into two shapes with three z-indexes and two scrim colours:
//
//   centred dialog   rgba(0,0,0,0.4)      z 200 / z 300   flex-centred, click the scrim to close
//   full-bleed       rgba(20,30,24,0.45)  z 1000          scrollable overlay, close button pinned
//
// This is the CENTRED one, and deliberately only that. The full-bleed pair is a studio taking over
// the screen — a different thing that happens to be built from the same two divs, and folding them
// together would give one component two personalities and a `variant` prop to choose between them.
//
// ⚠️ ManagePlans and BakerSubscriptions still hold their own copies of THIS shape. They are the
// migration this component is for; they were left alone here because moving them is a change to two
// screens nobody asked about, not because the copies are fine.
//
// What the copies each got slightly differently, and what is settled here:
//   • Esc closes. Two of the four had no keyboard escape at all.
//   • The scrim closes; a click inside does not (stopPropagation on the panel).
//   • The body does not scroll behind an open dialog — a long form scrolling under a dialog is how
//     you lose your place in it.
export default function Modal({ title, onClose, children, width = 720 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 400,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 16, width, maxWidth: 'calc(100vw - 40px)',
          maxHeight: 'calc(100vh - 40px)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px',
          borderBottom: '1px solid #E3EDE6', flexShrink: 0,
        }}>
          <div style={{ flex: 1, fontSize: 15, fontWeight: 800, color: '#2C4433' }}>{title}</div>
          <button
            type="button" onClick={onClose} title="Close (Esc)"
            style={{
              border: 'none', background: '#F4F8F5', color: '#2C4433', borderRadius: 8,
              width: 30, height: 30, fontSize: 16, lineHeight: 1, cursor: 'pointer',
              fontFamily: "'Quicksand', sans-serif", fontWeight: 700,
            }}
          >×</button>
        </div>
        <div style={{ padding: 20, overflowY: 'auto' }}>{children}</div>
      </div>
    </div>
  );
}
