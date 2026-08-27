import fs from 'fs/promises';
import fsSync, { type Stats } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { badRequest, conflict, fromNodeError, insufficientStorage, notFound } from '../lib/errors';
import { mimeFor, previewKind, thumbnailable, type PreviewKind } from '../lib/mime';
import {
  assertValidName,
  joinVPath,
  parentVPath,
  resolveVPath,
  rootDirFor,
  type ResolvedPath,
  type RootId,
} from '../lib/vpath';

export interface FileEntry {
  name: string;
  /** Virtual path, e.g. "/me/Documents/report.pdf". */
  path: string;
  isDir: boolean;
  size: number;
  /** Milliseconds since the epoch. */
  mtime: number;
  ctime: number;
  mime: string;
  preview: PreviewKind;
  hasThumbnail: boolean;
  /**
   * Changes whenever the bytes change. Used for HTTP caching, for optimistic
   * concurrency on writes, and as the File Provider content version.
   */
  etag: string;
}

export type SortKey = 'name' | 'size' | 'mtime' | 'kind';

export interface ListOptions {
  sort?: SortKey;
  descending?: boolean;
  /** Include entries whose name starts with a dot. */
  showHidden?: boolean;
}

//=================================================
// Entry construction
//=================================================

function etagOf(stats: Stats): string {
  // inode + size + mtime is enough to notice any content change without
  // hashing multi-gigabyte files on every listing.
  return crypto
    .createHash('sha1')
    .update(`${stats.ino}:${stats.size}:${stats.mtimeMs}`)
    .digest('base64url')
    .slice(0, 22);
}

function toEntry(vpath: string, name: string, stats: Stats): FileEntry {
  const isDir = stats.isDirectory();
  return {
    name,
    path: vpath,
    isDir,
    size: isDir ? 0 : stats.size,
    mtime: Math.round(stats.mtimeMs),
    ctime: Math.round(stats.ctimeMs),
    mime: isDir ? 'inode/directory' : mimeFor(name),
    preview: isDir ? null : previewKind(name),
    hasThumbnail: !isDir && config.previews.enabled && thumbnailable(name),
    etag: etagOf(stats),
  };
}

//=================================================
// Roots
//=================================================

/**
 * Create a user's private root and trash folder.
 *
 * Called on every authenticated request rather than only at login, because a
 * device can hold a valid token across a server restore that did not include
 * its directory — and a 404 on "/me" is a baffling thing for a user to be
 * shown. The result is memoised, so after the first request per account per
 * process this costs nothing.
 */
const provisionedRoots = new Set<string>();

export async function ensureUserRoot(username: string): Promise<void> {
  if (provisionedRoots.has(username)) return;

  const dir = path.join(config.storage.usersDir, username);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(config.storage.trashDir, username), { recursive: true, mode: 0o700 });
  provisionedRoots.add(username);
}

export interface RootInfo {
  id: RootId;
  name: string;
  path: string;
  writable: boolean;
}

export function rootsFor(_username: string): RootInfo[] {
  const roots: RootInfo[] = [{ id: 'me', name: 'My Files', path: '/me', writable: true }];
  if (config.storage.sharedEnabled) {
    roots.push({ id: 'shared', name: 'Shared', path: '/shared', writable: true });
  }
  return roots;
}

//=================================================
// Reading
//=================================================

export async function stat(username: string, vpath: string): Promise<FileEntry> {
  const resolved = await resolveVPath(username, vpath, { mustExist: true });
  const stats = await fs.stat(resolved.abs).catch((e) => {
    throw fromNodeError(e);
  });
  const name = resolved.rel === '' ? rootLabel(resolved.root) : path.basename(resolved.rel);
  return toEntry(resolved.vpath, name, stats);
}

function rootLabel(root: RootId): string {
  return root === 'shared' ? 'Shared' : 'My Files';
}

const KIND_ORDER: Record<string, number> = { image: 0, video: 1, audio: 2, pdf: 3, text: 4 };

