import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { wrap } from '../lib/async';
import { badRequest, conflict, unauthorized } from '../lib/errors';
import { principal, requireAuth } from '../middleware/auth';
import * as ldap from '../services/ldap';
import * as passkeys from '../services/passkeys';
import * as storage from '../services/storage';
import * as tokens from '../services/tokens';
import * as users from '../services/users';
import * as quick from '../services/quickSignIn';

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

/**
 * The account as the directory describes it now, falling back to what the
 * session already knew. Every route that signs someone in without a password
 * goes through here, so the admin flag and the display name survive a refresh
 * instead of being reset to "not an admin, called by their username".
 */
/** An account created in this app, as a session sees it. */
function localPrincipal(user: users.LocalUser): tokens.Principal {
  return { username: user.username, displayName: user.username, isAdmin: user.isAdmin };
}

async function currentPrincipal(known: tokens.Principal): Promise<tokens.Principal> {
  // Local accounts are not in the directory; their record here is the truth.
  const local = users.getLocalUser(known.username);
  if (local) return localPrincipal(local);

  const profile = await ldap.lookup(known.username);
  if (!profile) return known;
  return {
    username: known.username,
    displayName: profile.displayName || known.displayName,
    email: profile.email ?? known.email,
    // Only a directory that showed the memberships gets to change the flag.
    isAdmin: profile.membershipKnown ? profile.isAdmin : known.isAdmin,
  };
}

function deviceLabel(raw: unknown, fallbackAgent: string | undefined): string {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim().slice(0, 120);
  return (fallbackAgent ?? 'Unknown device').slice(0, 120);
}

/**
 * Version of the API contract the clients are written against. Bumped when a
 * response changes in a way a client may want to detect; additions alone do
 * not need it.
 */
export const API_VERSION = 2;

//=================================================
// GET /api/v1/auth/config
//=================================================
// What a client needs to know before anybody has signed in: whether to offer
// a passkey button, and which version of the API it is talking to. Nothing
// here is secret.

authRouter.get('/config', (_req, res) => {
  res.json({
    name: 'Cloud',
    version: API_VERSION,
    appPath: config.appPath,
    passkeys: passkeys.enabled(),
    sharing: config.storage.sharingEnabled,
    publicLinks: config.publicLinks.enabled,
    limits: { maxUploadBytes: config.storage.maxUploadBytes, chunkSize: 8 * 1024 * 1024 },
  });
});

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

    // The directory first; an account created in this app only when the
    // directory turned the name down and such an account exists.
    let principal: tokens.Principal;
    try {
      const user = await ldap.authenticate(username, password);
      principal = { username: user.username, displayName: user.displayName, email: user.email, isAdmin: user.isAdmin };
    } catch (err) {
      if ((err as { code?: string }).code !== 'unauthorized' || !users.getLocalUser(username)) throw err;
      principal = localPrincipal(await users.authenticateLocal(username, password));
    }

    await storage.ensureUserRoot(principal.username);

    const pair = await tokens.issueTokenPair(principal, deviceLabel(device, req.headers['user-agent']));

    res.json({
      ...pair,
      roots: storage.rootsFor(principal.username),
      server: { name: 'Cloud', version: API_VERSION, appPath: config.appPath },
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

    const isLocal = !!users.getLocalUser(username);
    if (!isLocal) {
      const permission = await ldap.stillPermitted(username);
      if (permission === 'revoked') {
        await tokens.revokeSession(username, rotated.sid);
        throw unauthorized('Access to this app has been withdrawn', 'no_permission');
      }
    }

    const user = await currentPrincipal(rotated.principal);
    await tokens.updatePrincipal(username, rotated.sid, user);

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
// POST /api/v1/auth/password
//=================================================
// Accounts created in Cloud change their own password here. YunoHost users
// change theirs in YunoHost, which owns it.

authRouter.post(
  '/password',
  loginLimiter,
  requireAuth,
  wrap(async (req, res) => {
    const user = principal(req);
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      throw badRequest('Current and new password are required', 'missing_fields');
    }
    if (!users.getLocalUser(user.username)) {
      throw conflict('YunoHost users change their password in YunoHost.', 'password_from_server');
    }

    // Proves it is the person, not just their unlocked device.
    await users.authenticateLocal(user.username, currentPassword);
    await users.setLocalPassword(user.username, newPassword);
    // Every other device signs in again with the new password; this one stays.
    await tokens.revokeOtherSessions(user.username, user.sid);
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
        // An account created in Cloud: it has a password here to change.
        local: !!users.getLocalUser(user.username),
      },
      roots: storage.rootsFor(user.username),
      usage: await storage.usage(user.username),
      limits: {
        maxUploadBytes: config.storage.maxUploadBytes,
        chunkSize: 8 * 1024 * 1024,
        passkeys: passkeys.enabled(),
        publicLinks: config.publicLinks.enabled,
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
      publicLinks: config.publicLinks.enabled,
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

    const isLocal = !!users.getLocalUser(cookie.username);
    if (!isLocal) {
      if ((await ldap.stillPermitted(cookie.username)) === 'revoked') {
        await tokens.revokeSession(cookie.username, rotated.sid);
        clearSessionCookie(res);
        throw unauthorized('Access to this app has been withdrawn', 'no_permission');
      }
    }

    const user = await currentPrincipal(rotated.principal);
    await tokens.updatePrincipal(cookie.username, rotated.sid, user);

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
    const info = await passkeys.list(user.username);
    res.json({ ...info, enabled: passkeys.enabled() });
  }),
);

/**
 * Turn portal sign-in off for this account, leaving the passkey as the only
 * way in — or turn it back on.
 *
 * Switching it OFF requires a passkey assertion made moments ago, in the same
 * browser: registering a key proves a key was created, not that the user can
 * still use it. Somebody who enrolled a passkey into a password manager they
 * cannot reopen would otherwise be one click from needing SSH to get back in.
 * Turning it back ON is the safe direction and needs nothing extra.
 */
authRouter.post(
  '/passkeys/sso/disable',
  requireAuth,
  wrap(async (req, res) => {
    const user = principal(req);
    const { disabled, ticket, response } = req.body ?? {};
    if (typeof disabled !== 'boolean') throw badRequest('disabled flag is required', 'missing_flag');

    if (disabled) {
      if (!response || typeof response !== 'object') {
        throw badRequest(
          'Confirm with your passkey before turning off portal sign-in',
          'passkey_confirmation_required',
        );
      }

      const verified = await passkeys.finishAuthentication(ticket, response);
      if (verified.username !== user.username) {
        // The assertion was valid but belongs to somebody else's key.
        throw badRequest('That passkey belongs to another account', 'passkey_mismatch');
      }
    }

    await passkeys.setSsoDisabled(user.username, disabled);
    res.json({
      ssoDisabled: disabled,
      rescueCommand: passkeys.rescueCommand(user.username),
    });
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
    const isLocal = !!users.getLocalUser(verified.username);
    if (!isLocal) {
      if ((await ldap.stillPermitted(verified.username)) === 'revoked') {
        throw unauthorized('Access to this app has been withdrawn', 'no_permission');
      }
    }

    const user = await currentPrincipal({
      username: verified.username,
      displayName: verified.displayName,
      isAdmin: false,
    });

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
      server: { name: 'Cloud', version: API_VERSION, appPath: config.appPath },
    });
  }),
);

