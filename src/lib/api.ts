/**
 * Client for the Cloud API.
 *
 * There are two ways a browser gets a session, tried in this order:
 *
 *  1. The YunoHost portal. If the browser already has a portal session, the
 *     SSO bridge exchanges it for a short-lived access token. Nothing is
 *     stored: on reload the exchange simply happens again.
 *  2. A passkey. Signing in with one leaves an HttpOnly cookie holding a
 *     refresh token, which /auth/web/session trades for the same access token.
 *     Script never sees that cookie, and the access token stays in memory.
 *
 * Either way the token lives in a variable, not in localStorage, and every
 * request carries it in an Authorization header — so there is no ambient
 * credential for another site to exploit.
 */

// Vite's `base` is the sub-path the app is installed under ("/cloud/").
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

export const API = `${BASE}/api/v1`;
const SSO_SESSION = `${BASE}/api/sso/session`;
const WEB_SESSION = `${API}/auth/web/session`;

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

  /** One of your own items that is published under "/shared". */
  shared?: boolean;
  /** Where it is published, e.g. "/shared/Holiday Photos". */
  sharedAs?: string;
  /** Who published it, when the item was reached through "/shared". */
  sharedBy?: string;
  /** Readable but not changeable — someone else's shared item. */
  readOnly?: boolean;
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
  limits: { maxUploadBytes: number; chunkSize: number; passkeys?: boolean };
  /** How this session was obtained, which decides how signing out works. */
  via: 'portal' | 'passkey';
}

export interface Listing {
  entry: FileEntry;
  entries: FileEntry[];
  parent: string | null;
  /** Whether the caller may add to or change things in this folder. */
  writable: boolean;
  ticket: { token: string; expiresIn: number };
}

export interface ShareSummary {
  id: string;
  /** Where the item lives, e.g. "/me/Photos/Trip". */
  path: string;
  /** Where it appears to everyone else, e.g. "/shared/Trip". */
  sharedAs: string;
  name: string;
  sharedAt: number;
}

export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number;
  /** True when the passkey is synced across the user's devices. */
  synced: boolean;
}

export interface DeviceSession {
  id: string;
  device: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  current: boolean;
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

interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  user: Session['user'];
  roots: RootInfo[];
  usage: Usage;
  limits: Session['limits'];
}

/** Adopt a session payload from whichever endpoint produced it. */
function adopt(data: SessionResponse, via: Session['via']): Session {
  accessToken = data.accessToken;
  // Renew a minute early so a request never races its own expiry.
  tokenExpiresAt = Date.now() + (data.expiresIn - 60) * 1000;
  cachedSession = { user: data.user, roots: data.roots, usage: data.usage, limits: data.limits, via };
  return cachedSession;
}

/**
 * "Nobody is signed in" and "the server did not answer" are different
 * problems, and they need different screens: one asks the user to sign in,
 * the other asks them to try again. Conflating them puts somebody whose API
 * is merely restarting on a sign-in screen that cannot help them.
 */
class ServerUnreachableError extends ApiError {
  constructor(message = 'Could not reach the server.') {
    super(0, 'unreachable', message);
    this.name = 'ServerUnreachableError';
  }
}

/** Exchange the YunoHost portal session for an access token. */
async function portalSession(): Promise<Session> {
  let response: Response;
  try {
    response = await fetch(SSO_SESSION, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
  } catch {
    // fetch only rejects when the request never got an answer at all.
    throw new ServerUnreachableError();
  }

  if (response.status === 401 || response.status === 403) throw new SessionExpiredError();
  if (response.status >= 500) {
    throw new ServerUnreachableError('The server could not start a session.');
  }

  // SSOwat answers an expired portal session with a redirect to the login
  // page, which fetch follows — so an HTML body with a 200, rather than a 401,
  // is what an expired portal session actually looks like from here.
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) throw new SessionExpiredError();
  if (!response.ok) throw new ApiError(response.status, 'sso_failed', 'Could not start a session.');

  return adopt((await response.json()) as SessionResponse, 'portal');
}

