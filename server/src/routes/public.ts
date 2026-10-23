import fs from 'fs/promises';
import path from 'path';
import { Router, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { wrap } from '../lib/async';
import { HttpError, notFound } from '../lib/errors';
import { previewKind, thumbnailable } from '../lib/mime';
import { assertValidName } from '../lib/vpath';
import { archiveNameFor, streamArchive, streamFile } from '../lib/streaming';
import { formatBytes } from '../services/storage';
import * as links from '../services/links';
import * as thumbs from '../services/thumbs';
import { renderLinkPage, renderMissingPage, type PageEntry } from './publicPage';

/**
 * Public links: /s/<token>, reachable by anyone with the URL.
 *
 * Everything here is confined to the one item the link publishes. A path
 * inside it is validated segment by segment and then canonicalised, and must
 * still be inside the item afterwards — so neither "..", nor a symlink, nor a
 * file hidden from the folder view, is reachable through a link.
 */
export const publicRouter: Router = Router();

// Generous enough for a page of thumbnails, tight enough to make guessing
// tokens pointless — not that 192 bits could be guessed anyway.
publicRouter.use(
  rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 1500,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  }),
);

publicRouter.use((_req, res, next) => {
  // The token is the credential and it is in the URL: never send it on.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

interface Located {
  record: links.LinkRecord;
  /** Path inside the link, "" for the linked item itself. */
  sub: string;
  abs: string;
  stats: import('fs').Stats;
  name: string;
}

async function locate(token: string, subRaw: unknown): Promise<Located> {
  const record = await links.byToken(token);
  if (!record) throw notFound('This link has expired or been removed', 'no_link');

  const segments = typeof subRaw === 'string' ? subRaw.split('/').filter(Boolean) : [];
  for (const segment of segments) {
    assertValidName(segment);
    if (segment.startsWith('.')) throw notFound();
  }

  const root = await fs.realpath(links.absOf(record)).catch(() => null);
  if (!root) throw notFound('This link has expired or been removed', 'no_link');
  const real = await fs.realpath(path.join(root, ...segments)).catch(() => null);
  if (!real || (real !== root && !real.startsWith(root + path.sep))) throw notFound();

  const stats = await fs.stat(real);
  if (!stats.isDirectory() && !stats.isFile()) throw notFound();
  const name = segments.length > 0 ? segments[segments.length - 1]! : path.basename(record.rel);
  return { record, sub: segments.join('/'), abs: real, stats, name };
}

/** HTML pages get an HTML answer to a missing link, not a JSON one. */
function failPage(res: Response, err: unknown): void {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error('[cloud] public link page failed:', err);
  res.status(status === 404 || status === 400 ? 404 : status).type('html').send(renderMissingPage());
}

//=================================================
// The page
//=================================================

publicRouter.get('/:token', async (req, res) => {
  try {
    const located = await locate(req.params.token, req.query.path);
    const { record, sub, abs, stats, name } = located;

    let entries: PageEntry[] = [];
    if (stats.isDirectory()) {
      const names = (await fs.readdir(abs)).filter((n) => !n.startsWith('.'));
      for (const child of names) {
        const childStats = await fs.stat(path.join(abs, child)).catch(() => null);
        if (!childStats || (!childStats.isDirectory() && !childStats.isFile())) continue;
        entries.push({
          name: child,
          sub: sub ? `${sub}/${child}` : child,
          isDir: childStats.isDirectory(),
          size: childStats.isDirectory() ? '' : formatBytes(childStats.size),
          modified: childStats.mtime,
          kind: childStats.isDirectory() ? 'folder' : (previewKind(child) ?? 'file'),
          thumbnail: !childStats.isDirectory() && config.previews.enabled && thumbnailable(child),
        });
      }
      entries = entries.sort((a, b) =>
        a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
    }

    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    res.type('html').send(
      renderLinkPage({
        token: record.token,
        title: path.basename(record.rel),
        sub,
        name,
        isDir: stats.isDirectory(),
        size: stats.isDirectory() ? '' : formatBytes(stats.size),
        kind: stats.isDirectory() ? 'folder' : (previewKind(name) ?? 'file'),
        thumbnail: !stats.isDirectory() && config.previews.enabled && thumbnailable(name),
        modified: stats.mtime,
        expiresAt: record.expiresAt,
        entries,
      }),
    );
  } catch (err) {
    failPage(res, err);
  }
});

//=================================================
// Bytes
//=================================================

publicRouter.get(
  '/:token/file',
  wrap(async (req, res) => {
    const { abs, stats, name } = await locate(req.params.token as string, req.query.path);
    if (stats.isDirectory()) throw notFound();
    streamFile(req, res, abs, name, stats.size, `${stats.ino}-${stats.size}-${stats.mtimeMs}`, false);
  }),
);

publicRouter.get(
  '/:token/zip',
  wrap(async (req, res) => {
    const { abs, stats, name } = await locate(req.params.token as string, req.query.path);
    await streamArchive(
      res,
      [{ name, abs, isDir: stats.isDirectory(), mtime: stats.mtimeMs }],
      archiveNameFor(name, stats.isDirectory()),
    );
  }),
);

publicRouter.get(
  '/:token/thumb',
  wrap(async (req, res) => {
    const { abs, stats, name } = await locate(req.params.token as string, req.query.path);
    if (stats.isDirectory()) throw notFound();
    thumbs.assertPreviewable(name);
    const size = thumbs.normaliseSize(req.query.size);
    const etag = `${stats.ino}-${stats.size}-${stats.mtimeMs}-${size}`;
    const file = await thumbs.thumbnailFor(abs, name, etag, size);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(file);
  }),
);