function compare(a: FileEntry, b: FileEntry, key: SortKey): number {
  // Folders always lead, regardless of the sort key — this is what every file
  // browser does and what users expect when they flip to "largest first".
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;

  switch (key) {
    case 'size':
      return a.size - b.size;
    case 'mtime':
      return a.mtime - b.mtime;
    case 'kind': {
      const ka = KIND_ORDER[a.preview ?? ''] ?? 9;
      const kb = KIND_ORDER[b.preview ?? ''] ?? 9;
      if (ka !== kb) return ka - kb;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    }
    default:
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  }
}

export async function list(
  username: string,
  vpath: string,
  options: ListOptions = {},
): Promise<{ entry: FileEntry; entries: FileEntry[] }> {
  const resolved = await resolveVPath(username, vpath, { mustExist: true });

  const dirStats = await fs.stat(resolved.abs).catch((e) => {
    throw fromNodeError(e);
  });
  if (!dirStats.isDirectory()) throw badRequest('That path is not a folder', 'not_directory');

  const names = await fs.readdir(resolved.abs).catch((e) => {
    throw fromNodeError(e);
  });

  const entries: FileEntry[] = [];
  for (const name of names) {
    if (!options.showHidden && name.startsWith('.')) continue;
    // A file can disappear between readdir and stat; skipping it is more
    // useful than failing the whole listing.
    const stats = await fs.stat(path.join(resolved.abs, name)).catch(() => null);
    if (!stats) continue;
    if (!stats.isDirectory() && !stats.isFile()) continue;
    entries.push(toEntry(joinVPath(resolved.vpath, name), name, stats));
  }

  const key = options.sort ?? 'name';
  entries.sort((a, b) => compare(a, b, key));
  if (options.descending) entries.reverse();

  return {
    entry: toEntry(resolved.vpath, resolved.rel === '' ? rootLabel(resolved.root) : path.basename(resolved.rel), dirStats),
    entries,
  };
}

/** Resolve to an existing regular file — used by download, preview and thumbnails. */
export async function resolveFile(
  username: string,
  vpath: string,
): Promise<{ resolved: ResolvedPath; stats: Stats; name: string }> {
  const resolved = await resolveVPath(username, vpath, { mustExist: true });
  const stats = await fs.stat(resolved.abs).catch((e) => {
    throw fromNodeError(e);
  });
  if (stats.isDirectory()) throw badRequest('That path is a folder', 'is_directory');
  if (!stats.isFile()) throw notFound();
  return { resolved, stats, name: path.basename(resolved.abs) };
}

//=================================================
// Writing
//=================================================

export async function createFolder(username: string, vpath: string): Promise<FileEntry> {
  const resolved = await resolveVPath(username, vpath);
  if (resolved.rel === '') throw badRequest('Cannot create a root', 'invalid_path');

  try {
    await fs.mkdir(resolved.abs, { recursive: false, mode: 0o700 });
  } catch (err) {
    throw fromNodeError(err);
  }
  return stat(username, resolved.vpath);
}

/**
 * Pick a name that does not collide, the way the Finder does: "report.pdf",
 * then "report 2.pdf", "report 3.pdf". Used for uploads and copies when the
 * caller asked to keep both.
 */
export async function uniqueName(dirAbs: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);

  let candidate = name;
  for (let n = 2; n < 10000; n += 1) {
    const exists = await fs
      .lstat(path.join(dirAbs, candidate))
      .then(() => true)
      .catch(() => false);
    if (!exists) return candidate;
    candidate = `${base} ${n}${ext}`;
  }
  throw conflict('Too many files with that name', 'exists');
}

export type ConflictPolicy = 'fail' | 'replace' | 'rename';

async function prepareDestination(
  destAbs: string,
  policy: ConflictPolicy,
): Promise<string> {
  const exists = await fs.lstat(destAbs).then(() => true).catch(() => false);
  if (!exists) return destAbs;

  switch (policy) {
    case 'replace':
      await fs.rm(destAbs, { recursive: true, force: true });
      return destAbs;
    case 'rename':
      return path.join(path.dirname(destAbs), await uniqueName(path.dirname(destAbs), path.basename(destAbs)));
    default:
      throw conflict('A file or folder with that name already exists', 'exists');
  }
}

