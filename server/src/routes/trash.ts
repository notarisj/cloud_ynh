import { Router } from 'express';
import { wrap } from '../lib/async';
import { badRequest } from '../lib/errors';
import { ensureRoot, principal, requireAuth } from '../middleware/auth';
import * as trash from '../services/trash';

export const trashRouter: Router = Router();
trashRouter.use(requireAuth);
trashRouter.use(ensureRoot);

trashRouter.get(
  '/',
  wrap(async (req, res) => {
    const user = principal(req);
    res.json({ items: await trash.list(user.username), retentionDays: trash.RETENTION_DAYS });
  }),
);

trashRouter.post(
  '/:id/restore',
  wrap(async (req, res) => {
    const user = principal(req);
    res.json({ entry: await trash.restore(user.username, String(req.params.id)) });
  }),
);

trashRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    const user = principal(req);
    const id = String(req.params.id);
    if (!id) throw badRequest('"id" is required', 'missing_parameter');
    await trash.purge(user.username, id);
    res.status(204).end();
  }),
);

trashRouter.delete(
  '/',
  wrap(async (req, res) => {
    const user = principal(req);
    res.json({ removed: await trash.empty(user.username) });
  }),
);
