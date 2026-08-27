import mimeTypes from 'mime-types';

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | null;

/**
 * Extensions the preview pipeline can actually render. Anything else is
 * offered as a download only — guessing from the MIME family alone would
 * promise previews for formats sharp and ffmpeg cannot open.
 */
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'tiff', 'tif', 'bmp', 'svg', 'heic', 'heif']);
const VIDEO = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mpg', 'mpeg', '3gp']);
const AUDIO = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'aiff']);
const TEXT = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'yaml', 'yml', 'toml', 'ini', 'conf',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'html', 'htm', 'xml', 'svg',
  'py', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'java', 'kt', 'swift', 'sh', 'bash', 'sql',
]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function mimeFor(name: string): string {
  return mimeTypes.lookup(name) || 'application/octet-stream';
}

export function previewKind(name: string): PreviewKind {
  const ext = extensionOf(name);
  if (IMAGE.has(ext)) return 'image';
  if (VIDEO.has(ext)) return 'video';
  if (AUDIO.has(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (TEXT.has(ext)) return 'text';
  return null;
}

/** Whether a thumbnail image can be produced for this file. */
export function thumbnailable(name: string): boolean {
  const kind = previewKind(name);
  return kind === 'image' || kind === 'video' || kind === 'pdf';
}

/**
 * RFC 6266 Content-Disposition with both the plain and the UTF-8 form, so
 * non-ASCII filenames survive the trip to Safari and to URLSession.
 */
export function contentDisposition(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
