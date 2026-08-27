import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { badRequest, fromNodeError, notFound } from '../lib/errors';
import { joinVPath, parentVPath, resolveVPath } from '../lib/vpath';
import { invalidateUsage, uniqueName, type FileEntry } from './storage';
import * as storage from './storage';

export interface TrashItem {
  id: string;
  name: string;
  /** Where it came from, so restore can put it back. */
  originalPath: string;
  deletedAt: number;
  size: number;
  isDir: boolean;
}

/** Deleted items are purged automatically after this long. */
export const RETENTION_DAYS = 30;

const userTrashDir = (username: string) => path.join(config.storage.trashDir, username);
const indexFile = (username: string) => path.join(userTrashDir(username), 'index.json');

//=================================================
// Index
//=================================================
// Items live in .meta/trash/<user>/<id>/<name> and are described by a single
// index.json. Keeping the original name inside a per-item directory means two
// files deleted from different folders never collide, and the name survives
// intact for the restore.

const queues = new Map<string, Promise<unknown>>();

function serialise<T>(username: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(username) ?? Promise.resolve();
  const next = previous.then(work, work);
  queues.set(username, next.catch(() => undefined));
  return next;
}

async function readIndex(username: string): Promise<TrashItem[]> {
  try {
    const raw = await fs.readFile(indexFile(username), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TrashItem[]) : [];
  } catch {
    return [];
  }
}

async function writeIndex(username: string, items: TrashItem[]): Promise<void> {
  const dir = userTrashDir(username);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = indexFile(username);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(items), { mode: 0o600 });
  await fs.rename(temp, target);
}

//=================================================
// Operations
//=================================================

export async function moveToTrash(username: string, vpath: string): Promise<TrashItem> {
  const resolved = await resolveVPath(username, vpath, { mustExist: true });
  if (resolved.rel === '') throw badRequest('Cannot delete a root', 'invalid_path');

  const stats = await fs.stat(resolved.abs).catch((e) => {
    throw fromNodeError(e);
  });

  const id = crypto.randomUUID();
  const name = path.basename(resolved.abs);
  const itemDir = path.join(userTrashDir(username), id);

  await fs.mkdir(itemDir, { recursive: true, mode: 0o700 });

  try {
    await fs.rename(resolved.abs, path.join(itemDir, name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      // Trash lives under the same data directory as "me", but the shared area
      // could be a separate mount.
      await fs.cp(resolved.abs, path.join(itemDir, name), { recursive: true, force: true });
      await fs.rm(resolved.abs, { recursive: true, force: true });
    } else {
      await fs.rm(itemDir, { recursive: true, force: true }).catch(() => undefined);
      throw fromNodeError(err);
    }
  }

  const item: TrashItem = {
    id,
    name,
    originalPath: resolved.vpath,
    deletedAt: Date.now(),
    size: stats.isDirectory() ? 0 : stats.size,
    isDir: stats.isDirectory(),
  };

  await serialise(username, async () => {
    const items = await readIndex(username);
    items.unshift(item);
    await writeIndex(username, items);
  });

  invalidateUsage(username);
  return item;
}

export async function list(username: string): Promise<TrashItem[]> {
  const items = await readIndex(username);
  return items.sort((a, b) => b.deletedAt - a.deletedAt);
}

export async function restore(username: string, id: string): Promise<FileEntry> {
  const items = await readIndex(username);
  const item = items.find((i) => i.id === id);
  if (!item) throw notFound('That item is no longer in the trash');

  const source = path.join(userTrashDir(username), item.id, item.name);
  const sourceExists = await fs.lstat(source).then(() => true).catch(() => false);
  if (!sourceExists) {
    await forget(username, id);
    throw notFound('That item is no longer in the trash');
  }

  // The folder it came from may itself have been deleted since. Recreate the
  // chain rather than refusing the restore.
  const parent = parentVPath(item.originalPath);
  if (parent === null) throw badRequest('Cannot restore to a root', 'invalid_path');
  await ensureFolderChain(username, parent);

  const parentResolved = await resolveVPath(username, parent, { mustExist: true });
  const finalName = await uniqueName(parentResolved.abs, item.name);
  const destination = path.join(parentResolved.abs, finalName);

  try {
    await fs.rename(source, destination);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await fs.cp(source, destination, { recursive: true, force: true });
      await fs.rm(source, { recursive: true, force: true });
    } else {
      throw fromNodeError(err);
    }
  }

  await fs.rm(path.join(userTrashDir(username), item.id), { recursive: true, force: true });
  await forget(username, id);
  invalidateUsage(username);

  return storage.stat(username, joinVPath(parent, finalName));
}

async function ensureFolderChain(username: string, vpath: string): Promise<void> {
  const segments = vpath.split('/').filter(Boolean);
  // segments[0] is the root, which always exists.
  for (let i = 2; i <= segments.length; i += 1) {
    const partial = '/' + segments.slice(0, i).join('/');
    const resolved = await resolveVPath(username, partial);
    await fs.mkdir(resolved.abs, { recursive: true, mode: 0o700 }).catch(() => undefined);
  }
}

/** Remove one item permanently. */
export async function purge(username: string, id: string): Promise<void> {
  const items = await readIndex(username);
  const item = items.find((i) => i.id === id);
  if (!item) throw notFound('That item is no longer in the trash');

  await fs.rm(path.join(userTrashDir(username), item.id), { recursive: true, force: true });
  await forget(username, id);
  invalidateUsage(username);
}

export async function empty(username: string): Promise<number> {
  const items = await readIndex(username);
  for (const item of items) {
    await fs.rm(path.join(userTrashDir(username), item.id), { recursive: true, force: true });
  }
  await serialise(username, () => writeIndex(username, []));
  invalidateUsage(username);
  return items.length;
}

async function forget(username: string, id: string): Promise<void> {
  await serialise(username, async () => {
    const items = await readIndex(username);
    await writeIndex(username, items.filter((i) => i.id !== id));
  });
}

/**
 * Drop anything past the retention window, and any item directory the index no
 * longer knows about (a crash between the rename and the index write).
 * Called at startup and once a day.
 */
export async function purgeExpired(): Promise<void> {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;

  const usernames = await fs.readdir(config.storage.trashDir).catch(() => [] as string[]);
  for (const username of usernames) {
    const dir = userTrashDir(username);
    const dirStats = await fs.lstat(dir).catch(() => null);
    if (!dirStats?.isDirectory()) continue;

    const items = await readIndex(username);
    const keep = items.filter((i) => i.deletedAt >= cutoff);

    for (const expired of items.filter((i) => i.deletedAt < cutoff)) {
      await fs.rm(path.join(dir, expired.id), { recursive: true, force: true }).catch(() => undefined);
    }

    if (keep.length !== items.length) {
      await serialise(username, () => writeIndex(username, keep));
      invalidateUsage(username);
    }

    // Orphaned item directories.
    const known = new Set(keep.map((i) => i.id));
    const present = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of present) {
      if (name === 'index.json' || name.startsWith('index.json.')) continue;
      if (known.has(name)) continue;
      await fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
