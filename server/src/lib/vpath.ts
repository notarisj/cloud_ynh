import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { badRequest, forbidden, notFound } from './errors';

/**
 * Clients never see filesystem paths. They see *virtual* paths of the form
 *
 *     /me/Documents/report.pdf
 *     /shared/Team/logo.png
 *
 * where the first segment names a root. "me" is the caller's private
 * directory, "shared" is the common area. Keeping the caller's username out of
 * the path means a device that logs in as somebody else automatically sees the
 * right files without rewriting anything it has cached.
 */
export type RootId = 'me' | 'shared';

export const ROOTS: readonly RootId[] = ['me', 'shared'];

export interface ResolvedPath {
  /** Canonical virtual path, e.g. "/me/Documents/report.pdf". */
  vpath: string;
  root: RootId;
  /** Path relative to the root, "" for the root itself. */
  rel: string;
  /** Absolute path on disk. */
  abs: string;
  /** Absolute path of the root this resolved into. */
  rootAbs: string;
}

/** Absolute directory backing a root for a given user. */
export function rootDirFor(username: string, root: RootId): string {
  if (root === 'shared') {
    if (!config.storage.sharedEnabled) {
      throw forbidden('The shared area is disabled on this server', 'shared_disabled');
    }
    return config.storage.sharedDir;
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

  const restSegments = segments.slice(1);
  for (const segment of restSegments) assertValidName(segment);

  const rootAbs = rootDirFor(username, root);
  const rel = restSegments.join('/');

  return {
    vpath: '/' + [root, ...restSegments].join('/'),
    root,
    rel,
    abs: rel === '' ? rootAbs : path.join(rootAbs, rel),
    rootAbs,
  };
}

/**
 * Parse a virtual path *and* prove that the real path it lands on is inside
 * the root, following symlinks.
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

  const realRoot = await fs.realpath(parsed.rootAbs).catch(() => null);
  if (realRoot === null) {
    // The private root is created lazily on first login; the shared root is
    // created at install time. Either way a missing root is not the client's
    // fault to fix.
    throw notFound('Storage root is not available');
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