export async function move(
  username: string,
  fromVPath: string,
  toVPath: string,
  policy: ConflictPolicy = 'fail',
): Promise<FileEntry> {
  const from = await resolveVPath(username, fromVPath, { mustExist: true });
  const to = await resolveVPath(username, toVPath);

  if (from.rel === '') throw badRequest('Cannot move a root', 'invalid_path');
  if (to.rel === '') throw badRequest('Cannot replace a root', 'invalid_path');

  // Moving a folder into itself would silently detach the whole subtree.
  if (to.abs === from.abs || to.abs.startsWith(from.abs + path.sep)) {
    throw badRequest('Cannot move a folder into itself', 'invalid_move');
  }

  const destination = await prepareDestination(to.abs, policy);

  try {
    await fs.rename(from.abs, destination);
  } catch (err) {
    // EXDEV: "me" and "shared" could sit on different filesystems if the admin
    // mounted one of them elsewhere. Fall back to copy-then-delete.
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await fs.cp(from.abs, destination, { recursive: true, force: true, preserveTimestamps: true });
      await fs.rm(from.abs, { recursive: true, force: true });
    } else {
      throw fromNodeError(err);
    }
  }

  invalidateUsage(username);
  return stat(username, toVirtual(to, destination));
}

export async function copy(
  username: string,
  fromVPath: string,
  toVPath: string,
  policy: ConflictPolicy = 'rename',
): Promise<FileEntry> {
  const from = await resolveVPath(username, fromVPath, { mustExist: true });
  const to = await resolveVPath(username, toVPath);

  if (to.rel === '') throw badRequest('Cannot replace a root', 'invalid_path');
  if (to.abs === from.abs || to.abs.startsWith(from.abs + path.sep)) {
    throw badRequest('Cannot copy a folder into itself', 'invalid_copy');
  }

  const size = await treeSize(from.abs);
  await assertQuota(username, from.root, size);

  const destination = await prepareDestination(to.abs, policy);

  try {
    await fs.cp(from.abs, destination, { recursive: true, force: true, preserveTimestamps: true });
  } catch (err) {
    throw fromNodeError(err);
  }

  invalidateUsage(username);
  return stat(username, toVirtual(to, destination));
}

export async function rename(
  username: string,
  vpath: string,
  newName: string,
  policy: ConflictPolicy = 'fail',
): Promise<FileEntry> {
  assertValidName(newName);
  const parent = parentVPath(vpath);
  if (parent === null) throw badRequest('Cannot rename a root', 'invalid_path');
  return move(username, vpath, joinVPath(parent, newName), policy);
}

/** Recompute the virtual path after prepareDestination may have renamed it. */
function toVirtual(resolved: ResolvedPath, actualAbs: string): string {
  const parent = parentVPath(resolved.vpath);
  if (parent === null) return resolved.vpath;
  return joinVPath(parent, path.basename(actualAbs));
}

export async function hardDelete(username: string, vpath: string): Promise<void> {
  const resolved = await resolveVPath(username, vpath, { mustExist: true });
  if (resolved.rel === '') throw badRequest('Cannot delete a root', 'invalid_path');
  await fs.rm(resolved.abs, { recursive: true, force: true }).catch((e) => {
    throw fromNodeError(e);
  });
  invalidateUsage(username);
}

//=================================================
// Search
//=================================================

export interface SearchOptions {
  limit?: number;
  /** Restrict to a subtree, e.g. "/me/Photos". Defaults to every root. */
  scope?: string;
}

/**
 * Recursive filename search. Deliberately not indexed: for a personal server
 * a bounded walk is fast enough, has no index to fall out of date, and cannot
 * leak a name the caller is not allowed to see.
 */
