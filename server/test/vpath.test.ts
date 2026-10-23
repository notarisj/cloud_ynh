import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useScratchDataDir } from './helpers';

useScratchDataDir();

test('virtual paths', async (t) => {
  const { parseVPath, assertValidName, joinVPath, parentVPath } = await import('../src/lib/vpath');
  const { ticketCovers } = await import('../src/services/tokens');

  await t.test('normalises and maps /me to the caller', () => {
    const parsed = parseVPath('alice', '/me//Photos/./Trip/');
    assert.equal(parsed.vpath, '/me/Photos/Trip');
    assert.equal(parsed.rel, 'Photos/Trip');
    assert.equal(parsed.owner, 'alice');
    assert.ok(parsed.abs.endsWith(`users/alice/Photos/Trip`));
  });

  await t.test('rejects traversal and unknown roots', () => {
    // ".." is resolved inside the virtual space and can never leave it.
    assert.throws(() => parseVPath('alice', '/me/../bob'), { code: 'invalid_root' });
    assert.equal(parseVPath('alice', '/me/a/../b').vpath, '/me/b');
    assert.throws(() => parseVPath('alice', '/etc/passwd'), { code: 'invalid_root' });
    assert.throws(() => parseVPath('alice', '/me/a\0b'), { code: 'invalid_path' });
  });

  await t.test('validates names', () => {
    for (const bad of ['', '.', '..', 'a/b', ' padded', 'x'.repeat(256)]) {
      assert.throws(() => assertValidName(bad), { code: 'invalid_name' }, bad);
    }
    assert.doesNotThrow(() => assertValidName('Résumé 2.pdf'));
  });

  await t.test('joins and splits', () => {
    assert.equal(joinVPath('/me/Photos/', 'a.jpg'), '/me/Photos/a.jpg');
    assert.equal(parentVPath('/me/Photos/a.jpg'), '/me/Photos');
    assert.equal(parentVPath('/me'), null);
  });

  await t.test('tickets cover a subtree on path boundaries', () => {
    const ticket = { username: 'alice', scope: '/me/Photos' };
    assert.ok(ticketCovers(ticket, '/me/Photos'));
    assert.ok(ticketCovers(ticket, '/me/Photos/a.jpg'));
    assert.ok(!ticketCovers(ticket, '/me/Photos Private/a.jpg'));
    assert.ok(ticketCovers({ username: 'alice', scope: '/' }, '/shared/x'));
  });
});
