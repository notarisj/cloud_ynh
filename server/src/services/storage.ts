import fs from 'fs/promises';
import fsSync, { type Stats } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { badRequest, conflict, fromNodeError, insufficientStorage, notFound } from '../lib/errors';
import { mimeFor, previewKind, thumbnailable, type PreviewKind } from '../lib/mime';
import {
  assertValidName,
  assertWritable,
  joinVPath,
  ownerRelOf,
  parentVPath,
  parseVPath,
  resolveVPath,
  rootDirFor,
  type ResolvedPath,
  type RootId,
} from '../lib/vpath';
import * as shares from './shares';

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

  //-----------------------------------------------
  // Sharing
  //-----------------------------------------------
  // All four are optional so that a client built against an older release —
  // the iOS app in the field, for instance — keeps decoding these listings.

  /** Set on an item of your own that is published under "/shared". */
  shared?: boolean;
  /** Where that published item appears, e.g. "/shared/Holiday Photos". */
  sharedAs?: string;
  /** Set when the item was reached through "/shared": who published it. */
  sharedBy?: string;
  /** Set when the caller may read this item but not change it. */
  readOnly?: boolean;
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
  if (shares.enabled()) {
    // Not writable, and deliberately so: "Shared" lists what people have
    // published, so the only way something appears there is by being shared
    // from the files it already lives in.
    roots.push({ id: 'shared', name: 'Shared', path: '/shared', writable: false });
  }
  return roots;
}

//=================================================
// Reading
//=================================================

export async function stat(username: string, vpath: string): Promise<FileEntry> {
  const resolved = await resolveVPath(username, vpath, { mustExist: true });
  if (resolved.isShareIndex) return shareIndexEntry();

  const stats = await fs.stat(resolved.abs).catch((e) => {
    throw fromNodeError(e);
  });
  const name = displayNameOf(resolved);
  return decorate(username, resolved, toEntry(resolved.vpath, name, stats));
}

/** What to call a path in a breadcrumb: the root's label, or the file's name. */
function displayNameOf(resolved: ResolvedPath): string {
  if (resolved.root === 'me') return resolved.rel === '' ? 'My Files' : path.basename(resolved.rel);
  if (resolved.rel === '') return resolved.share?.slug ?? 'Shared';
  return path.basename(resolved.rel);
}

/**
 * "/shared" is an index, not a directory, so its own entry is synthesised.
 * Giving it a real mtime and etag keeps the clients' caching logic working
 * without teaching them that this one path is special.
 */
function shareIndexEntry(): FileEntry {
  const records = shares.all();
  const newest = records.reduce((latest, record) => Math.max(latest, record.sharedAt), 0);
  return {
    name: 'Shared',
    path: '/shared',
    isDir: true,
    size: 0,
    mtime: newest,
    ctime: newest,
    mime: 'inode/directory',
    preview: null,
    hasThumbnail: false,
    etag: crypto
      .createHash('sha1')
      .update(records.map((record) => `${record.id}:${record.rel}`).join('|'))
      .digest('base64url')
      .slice(0, 22),
    readOnly: true,
  };
}

