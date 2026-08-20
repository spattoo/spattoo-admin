import { useState, useEffect, useRef, Fragment } from 'react';
import { corsUrl } from '@spattoo/designer';
import { fetchAdminElementCategories, createElementCategory, updateElementCategory,
         uploadCategoryThumbnail, fetchAllElements } from '../lib/api.js';

// ── Element categories — the customer's decorations menu, in order ─────────────────────────────
//
// Categories can be CREATED from either element form, because that is where you notice one is
// missing. Everything else needs a screen of its own:
//
//   ORDER. sort_order is the order customers see, and a new category always lands at the end. Left
//   alone, the menu becomes a record of the sequence someone happened to add things in. This is the
//   only place it can be changed.
//
//   NAME. What the customer reads. It gets settled after you have seen the decorations in it —
//   "Party & Shapes" was a guess made before anyone looked at what fell into it.
//
//   RETIRE. Hides a category from customers while every element keeps its category_id, so switching
//   it back restores the memberships. There is no delete, deliberately: the FK is ON DELETE SET
//   NULL, so deleting would quietly strip the category off every element it held, with no way back.
//
//   PICTURE. What the customer sees above the name in the decorations menu, because people recognise
//   a lion faster than they read "Animals". Uploaded here — typically a collage of a few of the
//   category's decorations, which says what is inside better than any one of them can.
//
// The COUNT is why retiring is safe to offer. It answers "how many decorations would this strand?"
// at the moment you are deciding.
//
// ── Two kinds of picture, and the screen must not blur them ─────────────────────────────────────
// A category with no picture of its own BORROWS one: the menu falls back to the first decoration in
// it that has a thumbnail, so a category is never a blank square and nothing has to be made before a
// category can exist. That is why the tile below shows the borrowed image faded, with "borrowed"
// under it. Showing it the same as an uploaded one would leave the screen unable to answer the
// question it exists to answer — which categories still need a picture of their own.

const s = {
  wrap:   { padding: 24, maxWidth: 720, margin: '0 auto', fontFamily: "'Quicksand', sans-serif" },
  h1:     { fontSize: 20, fontWeight: 800, margin: '0 0 4px', color: '#2C4433' },
  sub:    { fontSize: 13, color: '#6B8C74', margin: '0 0 20px' },
  row:    (dim) => ({
    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
    border: '1.5px solid #C5D4C8', borderRadius: 10, background: '#fff', marginBottom: 8,
    opacity: dim ? 0.5 : 1,
  }),
  input:  { flex: 1, minWidth: 0, padding: '7px 10px', border: '1.5px solid #C5D4C8', borderRadius: 8,
            fontSize: 13, fontWeight: 700, color: '#2C4433', fontFamily: 'inherit', outline: 'none', background: '#fff' },
  count:  { fontSize: 11, fontWeight: 800, color: '#8aa091', minWidth: 58, textAlign: 'right' },
  arrow:  (off) => ({ width: 26, height: 26, borderRadius: 7, border: '1.5px solid #C5D4C8', background: '#fff',
                      color: off ? '#ccd8ce' : '#3D5A44', fontWeight: 800, fontSize: 13, lineHeight: 1,
                      cursor: off ? 'default' : 'pointer', flexShrink: 0 }),
  btn:    { padding: '9px 16px', borderRadius: 9, border: 'none', background: '#3D5A44', color: '#fff',
            fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' },
  ghost:  { padding: '5px 11px', borderRadius: 7, border: '1.5px solid #C5D4C8', background: '#fff',
            color: '#3D5A44', fontWeight: 700, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 },
  err:    { background: '#FEF3F2', border: '1px solid #FECDCA', color: '#B42318', borderRadius: 10,
            padding: '10px 14px', fontSize: 13, fontWeight: 600, marginBottom: 14 },
  hint:   { fontSize: 12, color: '#8aa091', marginTop: 16, lineHeight: 1.5 },
  // The tile is square because the menu renders it square — judging a collage in a different shape
  // from the one customers see is how a picture gets approved here and looks cropped there.
  thumb:  (own) => ({
    width: 46, height: 46, borderRadius: 8, flexShrink: 0, cursor: 'pointer', padding: 0,
    border: own ? '1.5px solid #C5D4C8' : '1.5px dashed #C5D4C8',
    background: '#fff', overflow: 'hidden', display: 'flex', alignItems: 'center',
    justifyContent: 'center', position: 'relative',
  }),
  // `contain` and a 6px inset because that is EXACTLY what the customer's menu tile does. `cover`
  // would crop here and letterbox there, so a collage judged in this square would not be the picture
  // anyone actually sees — which is the one thing showing a preview is for.
  thumbImg: (own) => ({ width: '100%', height: '100%', objectFit: 'contain', padding: 4,
                        boxSizing: 'border-box', opacity: own ? 1 : 0.4 }),
  thumbNote: { fontSize: 8.5, fontWeight: 800, color: '#8aa091', textAlign: 'center',
               letterSpacing: 0.2, marginTop: 2, minHeight: 11 },
  thumbCol: { display: 'flex', flexDirection: 'column', alignItems: 'center', width: 52, flexShrink: 0 },
  clear:  { background: 'none', border: 'none', padding: 0, fontSize: 9, fontWeight: 700,
            color: '#B42318', cursor: 'pointer', fontFamily: 'inherit' },
  builder: { border: '1.5px solid #C5D4C8', borderRadius: 10, background: '#F7FAF7',
             padding: 12, marginTop: -4, marginBottom: 10 },
  // Scrolls rather than growing: a category can hold forty decorations and the builder must not
  // push the rest of the list off the screen while it is open.
  choiceGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(52px, 1fr))',
                gap: 6, maxHeight: 168, overflowY: 'auto' },
  choice: (on) => ({ position: 'relative', aspectRatio: '1 / 1', padding: 0, cursor: 'pointer',
                     borderRadius: 7, background: '#fff',
                     border: on ? '2px solid #3D5A44' : '1.5px solid #C5D4C8' }),
  choiceNum: { position: 'absolute', top: -6, right: -6, width: 17, height: 17, borderRadius: 9,
               background: '#3D5A44', color: '#fff', fontSize: 10, fontWeight: 800,
               display: 'flex', alignItems: 'center', justifyContent: 'center' },
};