/** Resume a passkey session from its HttpOnly cookie. */
async function cookieSession(): Promise<Session> {
  let response: Response;
  try {
    response = await fetch(WEB_SESSION, {
      method: 'POST',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new ServerUnreachableError();
  }

  if (response.status >= 500) throw new ServerUnreachableError();
  if (!response.ok) throw new SessionExpiredError();
  return adopt((await response.json()) as SessionResponse, 'passkey');
}

/**
 * Fetch (or refresh) the access token. Concurrent callers share one request,
 * which matters on first paint when the sidebar, the listing and the usage bar
 * all want a session at once.
 */
async function openSession(force = false): Promise<Session> {
  if (!force && cachedSession && Date.now() < tokenExpiresAt) return cachedSession;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    // A session that began with a passkey stays with the passkey: asking the
    // portal first would bounce a passkey user through a login page they
    // deliberately did not use.
    if (cachedSession?.via === 'passkey') return cookieSession();

    try {
      return await portalSession();
    } catch (cause) {
      if (!(cause instanceof SessionExpiredError)) throw cause;
      // No portal session. There may still be a passkey one.
      return cookieSession();
    }
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

export const getSession = (force = false) => openSession(force);

/** Whether a session is currently held — used to gate the sign-in screen. */
export const currentSession = (): Session | null => cachedSession;

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
// Sharing
//=================================================
// Sharing publishes an item you own; it never moves or copies it. The file
// stays in My Files, still counts against your storage, and stops being
// visible to everyone else the moment you unshare it.

export function listShares(): Promise<{ shares: ShareSummary[]; enabled: boolean }> {
  return request('/files/shares');
}

export function share(path: string): Promise<{ share: ShareSummary; entry: FileEntry }> {
  return request('/files/share', jsonBody({ path }));
}

export function unshare(path: string): Promise<unknown> {
  return request(`/files/share?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
}

export function unshareById(id: string): Promise<unknown> {
  return request(`/files/share?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
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

//=================================================
// Passkeys
//=================================================
// The ceremonies are deliberately thin wrappers: the browser does the
// cryptography, the server does the verification, and this module only carries
// the two messages between them.

export function listPasskeys(): Promise<{ passkeys: PasskeySummary[]; enabled: boolean; ssoDisabled: boolean; storeFile: string }> {
  return request('/auth/passkeys');
}

export function renamePasskey(id: string, name: string): Promise<{ passkey: PasskeySummary }> {
  return request(`/auth/passkeys/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function removePasskey(id: string): Promise<unknown> {
  return request(`/auth/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function setSsoDisabled(disabled: boolean): Promise<void> {
  return request('/auth/passkeys/sso/disable', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ disabled }),
  });
}

/**
 * Enrol a passkey for the account this session belongs to.
 *
 * `startRegistration` is imported lazily so the WebAuthn helper is only
 * downloaded by someone who actually opens the settings panel.
 */
export async function registerPasskey(name: string): Promise<PasskeySummary> {
  const { startRegistration } = await import('@simplewebauthn/browser');
  const { ticket, options } = await request<{ ticket: string; options: unknown }>(
    '/auth/passkeys/register/options',
    { method: 'POST' },
  );

  const response = await startRegistration({ optionsJSON: options as never });
  const result = await request<{ passkey: PasskeySummary }>(
    '/auth/passkeys/register',
    jsonBody({ ticket, response, name }),
  );
  return result.passkey;
}

/** Whether this browser can do WebAuthn at all. */
export async function passkeysUsable(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.PublicKeyCredential) return false;
  const { browserSupportsWebAuthn } = await import('@simplewebauthn/browser');
  return browserSupportsWebAuthn();
}

/**
 * Sign in with a passkey, with no session to start from.
 *
 * The challenge endpoints are outside `request()` on purpose: that helper
 * would try to mint an access token first, and the whole point here is that
 * there is not one yet.
 */
export async function signInWithPasskey(): Promise<Session> {
  const { startAuthentication } = await import('@simplewebauthn/browser');

  const challenge = await fetch(`${API}/auth/passkeys/challenge`, {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: '{}',
  });
  if (!challenge.ok) throw await parseError(challenge);
  const { ticket, options } = (await challenge.json()) as { ticket: string; options: unknown };

  const assertion = await startAuthentication({ optionsJSON: options as never });

  const verified = await fetch(`${API}/auth/passkeys/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    // `cookie: true` asks the server to keep the refresh token in an HttpOnly
    // cookie rather than handing it to script.
    body: JSON.stringify({ ticket, response: assertion, cookie: true }),
  });
  if (!verified.ok) throw await parseError(verified);

  return adopt((await verified.json()) as SessionResponse, 'passkey');
}

//=================================================
// Devices and sign-out
//=================================================

export function listSessions(): Promise<{ sessions: DeviceSession[] }> {
  return request('/auth/sessions');
}

export function revokeSession(id: string): Promise<unknown> {
  return request(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function revokeAllSessions(): Promise<unknown> {
  return request('/auth/sessions', { method: 'DELETE' });
}

/** End a passkey session in this browser: revoke the token, drop the cookie. */
export async function signOut(): Promise<void> {
  await fetch(`${API}/auth/web/logout`, { method: 'POST', credentials: 'include' }).catch(
    () => undefined,
  );
  accessToken = null;
  tokenExpiresAt = 0;
  cachedSession = null;
}