/** Tag an entry with what the caller may do with it and where it is published. */
function decorate(username: string, resolved: ResolvedPath, entry: FileEntry): FileEntry {
  if (resolved.root === 'shared') {
    entry.sharedBy = resolved.owner;
    entry.shared = true;
    if (resolved.share) entry.sharedAs = `/shared/${resolved.share.slug}`;
    if (!resolved.writable) entry.readOnly = true;
    return entry;
  }

  const record = shares.recordFor(username, ownerRelOf(resolved));
  if (record) {
    entry.shared = true;
    entry.sharedAs = `/shared/${record.slug}`;
  }
  return entry;
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

export interface ListResult {
  entry: FileEntry;
  entries: FileEntry[];
  /** Whether the caller may add to, or change things in, this folder. */
  writable: boolean;
}

export async function list(
  username: string,
  vpath: string,
  options: ListOptions = {},
): Promise<ListResult> {
  const resolved = await resolveVPath(username, vpath, { mustExist: true });

  if (resolved.isShareIndex) return listShareIndex(username, options);

  const dirStats = await fs.stat(resolved.abs).catch((e) => {
    throw fromNodeError(e);
  });
  if (!dirStats.isDirectory()) throw badRequest('That path is not a folder', 'not_directory');

  const names = await fs.readdir(resolved.abs).catch((e) => {
    throw fromNodeError(e);
  });

  // One lookup for the whole folder rather than one per entry.
  const published = resolved.root === 'me' ? shares.sharedRelsOf(username) : new Map();
  const parentRel = ownerRelOf(resolved);

  const entries: FileEntry[] = [];
  for (const name of names) {
    if (!options.showHidden && name.startsWith('.')) continue;
    // A file can disappear between readdir and stat; skipping it is more
    // useful than failing the whole listing.
    const stats = await fs.stat(path.join(resolved.abs, name)).catch(() => null);
    if (!stats) continue;
    if (!stats.isDirectory() && !stats.isFile()) continue;

    const entry = toEntry(joinVPath(resolved.vpath, name), name, stats);

    if (resolved.root === 'shared') {
      entry.sharedBy = resolved.owner;
      if (!resolved.writable) entry.readOnly = true;
    } else {
      const record = published.get(parentRel === '' ? name : `${parentRel}/${name}`);
      if (record) {
        entry.shared = true;
        entry.sharedAs = `/shared/${record.slug}`;
      }
    }

    entries.push(entry);
  }

  const key = options.sort ?? 'name';
  entries.sort((a, b) => compare(a, b, key));
  if (options.descending) entries.reverse();

  return {
    entry: decorate(username, resolved, toEntry(resolved.vpath, displayNameOf(resolved), dirStats)),
    entries,
    writable: resolved.writable,
  };
}

/**
 * The contents of "/shared": one entry per published item, wherever it lives.
 *
 * Records whose file has vanished are skipped rather than reported. The daily
 * sweep is what removes them for good; a listing is not the place to start
 * rewriting the registry.
 */
async function listShareIndex(username: string, options: ListOptions): Promise<ListResult> {
  const entries: FileEntry[] = [];

  for (const record of shares.all()) {
    if (record.visibility === 'users' && record.owner !== username && !record.sharedWith?.includes(username)) {
      continue; // Not shared with this user
    }

    const stats = await fs.stat(shares.absOf(record)).catch(() => null);
    if (!stats) continue;
    if (!stats.isDirectory() && !stats.isFile()) continue;

    const entry = toEntry(`/shared/${record.slug}`, record.slug, stats);
    entry.shared = true;
    entry.sharedBy = record.owner;
    entry.sharedAs = `/shared/${record.slug}`;
    if (record.owner !== username) entry.readOnly = true;
    entries.push(entry);
  }

  const key = options.sort ?? 'name';
  entries.sort((a, b) => compare(a, b, key));
  if (options.descending) entries.reverse();

  return { entry: shareIndexEntry(), entries, writable: false };
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
  if (resolved.isRoot) throw badRequest('Cannot create a root', 'invalid_path');
  assertWritable(resolved);

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

  assertNotShareRoot(from, 'move or rename');
  assertNotShareRoot(to, 'replace');
  if (from.isRoot) throw badRequest('Cannot move a root', 'invalid_path');
  if (to.isRoot) throw badRequest('Cannot replace a root', 'invalid_path');
  assertWritable(from);
  assertWritable(to);

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

  // A share follows the item it publishes: someone who reorganises their own
  // files should not silently un-share half of them. Anything the move
  // overwrote is gone, so its share goes with it.
  const finalRel = siblingRel(ownerRelOf(to), path.basename(destination));
  if (finalRel !== ownerRelOf(from)) {
    await shares.forgetUnder(to.owner, finalRel);
    await shares.relocate(from.owner, ownerRelOf(from), finalRel);
  }

  invalidateUsage(username);
  return stat(username, toVirtual(to, destination));
}

/**
 * A share's top-level item is not a folder inside "/shared" that can be
 * renamed or deleted there — it is somebody's own file, seen through the
 * index. Changing it happens where it lives.
 */
function assertNotShareRoot(resolved: ResolvedPath, verb: string): void {
  if (resolved.root === 'shared' && resolved.rel === '' && resolved.share) {
    throw badRequest(
      `Cannot ${verb} a shared item from here — open it in My Files, or stop sharing it.`,
      'share_root',
    );
  }
}

/** Replace the last segment of a relative path, keeping its parent. */
function siblingRel(rel: string, name: string): string {
  const parent = rel.split('/').slice(0, -1).join('/');
  return parent === '' ? name : `${parent}/${name}`;
}

export async function copy(
  username: string,
  fromVPath: string,
  toVPath: string,
  policy: ConflictPolicy = 'rename',
): Promise<FileEntry> {
  const from = await resolveVPath(username, fromVPath, { mustExist: true });
  const to = await resolveVPath(username, toVPath);

  assertNotShareRoot(to, 'replace');
  if (to.isRoot) throw badRequest('Cannot replace a root', 'invalid_path');
  assertWritable(to);
  if (to.abs === from.abs || to.abs.startsWith(from.abs + path.sep)) {
    throw badRequest('Cannot copy a folder into itself', 'invalid_copy');
  }

  const size = await treeSize(from.abs);
  // The copy is charged to whoever will own it, which is what makes copying
  // something out of Shared count against the person taking the copy.
  await assertQuota(to.owner, size);

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
  assertNotShareRoot(parseVPath(username, vpath), 'move or rename');
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
  assertNotShareRoot(resolved, 'delete');
  if (resolved.isRoot) throw badRequest('Cannot delete a root', 'invalid_path');
  assertWritable(resolved);

  await fs.rm(resolved.abs, { recursive: true, force: true }).catch((e) => {
    throw fromNodeError(e);
  });

  // Nothing left to publish.
  await shares.forgetUnder(resolved.owner, ownerRelOf(resolved));
  invalidateUsage(resolved.owner);
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

  const scopes = await searchScopes(username, options.scope);

  // Bound the walk so a pathological tree cannot pin a CPU core.
  const DEADLINE = Date.now() + 8000;
  const MAX_VISITED = 200_000;
  let visited = 0;

  // Set while walking a shared subtree, so a hit can say who published it.
  let owner: string | null = null;

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
        if (stats) {
          const entry = toEntry(childV, dirent.name, stats);
          if (owner !== null) {
            entry.sharedBy = owner;
            if (owner !== username) entry.readOnly = true;
          }
          results.push(entry);
        }
      }

      // Only descend into real directories: following a symlink here is how a
      // search turns into an infinite loop.
      if (dirent.isDirectory()) await walk(childAbs, childV, depth + 1);
    }
  }

  for (const scope of scopes) {
    owner = scope.owner;
    await walk(scope.abs, scope.vpath, 0);
  }

  return results;
}

