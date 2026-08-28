import { Client, type Entry } from 'ldapts';
import { config } from '../config';
import { forbidden, unauthorized } from '../lib/errors';

export interface LdapUser {
  username: string;
  displayName: string;
  email?: string;
  isAdmin: boolean;
}

/** LDAP attribute values arrive as a string, an array, or a Buffer. */
function attr(entry: Entry, name: string): string[] {
  const raw = entry[name];
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v)));
}

/** "cn=cloud.main,ou=permission,dc=yunohost,dc=org" -> "cloud.main" */
function cnOf(dn: string): string {
  const first = dn.split(',')[0] ?? '';
  const [key, ...rest] = first.split('=');
  if ((key ?? '').trim().toLowerCase() !== 'cn') return '';
  return rest.join('=').trim().toLowerCase();
}

/**
 * A username is only ever interpolated into a DN, never into a filter, but a
 * DN is still a structured string: a comma or an equals sign would let the
 * caller graft extra RDNs onto the template. YunoHost usernames are already
 * restricted to this alphabet, so anything outside it is a probe.
 */
const USERNAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

export function isPlausibleUsername(username: unknown): username is string {
  return typeof username === 'string' && USERNAME_RE.test(username);
}

/**
 * Verify a password against YunoHost's LDAP and confirm the account still
 * holds this app's permission.
 *
 * The bind *is* the password check — we never read or compare a hash. The
 * permission check then reads the freshly-bound user's own entry, which every
 * YunoHost account is allowed to read, rather than the permission entry (whose
 * ACL varies between YunoHost versions).
 *
 * Membership in `admins` also grants access, so an administrator is never
 * locked out of an app they just installed.
 */
