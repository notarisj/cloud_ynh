import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Transform, type Readable } from 'stream';
import { config } from '../config';
import { badRequest, conflict, forbidden, fromNodeError, notFound, tooLarge } from '../lib/errors';
import { parentVPath, resolveVPath } from '../lib/vpath';
import * as storage from './storage';
import type { ConflictPolicy, FileEntry } from './storage';

/**
 * Resumable uploads.
 *
 * A session allocates one sparse file the size of the finished upload and
 * writes each chunk straight to its final offset. That means chunks can arrive
 * out of order or in parallel, a resumed upload only has to send the indices
 * the server is missing, and completing an upload is a rename rather than a
 * second pass over the bytes.
 */

export const CHUNK_SIZE = 8 * 1024 * 1024;

interface UploadMeta {
  id: string;
  username: string;
  /** Virtual path of the destination file. */
  target: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  received: number[];
  conflict: ConflictPolicy;
  /** Original modification time, preserved so a re-upload is not "newer". */
  mtime: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface UploadSession {
  id: string;
  target: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  received: number[];
  missing: number[];
  complete: boolean;
}

/** Abandoned sessions are swept after this long. */
const SESSION_TTL_MS = 24 * 3600 * 1000;

const sessionDir = (id: string) => path.join(config.storage.uploadsDir, id);
const metaFile = (id: string) => path.join(sessionDir(id), 'meta.json');
const dataFile = (id: string) => path.join(sessionDir(id), 'data');

const queues = new Map<string, Promise<unknown>>();

function serialise<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(id) ?? Promise.resolve();
  const next = previous.then(work, work);
  queues.set(id, next.catch(() => undefined));
  return next;
}

function toSession(meta: UploadMeta): UploadSession {
  const received = [...meta.received].sort((a, b) => a - b);
  const have = new Set(received);
  const missing: number[] = [];
  for (let i = 0; i < meta.chunkCount; i += 1) if (!have.has(i)) missing.push(i);

  return {
    id: meta.id,
    target: meta.target,
    size: meta.size,
    chunkSize: meta.chunkSize,
    chunkCount: meta.chunkCount,
    received,
    missing,
    complete: missing.length === 0,
  };
}

async function readMeta(id: string, username: string): Promise<UploadMeta> {
  // The id is a UUID we generated, but it arrives back in a URL path.
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw badRequest('Invalid upload id', 'invalid_upload');

  let meta: UploadMeta;
  try {
    meta = JSON.parse(await fs.readFile(metaFile(id), 'utf8')) as UploadMeta;
  } catch {
    throw notFound('That upload session has expired or does not exist');
  }
  // Session ids are unguessable, but ownership is still checked: an id that
  // leaked through a log or a shared screenshot should not be usable.
  if (meta.username !== username) throw forbidden('That upload belongs to another account');
  return meta;
}

async function writeMeta(meta: UploadMeta): Promise<void> {
  const target = metaFile(meta.id);
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ ...meta, updatedAt: Date.now() }), { mode: 0o600 });
  await fs.rename(temp, target);
}

//=================================================
// Lifecycle
//=================================================

export async function begin(
  username: string,
  options: { target: string; size: number; mtime?: number; conflict?: ConflictPolicy },
): Promise<UploadSession> {
  const { target, size } = options;

  if (!Number.isFinite(size) || size < 0) throw badRequest('Invalid size', 'invalid_size');
  if (size > config.storage.maxUploadBytes) {
    throw tooLarge(
      `That file is larger than the ${storage.formatBytes(config.storage.maxUploadBytes)} limit for a single upload.`,
    );
  }

  const resolved = await resolveVPath(username, target);
  if (resolved.rel === '') throw badRequest('Upload target must be a file', 'invalid_path');

  // Fail before transferring gigabytes rather than after.
  await storage.assertQuota(username, resolved.root, size);

  const parent = parentVPath(resolved.vpath);
  if (parent === null) throw badRequest('Upload target must be inside a folder', 'invalid_path');
  const parentResolved = await resolveVPath(username, parent, { mustExist: true });
  const parentStats = await fs.stat(parentResolved.abs).catch((e) => {
    throw fromNodeError(e);
  });
  if (!parentStats.isDirectory()) throw badRequest('Upload target must be inside a folder', 'not_directory');

  const policy = options.conflict ?? 'rename';
  if (policy === 'fail') {
    const exists = await fs.lstat(resolved.abs).then(() => true).catch(() => false);
    if (exists) throw conflict('A file with that name already exists', 'exists');
  }

  const id = crypto.randomUUID();
  const chunkCount = size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE);

  await fs.mkdir(sessionDir(id), { recursive: true, mode: 0o700 });
  // Preallocate so the final size is reserved up front and every chunk can be
  // written at its own offset without coordinating with the others.
  const handle = await fs.open(dataFile(id), 'w', 0o600);
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }

  const meta: UploadMeta = {
    id,
    username,
    target: resolved.vpath,
    size,
    chunkSize: CHUNK_SIZE,
    chunkCount,
    received: [],
    conflict: policy,
    mtime: options.mtime ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await writeMeta(meta);

  return toSession(meta);
}

