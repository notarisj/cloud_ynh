import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { badRequest, conflict, notFound, unauthorized } from '../lib/errors';
import { serverAccountExists } from './ldap';

export interface LocalUser {
  username: string;
  passwordHash: string;
  passwordSalt: string;
  isAdmin: boolean;
  createdAt: number;
}

const registryFile = () => path.join(config.storage.metaDir, 'users.json');

let cache: LocalUser[] | null = null;
let checkedAt = 0;
let cachedMtimeMs = -1;
const RECHECK_MS = 1000;
let queue: Promise<unknown> = Promise.resolve();

function load(): LocalUser[] {
  const now = Date.now();
  if (cache !== null && now - checkedAt < RECHECK_MS) return cache;
  try {
    const stats = fsSync.statSync(registryFile());
    if (cache === null || stats.mtimeMs !== cachedMtimeMs) {
      const data = JSON.parse(fsSync.readFileSync(registryFile(), 'utf8'));
      cache = Array.isArray(data) ? data : [];
      cachedMtimeMs = stats.mtimeMs;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      cache = [];
      cachedMtimeMs = -1;
    } else if (cache === null) {
      cache = [];
    }
  }
  checkedAt = now;
  return cache;
}

async function persist(users: LocalUser[]): Promise<void> {
  const target = registryFile();
  const temp = `${target}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temp, JSON.stringify(users, null, 2), { mode: 0o600 });
  await fs.rename(temp, target);
  cache = users;
  cachedMtimeMs = await fs.stat(target).then((stats) => stats.mtimeMs).catch(() => -1);
  checkedAt = Date.now();
}

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

export function getLocalUsers(): LocalUser[] {
  return load();
}

export function getLocalUser(username: string): LocalUser | undefined {
  return load().find(u => u.username === username);
}

/** The shortest password a local account may have. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Names a new local account may take: lowercase, starting with a letter, the
 * shape YunoHost itself allows for its users. Kept narrow on purpose — the
 * name becomes a folder on disk and appears in every share list.
 */
const LOCAL_NAME = /^[a-z][a-z0-9._-]{0,31}$/;

function hashPassword(password: string, salt: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function createLocalUser(username: string, password: string, isAdmin: boolean): Promise<LocalUser> {
  if (typeof username !== 'string' || !LOCAL_NAME.test(username)) {
    throw badRequest('Use lowercase letters, digits, dots, dashes or underscores, starting with a letter', 'invalid_username');
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters`, 'weak_password');
  }
  // A local account named after a server account would sign in as that
  // person, into their files.
  if (await serverAccountExists(username)) {
    throw conflict('There is already an account with that name on this server', 'user_exists');
  }

  return serialise(async () => {
    const users = load();
    if (users.find(u => u.username === username)) {
      throw conflict('User already exists', 'user_exists');
    }

    const salt = crypto.randomBytes(16).toString('base64');
    const hash = await hashPassword(password, salt);

    const user: LocalUser = {
      username,
      passwordHash: hash.toString('base64'),
      passwordSalt: salt,
      isAdmin,
      createdAt: Date.now(),
    };

    await persist([...users, user]);
    return user;
  });
}

export async function deleteLocalUser(username: string): Promise<void> {
  return serialise(async () => {
    const users = load();
    const filtered = users.filter(u => u.username !== username);
    if (filtered.length === users.length) throw notFound('User not found');
    await persist(filtered);
  });
}

export async function authenticateLocal(username: string, password: string): Promise<LocalUser> {
  const user = getLocalUser(username);
  // Hash either way, so how long a refusal takes does not tell anyone which
  // names have accounts.
  const hash = await hashPassword(password, user?.passwordSalt ?? 'no-such-user');
  const stored = user ? Buffer.from(user.passwordHash, 'base64') : null;
  if (!user || !stored || stored.length !== hash.length || !crypto.timingSafeEqual(stored, hash)) {
    throw unauthorized('Invalid username or password');
  }
  // Created before the directory had someone by this name: the directory wins.
  if (await serverAccountExists(username)) throw unauthorized('Invalid username or password');

  return user;
}
