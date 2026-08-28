import { Router } from 'express';
import { wrap } from '../lib/async';
import { badRequest, forbidden } from '../lib/errors';
import { parentVPath, parseVPath } from '../lib/vpath';
import { ensureRoot, principal, requireAuth } from '../middleware/auth';
import * as storage from '../services/storage';
import * as shares from '../services/shares';
import * as trash from '../services/trash';
import { signTicket, TICKET_TTL_SECONDS } from '../services/tokens';
import type { ConflictPolicy, SortKey } from '../services/storage';

export const filesRouter: Router = Router();
filesRouter.use(requireAuth);
filesRouter.use(ensureRoot);

const SORT_KEYS: SortKey[] = ['name', 'size', 'mtime', 'kind'];
const POLICIES: ConflictPolicy[] = ['fail', 'replace', 'rename'];

function stringParam(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest(`"${name}" is required`, 'missing_parameter');
  }
  return value;
}

function policyParam(value: unknown, fallback: ConflictPolicy): ConflictPolicy {
  if (typeof value !== 'string') return fallback;
  return POLICIES.includes(value as ConflictPolicy) ? (value as ConflictPolicy) : fallback;
}

//=================================================
// Listing and metadata
//=================================================

filesRouter.get(
  '/',
  wrap(async (req, res) => {
    const user = principal(req);
    const vpath = typeof req.query.path === 'string' && req.query.path ? req.query.path : '/me';

    const sortRaw = req.query.sort;
    const sort = SORT_KEYS.includes(sortRaw as SortKey) ? (sortRaw as SortKey) : 'name';

    const { entry, entries, writable } = await storage.list(user.username, vpath, {
      sort,
      descending: req.query.desc === '1' || req.query.desc === 'true',
      showHidden: req.query.hidden === '1' || req.query.hidden === 'true',
    });

    res.json({
      entry,
      entries,
      // Clients use this to decide whether to offer New Folder, Upload and
      // drag-and-drop at all, rather than letting the user try and be refused.
      writable,
      parent: parentVPath(entry.path),
      // Bundled so that opening a folder is one round trip, not one plus one
      // per thumbnail the client is about to request.
      ticket: { token: signTicket(user.username, entry.path), expiresIn: TICKET_TTL_SECONDS },
    });
  }),
);

filesRouter.get(
  '/stat',
  wrap(async (req, res) => {
    const user = principal(req);
    res.json({ entry: await storage.stat(user.username, stringParam(req.query.path, 'path')) });
  }),
);

filesRouter.get(
  '/search',
  wrap(async (req, res) => {
    const user = principal(req);
    const query = stringParam(req.query.q, 'q');
    const limit = Number.parseInt(String(req.query.limit ?? '100'), 10);

    const results = await storage.search(user.username, query, {
      limit: Number.isFinite(limit) ? limit : 100,
      scope: typeof req.query.path === 'string' && req.query.path ? req.query.path : undefined,
    });

    res.json({
      results,
      // Search spans roots, so the ticket has to as well.
      ticket: { token: signTicket(user.username, '/'), expiresIn: TICKET_TTL_SECONDS },
    });
  }),
);

/**
 * Mint a read ticket for a subtree. The SPA and the iOS app use it to build
 * <img> and QuickLook URLs that carry no access token.
 */
filesRouter.post(
  '/ticket',
  wrap(async (req, res) => {
    const user = principal(req);
    const scope = typeof req.body?.path === 'string' && req.body.path ? req.body.path : '/';
    // Resolving proves the caller can reach it before a ticket is written for it.
    if (scope !== '/') await storage.stat(user.username, scope);

    res.json({ token: signTicket(user.username, scope), expiresIn: TICKET_TTL_SECONDS });
  }),
);

//=================================================
// Sharing
//=================================================
// Sharing never moves a file. It records that an item of yours should also be
// reachable through "/shared", where everyone with access to this app can read
// it. Your copy stays exactly where it was, and it is still the only copy.

filesRouter.get(
  '/shares',
  wrap(async (req, res) => {
    const user = principal(req);
    res.json({
      shares: shares
        .all()
        .filter((record) => record.owner === user.username)
        .map((record) => ({
          id: record.id,
          path: `/me/${record.rel}`,
          sharedAs: `/shared/${record.slug}`,
          name: record.slug,
          sharedAt: record.sharedAt,
          visibility: record.visibility || 'all',
          sharedWith: record.sharedWith || [],
        })),
      enabled: shares.enabled(),
    });
  }),
);

