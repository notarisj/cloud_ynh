import { describe, expect, it } from 'vitest';
import { locationHash, pathHash, readHash } from './routing';

describe('hash routing', () => {
  it('round-trips folder names a URL would otherwise cut short', () => {
    const path = '/me/Q1 #2 ? 50%/Draft';
    expect(readHash(pathHash(path))).toEqual({ view: 'browse', path, query: '' });
  });

  it('reads the fixed views', () => {
    expect(readHash('#trash').view).toBe('trash');
    expect(readHash('#recents').view).toBe('recents');
    expect(readHash('#search=a%20b')).toEqual({ view: 'search', path: '/me', query: 'a b' });
  });

  it('falls back to My Files rather than failing', () => {
    expect(readHash('').path).toBe('/me');
    expect(readHash('#nonsense').path).toBe('/me');
    // A malformed escape is kept as typed instead of throwing.
    expect(readHash('#/me/100%').path).toBe('/me/100%');
  });

  it('writes the hash each view reads back', () => {
    for (const location of [
      { view: 'browse', path: '/shared/Trip', query: '' },
      { view: 'trash', path: '/me', query: '' },
      { view: 'recents', path: '/me', query: '' },
      { view: 'search', path: '/me', query: 'tax 2025' },
    ] as const) {
      expect(readHash(locationHash(location))).toEqual(location);
    }
  });
});
