import { Router } from 'express';
import busboy from 'busboy';
import { pipeline } from 'stream/promises';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { config } from '../config';
import { wrap } from '../lib/async';
import { badRequest, conflict, fromNodeError, tooLarge } from '../lib/errors';
import { assertWritable, joinVPath, resolveVPath } from '../lib/vpath';
import { ensureRoot, principal, requireAuth } from '../middleware/auth';
import * as storage from '../services/storage';
import * as uploads from '../services/uploads';
import type { ConflictPolicy } from '../services/storage';

export const uploadRouter: Router = Router();
uploadRouter.use(requireAuth);
uploadRouter.use(ensureRoot);

const POLICIES: ConflictPolicy[] = ['fail', 'replace', 'rename'];

function policyOf(value: unknown, fallback: ConflictPolicy = 'rename'): ConflictPolicy {
  return typeof value === 'string' && POLICIES.includes(value as ConflictPolicy)
    ? (value as ConflictPolicy)
    : fallback;
}

//=================================================
// Simple upload — multipart, one request
//=================================================
// For anything a phone can send in a few seconds. Larger files should use the
// chunked API below, which survives a dropped connection.

/** Above this, clients are told to use the resumable API instead. */
const SIMPLE_UPLOAD_LIMIT = 64 * 1024 * 1024;

uploadRouter.post(
  '/simple',
  wrap(async (req, res) => {
    const user = principal(req);

    const dir = typeof req.query.path === 'string' ? req.query.path : '/me';
    const policy = policyOf(req.query.conflict);

    const dirResolved = await resolveVPath(user.username, dir, { mustExist: true });
    // Uploads always land in files the caller owns; Shared is a view, not a
    // drop box, and someone else's shared folder is read-only.
    assertWritable(dirResolved);

    const dirStats = await fsp.stat(dirResolved.abs).catch((e) => {
      throw fromNodeError(e);
    });
    if (!dirStats.isDirectory()) throw badRequest('Upload target must be a folder', 'not_directory');

    const declared = Number.parseInt(String(req.headers['content-length'] ?? '0'), 10);
    if (Number.isFinite(declared) && declared > 0) {
      await storage.assertQuota(dirResolved.owner, declared);
    }

    const entry = await new Promise<storage.FileEntry>((resolve, reject) => {
      const parser = busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: Math.min(SIMPLE_UPLOAD_LIMIT, config.storage.maxUploadBytes) },
      });

      let handled = false;
      // Written to a temp file first so a truncated upload never appears in the
      // user's folder as a plausible-looking short file.
      const temp = path.join(os.tmpdir(), `cloud-up-${crypto.randomUUID()}`);

      parser.on('file', (_field, stream, info) => {
        handled = true;
        const filename = path.basename(info.filename || 'upload');

        void (async () => {
          try {
            await pipeline(stream, fs.createWriteStream(temp, { mode: 0o600 }));

            if (stream.truncated) {
              throw tooLarge(
                `Files above ${storage.formatBytes(SIMPLE_UPLOAD_LIMIT)} must use the resumable upload API.`,
                'use_chunked',
              );
            }

            const stats = await fsp.stat(temp);
            await storage.assertQuota(dirResolved.owner, stats.size);

            let finalName = filename;
            const target = path.join(dirResolved.abs, finalName);
            const exists = await fsp.lstat(target).then(() => true).catch(() => false);

            if (exists) {
              if (policy === 'fail') throw conflict('A file with that name already exists', 'exists');
              if (policy === 'rename') finalName = await storage.uniqueName(dirResolved.abs, finalName);
            }

            const destination = path.join(dirResolved.abs, finalName);
            await fsp.copyFile(temp, destination);
            await fsp.chmod(destination, 0o600).catch(() => undefined);

            storage.adjustUsage(dirResolved.owner, stats.size);
            resolve(await storage.stat(user.username, joinVPath(dirResolved.vpath, finalName)));
          } catch (err) {
            reject(err);
          } finally {
            await fsp.rm(temp, { force: true }).catch(() => undefined);
          }
        })();
      });

      parser.on('close', () => {
        if (!handled) reject(badRequest('No file was included in the request', 'no_file'));
      });
      parser.on('error', (err) => reject(fromNodeError(err)));

      req.pipe(parser);
    });

    res.status(201).json({ entry });
  }),
);

//=================================================
// Resumable upload
//=================================================

uploadRouter.post(
  '/',
  wrap(async (req, res) => {
    const user = principal(req);
    const { path: target, size, mtime, conflict: policy } = req.body ?? {};

    if (typeof target !== 'string') throw badRequest('"path" is required', 'missing_parameter');
    if (typeof size !== 'number') throw badRequest('"size" is required', 'missing_parameter');

    const session = await uploads.begin(user.username, {
      target,
      size,
      mtime: typeof mtime === 'number' ? mtime : undefined,
      conflict: policyOf(policy),
    });

    res.status(201).json({ upload: session });
  }),
);

uploadRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const user = principal(req);
    res.json({ upload: await uploads.status(user.username, String(req.params.id)) });
  }),
);

/**
 * Chunk bodies are raw bytes, not JSON or multipart — the request stream goes
 * straight to the right offset in the destination file with no buffering in
 * between, which is what lets the server accept a 4 GB upload in 256 MB of RAM.
 */
uploadRouter.put(
  '/:id/chunk/:index',
  wrap(async (req, res) => {
    const user = principal(req);
    const index = Number.parseInt(String(req.params.index), 10);

    const session = await uploads.writeChunk(user.username, String(req.params.id), index, req);
    res.json({ upload: session });
  }),
);

uploadRouter.post(
  '/:id/complete',
  wrap(async (req, res) => {
    const user = principal(req);
    res.status(201).json({ entry: await uploads.finish(user.username, String(req.params.id)) });
  }),
);

uploadRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    const user = principal(req);
    await uploads.discard(user.username, String(req.params.id));
    res.status(204).end();
  }),
);
