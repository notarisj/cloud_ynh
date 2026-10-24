import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
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
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/auth/quick`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method: string, route: string, body?: unknown) {
  const response = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, cookie: response.headers.get('set-cookie') };
}

test('a phone approves a browser, once, with the number the browser shows', async () => {
  const started = await call('POST', '/start');
  assert.equal(started.status, 201);
  const { id, secret, code, url } = started.body;
  assert.ok(url.endsWith(`#quick=${id}`));

  // Before anything: pending, and only to the browser that holds the secret.
  assert.equal((await call('POST', `/${id}/poll`, { secret })).body.status, 'pending');
  assert.equal((await call('POST', `/${id}/poll`, { secret: 'guess' })).status, 404);

  // The phone sees who is asking and three numbers, but never the code itself.
  const scanned = await call('POST', `/${id}/scan`);
  assert.equal(scanned.status, 200);
  assert.equal(scanned.body.browser, 'Safari on Mac');
  assert.equal(scanned.body.choices.length, 3);
  assert.ok(scanned.body.choices.includes(code));
  assert.equal(scanned.body.code, undefined);

  assert.equal((await call('POST', `/${id}/approve`, { code })).status, 204);

  const done = await call('POST', `/${id}/poll`, { secret });
  assert.equal(done.body.status, 'approved');
  assert.ok(done.body.session.accessToken);
  assert.match(done.cookie ?? '', /cloud_session=/);
  assert.match(done.cookie ?? '', /HttpOnly/);

  // Used up: neither the browser nor anyone else gets a second session.
  assert.equal((await call('POST', `/${id}/poll`, { secret })).status, 404);
});

test('a wrong number ends the request', async () => {
  const { id, secret, code } = (await call('POST', '/start')).body;
  const { choices } = (await call('POST', `/${id}/scan`)).body;
  const wrong = choices.find((n: number) => n !== code);
  assert.equal((await call('POST', `/${id}/approve`, { code: wrong })).body.code, 'quick_mismatch');
  // No second try with the right one.
  assert.equal((await call('POST', `/${id}/approve`, { code })).status, 409);
  assert.equal((await call('POST', `/${id}/poll`, { secret })).body.status, 'denied');
});

test('declining, unknown codes, and approving without scanning', async () => {
  const { id, secret } = (await call('POST', '/start')).body;
  assert.equal((await call('POST', `/${id}/approve`, { code: 10 })).status, 403);
  await call('POST', `/${id}/scan`);
  assert.equal((await call('POST', `/${id}/deny`)).status, 204);
  assert.equal((await call('POST', `/${id}/poll`, { secret })).body.status, 'denied');
  assert.equal((await call('POST', '/nope/scan')).status, 404);
});
