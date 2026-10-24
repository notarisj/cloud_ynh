import { Router } from 'express';
import { wrap } from '../lib/async';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { principal, requireAuth } from '../middleware/auth';
import * as usersService from '../services/users';
import * as ldapService from '../services/ldap';
import * as passkeys from '../services/passkeys';
import * as policy from '../services/policy';
import * as storage from '../services/storage';
import * as tokens from '../services/tokens';
import { config } from '../config';

/**
 * People on this server, and what administrators can do about them.
 *
 * Every account — YunoHost's or one created here — can be turned off for
 * Cloud, made an administrator of Cloud or not, and signed out everywhere.
 * What the app cannot do is change what YunoHost owns: a YunoHost user's
 * password, or an admin rank that comes from the admins group or the config
 * panel. Accounts created here can additionally have their password reset,
 * and be removed.
 *
 * Everyone signed in may list names — that is what choosing who to share
 * with needs — but only accounts that can still sign in, and nothing else
 * about them.
 */
export const usersRouter: Router = Router();
usersRouter.use(requireAuth);

interface Person {
  username: string;
  displayName: string;
  email?: string;
  source: 'ldap' | 'local';
  isAdmin: boolean;
  /** Admin by the admins group or the config panel: shown, not changeable here. */
  adminFromServer: boolean;
  disabled: boolean;
  usedBytes: number;
  /** When any of its devices last used Cloud; null if it never has. */
  lastActiveAt: number | null;
  devices: number;
}

interface RosterEntry {
  username: string;
  displayName: string;
  email?: string;
  source: 'ldap' | 'local';
  directoryAdmin: boolean;
  localAdmin: boolean;
}

/** Everyone, with the directory winning a name collision. */
async function roster(): Promise<RosterEntry[]> {
  const directory = config.isProd
    ? await ldapService.listLdapUsers()
    : [
        {
          username: config.auth.devUser,
          displayName: config.auth.devUser,
          email: `${config.auth.devUser}@localhost`,
          isAdmin: config.auth.devAdmin,
        },
      ];

  const known = new Set(directory.map((u) => u.username));
  return [
    ...directory.map((u) => ({
      username: u.username,
      displayName: u.displayName,
      email: u.email,
      source: 'ldap' as const,
      directoryAdmin: u.isAdmin,
      localAdmin: false,
    })),
    ...usersService
      .getLocalUsers()
      .filter((u) => !known.has(u.username))
      .map((u) => ({
        username: u.username,
        displayName: u.username,
        source: 'local' as const,
        directoryAdmin: false,
        localAdmin: u.isAdmin,
      })),
  ];
}

async function describe(entry: RosterEntry): Promise<Person> {
  const adminFromServer =
    entry.source === 'ldap' &&
    (config.isProd
      ? await ldapService.isDirectoryAdministrator(entry.username, entry.directoryAdmin)
      : entry.directoryAdmin);
  const sessions = await tokens.listSessions(entry.username).catch(() => []);
  const usedBytes = await storage
    .usage(entry.username)
    .then((u) => u.usedBytes)
    .catch(() => 0);

  return {
    username: entry.username,
    displayName: entry.displayName,
    email: entry.email,
    source: entry.source,
    isAdmin: adminFromServer || entry.localAdmin || policy.isAppAdmin(entry.username),
    adminFromServer,
    disabled: policy.isDisabled(entry.username),
    usedBytes,
    lastActiveAt: sessions[0]?.lastUsedAt ?? null,
    devices: sessions.length,
  };
}

async function find(username: string): Promise<RosterEntry> {
  const entry = (await roster()).find((u) => u.username === username);
  if (!entry) throw notFound('There is no account by that name', 'no_user');
  return entry;
}

function requireAdmin(req: Parameters<typeof principal>[0]) {
  const user = principal(req);
  if (!user.isAdmin) throw forbidden('Only administrators can manage people', 'not_admin');
  return user;
}

