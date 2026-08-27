import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { wrap } from '../lib/async';
import { badRequest, unauthorized } from '../lib/errors';
import { principal, requireAuth } from '../middleware/auth';
import * as ldap from '../services/ldap';
import * as passkeys from '../services/passkeys';
import * as storage from '../services/storage';
import * as tokens from '../services/tokens';

export const authRouter: Router = Router();

/**
 * Login is the one endpoint reachable without any credential, so it is the one
 * worth hammering. The limiter counts only failures — a device that keeps
 * refreshing a valid session is not an attacker.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.auth.loginRateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many sign-in attempts. Try again in a few minutes.', code: 'rate_limited' },
});

function deviceLabel(raw: unknown, fallbackAgent: string | undefined): string {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim().slice(0, 120);
  return (fallbackAgent ?? 'Unknown device').slice(0, 120);
}

//=================================================
// POST /api/v1/auth/login
//=================================================

authRouter.post(
  '/login',
  loginLimiter,
  wrap(async (req, res) => {
    const { username, password, device } = req.body ?? {};

    if (typeof username !== 'string' || typeof password !== 'string') {
      throw badRequest('username and password are required', 'missing_credentials');
    }

    const user = await ldap.authenticate(username, password);
    await storage.ensureUserRoot(user.username);

    const pair = await tokens.issueTokenPair(user, deviceLabel(device, req.headers['user-agent']));

    res.json({
      ...pair,
      roots: storage.rootsFor(user.username),
      server: { name: 'Cloud', version: 1, appPath: config.appPath },
    });
  }),
);

//=================================================
// POST /api/v1/auth/refresh
//=================================================

authRouter.post(
  '/refresh',
  wrap(async (req, res) => {
    const { username, refreshToken } = req.body ?? {};

    if (typeof username !== 'string' || typeof refreshToken !== 'string') {
      throw badRequest('username and refreshToken are required', 'missing_refresh');
    }
    if (!ldap.isPlausibleUsername(username)) throw unauthorized('Invalid session', 'refresh_invalid');

    // Rotate first: a replayed token is rejected here before anything else runs.
    const rotated = await tokens.rotateRefreshToken(username, refreshToken);

    // An account whose app permission was withdrawn should stop working now,
    // not in thirty days when the refresh token finally expires.
    const permission = await ldap.stillPermitted(username);
    if (permission === 'revoked') {
      await tokens.revokeSession(username, rotated.sid);
      throw unauthorized('Access to this app has been withdrawn', 'no_permission');
    }

    const user: tokens.Principal = {
      username,
      displayName: username,
      isAdmin: false,
    };

    res.json({
      accessToken: tokens.signAccessToken(user, rotated.sid),
      refreshToken: rotated.newRefreshToken,
      expiresIn: config.auth.accessTtl,
      user,
    });
  }),
);

//=================================================
// POST /api/v1/auth/logout
//=================================================

authRouter.post(
  '/logout',
  wrap(async (req, res) => {
    const { username, refreshToken } = req.body ?? {};
    if (typeof username === 'string' && typeof refreshToken === 'string') {
      await tokens.revokeRefreshToken(username, refreshToken).catch(() => undefined);
    }
    // Always 204: telling a caller whether the token existed is an oracle, and
    // the client's next step is the same either way.
    res.status(204).end();
  }),
);

//=================================================
// GET /api/v1/auth/me
//=================================================

authRouter.get(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const user = principal(req);
    await storage.ensureUserRoot(user.username);

    res.json({
      user: {
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        isAdmin: user.isAdmin,
      },
      roots: storage.rootsFor(user.username),
      usage: await storage.usage(user.username),
      limits: {
        maxUploadBytes: config.storage.maxUploadBytes,
        chunkSize: 8 * 1024 * 1024,
        passkeys: passkeys.enabled(),
      },
    });
  }),
);

//=================================================
// Sessions
//=================================================

authRouter.get(
  '/sessions',
  requireAuth,
  wrap(async (req, res) => {
    const user = principal(req);
    const sessions = await tokens.listSessions(user.username);
    res.json({ sessions: sessions.map((s) => ({ ...s, current: s.id === user.sid })) });
  }),
);

authRouter.delete(
  '/sessions/:id',
  requireAuth,
  wrap(async (req, res) => {
    const user = principal(req);
    await tokens.revokeSession(user.username, String(req.params.id));
    res.status(204).end();
  }),
);

authRouter.delete(
  '/sessions',
  requireAuth,
  wrap(async (req, res) => {
    const user = principal(req);
    await tokens.revokeAllSessions(user.username);
    res.status(204).end();
  }),
);

//=================================================
// Browser sessions
//=================================================
// The SSO bridge covers the normal case: the browser already has a portal
// session and exchanges it for tokens. A passkey sign-in has no portal session
// to exchange, so the refresh token is kept in a cookie instead — HttpOnly, so
// no script can read it; SameSite=Strict, so no other site can cause it to be
// sent; and scoped to the auth endpoints, so it is not attached to every
// download the page makes.

const SESSION_COOKIE = 'cloud_session';

function cookieOf(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

function cookiePath(): string {
  return `${config.appPath || ''}/api/v1/auth`;
}

function setSessionCookie(res: Response, username: string, refreshToken: string): void {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(`${username}:${refreshToken}`)}`,
    `Path=${cookiePath()}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${config.auth.refreshTtl}`,
  ];
  if (config.isProd) attributes.push('Secure');
  res.append('Set-Cookie', attributes.join('; '));
}

function clearSessionCookie(res: Response): void {
  const attributes = [
    `${SESSION_COOKIE}=`,
    `Path=${cookiePath()}`,
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];
  if (config.isProd) attributes.push('Secure');
  res.append('Set-Cookie', attributes.join('; '));
}

function readSessionCookie(req: Request): { username: string; refreshToken: string } | null {
  const raw = cookieOf(req, SESSION_COOKIE);
  if (!raw) return null;
  const separator = raw.indexOf(':');
  if (separator <= 0) return null;

  const username = raw.slice(0, separator);
  const refreshToken = raw.slice(separator + 1);
  if (!ldap.isPlausibleUsername(username) || refreshToken.length === 0) return null;
  return { username, refreshToken };
}

/** The payload the web app boots from — the same shape the SSO bridge returns. */
async function sessionPayload(user: tokens.Principal, sid: string) {
  await storage.ensureUserRoot(user.username);
  return {
    accessToken: tokens.signAccessToken(user, sid),
    expiresIn: config.auth.accessTtl,
    user,
    roots: storage.rootsFor(user.username),
    usage: await storage.usage(user.username),
    limits: {
      maxUploadBytes: config.storage.maxUploadBytes,
      chunkSize: 8 * 1024 * 1024,
      passkeys: passkeys.enabled(),
    },
  };
}