// ── Building a collage out of the category's own decorations ────────────────────────────────────
// A category picture is best as a few of its decorations together: one lion says "lion", four
// animals say "Animals". Making that by hand means eleven files somebody owns and re-cuts forever,
// so the pictures are assembled here, from elements already in the library.
//
// It is deliberately NOT a design tool. Pick three or four; the arrangement is automatic. The moment
// this offers dragging, rotation and backgrounds it has become a bad Canva living inside an admin
// screen, and the job is "four pictures in a square". Anyone who wants real control can still upload
// a composed image — the button is right there.
//
// The result is a flat picture, so it dates like a hand-made one would: add a giraffe to Animals and
// the collage still shows the old four. Rebuilding it is four clicks, and storing which elements
// went in (to offer a one-click rebuild) would need a column, so it is not done yet.
const COLLAGE_PX = 400;   // see the size hint below — the tile is ~130 CSS px at up to 3x

// Cells as fractions of the square, so the same table drives the 400px export and the small preview.
// Three is 2-over-1 CENTRED rather than left-aligned: an off-centre gap reads as a mistake.
const LAYOUTS = {
  1: [[0, 0, 1, 1]],
  2: [[0, 0.25, 0.5, 0.5], [0.5, 0.25, 0.5, 0.5]],
  3: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0.25, 0.5, 0.5, 0.5]],
  4: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]],
};

// crossOrigin + corsUrl, both required. The thumbnails are on R2, and drawing a cross-origin image
// onto a canvas TAINTS it — toBlob then throws and no collage can be exported at all. corsUrl's
// `?cors=1` keeps the CORS fetch in its own cache entry, so a plain <img> elsewhere on the page
// cannot poison this one (see check-cors.mjs in core, which exists because that bug is invisible).
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load a decoration picture.'));
    img.src = corsUrl(url);
  });
}

// Each picture is CONTAINED in its cell, never cropped: these are cut-out decorations of wildly
// different shapes, and cropping a giraffe to a square is how you get a picture of a giraffe's middle.
function drawCollage(canvas, imgs) {
  const ctx = canvas.getContext('2d');
  const S = canvas.width;
  ctx.clearRect(0, 0, S, S);   // transparent — the customer's tile supplies its own background
  const cells = LAYOUTS[imgs.length] ?? LAYOUTS[4];
  imgs.slice(0, cells.length).forEach((img, i) => {
    const [cx, cy, cw, ch] = cells[i];
    const pad = S * 0.02;
    const bx = cx * S + pad, by = cy * S + pad;
    const bw = cw * S - pad * 2, bh = ch * S - pad * 2;
    const k = Math.min(bw / img.naturalWidth, bh / img.naturalHeight);
    const w = img.naturalWidth * k, h = img.naturalHeight * k;
    ctx.drawImage(img, bx + (bw - w) / 2, by + (bh - h) / 2, w, h);
  });
}

