import crypto from 'crypto';
import { badRequest, conflict, forbidden, notFound, tooManyRequests } from '../lib/errors';

/**
 * Quick sign-in: a browser signs in by being approved from a phone that is
 * already signed in — scan a code, confirm, done.
 *
 * Three secrets keep it safe, and each has one job:
 *
 * - The **request id** is in the QR code. It identifies the request and
 *   nothing more: holding it lets you look at the request, never claim it.
 * - The **poll secret** is given only to the browser that started the
 *   request, and never shown. Only it can collect the session, so a photo of
 *   the QR code is worthless.
 * - The **match code** is a number the browser shows. The phone is offered
 *   three numbers and must pick that one. Somebody who tricks you into
 *   scanning *their* QR code (to have you sign *them* in) cannot show you the
 *   number on their screen — you are not looking at it — so you would have to
 *   guess, and one wrong guess kills the request.
 *
 * On top: requests live two minutes, are used once, are bound to the first
 * account that scans them, and approving one needs that phone's own session,
 * which is refused for an account an administrator has turned off.
 *
 * Kept in memory: a request is worth nothing after two minutes, and a restart
 * simply means scanning again.
 */

export type QuickStatus = 'pending' | 'scanned' | 'approved' | 'denied' | 'expired';

interface QuickRequest {
  id: string;
  /** sha256 of the browser's poll secret; the secret itself is not kept. */
  secretHash: Buffer;
  code: number;
  choices: number[];
  createdAt: number;
  expiresAt: number;
  /** What the phone is shown about who is asking. */
  browser: string;
  ip: string;
  status: QuickStatus;
  /** The account that scanned it first; nobody else may act on it. */
  scannedBy?: string;
  approvedBy?: string;
}

const TTL_MS = 2 * 60 * 1000;
const MAX_PENDING = 500;
const requests = new Map<string, QuickRequest>();

function sweep(now = Date.now()): void {
  for (const [id, request] of requests) {
    // Kept a little past expiry so a browser polling at the edge hears
    // "expired" rather than "no such request".
    if (request.expiresAt + 30_000 < now) requests.delete(id);
  }
}

function live(id: string): QuickRequest {
  sweep();
  const request = requests.get(id);
  if (!request) throw notFound('This sign-in code is no longer valid', 'quick_unknown');
  if (request.expiresAt < Date.now() && request.status !== 'approved') request.status = 'expired';
  return request;
}

/** Two digits, three choices: the right one and two others, in random order. */
function matchCode(): { code: number; choices: number[] } {
  const code = crypto.randomInt(10, 100);
  const choices = new Set([code]);
  while (choices.size < 3) choices.add(crypto.randomInt(10, 100));
  const shuffled = [...choices];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return { code, choices: shuffled };
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest();

/** A browser asks to be signed in. Returns what only that browser may know. */
export function start(browser: string, ip: string) {
  sweep();
  if (requests.size >= MAX_PENDING) throw tooManyRequests('Too many sign-in requests right now; try again shortly');

  const id = crypto.randomBytes(16).toString('base64url');
  const secret = crypto.randomBytes(32).toString('base64url');
  const { code, choices } = matchCode();
  const now = Date.now();
  requests.set(id, {
    id,
    secretHash: sha256(secret),
    code,
    choices,
    createdAt: now,
    expiresAt: now + TTL_MS,
    browser: browser.slice(0, 120),
    ip,
    status: 'pending',
  });
  return { id, secret, code, expiresIn: TTL_MS / 1000 };
}

/** The phone has scanned the code. It sees who is asking, and the choices — never the code. */
export function scan(id: string, username: string) {
  const request = live(id);
  if (request.status === 'expired') throw conflict('This sign-in code has expired', 'quick_expired');
  if (request.scannedBy && request.scannedBy !== username) {
    throw forbidden('Another account has already scanned this code', 'quick_taken');
  }
  if (request.status !== 'pending' && request.status !== 'scanned') {
    throw conflict('This sign-in code has already been used', 'quick_used');
  }
  request.scannedBy = username;
  request.status = 'scanned';
  return {
    browser: request.browser,
    ip: request.ip,
    createdAt: request.createdAt,
    expiresIn: Math.max(0, Math.round((request.expiresAt - Date.now()) / 1000)),
    choices: request.choices,
  };
}

/** The phone says yes, with the number it picked. A wrong number ends the request. */
export function approve(id: string, username: string, picked: unknown): void {
  const request = live(id);
  if (request.scannedBy !== username) throw forbidden('Scan the code before approving it', 'quick_not_scanned');
  if (request.status !== 'scanned') throw conflict('This sign-in code can no longer be approved', 'quick_used');
  if (typeof picked !== 'number' || picked !== request.code) {
    request.status = 'denied';
    throw badRequest('That number did not match the one in the browser. Start again from the browser.', 'quick_mismatch');
  }
  request.status = 'approved';
  request.approvedBy = username;
}

/** The phone says no. */
export function deny(id: string, username: string): void {
  const request = live(id);
  if (request.scannedBy && request.scannedBy !== username) throw forbidden('Not your request', 'quick_taken');
  if (request.status === 'pending' || request.status === 'scanned') request.status = 'denied';
}

/**
 * The browser asks how it is going, proving it is the browser that started
 * the request. On "approved" it gets the account to sign in as — once: the
 * request is gone afterwards.
 */
export function poll(id: string, secret: unknown): { status: QuickStatus; username?: string } {
  const request = live(id);
  if (typeof secret !== 'string' || !crypto.timingSafeEqual(sha256(secret), request.secretHash)) {
    // Indistinguishable from an unknown id, so the id alone tells nobody anything.
    throw notFound('This sign-in code is no longer valid', 'quick_unknown');
  }
  if (request.status === 'approved' && request.approvedBy) {
    requests.delete(id);
    return { status: 'approved', username: request.approvedBy };
  }
  if (request.status === 'denied' || request.status === 'expired') requests.delete(id);
  return { status: request.status };
}

/** For tests. */
export function _reset(): void {
  requests.clear();
}
