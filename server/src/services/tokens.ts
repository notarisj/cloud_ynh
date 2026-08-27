import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { unauthorized } from '../lib/errors';

export interface Principal {
  username: string;
  displayName: string;
  email?: string;
  isAdmin: boolean;
}

export interface AccessClaims extends Principal {
  /** Refresh-token family this access token belongs to, for targeted revocation. */
  sid: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  user: Principal;
}

interface StoredToken {
  id: string;
  /** SHA-256 of the refresh token. The token itself is never written to disk. */
  hash: string;
  device: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Constant-time comparison of two hex digests. timingSafeEqual throws on a
 * length mismatch, which a hand-edited or truncated store file could cause, so
 * the lengths are checked first — that leaks nothing, both sides are digests.
 */
function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

//=================================================
// Access tokens
//=================================================

export function signAccessToken(user: Principal, sid: string): string {
  const claims = {
    sub: user.username,
    name: user.displayName,
    email: user.email,
    adm: user.isAdmin,
    sid,
  };
  // The audience is what keeps a read-only download ticket from being replayed
  // as a full access token: both are signed with the same key, so the only
  // thing separating them is a claim that verification insists on.
  return jwt.sign(claims, config.auth.jwtSecret, {
    expiresIn: config.auth.accessTtl,
    issuer: config.auth.requiredPermission,
    audience: 'access',
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, config.auth.jwtSecret, {
      issuer: config.auth.requiredPermission,
      audience: 'access',
    }) as jwt.JwtPayload;
  } catch (err) {
    const expired = err instanceof jwt.TokenExpiredError;
    throw unauthorized(
      expired ? 'Access token expired' : 'Invalid access token',
      expired ? 'token_expired' : 'token_invalid',
    );
  }

  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
    throw unauthorized('Malformed access token', 'token_invalid');
  }

  return {
    username: payload.sub,
    displayName: typeof payload.name === 'string' ? payload.name : payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    isAdmin: payload.adm === true,
    sid: payload.sid,
  };
}

//=================================================
// Refresh tokens
//=================================================
// One JSON file per user under .meta/tokens. Writes are serialised per user
// through a promise chain so that two devices refreshing at the same moment
// cannot lose each other's entry, and are done rename-style so a crash mid-
// write cannot truncate the file.

const writeQueues = new Map<string, Promise<unknown>>();

function serialise<T>(username: string, work: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(username) ?? Promise.resolve();
  const next = previous.then(work, work);
  writeQueues.set(
    username,
    next.catch(() => undefined),
  );
  return next;
}

const storeFile = (username: string) => path.join(config.storage.tokensDir, `${username}.json`);

async function readStore(username: string): Promise<StoredToken[]> {
  try {
    const raw = await fs.readFile(storeFile(username), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return (parsed as StoredToken[]).filter((t) => t && t.expiresAt > now);
  } catch {
    return [];
  }
}

async function writeStore(username: string, tokens: StoredToken[]): Promise<void> {
  await fs.mkdir(config.storage.tokensDir, { recursive: true });
  const target = storeFile(username);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(tokens), { mode: 0o600 });
  await fs.rename(temp, target);
}

/** Cap how many live sessions one account can accumulate. */
const MAX_SESSIONS_PER_USER = 25;

export async function issueTokenPair(user: Principal, device: string): Promise<TokenPair> {
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const sid = crypto.randomUUID();
  const now = Date.now();

  await serialise(user.username, async () => {
    const tokens = await readStore(user.username);
    tokens.push({
      id: sid,
      hash: sha256(refreshToken),
      device: device.slice(0, 120),
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + config.auth.refreshTtl * 1000,
    });
    // Oldest sessions fall off the end.
    tokens.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    await writeStore(user.username, tokens.slice(0, MAX_SESSIONS_PER_USER));
  });

  return {
    accessToken: signAccessToken(user, sid),
    refreshToken,
    expiresIn: config.auth.accessTtl,
    user,
  };
}

