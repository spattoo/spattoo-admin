import { supabase } from './supabase.js';
import { encodeWebp } from './thumbnail.js';

const BASE_URL = import.meta.env.VITE_API_URL;

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

export { get };

export async function fetchElementTypes() {
  return get('/api/element-types');
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

export async function getSignedUploadUrl(folder, filename, contentType) {
  return post('/api/storage/sign-upload', { folder, filename, contentType });
}

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
  const { url, key } = await getSignedUploadUrl(folder, `${basename}.${ext}`, contentType);
  await uploadToR2(url, file, contentType);
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
  const { url, key, publicUrl } = await getSignedUploadUrl('elements/fonts', `${crypto.randomUUID()}.${ext}`, contentType);
  await uploadToR2(url, file, contentType);
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
  const { url, key } = await getSignedUploadUrl(folder, `${basename}.${ext}`, webp.type);
  await uploadToR2(url, webp);
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

