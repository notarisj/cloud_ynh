import { Router } from 'express';
import { config } from '../config';
import { wrap } from '../lib/async';
import { unauthorized } from '../lib/errors';
import { requireProxySecret, ssoIdentity } from '../middleware/auth';
import * as ldap from '../services/ldap';
import * as passkeys from '../services/passkeys';
import * as storage from '../services/storage';
import * as tokens from '../services/tokens';

/**
 * The bridge between YunoHost's portal session and this app's tokens.
 *
 * Mounted at /api/sso, which nginx runs through SSOwat. By the time a request
 * reaches here the browser has already proved who it is, so there is no
 * password to check — the identity arrives in a header that only the reverse
 * proxy can set, which is why the proxy secret is mandatory on this route.
 *
 * The SPA calls this once at boot and again whenever its in-memory access
 * token expires. Nothing is stored in a cookie: the portal session is the
 * durable credential, and re-minting from it costs one request.
 */
export const ssoRouter: Router = Router();

ssoRouter.get(
  '/session',
  requireProxySecret,
  wrap(async (req, res) => {
    let username: string;
    let displayName: string;
    let email: string | undefined;
    let isAdmin = false;

    if (config.isProd) {
      const identity = ssoIdentity(req);
      if (!identity) {
        // The proxy secret matched but SSOwat injected no user. That is a
        // misconfiguration, not a client error — say so in the journal.
        console.error(
          '[cloud/sso] proxy secret accepted but no YNH_USER header present. ' +
            'Check that SSOwat protects this location and that the user holds the app permission.',
        );
        throw unauthorized('No portal session', 'no_sso_session');
      }
      username = identity.username;
      displayName = identity.displayName ?? identity.username;
      email = identity.email;

      const ldapUser = await ldap.getLdapUser(username);
      isAdmin = ldapUser?.isAdmin ?? false;

      // Ultimate fallback: since YunoHost completely blocks anonymous LDAP queries 
      // for users and groups, we check the OS-level group mapping directly. 
      // /etc/group is world-readable and synced with LDAP in YunoHost.
      if (!isAdmin) {
        try {
          const fs = require('fs');
          const groupData = fs.readFileSync('/etc/group', 'utf-8');
          const adminLine = groupData.split('\n').find((line: string) => line.startsWith(`${config.auth.adminGroup}:`));
          if (adminLine) {
            const members = adminLine.split(':')[3];
            if (members && members.split(',').map((m: string) => m.trim().toLowerCase()).includes(username.toLowerCase())) {
              isAdmin = true;
            }
          }
        } catch (e) {
          console.warn('[cloud/sso] Failed to read /etc/group for admin check:', e);
        }
      }

      if (!isAdmin && await ldap.hasPermission(username, 'ssh.main')) {
        isAdmin = true;
      }

      if (config.auth.adminUsers.includes(username.toLowerCase())) {
        isAdmin = true;
      }

      if (await passkeys.isSsoDisabled(username)) {
        throw unauthorized('SSO login is disabled for this account. Please use a passkey.', 'sso_disabled');
      }
    } else {
      username = config.auth.devUser;
      displayName = config.auth.devUser;
      email = `${config.auth.devUser}@localhost`;
      isAdmin = config.auth.devAdmin;
    }

    await storage.ensureUserRoot(username);

    const user: tokens.Principal = { username, displayName, email, isAdmin };
    const sid = `sso:${username}`;

    res.json({
      accessToken: tokens.signAccessToken(user, sid),
      expiresIn: config.auth.accessTtl,
      user,
      roots: storage.rootsFor(username),
      usage: await storage.usage(username),
      limits: {
        maxUploadBytes: config.storage.maxUploadBytes,
        chunkSize: 8 * 1024 * 1024,
        // Lets the web app hide the passkey controls entirely when the admin
        // has turned the feature off.
        passkeys: passkeys.enabled(),
      },
    });
  }),
);
