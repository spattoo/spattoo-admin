import { supabase } from './supabase.js';

const BASE_URL = import.meta.env.VITE_API_URL;

async function authHeaders() {
  const { data: { session } } = await supabase.auth.getSession();
  return {
    'Authorization': `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  };
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: await authHeaders() });
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
  return res.json();
}

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
  return res.json();
}

export async function fetchElementTypes() {
  return get('/api/element-types');
}

export async function fetchParentElements(elementTypeId) {
  return get(`/api/elements?parents_only=true&element_type_id=${elementTypeId}`);
}

export async function getSignedUploadUrl(folder, filename, contentType) {
  return post('/api/storage/sign-upload', { folder, filename, contentType });
}

export async function uploadToR2(signedUrl, file) {
  const res = await fetch(signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!res.ok) throw new Error('Upload to R2 failed');
}

export async function createGlobalElement(payload) {
  return post('/api/admin/elements', payload);
}
