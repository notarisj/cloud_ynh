import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';
import { useScratchDataDir } from './helpers';

const dataDir = useScratchDataDir();

let server: Server;
let base = '';

before(async () => {
  const { ensureStorageLayout } = await import('../src/config');
  const { createApp } = await import('../src/app');
  ensureStorageLayout();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call<T = any>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(base + route, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function upload(target: string, bytes: Buffer, conflict = 'rename') {
  const begun = await call('POST', '/upload', { path: target, size: bytes.length, conflict });
  if (begun.status !== 201) return begun;
  const { id, chunkSize, chunkCount } = begun.body.upload;
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = bytes.subarray(index * chunkSize, (index + 1) * chunkSize);
    const put = await fetch(`${base}/upload/${id}/chunk/${index}`, { method: 'PUT', body: chunk });
    assert.equal(put.status, 200);
  }
  return call('POST', `/upload/${id}/complete`);
}

test('server configuration is public', async () => {
  const { status, body } = await call('GET', '/auth/config');
  assert.equal(status, 200);
  assert.equal(body.version, 2);
  assert.equal(body.sharing, true);
});

test('uploads create missing folders and refuse to replace a folder', async () => {
  const done = await upload('/me/Photos/Trip/beach.jpg', Buffer.from('jpeg bytes'));
  assert.equal(done.status, 201);
  assert.equal(done.body.entry.path, '/me/Photos/Trip/beach.jpg');

  const onFolder = await call('POST', '/upload', { path: '/me/Photos', size: 1, conflict: 'replace' });
  assert.equal(onFolder.status, 409);

  const listing = await call('GET', '/files/?path=/me/Photos/Trip');
  assert.deepEqual(listing.body.entries.map((e: any) => e.name), ['beach.jpg']);
  assert.ok(listing.body.ticket.token);
});

test('simple uploads land with a valid name', async () => {
  const form = new FormData();
  form.append('file', new Blob(['hello']), 'note.txt');
  const response = await fetch(`${base}/upload/simple?path=/me`, { method: 'POST', body: form });
  assert.equal(response.status, 201);
  assert.ok(fs.existsSync(path.join(dataDir, 'users/alice/note.txt')));
  // Nothing is left behind in the staging area.
  assert.deepEqual(fs.readdirSync(path.join(dataDir, '.meta/uploads')), []);
});

test('sharing rules and the shared index', async () => {
  const shared = await call('POST', '/files/share', { path: '/me/Photos/Trip' });
  assert.equal(shared.status, 201);
  assert.equal(shared.body.share.isDir, true);

  const parent = await call('POST', '/files/share', { path: '/me/Photos' });
  assert.equal(parent.status, 409);
  assert.equal(parent.body.code, 'contains_shared');

  const index = await call('GET', '/files/?path=/shared');
  assert.deepEqual(index.body.entries.map((e: any) => e.path), ['/shared/Trip']);
  assert.equal(index.body.writable, false);

  const found = await call('GET', '/files/search?q=trip');
  const hit = found.body.results.find((e: any) => e.path === '/me/Photos/Trip');
  assert.equal(hit.shared, true);

  const mine = await call('GET', '/files/shares');
  assert.equal(mine.body.shares.length, 1);

  // Renaming the shared folder carries the share along with it.
  await call('POST', '/files/rename', { path: '/me/Photos/Trip', name: 'Iceland' });
  const after = await call('GET', '/files/shares');
  assert.equal(after.body.shares[0].path, '/me/Photos/Iceland');
  assert.equal(after.body.shares[0].name, 'Iceland');

  assert.equal((await call('DELETE', `/files/share?id=${after.body.shares[0].id}`)).status, 204);
  assert.equal((await call('GET', '/files/shares')).body.shares.length, 0);
});

test('copying over a shared item drops its share', async () => {
  await upload('/me/a.txt', Buffer.from('a'));
  await upload('/me/b.txt', Buffer.from('b'));
  await call('POST', '/files/share', { path: '/me/b.txt' });
  const copied = await call('POST', '/files/copy', { from: '/me/a.txt', to: '/me/b.txt', conflict: 'replace' });
  assert.equal(copied.status, 200);
  assert.equal((await call('GET', '/files/shares')).body.shares.length, 0);
});

test('the change feed pages forward and always advances', async () => {
  for (let i = 0; i < 5; i += 1) await upload(`/me/Feed/f${i}.txt`, Buffer.from(String(i)));

  const seen = new Set<string>();
  let since = 0;
  for (let page = 0; page < 20; page += 1) {
    const { body } = await call('GET', `/sync/changes?root=/me&since=${since}&limit=2`);
    for (const entry of body.changes) seen.add(entry.path);
    assert.ok(body.anchor > since || !body.truncated, 'anchor must move while there is more');
    since = body.anchor;
    if (!body.truncated) break;
  }
  for (let i = 0; i < 5; i += 1) assert.ok(seen.has(`/me/Feed/f${i}.txt`));

  const newest = await call('GET', '/sync/changes?root=/me&newest=1&limit=3');
  const times = newest.body.changes.map((e: any) => e.mtime);
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test('trash restores into My Files when the original folder is gone', async () => {
  await upload('/me/Old/keep.txt', Buffer.from('keep'));
  const trashed = await call('DELETE', '/files/?path=/me/Old/keep.txt');
  await call('DELETE', '/files/?path=/me/Old&permanent=1');
  // A file now sits where the folder used to be.
  await upload('/me/Old', Buffer.from('not a folder'), 'fail');

  const restored = await call('POST', `/trash/${trashed.body.trashed.id}/restore`);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.entry.path, '/me/keep.txt');
});

test('paths cannot escape the data directory', async () => {
  const listing = await call('GET', '/files/?path=/etc');
  assert.equal(listing.status, 400);
  fs.symlinkSync('/etc', path.join(dataDir, 'users/alice/escape'));
  const through = await call('GET', '/files/?path=/me/escape');
  assert.equal(through.status, 403);
});

test('folders download as a ZIP that stays inside the tree', async () => {
  await upload('/me/Album.2024/one.txt', Buffer.from('one'));
  await upload('/me/Album.2024/Inner/two.txt', Buffer.from('two'));
  fs.symlinkSync('/etc/hosts', path.join(dataDir, 'users/alice/Album.2024/hosts'));

  const response = await fetch(`${base}/media/archive?path=${encodeURIComponent('/me/Album.2024')}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('content-disposition') ?? '', /Album\.2024\.zip/);

  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString('latin1');
  assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'starts with a local file header');
  assert.ok(text.includes('Album.2024/one.txt'));
  assert.ok(text.includes('Album.2024/Inner/two.txt'));
  assert.ok(!text.includes('Album.2024/hosts'), 'symlinks are not followed');
});

test('get info measures a folder', async () => {
  const { status, body } = await call('GET', `/files/info?path=${encodeURIComponent('/me/Album.2024')}`);
  assert.equal(status, 200);
  assert.equal(body.entry.isDir, true);
  assert.deepEqual(body.contents, { size: 6, files: 2, folders: 1, complete: true });
});

test('public links publish one item and nothing else', async () => {
  await upload('/me/Public/Trip/photo.jpg', Buffer.from('jpeg'));
  await upload('/me/Public/Trip/.hidden', Buffer.from('secret'));
  await upload('/me/Private/diary.txt', Buffer.from('private'));
  fs.symlinkSync(path.join(dataDir, 'users/alice/Private'), path.join(dataDir, 'users/alice/Public/Trip/escape'));

  const created = await call('POST', '/links', { path: '/me/Public/Trip', expiresInDays: 7 });
  assert.equal(created.status, 201);
  const { url, id } = created.body.link;
  assert.ok(created.body.link.expiresAt > Date.now());
  const token = url.split('/s/')[1];
  const site = base.replace('/api/v1', '');

  const page = await fetch(`${site}/s/${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const html = await page.text();
  assert.ok(html.includes('photo.jpg'));
  assert.ok(!html.includes('.hidden'), 'hidden files are not listed');

  const file = await fetch(`${site}/s/${token}/file?path=photo.jpg`);
  assert.equal(await file.text(), 'jpeg');

  for (const probe of ['../../Private/diary.txt', 'escape/diary.txt', '.hidden', '%2e%2e/x']) {
    const response = await fetch(`${site}/s/${token}/file?path=${encodeURIComponent(probe)}`);
    assert.ok(response.status === 404 || response.status === 400, `${probe} → ${response.status}`);
  }

  const zip = await fetch(`${site}/s/${token}/zip`);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  const zipped = Buffer.from(await zip.arrayBuffer()).toString('latin1');
  assert.ok(zipped.includes('Trip/photo.jpg'));
  assert.ok(!zipped.includes('diary'), 'the archive does not follow the symlink');

  // The link follows its folder when the folder is renamed…
  await call('POST', '/files/rename', { path: '/me/Public/Trip', name: 'Iceland' });
  assert.equal((await fetch(`${site}/s/${token}/file?path=photo.jpg`)).status, 200);
  assert.equal((await call('GET', '/links')).body.links[0].path, '/me/Public/Iceland');

  // …and stops working when it is revoked.
  assert.equal((await call('DELETE', `/links/${id}`)).status, 204);
  const gone = await fetch(`${site}/s/${token}`);
  assert.equal(gone.status, 404);
  assert.ok((await gone.text()).includes('no longer available'));
});

test('a link dies with its item and cannot point outside My Files', async () => {
  await upload('/me/temp.txt', Buffer.from('t'));
  const created = await call('POST', '/links', { path: '/me/temp.txt', expiresInDays: null });
  assert.equal(created.body.link.expiresAt, null);
  await call('DELETE', '/files/?path=/me/temp.txt');
  assert.deepEqual((await call('GET', '/links?path=/me/temp.txt')).body.links, []);

  assert.equal((await call('POST', '/links', { path: '/me' })).status, 400);
  assert.equal((await call('POST', '/links', { path: '/me/nothing-here' })).status, 404);
  assert.equal((await call('POST', '/links', { path: '/me/a.txt', expiresInDays: 0 })).status, 400);
});
