import { Router } from 'express';
import { wrap } from '../lib/async';
import { badRequest, forbidden } from '../lib/errors';
import { principal, requireAuth } from '../middleware/auth';
import * as usersService from '../services/users';
import * as ldapService from '../services/ldap';
import { config } from '../config';

export const usersRouter: Router = Router();
usersRouter.use(requireAuth);

usersRouter.get(
  '/',
  wrap(async (req, res) => {
    const localUsers = usersService.getLocalUsers().map(u => ({
      username: u.username,
      displayName: u.username, // Using username as display name for local users
      isAdmin: u.isAdmin,
      source: 'local' as const,
    }));

    let ldapUsers: Array<{username: string; displayName: string; email?: string; isAdmin: boolean; source: 'ldap'}> = [];
    if (config.isProd) {
      const users = await ldapService.listLdapUsers();
      ldapUsers = users.map(u => ({ ...u, source: 'ldap' as const }));
    } else {
      // Provide a dev fallback for testing UI
      ldapUsers = [{
        username: config.auth.devUser,
        displayName: config.auth.devUser,
        email: `${config.auth.devUser}@localhost`,
        isAdmin: config.auth.devAdmin,
        source: 'ldap' as const,
      }];
    }

    // Merge lists, preferring LDAP users in case of collision
    const allUsers: Array<{username: string; displayName: string; email?: string; isAdmin: boolean; source: 'ldap' | 'local'}> = [...ldapUsers];
    const ldapUsernames = new Set(ldapUsers.map(u => u.username));
    for (const u of localUsers) {
      if (!ldapUsernames.has(u.username)) {
        allUsers.push(u);
      }
    }

    res.json({ users: allUsers });
  })
);

usersRouter.post(
  '/',
  wrap(async (req, res) => {
    const user = principal(req);
    if (!user.isAdmin) throw forbidden('Only administrators can create users', 'not_admin');

    const { username, password, isAdmin } = req.body;
    if (!username || !password) throw badRequest('Username and password are required', 'missing_fields');

    const newUser = await usersService.createLocalUser(username, password, !!isAdmin);
    res.status(201).json({
      user: {
        username: newUser.username,
        displayName: newUser.username,
        isAdmin: newUser.isAdmin,
        source: 'local'
      }
    });
  })
);

usersRouter.delete(
  '/:username',
  wrap(async (req, res) => {
    const user = principal(req);
    if (!user.isAdmin) throw forbidden('Only administrators can delete users', 'not_admin');

    const { username } = req.params;
    if (!username) throw badRequest('Username is required', 'missing_parameter');
    if (username === user.username) throw badRequest('Cannot delete yourself', 'delete_self');

    const ldapUsers = config.isProd ? await ldapService.listLdapUsers() : [];
    if (ldapUsers.find(u => u.username === username)) {
      throw forbidden('Cannot delete YunoHost users from the app', 'delete_ldap_user');
    }

    await usersService.deleteLocalUser(username);
    res.status(204).end();
  })
);
