import { Router } from 'express';
import { wrap } from '../lib/async';
import { badRequest, forbidden } from '../lib/errors';
import { principal, requireAuth } from '../middleware/auth';
import * as usersService from '../services/users';
import * as ldapService from '../services/ldap';
import * as passkeys from '../services/passkeys';
import * as tokens from '../services/tokens';
import { config } from '../config';

/**
 * People on this server: the YunoHost directory's users, plus the accounts an
 * administrator created in this app.
 *
 * Everyone signed in may list names — that is what choosing who to share with
 * needs. Only administrators see who else is an administrator, or which
 * accounts are local, and only they may add or remove one.
 */
export const usersRouter: Router = Router();
usersRouter.use(requireAuth);

interface Person {
  username: string;
  displayName: string;
  email?: string;
  isAdmin: boolean;
  source: 'ldap' | 'local';
}

async function everyone(): Promise<Person[]> {
  const directory: Person[] = config.isProd
    ? (await ldapService.listLdapUsers()).map((u) => ({ ...u, source: 'ldap' as const }))
    : [
        {
          username: config.auth.devUser,
          displayName: config.auth.devUser,
          email: `${config.auth.devUser}@localhost`,
          isAdmin: config.auth.devAdmin,
          source: 'ldap' as const,
        },
      ];

  // The directory wins a collision: a local account by that name cannot sign in.
  const known = new Set(directory.map((u) => u.username));
  const local: Person[] = usersService
    .getLocalUsers()
    .filter((u) => !known.has(u.username))
    .map((u) => ({ username: u.username, displayName: u.username, isAdmin: u.isAdmin, source: 'local' as const }));

  return [...directory, ...local].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
  );
}

usersRouter.get(
  '/',
  wrap(async (req, res) => {
    const user = principal(req);
    const people = await everyone();
    res.json({
      users: user.isAdmin
        ? people
        : people.map(({ username, displayName }) => ({ username, displayName })),
      minPasswordLength: usersService.MIN_PASSWORD_LENGTH,
    });
  }),
);

usersRouter.post(
  '/',
  wrap(async (req, res) => {
    const user = principal(req);
    if (!user.isAdmin) throw forbidden('Only administrators can add people', 'not_admin');

    const { username, password, isAdmin } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw badRequest('Username and password are required', 'missing_fields');
    }

    const created = await usersService.createLocalUser(username, password, isAdmin === true);
    res.status(201).json({
      user: { username: created.username, displayName: created.username, isAdmin: created.isAdmin, source: 'local' },
    });
  }),
);

usersRouter.delete(
  '/:username',
  wrap(async (req, res) => {
    const user = principal(req);
    if (!user.isAdmin) throw forbidden('Only administrators can remove people', 'not_admin');

    const username = req.params.username ?? '';
    if (username === user.username) throw badRequest('You cannot remove your own account', 'delete_self');
    if (!usersService.getLocalUser(username)) {
      throw forbidden('Only accounts created in Cloud can be removed here. Manage YunoHost users in YunoHost.', 'delete_ldap_user');
    }

    await usersService.deleteLocalUser(username);
    // Signed out everywhere at once, not at the next token refresh, and no
    // passkey left behind that could open a session for the name again.
    await tokens.revokeAllSessions(username);
    await passkeys.removeAll(username);
    res.status(204).end();
  }),
);
