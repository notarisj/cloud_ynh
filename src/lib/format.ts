/** Human-readable byte counts, base-2 like the Finder's "on disk" figures. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return 'Zero bytes';
  if (bytes < 1024) return `${bytes} bytes`;

  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const TIME_ONLY = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const THIS_YEAR = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const FULL = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const EXACT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

/**
 * Dates the way a file browser shows them: a time for today, a weekday-free
 * short date for this year, a full date beyond that.
 */
export function formatDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const date = new Date(ms);
  const now = new Date();

  const sameDay =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();

  if (sameDay) return `Today at ${TIME_ONLY.format(date)}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear();

  if (isYesterday) return `Yesterday at ${TIME_ONLY.format(date)}`;
  if (date.getFullYear() === now.getFullYear()) return THIS_YEAR.format(date);
  return FULL.format(date);
}

export const formatExactDate = (ms: number): string =>
  Number.isFinite(ms) && ms > 0 ? EXACT.format(new Date(ms)) : '—';

/** "in 12 days" / "3 days ago" — used for trash retention. */
export function formatRelativeDays(days: number): string {
  return RELATIVE.format(Math.round(days), 'day');
}

/** "JPEG image", "Folder" — the Kind line in Get Info, as the iOS app words it. */
export function kindLabel(entry: { isDir: boolean; name: string; preview: string | null }): string {
  if (entry.isDir) return 'Folder';
  const extension = entry.name.includes('.') ? entry.name.split('.').pop()!.toUpperCase() : '';
  const family: Record<string, string> = {
    image: 'image', video: 'video', audio: 'audio', pdf: 'document', text: 'text document',
  };
  if (entry.preview === 'pdf') return 'PDF document';
  const noun = family[entry.preview ?? ''] ?? 'document';
  return extension ? `${extension} ${noun}` : noun[0]!.toUpperCase() + noun.slice(1);
}

/** "/me/Photos/Trip/a.jpg" → "My Files › Photos › Trip": where an item lives. */
export function locationLabel(vpath: string, rootLabels: Record<string, string>): string {
  const segments = vpath.split('/').filter(Boolean).slice(0, -1);
  if (segments.length === 0) return '—';
  return segments.map((segment, index) => (index === 0 ? (rootLabels[segment] ?? segment) : segment)).join(' › ');
}

/**
 * Image formats a browser cannot be relied on to display, which the preview
 * shows through the server's JPEG rendition instead of the original bytes.
 */
export function needsRendition(name: string): boolean {
  return /\.(heic|heif|tiff?)$/i.test(name);
}

/**
 * Up to two initials, split on the separators a user name or a display name
 * uses: "Jane Doe" and "jane.doe" both give "JD". Matches the iOS app.
 */
export function initials(name: string): string {
  const letters = name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  return letters || '?';
}

/** The display name without its extension, for rename fields and grid labels. */
export function splitExtension(name: string): { base: string; extension: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { base: name, extension: '' };
  return { base: name.slice(0, dot), extension: name.slice(dot) };
}

/** Segments of a virtual path, with the display label for its root. */
export function breadcrumbs(vpath: string, rootLabels: Record<string, string>): {
  label: string;
  path: string;
}[] {
  const segments = vpath.split('/').filter(Boolean);
  return segments.map((segment, index) => ({
    label: index === 0 ? (rootLabels[segment] ?? segment) : segment,
    path: '/' + segments.slice(0, index + 1).join('/'),
  }));
}

/** "4.2 MB/s". Empty while the rate is still unknown, so callers can omit it. */
export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * Time left, rounded to something a person would actually say.
 *
 * Precision here is false comfort: the number is an extrapolation from the
 * last few seconds of a connection that is about to change its mind. Coarse
 * buckets age better than "1:47 remaining" counting down unevenly.
 */
export function formatRemaining(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 10) return 'a few seconds left';
  if (seconds < 60) return `${Math.round(seconds / 5) * 5} seconds left`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min left`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr left` : `${hours} hr ${rest} min left`;
}