/**
 * Redeem a refresh token, rotating it. The old token stops working the moment
 * this returns, so a stolen copy is good for at most one use — and if the
 * legitimate device then fails to refresh, the theft is visible.
 */
export async function rotateRefreshToken(
  username: string,
  refreshToken: string,
): Promise<{ sid: string; newRefreshToken: string; device: string }> {
  const hash = sha256(refreshToken);

  return serialise(username, async () => {
    const tokens = await readStore(username);
    const index = tokens.findIndex((t) => hashesMatch(t.hash, hash));

    const existing = index >= 0 ? tokens[index] : undefined;
    if (!existing) throw unauthorized('Refresh token is not valid', 'refresh_invalid');

    const newRefreshToken = crypto.randomBytes(48).toString('base64url');
    const now = Date.now();

    tokens[index] = {
      ...existing,
      hash: sha256(newRefreshToken),
      lastUsedAt: now,
      expiresAt: now + config.auth.refreshTtl * 1000,
    };
    await writeStore(username, tokens);

    return { sid: existing.id, newRefreshToken, device: existing.device };
  });
}

export async function revokeRefreshToken(username: string, refreshToken: string): Promise<void> {
  const hash = sha256(refreshToken);
  await serialise(username, async () => {
    const tokens = await readStore(username);
    await writeStore(username, tokens.filter((t) => t.hash !== hash));
  });
}

export async function revokeSession(username: string, sid: string): Promise<void> {
  await serialise(username, async () => {
    const tokens = await readStore(username);
    await writeStore(username, tokens.filter((t) => t.id !== sid));
  });
}

export async function revokeAllSessions(username: string): Promise<void> {
  await serialise(username, () => writeStore(username, []));
}

export interface SessionInfo {
  id: string;
  device: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
}

export async function listSessions(username: string): Promise<SessionInfo[]> {
  const tokens = await readStore(username);
  return tokens
    .map(({ id, device, createdAt, lastUsedAt, expiresAt }) => ({
      id,
      device,
      createdAt,
      lastUsedAt,
      expiresAt,
    }))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

//=================================================
// Download tickets
//=================================================
// An <img src> or an <a download> cannot carry an Authorization header, and a
// QuickLook preview controller on iOS opens a URL rather than making a request
// we control. Rather than putting a full access token in a query string — where
// it lands in nginx logs and Referer headers — those URLs carry a *ticket*: a
// short-lived token that only grants reads, and only beneath one path prefix.

export interface TicketClaims {
  username: string;
  /** Virtual path prefix this ticket covers, e.g. "/me/Photos". */
  scope: string;
}

/** Long enough to open a folder and scroll it; short enough that a leaked URL is worthless. */
export const TICKET_TTL_SECONDS = 15 * 60;

export function signTicket(username: string, scope: string): string {
  return jwt.sign({ sub: username, scp: scope }, config.auth.jwtSecret, {
    expiresIn: TICKET_TTL_SECONDS,
    issuer: config.auth.requiredPermission,
    audience: 'ticket',
  });
}

export function verifyTicket(token: string): TicketClaims {
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, config.auth.jwtSecret, {
      issuer: config.auth.requiredPermission,
      audience: 'ticket',
    }) as jwt.JwtPayload;
  } catch {
    throw unauthorized('Invalid or expired link', 'ticket_invalid');
  }

  if (typeof payload.sub !== 'string' || typeof payload.scp !== 'string') {
    throw unauthorized('Malformed link', 'ticket_invalid');
  }
  return { username: payload.sub, scope: payload.scp };
}

/**
 * A ticket for "/me/Photos" must not also unlock "/me/Photos Private". Compare
 * on path boundaries, not as a bare string prefix.
 */
export function ticketCovers(ticket: TicketClaims, vpath: string): boolean {
  const scope = ticket.scope.replace(/\/+$/, '');
  if (scope === '' || scope === '/') return true;
  return vpath === scope || vpath.startsWith(scope + '/');
}