export async function search(
  username: string,
  query: string,
  options: SearchOptions = {},
): Promise<FileEntry[]> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) throw badRequest('Search needs at least two characters', 'query_too_short');

  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const results: FileEntry[] = [];

  const scopes = options.scope
    ? [await resolveVPath(username, options.scope, { mustExist: true })]
    : await Promise.all(
        rootsFor(username).map((r) => resolveVPath(username, r.path, { mustExist: true })),
      );

  // Bound the walk so a pathological tree cannot pin a CPU core.
  const DEADLINE = Date.now() + 8000;
  const MAX_VISITED = 200_000;
  let visited = 0;

  async function walk(absDir: string, vDir: string, depth: number): Promise<void> {
    if (results.length >= limit || depth > 24 || Date.now() > DEADLINE || visited > MAX_VISITED) return;

    const dirents = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents) {
      if (results.length >= limit || Date.now() > DEADLINE) return;
      if (dirent.name.startsWith('.')) continue;
      visited += 1;

      const childAbs = path.join(absDir, dirent.name);
      const childV = joinVPath(vDir, dirent.name);

      if (dirent.name.toLowerCase().includes(needle)) {
        const stats = await fs.stat(childAbs).catch(() => null);
        if (stats) results.push(toEntry(childV, dirent.name, stats));
      }

      // Only descend into real directories: following a symlink here is how a
      // search turns into an infinite loop.
      if (dirent.isDirectory()) await walk(childAbs, childV, depth + 1);
    }
  }

  for (const scope of scopes) {
    await walk(scope.abs, scope.vpath, 0);
  }

  return results;
}

//=================================================
// Quota
//=================================================

interface UsageCache {
  bytes: number;
  computedAt: number;
}

const usageCache = new Map<string, UsageCache>();
const USAGE_TTL_MS = 5 * 60 * 1000;

export function invalidateUsage(username: string): void {
  usageCache.delete(username);
}

/** Adjust the cached figure after a write instead of rescanning the tree. */
export function adjustUsage(username: string, deltaBytes: number): void {
  const cached = usageCache.get(username);
  if (cached) cached.bytes = Math.max(0, cached.bytes + deltaBytes);
}

async function treeSize(absDir: string): Promise<number> {
  const stats = await fs.lstat(absDir).catch(() => null);
  if (!stats) return 0;
  if (stats.isFile()) return stats.size;
  if (!stats.isDirectory()) return 0;

  let total = 0;
  const dirents = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
  for (const dirent of dirents) {
    const child = path.join(absDir, dirent.name);
    if (dirent.isDirectory()) total += await treeSize(child);
    else if (dirent.isFile()) {
      const childStats = await fs.lstat(child).catch(() => null);
      if (childStats) total += childStats.size;
    }
  }
  return total;
}

export interface Usage {
  usedBytes: number;
  quotaBytes: number;
  /** Free space on the volume, so a client can warn before a doomed upload. */
  availableBytes: number;
}

export async function usage(username: string): Promise<Usage> {
  const cached = usageCache.get(username);
  let bytes: number;

  if (cached && Date.now() - cached.computedAt < USAGE_TTL_MS) {
    bytes = cached.bytes;
  } else {
    // A user's own files plus whatever their deleted items still occupy.
    bytes =
      (await treeSize(rootDirFor(username, 'me'))) +
      (await treeSize(path.join(config.storage.trashDir, username)));
    usageCache.set(username, { bytes, computedAt: Date.now() });
  }

  const quota = config.storage.userQuotaBytes;
  let available = Number.MAX_SAFE_INTEGER;
  try {
    const vfs = await fs.statfs(config.storage.dataDir);
    available = Number(vfs.bavail) * Number(vfs.bsize);
  } catch {
    /* statfs is unavailable on some kernels; treat free space as unknown. */
  }

  if (quota > 0) available = Math.min(available, Math.max(0, quota - bytes));

  return { usedBytes: bytes, quotaBytes: quota, availableBytes: available };
}

/**
 * Refuse a write that would not fit. Only the private root is metered — the
 * shared area is the admin's problem, not one user's allowance.
 */
export async function assertQuota(username: string, root: RootId, incomingBytes: number): Promise<void> {
  if (incomingBytes <= 0) return;

  if (incomingBytes > config.storage.maxUploadBytes) {
    throw insufficientStorage(
      `That file is larger than the ${formatBytes(config.storage.maxUploadBytes)} per-file limit.`,
    );
  }

  if (root !== 'me' || config.storage.userQuotaBytes <= 0) return;

  const { usedBytes, quotaBytes } = await usage(username);
  if (usedBytes + incomingBytes > quotaBytes) {
    throw insufficientStorage(
      `Not enough space: ${formatBytes(quotaBytes - usedBytes)} free of ${formatBytes(quotaBytes)}.`,
    );
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Synchronous existence check, for the few places a promise would be noise. */
export function existsSync(absPath: string): boolean {
  return fsSync.existsSync(absPath);
}
