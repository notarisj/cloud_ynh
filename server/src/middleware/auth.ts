import { timingSafeEqual } from 'crypto';
import type { Request, RequestHandler } from 'express';
import { config } from '../config';
import { forbidden, unauthorized } from '../lib/errors';
import { verifyAccessToken, type Principal } from '../services/tokens';
import { ensureUserRoot } from '../services/storage';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: Principal & { sid: string };
    }
  }
}

/**
 * Nothing here authenticates by cookie.
 *
 * The web interface obtains an access token from /api/sso/session and keeps it
 * in memory, re-minting it from the still-valid portal session after a reload;
 * the iOS app keeps its tokens in the Keychain. Both send them in an
 * Authorization header. Because no credential is ever attached to a request
 * automatically by the browser, cross-site request forgery has nothing to ride
 * on, and the API needs no CSRF token or custom-header ritual.
 */

//=================================================
// Proxy secret
//=================================================

/**
 * Confirm the request arrived through nginx.
 *
 * The API listens on 127.0.0.1 only, so this matters when something else on
 * the host — another YunoHost app, a compromised service — can open a local
 * socket. It proves origin, never identity: a valid secret alone never
 * authenticates anybody.
 */
export function proxySecretValid(headers: Request['headers']): boolean {
  if (!config.isProd || !config.auth.proxySecret) return true;

  const sent = headers['x-cloud-secret'];
  if (typeof sent !== 'string') return false;
  if (sent.length !== config.auth.proxySecret.length) return false;

  try {
    return timingSafeEqual(Buffer.from(sent), Buffer.from(config.auth.proxySecret));
  } catch {
    return false;
  }
}

export const requireProxySecret: RequestHandler = (req, res, next) => {
  if (proxySecretValid(req.headers)) {
    next();
    return;
  }
  console.warn(`[cloud/auth] rejected request without a valid proxy secret from ${req.ip}`);
  next(forbidden('Requests must go through the reverse proxy', 'bad_origin'));
};

//=================================================
// Bearer / cookie authentication
//=================================================

function bearerFrom(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) return null;
  return header.slice(7).trim() || null;
}

/**
 * Every /api/v1 route except login and refresh goes through this.
 *
 * Outside production there is no LDAP to talk to, so requests are attributed
 * to DEV_USER — that is what makes `npm run dev` usable, and it is why
 * assertProductionConfig() refuses to start a production process without the
 * secrets that turn this branch off.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!config.isProd) {
    req.user = {
      username: config.auth.devUser,
      displayName: config.auth.devUser,
      email: `${config.auth.devUser}@localhost`,
      isAdmin: config.auth.devAdmin,
      sid: 'dev-session',
    };
    next();
    return;
  }

  const token = bearerFrom(req);
  if (!token) {
    next(unauthorized('No access token supplied', 'no_token'));
    return;
  }

  try {
    const claims = verifyAccessToken(token);
    req.user = claims;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Guarantee the caller's storage root exists before any handler touches it.
 * Mounted right after authentication on every router that reads or writes
 * files; memoised in the storage service, so it is a no-op after the first
 * request from each account.
 */
export const ensureRoot: RequestHandler = (req, _res, next) => {
  const username = req.user?.username;
  if (!username) {
    next(unauthorized());
    return;
  }
  ensureUserRoot(username).then(() => next(), next);
};

/** Narrow req.user for handlers that run after requireAuth. */
export function principal(req: Request): Principal & { sid: string } {
  if (!req.user) throw unauthorized();
  return req.user;
}

//=================================================
// SSOwat identity (the /api/sso bridge only)
//=================================================

export interface SsoIdentity {
  username: string;
  email?: string;
  displayName?: string;
}

function headerValue(req: Request, ...names: string[]): string | undefined {
  for (const name of names) {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Read the identity SSOwat injected.
 *
 * SSOwat publishes the logged-in user either as an nginx variable or by
 * rewriting the request header, and which one depends on the YunoHost version,
 * so the nginx template forwards both and this reads whichever arrived.
 */
export function ssoIdentity(req: Request): SsoIdentity | null {
  const username = headerValue(req, 'ynh_user', 'ynh-user', 'x-ynh-user', 'remote-user', 'x-remote-user');
  if (!username) return null;

  return {
    username,
    email: headerValue(req, 'ynh_email', 'ynh-email', 'x-ynh-email'),
    displayName: headerValue(req, 'ynh_fullname', 'ynh-fullname', 'x-ynh-fullname'),
  };
}
