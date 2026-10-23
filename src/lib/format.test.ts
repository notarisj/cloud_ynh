import { describe, expect, it } from 'vitest';
import { breadcrumbs, formatBytes, initials, needsRendition, splitExtension } from './format';

describe('formatting', () => {
  it('formats sizes the way the Finder does', () => {
    expect(formatBytes(0)).toBe('Zero bytes');
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(formatBytes(Number.NaN)).toBe('—');
  });

  it('keeps the extension out of a rename', () => {
    expect(splitExtension('photo.jpg')).toEqual({ base: 'photo', extension: '.jpg' });
    expect(splitExtension('.env')).toEqual({ base: '.env', extension: '' });
    expect(splitExtension('archive.tar.gz')).toEqual({ base: 'archive.tar', extension: '.gz' });
  });

  it('labels breadcrumbs with the root name', () => {
    expect(breadcrumbs('/me/Photos/Trip', { me: 'My Files' })).toEqual([
      { label: 'My Files', path: '/me' },
      { label: 'Photos', path: '/me/Photos' },
      { label: 'Trip', path: '/me/Photos/Trip' },
    ]);
  });

  it('knows which images need a rendition', () => {
    expect(needsRendition('IMG_0001.HEIC')).toBe(true);
    expect(needsRendition('scan.tif')).toBe(true);
    expect(needsRendition('photo.jpg')).toBe(false);
  });

  it('makes the same initials as the iOS app', () => {
    expect(initials('Jane Doe')).toBe('JD');
    expect(initials('jane.doe')).toBe('JD');
    expect(initials('dev')).toBe('D');
    expect(initials('')).toBe('?');
  });
});
