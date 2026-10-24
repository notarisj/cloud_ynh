/**
 * Hash routing.
 *
 * The app lives under whatever sub-path YunoHost installed it at, so a
 * history-based router would need that path threaded through everything. The
 * hash carries the location instead: it survives reloads, makes folders
 * linkable, and is completely indifferent to the mount point.
 */

export type View = 'browse' | 'trash' | 'search' | 'recents' | 'shares' | 'links';

/** Views that are a place of their own, with a fixed hash rather than a path. */
const PLACES: Partial<Record<View, string>> = {
  trash: 'trash',
  recents: 'recents',
  shares: 'shared-by-me',
  links: 'links',
};

export interface Location {
  view: View;
  path: string;
  query: string;
}

export function readHash(hash: string = window.location.hash): Location {
  const value = hash.replace(/^#/, '');
  for (const [view, hash] of Object.entries(PLACES)) {
    if (value === hash) return { view: view as View, path: '/me', query: '' };
  }
  if (value.startsWith('search=')) {
    return { view: 'search', path: '/me', query: safeDecode(value.slice(7)) };
  }
  const path = value.startsWith('/') ? value.split('/').map(safeDecode).join('/') : '/me';
  return { view: 'browse', path, query: '' };
}

/** The hash for a location — the inverse of readHash. */
export function locationHash({ view, path, query }: Location): string {
  const place = PLACES[view];
  if (place) return `#${place}`;
  if (view === 'search') return `#search=${encodeURIComponent(query)}`;
  return pathHash(path);
}

/**
 * Each segment is encoded on its own: encodeURI would leave "#" and "?" in a
 * folder name alone, and the address bar would then cut the path short.
 */
export function pathHash(path: string): string {
  return '#' + path.split('/').map(encodeURIComponent).join('/');
}

/** A hand-edited or truncated hash must not take the whole app down. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
