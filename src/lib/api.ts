/**
 * Client for the Cloud API.
 *
 * Authentication works differently here than in the iOS app. The browser
 * already has a YunoHost portal session, so instead of a password this client
 * exchanges that session for a short-lived access token at /api/sso/session,
 * keeps it in memory, and re-mints it when it expires. Nothing is written to
 * localStorage or a cookie: on reload the exchange simply happens again.
 */

// Vite's `base` is the sub-path the app is installed under ("/cloud/").
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

export const API = `${BASE}/api/v1`;
const SSO_SESSION = `${BASE}/api/sso/session`;

//=================================================
// Types — mirrors of the server's JSON shapes
//=================================================

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | null;

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
  ctime: number;
  mime: string;
  preview: PreviewKind;
  hasThumbnail: boolean;
  etag: string;
}

export interface RootInfo {
  id: 'me' | 'shared';
  name: string;
  path: string;
  writable: boolean;
}

export interface Usage {
  usedBytes: number;
  quotaBytes: number;
  availableBytes: number;
}

export interface Session {
  user: { username: string; displayName: string; email?: string; isAdmin: boolean };
  roots: RootInfo[];
  usage: Usage;
  limits: { maxUploadBytes: number; chunkSize: number };
}

export interface Listing {
  entry: FileEntry;
  entries: FileEntry[];
  parent: string | null;
  ticket: { token: string; expiresIn: number };
}

export interface TrashItem {
  id: string;
  name: string;
  originalPath: string;
  deletedAt: number;
  size: number;
  isDir: boolean;
}

export type SortKey = 'name' | 'size' | 'mtime' | 'kind';
export type ConflictPolicy = 'fail' | 'replace' | 'rename';

//=================================================
// Errors
//=================================================

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Raised when the portal session itself is gone and the user must sign in again. */
export class SessionExpiredError extends ApiError {
  constructor() {
    super(401, 'sso_expired', 'Your session has expired.');
    this.name = 'SessionExpiredError';
  }
}

export const portalUrl = '/yunohost/sso/';

//=================================================
// Token handling
//=================================================

let accessToken: string | null = null;
let tokenExpiresAt = 0;
let inFlight: Promise<Session> | null = null;
let cachedSession: Session | null = null;

/**
 * Fetch (or refresh) the access token. Concurrent callers share one request,
 * which matters on first paint when the sidebar, the listing and the usage bar
 * all want a session at once.
 */
async function openSession(force = false): Promise<Session> {
  if (!force && cachedSession && Date.now() < tokenExpiresAt) return cachedSession;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const response = await fetch(SSO_SESSION, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });

    // SSOwat answers an expired portal session with a redirect to the login
    // page, which fetch follows — so an HTML body, not a 401, is the signal.
    const contentType = response.headers.get('content-type') ?? '';
    if (response.status === 401 || !contentType.includes('application/json')) {
      throw new SessionExpiredError();
    }
    if (!response.ok) {
      throw new ApiError(response.status, 'sso_failed', 'Could not start a session.');
    }

    const data = (await response.json()) as Session & { accessToken: string; expiresIn: number };
    accessToken = data.accessToken;
    // Renew a minute early so a request never races its own expiry.
    tokenExpiresAt = Date.now() + (data.expiresIn - 60) * 1000;
    cachedSession = { user: data.user, roots: data.roots, usage: data.usage, limits: data.limits };
    return cachedSession;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

export const getSession = (force = false) => openSession(force);

async function authHeader(): Promise<Record<string, string>> {
  await openSession();
  return accessToken ? { authorization: `Bearer ${accessToken}` } : {};
}

//=================================================
// Request plumbing
//=================================================

async function parseError(response: Response): Promise<ApiError> {
  let code = 'error';
  let message = `Request failed (${response.status})`;
  try {
    const body = (await response.json()) as { error?: string; code?: string };
    if (body.error) message = body.error;
    if (body.code) code = body.code;
  } catch {
    /* Non-JSON error body; the generic message stands. */
  }
  return new ApiError(response.status, code, message);
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { accept: 'application/json', ...(await authHeader()), ...(init.headers ?? {}) },
  });

  if (response.status === 401 && retry) {
    // The token aged out mid-session. Mint a new one from the portal session
    // and replay once; a second failure means the portal session is gone too.
    await openSession(true);
    return request<T>(path, init, false);
  }

  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function jsonBody(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
}

//=================================================
// Files
//=================================================

export function list(path: string, sort: SortKey = 'name', descending = false): Promise<Listing> {
  const params = new URLSearchParams({ path, sort });
  if (descending) params.set('desc', '1');
  return request<Listing>(`/files/?${params}`);
}

