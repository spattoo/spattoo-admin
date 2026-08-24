import { useEffect, useMemo, useState } from 'react';
import { fetchElementTypes, createGlobalElement, updateGlobalElement, fetchGlobalElement, uploadThumbnail } from './api.js';

// ── Author a file-less catalogue element from a studio ────────────────────────────────────────────
//
// Every procedural studio (drip, grass, letter blocks) wants the same thing: turn what is on screen
// into a `cake_elements` row — no asset, a thumbnail captured from its own canvas, and the tuned
// parameters in placement_config. The row is what makes the thing searchable, taggable and
// manageable; the geometry stays in code.
//
// ── WHY THIS IS SHARED AND NOT COPIED ───────────────────────────────────────────────────────────
// The drip studio wrote it first and had two faults nobody noticed. `cake_elements` has no
// uniqueness constraint and POST /admin/elements is a plain insert with no upsert, so EVERY press of
// Save made another row — another name in the picker, another embedding job, another decoration
// guide. And PATCH /admin/elements/:id has always accepted thumbnail_url and placement_config, but
// no studio called it, so a saved element could never be corrected: you made a second and deleted
// the first.
//
// Grass then inherited both faults by copy-paste, which is the moment the rule in INVARIANTS #3
// applies — "a rule used in two places lives in a single pure function both call". This is that
// function. Fixing it here fixed the drip too.
//
// ── THE CONTRACT ────────────────────────────────────────────────────────────────────────────────
//   typeSlug    the element_types slug this studio authors under ('drip', 'grass', …)
//   canvasRef   a ref to a node CONTAINING the canvas — the thumbnail is literally what it shows
//   buildPayload()  → { placement_config, default_color?, allowed_zones? } — the per-studio bits
//   onHydrate(el)   ← called when opened with ?element=<id>, to load the row back into the sliders
//
// Returns the save state plus `save()` and `startNew()`. The caller renders its own name field and
// buttons, because the copy differs per studio and a shared widget would be a worse fit than a
// shared behaviour.
//
// ── WHY SAVING WRITES THE URL ───────────────────────────────────────────────────────────────────
// `editing` used to live only in memory, so a reload came back as a FRESH studio against a row that
// already existed — and the next press of Save made a second one. Nothing said so: the name was
// still typed in, the sliders still where you left them, and the only clue was a heading that no
// longer said EDITING. That is a trap for whoever uses this tool without having built it.
//
// So a create rewrites the address to `?element=<id>`. Reload, bookmark, or send the link to someone
// else, and it opens as a revision of that row.
//
// ── AND WHY `startNew` HAD TO COME WITH IT ──────────────────────────────────────────────────────
// That fix alone trades one silent failure for a worse one. Somebody authoring a SECOND variant —
// tune, rename, Save — would now quietly overwrite the first instead of adding a row, and an
// overwrite cannot be undone by deleting a duplicate.
//
// `startNew()` is the way out, and it must be rendered wherever Save is. The pair is the point:
// which row you are about to write is visible, and both directions are reachable.
export function useElementSave({ typeSlug, canvasRef, buildPayload, onHydrate }) {
  // `?element=<id>` opens a studio against a saved row — the Relief Sticker Studio's pattern.
  const elementId = useMemo(() => new URLSearchParams(window.location.search).get('element'), []);
  const [editing, setEditing]   = useState(null);   // { id, name } once revising a real row
  const [saveName, setSaveName] = useState('');
  const [busy, setBusy]         = useState(false);
  const [msg, setMsg]           = useState(null);

  useEffect(() => {
    if (!elementId) return;
    let cancelled = false;
    (async () => {
      try {
        const el = await fetchGlobalElement(elementId);
        if (cancelled || !el) return;
        setEditing({ id: el.id, name: el.name });
        setSaveName(el.name ?? '');
        onHydrate?.(el);
      } catch (e) {
        // Never silent: a studio that quietly ignored the id would look like a fresh one, and the
        // next save would clone the row you meant to edit.
        if (!cancelled) setMsg({ ok: false, text: `Could not load that element: ${e.message}` });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elementId]);

  async function captureThumbnail() {
    const cnv = canvasRef?.current?.querySelector('canvas');
    if (!cnv) return null;
    const blob = await new Promise((res) => cnv.toBlob(res, 'image/png'));
    return blob ? uploadThumbnail('elements/thumbnails', blob) : null;
  }

  async function save() {
    if (!saveName.trim()) { setMsg({ ok: false, text: 'Give the element a name.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const { placement_config, default_color, allowed_zones } = buildPayload();
      // Best-effort: a failed capture must never lose the tuning.
      let thumbnail_url = null;
      try { thumbnail_url = await captureThumbnail(); } catch { /* keep whatever is there */ }

      if (editing) {
        await updateGlobalElement(editing.id, {
          name: saveName.trim(),
          ...(default_color !== undefined ? { default_color } : {}),
          ...(allowed_zones ? { allowed_zones } : {}),
          placement_config,
          // Only send a thumbnail actually captured. PATCH treats undefined as "leave alone", so a
          // failed capture keeps the existing picture rather than blanking it.
          ...(thumbnail_url ? { thumbnail_url } : {}),
        });
        setEditing({ id: editing.id, name: saveName.trim() });
        setMsg({ ok: true, text: `Updated "${saveName.trim()}".` });
      } else {
        const types = await fetchElementTypes();
        const type = (types ?? []).find(
          (t) => t.slug === typeSlug || (t.name ?? '').trim().toLowerCase() === typeSlug,
        );
        if (!type) throw new Error(`No "${typeSlug}" element type found - create it first in Element Types.`);
        const created = await createGlobalElement({
          name: saveName.trim(),
          element_type_id: type.id,
          allowed_zones: allowed_zones ?? [],
          default_color: default_color ?? null,
          image_url: null,          // generated — there is no asset; the thumbnail carries the look
          thumbnail_url,
          placement_config,
        });
        // Become an EDIT of what was just made, so the next press revises this row instead of
        // cloning it. The common path is author-then-immediately-adjust, so this is the line that
        // actually prevents the duplicates.
        if (created?.id) {
          setEditing({ id: created.id, name: saveName.trim() });
          rememberInUrl(created.id);
        }
        setMsg({ ok: true, text: `Saved "${saveName.trim()}" - saving again updates it.` });
      }
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally { setBusy(false); }
  }

  // Stop revising the saved row and author a fresh one. Clears the name too: keeping it is how you
  // end up with two rows called the same thing, which is the confusion this was avoiding.
  function startNew() {
    setEditing(null);
    setSaveName('');
    setMsg(null);
    rememberInUrl(null);
  }

  return { elementId, editing, saveName, setSaveName, busy, msg, save, startNew };
}

// replaceState, not pushState: the studio is one screen being pointed at different rows, so Back
// should leave it rather than walk through everything that was saved in this session.
function rememberInUrl(id) {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('element', id);
  else url.searchParams.delete('element');
  window.history.replaceState(null, '', url);
}
