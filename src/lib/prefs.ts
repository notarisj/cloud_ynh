/**
 * View preferences, remembered per browser.
 *
 * Deliberately the only thing this app stores locally — it is a convenience,
 * never state the server needs, and every access is guarded because private
 * windows and locked-down browsers throw on the first read.
 */

const KEY = 'cloud.prefs.v1';

export interface Preferences {
  view: 'grid' | 'list';
  sort: 'name' | 'size' | 'mtime' | 'kind';
  descending: boolean;
}

const DEFAULTS: Preferences = { view: 'list', sort: 'name', descending: false };

export function loadPreferences(): Preferences {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      view: parsed.view === 'grid' ? 'grid' : 'list',
      sort: (['name', 'size', 'mtime', 'kind'] as const).includes(parsed.sort as never)
        ? (parsed.sort as Preferences['sort'])
        : 'name',
      descending: parsed.descending === true,
    };
  } catch {
    return DEFAULTS;
  }
}

export function savePreferences(preferences: Preferences): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(preferences));
  } catch {
    /* Storage is unavailable or full; the preference simply is not remembered. */
  }
}
