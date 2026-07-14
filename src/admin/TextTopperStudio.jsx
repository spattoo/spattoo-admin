import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchElementTypes, uploadBlob, uploadThumbnail, uploadFont,
  createGlobalElement, fetchAdminTextStyles, createTextStyle, updateTextStyle,
} from '../lib/api.js';
import { prepareElementImage } from '../lib/elementImage.js';
// The renderer lives in spattoo-core and is imported, NOT copied: the designer composites the
// customer's value with these exact functions, so this preview and the cake cannot drift.
import {
  DEFAULT_TEXT_STYLE, composeTextTopper, bakeArtwork, resolveTextStyle as resolveStyle,
  loadSlotFonts, loadStyleFont, findCleanSource, findInkColor,
} from '@spattoo/designer';

// ── Text Topper Studio ─────────────────────────────────────────────────────────
// Authors a template whose text is a PLACEHOLDER the customer fills: a {number} plaque, a {name}
// banner, or both on one artwork. The artwork is just artwork — nothing in the code knows about any
// particular template, so a new one is artwork + slot rects + a style pick.
//
//   image_url                        = the artwork (patches baked in)
//   placement_config.text_slots      = [{ key, label, kind, default, maxLen, rect, style_key, style_override }]
//
// Rendering is ONE shared module — spattoo-core's shared/textures/textSlots.js, imported from
// @spattoo/designer. This preview and the designer's on-cake texture call the SAME functions, so they
// cannot drift. Reuses createGlobalElement + the upload helpers, not a parallel element-creation path.
//
// ORDER MATTERS: the artwork is normalized (remove-bg → crop-to-content → centred at 80% of a square)
// on UPLOAD, and slots are authored against that canonical frame. Authoring first and normalizing at
// save would silently shift every rect, because normalizing re-frames the image.

const S = 1024;                                     // the canonical authoring/asset frame
const TOPPER_ZONES = ['top_surface', 'side'];
const TOPPER_ACTIONS = { resize: true, duplicate: true, color: false, gradient: false, delete: true, move: true, tilt: false };
const NEW_RECT = { x: 0.5, y: 0.5, w: 0.3, h: 0.3, rot: 0 };
const HANDLE = 0.022;                               // corner grip half-size, normalized

const SAMPLES = { number: '2', text: 'Amara' };

// ── The style panel is DATA ────────────────────────────────────────────────────
// One row per Look, listing the config each of its controls edits by path. A new algorithm in core adds
// a row here and nothing else — the panel never branches on `algorithm` in JSX.
const LOOKS = {
  fondant: {
    label: 'Fondant (a puffy piece of icing)',
    short: 'Fondant',
    // Icing is modelled, not drawn: a piped/rolled figure has no ink line round it, and an outline on one
    // reads as a sticker. `defaults` is applied when the Look is chosen, so it is a starting point the
    // operator can overrule — not a rule the renderer enforces.
    defaults: { outline: { width: 0 } },
    swatches: [['Icing', 'fill'], ['Outline', 'outline.color']],
    sliders: [
      ['Light from',        'fondant.light',        0,    360,  5,     v => `${Math.round(v)}°`],
      ['Puffiness',         'fondant.bevel',        0.05, 1,    0.05],
      ['Sheen',             'fondant.gloss',        0,    1,    0.05],
      ['Shading',           'fondant.ao',           0,    1,    0.05],
      ['Outline width',     'outline.width',        0,    0.12, 0.005],
      ['Shadow softness',   'fondant.shadow_blur',  0,    0.2,  0.01],
      ['Shadow drop',       'fondant.shadow_dy',    0,    0.12, 0.005],
      ['Shadow strength',   'fondant.shadow_alpha', 0,    0.8,  0.05],
    ],
  },
  scribble: {
    label: 'Scribble (hairlines carved through the fill)',
    short: 'Scribble',
    swatches: [['Fill', 'fill'], ['Outline', 'outline.color'], ['Hatch', 'hatch.color']],
    sliders: [
      ['Outline width',    'outline.width',  0,     0.12, 0.005],
      ['Outline wobble',   'outline.wobble', 0,     1,    0.05],
      ['Hatch spacing',    'hatch.gap',      0,     0.16, 0.005],
      ['Hatch thickness',  'hatch.width',    0.002, 0.05, 0.002],
      ['Hatch angle',      'hatch.angle',    -90,   90,   1,     v => `${Math.round(v)}°`],
    ],
  },
  flat: {
    label: 'Flat (solid fill + outline)',
    short: 'Flat',
    swatches: [['Fill', 'fill'], ['Outline', 'outline.color']],
    sliders: [['Outline width', 'outline.width', 0, 0.12, 0.005]],
  },
};
const COMMON_SLIDERS = [['Letter spacing', 'tracking', -0.1, 0.4, 0.01]];

const atPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

