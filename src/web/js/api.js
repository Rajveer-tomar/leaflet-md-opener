// Thin client for the local Leaflet server (src/Leaflet.ps1).
// Every URL is relative, so it carries the per-session token in the page path.

const API = '__leaflet__/api/';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function request(route, { method = 'GET', query, body } = {}) {
  const url = new URL(API + route, location.href);
  if (query) Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));

  let response;
  try {
    response = await fetch(url, {
      method,
      cache: 'no-store',
      headers: body === undefined ? { 'X-Leaflet': '1' } : { 'X-Leaflet': '1', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, { error: 'offline' });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data);
  return data;
}

export const api = {
  session: () => request('session'),
  files: () => request('files').then((d) => d.files || []),
  readFile: (name) => request('file', { query: { name } }),
  saveFile: (name, text, baseMtime, force = false) =>
    request('file', { method: 'PUT', query: { name }, body: { text, baseMtime, force } }),
  createFile: (name, text) =>
    request('file', { method: 'PUT', query: { name }, body: { text, create: true } }),
  loadSettings: () => request('settings').catch(() => ({})),
  saveSettings: (settings) => request('settings', { method: 'PUT', body: settings }).catch(() => {}),
  // sendBeacon survives the page closing, which fetch does not.
  bye: () => navigator.sendBeacon(new URL(API + 'bye', location.href)),
};
