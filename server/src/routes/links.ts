import fs from 'fs/promises';
import { Router } from 'express';
import { wrap } from '../lib/async';
import { badRequest } from '../lib/errors';
import { parseVPath } from '../lib/vpath';
import { ensureRoot, principal, requireAuth } from '../middleware/auth';
import * as links from '../services/links';
import * as storage from '../services/storage';

/** Managing public links: what you have published outside the server. */
export const linksRouter: Router = Router();
linksRouter.use(requireAuth);
linksRouter.use(ensureRoot);

async function summarise(record: links.LinkRecord) {
  const stats = await fs.stat(links.absOf(record)).catch(() => null);
  return {
    id: record.id,
    url: links.urlOf(record),
    path: `/me/${record.rel}`,
    name: record.rel.split('/').pop() ?? record.rel,
    isDir: stats?.isDirectory() ?? false,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

/** Your links, or — with ?path= — the link for one item, if it has one. */
linksRouter.get(
  '/',
  wrap(async (req, res) => {
    const user = principal(req);
    let records = await links.ownedBy(user.username);
    if (typeof req.query.path === 'string' && req.query.path) {
      const parsed = parseVPath(user.username, req.query.path);
      records = records.filter((record) => parsed.root === 'me' && record.rel === parsed.rel);
    }
    res.json({ links: await Promise.all(records.map(summarise)), enabled: links.enabled() });
  }),
);

/**
 * Create the link for one of your items, or change its expiry.
 * `expiresInDays` is a whole number of days, or null for no expiry.
 */
linksRouter.post(
  '/',
  wrap(async (req, res) => {
    const user = principal(req);
    const { path: vpath, expiresInDays } = req.body ?? {};
    if (typeof vpath !== 'string' || !vpath) throw badRequest('"path" is required', 'missing_parameter');

    const parsed = parseVPath(user.username, vpath);
    if (parsed.root !== 'me') throw badRequest('Only your own files can be published', 'not_owner');
    // Proves the item exists before a link is written for it.
    await storage.stat(user.username, parsed.vpath);

    let expiresAt: number | null = null;
    if (expiresInDays !== null && expiresInDays !== undefined) {
      if (typeof expiresInDays !== 'number' || !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650) {
        throw badRequest('"expiresInDays" must be a whole number of days, or null', 'invalid_expiry');
      }
      expiresAt = Date.now() + expiresInDays * 86_400_000;
    }

    const record = await links.upsert(user.username, parsed.rel, expiresAt);
    res.status(201).json({ link: await summarise(record) });
  }),
);

linksRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    await links.revoke(principal(req), String(req.params.id));
    res.status(204).end();
  }),
);
