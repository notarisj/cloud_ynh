import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { wrap } from '../lib/async';
import { badRequest, unauthorized } from '../lib/errors';
import { principal, requireAuth } from '../middleware/auth';
import * as ldap from '../services/ldap';
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
