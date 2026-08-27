import fs from 'fs';
import { Router, type RequestHandler } from 'express';
import { wrap } from '../lib/async';
import { badRequest, unauthorized } from '../lib/errors';
import { contentDisposition, mimeFor, previewKind } from '../lib/mime';
import { ensureRoot, principal } from '../middleware/auth';
import * as storage from '../services/storage';
import * as thumbs from '../services/thumbs';
import { ticketCovers, verifyAccessToken, verifyTicket } from '../services/tokens';
import { config } from '../config';
import { parseVPath } from '../lib/vpath';

export const mediaRouter: Router = Router();

/**
 * Byte-serving routes accept either a Bearer token or a `t=` ticket.
 *
 * The ticket exists because an <img src>, an <a download> and a QuickLook
 * preview all fetch a URL without any way to attach a header. It is read-only
 * and scoped to a subtree, so the worst a leaked URL can do is expose the
 * folder it was minted for, for fifteen minutes.
 */
const authOrTicket: RequestHandler = (req, _res, next) => {
  if (!config.isProd) {
    req.user = {
      username: config.auth.devUser,
      displayName: config.auth.devUser,
      isAdmin: true,
      sid: 'dev-session',
    };
    next();
    return;
  }

  const header = req.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    try {
      req.user = verifyAccessToken(header.slice(7).trim());
      next();
    } catch (err) {
      next(err);
    }
    return;
  }

  const ticket = req.query.t;
  if (typeof ticket !== 'string' || ticket.length === 0) {
    next(unauthorized('No access token supplied', 'no_token'));
    return;
  }

  try {
    const claims = verifyTicket(ticket);
    const requested = typeof req.query.path === 'string' ? req.query.path : '';
    // parseVPath normalises before the prefix check, so "/me/a/../../b" cannot
    // masquerade as a path inside the ticket's scope.
    const normalised = parseVPath(claims.username, requested).vpath;
    if (!ticketCovers(claims, normalised)) {
      next(unauthorized('This link does not cover that file', 'ticket_scope'));
      return;
    }
    req.user = {
      username: claims.username,
      displayName: claims.username,
      isAdmin: false,
      sid: 'ticket',
    };
    next();
  } catch (err) {
    next(err);
  }
};

function pathParam(req: Parameters<RequestHandler>[0]): string {
  const value = req.query.path;
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest('"path" is required', 'missing_parameter');
  }
  return value;
}

//=================================================
// Download and inline preview
//=================================================

/**
 * Streams a file with Range support, which is what makes video scrubbing and
 * resumed downloads work — including URLSession's own resume logic on iOS.
 */
function streamFile(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  absPath: string,
  name: string,
  size: number,
  etag: string,
  inline: boolean,
): void {
  const mime = inline ? mimeFor(name) : 'application/octet-stream';

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', contentDisposition(name, inline));
  res.setHeader('ETag', `"${etag}"`);
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  // Files are user content; never let a browser sniff one into a script.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.headers['if-none-match'] === `"${etag}"`) {
    res.status(304).end();
    return;
  }

  const range = req.headers.range;
  if (typeof range === 'string' && range.startsWith('bytes=')) {
    const [startRaw, endRaw] = range.slice(6).split('-');
    let start = Number.parseInt(startRaw ?? '', 10);
    let end = Number.parseInt(endRaw ?? '', 10);

    // "bytes=-500" means the last 500 bytes.
    if (Number.isNaN(start) && !Number.isNaN(end)) {
      start = Math.max(0, size - end);
      end = size - 1;
    }
    if (Number.isNaN(end)) end = size - 1;

    if (Number.isNaN(start) || start >= size || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }

    end = Math.min(end, size - 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));

    const stream = fs.createReadStream(absPath, { start, end });
    stream.on('error', () => res.destroy());
    // Stop reading if the client hangs up mid-scrub.
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return;
  }

  res.setHeader('Content-Length', String(size));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(absPath);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

mediaRouter.get(
  '/download',
  authOrTicket,
  ensureRoot,
  wrap(async (req, res) => {
    const user = principal(req);
    const { resolved, stats, name } = await storage.resolveFile(user.username, pathParam(req));
    streamFile(req, res, resolved.abs, name, stats.size, `${stats.ino}-${stats.size}-${stats.mtimeMs}`, false);
  }),
);

mediaRouter.get(
  '/preview',
  authOrTicket,
  ensureRoot,
  wrap(async (req, res) => {
    const user = principal(req);
    const { resolved, stats, name } = await storage.resolveFile(user.username, pathParam(req));

    // Only formats a browser renders safely are served inline. Anything else
    // would be an invitation to host HTML on the same origin as the app.
    const kind = previewKind(name);
    const inlineSafe = kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf';
    if (!inlineSafe) {
      throw badRequest('That file type cannot be previewed inline', 'no_preview');
    }

    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    streamFile(req, res, resolved.abs, name, stats.size, `${stats.ino}-${stats.size}-${stats.mtimeMs}`, true);
  }),
);

//=================================================
// Thumbnails
//=================================================

mediaRouter.get(
  '/thumb',
  authOrTicket,
  ensureRoot,
  wrap(async (req, res) => {
    const user = principal(req);
    const { resolved, stats, name } = await storage.resolveFile(user.username, pathParam(req));

    thumbs.assertPreviewable(name);

    const size = thumbs.normaliseSize(req.query.size);
    const etag = `${stats.ino}-${stats.size}-${stats.mtimeMs}-${size}`;

    if (req.headers['if-none-match'] === `"${etag}"`) {
      res.status(304).end();
      return;
    }

    const cached = await thumbs.thumbnailFor(resolved.abs, name, etag, size);
    const thumbStats = await fs.promises.stat(cached);

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', String(thumbStats.size));
    res.setHeader('ETag', `"${etag}"`);
    // A thumbnail is immutable for a given etag, so let the client keep it.
    res.setHeader('Cache-Control', 'private, max-age=86400');

    const stream = fs.createReadStream(cached);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }),
);