interface SearchScope {
  abs: string;
  vpath: string;
  /** Owner when the scope is a shared item; null for the caller's own files. */
  owner: string | null;
}

/**
 * Where a search looks.
 *
 * Unscoped, that is the caller's own files plus everything other people have
 * shared. Their *own* shared items are deliberately not walked twice: the item
 * is already covered by "/me", and a result list that shows the same photo
 * under two paths is a puzzle, not a feature.
 */
async function searchScopes(username: string, scopePath?: string): Promise<SearchScope[]> {
  if (scopePath) {
    const resolved = await resolveVPath(username, scopePath, { mustExist: true });
    if (!resolved.isShareIndex) {
      return [{ abs: resolved.abs, vpath: resolved.vpath, owner: resolved.root === 'shared' ? resolved.owner : null }];
    }
    return shares
      .all()
      .map((record) => ({ abs: shares.absOf(record), vpath: `/shared/${record.slug}`, owner: record.owner }));
  }

  const own = await resolveVPath(username, '/me', { mustExist: true });
  const scopes: SearchScope[] = [{ abs: own.abs, vpath: own.vpath, owner: null }];

  for (const record of shares.all()) {
    if (record.owner === username) continue;
    scopes.push({ abs: shares.absOf(record), vpath: `/shared/${record.slug}`, owner: record.owner });
  }

  return scopes;
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
 * Refuse a write that would not fit.
 *
 * Every file has exactly one owner and lives in that owner's private root, so
 * there is no unmetered corner of the storage any more: sharing something does
 * not hand its bytes to the server, and copying something out of Shared bills
 * the person taking the copy.
 */
export async function assertQuota(username: string, incomingBytes: number): Promise<void> {
  if (incomingBytes <= 0) return;

  if (incomingBytes > config.storage.maxUploadBytes) {
    throw insufficientStorage(
      `That file is larger than the ${formatBytes(config.storage.maxUploadBytes)} per-file limit.`,
    );
  }

  if (config.storage.userQuotaBytes <= 0) return;

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