function CollageBuilder({ cat, elements, busy, onSave, onUpload, onClose }) {
  const [picked, setPicked] = useState([]);       // element ids, in the order they were chosen
  const [err, setErr] = useState(null);
  const canvasRef = useRef(null);
  const cache = useRef(new Map());                // url -> loaded Image, so re-picking is instant
  const fileRef = useRef(null);

  // Only what a customer could actually meet in this category: live, top-level, and with a picture.
  const choices = elements.filter(e =>
    e.category_id === cat.id && e.is_active && !e.parent_id && (e.thumb_key || e.thumbnail_url));

  // Redraw whenever the selection changes. Order matters — pick order IS cell order, which is the
  // only arrangement control offered and the only one needed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setErr(null);
        const urls = picked
          .map(id => choices.find(e => e.id === id))
          .filter(Boolean)
          .map(e => e.thumb_key || e.thumbnail_url);
        const imgs = await Promise.all(urls.map(async u => {
          if (!cache.current.has(u)) cache.current.set(u, await loadImage(u));
          return cache.current.get(u);
        }));
        if (!cancelled && canvasRef.current) drawCollage(canvasRef.current, imgs);
      } catch (e) { if (!cancelled) setErr(e.message); }
    })();
    return () => { cancelled = true; };
  }, [picked]);   // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(id) {
    setPicked(p => p.includes(id) ? p.filter(x => x !== id) : (p.length >= 4 ? p : [...p, id]));
  }

  function save() {
    // Straight to WebP here rather than leaving it to the uploader: this canvas is the source, and
    // a PNG of a 400px collage is several times the bytes for the same picture.
    canvasRef.current?.toBlob(blob => { if (blob) onSave(blob); else setErr('Could not build the picture.'); },
      'image/webp', 0.92);
  }

  return (
    <div style={s.builder}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <strong style={{ fontSize: 13, color: '#2C4433' }}>{cat.name} — build a picture</strong>
        <span style={{ fontSize: 11, color: '#8aa091' }}>
          {picked.length ? `${picked.length} of 4 chosen` : 'Choose up to four decorations'}
        </span>
        <div style={{ flex: 1 }} />
        <button style={s.ghost} onClick={onClose}>Close</button>
      </div>

      {err && <div style={s.err}>{err}</div>}

      <div style={{ display: 'flex', gap: 12 }}>
        {/* The preview is the customer's tile: square, and the picture contained inside it. */}
        <div style={{ flexShrink: 0, textAlign: 'center' }}>
          <div style={{ width: 104, height: 104, borderRadius: 8, border: '1.5px solid #C5D4C8',
                        background: '#FAFAF8', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <canvas ref={canvasRef} width={COLLAGE_PX} height={COLLAGE_PX}
                    style={{ width: '100%', height: '100%', padding: 4, boxSizing: 'border-box' }} />
          </div>
          <div style={s.thumbNote}>preview</div>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {choices.length === 0 ? (
            <div style={{ fontSize: 12, color: '#8aa091', padding: '8px 0' }}>
              Nothing in this category has a picture yet, so there is nothing to build one from.
              Upload a composed image instead.
            </div>
          ) : (
            <div style={s.choiceGrid}>
              {choices.map(e => {
                const n = picked.indexOf(e.id);
                return (
                  <button key={e.id} onClick={() => toggle(e.id)} title={e.name}
                          style={s.choice(n >= 0)}>
                    <img src={corsUrl(e.thumb_key || e.thumbnail_url)} alt="" crossOrigin="anonymous"
                         loading="lazy" decoding="async"
                         style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 3, boxSizing: 'border-box' }} />
                    {/* The number, not a tick: pick order is cell order, so it is the one thing
                        worth showing about a chosen decoration. */}
                    {n >= 0 && <span style={s.choiceNum}>{n + 1}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
        <button style={{ ...s.btn, width: 'auto', opacity: picked.length && !busy ? 1 : 0.5 }}
                disabled={!picked.length || busy} onClick={save}>
          Use this picture
        </button>
        <button style={s.ghost} disabled={!picked.length || busy} onClick={() => setPicked([])}>Clear</button>
        <div style={{ flex: 1 }} />
        <button style={s.ghost} disabled={busy} onClick={() => fileRef.current?.click()}>
          Upload an image instead
        </button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif"
               style={{ display: 'none' }}
               onChange={e => { onUpload(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
    </div>
  );
}

// The picture tile: what a customer sees above this category's name, and whether it is the
// category's own or one it is borrowing from a decoration inside it. A hidden file input rather than
// a visible one — the tile IS the control, and a bare "Choose file" next to a picture reads as a
// second, unrelated thing.
function CategoryPicture({ cat, busy, onOpen, onClear }) {
  const own = !!cat.thumbnail_url;
  const src = cat.thumbnail_url || cat.borrowed_url;

  return (
    <div style={s.thumbCol}>
      {/* The tile opens the BUILDER, not a file picker. Building from the category's own decorations
          is the normal way to get one of these; uploading a composed image is the exception, and it
          is offered inside. One target, and the common path is the shallow one. */}
      <button
        style={s.thumb(own)}
        disabled={busy}
        onClick={onOpen}
        title={own ? 'Change this category’s picture' : 'Give this category a picture'}>
        {src
          ? <img src={src} alt="" style={s.thumbImg(own)} loading="lazy" decoding="async" />
          : <span style={{ fontSize: 16, color: '#C5D4C8', fontWeight: 800 }}>+</span>}
      </button>
      {own
        ? <button style={s.clear} disabled={busy} onClick={onClear} title="Go back to borrowing a decoration’s picture">remove</button>
        : <span style={s.thumbNote}>{src ? 'borrowed' : 'no picture'}</span>}
    </div>
  );
}

export default function ElementCategories() {
  const [cats, setCats]   = useState([]);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState('');
  // Which category's picture is being built, and the library to build it from. The elements are
  // fetched ONCE, on first open — the list is large and most visits to this screen never open the
  // builder at all, so loading it up front would be a payload nobody asked for.
  const [buildFor, setBuildFor] = useState(null);
  const [elements, setElements] = useState(null);

  useEffect(() => { load(); }, []);

  async function openBuilder(cat) {
    setBuildFor(cat.id);
    if (elements) return;
    try { setElements(await fetchAllElements()); }
    catch (e) { setError(e.message); setElements([]); }
  }

  async function load() {
    try { setCats(await fetchAdminElementCategories()); }
    catch (e) { setError(e.message); }
  }

  // Optimistic, then reconciled. The rename field would fight the user otherwise — every keystroke
  // waits on a round trip and the caret jumps.
  function patchLocal(id, fields) {
    setCats(cs => cs.map(c => (c.id === id ? { ...c, ...fields } : c)));
  }

  async function save(id, fields) {
    try { await updateElementCategory(id, fields); }
    catch (e) { setError(e.message); load(); }   // reload so the screen stops showing what did not save
  }

  // Upload, then point the category at it. Two steps that must both land: the picture reaches R2
  // first and the row is updated second, so a failed PATCH leaves an orphaned object rather than a
  // category pointing at nothing. That is the right way round — a stray file costs storage, a
  // dangling key costs the customer a broken image in the menu.
  async function pickPicture(cat, file) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const key = await uploadCategoryThumbnail(file);
      const saved = await updateElementCategory(cat.id, { thumb_key: key });
      patchLocal(cat.id, { thumb_key: key, thumbnail_url: saved.thumbnail_url });
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  // A built collage travels the SAME path as an uploaded file — uploadCategoryThumbnail takes a blob,
  // so the canvas output and a picked file are indistinguishable from here down. One upload path.
  async function saveCollage(cat, blob) {
    await pickPicture(cat, blob);
    setBuildFor(null);
  }

  // Clearing returns the category to the borrowed thumbnail — it does not leave it blank, which is
  // why this is offered without a confirmation. `null` must reach the server as an explicit null.
  async function clearPicture(cat) {
    setBusy(true);
    try {
      await updateElementCategory(cat.id, { thumb_key: null });
      patchLocal(cat.id, { thumb_key: null, thumbnail_url: null });
    } catch (e) { setError(e.message); load(); }
    finally { setBusy(false); }
  }

  // Reorder by SWAPPING sort_order with the neighbour, rather than renumbering the list. Two writes
  // instead of eleven, and any gaps the admin left between numbers survive.
  async function move(idx, dir) {
    const a = cats[idx], b = cats[idx + dir];
    if (!a || !b) return;
    setBusy(true);
    const next = [...cats];
    next[idx] = { ...a, sort_order: b.sort_order };
    next[idx + dir] = { ...b, sort_order: a.sort_order };
    next.sort((x, y) => x.sort_order - y.sort_order);
    setCats(next);
    try {
      await Promise.all([
        updateElementCategory(a.id, { sort_order: b.sort_order }),
        updateElementCategory(b.id, { sort_order: a.sort_order }),
      ]);
    } catch (e) { setError(e.message); load(); }
    finally { setBusy(false); }
  }

  async function add() {
    const name = adding.trim();
    if (!name) return;
    setBusy(true);
    try {
      const created = await createElementCategory(name);
      setCats(cs => [...cs, { ...created, count: 0 }].sort((a, b) => a.sort_order - b.sort_order));
      setAdding('');
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={s.wrap}>
      <h1 style={s.h1}>Element Categories</h1>
      <p style={s.sub}>
        How customers browse for decorations. This order is the order they see.
      </p>

      {error && <div style={s.err}>{error}</div>}

      {cats.map((c, i) => (
        <Fragment key={c.id}>
        <div style={s.row(!c.is_active)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <button style={s.arrow(i === 0)} disabled={i === 0 || busy} onClick={() => move(i, -1)} title="Move up">↑</button>
            <button style={s.arrow(i === cats.length - 1)} disabled={i === cats.length - 1 || busy} onClick={() => move(i, 1)} title="Move down">↓</button>
          </div>

          <CategoryPicture cat={c} busy={busy} onOpen={() => openBuilder(c)} onClear={() => clearPicture(c)} />

          <input
            style={s.input}
            value={c.name}
            onChange={e => patchLocal(c.id, { name: e.target.value })}
            // Saved on blur, not per keystroke — this is a name customers read, and a PATCH per
            // character would write a dozen half-typed versions of it.
            onBlur={e => e.target.value.trim() && save(c.id, { name: e.target.value.trim() })}
            onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
          />

          <div style={s.count}>{c.count} item{c.count === 1 ? '' : 's'}</div>

          <button
            style={s.ghost}
            disabled={busy}
            onClick={() => { patchLocal(c.id, { is_active: !c.is_active }); save(c.id, { is_active: !c.is_active }); }}
            title={c.is_active ? 'Hide from customers — elements keep their category' : 'Show to customers again'}>
            {c.is_active ? 'Retire' : 'Restore'}
          </button>
        </div>
        {/* Under its own row, not in a modal: the row is the context — which category this is, what
            it currently shows, how many decorations are in it — and a modal would cover exactly that. */}
        {buildFor === c.id && (
          <CollageBuilder
            cat={c}
            elements={elements ?? []}
            busy={busy || elements === null}
            onSave={blob => saveCollage(c, blob)}
            onUpload={f => { pickPicture(c, f); setBuildFor(null); }}
            onClose={() => setBuildFor(null)}
          />
        )}
        </Fragment>
      ))}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <input
          style={s.input}
          placeholder="New category name"
          value={adding}
          onChange={e => setAdding(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
        />
        <button style={s.btn} onClick={add} disabled={!adding.trim() || busy}>Add</button>
      </div>

      <p style={s.hint}>
        A new category goes to the end of the menu — move it with the arrows.
        Retiring hides a category from customers but keeps every element in it, so restoring brings
        them all back. Categories cannot be deleted: that would strip the category off the
        decorations it holds, with no way to undo it.
      </p>
      <p style={s.hint}>
        The square is the picture customers see above the category name. A faded one is BORROWED —
        the first decoration in the category that has a thumbnail — so a category always shows
        something even before you give it a picture of its own. Click to upload one; a collage of a
        few of its decorations reads better than a single one — which is what the square builds for you:
        click it, choose up to four of the category's decorations, and it arranges them.
      </p>
      <p style={s.hint}>
        Uploading your own instead? Make it SQUARE, about 400x400 — the tile is square, and a picture
        that is not is letterboxed inside it with bars down two sides. No need to add your own margin,
        the tile already insets the picture. A transparent background suits it best.
      </p>
    </div>
  );
}
