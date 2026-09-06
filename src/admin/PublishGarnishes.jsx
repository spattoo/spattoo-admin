import { useEffect, useState } from 'react';
import { fetchAllGarnishes, publishGarnish, fetchAdminElementTypes, fetchAdminElementCategories } from '../lib/api.js';

// ── Publishing a baker's chocolate piece to the global catalogue ─────────────────────────────────
//
// ⚠️ THIS IS THE WIDEST-REACHING ACTION IN THE ADMIN. Everything else here authors OUR content;
// this takes something a baker drew for their own cakes and puts it in front of every bakery on the
// platform and all of their customers. So the screen is built to make that weight visible rather
// than to make publishing quick — there is no bulk action, no select-all, and the confirmation names
// the audience rather than saying "are you sure?".
//
// ⚠️ AND IT IS SOMEBODY ELSE'S WORK. A baker drew these for themselves; nothing in the product asked
// them whether it could become catalogue furniture. Until that consent exists in the product, this
// screen says so, because an author clicking through a list of thumbnails will not otherwise think
// about it — the same reasoning that put an attestation on upload promotion.
//
// ⚠️ THE PUBLISHED COPY IS DETACHED. Withdrawing one is deactivating the ELEMENT, not deleting the
// baker's piece — see the publish route in spattoo-api. Said on screen so nobody expects an undo.

const ART_CATEGORY_HINT = 'Art';

export default function PublishGarnishes() {
  const [rows, setRows] = useState(null);
  const [types, setTypes] = useState([]);
  const [cats, setCats] = useState([]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [confirming, setConfirming] = useState(null);

  useEffect(() => {
    Promise.all([
      fetchAllGarnishes(),
      fetchAdminElementTypes().catch(() => []),
      fetchAdminElementCategories().catch(() => []),
    ])
      .then(([g, t, c]) => { setRows(g); setTypes(t ?? []); setCats(c ?? []); })
      .catch(e => setErr(e.message));
  }, []);

  const chocolateType = types.find(t => /chocolate/i.test(t.name ?? '')) ?? types[0];
  const artCategory = cats.find(c => (c.name ?? '').includes(ART_CATEGORY_HINT)) ?? cats[0];

  async function publish(row) {
    setBusy(row.id); setErr(null);
    try {
      await publishGarnish(row.id, {
        element_type_id: chocolateType?.id,
        category_id: artCategory?.id ?? null,
        name: row.name,
      });
      setRows(rs => rs.map(r => (r.id === row.id ? { ...r, published: true } : r)));
      setConfirming(null);
    } catch (e) { setErr(e.message); } finally { setBusy(null); }
  }

  if (err && !rows) return <div style={S.wrap}><div style={S.error}>{err}</div></div>;
  if (!rows) return <div style={S.wrap}><div style={S.muted}>Loading…</div></div>;

  return (
    <div style={S.wrap}>
      <div style={S.title}>Publish chocolate garnishes</div>

      {/* Said once, at the top, where it is read before anything is clicked — not inside a dialog
          that appears after the decision has effectively been made. */}
      <div style={S.warning}>
        <strong>These are bakers&rsquo; own drawings.</strong> Publishing one puts it in the
        catalogue for <strong>every bakery</strong> and all of their customers. The published copy is
        detached, so withdrawing it later means deactivating the catalogue element — the baker&rsquo;s
        piece is untouched, and cakes already designed with the published one keep working.
      </div>

      {!chocolateType && (
        <div style={S.error}>
          No chocolate element type found, so nothing can be published yet. Create one under Element
          Types first.
        </div>
      )}
      {err && <div style={S.error}>{err}</div>}

      {!rows.length && <div style={S.muted}>No bakery has kept a chocolate piece yet.</div>}

      <div style={S.grid}>
        {rows.map(r => (
          <div key={r.id} style={S.card}>
            <div style={S.thumbBox}>
              {r.thumbUrl
                ? <img src={r.thumbUrl} alt={r.name} style={S.thumb} />
                : <span style={S.muted}>no thumbnail</span>}
            </div>
            <div style={S.name}>{r.name}</div>
            <div style={S.meta}>
              {(r.payload?.strokes?.length ?? 0)} stroke{(r.payload?.strokes?.length ?? 0) === 1 ? '' : 's'}
              {r.payload?.kind === 'cut' ? ' · cut' : ' · piped'}
            </div>

            {r.published ? (
              <div style={S.published}>In the catalogue</div>
            ) : confirming === r.id ? (
              <div style={S.confirm}>
                {/* ⚠️ NAMES THE AUDIENCE, not "are you sure?". A confirmation that does not say what
                    will happen is a speed bump, and speed bumps get learned. */}
                <div style={S.confirmText}>
                  Publish &ldquo;{r.name}&rdquo; to every bakery on the platform?
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={S.btnDanger} disabled={busy === r.id || !chocolateType}
                    onClick={() => publish(r)}>
                    {busy === r.id ? 'Publishing…' : 'Yes, publish it'}
                  </button>
                  <button style={S.btn} onClick={() => setConfirming(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button style={S.btn} disabled={!chocolateType}
                onClick={() => setConfirming(r.id)}>Publish…</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const S = {
  wrap: { padding: 24, maxWidth: 1100, margin: '0 auto', fontFamily: 'inherit' },
  title: { fontSize: 22, fontWeight: 800, marginBottom: 14 },
  warning: { padding: '12px 14px', borderRadius: 10, background: '#FFF6E6',
             border: '1px solid #F0DFBC', fontSize: 13, lineHeight: 1.55, marginBottom: 16 },
  error: { padding: '10px 12px', borderRadius: 9, background: '#FDECEC',
           border: '1px solid #F2CFCF', color: '#A33', fontSize: 13, marginBottom: 12 },
  muted: { fontSize: 13, color: '#888' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 14 },
  card: { border: '1px solid #E6E1D9', borderRadius: 12, padding: 12, display: 'flex',
          flexDirection: 'column', gap: 7 },
  thumbBox: { height: 120, borderRadius: 9, background: '#F7F4EF', display: 'grid',
              placeItems: 'center', overflow: 'hidden' },
  thumb: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' },
  name: { fontSize: 13.5, fontWeight: 700 },
  meta: { fontSize: 11, color: '#999' },
  btn: { padding: '7px 12px', borderRadius: 8, border: '1.5px solid #DDD7CD', background: '#fff',
         fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' },
  btnDanger: { padding: '7px 12px', borderRadius: 8, border: '1.5px solid #C98A8A',
               background: '#fff', color: '#A33', fontFamily: 'inherit', fontSize: 12.5,
               fontWeight: 700, cursor: 'pointer' },
  confirm: { display: 'flex', flexDirection: 'column', gap: 8 },
  confirmText: { fontSize: 12, lineHeight: 1.45, color: '#7a4a00' },
  published: { fontSize: 12, fontWeight: 700, color: '#2b7a4b' },
};