export async function status(username: string, id: string): Promise<UploadSession> {
  return toSession(await readMeta(id, username));
}

export async function writeChunk(
  username: string,
  id: string,
  index: number,
  body: Readable,
): Promise<UploadSession> {
  const meta = await readMeta(id, username);

  if (!Number.isInteger(index) || index < 0 || index >= meta.chunkCount) {
    throw badRequest(`Chunk index must be between 0 and ${meta.chunkCount - 1}`, 'invalid_chunk');
  }

  const offset = index * meta.chunkSize;
  const expected = Math.min(meta.chunkSize, meta.size - offset);

  // A chunk longer than its slot would spill into the next chunk's bytes, so
  // the stream is cut off at the declared length rather than trusted.
  let written = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      written += chunk.length;
      if (written > expected) {
        done(tooLarge(`Chunk ${index} is larger than the declared ${expected} bytes`, 'chunk_too_large'));
        return;
      }
      done(null, chunk);
    },
  });

  const sink = fsSync.createWriteStream(dataFile(id), { flags: 'r+', start: offset });

  try {
    await pipeline(body, limiter, sink);
  } catch (err) {
    throw err instanceof Error && 'status' in err ? err : fromNodeError(err);
  }

  if (written !== expected) {
    throw badRequest(
      `Chunk ${index} was ${written} bytes, expected ${expected}`,
      'chunk_size_mismatch',
    );
  }

  return serialise(id, async () => {
    const current = await readMeta(id, username);
    if (!current.received.includes(index)) current.received.push(index);
    await writeMeta(current);
    return toSession(current);
  });
}

export async function finish(username: string, id: string): Promise<FileEntry> {
  const meta = await readMeta(id, username);
  const session = toSession(meta);

  if (!session.complete) {
    throw badRequest(
      `Upload is incomplete — still missing ${session.missing.length} chunk(s)`,
      'incomplete',
    );
  }

  const actual = await fs.stat(dataFile(id)).catch((e) => {
    throw fromNodeError(e);
  });
  if (actual.size !== meta.size) {
    await discard(username, id).catch(() => undefined);
    throw badRequest('Assembled file size does not match the declared size', 'size_mismatch');
  }

  const resolved = await resolveVPath(username, meta.target);
  const parent = parentVPath(resolved.vpath);
  if (parent === null) throw badRequest('Invalid upload target', 'invalid_path');
  const parentResolved = await resolveVPath(username, parent, { mustExist: true });

  let finalName = path.basename(resolved.abs);
  const exists = await fs.lstat(resolved.abs).then(() => true).catch(() => false);

  if (exists) {
    if (meta.conflict === 'fail') throw conflict('A file with that name already exists', 'exists');
    if (meta.conflict === 'rename') finalName = await storage.uniqueName(parentResolved.abs, finalName);
    // 'replace' falls through: the rename below overwrites in place.
  }

  const destination = path.join(parentResolved.abs, finalName);

  try {
    await fs.rename(dataFile(id), destination);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await fs.copyFile(dataFile(id), destination);
      await fs.rm(dataFile(id), { force: true });
    } else {
      throw fromNodeError(err);
    }
  }

  await fs.chmod(destination, 0o600).catch(() => undefined);
  if (meta.mtime && Number.isFinite(meta.mtime)) {
    const when = new Date(meta.mtime);
    await fs.utimes(destination, when, when).catch(() => undefined);
  }

  await fs.rm(sessionDir(id), { recursive: true, force: true }).catch(() => undefined);
  queues.delete(id);

  storage.adjustUsage(username, meta.size);
  return storage.stat(username, `${parent}/${finalName}`);
}

export async function discard(username: string, id: string): Promise<void> {
  await readMeta(id, username);
  await fs.rm(sessionDir(id), { recursive: true, force: true }).catch(() => undefined);
  queues.delete(id);
}

/** Sweep sessions nobody came back for. Runs at startup and hourly. */
export async function purgeStale(): Promise<void> {
  const cutoff = Date.now() - SESSION_TTL_MS;
  const ids = await fs.readdir(config.storage.uploadsDir).catch(() => [] as string[]);

  for (const id of ids) {
    const stats = await fs.stat(path.join(config.storage.uploadsDir, id)).catch(() => null);
    if (!stats) continue;
    if (stats.mtimeMs < cutoff) {
      await fs.rm(path.join(config.storage.uploadsDir, id), { recursive: true, force: true })
        .catch(() => undefined);
    }
  }
}