export function stat(path: string): Promise<FileEntry> {
  return request<{ entry: FileEntry }>(`/files/stat?path=${encodeURIComponent(path)}`)
    .then((r) => r.entry);
}

export function search(query: string, scope?: string): Promise<{ results: FileEntry[]; ticket: { token: string } }> {
  const params = new URLSearchParams({ q: query });
  if (scope) params.set('path', scope);
  return request(`/files/search?${params}`);
}

export function createFolder(path: string): Promise<FileEntry> {
  return request<{ entry: FileEntry }>('/files/folder', jsonBody({ path })).then((r) => r.entry);
}

export function rename(path: string, name: string): Promise<FileEntry> {
  return request<{ entry: FileEntry }>('/files/rename', jsonBody({ path, name })).then((r) => r.entry);
}

export function move(from: string, to: string, conflict: ConflictPolicy = 'rename'): Promise<FileEntry> {
  return request<{ entry: FileEntry }>('/files/move', jsonBody({ from, to, conflict })).then((r) => r.entry);
}

export function copy(from: string, to: string, conflict: ConflictPolicy = 'rename'): Promise<FileEntry> {
  return request<{ entry: FileEntry }>('/files/copy', jsonBody({ from, to, conflict })).then((r) => r.entry);
}

export function remove(path: string, permanent = false): Promise<unknown> {
  const params = new URLSearchParams({ path });
  if (permanent) params.set('permanent', '1');
  return request(`/files/?${params}`, { method: 'DELETE' });
}

export function usage(): Promise<Usage> {
  return request<{ usage: Usage }>('/auth/me').then((r) => r.usage);
}

//=================================================
// Trash
//=================================================

export function listTrash(): Promise<{ items: TrashItem[]; retentionDays: number }> {
  return request('/trash/');
}

export function restoreFromTrash(id: string): Promise<FileEntry> {
  return request<{ entry: FileEntry }>(`/trash/${id}/restore`, { method: 'POST' }).then((r) => r.entry);
}

export function purgeFromTrash(id: string): Promise<unknown> {
  return request(`/trash/${id}`, { method: 'DELETE' });
}

export function emptyTrash(): Promise<{ removed: number }> {
  return request('/trash/', { method: 'DELETE' });
}

//=================================================
// Media URLs
//=================================================
// <img>, <video> and download links cannot set an Authorization header, so
// they carry a ticket: a read-only token scoped to one folder, handed out by
// the listing endpoint.

export function thumbUrl(ticket: string, path: string, size = 256): string {
  return `${API}/media/thumb?path=${encodeURIComponent(path)}&size=${size}&t=${encodeURIComponent(ticket)}`;
}

export function previewUrl(ticket: string, path: string): string {
  return `${API}/media/preview?path=${encodeURIComponent(path)}&t=${encodeURIComponent(ticket)}`;
}

export function downloadUrl(ticket: string, path: string): string {
  return `${API}/media/download?path=${encodeURIComponent(path)}&t=${encodeURIComponent(ticket)}`;
}

/** Fetch a text file's contents for the inline text preview. */
export async function fetchText(path: string, maxBytes = 512 * 1024): Promise<string> {
  const response = await fetch(`${API}/media/download?path=${encodeURIComponent(path)}`, {
    headers: { ...(await authHeader()), range: `bytes=0-${maxBytes - 1}` },
  });
  if (!response.ok && response.status !== 206) throw await parseError(response);
  return response.text();
}

//=================================================
// Uploads
//=================================================

export interface UploadSession {
  id: string;
  target: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  received: number[];
  missing: number[];
  complete: boolean;
}

export function beginUpload(
  path: string,
  size: number,
  mtime: number,
  conflict: ConflictPolicy = 'rename',
): Promise<UploadSession> {
  return request<{ upload: UploadSession }>('/upload', jsonBody({ path, size, mtime, conflict }))
    .then((r) => r.upload);
}

export async function putChunk(
  id: string,
  index: number,
  blob: Blob,
  signal?: AbortSignal,
): Promise<UploadSession> {
  const response = await fetch(`${API}/upload/${id}/chunk/${index}`, {
    method: 'PUT',
    headers: { ...(await authHeader()), 'content-type': 'application/octet-stream' },
    body: blob,
    signal,
  });
  if (!response.ok) throw await parseError(response);
  return ((await response.json()) as { upload: UploadSession }).upload;
}

export function completeUpload(id: string): Promise<FileEntry> {
  return request<{ entry: FileEntry }>(`/upload/${id}/complete`, { method: 'POST' }).then((r) => r.entry);
}

export function abortUpload(id: string): Promise<unknown> {
  return request(`/upload/${id}`, { method: 'DELETE' }).catch(() => undefined);
}
