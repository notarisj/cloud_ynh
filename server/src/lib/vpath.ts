import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { badRequest, forbidden, notFound } from './errors';
import * as shares from '../services/shares';

/**
 * Clients never see filesystem paths. They see *virtual* paths of the form
 *
 *     /me/Documents/report.pdf
 *     /shared/Holiday Photos/beach.jpg
 *
 * where the first segment names a root. "me" is the caller's private
 * directory. Keeping the caller's username out of the path means a device that
 * logs in as somebody else automatically sees the right files without
 * rewriting anything it has cached.
 *
 * "shared" is not a directory at all. It is an index: its children are the
 * items people have published, each one resolving back into its owner's
 * private root. A file therefore has exactly one home — the owner's — and
 * sharing never moves, copies or hides it. "/shared/Holiday Photos" and
 * "/me/Photos/Holiday" can be the very same directory, seen from two angles.
 */
export type RootId = 'me' | 'shared';

export const ROOTS: readonly RootId[] = ['me', 'shared'];

export interface ResolvedPath {
  /** Canonical virtual path, e.g. "/me/Documents/report.pdf". */
  vpath: string;
  root: RootId;
  /** Path relative to the root, "" for the root itself. */
  rel: string;
  /** Absolute path on disk. Empty for the "/shared" index, which has none. */
  abs: string;
  /** Absolute path of the subtree this resolved into. */
  rootAbs: string;
  /** Account whose bytes these are — the caller, or the owner of a share. */
  owner: string;
  /** Whether the caller may modify what this path points at. */
  writable: boolean;
  /** The share this path was reached through, when it came in via "/shared". */
  share: shares.ShareRecord | null;
  /** True for "/me" and "/shared" themselves, and for a share's top item. */
  isRoot: boolean;
  /** True only for "/shared", which is an index rather than a directory. */
  isShareIndex: boolean;
}

/** Absolute directory backing a user's private root. */
export function rootDirFor(username: string, root: RootId = 'me'): string {
  if (root === 'shared') {
    throw badRequest('The shared index has no single directory', 'invalid_root');
  }
  return path.join(config.storage.usersDir, username);
}

/**
 * Reject anything that could escape a directory or confuse the filesystem.
 * Enforced on every path segment a client supplies, including upload targets
 * and rename destinations.
 */
export function assertValidName(name: string): void {
  if (name.length === 0) throw badRequest('Name cannot be empty', 'invalid_name');
  if (name === '.' || name === '..') throw badRequest('Invalid name', 'invalid_name');
  if (name.includes('/') || name.includes('\0')) {
    throw badRequest('Names cannot contain slashes or null bytes', 'invalid_name');
  }
  // ext4 caps a filename at 255 bytes, not 255 characters.
  if (Buffer.byteLength(name, 'utf8') > 255) {
    throw badRequest('Name is too long (255 bytes maximum)', 'invalid_name');
  }
  if (name.trim() !== name) {
    throw badRequest('Names cannot start or end with whitespace', 'invalid_name');
  }
}

/**
 * Parse and normalise a client-supplied virtual path without touching the
 * filesystem. Throws on traversal attempts and unknown roots.
 */
export function parseVPath(username: string, input: string): ResolvedPath {
  if (typeof input !== 'string' || input.includes('\0')) {
    throw badRequest('Invalid path', 'invalid_path');
  }

  // Normalise separators and collapse "." / duplicate slashes. The result is
  // still untrusted — normalize() happily produces a leading "..".
  const normalised = path.posix.normalize('/' + input.replace(/\\/g, '/')).replace(/\/+$/, '');
  const segments = normalised.split('/').filter((s) => s.length > 0);

  if (segments.some((s) => s === '..')) {
    throw forbidden('Path traversal is not allowed', 'traversal');
  }

  const rootSegment = segments[0];
  if (rootSegment === undefined) {
    throw badRequest('A path must name a root ("/me" or "/shared")', 'invalid_path');
  }
  if (!ROOTS.includes(rootSegment as RootId)) {
    throw badRequest(`Unknown root "${rootSegment}"`, 'invalid_root');
  }
  const root = rootSegment as RootId;

  if (root === 'shared') return parseSharedPath(username, segments);

  const restSegments = segments.slice(1);
  for (const segment of restSegments) assertValidName(segment);

  const rootAbs = rootDirFor(username);
  const rel = restSegments.join('/');

  return {
    vpath: '/' + ['me', ...restSegments].join('/'),
    root: 'me',
    rel,
    abs: rel === '' ? rootAbs : path.join(rootAbs, rel),
    rootAbs,
    owner: username,
    writable: true,
    share: null,
    isRoot: rel === '',
    isShareIndex: false,
  };
}

/**
 * "/shared" itself, or "/shared/<slug>/…" — one published item and whatever
 * lies beneath it. The slug is looked up in the registry; everything after it
 * is an ordinary relative path inside the owner's directory.
 */
