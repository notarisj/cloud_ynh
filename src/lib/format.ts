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
