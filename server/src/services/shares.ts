import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';

/**
 * The share registry.
 *
 * Files never move when they are shared. Every byte a user owns lives under
 * their private root and is metered against their quota; sharing only records
 * that an item should also be reachable through "/shared". That is what keeps
 * the two views honest: "My Files" is everything you have, "Shared" is the
 * subset — yours and other people's — that somebody deliberately published.
 *
 * A record is small and there are never many of them, so the whole registry is
 * a single JSON file kept in memory. It is read synchronously on first use
 * because path resolution — which runs on every request — has to be able to
 * turn "/shared/Holiday Photos" into a directory without awaiting anything.
 */

export interface ShareRecord {
  id: string;
  /** Account that owns the bytes. */
  owner: string;
  /** Path relative to the owner's private root, e.g. "Photos/Trip". */
  rel: string;
  /**
   * The segment this share appears under in "/shared/<slug>". Unique across
   * the whole registry, so two people sharing "Notes" do not collide.
   */
  slug: string;
  sharedAt: number;
  visibility?: 'all' | 'users';
  sharedWith?: string[];
}

const registryFile = () => config.storage.sharesFile;

let cache: ShareRecord[] | null = null;
/** When the cache was last checked against the file, and what it saw. */
let checkedAt = 0;
let cachedMtimeMs = -1;
let queue: Promise<unknown> = Promise.resolve();

/** How stale the in-memory copy may be before the file is checked again. */
const RECHECK_MS = 1000;

function sanitise(value: unknown): ShareRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (record): record is ShareRecord =>
      !!record &&
      typeof record.id === 'string' &&
      typeof record.owner === 'string' &&
      typeof record.rel === 'string' &&
      record.rel.length > 0 &&
      typeof record.slug === 'string' &&
      record.slug.length > 0,
  );
}

/**
 * The registry, from memory.
 *
 * Path resolution runs on every request and cannot await anything, so the file
 * is held in memory — but it is not assumed to be the only writer. A restored
 * backup, an admin editing the file, or a second process all change it behind
 * this one's back, so the modification time is rechecked at most once a second
 * and the copy is reloaded when it has moved.
 */
function load(): ShareRecord[] {
  const now = Date.now();
  if (cache !== null && now - checkedAt < RECHECK_MS) return cache;

  try {
    const stats = fsSync.statSync(registryFile());
    if (cache === null || stats.mtimeMs !== cachedMtimeMs) {
      cache = sanitise(JSON.parse(fsSync.readFileSync(registryFile(), 'utf8')));
      cachedMtimeMs = stats.mtimeMs;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // The file is gone: either nothing has ever been shared, or an admin
      // deleted it to revoke everything at once. Both mean "no shares" — and
      // holding on to a cached copy would keep publishing files that the
      // server has been told to stop publishing.
      cache = [];
      cachedMtimeMs = -1;
    } else if (cache === null) {
      // Unreadable for some other reason, and nothing to fall back on. Start
      // from empty; the file is only rewritten by a deliberate share, never
      // on read, so nothing is lost by not understanding it today.
      cache = [];
    }
  }

  checkedAt = now;
  return cache;
}