export async function authenticate(username: string, password: string): Promise<LdapUser> {
  if (!isPlausibleUsername(username)) throw unauthorized('Invalid username or password');
  if (typeof password !== 'string' || password.length === 0) {
    throw unauthorized('Invalid username or password');
  }

  const dn = config.auth.ldapDnTemplate.replace('{username}', username);
  const client = new Client({ url: config.auth.ldapUrl, timeout: 5000, connectTimeout: 5000 });

  try {
    try {
      await client.bind(dn, password);
    } catch {
      // Do not distinguish "no such account" from "wrong password": that
      // difference is a user-enumeration oracle on an endpoint reachable
      // without a session.
      throw unauthorized('Invalid username or password');
    }

    const { searchEntries } = await client.search(dn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['uid', 'cn', 'displayName', 'mail', 'permission'],
    });

    const entry = searchEntries[0];
    if (!entry) throw unauthorized('Invalid username or password');

    // Fetch the admins group to see who is an admin
    let isAdmin = false;
    try {
      const { searchEntries: groupEntries } = await client.search('ou=groups,dc=yunohost,dc=org', {
        scope: 'one',
        filter: `(cn=${config.auth.adminGroup})`,
        attributes: ['memberUid'],
      });
      if (groupEntries[0]) {
        const members = attr(groupEntries[0], 'memberUid').map(m => m.toLowerCase());
        if (members.includes(username.toLowerCase())) {
          isAdmin = true;
        }
      }
    } catch (e) {
      console.warn('[cloud/ldap] failed to fetch admin group:', e);
    }

    const permissions = attr(entry, 'permission').map(cnOf);
    const hasPermission = permissions.includes(config.auth.requiredPermission.toLowerCase());

    if (!hasPermission && !isAdmin) {
      throw forbidden(
        'This account does not have access to this app. Ask an administrator to grant ' +
          `the "${config.auth.requiredPermission}" permission.`,
        'no_permission',
      );
    }

    return {
      username,
      displayName: attr(entry, 'displayName')[0] ?? attr(entry, 'cn')[0] ?? username,
      email: attr(entry, 'mail')[0],
      isAdmin,
    };
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

/**
 * Re-check permission for a user we already trust the identity of — used when
 * a refresh token is redeemed, so that revoking the app permission in the
 * YunoHost admin panel actually ends existing device sessions instead of
 * letting them roll over for another thirty days.
 *
 * Failure modes are deliberately different:
 *   'granted' / 'revoked' — the directory answered, trust the answer.
 *   'unknown'             — the directory could not be read. The user already
 *                           proved their password to obtain this refresh
 *                           token, so we let them through and log loudly
 *                           rather than signing every device out because
 *                           slapd was restarting.
 */
export type PermissionCheck = 'granted' | 'revoked' | 'unknown';

export async function stillPermitted(username: string): Promise<PermissionCheck> {
  if (!isPlausibleUsername(username)) return 'revoked';

  const client = new Client({ url: config.auth.ldapUrl, timeout: 5000, connectTimeout: 5000 });
  try {
    const { searchEntries } = await client.search('ou=permission,dc=yunohost,dc=org', {
      scope: 'one',
      filter: `(cn=${config.auth.requiredPermission})`,
      attributes: ['inheritPermission'],
    });

    const entry = searchEntries[0];
    // No entry at all means the app permission is gone — treat as revoked.
    if (!entry) return 'revoked';

    const dns = attr(entry, 'inheritPermission').map((d) => d.toLowerCase().replace(/\s*,\s*/g, ','));
    // An empty attribute is indistinguishable from one the ACL hid from us.
    if (dns.length === 0) return 'unknown';

    const expected = config.auth.ldapDnTemplate
      .replace('{username}', username)
      .toLowerCase()
      .replace(/\s*,\s*/g, ',');

    return dns.includes(expected) ? 'granted' : 'revoked';
  } catch (err) {
    console.warn(`[cloud/ldap] permission re-check unavailable for ${username}:`, err);
    return 'unknown';
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

/** Check if a user has a specific YunoHost permission (works anonymously) */
export async function hasPermission(username: string, permission: string): Promise<boolean> {
  if (!isPlausibleUsername(username)) return false;
  const client = new Client({ url: config.auth.ldapUrl, timeout: 5000, connectTimeout: 5000 });
  try {
    const { searchEntries } = await client.search('ou=permission,dc=yunohost,dc=org', {
      scope: 'one',
      filter: `(cn=${permission})`,
      attributes: ['inheritPermission'],
    });
    const entry = searchEntries[0];
    if (!entry) return false;
    const dns = attr(entry, 'inheritPermission').map((d) => d.toLowerCase().replace(/\s*,\s*/g, ','));
    const expected = config.auth.ldapDnTemplate.replace('{username}', username).toLowerCase().replace(/\s*,\s*/g, ',');
    return dns.includes(expected);
  } catch {
    return false;
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

/** List all YunoHost users from the LDAP directory. */
export async function listLdapUsers(): Promise<LdapUser[]> {
  const client = new Client({ url: config.auth.ldapUrl, timeout: 5000, connectTimeout: 5000 });
  try {
    // 1. Fetch the admins group to see who is an admin
    let adminUids: string[] = [];
    try {
      const { searchEntries: groupEntries } = await client.search('ou=groups,dc=yunohost,dc=org', {
        scope: 'one',
        filter: `(cn=${config.auth.adminGroup})`,
        attributes: ['memberUid'],
      });
      if (groupEntries[0]) {
        adminUids = attr(groupEntries[0], 'memberUid').map(u => u.toLowerCase());
      }
    } catch (e) {
      console.warn('[cloud/ldap] failed to fetch admin group:', e);
    }

    // 2. Fetch the users
    const { searchEntries } = await client.search('ou=users,dc=yunohost,dc=org', {
      scope: 'one',
      filter: '(uid=*)',
      attributes: ['uid', 'cn', 'displayName', 'mail'],
    });

    return searchEntries.map(entry => {
      const username = attr(entry, 'uid')[0] ?? '';
      const isAdmin = adminUids.includes(username.toLowerCase());
      return {
        username,
        displayName: attr(entry, 'displayName')[0] ?? attr(entry, 'cn')[0] ?? username,
        email: attr(entry, 'mail')[0],
        isAdmin,
      };
    }).filter(user => user.username.length > 0);
  } catch (err) {
    console.warn(`[cloud/ldap] failed to list users:`, err);
    return [];
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

/** Get a single YunoHost user's details without requiring their password. */
export async function getLdapUser(username: string): Promise<LdapUser | null> {
  if (!isPlausibleUsername(username)) return null;

  const client = new Client({ url: config.auth.ldapUrl, timeout: 5000, connectTimeout: 5000 });
  try {
    let isAdmin = false;
    try {
      const { searchEntries: groupEntries } = await client.search('ou=groups,dc=yunohost,dc=org', {
        scope: 'one',
        filter: `(cn=${config.auth.adminGroup})`,
        attributes: ['memberUid'],
      });
      if (groupEntries[0]) {
        const members = attr(groupEntries[0], 'memberUid').map(m => m.toLowerCase());
        if (members.includes(username.toLowerCase())) {
          isAdmin = true;
        }
      }
    } catch (e) {
      console.warn('[cloud/ldap] failed to fetch admin group:', e);
    }

    let displayName = username;
    let email: string | undefined;
    try {
      const { searchEntries } = await client.search('ou=users,dc=yunohost,dc=org', {
        scope: 'one',
        filter: `(uid=${username})`,
        attributes: ['uid', 'cn', 'displayName', 'mail'],
      });
      const entry = searchEntries[0];
      if (entry) {
        displayName = attr(entry, 'displayName')[0] ?? attr(entry, 'cn')[0] ?? username;
        email = attr(entry, 'mail')[0];
      }
    } catch (e) {
      console.warn('[cloud/ldap] failed to fetch user info:', e);
    }

    return { username, displayName, email, isAdmin };
  } finally {
    await client.unbind().catch(() => undefined);
  }
}
