import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { badRequest, conflict, notFound, unauthorized } from '../lib/errors';
import { isPlausibleUsername } from './ldap';

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

export async function createLocalUser(username: string, password: string, isAdmin: boolean): Promise<LocalUser> {
  if (!isPlausibleUsername(username)) throw badRequest('Invalid username format');
  if (typeof password !== 'string' || password.length < 4) throw badRequest('Password too short');

  return serialise(async () => {
    const users = load();
    if (users.find(u => u.username === username)) {
      throw conflict('User already exists', 'user_exists');
    }

    const salt = crypto.randomBytes(16).toString('base64');
    const hash = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(password, salt, 64, (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey);
      });
    });

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
  if (!user) throw unauthorized('Invalid username or password');

  const hash = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, user.passwordSalt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });

  if (!crypto.timingSafeEqual(Buffer.from(user.passwordHash, 'base64'), hash)) {
    throw unauthorized('Invalid username or password');
  }

  return user;
}
