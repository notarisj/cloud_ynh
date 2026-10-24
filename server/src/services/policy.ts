import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { config } from '../config';

/**
 * What an administrator has decided about accounts, in this app only.
 *
 * Two lists, kept apart from the directory on purpose: YunoHost owns its
 * users — their names, passwords and group memberships — and this app has no
 * business writing there. What it can decide for itself is whether an account
 * may use Cloud at all, and who besides the admins group administers Cloud.
 * Both apply to every account, YunoHost or local, the same way.
 *
 * Read synchronously and cached, like the share registry, because every
 * authenticated request asks whether its account is still allowed in.
 */

interface PolicyFile {
  /** Accounts that may not sign in to Cloud. */
  disabled: string[];
  /** Accounts made administrators of Cloud from inside the app. */
  admins: string[];
}

const policyFile = () => path.join(config.storage.metaDir, 'user-policy.json');
const RECHECK_MS = 1000;

let cache: PolicyFile | null = null;
let checkedAt = 0;
let cachedMtimeMs = -1;
let queue: Promise<unknown> = Promise.resolve();

function names(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase()))]
    : [];
}

function load(): PolicyFile {
  const now = Date.now();
  if (cache !== null && now - checkedAt < RECHECK_MS) return cache;
  try {
    const stats = fsSync.statSync(policyFile());
    if (cache === null || stats.mtimeMs !== cachedMtimeMs) {
      const raw = JSON.parse(fsSync.readFileSync(policyFile(), 'utf8')) as Partial<PolicyFile>;
      cache = { disabled: names(raw?.disabled), admins: names(raw?.admins) };
      cachedMtimeMs = stats.mtimeMs;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      cache = { disabled: [], admins: [] };
      cachedMtimeMs = -1;
    } else if (cache === null) {
      // Unreadable: fail closed for nobody and open for nobody — an empty
      // policy is exactly the state before anyone used these controls.
      cache = { disabled: [], admins: [] };
    }
  }
  checkedAt = now;
  return cache;
}

async function persist(next: PolicyFile): Promise<void> {
  const target = policyFile();
  const temp = `${target}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fs.rename(temp, target);
  cache = next;
  cachedMtimeMs = await fs.stat(target).then((s) => s.mtimeMs).catch(() => -1);
  checkedAt = Date.now();
}

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

export function isDisabled(username: string): boolean {
  return load().disabled.includes(username.toLowerCase());
}

/** Made an administrator from inside the app (not by the directory). */
export function isAppAdmin(username: string): boolean {
  return load().admins.includes(username.toLowerCase());
}

function toggle(list: string[], name: string, on: boolean): string[] {
  const without = list.filter((entry) => entry !== name);
  return on ? [...without, name] : without;
}

export function setDisabled(username: string, disabled: boolean): Promise<void> {
  const name = username.toLowerCase();
  return serialise(async () => {
    const current = load();
    await persist({ ...current, disabled: toggle(current.disabled, name, disabled) });
  });
}

export function setAppAdmin(username: string, admin: boolean): Promise<void> {
  const name = username.toLowerCase();
  return serialise(async () => {
    const current = load();
    await persist({ ...current, admins: toggle(current.admins, name, admin) });
  });
}

/** An account is gone: forget anything decided about it. */
export function forget(username: string): Promise<void> {
  const name = username.toLowerCase();
  return serialise(async () => {
    const current = load();
    await persist({
      disabled: current.disabled.filter((entry) => entry !== name),
      admins: current.admins.filter((entry) => entry !== name),
    });
  });
}