usersRouter.get(
  '/',
  wrap(async (req, res) => {
    const user = principal(req);
    const everyone = (await roster()).sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
    );

    if (!user.isAdmin) {
      res.json({
        users: everyone
          .filter((u) => !policy.isDisabled(u.username))
          .map(({ username, displayName }) => ({ username, displayName })),
      });
      return;
    }

    res.json({
      users: await Promise.all(everyone.map(describe)),
      minPasswordLength: usersService.MIN_PASSWORD_LENGTH,
    });
  }),
);

usersRouter.post(
  '/',
  wrap(async (req, res) => {
    requireAdmin(req);
    const { username, password, isAdmin } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw badRequest('Username and password are required', 'missing_fields');
    }
    const created = await usersService.createLocalUser(username, password, isAdmin === true);
    res.status(201).json({ user: await describe(await find(created.username)) });
  }),
);

/**
 * Change an account: { disabled?, isAdmin?, password? }, in any combination.
 * Every part is checked before any is applied, so a refused part changes
 * nothing.
 */
usersRouter.patch(
  '/:username',
  wrap(async (req, res) => {
    const admin = requireAdmin(req);
    const username = req.params.username ?? '';
    const entry = await find(username);
    const { disabled, isAdmin, password } = req.body ?? {};
    const self = username === admin.username;

    if (disabled !== undefined && typeof disabled !== 'boolean') {
      throw badRequest('disabled must be true or false', 'bad_field');
    }
    if (isAdmin !== undefined && typeof isAdmin !== 'boolean') {
      throw badRequest('isAdmin must be true or false', 'bad_field');
    }
    if (password !== undefined && typeof password !== 'string') {
      throw badRequest('password must be text', 'bad_field');
    }
    if (self && disabled === true) throw badRequest('You cannot turn off your own account', 'self');
    if (self && isAdmin === false) throw badRequest('You cannot remove your own administrator rights', 'self');

    const current = await describe(entry);
    if (isAdmin === false && current.adminFromServer) {
      throw conflict(
        'This account is an administrator through YunoHost’s admins group or the app’s config panel. Change it there.',
        'admin_from_server',
      );
    }
    if (password !== undefined && entry.source !== 'local') {
      throw conflict('YunoHost users change their password in YunoHost.', 'password_from_server');
    }

    if (password !== undefined) {
      await usersService.setLocalPassword(username, password);
      // A reset password is a fresh start: every device signs in again.
      await tokens.revokeAllSessions(username);
    }

    if (isAdmin !== undefined && isAdmin !== current.isAdmin) {
      if (entry.source === 'local') await usersService.setLocalAdmin(username, isAdmin);
      else await policy.setAppAdmin(username, isAdmin);
      // Promotion arrives with the next token refresh. Demotion must not wait
      // for one, so the account's devices sign in again as what they now are.
      if (!isAdmin) await tokens.revokeAllSessions(username);
    }

    if (disabled !== undefined && disabled !== current.disabled) {
      await policy.setDisabled(username, disabled);
      if (disabled) await tokens.revokeAllSessions(username);
    }

    // Described afresh: the changes above may have rewritten what was read.
    res.json({ user: await describe(await find(username)) });
  }),
);

/** Sign an account out of every device. */
usersRouter.post(
  '/:username/signout',
  wrap(async (req, res) => {
    requireAdmin(req);
    const entry = await find(req.params.username ?? '');
    await tokens.revokeAllSessions(entry.username);
    res.json({ user: await describe(entry) });
  }),
);

usersRouter.delete(
  '/:username',
  wrap(async (req, res) => {
    const admin = requireAdmin(req);
    const username = req.params.username ?? '';
    if (username === admin.username) throw badRequest('You cannot remove your own account', 'delete_self');
    if (!usersService.getLocalUser(username)) {
      throw forbidden(
        'Only accounts created in Cloud can be removed here. Manage YunoHost users in YunoHost.',
        'delete_ldap_user',
      );
    }

    await usersService.deleteLocalUser(username);
    // Signed out everywhere at once, and nothing left behind: no passkey that
    // could open a session for the name again, no rule about it.
    await tokens.revokeAllSessions(username);
    await passkeys.removeAll(username);
    await policy.forget(username);
    res.status(204).end();
  }),
);