//=================================================
// Quick sign-in: a signed-in phone approves a browser
//=================================================
// See services/quickSignIn.ts for why it is safe. The browser starts a
// request and shows its id as a QR code, and a number; the phone scans it,
// shows who is asking, and approves with that number; the browser, polling
// with a secret only it holds, is then given a session of its own — listed
// under Signed-In Devices like any other, and revocable the same way.

const quickStartLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many sign-in codes. Wait a minute and try again.', code: 'rate_limited' },
});

const quickPollLimiter = rateLimit({
  windowMs: 60 * 1000,
  // A browser asks every second or so for two minutes.
  limit: 150,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests.', code: 'rate_limited' },
});

/** "Safari on Mac" from a user agent — what the phone shows about the asker. */
export function describeBrowser(agent: string | undefined): string {
  const ua = agent ?? '';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'A browser';
  const platform = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : null;
  return platform ? `${browser} on ${platform}` : browser;
}

authRouter.post(
  '/quick/start',
  quickStartLimiter,
  wrap(async (req, res) => {
    const started = quick.start(describeBrowser(req.headers['user-agent']), req.ip ?? '');
    res.status(201).json({
      ...started,
      // What the QR code holds. Scanned by the app, it is read for the id; by
      // the system camera, it opens this app's page that says how to use it.
      url: `${config.publicUrl}/#quick=${started.id}`,
    });
  }),
);

/** The browser, with its secret: pending, scanned, approved (and signed in), denied or expired. */
authRouter.post(
  '/quick/:id/poll',
  quickPollLimiter,
  wrap(async (req, res) => {
    const result = quick.poll(req.params.id ?? '', req.body?.secret);
    if (result.status !== 'approved' || !result.username) {
      res.json({ status: result.status });
      return;
    }

    // The approving account, as the directory describes it now, with its own
    // session for this browser. issueTokenPair refuses an account that has
    // been turned off in the meantime.
    const local = users.getLocalUser(result.username);
    const user = await currentPrincipal({
      username: result.username,
      displayName: result.username,
      isAdmin: local?.isAdmin ?? false,
    });
    const pair = await tokens.issueTokenPair(user, `${describeBrowser(req.headers['user-agent'])} (quick sign-in)`);
    setSessionCookie(res, user.username, pair.refreshToken);
    res.json({ status: 'approved', session: await sessionPayload(user, tokens.verifyAccessToken(pair.accessToken).sid) });
  }),
);

/** The phone scanned the code: who is asking, and the numbers to choose from. */
authRouter.post(
  '/quick/:id/scan',
  requireAuth,
  wrap(async (req, res) => {
    res.json(quick.scan(req.params.id ?? '', principal(req).username));
  }),
);

/** The phone approves, with the number the browser shows. */
authRouter.post(
  '/quick/:id/approve',
  requireAuth,
  wrap(async (req, res) => {
    quick.approve(req.params.id ?? '', principal(req).username, req.body?.code);
    res.status(204).end();
  }),
);

/** The phone declines. */
authRouter.post(
  '/quick/:id/deny',
  requireAuth,
  wrap(async (req, res) => {
    quick.deny(req.params.id ?? '', principal(req).username);
    res.status(204).end();
  }),
);
