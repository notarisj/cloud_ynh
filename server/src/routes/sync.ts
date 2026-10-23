import fs from 'fs/promises';
import path from 'path';
import { Router } from 'express';
import { wrap } from '../lib/async';
import { joinVPath, resolveVPath } from '../lib/vpath';
import { ensureRoot, principal, requireAuth } from '../middleware/auth';
import * as storage from '../services/storage';
import * as shares from '../services/shares';

/**
 * Change feed for the iOS File Provider extension.
 *
 * NSFileProviderReplicatedExtension asks "what changed since this anchor?"
 * every time the Files app comes forward. Answering that properly wants a
 * journal, which a plain directory tree does not have — so the anchor is a
 * timestamp and the answer is every entry whose mtime is newer.
 *
 * The consequence is that deletions are not reported: a file removed on the
 * server stays visible in Files until the user pulls to refresh, at which
 * point a full re-enumeration corrects it. That is a deliberate trade — the
 * alternative is a write-ahead log that has to stay consistent with whatever
 * else touches the data directory, including restored backups and rsync.
 */
export const syncRouter: Router = Router();
syncRouter.use(requireAuth);
syncRouter.use(ensureRoot);

const MAX_RESULTS = 500;
const MAX_WALK_MS = 8000;

interface Candidate {
  abs: string;
  vpath: string;
  mtime: number;
}

/**
 * Two ways to read the feed.
 *
 * By default it is a cursor: changes come oldest first, at most a page at a
 * time, and the anchor handed back is the modification time of the last one
 * returned — so the next call picks up exactly where this one stopped, and a
 * tree with more changes than fit in a page is still worked through rather
 * than re-walked forever. Entries that share the page's last timestamp are
 * all included, which is what guarantees the anchor moves.
 *
 * With `newest=1` it is a list of what changed most recently — what a
 * "Recents" screen wants — and the anchor is simply now.
 */
syncRouter.get(
  '/changes',
  wrap(async (req, res) => {
    const user = principal(req);

    const rootPath = typeof req.query.root === 'string' && req.query.root ? req.query.root : '/me';
    // Fractional on purpose: mtimes carry sub-millisecond precision, and an
    // anchor rounded down would hand the boundary entries back again.
    const sinceRaw = Number.parseFloat(String(req.query.since ?? '0'));
    const since = Number.isFinite(sinceRaw) ? sinceRaw : 0;
    const newest = req.query.newest === '1' || req.query.newest === 'true';
    const limitRaw = Number.parseInt(String(req.query.limit ?? MAX_RESULTS), 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : MAX_RESULTS, 1), MAX_RESULTS);

    const scope = await resolveVPath(user.username, rootPath, { mustExist: true });

    // "/shared" is an index rather than a directory, so the walk starts at
    // each published item instead of at a single tree.
    const targets = scope.isShareIndex
      ? shares.all().map((record) => ({
          abs: shares.absOf(record),
          vpath: `/shared/${record.slug}`,
          sharedAt: record.sharedAt,
        }))
      : [{ abs: scope.abs, vpath: scope.vpath, sharedAt: 0 }];

    const candidates: Candidate[] = [];
    const deadline = Date.now() + MAX_WALK_MS;
    let incomplete = false;

    async function consider(abs: string, vpath: string): Promise<boolean> {
      const stats = await fs.stat(abs).catch(() => null);
      if (!stats) return false;
      if (stats.mtimeMs > since) candidates.push({ abs, vpath, mtime: stats.mtimeMs });
      return stats.isDirectory();
    }

    async function walk(absDir: string, vDir: string, depth: number): Promise<void> {
      if (depth > 24) return;
      if (Date.now() > deadline) {
        incomplete = true;
        return;
      }

      const dirents = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
      for (const dirent of dirents) {
        if (dirent.name.startsWith('.')) continue;
        if (Date.now() > deadline) {
          incomplete = true;
          return;
        }
        const childV = joinVPath(vDir, dirent.name);
        const childAbs = path.join(absDir, dirent.name);
        // Only real directories are descended into, so a symlink cannot lead
        // the walk out of the tree. Its timestamp is still read, and
        // storage.stat re-checks the path before anything is reported.
        const isDir = await consider(childAbs, childV);
        if (isDir && dirent.isDirectory()) await walk(childAbs, childV, depth + 1);
      }
    }

    for (const target of targets) {
      // A shared item can be a single file; it is a change in its own right.
      if (scope.isShareIndex) {
        const before = candidates.length;
        const isDir = await consider(target.abs, target.vpath);
        // Publishing is a change to Shared even when the file itself is old.
        if (candidates.length === before && target.sharedAt > since) {
          candidates.push({ abs: target.abs, vpath: target.vpath, mtime: target.sharedAt });
        }
        if (isDir) await walk(target.abs, target.vpath, 0);
      } else {
        await walk(target.abs, target.vpath, 0);
      }
    }

    let chosen: Candidate[];
    let anchor: number;
    let truncated: boolean;

    if (newest) {
      candidates.sort((a, b) => b.mtime - a.mtime);
      chosen = candidates.slice(0, limit);
      truncated = incomplete || candidates.length > limit;
      anchor = Date.now();
    } else {
      candidates.sort((a, b) => a.mtime - b.mtime);
      chosen = candidates.slice(0, limit);
      const last = chosen[chosen.length - 1];
      if (last && candidates.length > limit) {
        // Take everything that shares the boundary timestamp, so the anchor
        // can be that timestamp without losing a sibling to a tie.
        chosen = candidates.filter((candidate) => candidate.mtime <= last.mtime);
        anchor = last.mtime;
        truncated = true;
      } else if (incomplete) {
        // The walk ran out of time somewhere unknown: report what was seen,
        // but do not move the anchor past anything that was not looked at.
        anchor = since;
        truncated = true;
      } else {
        anchor = Date.now();
        truncated = false;
      }
    }

    const changes: storage.FileEntry[] = [];
    for (const candidate of chosen) {
      const entry = await storage.stat(user.username, candidate.vpath).catch(() => null);
      if (entry) changes.push(entry);
    }

    res.json({ changes, anchor, truncated });
  }),
);