function parseSharedPath(username: string, segments: string[]): ResolvedPath {
  if (!shares.enabled()) {
    throw forbidden('Sharing is disabled on this server', 'sharing_disabled');
  }

  const slug = segments[1];
  if (slug === undefined) {
    return {
      vpath: '/shared',
      root: 'shared',
      rel: '',
      abs: '',
      rootAbs: '',
      owner: '',
      // Nothing is ever written to the index itself: publishing an item is a
      // share, not an upload.
      writable: false,
      share: null,
      isRoot: true,
      isShareIndex: true,
    };
  }

  const record = shares.bySlug(slug);
  if (!record) throw notFound('That shared item is no longer available', 'not_shared');

  if (record.visibility === 'users' && record.owner !== username) {
    if (!record.sharedWith?.includes(username)) {
      throw forbidden('This shared item is not accessible to you', 'not_shared_with_you');
    }
  }

  const restSegments = segments.slice(2);
  for (const segment of restSegments) assertValidName(segment);

  const rootAbs = shares.absOf(record);
  const rel = restSegments.join('/');

  return {
    vpath: '/' + ['shared', slug, ...restSegments].join('/'),
    root: 'shared',
    rel,
    abs: rel === '' ? rootAbs : path.join(rootAbs, rel),
    rootAbs,
    owner: record.owner,
    // Everyone with access to the app may read a shared item; only its owner
    // may change it, and even then the canonical place to do that is their own
    // files. Someone else's share is never a place to drop things.
    writable: record.owner === username,
    share: record,
    isRoot: rel === '',
    isShareIndex: false,
  };
}

/**
 * Parse a virtual path *and* prove that the real path it lands on is inside
 * the subtree it claims to be in, following symlinks.
 *
 * parseVPath alone is not enough: a symlink placed inside the data directory
 * (by a restored backup, by another app, or by a user with shell access) would
 * otherwise let a request read anywhere the service user can reach. The check
 * walks up to the nearest ancestor that exists, canonicalises that, and
 * compares prefixes — so it works for paths that are about to be created as
 * well as ones that already exist.
 */
export async function resolveVPath(
  username: string,
  input: string,
  opts: { mustExist?: boolean } = {},
): Promise<ResolvedPath> {
  const parsed = parseVPath(username, input);

  // The share index is synthetic: there is nothing on disk to canonicalise.
  if (parsed.isShareIndex) return parsed;

  const realRoot = await fs.realpath(parsed.rootAbs).catch(() => null);
  if (realRoot === null) {
    // The private root is created lazily on first login. A missing *share*
    // root means the owner deleted the item from underneath the registry;
    // either way it is not the client's fault to fix.
    throw notFound(
      parsed.share ? 'That shared item is no longer available' : 'Storage root is not available',
    );
  }

  let existing = parsed.abs;
  const trailing: string[] = [];
  // Walk up until something exists. The loop terminates because rootAbs
  // exists, and abs is always a descendant of it.
  for (;;) {
    try {
      await fs.lstat(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing || existing === parsed.rootAbs) break;
      trailing.unshift(path.basename(existing));
      existing = parent;
    }
  }

  const realExisting = await fs.realpath(existing).catch(() => null);
  if (realExisting === null) throw notFound();

  if (realExisting !== realRoot && !realExisting.startsWith(realRoot + path.sep)) {
    throw forbidden('Path escapes the storage root', 'traversal');
  }

  if (opts.mustExist && trailing.length > 0) throw notFound();

  return { ...parsed, abs: path.join(realExisting, ...trailing) };
}

/**
 * Refuse a write the caller is not entitled to make. Read access to a shared
 * item never implies write access to it.
 */
export function assertWritable(resolved: ResolvedPath): void {
  if (resolved.writable) return;

  if (resolved.isShareIndex) {
    throw forbidden(
      'Shared is a view of published items, not a folder. Upload to My Files and share from there.',
      'shared_read_only',
    );
  }
  throw forbidden('This item was shared with you and is read-only', 'read_only_share');
}

/** The owner's own virtual path for something reached through a share. */
export function ownerVPath(resolved: ResolvedPath): string {
  if (resolved.root === 'me') return resolved.vpath;
  if (!resolved.share) return resolved.vpath;
  const rel = resolved.rel === '' ? resolved.share.rel : `${resolved.share.rel}/${resolved.rel}`;
  return `/me/${rel}`;
}

/** Path of the owner's item relative to their private root, "" for the root. */
export function ownerRelOf(resolved: ResolvedPath): string {
  if (resolved.root === 'me') return resolved.rel;
  if (!resolved.share) return '';
  return resolved.rel === '' ? resolved.share.rel : `${resolved.share.rel}/${resolved.rel}`;
}

/** Virtual path of the parent, or null when the argument is a root. */
export function parentVPath(vpath: string): string | null {
  const segments = vpath.split('/').filter(Boolean);
  if (segments.length <= 1) return null;
  return '/' + segments.slice(0, -1).join('/');
}

/** Join a virtual directory path with a single child name. */
export function joinVPath(dir: string, name: string): string {
  assertValidName(name);
  return dir.replace(/\/+$/, '') + '/' + name;
}