filesRouter.post(
  '/share',
  wrap(async (req, res) => {
    const user = principal(req);
    const vpath = stringParam(req.body?.path, 'path');

    const parsed = parseVPath(user.username, vpath);
    if (parsed.root !== 'me') {
      throw badRequest('Only your own files can be shared', 'not_owner');
    }
    if (parsed.rel === '') throw badRequest('Cannot share the whole of My Files', 'invalid_path');

    const visibility = req.body?.visibility === 'users' ? 'users' : 'all';
    const sharedWith = Array.isArray(req.body?.sharedWith) ? req.body.sharedWith : [];

    // Prove it exists and is readable before writing a record for it.
    const entry = await storage.stat(user.username, parsed.vpath);
    const record = await shares.share(user.username, parsed.rel, entry.name, visibility, sharedWith);

    res.status(201).json({
      share: {
        id: record.id,
        path: `/me/${record.rel}`,
        sharedAs: `/shared/${record.slug}`,
        name: record.slug,
        sharedAt: record.sharedAt,
        visibility: record.visibility || 'all',
        sharedWith: record.sharedWith || [],
      },
      entry: await storage.stat(user.username, parsed.vpath),
    });
  }),
);

filesRouter.delete(
  '/share',
  wrap(async (req, res) => {
    const user = principal(req);
    const id = req.query.id ?? req.body?.id;
    const rawPath = req.query.path ?? req.body?.path;

    if (typeof id === 'string' && id.length > 0) {
      await shares.unshare(user, { id });
      res.status(204).end();
      return;
    }

    const parsed = parseVPath(user.username, stringParam(rawPath, 'path'));
    if (parsed.root === 'shared') {
      // Unsharing by the path it is published under: only the owner may.
      if (!parsed.share) throw badRequest('That path is not a shared item', 'not_shared');
      if (parsed.rel !== '') {
        throw badRequest('Only the top of a shared item can be unshared', 'not_shared');
      }
      if (parsed.share.owner !== user.username && !user.isAdmin) {
        throw forbidden('Only the owner can stop sharing an item', 'not_owner');
      }
      await shares.unshare(user, { id: parsed.share.id });
      res.status(204).end();
      return;
    }

    await shares.unshare(user, { owner: user.username, rel: parsed.rel });
    res.status(204).end();
  }),
);

//=================================================
// Mutations
//=================================================

filesRouter.post(
  '/folder',
  wrap(async (req, res) => {
    const user = principal(req);
    const entry = await storage.createFolder(user.username, stringParam(req.body?.path, 'path'));
    res.status(201).json({ entry });
  }),
);

filesRouter.post(
  '/move',
  wrap(async (req, res) => {
    const user = principal(req);
    const entry = await storage.move(
      user.username,
      stringParam(req.body?.from, 'from'),
      stringParam(req.body?.to, 'to'),
      policyParam(req.body?.conflict, 'fail'),
    );
    res.json({ entry });
  }),
);

filesRouter.post(
  '/copy',
  wrap(async (req, res) => {
    const user = principal(req);
    const entry = await storage.copy(
      user.username,
      stringParam(req.body?.from, 'from'),
      stringParam(req.body?.to, 'to'),
      policyParam(req.body?.conflict, 'rename'),
    );
    res.json({ entry });
  }),
);

filesRouter.post(
  '/rename',
  wrap(async (req, res) => {
    const user = principal(req);
    const entry = await storage.rename(
      user.username,
      stringParam(req.body?.path, 'path'),
      stringParam(req.body?.name, 'name'),
      policyParam(req.body?.conflict, 'fail'),
    );
    res.json({ entry });
  }),
);

/**
 * Deleting moves to the trash by default. `permanent=1` skips it — used by the
 * clients only after an explicit confirmation, and by the trash view itself.
 */
filesRouter.delete(
  '/',
  wrap(async (req, res) => {
    const user = principal(req);
    const vpath = stringParam(req.query.path ?? req.body?.path, 'path');
    const permanent = req.query.permanent === '1' || req.body?.permanent === true;

    if (permanent) {
      await storage.hardDelete(user.username, vpath);
      res.status(204).end();
      return;
    }

    res.json({ trashed: await trash.moveToTrash(user.username, vpath) });
  }),
);
