import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { badRequest, forbidden, notFound } from '../lib/errors';

/**
 * Public links.
 *
 * A link publishes one of a user's items to anyone who has the URL — no
 * account, no portal. Like a share, it never moves or copies anything: the
 * record points into the owner's own files, follows the item when it is
 * renamed or moved, and disappears with it when it is deleted. Each item has
 * at most one link, so "the link to this" is always a single, revocable thing.
 *
 * The token is the only secret. It is 24 random bytes, long enough that it
 * cannot be guessed, and it is stored as given so the owner can copy the link
 * again later; the registry is readable only by the service user.
 */

export interface LinkRecord {
  id: string;
  token: string;
  owner: string;
  /** Path relative to the owner's private root. */
  rel: string;
  createdAt: number;
  /** Milliseconds since the epoch, or null for a link that does not expire. */
  expiresAt: number | null;
}

const registryFile = () => config.storage.linksFile;

let cache: LinkRecord[] | null = null;
let queue: Promise<unknown> = Promise.resolve();

export function enabled(): boolean {
  return config.publicLinks.enabled;
}

function assertEnabled(): void {
  if (!enabled()) throw forbidden('Public links are turned off on this server', 'links_disabled');
}

function sanitise(value: unknown): LinkRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (record): record is LinkRecord =>
      !!record &&
      typeof record.id === 'string' &&
      typeof record.token === 'string' &&
      typeof record.owner === 'string' &&
      typeof record.rel === 'string' &&
      record.rel.length > 0,
  );
}

async function load(): Promise<LinkRecord[]> {
  if (cache) return cache;
  try {
    cache = sanitise(JSON.parse(await fs.readFile(registryFile(), 'utf8')));
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(records: LinkRecord[]): Promise<void> {
  const target = registryFile();
  const temp = `${target}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temp, JSON.stringify(records, null, 2), { mode: 0o600 });
  await fs.rename(temp, target);
  cache = records;
}

/** Serialise writes so two changes made at once cannot lose each other. */
function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

const isLive = (record: LinkRecord, now = Date.now()) => record.expiresAt === null || record.expiresAt > now;

//=================================================
// Reading
//=================================================

/** An owner's live links, newest first. */
export async function ownedBy(owner: string): Promise<LinkRecord[]> {
  if (!enabled()) return [];
  return (await load())
    .filter((record) => record.owner === owner && isLive(record))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** The live link for a token. Constant-time against the token itself. */
export async function byToken(token: string): Promise<LinkRecord | undefined> {
  if (!enabled() || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return undefined;
  const wanted = Buffer.from(token);
  return (await load()).find((record) => {
    const have = Buffer.from(record.token);
    return have.length === wanted.length && crypto.timingSafeEqual(have, wanted) && isLive(record);
  });
}

export function absOf(record: LinkRecord): string {
  return path.join(config.storage.usersDir, record.owner, record.rel);
}

export function urlOf(record: LinkRecord): string {
  return `${config.publicUrl}/s/${record.token}`;
}

//=================================================
// Writing
//=================================================

/** Create the link for an item, or change the expiry of the one it has. */
export function upsert(owner: string, rel: string, expiresAt: number | null): Promise<LinkRecord> {
  assertEnabled();
  if (rel.length === 0) throw badRequest('Cannot publish the whole of My Files', 'invalid_path');
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
    throw badRequest('The expiry must be in the future', 'invalid_expiry');
  }

  return serialise(async () => {
    const records = (await load()).filter((record) => isLive(record));
    const existing = records.find((record) => record.owner === owner && record.rel === rel);
    if (existing) {
      const updated = { ...existing, expiresAt };
      await persist(records.map((record) => (record.id === existing.id ? updated : record)));
      return updated;
    }

    const record: LinkRecord = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(24).toString('base64url'),
      owner,
      rel,
      createdAt: Date.now(),
      expiresAt,
    };
    await persist([...records, record]);
    return record;
  });
}

/** Stop a link working. Only its owner (or an admin) may. */
export function revoke(requester: { username: string; isAdmin: boolean }, id: string): Promise<void> {
  return serialise(async () => {
    const records = await load();
    const record = records.find((candidate) => candidate.id === id);
    if (!record) throw notFound('That link no longer exists', 'no_link');
    if (record.owner !== requester.username && !requester.isAdmin) {
      throw forbidden('Only the owner can remove a link', 'not_owner');
    }
    await persist(records.filter((candidate) => candidate.id !== id));
  });
}

/** Follow a rename or a move, so a link keeps pointing at its item. */
export function relocate(owner: string, fromRel: string, toRel: string): Promise<void> {
  return serialise(async () => {
    const records = await load();
    let changed = false;
    const updated = records.map((record) => {
      if (record.owner !== owner) return record;
      if (record.rel === fromRel) {
        changed = true;
        return { ...record, rel: toRel };
      }
      if (record.rel.startsWith(fromRel + '/')) {
        changed = true;
        return { ...record, rel: toRel + record.rel.slice(fromRel.length) };
      }
      return record;
    });
    if (changed) await persist(updated);
  });
}

/** Drop the links to an item that has just been deleted, and to anything inside it. */
export function forgetUnder(owner: string, rel: string): Promise<void> {
  return serialise(async () => {
    const records = await load();
    const kept = records.filter(
      (record) => record.owner !== owner || (record.rel !== rel && !record.rel.startsWith(rel + '/')),
    );
    if (kept.length !== records.length) await persist(kept);
  });
}

/** Daily: drop expired links and links whose item vanished behind the app's back. */
export async function prune(): Promise<number> {
  const records = await load();
  const alive: LinkRecord[] = [];
  for (const record of records) {
    if (!isLive(record)) continue;
    if (await fs.lstat(absOf(record)).then(() => true, () => false)) alive.push(record);
  }
  if (alive.length === records.length) return 0;
  await serialise(() => persist(alive));
  return records.length - alive.length;
}