async function persist(records: ShareRecord[]): Promise<void> {
  const target = registryFile();
  const temp = `${target}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temp, JSON.stringify(records, null, 2), { mode: 0o600 });
  await fs.rename(temp, target);

  cache = records;
  // Adopt what was just written as the known-good state, so the next read does
  // not throw the fresh copy away and re-parse the file.
  cachedMtimeMs = await fs.stat(target).then((stats) => stats.mtimeMs).catch(() => -1);
  checkedAt = Date.now();
}

/** Serialise writes so two shares created at once cannot lose each other. */
function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

//=================================================
// Reading
//=================================================

export function enabled(): boolean {
  return config.storage.sharingEnabled;
}

export function all(): ShareRecord[] {
  return enabled() ? load() : [];
}

export function bySlug(slug: string): ShareRecord | undefined {
  return all().find((record) => record.slug === slug);
}

export function byId(id: string): ShareRecord | undefined {
  return all().find((record) => record.id === id);
}

/** Absolute path of the shared item on disk. */
export function absOf(record: ShareRecord): string {
  return path.join(config.storage.usersDir, record.owner, record.rel);
}

/** The record that publishes exactly this item, if there is one. */
export function recordFor(owner: string, rel: string): ShareRecord | undefined {
  return all().find((record) => record.owner === owner && record.rel === rel);
}

/** Every relative path this owner currently publishes, for decorating listings. */
export function sharedRelsOf(owner: string): Map<string, ShareRecord> {
  const map = new Map<string, ShareRecord>();
  for (const record of all()) if (record.owner === owner) map.set(record.rel, record);
  return map;
}

//=================================================
// Writing
//=================================================

function slugify(name: string, taken: Set<string>): string {
  // The slug becomes a path segment, so it must contain nothing that path
  // validation would later reject: no separators, no control characters, no
  // leading or trailing whitespace, and short enough to stay under the 255
  // byte filename limit once a disambiguating suffix is appended.
  const cleaned =
    name
      .replace(/[/\\\0]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'Shared item';
  const extension = path.extname(cleaned);
  const base = cleaned.slice(0, cleaned.length - extension.length) || cleaned;

  let candidate = cleaned;
  for (let n = 2; taken.has(candidate) && n < 1000; n += 1) candidate = `${base} ${n}${extension}`;
  return candidate;
}

/**
 * Publish one item. The caller has already proved the path exists and belongs
 * to them; this only records it.
 */
export function share(
  owner: string,
  rel: string,
  name: string,
  visibility: 'all' | 'users' = 'all',
  sharedWith: string[] = []
): Promise<ShareRecord> {
  if (!enabled()) throw forbidden('Sharing is disabled on this server', 'sharing_disabled');
  if (rel.length === 0) throw badRequest('Cannot share a whole root', 'invalid_path');

  return serialise(async () => {
    const records = load();

    const existing = records.find((record) => record.owner === owner && record.rel === rel);
    if (existing) {
      // Update existing visibility settings
      existing.visibility = visibility;
      existing.sharedWith = sharedWith;
      await persist(records);
      return existing;
    }

    // Sharing a folder that already sits inside a shared folder would show the
    // same bytes twice under two names.
    const enclosing = records.find(
      (record) => record.owner === owner && (rel === record.rel || rel.startsWith(record.rel + '/')),
    );
    if (enclosing) {
      throw conflict(`Already shared as part of “${enclosing.slug}”`, 'already_shared');
    }

    const record: ShareRecord = {
      id: crypto.randomUUID(),
      owner,
      rel,
      slug: slugify(name, new Set(records.map((r) => r.slug))),
      sharedAt: Date.now(),
      visibility,
      sharedWith,
    };

    await persist([...records, record]);
    return record;
  });
}

/** Stop publishing one item. Only its owner (or an admin) may do this. */
export function unshare(
  requester: { username: string; isAdmin: boolean },
  match: { id?: string; owner?: string; rel?: string },
): Promise<ShareRecord> {
  return serialise(async () => {
    const records = load();
    const record = records.find((candidate) =>
      match.id !== undefined
        ? candidate.id === match.id
        : candidate.owner === match.owner && candidate.rel === match.rel,
    );
    if (!record) throw notFound('That item is not shared', 'not_shared');
    if (record.owner !== requester.username && !requester.isAdmin) {
      throw forbidden('Only the owner can stop sharing an item', 'not_owner');
    }

    await persist(records.filter((candidate) => candidate.id !== record.id));
    return record;
  });
}

/**
 * Follow a rename or a move. A shared folder that its owner reorganises should
 * stay shared — the alternative is a share that silently points at nothing.
 */
export function relocate(owner: string, fromRel: string, toRel: string): Promise<void> {
  return serialise(async () => {
    const records = load();
    let changed = false;

    const updated = records.map((record) => {
      if (record.owner !== owner) return record;

      if (record.rel === fromRel) {
        changed = true;
        const oldName = fromRel.split('/').pop() ?? '';
        const newName = toRel.split('/').pop() ?? '';
        // Renaming the item renames the share: leaving "Holiday Photos" on
        // display after the folder became "Iceland" is just a stale label.
        const slug =
          record.slug === oldName && newName !== oldName
            ? slugify(newName, new Set(records.filter((r) => r.id !== record.id).map((r) => r.slug)))
            : record.slug;
        return { ...record, rel: toRel, slug };
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

/** Drop the shares covering an item that has just been deleted or trashed. */
export function forgetUnder(owner: string, rel: string): Promise<void> {
  return serialise(async () => {
    const records = load();
    const kept = records.filter(
      (record) => record.owner !== owner || (record.rel !== rel && !record.rel.startsWith(rel + '/')),
    );
    if (kept.length !== records.length) await persist(kept);
  });
}

/** Forget everything an account published — used when its files are removed. */
export function forgetOwner(owner: string): Promise<void> {
  return serialise(async () => {
    const records = load();
    const kept = records.filter((record) => record.owner !== owner);
    if (kept.length !== records.length) await persist(kept);
  });
}

/**
 * Drop records whose file no longer exists.
 *
 * The registry is kept up to date by the operations that move and delete
 * files, but the data directory can also be changed from outside the app — by
 * a restored backup, by rsync, by an admin with a shell. Rather than let a
 * dangling record turn every "/shared" listing into a 404, the sweep runs at
 * startup and once a day.
 */
export async function prune(): Promise<number> {
  if (!enabled()) return 0;

  const records = load();
  const alive: ShareRecord[] = [];

  for (const record of records) {
    const exists = await fs.lstat(absOf(record)).then(() => true).catch(() => false);
    if (exists) alive.push(record);
  }

  if (alive.length === records.length) return 0;
  const removed = records.length - alive.length;
  await serialise(() => persist(alive));
  console.warn(`[cloud] pruned ${removed} share(s) whose file no longer exists`);
  return removed;
}
