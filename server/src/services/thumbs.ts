import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import sharp from 'sharp';
import { config } from '../config';
import { badRequest, notFound } from '../lib/errors';
import { previewKind } from '../lib/mime';

const run = promisify(execFile);

/** Sizes the API will produce. A closed set keeps the cache bounded. */
export const THUMB_SIZES = [128, 256, 512, 1024] as const;
export type ThumbSize = (typeof THUMB_SIZES)[number];

export function normaliseSize(requested: unknown): ThumbSize {
  const n = typeof requested === 'string' ? Number.parseInt(requested, 10) : Number(requested);
  const match = THUMB_SIZES.find((s) => s >= n);
  return match ?? 512;
}

/** Refuse to decode images large enough to be a memory-exhaustion attempt. */
const MAX_SOURCE_BYTES = 200 * 1024 * 1024;

//=================================================
// External tool detection
//=================================================
// ffmpeg and pdftoppm are declared as apt dependencies, but the app must still
// work if a minimal host is missing one — the file simply has no thumbnail.

let toolCache: { ffmpeg: boolean; pdftoppm: boolean } | null = null;

async function hasTool(name: string): Promise<boolean> {
  try {
    await run('which', [name], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function tools(): Promise<{ ffmpeg: boolean; pdftoppm: boolean }> {
  if (!toolCache) {
    toolCache = { ffmpeg: await hasTool('ffmpeg'), pdftoppm: await hasTool('pdftoppm') };
    console.log(
      `[cloud] preview tools — ffmpeg: ${toolCache.ffmpeg ? 'yes' : 'no'}, ` +
        `pdftoppm: ${toolCache.pdftoppm ? 'yes' : 'no'}`,
    );
  }
  return toolCache;
}

//=================================================
// Cache
//=================================================

function cacheKey(absPath: string, etag: string, size: ThumbSize): string {
  return crypto.createHash('sha1').update(`${absPath}|${etag}|${size}`).digest('hex');
}

const cachePath = (key: string) => path.join(config.storage.thumbsDir, `${key}.jpg`);

/**
 * Produce a JPEG thumbnail, reusing the cached copy when the source has not
 * changed. Returns the path of the cached file so the route can stream it.
 *
 * Throws 404 for formats with no thumbnail rather than inventing a placeholder:
 * the client already knows the file kind and draws its own icon.
 */
export async function thumbnailFor(
  absPath: string,
  name: string,
  etag: string,
  size: ThumbSize,
): Promise<string> {
  if (!config.previews.enabled) throw notFound('Thumbnails are disabled on this server');

  const key = cacheKey(absPath, etag, size);
  const cached = cachePath(key);

  const hit = await fs.stat(cached).then((s) => s.size > 0).catch(() => false);
  if (hit) {
    // Touch so the sweeper treats it as recently used.
    const now = new Date();
    await fs.utimes(cached, now, now).catch(() => undefined);
    return cached;
  }

  const source = await fs.stat(absPath).catch(() => null);
  if (!source) throw notFound();
  if (source.size > MAX_SOURCE_BYTES) throw notFound('File is too large to preview');

  await fs.mkdir(config.storage.thumbsDir, { recursive: true });
  const temp = path.join(config.storage.thumbsDir, `.${key}.${process.pid}.tmp.jpg`);

  try {
    const kind = previewKind(name);
    if (kind === 'image') await renderImage(absPath, temp, size);
    else if (kind === 'video') await renderVideo(absPath, temp, size);
    else if (kind === 'pdf') await renderPdf(absPath, temp, size);
    else throw notFound('No thumbnail available for this file type');

    await fs.rename(temp, cached);
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }

  scheduleSweep();
  return cached;
}

//=================================================
// Renderers
//=================================================

async function renderImage(source: string, destination: string, size: ThumbSize): Promise<void> {
  await sharp(source, { failOn: 'none', limitInputPixels: 268_402_689, animated: false })
    .rotate() // honour the EXIF orientation, otherwise phone photos come out sideways
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true })
    .toFile(destination);
}

async function renderVideo(source: string, destination: string, size: ThumbSize): Promise<void> {
  if (!(await tools()).ffmpeg) throw notFound('Video thumbnails are unavailable on this server');

  const frame = path.join(os.tmpdir(), `cloud-frame-${crypto.randomUUID()}.jpg`);
  try {
    await run(
      'ffmpeg',
      [
        '-nostdin', '-loglevel', 'error',
        // Seek before -i so ffmpeg jumps rather than decoding from the start.
        '-ss', '00:00:01',
        '-i', source,
        '-frames:v', '1',
        '-vf', `scale='min(${size},iw)':-2`,
        '-y', frame,
      ],
      { timeout: 20_000, maxBuffer: 1024 * 1024 },
    );
    await renderImage(frame, destination, size);
  } finally {
    await fs.rm(frame, { force: true }).catch(() => undefined);
  }
}

async function renderPdf(source: string, destination: string, size: ThumbSize): Promise<void> {
  if (!(await tools()).pdftoppm) throw notFound('PDF thumbnails are unavailable on this server');

  const prefix = path.join(os.tmpdir(), `cloud-pdf-${crypto.randomUUID()}`);
  try {
    // -singlefile makes pdftoppm write "<prefix>.jpg" instead of "<prefix>-1.jpg".
    await run(
      'pdftoppm',
      ['-jpeg', '-r', '96', '-f', '1', '-l', '1', '-singlefile', '-scale-to', String(size), source, prefix],
      { timeout: 20_000, maxBuffer: 1024 * 1024 },
    );
    await renderImage(`${prefix}.jpg`, destination, size);
  } finally {
    await fs.rm(`${prefix}.jpg`, { force: true }).catch(() => undefined);
  }
}

//=================================================
// Cache sweeping
//=================================================
// Least-recently-used, driven by mtime, run at most once a minute and only
// after a cache miss — so a browsing session never pays for it twice.

let sweepTimer: NodeJS.Timeout | null = null;
let lastSweep = 0;

function scheduleSweep(): void {
  if (sweepTimer || Date.now() - lastSweep < 60_000) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    lastSweep = Date.now();
    void sweepCache();
  }, 5_000);
  sweepTimer.unref();
}

export async function sweepCache(): Promise<void> {
  const limit = config.previews.cacheBytes;
  if (limit <= 0) return;

  const names = await fs.readdir(config.storage.thumbsDir).catch(() => [] as string[]);
  const files: { path: string; size: number; atime: number }[] = [];
  let total = 0;

  for (const name of names) {
    const full = path.join(config.storage.thumbsDir, name);
    const stats = await fs.stat(full).catch(() => null);
    if (!stats?.isFile()) continue;
    files.push({ path: full, size: stats.size, atime: stats.mtimeMs });
    total += stats.size;
  }

  if (total <= limit) return;

  files.sort((a, b) => a.atime - b.atime);
  for (const file of files) {
    if (total <= limit * 0.8) break;
    await fs.rm(file.path, { force: true }).catch(() => undefined);
    total -= file.size;
  }
}

/** Guard the size parameter before it reaches the renderers. */
export function assertPreviewable(name: string): void {
  const kind = previewKind(name);
  if (kind !== 'image' && kind !== 'video' && kind !== 'pdf') {
    throw badRequest('No thumbnail available for this file type', 'no_thumbnail');
  }
}
