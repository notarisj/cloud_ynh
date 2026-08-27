import fs from 'fs/promises';
import path from 'path';
import { Router } from 'express';
import { wrap } from '../lib/async';
import { joinVPath, resolveVPath } from '../lib/vpath';
import { ensureRoot, principal, requireAuth } from '../middleware/auth';
import * as storage from '../services/storage';

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

syncRouter.get(
  '/changes',
  wrap(async (req, res) => {
    const user = principal(req);

    const rootPath = typeof req.query.root === 'string' && req.query.root ? req.query.root : '/me';
    const sinceRaw = Number.parseInt(String(req.query.since ?? '0'), 10);
    const since = Number.isFinite(sinceRaw) ? sinceRaw : 0;

    const scope = await resolveVPath(user.username, rootPath, { mustExist: true });

    const changes: storage.FileEntry[] = [];
    const deadline = Date.now() + MAX_WALK_MS;
    let truncated = false;

    async function walk(absDir: string, vDir: string, depth: number): Promise<void> {
      if (depth > 24 || Date.now() > deadline) {
        truncated = true;
        return;
      }
      if (changes.length >= MAX_RESULTS) {
        truncated = true;
        return;
      }

      const dirents = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
      for (const dirent of dirents) {
        if (dirent.name.startsWith('.')) continue;
        if (changes.length >= MAX_RESULTS) {
          truncated = true;
          return;
        }

        const childV = joinVPath(vDir, dirent.name);
        const childAbs = path.join(absDir, dirent.name);
        const stats = await fs.stat(childAbs).catch(() => null);
        if (!stats) continue;

        if (stats.mtimeMs > since) {
          const entry = await storage.stat(user.username, childV).catch(() => null);
          if (entry) changes.push(entry);
        }

        if (dirent.isDirectory()) await walk(childAbs, childV, depth + 1);
      }
    }

    await walk(scope.abs, scope.vpath, 0);

    res.json({
      changes,
      // The client stores this and sends it back next time. When the walk was
      // cut short the anchor does not advance, so nothing is missed — the next
      // call simply repeats the work.
      anchor: truncated ? since : Date.now(),
      truncated,
    });
  }),
);
