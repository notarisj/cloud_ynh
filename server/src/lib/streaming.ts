import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import type { Request, Response } from 'express';
import { contentDisposition, mimeFor } from './mime';
import { filesBeneath } from '../services/storage';

/**
 * Sending file bytes: one file with Range support, or several as a ZIP. Used
 * by the authenticated media routes and by public links alike, so both serve
 * files the same way and under the same rules.
 */

/**
 * Streams a file with Range support, which is what makes video scrubbing and
 * resumed downloads work — including URLSession's own resume logic on iOS.
 */
export function streamFile(
  req: Request,
  res: Response,
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


export interface ArchiveItem {
  /** Name at the top of the archive. */
  name: string;
  abs: string;
  isDir: boolean;
  mtime: number;
}

/** "Holiday.zip" for a folder or several items, "report.zip" for "report.pdf". */
export function archiveNameFor(name: string, isDir: boolean): string {
  // A file's extension gives way to ".zip"; a folder's name is kept whole.
  const base = isDir ? name : name.replace(/\.[^.]+$/, '');
  return `${base.replace(/[/\\\0]/g, '_').slice(0, 120) || 'Download'}.zip`;
}

/**
 * Stream items as one ZIP, built as it is sent — nothing is staged on disk —
 * and stored rather than compressed: photos and video, which are most of what
 * lives here, do not shrink, and storing keeps a large archive from pinning a
 * CPU. Folders are walked by filesBeneath, which never follows a symlink.
 */
export async function streamArchive(res: Response, items: ArchiveItem[], archiveName: string): Promise<void> {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', contentDisposition(archiveName, false));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const archive = archiver('zip', { store: true });
  archive.on('warning', (err) => console.warn('[cloud] archive warning:', err.message));
  archive.on('error', () => res.destroy());
  // A download cancelled half-way stops the walk instead of finishing it for nobody.
  res.on('close', () => {
    if (!res.writableFinished) archive.abort();
  });
  archive.pipe(res);

  const used = new Set<string>();
  for (const item of items) {
    // Two selected items can share a name when they come from different
    // folders; the second becomes "name 2", as anywhere else.
    const parsed = path.parse(item.name);
    let top = item.name;
    for (let n = 2; used.has(top); n += 1) top = `${parsed.name} ${n}${parsed.ext}`;
    used.add(top);

    if (!item.isDir) {
      archive.file(item.abs, { name: top, date: new Date(item.mtime) });
      continue;
    }
    archive.append('', { name: `${top}/` });
    for await (const child of filesBeneath(item.abs, top)) {
      if (child.isDir) archive.append('', { name: `${child.name}/` });
      else archive.file(child.abs, { name: child.name });
    }
  }

  await archive.finalize();
}
