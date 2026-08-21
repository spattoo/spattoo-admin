import { supabase } from './supabase.js';
import { encodeWebp } from '@spattoo/designer';

// Trailing slash stripped, because every caller below writes `${BASE_URL}/api/…`. Configured as
// "https://api.spattoo.com/" that builds "…com//api/…", which is a different path to the router and
// 404s on every request — with nothing in the message naming the cause. A deployment typo should not
// be able to take the whole app down, so it is absorbed here rather than relied on being typed right.
const BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

async function authHeaders() {
  const { data: { session } } = await supabase.auth.getSession();
  return {
    'Authorization': `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  };
}

export async function removeBg(blob) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${BASE_URL}/api/admin/remove-bg`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': blob.type || 'image/png',
    },
    body: blob,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.blob(); // returns PNG Blob with transparent background
}

async function parseError(res) {
  const text = await res.text();
  try { return JSON.parse(text).error ?? res.statusText; } catch { return res.statusText; }
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: await authHeaders() });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function patch(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PATCH',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function put(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PUT',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export { get };

// ── Flavour ↔ dietary baseline ────────────────────────────────────────────────
// The GLOBAL default: what a flavour cannot be made as, for every baker ("hazelnut
// praline is not nut-free"). Per-kitchen facts ("we don't do eggless tiramisu") are the
// baker's to state in their own settings, never authored here.
//
// It is a DEFAULT, not a verdict — any baker can overturn any row, which is what keeps
// it consistent with ToS §3.4 (Spattoo records, and verifies nothing). It drives a
// warning that points the customer at the baker; it never blocks an order.
export async function fetchFlavourDietaryConflicts() {
  return get('/api/admin/flavours/dietary-conflicts');
}
export async function updateFlavourDietaryConflicts(flavourId, requirementKeys) {
  return put(`/api/admin/flavours/${flavourId}/dietary-conflicts`, { requirementKeys });
}
export async function fetchDietaryRequirements() {
  return get('/api/dietary-requirements');
}

export async function fetchElementTypes() {
  return get('/api/element-types');
}

// ── Browsing categories (migration 065) ────────────────────────────────────────
// What a decoration IS, as opposed to element-types, which is how it behaves. The ADMIN list, not
// the customer one: it includes empty and retired categories, because an element has to be
// assignable to a category before that category has anything in it.
export async function fetchAdminElementCategories() {
  return get('/api/admin/element-categories');
}

export async function createElementCategory(name) {
  return post('/api/admin/element-categories', { name });
}

// Rename, reorder, retire, re-picture. No delete: the FK is ON DELETE SET NULL, so removing a
// category would silently strip it off every element it held with no way back.
//
// `thumb_key: null` CLEARS the category's own picture and returns it to borrowing an element's
// thumbnail. That is a real edit, so it must reach the server as an explicit null rather than being
// dropped as "nothing to change" — see the route, which distinguishes absent from null.
export async function updateElementCategory(id, fields) {
  return patch(`/api/admin/element-categories/${id}`, fields);
}

// A category's own menu picture — typically a hand-made collage of a few of its decorations. Its own
// folder (migration 068), so a category picture is never mistaken for an element's thumbnail when
// somebody is reading the bucket.
//
// Through uploadThumbnail, NOT uploadAsset: this is a thumbnail, and that function is the one place
// thumbnail uploads pick their format. It re-encodes to WebP with the alpha kept, and derives the
// extension, the content-type signed into the URL and the PUT header from the encoded blob so the
// three can never disagree. Uploading the raw file instead — which this did at first — put a 900KB
// PNG in a menu that loads all eleven categories at once, and did it in a format nothing else here
// uses.
//
// Background is deliberately NOT removed. An element gets that because a photographed decal has to be
// cut out; a category picture is a collage somebody composed, and its background is part of the
// composition. It is also a paid call. If one does need cutting out, admin already has a screen for
// it (BackgroundRemover) — better than spending credits on every upload for the rare case.
export async function uploadCategoryThumbnail(file) {
  return uploadThumbnail('categories/thumbnails', file);
}

// ── Cake textures (cream finish/style config) ──────────────────────────────────
export async function fetchTextures()            { return get('/api/textures'); }
export async function fetchAdminTextures()       { return get('/api/admin/textures'); }
export async function createTexture(payload)     { return post('/api/admin/textures', payload); }
export async function updateTexture(id, payload) { return patch(`/api/admin/textures/${id}`, payload); }

// ── Text styles (the look of an editable {name}/{number} placeholder) ──────────
export async function fetchTextStyles()            { return get('/api/text-styles'); }
export async function fetchAdminTextStyles()       { return get('/api/admin/text-styles'); }
export async function createTextStyle(payload)     { return post('/api/admin/text-styles', payload); }
export async function updateTextStyle(id, payload) { return patch(`/api/admin/text-styles/${id}`, payload); }

// ── Cake shapes (the catalog of tier footprints: round, sheet, heart, butterfly…) ─
export async function fetchCakeShapes()            { return get('/api/cake-shapes'); }
export async function fetchAdminCakeShapes()       { return get('/api/admin/cake-shapes'); }
export async function createCakeShape(payload)     { return post('/api/admin/cake-shapes', payload); }
export async function updateCakeShape(id, payload) { return patch(`/api/admin/cake-shapes/${id}`, payload); }

// ── Materials (frosting material + its ordered style list) ─────────────────────
export async function fetchMaterials()            { return get('/api/materials'); }
export async function fetchAdminMaterials()       { return get('/api/admin/materials'); }
export async function createMaterial(payload)     { return post('/api/admin/materials', payload); }
export async function updateMaterial(id, payload) { return patch(`/api/admin/materials/${id}`, payload); }

export async function fetchAdminElementTypes() {
  return get('/api/admin/element-types');
}

export async function createElementType(payload) {
  return post('/api/admin/element-types', payload);
}

export async function updateElementType(id, payload) {
  const res = await fetch(`${BASE_URL}/api/admin/element-types/${id}`, {
    method: 'PATCH',
    headers: await authHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function fetchParentElements(elementTypeId) {
  return get(`/api/elements?parents_only=true&element_type_id=${elementTypeId}`);
}

// `contentLength` is REQUIRED by the API and is signed into the URL: R2 rejects a PUT whose body is a
// different length, which is what makes the per-folder size ceiling enforceable at all (the body goes
// browser → R2 and never passes through our server, so a client-side check is advice, not a limit).
// Callers should not reach for this directly — use `uploadBlob`, which cannot get the length wrong.
export async function getSignedUploadUrl(folder, filename, contentType, contentLength) {
  return post('/api/storage/sign-upload', { folder, filename, contentType, contentLength });
}

// Sign + PUT, in ONE place. Every upload in this app was the same copy-pasted pair — sign, then
// uploadToR2 — repeated at 14 call sites, and the signed Content-Length turned that duplication from
// untidy into dangerous: 14 chances to sign one length and send a body of another (an upload that
// fails at R2 with a signature error, which reads like a credentials bug). The length is now derived
// from the very blob that is PUT, so it cannot disagree.
export async function uploadBlob(folder, filename, blob, contentType = blob.type) {
  const { url, key, publicUrl } = await getSignedUploadUrl(folder, filename, contentType, blob.size);
  await uploadToR2(url, blob, contentType);
  return { key, publicUrl };
}

// ── Extract Elements ─────────────────────────────────────────────────────────────────────────
// Point at a reference cake photo, get back the decorations on it as candidates, choose what each
// one is FOR, and regenerate the chosen ones as isolated images.
//
// `intent` selects the prompt recipe server-side (migration 062) and is settable only BEFORE
// generation — a generated image cannot be re-purposed by relabelling it, because the recipe
// shaped how it was drawn.
export async function identifyCandidates(sourceKey)      { return post('/api/admin/element-extract/identify', { sourceKey }); }
export async function generateCandidates(candidateIds, variants = 1) { return post('/api/admin/element-extract/generate', { candidateIds, variants }); }
export async function fetchExtractJob(jobId)             { return get(`/api/admin/element-extract/${jobId}`); }
export async function updateCandidate(id, body)          { return patch(`/api/admin/element-extract/candidates/${id}`, body); }

// Delete a managed R2 object. Accepts a bare key or a full public URL; the API
// normalizes it and refuses anything outside the managed asset folders.
export async function deleteR2Object(key) {
  return post('/api/storage/delete', { key });
}

// `contentType` defaults to the blob/file's own type, but callers can override it so the PUT header
// matches the type the presigned URL was signed with (a File from <input> can have an empty .type).
export async function uploadToR2(signedUrl, file, contentType) {
  const res = await fetch(signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType || file.type },
    body: file,
  });
  if (!res.ok) throw new Error('Upload to R2 failed');
}

// Store a MASTER asset (GLB or 2D image) in R2 under `folder` and return its key. Unlike
// uploadThumbnail it does NOT transcode — assets keep their authored format — but it derives the
// extension AND Content-Type from one source so the signed type, the sent type, and the stored
// object always agree (a canvas/remove-bg Blob has a reliable .type; a File from <input> may have an
// empty .type, so we fall back to its filename extension). The ONE place asset uploads pick format.
const MIME_BY_EXT = { glb: 'model/gltf-binary', gltf: 'model/gltf-binary', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
const EXT_BY_MIME = { 'model/gltf-binary': 'glb', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
export async function uploadAsset(folder, file, basename = crypto.randomUUID()) {
  const nameExt = (file.name?.split('.').pop() || '').toLowerCase();
  const contentType = file.type || MIME_BY_EXT[nameExt] || 'application/octet-stream';
  const ext = EXT_BY_MIME[contentType] || nameExt || 'bin';
  const { key } = await uploadBlob(folder, `${basename}.${ext}`, file, contentType);
  return key;
}

// Store a webfont for a text style and return its PUBLIC URL — deliberately NOT a bare key. A style's
// `config.font.url` is read straight out of jsonb by the renderer's FontFace loader, and the API only
// expands key columns it knows about (image_url, thumbnail_url), never nested jsonb. Same reason the
// photo-cake frame stores a full URL inside its design JSON.
export async function uploadFont(file) {
  const isWoff = (file.name?.split('.').pop() || '').toLowerCase() === 'woff';
  const ext = isWoff ? 'woff' : 'woff2';
  const contentType = isWoff ? 'font/woff' : 'font/woff2';
  const { key, publicUrl } = await uploadBlob('elements/fonts', `${crypto.randomUUID()}.${ext}`, file, contentType);
  return publicUrl || key;
}

// Store an image blob as a WebP thumbnail in R2 under `folder` and return its key.
// Normalizes the source to WebP (alpha preserved) so masters never land as PNG —
// the source can be a direct canvas capture, a remove.bg PNG, or already-WebP; all
// come out WebP (server then bakes the smaller picker variant). The R2 signed PUT
// signs the content-type, so the extension, the type sent to sign-upload, and
// uploadToR2's header must all agree — we derive all three from the encoded blob's
// MIME, which also makes the PNG fallback (browsers that can't encode WebP via
// canvas) self-consistent. The ONE place thumbnail uploads pick their format.
const IMAGE_EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };
export async function uploadThumbnail(folder, blob, basename = crypto.randomUUID()) {
  const webp = await encodeWebp(blob);
  const ext = IMAGE_EXT[webp.type] ?? 'png';
  const { key } = await uploadBlob(folder, `${basename}.${ext}`, webp);
  return key;
}

export async function fetchAllElements() {
  return get('/api/admin/elements');
}

// One element by id — for an authoring surface opened against a specific element (Relief Sticker
// Studio via ?element=<id>). Never fetch the whole library to read a single row.
export async function fetchGlobalElement(id) {
  return get(`/api/admin/elements/${id}`);
}

// The same element as the DESIGNER receives it — public URLs for the top-level image columns AND
// for the keys nested inside placement_config (a photo frame's mask, alternate piping GLBs). The
// plain fetch above deliberately returns raw keys, because the edit form has to write them back;
// the renderer needs URLs. Two shapes of one row, one for each job.
export async function fetchElementForPreview(id) {
  return get(`/api/admin/elements/${id}/preview`);
}

// ── Promotion: dev → prod ────────────────────────────────────────────────────────────────────────
// See spattoo-docs/plans/element-preview-and-publish.md. The bundle is JSON: rows verbatim (ids
// included — that is what makes template/shape designs keep resolving) plus each R2 object named by
// KEY and a URL to fetch it from. Asset bytes are never in the file.
export async function exportElements(ids) {
  return get(`/api/admin/elements/export?ids=${ids.map(encodeURIComponent).join(',')}`);
}

// dryRun reports create-vs-update per table and writes nothing — the mode to use first, because the
// number worth seeing is how many rows an import is about to overwrite.
export async function importElements(bundle, { dryRun = false } = {}) {
  return post(`/api/admin/elements/import${dryRun ? '?dryRun=true' : ''}`, bundle);
}

// Templates carry their referenced ELEMENTS with them — a design embeds elementId, and a template
// whose elements are absent renders correctly and misbehaves quietly. Same bundle format as the
// element export, with the template rows added, so one import screen receives both.
// Copy a bakery's template into the global catalogue. A COPY — the bakery keeps its own row.
// Refused unless that bakery is flagged is_catalog_author (migration 070), which is what keeps other
// bakers' work theirs, and what makes this dev-only without an environment check.
export async function publishTemplate(id) {
  return post(`/api/admin/templates/${id}/publish`, {});
}

export async function exportTemplates(ids) {
  return get(`/api/admin/templates/export?ids=${ids.map(encodeURIComponent).join(',')}`);
}

export async function createGlobalElement(payload) {
  return post('/api/admin/elements', payload);
}

// ── Image → 3D wizard (Meshy.ai) ──────────────────────────────────────────────
// Run the validation gate + kick off a Meshy image-to-3D task for an already-uploaded
// source image (R2 key under meshy/source/). A gate rejection comes back as { ok:false,
// reason, category } (HTTP 200, no credits spent); success is { ok:true, id, status, ... }.
export async function startMeshyGeneration(sourceImageKey, force = false) {
  return post('/api/admin/meshy/generate', { sourceImageKey, force });
}

// Poll a generation row. While non-terminal the API live-polls Meshy and updates the row,
// so this returns fresh { status, progress, glb_url, thumbnail_url, error }.
export async function getMeshyGeneration(id) {
  return get(`/api/admin/meshy/${id}`);
}

// Build from Inspiration: validate + analyse a cake photo → tier-wise reconstruction spec.
// Sends the image as base64 (no upload). Returns { ok:true, analysis } or { ok:false, reason }.
export async function analyzeInspiration(imageBlob) {
  const bytes = new Uint8Array(await imageBlob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return post('/api/admin/inspiration/analyze', { imageBase64: btoa(binary), mimeType: imageBlob.type || 'image/jpeg' });
}

// Match an analysis spec's decorations to library elements → per-tier matches + coverage.
export async function matchInspiration(analysis) {
  return post('/api/admin/inspiration/match', { analysis });
}

export async function updateGlobalElement(id, payload) {
  const res = await fetch(`${BASE_URL}/api/admin/elements/${id}`, {
    method: 'PATCH',
    headers: await authHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function fetchAdminTemplates() {
  return get('/api/admin/templates');
}

export async function createTemplate(payload) {
  return post('/api/admin/templates', payload);
}

export async function deleteTemplate(id) {
  const res = await fetch(`${BASE_URL}/api/admin/templates/${id}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function updateTemplate(id, payload) {
  const res = await fetch(`${BASE_URL}/api/admin/templates/${id}`, {
    method: 'PATCH',
    headers: await authHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function createBaker(payload) {
  return post('/api/admin/bakers', payload);
}

export async function fetchAdminBakers() {
  return get('/api/admin/bakers');
}

export async function createPattern(payload) {
  return post('/api/admin/patterns', payload);
}

// ── Nozzle catalog ─────────────────────────────────────────────────────────────

export async function fetchNozzles() {
  return get('/api/nozzles');
}

export async function createNozzle(payload) {
  return post('/api/admin/nozzles', payload);
}

// Bulk import from the paste screen. rows: [{ brand, number, name, category, description, is_common, sort_order }]
// Returns { created, skipped, errors: [{ row, reason }] }.
export async function bulkCreateNozzles(rows) {
  return post('/api/admin/nozzles/bulk', { nozzles: rows });
}

export async function updateNozzle(id, payload) {
  return patch(`/api/admin/nozzles/${id}`, payload);
}

export async function deleteNozzle(id) {
  const res = await fetch(`${BASE_URL}/api/admin/nozzles/${id}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// ── Craft guide (X-Ray baker how-to-make-it metadata) ──────────────────────────

// Returns the craft guide for one element, or null if it hasn't been authored.
export async function getCraftGuide(elementId) {
  return get(`/api/admin/craft-guide/${elementId}`);
}

// GPT-suggest a craft guide from an image (base64 pre-upload, or a public image_url),
// grounded on the nozzle catalog. payload: { imageBase64, mimeType } OR { image_url },
// plus { name, description }. Returns { nozzle_recs, consistency, technique }.
export async function suggestCraftGuide(payload) {
  return post('/api/admin/craft-guide/suggest', payload);
}

// Upsert. payload: { nozzle_recs: [{ nozzle_id, brand, number, name, rank, confidence }], consistency, technique }
export async function saveCraftGuide(elementId, payload) {
  const res = await fetch(`${BASE_URL}/api/admin/craft-guide/${elementId}`, {
    method: 'PUT',
    headers: await authHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// ── Decoration guide (X-Ray "how do I make this") ─────────────────────────────

// The MODELLING guide for one element: steps, colours, and the build-sequence picture.
//
// Separate from getCraftGuide, which reads the NOZZLE guide. They are two rows on the same
// sidecar table (element_craft_guide, keyed by guide_type) answering different questions —
// which tip pipes this, versus how do I make this by hand.
//
// Also returns `policy` — what X-Ray WOULD offer for this decoration — so an absent guide can be
// explained rather than shown as an empty panel. "This is a printed sheet" and "nobody has
// generated one yet" look identical otherwise, and only one is worth acting on.
export async function getDecorationGuide(elementId) {
  return get(`/api/admin/elements/${elementId}/decoration-guide`);
}

// Build or rebuild it. UNMETERED — this is our catalogue, and its guides were never a baker's to
// pay for. `force` replaces an existing guide; without it an existing one returns 409, so nobody
// silently overwrites a guide a human has already read and approved.
// `quality` overrides the image quality for THIS call only — 'low' | 'medium' | 'high'. The
// catalogue default is low because it is legible and a quarter of the cost; medium is for the
// occasional decoration too intricate to read at low, without quadrupling the cost of every guide.
export async function buildDecorationGuide(elementId, { force = false, quality } = {}) {
  return post(`/api/admin/elements/${elementId}/decoration-guide`, { force, quality });
}

// Remove a decoration guide entirely — for a decoration that should NOT have one, where a rebuild
// would only produce a better wrong answer. The picture is archived under deleted/ rather than
// destroyed: it cost money to generate and the model will not return the same image twice.
export async function deleteDecorationGuide(elementId) {
  const res = await fetch(`${BASE_URL}/api/admin/elements/${elementId}/decoration-guide`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// ── Tags ──────────────────────────────────────────────────────────────────────

export async function fetchAllTags() {
  return get('/api/admin/tags');
}

export async function createTag(payload) {
  return post('/api/admin/tags', payload);
}

export async function updateTag(id, payload) {
  return patch(`/api/admin/tags/${id}`, payload);
}

export async function deleteTag(id) {
  const res = await fetch(`${BASE_URL}/api/admin/tags/${id}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function fetchElementTags(elementId) {
  return get(`/api/admin/elements/${elementId}/tags`);
}

export async function saveElementTags(elementId, tagIds) {
  const res = await fetch(`${BASE_URL}/api/admin/elements/${elementId}/tags`, {
    method: 'PUT',
    headers: await authHeaders(),
    body: JSON.stringify({ tagIds }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function retagElement(elementId) {
  return post(`/api/admin/elements/${elementId}/retag`, {});
}

export async function fetchTemplateTags(templateId) {
  return get(`/api/admin/templates/${templateId}/tags`);
}

export async function saveTemplateTags(templateId, tagIds) {
  const res = await fetch(`${BASE_URL}/api/admin/templates/${templateId}/tags`, {
    method: 'PUT',
    headers: await authHeaders(),
    body: JSON.stringify({ tagIds }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function fetchTemplateAttrs(templateId) {
  return get(`/api/admin/templates/${templateId}/attrs`);
}

export async function saveTemplateAttrs(templateId, attrs) {
  const res = await fetch(`${BASE_URL}/api/admin/templates/${templateId}/attrs`, {
    method: 'PUT',
    headers: await authHeaders(),
    body: JSON.stringify(attrs),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

// ── RBAC (roles & capabilities) ─────────────────────────────────────────────

// The current user's resolved role + capabilities (server-authoritative).
export async function fetchMe() {
  return get('/api/me');
}

// { roles, capabilities, matrix: { roleKey: [capabilityKey, ...] } }
export async function fetchRbac() {
  return get('/api/admin/rbac');
}

export async function createCapability(payload) {
  return post('/api/admin/capabilities', payload);
}

// Replace a role's full capability set. capabilities: [key, ...]
export async function setRoleCapabilities(roleKey, capabilities) {
  const res = await fetch(`${BASE_URL}/api/admin/roles/${roleKey}/capabilities`, {
    method: 'PUT',
    headers: await authHeaders(),
    body: JSON.stringify({ capabilities }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function suggestElementMeta(thumbnailBlob, elementType) {
  const arrayBuffer = await thumbnailBlob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  const base64 = btoa(binary);
  const res = await fetch(`${BASE_URL}/api/admin/elements/suggest`, {
    method: 'POST',
    headers: { ...await authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64: base64, mimeType: thumbnailBlob.type || 'image/png', elementType }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