/**
 * Resume a browser session from the cookie, rotating the refresh token as it
 * goes. Called on every page load that did not come in through the portal.
 */
authRouter.post(
  '/web/session',
  wrap(async (req, res) => {
    const cookie = readSessionCookie(req);
    if (!cookie) throw unauthorized('No session', 'no_session');

    let rotated;
    try {
      rotated = await tokens.rotateRefreshToken(cookie.username, cookie.refreshToken);
    } catch (err) {
      // A refresh token that is no longer valid should not keep being sent.
      clearSessionCookie(res);
      throw err;
    }

    if ((await ldap.stillPermitted(cookie.username)) === 'revoked') {
      await tokens.revokeSession(cookie.username, rotated.sid);
      clearSessionCookie(res);
      throw unauthorized('Access to this app has been withdrawn', 'no_permission');
    }

    const user: tokens.Principal = {
      username: cookie.username,
      displayName: cookie.username,
      isAdmin: false,
    };

    setSessionCookie(res, cookie.username, rotated.newRefreshToken);
    res.json(await sessionPayload(user, rotated.sid));
  }),
);

authRouter.post(
  '/web/logout',
  wrap(async (req, res) => {
    const cookie = readSessionCookie(req);
    if (cookie) {
      await tokens.revokeRefreshToken(cookie.username, cookie.refreshToken).catch(() => undefined);
    }
    clearSessionCookie(res);
    res.status(204).end();
  }),
);

//=================================================
// Passkeys
//=================================================

/** Enrolling a passkey always happens from a session that is already trusted. */
authRouter.post(
  '/passkeys/register/options',
  requireAuth,
  wrap(async (req, res) => {
    const user = principal(req);
    res.json(await passkeys.beginRegistration(user));
  }),
);

authRouter.post(
  '/passkeys/register',
  requireAuth,
  wrap(async (req, res) => {
    const user = principal(req);
    const { ticket, response, name } = req.body ?? {};
    if (!response || typeof response !== 'object') {
      throw badRequest('A registration response is required', 'missing_response');
    }
    res.status(201).json({ passkey: await passkeys.finishRegistration(user, ticket, response, name) });
  }),
);

authRouter.get(
  '/passkeys',
  requireAuth,
  wrap(async (req, res) => {
    const user = principal(req);
    res.json({ passkeys: await passkeys.list(user.username), enabled: passkeys.enabled() });
  }),
);

authRouter.patch(
  '/passkeys/:id',
  requireAuth,
  wrap(async (req, res) => {
    const user = principal(req);
    const passkey = await passkeys.rename(user.username, String(req.params.id), String(req.body?.name ?? ''));
    res.json({ passkey });
  }),
);

authRouter.delete(
  '/passkeys/:id',
  requireAuth,
  wrap(async (req, res) => {
    const user = principal(req);
    await passkeys.remove(user.username, String(req.params.id));
    res.status(204).end();
  }),
);

//=================================================
// Signing in with a passkey
//=================================================
// Both halves are rate limited: this is the other endpoint pair reachable
// without a credential, and the first one is a free challenge generator.

authRouter.post(
  '/passkeys/challenge',
  loginLimiter,
  wrap(async (_req, res) => {
    res.json(await passkeys.beginAuthentication());
  }),
);

authRouter.post(
  '/passkeys/login',
  loginLimiter,
  wrap(async (req, res) => {
    const { ticket, response, device, cookie: wantsCookie } = req.body ?? {};
    if (!response || typeof response !== 'object') {
      throw badRequest('An authentication response is required', 'missing_response');
    }

    const verified = await passkeys.finishAuthentication(ticket, response);

    // Possession of the key proves identity, not entitlement: an account whose
    // app permission was withdrawn must not get back in with an old passkey.
    if ((await ldap.stillPermitted(verified.username)) === 'revoked') {
      throw unauthorized('Access to this app has been withdrawn', 'no_permission');
    }

    const user: tokens.Principal = {
      username: verified.username,
      displayName: verified.displayName,
      isAdmin: false,
    };

    await storage.ensureUserRoot(user.username);
    const pair = await tokens.issueTokenPair(
      user,
      deviceLabel(device ?? verified.credentialName, req.headers['user-agent']),
    );

    // Browsers ask for the cookie form and never see the refresh token itself;
    // native clients get it in the body and keep it in the Keychain.
    if (wantsCookie === true) {
      setSessionCookie(res, user.username, pair.refreshToken);
      res.json(await sessionPayload(user, tokens.verifyAccessToken(pair.accessToken).sid));
      return;
    }

    res.json({
      ...pair,
      roots: storage.rootsFor(user.username),
      server: { name: 'Cloud', version: 1, appPath: config.appPath },
    });
  }),
);
