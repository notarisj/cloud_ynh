import { execFile } from 'child_process';
import { promisify } from 'util';
import { Client, type Entry } from 'ldapts';
import { config } from '../config';
import { forbidden, unauthorized } from '../lib/errors';

const runFile = promisify(execFile);

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

    const directory = describe(entry, username);
    const { hasPermission, displayName, email } = directory;

    // Bound as the user, the admin group is readable even where the
    // directory hides it from anonymous queries.
    let inAdminGroup = directory.isAdmin;
    try {
      const { searchEntries: groupEntries } = await client.search('ou=groups,dc=yunohost,dc=org', {
        scope: 'one',
        filter: `(cn=${config.auth.adminGroup})`,
        attributes: ['memberUid'],
      });
      const members = groupEntries[0] ? attr(groupEntries[0], 'memberUid').map((m) => m.toLowerCase()) : [];
      if (members.includes(username.toLowerCase())) inAdminGroup = true;
    } catch (e) {
      console.warn('[cloud/ldap] failed to read the admin group:', e);
    }
    const isAdmin = await isAdministrator(username, inAdminGroup);

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
      // The directory answered and has nobody by that name.
      if (!entry) return null;
      displayName = attr(entry, 'displayName')[0] ?? attr(entry, 'cn')[0] ?? username;
      email = attr(entry, 'mail')[0];
    } catch (e) {
      console.warn('[cloud/ldap] failed to fetch user info:', e);
      return null;
    }

    return { username, displayName, email, isAdmin };
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

/**
 * Whether the server already has an account by this name — in the directory,
 * or anywhere the system knows about (root, service accounts). A local Cloud
 * account must never share a name with one: it would sign in as that person
 * and see their files. Anything other than a clear "no such account" counts
 * as yes, so a directory that cannot be reached never opens that door.
 */
export async function serverAccountExists(username: string): Promise<boolean> {
  if (!config.isProd) return username.toLowerCase() === config.auth.devUser.toLowerCase();
  if (await getLdapUser(username).catch(() => null)) return true;
  try {
    await runFile('getent', ['passwd', username], { timeout: 3000 });
    return true;
  } catch (error) {
    // getent exits with 2 when the key is not in the database.
    return (error as { code?: unknown }).code !== 2;
  }
}

export interface LdapProfile extends LdapUser {
  hasPermission: boolean;
  /** False when nothing could say whether this account is an admin. */
  membershipKnown: boolean;
}

//=================================================
// Who is an administrator
//=================================================
// One answer for every way in — password, portal, passkey, refresh — so an
// account cannot be an admin on one and not on another.

const ADMIN_GROUP_TTL_MS = 60_000;
let adminGroupCache: { members: Set<string>; readAt: number } | null = null;

/**
 * Members of the admin group as the operating system sees it. YunoHost maps
 * its LDAP groups through NSS, so `getent` answers even where the directory
 * refuses anonymous queries for groups. Null when it cannot be read.
 */
async function adminGroupMembers(): Promise<Set<string> | null> {
  if (adminGroupCache && Date.now() - adminGroupCache.readAt < ADMIN_GROUP_TTL_MS) return adminGroupCache.members;
  // The group name comes from configuration, but it still goes nowhere near
  // a shell: execFile passes it as a single argument.
  if (!/^[A-Za-z0-9._-]+$/.test(config.auth.adminGroup)) return null;
  try {
    const { stdout } = await runFile('getent', ['group', config.auth.adminGroup], { timeout: 3000 });
    // "admins:*:4001:alice,bob"
    const members = new Set(
      (stdout.trim().split(':')[3] ?? '').split(',').map((m) => m.trim().toLowerCase()).filter(Boolean),
    );
    adminGroupCache = { members, readAt: Date.now() };
    return members;
  } catch {
    return null;
  }
}

/**
 * Whether an account is an administrator of this app: named in ADMIN_USERS
 * (the config panel's "extra administrators"), reported by the directory, or
 * a member of the admin group according to the system.
 */
export async function isAdministrator(username: string, directorySays = false): Promise<boolean> {
  const name = username.toLowerCase();
  if (config.auth.adminUsers.includes(name) || directorySays) return true;
  return (await adminGroupMembers())?.has(name) ?? false;
}

/**
 * Read an account without its password — for the sign-in routes that already
 * trust the identity (the portal, a passkey, a refresh token) but still need
 * to know who the person is and whether they are an admin.
 *
 * The user's own entry is tried first; where the directory refuses anonymous
 * reads of it, the users list is searched instead. Null means neither
 * answered, and callers fall back to what they already know.
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
  let profile: Omit<LdapProfile, 'username'> | null = null;
  try {
    const { searchEntries } = await client.search(config.auth.ldapDnTemplate.replace('{username}', username), {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: USER_ATTRIBUTES,
    });
    if (searchEntries[0]) profile = describe(searchEntries[0], username);
  } catch {
    /* Refused or unreachable: try the users list below. */
  } finally {
    await client.unbind().catch(() => undefined);
  }

  if (!profile) {
    const listed = await getLdapUser(username).catch(() => null);
    if (listed) {
      profile = {
        displayName: listed.displayName,
        email: listed.email,
        isAdmin: listed.isAdmin,
        hasPermission: false,
        membershipKnown: false,
      };
    }
  }

  const groupKnown = (await adminGroupMembers()) !== null;
  const isAdmin = await isAdministrator(username, profile?.isAdmin ?? false);
  if (!profile) {
    return groupKnown || isAdmin
      ? { username, displayName: username, isAdmin, hasPermission: false, membershipKnown: true }
      : null;
  }
  return { username, ...profile, isAdmin, membershipKnown: profile.membershipKnown || groupKnown };
}
