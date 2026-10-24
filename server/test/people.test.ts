import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { useScratchDataDir } from './helpers';

const dataDir = useScratchDataDir();

let storage: typeof import('../src/services/storage');
let shares: typeof import('../src/services/shares');
let users: typeof import('../src/services/users');
let vpath: typeof import('../src/lib/vpath');

before(async () => {
  const { ensureStorageLayout } = await import('../src/config');
  ensureStorageLayout();
  storage = await import('../src/services/storage');
  shares = await import('../src/services/shares');
  users = await import('../src/services/users');
  vpath = await import('../src/lib/vpath');

  for (const name of ['bob', 'carol', 'dave']) {
    await storage.ensureUserRoot(name);
  }
  fs.mkdirSync(path.join(dataDir, 'users/bob/Plans'));
  fs.writeFileSync(path.join(dataDir, 'users/bob/Plans/budget.txt'), 'numbers');
  fs.writeFileSync(path.join(dataDir, 'users/bob/menu.txt'), 'soup');
});

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('an item shared with named people is invisible to everyone else', async () => {
  await shares.share('bob', 'Plans', 'Plans', 'users', ['carol', 'carol', 'bob', '../etc']);
  await shares.share('bob', 'menu.txt', 'menu.txt', 'all');

  const record = shares.all().find((r) => r.rel === 'Plans')!;
  // Cleaned up: once each, never the owner, nothing that is not a name.
  assert.deepEqual(record.sharedWith, ['carol']);

  const names = async (who: string) => (await storage.list(who, '/shared')).entries.map((e) => e.name).sort();
  assert.deepEqual(await names('carol'), ['Plans', 'menu.txt']);
  assert.deepEqual(await names('bob'), ['Plans', 'menu.txt']);
  assert.deepEqual(await names('dave'), ['menu.txt']);

  // Not by path, not by search, not by Get Info.
  await assert.rejects(vpath.resolveVPath('dave', '/shared/Plans/budget.txt', { mustExist: true }), {
    status: 404,
  });
  assert.equal((await storage.search('dave', 'budget')).length, 0);
  assert.equal((await storage.search('carol', 'budget')).length, 1);
  assert.equal((await storage.measure('dave', '/shared')).folders, 1);

  // And the index's etag differs between them, so a client cache cannot leak it.
  const daveIndex = await storage.stat('dave', '/shared');
  const carolIndex = await storage.stat('carol', '/shared');
  assert.notEqual(daveIndex.etag, carolIndex.etag);
});

test('sharing with nobody in particular is refused, and changing who works', async () => {
  await assert.rejects(async () => shares.share('bob', 'Plans', 'Plans', 'users', []), { code: 'no_recipients' });
  await shares.share('bob', 'Plans', 'Plans', 'users', ['dave']);
  assert.ok(shares.visibleTo(shares.all().find((r) => r.rel === 'Plans')!, 'dave'));
  assert.ok(!shares.visibleTo(shares.all().find((r) => r.rel === 'Plans')!, 'carol'));
  await shares.share('bob', 'Plans', 'Plans', 'all');
  assert.ok(shares.visibleTo(shares.all().find((r) => r.rel === 'Plans')!, 'carol'));
});

test('local accounts', async () => {
  // Never under the name of an account the server already has.
  await assert.rejects(users.createLocalUser('alice', 'long enough pw', false), { code: 'user_exists' });
  await assert.rejects(users.createLocalUser('Erin', 'long enough pw', false), { code: 'invalid_username' });
  await assert.rejects(users.createLocalUser('erin', 'short', false), { code: 'weak_password' });

  const erin = await users.createLocalUser('erin', 'long enough pw', false);
  assert.equal(erin.username, 'erin');
  await assert.rejects(users.createLocalUser('erin', 'long enough pw', false), { code: 'user_exists' });

  assert.equal((await users.authenticateLocal('erin', 'long enough pw')).username, 'erin');
  await assert.rejects(users.authenticateLocal('erin', 'wrong password'), { status: 401 });
  await assert.rejects(users.authenticateLocal('nobody', 'long enough pw'), { status: 401 });

  // The registry holds a hash, never the password.
  const stored = fs.readFileSync(path.join(dataDir, '.meta/users.json'), 'utf8');
  assert.ok(!stored.includes('long enough pw'));

  await users.deleteLocalUser('erin');
  await assert.rejects(users.authenticateLocal('erin', 'long enough pw'), { status: 401 });
});
