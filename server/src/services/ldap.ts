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

const USER_ATTRIBUTES = ['uid', 'cn', 'displayName', 'mail', 'memberOf', 'permission'];

/**
 * What a user entry says about the account.
 *
 * YunoHost records group membership in `memberOf` and the permissions a user
 * holds — directly or through a group — in `permission`. Both are read for
 * the app permission, because which one carries it has varied between
 * releases, and an account must not be refused on a technicality.
 */
function describe(
  entry: Entry,
  username: string,
): Omit<LdapUser, 'username'> & { hasPermission: boolean; membershipKnown: boolean } {
  const memberships = [...attr(entry, 'memberOf'), ...attr(entry, 'permission')].map(cnOf);
  const required = config.auth.requiredPermission.toLowerCase();
  return {
    displayName: attr(entry, 'displayName')[0] ?? attr(entry, 'cn')[0] ?? username,
    email: attr(entry, 'mail')[0],
    isAdmin: memberships.includes(config.auth.adminGroup.toLowerCase()),
    hasPermission: memberships.includes(required),
    // Every YunoHost account is at least in all_users, so an entry with no
    // memberships at all means the ACL hid them — not that there are none.
    membershipKnown: memberships.length > 0,
  };
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

  // Outside production there is no directory to bind against. Signing in as
  // DEV_USER with any password is what lets the iOS app be pointed at
  // `npm run dev`; assertProductionConfig() keeps this branch out of a real
  // install.
  if (!config.isProd) {
    if (username !== config.auth.devUser) throw unauthorized('Invalid username or password');
    return { username, displayName: username, email: `${username}@localhost`, isAdmin: config.auth.devAdmin };
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
      attributes: USER_ATTRIBUTES,
    });

    const entry = searchEntries[0];
    if (!entry) throw unauthorized('Invalid username or password');

    const { isAdmin, hasPermission, displayName, email } = describe(entry, username);

    if (!hasPermission && !isAdmin) {
      throw forbidden(
        'This account does not have access to this app. Ask an administrator to grant ' +
          `the "${config.auth.requiredPermission}" permission.`,
        'no_permission',
      );
    }

    return { username, displayName, email, isAdmin };
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
  if (!config.isProd) return 'granted';

  // Administrators are let in by login whether or not they hold the app
  // permission; the re-check has to agree, or an admin is signed out at the
  // first refresh by the very rule that admitted them.
  const profile = await lookup(username);
  if (profile?.isAdmin || profile?.hasPermission) return 'granted';

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

export interface LdapProfile extends LdapUser {
  hasPermission: boolean;
  /** False when the directory would not show this account's memberships. */
  membershipKnown: boolean;
}

/**
 * Read an account's entry without its password — for the sign-in routes that
 * already trust the identity (the portal, a passkey, a refresh token) but
 * still need to know who the person is and whether they are an admin.
 *
 * YunoHost's directory allows anonymous reads of user entries from localhost.
 * Null means it could not be read; callers fall back to what they already
 * know rather than failing the sign-in.
 */
export async function lookup(username: string): Promise<LdapProfile | null> {
  if (!isPlausibleUsername(username)) return null;
  if (!config.isProd) {
    return {
      username,
      displayName: username,
      email: `${username}@localhost`,
      isAdmin: config.auth.devAdmin,
      hasPermission: true,
      membershipKnown: true,
    };
  }

  const client = new Client({ url: config.auth.ldapUrl, timeout: 5000, connectTimeout: 5000 });
  try {
    const { searchEntries } = await client.search(config.auth.ldapDnTemplate.replace('{username}', username), {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: USER_ATTRIBUTES,
    });
    const entry = searchEntries[0];
    if (!entry) return null;
    return { username, ...describe(entry, username) };
  } catch {
    return null;
  } finally {
    await client.unbind().catch(() => undefined);
  }
}
