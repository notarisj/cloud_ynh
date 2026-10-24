import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import { useScratchDataDir } from './helpers';

const dataDir = useScratchDataDir();

let server: Server;
let base = '';
let tokens: typeof import('../src/services/tokens');

before(async () => {
  const { ensureStorageLayout } = await import('../src/config');
  const { createApp } = await import('../src/app');
  tokens = await import('../src/services/tokens');
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

const person = async (name: string) =>
  (await call('GET', '/users')).body.users.find((u: any) => u.username === name);

test('administrators see everything about everyone', async () => {
  assert.equal((await call('POST', '/users', { username: 'erin', password: 'long enough pw' })).status, 201);
  const erin = await person('erin');
  assert.equal(erin.source, 'local');
  assert.equal(erin.disabled, false);
  assert.equal(erin.isAdmin, false);
  assert.equal(typeof erin.usedBytes, 'number');

  // The development user is an admin "by the server" and that cannot be undone here.
  const me = await person('alice');
  assert.equal(me.adminFromServer, true);
});

test('any account can be turned off, which signs it out and keeps it out', async () => {
  const pair = await tokens.issueTokenPair({ username: 'erin', displayName: 'erin', isAdmin: false }, 'test');
  assert.ok(pair.accessToken);

  const off = await call('PATCH', '/users/erin', { disabled: true });
  assert.equal(off.status, 200);
  assert.equal(off.body.user.disabled, true);
  assert.equal(off.body.user.devices, 0);

  // No new session, no refresh, no request on an old one.
  await assert.rejects(tokens.issueTokenPair({ username: 'erin', displayName: 'erin', isAdmin: false }, 'x'), {
    code: 'account_disabled',
  });
  assert.throws(() => tokens.signAccessToken({ username: 'erin', displayName: 'erin', isAdmin: false }, 'sso:erin'), {
    code: 'account_disabled',
  });
  await assert.rejects(tokens.assertSessionActive('erin', 'sso:erin'), { code: 'account_disabled' });

  // Hidden from the people others can share with.
  assert.equal((await call('PATCH', '/users/erin', { disabled: false })).body.user.disabled, false);
  tokens.signAccessToken({ username: 'erin', displayName: 'erin', isAdmin: false }, 'sso:erin');
});

test('admin rights, passwords, and what the app may not change', async () => {
  assert.equal((await call('PATCH', '/users/erin', { isAdmin: true })).body.user.isAdmin, true);
  assert.equal((await call('PATCH', '/users/erin', { isAdmin: false })).body.user.isAdmin, false);

  assert.equal((await call('PATCH', '/users/erin', { password: 'short' })).status, 400);
  assert.equal((await call('PATCH', '/users/erin', { password: 'a new long password' })).status, 200);
  const users = await import('../src/services/users');
  assert.equal((await users.authenticateLocal('erin', 'a new long password')).username, 'erin');

  // Not on yourself, not a server-given rank, not a YunoHost password.
  assert.equal((await call('PATCH', '/users/alice', { disabled: true })).status, 400);
  assert.equal((await call('PATCH', '/users/alice', { isAdmin: false })).status, 400);
  assert.equal((await call('PATCH', '/users/alice', { password: 'whatever long' })).status, 409);
  assert.equal((await call('PATCH', '/users/nobody', { disabled: true })).status, 404);
});

test('removing an account forgets everything decided about it', async () => {
  await call('PATCH', '/users/erin', { disabled: true });
  assert.equal((await call('DELETE', '/users/erin')).status, 204);
  const policy = await import('../src/services/policy');
  assert.equal(policy.isDisabled('erin'), false);
  assert.equal(await person('erin'), undefined);
});
