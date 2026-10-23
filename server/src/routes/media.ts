import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { Router, type RequestHandler } from 'express';
import { wrap } from '../lib/async';
import { badRequest, unauthorized } from '../lib/errors';
import { contentDisposition, mimeFor, previewKind } from '../lib/mime';
import { ensureRoot, principal } from '../middleware/auth';
import * as storage from '../services/storage';
import * as thumbs from '../services/thumbs';
import { assertSessionActive, ticketCovers, verifyAccessToken, verifyTicket } from '../services/tokens';
import { config } from '../config';
import { parseVPath, resolveVPath } from '../lib/vpath';

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
      isAdmin: config.auth.devAdmin,
      sid: 'dev-session',
    };
    next();
    return;
  }

  const header = req.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    try {
      const claims = verifyAccessToken(header.slice(7).trim());
      assertSessionActive(claims.username, claims.sid).then(() => {
        req.user = claims;
        next();
      }, next);
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
    const requested = pathParams(req);
    if (requested.length === 0) throw badRequest('"path" is required', 'missing_parameter');
    // parseVPath normalises before the prefix check, so "/me/a/../../b" cannot
    // masquerade as a path inside the ticket's scope. An archive of several
    // items needs every one of them covered.
    for (const each of requested) {
      if (!ticketCovers(claims, parseVPath(claims.username, each).vpath)) {
        next(unauthorized('This link does not cover that file', 'ticket_scope'));
        return;
      }
    }
    const user = {
      username: claims.username,
      displayName: claims.username,
      isAdmin: false,
      sid: 'ticket',
    };
    // A ticket minted for a session lives no longer than that session.
    // Tickets from before tickets carried a session are honoured until they
    // expire on their own, which is at most fifteen minutes.
    const check = claims.sid ? assertSessionActive(claims.username, claims.sid) : Promise.resolve();
    check.then(() => {
      req.user = user;
      next();
    }, next);
  } catch (err) {
    next(err);
  }
};

/** Every `path` in the query — an archive may name several. */
function pathParams(req: Parameters<RequestHandler>[0]): string[] {
  const value = req.query.path;
  const list = Array.isArray(value) ? value : [value];
  return list.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

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

    // Everything is locked down; images, video and audio are sandboxed too.
    // A PDF cannot be: browsers refuse to run their PDF viewer inside a
    // sandboxed document and show a "blocked" page instead. It is still safe
    // to serve unsandboxed — the type is fixed to application/pdf and nosniff
    // stops a browser from reading the bytes as anything else.
    res.setHeader(
      'Content-Security-Policy',
      kind === 'pdf'
        ? "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; frame-ancestors 'self'"
        : "default-src 'none'; sandbox",
    );
    streamFile(req, res, resolved.abs, name, stats.size, `${stats.ino}-${stats.size}-${stats.mtimeMs}`, true);
  }),
);

//=================================================
// Archives
//=================================================
// Folders, and selections of several items, download as one ZIP. It is
// streamed as it is built — nothing is staged on disk — and stored rather
// than compressed: photos and video, which are most of what lives here, do
// not shrink, and storing keeps a large archive from pinning a CPU.

mediaRouter.get(
  '/archive',
  authOrTicket,
  ensureRoot,
  wrap(async (req, res) => {
    const user = principal(req);
    const requested = pathParams(req);
    if (requested.length === 0) throw badRequest('"path" is required', 'missing_parameter');
    if (requested.length > 1000) throw badRequest('Too many items for one archive', 'too_many');

    // Everything is resolved before the first byte goes out: once the
    // response has started, an error can only cut it short.
    const items = [];
    for (const vpath of requested) {
      const resolved = await storage.stat(user.username, vpath);
      const abs = (await resolveVPath(user.username, resolved.path, { mustExist: true })).abs;
      if (!abs) throw badRequest('Shared is not a folder that can be downloaded', 'share_index');
      items.push({ entry: resolved, abs });
    }

    const only = items.length === 1 ? items[0] : undefined;
    const requestedName = typeof req.query.name === 'string' ? req.query.name : '';
    // A file's extension gives way to ".zip"; a folder's name is kept whole.
    const base = only
      ? only.entry.isDir ? only.entry.name : only.entry.name.replace(/\.[^.]+$/, '')
      : requestedName || 'Download';
    const archiveName = `${base.replace(/[/\\\0]/g, '_').slice(0, 120) || 'Download'}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(archiveName, false));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const archive = archiver('zip', { store: true });
    archive.on('warning', (err) => console.warn('[cloud] archive warning:', err.message));
    archive.on('error', () => res.destroy());
    // A download cancelled half-way stops the walk instead of finishing it
    // for nobody.
    res.on('close', () => {
      if (!res.writableFinished) archive.abort();
    });
    archive.pipe(res);

    const used = new Set<string>();
    for (const { entry, abs } of items) {
      // Two selected items can share a name when they come from different
      // folders; the second becomes "name 2", as anywhere else.
      let top = entry.name;
      for (let n = 2; used.has(top); n += 1) top = `${path.parse(entry.name).name} ${n}${path.parse(entry.name).ext}`;
      used.add(top);

      if (!entry.isDir) {
        archive.file(abs, { name: top, date: new Date(entry.mtime) });
        continue;
      }
      archive.append('', { name: `${top}/` });
      for await (const item of storage.filesBeneath(abs, top)) {
        if (item.isDir) archive.append('', { name: `${item.name}/` });
        else archive.file(item.abs, { name: item.name });
      }
    }

    await archive.finalize();
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
