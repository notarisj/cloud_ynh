import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useScratchDataDir } from './helpers';

useScratchDataDir();

test('refresh tokens', async (t) => {
  const tokens = await import('../src/services/tokens');
  const user = { username: 'alice', displayName: 'Alice', isAdmin: true };

  await t.test('rotation keeps the account and honours the previous token briefly', async () => {
    const pair = await tokens.issueTokenPair(user, 'phone');
    const first = await tokens.rotateRefreshToken('alice', pair.refreshToken);
    assert.deepEqual(first.principal, { username: 'alice', displayName: 'Alice', email: undefined, isAdmin: true });

    // A second process presenting the same, just-replaced token still gets in.
    const second = await tokens.rotateRefreshToken('alice', pair.refreshToken);
    assert.equal(second.sid, first.sid);

    await assert.rejects(tokens.rotateRefreshToken('alice', 'not-a-token'), { code: 'refresh_invalid' });
  });

  await t.test('access tokens carry identity and are rejected as tickets', async () => {
    const pair = await tokens.issueTokenPair(user, 'laptop');
    const claims = tokens.verifyAccessToken(pair.accessToken);
    assert.equal(claims.username, 'alice');
    assert.equal(claims.isAdmin, true);

    const ticket = tokens.signTicket('alice', '/me', claims.sid);
    assert.throws(() => tokens.verifyAccessToken(ticket), { code: 'token_invalid' });
    assert.throws(() => tokens.verifyTicket(pair.accessToken), { code: 'ticket_invalid' });
    assert.equal(tokens.verifyTicket(ticket).sid, claims.sid);
  });

  await t.test('revoking a session ends its access token at once', async () => {
    const pair = await tokens.issueTokenPair(user, 'tablet');
    const { sid } = tokens.verifyAccessToken(pair.accessToken);
    await tokens.assertSessionActive('alice', sid);

    await tokens.revokeSession('alice', sid);
    await assert.rejects(tokens.assertSessionActive('alice', sid), { code: 'session_revoked' });

    // Portal sessions have no refresh token to revoke and always pass.
    await tokens.assertSessionActive('alice', 'sso:alice');
  });

  await t.test('logging out with a token revokes its session', async () => {
    const pair = await tokens.issueTokenPair(user, 'kiosk');
    const { sid } = tokens.verifyAccessToken(pair.accessToken);
    await tokens.revokeRefreshToken('alice', pair.refreshToken);
    await assert.rejects(tokens.assertSessionActive('alice', sid), { code: 'session_revoked' });
  });
});