// A style's `key` is its stable identity, so it is derived once from the name and never re-derived.
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
function uniqueKey(label, existing) {
  const base = slug(label) || 'style';
  const taken = new Set(existing.map(st => st.key));
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
  return key;
}
const NESTED = ['font', 'hatch', 'outline', 'fondant'];   // the one level of nesting the style shape has
const newSlotKey = (slots, kind) => {
  const base = kind === 'number' ? 'number' : 'name';
  if (!slots.some(s => s.key === base)) return base;
  let i = 2;
  while (slots.some(s => s.key === `${base}${i}`)) i++;
  return `${base}${i}`;
};

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export default function TextTopperStudio() {
  const [elementTypes, setElementTypes] = useState([]);
  const [styles, setStyles]     = useState([]);
  const [name, setName]         = useState('');
  const [typeId, setTypeId]     = useState('');
  const [topMode, setTopMode]   = useState('stand');   // a plaque topper stands; a decal hugs
  const [artwork, setArtwork]   = useState(null);      // the NORMALIZED artwork image
  const [artBlob, setArtBlob]   = useState(null);
  const [busy, setBusy]         = useState(null);
  const [msg, setMsg]           = useState(null);

  const [slots, setSlots]       = useState([]);
  const [patches, setPatches]   = useState([]);
  const [values, setValues]     = useState({});        // sample values driving the preview
  const [sel, setSel]           = useState(null);      // { kind:'slot'|'patch', i }
  const [tool, setTool]         = useState('slots');   // 'slots' | 'patch'
  const [picking, setPicking]   = useState(null);      // config path the next canvas click samples into
  // ── Styles are FORK-ON-EDIT ────────────────────────────────────────────────
  // A style row is DB master data SHARED by every template that references it. Picking one reuses it;
  // *editing* one while authoring makes a DRAFT, which is saved as a NEW style when the topper is saved —
  // so authoring a topper can never silently restyle somebody else's. Deliberately restyling everyone is
  // still possible (`mode = 'update'`), it just has to be asked for. The operator never manages a style
  // row by hand: "Save text topper" is the ONE save, and the preview can no longer promise a look the
  // designer (which renders from the DB) won't render.
  const [dirty, setDirty]       = useState([]);        // style ids edited in this tab
  const [mode, setMode]         = useState({});        // style id → 'fork' (default) | 'update'
  const [draftLabel, setDraft]  = useState({});        // style id → the new style's name, when forking
  const [fontTick, setFontTick] = useState(0);         // bumped when a webfont finishes loading

  const canvasRef = useRef(null);
  const dragRef   = useRef(null);

  useEffect(() => { fetchElementTypes().then(setElementTypes).catch(() => setElementTypes([])); }, []);
  useEffect(() => { fetchAdminTextStyles().then(setStyles).catch(() => setStyles([])); }, []);

  const styleOf = useMemo(() => {
    const byKey = new Map(styles.map(st => [st.key, { algorithm: st.algorithm, ...(st.config || {}) }]));
    return slot => byKey.get(slot.style_key) || DEFAULT_TEXT_STYLE;
  }, [styles]);

  // A style's face is an uploaded woff2 — canvas can't shape with it until it's in document.fonts.
  useEffect(() => {
    if (!slots.length) return;
    let alive = true;
    loadSlotFonts(slots, styleOf).then(() => { if (alive) setFontTick(t => t + 1); });
    return () => { alive = false; };
  }, [slots, styleOf]);

  // The artwork with its clone-patches AND slot covers baked in — what actually gets uploaded, and what
  // the preview must show (otherwise the operator tunes a slot against a "2" that won't be there).
  const patched = useMemo(
    () => (artwork ? bakeArtwork(S, artwork, patches, slots) : null),
    [artwork, patches, slots],
  );

  async function onArtwork(file) {
    setBusy('Removing background + normalizing…');
    setMsg(null);
    try {
      const blob = await prepareElementImage(file, { removeBgEnabled: true });
      const img = await loadImage(URL.createObjectURL(blob));
      setArtBlob(blob);
      setArtwork(img);
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Could not process the artwork.' });
    } finally {
      setBusy(null);
    }
  }

  // ── Preview ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const D = cv.width;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, D, D);

    const t = 16;                                        // checkerboard = transparent (the cake shows)
    for (let y = 0; y < D; y += t) for (let x = 0; x < D; x += t) {
      ctx.fillStyle = ((x / t + y / t) % 2 === 0) ? '#eceff1' : '#dfe4e7';
      ctx.fillRect(x, y, t, t);
    }
    if (!patched) return;

    const composed = composeTextTopper(S, patched, slots, values, styleOf);
    ctx.drawImage(composed, 0, 0, D, D);

    // Authoring overlay — the rects themselves are never part of the asset.
    // A slot's clone source is deliberately NOT drawn: covering is automatic, and where the pixels come
    // from is an implementation detail, not a decision for the operator. Only the Patch tool — where
    // choosing the source IS the point — shows one.
    const items = tool === 'patch'
      ? patches.map((p, i) => ({ r: p.rect, i, kind: 'patch', from: p.from }))
      : slots.map((sl, i) => ({ r: sl.rect, i, kind: 'slot' }));
    for (const it of items) {
      const on = sel?.kind === it.kind && sel.i === it.i;
      const x = (it.r.x - it.r.w / 2) * D, y = (it.r.y - it.r.h / 2) * D;
      const w = it.r.w * D, h = it.r.h * D;
      ctx.save();
      ctx.setLineDash(on ? [] : [6, 4]);
      ctx.lineWidth = on ? 2.5 : 1.5;
      ctx.strokeStyle = it.kind === 'patch' ? '#c0392b' : '#2E7D32';
      ctx.strokeRect(x, y, w, h);
      if (on) {
        ctx.setLineDash([]);
        ctx.fillStyle = it.kind === 'patch' ? '#c0392b' : '#2E7D32';
        for (const [hx, hy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
          ctx.fillRect(hx - HANDLE * D / 2, hy - HANDLE * D / 2, HANDLE * D, HANDLE * D);
        }
      }
      // The clone SOURCE marker — the small sample that gets tiled over the box. Selected item only,
      // so the canvas stays readable.
      if (on && it.from) {
        const side = (it.from.s ?? 0.08) * D;
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = '#c0392b';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(it.from.x * D - side / 2, it.from.y * D - side / 2, side, side);
        ctx.beginPath();
        ctx.arc(it.from.x * D, it.from.y * D, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#c0392b';
        ctx.fill();
      }
      ctx.restore();
    }
  }, [patched, slots, patches, values, styleOf, sel, tool, fontTick]);

  // ── Canvas drag: move / resize a rect, or move a clone source ───────────────
  function ptOf(e) {
    const cv = canvasRef.current;
    const b = cv.getBoundingClientRect();
    return { x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height };
  }

  function onPointerDown(e) {
    if (!patched) return;
    const p = ptOf(e);
    if (picking) {
      const hex = pickColorAt(p);
      if (hex) editSlotColor(picking, hex);
      setPicking(null);
      return;                                    // a sampling click never moves a box
    }
    const list = tool === 'patch' ? patches : slots;
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i].rect;
      const l = r.x - r.w / 2, t = r.y - r.h / 2, rt = r.x + r.w / 2, bt = r.y + r.h / 2;
      const corners = { nw: [l, t], ne: [rt, t], sw: [l, bt], se: [rt, bt] };
      for (const [k, [cx, cy]] of Object.entries(corners)) {
        if (Math.abs(p.x - cx) < HANDLE && Math.abs(p.y - cy) < HANDLE) {
          setSel({ kind: tool === 'patch' ? 'patch' : 'slot', i });
          dragRef.current = { mode: 'resize', corner: k, i, start: p, rect0: { ...r } };
          e.currentTarget.setPointerCapture(e.pointerId);
          return;
        }
      }
      // The clone source dot — Patch tool only; a slot covers itself automatically.
      const from = tool === 'patch' ? list[i].from : null;
      if (from && sel?.kind === 'patch' && sel.i === i && Math.hypot(p.x - from.x, p.y - from.y) < HANDLE) {
        dragRef.current = { mode: 'from', i, start: p, from0: { ...from } };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
      if (p.x >= l && p.x <= rt && p.y >= t && p.y <= bt) {
        setSel({ kind: tool === 'patch' ? 'patch' : 'slot', i });
        dragRef.current = { mode: 'move', i, start: p, rect0: { ...r } };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
    }
    setSel(null);
  }

  function onPointerMove(e) {
    const d = dragRef.current;
    if (!d) return;
    const p = ptOf(e);
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    const isPatch = tool === 'patch';
    const setList = isPatch ? setPatches : setSlots;

    setList(prev => prev.map((it, i) => {
      if (i !== d.i) return it;
      // Only a patch has a draggable source (keep its sample side `s`).
      if (d.mode === 'from') return { ...it, from: { ...d.from0, x: d.from0.x + dx, y: d.from0.y + dy } };
      const r0 = d.rect0;
      if (d.mode === 'move') return { ...it, rect: { ...it.rect, x: r0.x + dx, y: r0.y + dy } };
      // resize: the grabbed corner follows the pointer, the opposite corner stays put
      const sx = d.corner.includes('w') ? -1 : 1;
      const sy = d.corner.includes('n') ? -1 : 1;
      const w = Math.max(0.03, r0.w + sx * dx * 2);
      const h = Math.max(0.03, r0.h + sy * dy * 2);
      return { ...it, rect: { ...it.rect, w, h } };
    }));
  }

  // The clone source was picked for where the box USED to be, so re-pick once it lands somewhere else —
  // otherwise a placeholder dragged onto the baked-in "2" would sample a region that now overlaps it.
  // Silent: the operator never sees or manages the source.
  function onPointerUp() {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.mode === 'from' || tool === 'patch' || !artwork) return;
    setSlots(prev => prev.map((sl, i) => {
      if (i !== d.i) return sl;
      const next = sl.cover ? { ...sl, cover: { from: findCleanSource(artwork, sl.rect) } } : { ...sl };
      // The box has landed somewhere else — so has the value it covers. Re-inherit ITS colour, unless the
      // operator has already chosen one (a manual pick is a decision; it must not be silently undone).
      if (next.autoColor) {
        const ink = findInkColor(artwork, next.rect);
        if (ink) next.style_override = { ...next.style_override, fill: ink };
      }
      return next;
    }));
  }

  // ── Slots / patches ────────────────────────────────────────────────────────
  // A placeholder is useless without a style, and making the operator go author one before anything
  // renders is a trap. The code holds the SEED (DEFAULT_TEXT_STYLE); the first placeholder promotes it
  // to the DB row every template then shares. Editing it from here forks (see commitDraftStyles).
  async function ensureStyle() {
    if (styles.length) return styles[0].key;
    const created = await createTextStyle({
      key: 'default', label: 'Default',
      algorithm: DEFAULT_TEXT_STYLE.algorithm,
      config: DEFAULT_TEXT_STYLE,
    });
    setStyles([created]);
    return created.key;
  }

  async function addSlot(kind) {
    const key = newSlotKey(slots, kind);
    const def = SAMPLES[kind];
    const rect = { ...NEW_RECT };

    let style_key = styles[0]?.key ?? null;
    if (!style_key) {
      try { style_key = await ensureStyle(); }
      catch (err) { setMsg({ ok: false, text: `Could not create the default text style: ${err.message}` }); }
    }

    // Cover by default: a placeholder that lands on a baked-in value must ERASE it, not render "23".
    // The source is the flattest opaque region of the artwork — bare plaque, never a glyph or an animal.
    const from = artwork ? findCleanSource(artwork, rect) : null;
    // …and the value it replaces hands over its COLOUR, so the placeholder starts out the icing the
    // artwork is actually made of instead of the preset's brown. Re-picked as the box moves (below),
    // until the operator overrules it with the eyedropper or the swatch.
    const ink = artwork ? findInkColor(artwork, rect) : null;

    setSlots(s => [...s, {
      key, label: kind === 'number' ? 'Age / number' : 'Name',
      kind, default: def, maxLen: kind === 'number' ? 2 : 12,
      rect, style_key,
      style_override: ink ? { fill: ink } : {},
      autoColor: true,                          // local only — the save payload lists its fields explicitly
      cover: from ? { from } : null,
    }]);
    setValues(v => ({ ...v, [key]: def }));
    setSel({ kind: 'slot', i: slots.length });
    setTool('slots');
  }

  function patchSlot(i, patch) {
    setSlots(s => s.map((sl, j) => (j === i ? { ...sl, ...patch } : sl)));
  }

  function removeSlot(i) {
    setSlots(s => s.filter((_, j) => j !== i));
    setSel(null);
  }

  function addPatch() {
    const rect = { ...NEW_RECT };
    setPatches(p => [...p, { rect, from: artwork ? findCleanSource(artwork, rect) : { x: 0.5, y: 0.82, s: 0.08 } }]);
    setSel({ kind: 'patch', i: patches.length });
    setTool('patch');
  }

  // ── Style editing (persists to the DB — admin master data, never local) ─────
  const selSlot = sel?.kind === 'slot' ? slots[sel.i] : null;
  const selStyle = styles.find(st => st.key === selSlot?.style_key) || null;

  function editStyleConfig(patch) {
    if (!selStyle) return;
    markDirty(selStyle.id);
    setStyles(list => list.map(st => {
      if (st.id !== selStyle.id) return st;
      const config = { ...st.config, ...patch };
      for (const k of NESTED) {
        config[k] = { ...DEFAULT_TEXT_STYLE[k], ...st.config?.[k], ...(patch[k] || {}) };
      }
      return { ...st, config };
    }));
  }

  // Edit one control by its config path — what makes the LOOKS table above the whole panel.
  function editStylePath(path, value) {
    const [a, b] = path.split('.');
    editStyleConfig(b ? { [a]: { [b]: value } } : { [a]: value });
  }

  // COLOUR is per-SLOT, not per-style. The style is shared by every template using it, so writing this
  // artwork's icing colour into the preset would silently restyle all of them; `style_override` is the
  // seam that already exists for exactly this (one field tweaked, the preset otherwise intact).
  function editSlotColor(path, value) {
    if (sel?.kind !== 'slot') return;
    const [a, b] = path.split('.');
    patchSlot(sel.i, {
      autoColor: false,                          // an explicit choice outranks the artwork
      style_override: {
        ...(selSlot.style_override || {}),
        ...(b
          ? { [a]: { ...(selSlot.style_override?.[a] || {}), [b]: value } }
          : { [a]: value }),
      },
    });
  }

  const markDirty = id => setDirty(d => (d.includes(id) ? d : [...d, id]));
  const suggestLabel = st => `${LOOKS[st.algorithm]?.short || 'Style'}${name.trim() ? ` — ${name.trim()}` : ''}`;

  // Choosing a Look brings that Look's starting points with it (fondant: no outline). Config, not a
  // branch — and only a default: whatever the operator sets afterwards stands.
  function chooseLook(algorithm) {
    markDirty(selStyle.id);
    setStyles(l => l.map(x => (x.id === selStyle.id ? { ...x, algorithm } : x)));
    const defaults = LOOKS[algorithm]?.defaults;
    if (defaults) editStyleConfig(defaults);
  }

  // Eyedropper: the colour of the icing comes from the ARTWORK the operator is looking at. This is the
  // only part of the reference art that transfers — the shading cannot, because it follows the shape it
  // was painted on (which is why `fondant` derives its bevel from the typed glyph instead).
  function pickColorAt(p) {
    if (!patched) return null;
    const x = Math.max(0, Math.min(S - 1, Math.round(p.x * S)));
    const y = Math.max(0, Math.min(S - 1, Math.round(p.y * S)));
    const d = patched.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data;
    if (d[3] < 8) return null;   // transparent — off the artwork
    return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  async function onFont(file) {
    if (!selStyle) return;
    setBusy('Uploading font…');
    try {
      const url = await uploadFont(file);
      const family = (file.name || 'Custom').replace(/\.(woff2?|ttf|otf)$/i, '').replace(/[^A-Za-z0-9 _-]/g, '') || 'Custom';
      editStyleConfig({ font: { family, url, weight: selStyle.config?.font?.weight ?? 800 } });
      await loadStyleFont({ family, url, weight: 800 });
      setFontTick(t => t + 1);
      setMsg({ ok: true, text: `Font "${family}" uploaded. Save the style to keep it.` });
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Font upload failed.' });
    } finally {
      setBusy(null);
    }
  }

  // Persist every draft style a placeholder points at, and return the styles + slots as they now are —
  // a forked style has a NEW key, so the slots that referenced the draft must follow it. Runs as the
  // first step of saving the topper: by the time the element row is written, every style_key it names
  // exists in the DB with exactly the look that was on screen.
  async function commitDraftStyles() {
    let live = styles;
    let next = slots;
    for (const st of styles) {
      if (!dirty.includes(st.id) || !next.some(sl => sl.style_key === st.key)) continue;

      if (mode[st.id] === 'update') {
        const saved = await updateTextStyle(st.id, { algorithm: st.algorithm, config: st.config });
        live = live.map(x => (x.id === saved.id ? saved : x));
        continue;
      }
      const label = (draftLabel[st.id] ?? suggestLabel(st)).trim();
      if (!label) throw new Error('Name the new style before saving.');
      const created = await createTextStyle({
        key: uniqueKey(label, live), label, algorithm: st.algorithm, config: st.config,
      });
      live = [...live, created];
      next = next.map(sl => (sl.style_key === st.key ? { ...sl, style_key: created.key } : sl));
    }
    setStyles(live);
    setSlots(next);
    setDirty([]);
    return { live, next };
  }

  // ── Save the element ───────────────────────────────────────────────────────
  async function handleSave() {
    if (!name.trim())  return setMsg({ ok: false, text: 'Name is required.' });
    if (!typeId)       return setMsg({ ok: false, text: 'Pick an element type.' });
    if (!artwork)      return setMsg({ ok: false, text: 'Upload the artwork.' });
    if (!slots.length) return setMsg({ ok: false, text: 'Add at least one placeholder — otherwise this is a plain sticker (use Add Element).' });
    if (slots.some(sl => !sl.style_key)) return setMsg({ ok: false, text: 'Every placeholder needs a text style.' });

    setBusy('Saving…');
    setMsg(null);
    try {
      // Styles first — the element's slots must name style_keys that EXIST, carrying the look on screen.
      const { live, next } = await commitDraftStyles();
      const byKey = new Map(live.map(st => [st.key, { algorithm: st.algorithm, ...(st.config || {}) }]));
      const savedStyleOf = sl => byKey.get(sl.style_key) || DEFAULT_TEXT_STYLE;

      // The artwork with patches AND slot covers baked in — the designer never replays a clone.
      const artCanvas = bakeArtwork(S, artwork, patches, next);
      const blob = await new Promise(res => artCanvas.toBlob(res, 'image/png'));
      const { key } = await uploadBlob('elements/files/2D', `${crypto.randomUUID()}.png`, blob, 'image/png');

      // Thumbnail = the topper with its DEFAULT values, so the picker tile reads as a real topper.
      const thumbBlob = await new Promise(res =>
        composeTextTopper(512, artCanvas, next, Object.fromEntries(next.map(sl => [sl.key, sl.default])), savedStyleOf).toBlob(res, 'image/png'));
      const thumbKey = await uploadThumbnail('elements/thumbnails', thumbBlob);

      await createGlobalElement({
        name: name.trim(),
        description: null,
        element_type_id: typeId,
        parent_id: null,
        image_url: key,
        thumbnail_url: thumbKey,
        file_size: blob.size ?? null,
        allowed_zones: TOPPER_ZONES,
        placement_config: {
          top_surface: topMode,
          side: 'hug',
          r: 1,
          text_slots: next.map(sl => ({
            key: sl.key,
            label: sl.label,
            kind: sl.kind,
            default: sl.default,
            maxLen: sl.maxLen,
            rect: sl.rect,
            style_key: sl.style_key,
            ...(Object.keys(sl.style_override || {}).length ? { style_override: sl.style_override } : {}),
          })),
        },
        allowed_actions: TOPPER_ACTIONS,
        default_color: null,
        sort_order: 0,
      });

      setMsg({ ok: true, text: 'Text topper saved! It will show in the designer with its placeholders editable.' });
      setName('');
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Save failed.' });
    } finally {
      setBusy(null);
    }
  }

  const cfg = selStyle?.config || {};
  const st = resolveStyle(selStyle ? { algorithm: selStyle.algorithm, ...cfg } : null, selSlot?.style_override);
  const look = LOOKS[selStyle?.algorithm] || LOOKS.flat;
  const isDraft = !!selStyle && dirty.includes(selStyle.id);
  const isUpdate = isDraft && mode[selStyle.id] === 'update';

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Text Topper Studio</h1>
      <p style={s.sub}>
        Author a template whose text is a <b>placeholder the customer fills</b> — a <code>{'{number}'}</code> plaque,
        a <code>{'{name}'}</code> banner, or both. The artwork stays the same; only the placeholder changes.
        A value is never an asset, so any number or name costs nothing.
      </p>

      <div style={s.specBox}>
        <div style={s.specTitle}>How it works</div>
        <ul style={s.specList}>
          <li><b>Artwork</b> — a square PNG. On upload it's background-removed and centred; you author placeholders against <i>that</i> frame, so nothing shifts when it's saved.</li>
          <li><b>Placeholder</b> — drag a green box over where the text goes and size it to cover any value already printed there (like the "2"). Whatever is under the box is <b>erased automatically</b>.</li>
          <li><b>Style</b> — font, fill, hatch, outline. A reusable preset shared across templates: restyle it once and every template using it follows.</li>
          <li><b>Patch artwork</b> — only for clean-up unrelated to a placeholder (a stray mark elsewhere on the art).</li>
        </ul>
      </div>

      <div style={s.grid}>
        <div style={s.col}>
          <label style={s.label}>Name</label>
          <input style={s.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Safari Animals Number Plaque" />

          <label style={s.label}>Element type</label>
          <select style={s.select} value={typeId} onChange={e => setTypeId(e.target.value)}>
            <option value="">Select type…</option>
            {elementTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>

          <label style={s.label}>On the cake top it…</label>
          <select style={s.select} value={topMode} onChange={e => setTopMode(e.target.value)}>
            <option value="stand">Stands upright (a topper plaque)</option>
            <option value="hug">Lies flat (a decal)</option>
          </select>

          <label style={s.fileBox}>
            <input type="file" accept="image/*" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onArtwork(f); }} />
            <div style={{ fontSize: 12, fontWeight: 700, color: '#2C4433' }}>{artwork ? 'Replace artwork' : 'Upload artwork (PNG)'}</div>
            <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 2 }}>Background is removed and the art is centred automatically.</div>
          </label>

          <div style={s.toolRow}>
            <button style={{ ...s.tab, ...(tool === 'slots' ? s.tabOn : {}) }} onClick={() => { setTool('slots'); setSel(null); }}>Placeholders</button>
            <button style={{ ...s.tab, ...(tool === 'patch' ? s.tabOn : {}) }} onClick={() => { setTool('patch'); setSel(null); }}>Patch artwork</button>
          </div>

          {tool === 'slots' ? (
            <>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button style={s.btnSm} onClick={() => addSlot('number')} disabled={!artwork}>+ Number</button>
                <button style={s.btnSm} onClick={() => addSlot('text')} disabled={!artwork}>+ Name</button>
              </div>

              {!slots.length && <div style={s.empty}>No placeholders yet. Add one, then drag its box over the text area.</div>}

              {slots.map((sl, i) => (
                <div key={sl.key} style={{ ...s.card, borderColor: sel?.kind === 'slot' && sel.i === i ? '#2E7D32' : '#DCE5DE' }}
                  onClick={() => { setSel({ kind: 'slot', i }); setTool('slots'); }}>
                  <div style={s.cardHead}>
                    <code style={s.code}>{`{${sl.key}}`}</code>
                    <button style={s.link} onClick={e => { e.stopPropagation(); removeSlot(i); }}>Remove</button>
                  </div>
                  <div style={s.row}>
                    <div style={{ flex: 1 }}>
                      <div style={s.mini}>Label (shown to the customer)</div>
                      <input style={s.input} value={sl.label} onChange={e => patchSlot(i, { label: e.target.value })} />
                    </div>
                    <div style={{ width: 72 }}>
                      <div style={s.mini}>Max</div>
                      <input style={s.input} type="number" min={1} max={40} value={sl.maxLen}
                        onChange={e => patchSlot(i, { maxLen: Math.max(1, +e.target.value || 1) })} />
                    </div>
                  </div>
                  <div style={s.row}>
                    <div style={{ flex: 1 }}>
                      <div style={s.mini}>Default value</div>
                      <input style={s.input} value={sl.default}
                        onChange={e => { patchSlot(i, { default: e.target.value }); setValues(v => ({ ...v, [sl.key]: e.target.value })); }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={s.mini}>Style</div>
                      <select style={s.select} value={sl.style_key ?? ''} onChange={e => patchSlot(i, { style_key: e.target.value || null })}>
                        <option value="">Select…</option>
                        {styles.map(x => <option key={x.id} value={x.key}>{x.label}</option>)}
                      </select>
                    </div>
                  </div>
                  <div style={s.row}>
                    <div style={{ flex: 1 }}>
                      <div style={s.mini}>Rotation ({Math.round(sl.rect.rot || 0)}°)</div>
                      <input type="range" min={-45} max={45} step={1} value={sl.rect.rot || 0}
                        onChange={e => patchSlot(i, { rect: { ...sl.rect, rot: +e.target.value } })} style={{ width: '100%' }} />
                    </div>
                  </div>

                  <div style={s.coverBox}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                      <input type="checkbox" checked={!!sl.cover}
                        onChange={e => patchSlot(i, { cover: e.target.checked ? { from: findCleanSource(artwork, sl.rect) } : null })} />
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#2C4433' }}>Erase what's underneath</span>
                    </label>
                    <div style={{ fontSize: 11, color: '#6B8C74', marginTop: 4, lineHeight: 1.5 }}>
                      {sl.cover
                        ? 'Anything printed under the box (like a baked-in "2") is erased. Size the box to cover it.'
                        : 'Off — anything already printed under the box stays visible.'}
                    </div>
                  </div>
                </div>
              ))}

              {selSlot && selStyle && (
                <div style={{ ...s.card, background: '#FBF7EF', borderColor: '#E6D9BE' }}>
                  <div style={s.cardHead}>
                    <b style={{ fontSize: 12, color: '#7A5E1F' }}>Style — {selStyle.label}</b>
                    <span style={{ fontSize: 11, color: isDraft ? '#7A5E1F' : '#9a8a63', fontWeight: isDraft ? 700 : 400 }}>
                      {isDraft
                        ? (isUpdate ? 'edited — will restyle every template using it' : 'edited — will be saved as a new style')
                        : 'shared by every template using it'}
                    </span>
                  </div>

                  <div style={s.mini}>Look</div>
                  <select style={s.select} value={selStyle.algorithm} onChange={e => chooseLook(e.target.value)}>
                    {Object.entries(LOOKS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
                  </select>

                  <label style={{ ...s.fileBox, marginTop: 8 }}>
                    <input type="file" accept=".woff2,.woff,font/woff2,font/woff" style={{ display: 'none' }}
                      onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFont(f); }} />
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#7A5E1F' }}>
                      {cfg.font?.url ? `Font: ${cfg.font.family}` : 'Upload typeface (.woff2)'}
                    </div>
                    <div style={{ fontSize: 11, color: '#9a8a63', marginTop: 2 }}>The face is data — a new look never needs a code change.</div>
                  </label>

                  {/* Colours belong to THIS artwork (the slot's style_override), not to the shared preset. */}
                  <div style={s.row}>
                    {look.swatches.map(([label, path]) => (
                      <Swatch key={path} label={label} value={atPath(st, path)} onChange={v => editSlotColor(path, v)} />
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: '#9a8a63', marginTop: 4, lineHeight: 1.5 }}>
                    {selSlot.autoColor
                      ? 'Colour taken from what the placeholder covers — this artwork\'s own value.'
                      : 'Colour set by hand for this template. The Look below is what\'s shared.'}
                  </div>

                  <button style={{ ...s.btnSm, marginTop: 8, width: '100%', ...(picking ? s.btnSmOn : null) }}
                    disabled={!patched}
                    onClick={() => setPicking(p => (p ? null : look.swatches[0][1]))}>
                    {picking ? 'Click the artwork to sample that colour…' : `Pick ${look.swatches[0][0].toLowerCase()} colour from the artwork`}
                  </button>

                  {[...look.sliders, ...COMMON_SLIDERS].map(([label, path, min, max, step, fmt]) => (
                    <Slider key={path} label={label} min={min} max={max} step={step} fmt={fmt}
                      value={atPath(st, path)} onChange={v => editStylePath(path, v)} />
                  ))}

                  {isDraft && (
                    <div style={s.draftBox}>
                      {isUpdate ? (
                        <>
                          <div style={{ fontSize: 12, color: '#c0392b', fontWeight: 700, lineHeight: 1.5 }}>
                            Restyling “{selStyle.label}” itself — every template already using it changes too.
                          </div>
                          <button style={{ ...s.btnSm, marginTop: 8 }}
                            onClick={() => setMode(m => ({ ...m, [selStyle.id]: 'fork' }))}>
                            No — save this as a new style instead
                          </button>
                        </>
                      ) : (
                        <>
                          <div style={s.mini}>Save as a new style named</div>
                          <input style={s.input} value={draftLabel[selStyle.id] ?? suggestLabel(selStyle)}
                            onChange={e => setDraft(d => ({ ...d, [selStyle.id]: e.target.value }))} />
                          <div style={{ fontSize: 11, color: '#9a8a63', marginTop: 5, lineHeight: 1.5 }}>
                            Saved with the topper. “{selStyle.label}” is left as it is, so the templates using
                            it don&apos;t change.
                          </div>
                          <button style={{ ...s.btnSm, marginTop: 8 }}
                            onClick={() => setMode(m => ({ ...m, [selStyle.id]: 'update' }))}>
                            Update “{selStyle.label}” everywhere instead
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {selSlot && !selStyle && (
                <div style={{ ...s.card, background: '#FBF7EF', borderColor: '#E6D9BE' }}>
                  <div style={{ fontSize: 12, color: '#7A5E1F', lineHeight: 1.6 }}>
                    This placeholder has no style — the default one couldn't be created (is the API running?).
                    Pick a style above, or create one from the defaults.
                  </div>
                  <button style={{ ...s.btnSm, marginTop: 8 }}
                    onClick={async () => {
                      try {
                        const key = await ensureStyle();
                        patchSlot(sel.i, { style_key: key });
                      } catch (err) {
                        setMsg({ ok: false, text: `Could not create the default text style: ${err.message}` });
                      }
                    }}>
                    Create the default style
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <button style={{ ...s.btnSm, marginTop: 10 }} onClick={addPatch} disabled={!artwork}>+ Patch region</button>
              {!patches.length && <div style={s.empty}>Only needed if the artwork has a value baked in (like the "2"). Drag the red box over it, and the red dot to a clean area to clone from.</div>}
              {patches.map((p, i) => (
                <div key={i} style={{ ...s.card, borderColor: sel?.kind === 'patch' && sel.i === i ? '#c0392b' : '#DCE5DE' }}
                  onClick={() => setSel({ kind: 'patch', i })}>
                  <div style={s.cardHead}>
                    <b style={{ fontSize: 12, color: '#2C4433' }}>Patch {i + 1}</b>
                    <button style={s.link} onClick={e => { e.stopPropagation(); setPatches(l => l.filter((_, j) => j !== i)); setSel(null); }}>Remove</button>
                  </div>
                  <div style={{ fontSize: 11, color: '#6B8C74' }}>Red box = what gets covered. Red dot = the clean region cloned over it.</div>
                </div>
              ))}
            </>
          )}

          <button style={{ ...s.btn, opacity: busy ? 0.6 : 1 }} disabled={!!busy} onClick={handleSave}>
            {busy || 'Save text topper'}
          </button>
          {msg && <div style={{ ...s.msg, color: msg.ok ? '#2e7d32' : '#c0392b' }}>{msg.text}</div>}
        </div>

        <div style={s.col}>
          <label style={s.label}>Live preview</label>
          <canvas ref={canvasRef} width={460} height={460} style={s.canvas}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />

          {slots.length > 0 && (
            <div style={{ ...s.card, marginTop: 12 }}>
              <div style={s.cardHead}><b style={{ fontSize: 12, color: '#2C4433' }}>Try a value</b></div>
              <div style={{ fontSize: 11, color: '#6B8C74', marginBottom: 8 }}>
                What the customer types. The artwork never changes — only the placeholder.
              </div>
              {slots.map(sl => (
                <div key={sl.key} style={{ marginBottom: 8 }}>
                  <div style={s.mini}>{sl.label} <code style={s.code}>{`{${sl.key}}`}</code></div>
                  <input style={s.input} maxLength={sl.maxLen}
                    value={values[sl.key] ?? sl.default ?? ''}
                    inputMode={sl.kind === 'number' ? 'numeric' : 'text'}
                    onChange={e => {
                      const raw = e.target.value;
                      const v = sl.kind === 'number' ? raw.replace(/[^0-9]/g, '') : raw;
                      setValues(x => ({ ...x, [sl.key]: v }));
                    }} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Swatch({ label, value, onChange }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={s.mini}>{label}</div>
      <input type="color" value={value} onChange={e => onChange(e.target.value)}
        style={{ width: '100%', height: 32, border: '1.5px solid #C5D4C8', borderRadius: 6, cursor: 'pointer', padding: 2, background: '#fff' }} />
    </div>
  );
}

function Slider({ label, min, max, step, value, onChange, fmt }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={s.mini}>{label} — {fmt ? fmt(value) : (+value).toFixed(3)}</div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(+e.target.value)} style={{ width: '100%' }} />
    </div>
  );
}

const s = {
  page:    { maxWidth: 1080, margin: '0 auto', padding: '24px 20px 64px', fontFamily: "'Quicksand', sans-serif" },
  h1:      { fontSize: 22, fontWeight: 800, color: '#2C4433', margin: '0 0 6px' },
  sub:     { fontSize: 13, color: '#5C7565', lineHeight: 1.6, margin: '0 0 16px' },
  specBox: { marginBottom: 22, padding: '12px 16px', borderRadius: 10, background: '#FBF7EF', border: '1px solid #E6D9BE' },
  specTitle: { fontSize: 11, fontWeight: 800, color: '#7A5E1F', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 },
  specList: { margin: 0, paddingLeft: 18, fontSize: 12, color: '#5b5340', lineHeight: 1.7 },
  grid:    { display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-start' },
  col:     { flex: '1 1 380px', minWidth: 340, display: 'flex', flexDirection: 'column' },
  label:   { fontSize: 12, fontWeight: 700, color: '#2C4433', margin: '12px 0 4px' },
  mini:    { fontSize: 11, fontWeight: 700, color: '#6B8C74', margin: '6px 0 3px' },
  input:   { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontSize: 13, fontFamily: 'inherit', outline: 'none' },
  select:  { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1.5px solid #C5D4C8', fontSize: 13, fontFamily: 'inherit', background: '#fff' },
  fileBox: { display: 'block', marginTop: 10, padding: '12px 14px', borderRadius: 10, border: '1.5px dashed #C5D4C8', background: '#F7FAF8', cursor: 'pointer' },
  toolRow: { display: 'flex', gap: 6, marginTop: 16, borderBottom: '1.5px solid #E3EAE5', paddingBottom: 0 },
  tab:     { padding: '8px 14px', border: 'none', background: 'none', fontSize: 13, fontWeight: 700, color: '#8AA292', cursor: 'pointer', fontFamily: 'inherit', borderBottom: '2.5px solid transparent' },
  tabOn:   { color: '#2C4433', borderBottom: '2.5px solid #3D5A44' },
  card:    { marginTop: 10, padding: '10px 12px', borderRadius: 10, border: '1.5px solid #DCE5DE', background: '#fff', cursor: 'pointer' },
  cardHead:{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  code:    { fontSize: 11, fontWeight: 700, color: '#3D5A44', background: '#EEF5F0', padding: '2px 6px', borderRadius: 5, fontFamily: 'ui-monospace, monospace' },
  row:     { display: 'flex', gap: 8, alignItems: 'flex-end' },
  link:    { border: 'none', background: 'none', color: '#c0392b', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', padding: 0 },
  coverBox:{ marginTop: 10, paddingTop: 9, borderTop: '1px solid #EDF2EE' },
  empty:   { marginTop: 10, padding: '10px 12px', borderRadius: 8, background: '#F7FAF8', border: '1px dashed #D6E3DA', fontSize: 12, color: '#6B8C74', lineHeight: 1.5 },
  btn:     { marginTop: 18, padding: '11px 16px', borderRadius: 10, border: 'none', background: '#3D5A44', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnSm:   { padding: '7px 12px', borderRadius: 8, border: '1.5px solid #C5D4C8', background: '#fff', color: '#2C4433', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnSmOn: { borderColor: '#3D5A44', background: '#EEF5F0', color: '#3D5A44' },
  draftBox:{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #E6D9BE' },
  msg:     { marginTop: 10, fontSize: 13, fontWeight: 700 },
  canvas:  { width: 460, height: 460, maxWidth: '100%', borderRadius: 12, border: '1.5px solid #C5D4C8', background: '#fff', touchAction: 'none', cursor: 'crosshair' },
};
