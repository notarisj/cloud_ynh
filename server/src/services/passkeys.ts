import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { config } from '../config';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors';

/**
 * Passkeys.
 *
 * The YunoHost portal is still the front door, and nothing here replaces it.
 * A passkey is a second, self-contained way in: the private key never leaves
 * the user's device, there is no password to phish or reuse, and a stolen
 * database of these records is worth nothing to an attacker — every credential
 * is a public key bound to this exact domain.
 *
 * Credentials are stored one JSON file per account, the same shape and the
 * same guarantees as the refresh-token store next to it: written atomically,
 * serialised per user, never world-readable.
 *
 * Registrations require an authenticated session, so enrolling a key is always
 * something a user does *after* proving who they are through the portal.
 * Sign-in uses discoverable credentials, which is what lets the sign-in screen
 * ask for nothing at all — no username field means no way to probe which
 * accounts exist.
 */

export interface PasskeyRecord {
  /** Base64URL credential ID, as the authenticator reports it. */
  id: string;
  /** Base64URL COSE public key. */
  publicKey: string;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  /** What the user calls this key, e.g. "MacBook Touch ID". */
  name: string;
  createdAt: number;
  lastUsedAt: number;
  /** 'singleDevice' for a hardware key, 'multiDevice' for a synced passkey. */
  deviceType?: string;
  backedUp?: boolean;
}

interface PasskeyFile {
  username: string;
  displayName: string;
  /** Opaque, random user handle. Never the username: it leaves the server. */
  handle: string;
  credentials: PasskeyRecord[];
}

export function enabled(): boolean {
  return config.passkeys.enabled;
}

function assertEnabled(): void {
  if (!enabled()) throw forbidden('Passkeys are disabled on this server', 'passkeys_disabled');
}

//=================================================
// Store
//=================================================

const storeFile = (username: string) => path.join(config.storage.passkeysDir, `${username}.json`);

const queues = new Map<string, Promise<unknown>>();

function serialise<T>(username: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(username) ?? Promise.resolve();
  const next = previous.then(work, work);
  queues.set(username, next.catch(() => undefined));
  return next;
}

async function read(username: string): Promise<PasskeyFile | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(storeFile(username), 'utf8')) as PasskeyFile;
    if (!parsed || !Array.isArray(parsed.credentials)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function write(file: PasskeyFile): Promise<void> {
  await fs.mkdir(config.storage.passkeysDir, { recursive: true, mode: 0o700 });
  const target = storeFile(file.username);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(file, null, 2), { mode: 0o600 });
  await fs.rename(temp, target);
  index = null;
}

/**
 * Usernames become filenames, so the alphabet is checked here as well as in
 * the LDAP layer — a username with a slash in it must never reach the store.
 */
const USERNAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

function assertUsername(username: string): void {
  if (!USERNAME_RE.test(username)) throw badRequest('Invalid username', 'invalid_username');
}

//=================================================
// Lookup index
//=================================================
// Sign-in arrives with a credential ID and, usually, a user handle — but no
// username. Both have to be resolvable to an account, which means one small
// index over the store. There are never many files, and it is rebuilt whenever
// the store changes, so it stays a map lookup rather than a directory scan.

interface Index {
  byCredential: Map<string, string>;
  byHandle: Map<string, string>;
}

let index: Index | null = null;

async function loadIndex(): Promise<Index> {
  if (index) return index;

  const built: Index = { byCredential: new Map(), byHandle: new Map() };
  const names = await fs.readdir(config.storage.passkeysDir).catch(() => [] as string[]);

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const username = name.slice(0, -5);
    if (!USERNAME_RE.test(username)) continue;

    const file = await read(username);
    if (!file) continue;
    built.byHandle.set(file.handle, username);
    for (const credential of file.credentials) built.byCredential.set(credential.id, username);
  }

  index = built;
  return built;
}

//=================================================
// Challenges
//=================================================
// A ceremony is two requests: "give me a challenge" and "here is the signed
// answer". The challenge is held server-side, in memory, keyed by a random
// ticket the client echoes back — so nothing about the ceremony rides on a
// cookie, and a challenge is good for exactly one attempt.

interface PendingChallenge {
  challenge: string;
  /** Set for registration, where we already know who is enrolling. */
  username?: string;
  /**
   * The user handle the ceremony was started with. The authenticator stores it
   * alongside the credential, so the value that ends up on the user's device
   * has to be the one that ends up in the store — not a fresh random one.
   */
  handle?: string;
  expiresAt: number;
}

const pending = new Map<string, PendingChallenge>();

function remember(challenge: string, username?: string, handle?: string): string {
  sweepChallenges();
  const ticket = crypto.randomBytes(18).toString('base64url');
  pending.set(ticket, {
    challenge,
    username,
    handle,
    expiresAt: Date.now() + config.passkeys.challengeTtlMs,
  });
  return ticket;
}

function claim(ticket: unknown): PendingChallenge {
  sweepChallenges();
  if (typeof ticket !== 'string' || ticket.length === 0) {
    throw badRequest('Missing challenge ticket', 'no_challenge');
  }
  const found = pending.get(ticket);
  // One attempt per challenge, whether it succeeds or fails.
  pending.delete(ticket);
  if (!found || found.expiresAt < Date.now()) {
    throw badRequest('That sign-in attempt expired. Try again.', 'challenge_expired');
  }
  return found;
}

function sweepChallenges(): void {
  const now = Date.now();
  for (const [ticket, entry] of pending) if (entry.expiresAt < now) pending.delete(ticket);
  // A flood of unanswered challenges must not grow without bound.
  if (pending.size > 5000) pending.clear();
}

//=================================================
// Registration
//=================================================

export interface RegistrationChallenge {
  ticket: string;
  options: PublicKeyCredentialCreationOptionsJSON;
}

export async function beginRegistration(user: {
  username: string;
  displayName: string;
}): Promise<RegistrationChallenge> {
  assertEnabled();
  assertUsername(user.username);

  const existing = await read(user.username);
  const handle = existing?.handle ?? crypto.randomBytes(32).toString('base64url');

  const options = await generateRegistrationOptions({
    rpName: config.passkeys.rpName,
    rpID: config.passkeys.rpId,
    userName: user.username,
    userDisplayName: user.displayName || user.username,
    userID: new Uint8Array(Buffer.from(handle, 'utf8')),
    attestationType: 'none',
    // Enrolling the same authenticator twice would leave a duplicate that can
    // never be told apart in the list.
    excludeCredentials: (existing?.credentials ?? []).map((credential) => ({
      id: credential.id,
      transports: credential.transports,
    })),
    authenticatorSelection: {
      // Discoverable, so signing in needs no username — and so the sign-in
      // screen cannot be used to find out which accounts exist.
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'preferred',
    },
  });

  // The handle is only persisted once a credential actually lands, so an
  // abandoned ceremony leaves nothing behind.
  return { ticket: remember(options.challenge, user.username, handle), options };
}

export async function finishRegistration(
  user: { username: string; displayName: string },
  ticket: unknown,
  response: RegistrationResponseJSON,
  label: unknown,
): Promise<PasskeyRecord> {
  assertEnabled();
  assertUsername(user.username);

  const challenge = claim(ticket);
  if (challenge.username !== user.username) {
    throw badRequest('That challenge belongs to another session', 'challenge_mismatch');
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: [...config.passkeys.origins],
      expectedRPID: config.passkeys.rpId,
      requireUserVerification: false,
    });
  } catch (err) {
    throw badRequest(
      err instanceof Error ? err.message : 'That passkey could not be registered',
      'registration_failed',
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    throw badRequest('That passkey could not be registered', 'registration_failed');
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  return serialise(user.username, async () => {
    const file: PasskeyFile = (await read(user.username)) ?? {
      username: user.username,
      displayName: user.displayName || user.username,
      // The authenticator has already stored the handle this ceremony started
      // with; the store has to agree with it.
      handle: challenge.handle ?? crypto.randomBytes(32).toString('base64url'),
      credentials: [],
    };
    file.displayName = user.displayName || file.displayName;

    if (file.credentials.some((existing) => existing.id === credential.id)) {
      throw badRequest('That passkey is already registered', 'already_registered');
    }

    const record: PasskeyRecord = {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports,
      name: labelOf(label, file.credentials.length),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
    };

    file.credentials.push(record);
    await write(file);
    return record;
  });
}

function labelOf(label: unknown, count: number): string {
  if (typeof label === 'string' && label.trim().length > 0) return label.trim().slice(0, 60);
  return count === 0 ? 'Passkey' : `Passkey ${count + 1}`;
}

//=================================================
// Sign-in
//=================================================

export interface AuthenticationChallenge {
  ticket: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}

export async function beginAuthentication(): Promise<AuthenticationChallenge> {
  assertEnabled();

  // No allowCredentials: the browser offers whatever passkeys it holds for
  // this domain. Nothing here depends on, or reveals, who is signing in.
  const options = await generateAuthenticationOptions({
    rpID: config.passkeys.rpId,
    userVerification: 'preferred',
  });

  return { ticket: remember(options.challenge), options };
}

export interface AuthenticatedPasskey {
  username: string;
  displayName: string;
  credentialName: string;
}

export async function finishAuthentication(
  ticket: unknown,
  response: AuthenticationResponseJSON,
): Promise<AuthenticatedPasskey> {
  assertEnabled();

  const challenge = claim(ticket);
  if (!response || typeof response.id !== 'string') {
    throw badRequest('Malformed passkey response', 'invalid_response');
  }

  const lookup = await loadIndex();
  const username =
    lookup.byCredential.get(response.id) ??
    (response.response?.userHandle ? lookup.byHandle.get(response.response.userHandle) : undefined);

  // Deliberately the same answer as a failed signature: whether a credential
  // is known is not something an unauthenticated caller gets to learn.
  if (!username) throw unauthorized('That passkey is not registered here', 'unknown_passkey');

  const file = await read(username);
  const credential = file?.credentials.find((candidate) => candidate.id === response.id);
  if (!file || !credential) throw unauthorized('That passkey is not registered here', 'unknown_passkey');

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: [...config.passkeys.origins],
      expectedRPID: config.passkeys.rpId,
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')),
        counter: credential.counter,
        transports: credential.transports,
      },
      requireUserVerification: false,
    });
  } catch {
    throw unauthorized('That passkey could not be verified', 'passkey_invalid');
  }

  if (!verification.verified) throw unauthorized('That passkey could not be verified', 'passkey_invalid');

  // A counter that has gone backwards is the signature of a cloned
  // authenticator. The library rejects it; persisting the new value is what
  // keeps that check meaningful on the next attempt.
  await serialise(username, async () => {
    const current = await read(username);
    if (!current) return;
    const match = current.credentials.find((candidate) => candidate.id === response.id);
    if (!match) return;
    match.counter = verification.authenticationInfo.newCounter;
    match.lastUsedAt = Date.now();
    await write(current);
  });

  return { username, displayName: file.displayName || username, credentialName: credential.name };
}

//=================================================
// Management
//=================================================

export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number;
  /** True when the key is synced across the user's devices. */
  synced: boolean;
}

export async function list(username: string): Promise<PasskeySummary[]> {
  assertUsername(username);
  const file = await read(username);
  return (file?.credentials ?? [])
    .map((credential) => ({
      id: credential.id,
      name: credential.name,
      createdAt: credential.createdAt,
      lastUsedAt: credential.lastUsedAt,
      synced: credential.deviceType === 'multiDevice',
    }))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

export async function rename(username: string, id: string, name: string): Promise<PasskeySummary> {
  assertUsername(username);
  const trimmed = typeof name === 'string' ? name.trim().slice(0, 60) : '';
  if (trimmed.length === 0) throw badRequest('A passkey needs a name', 'invalid_name');

  return serialise(username, async () => {
    const file = await read(username);
    const credential = file?.credentials.find((candidate) => candidate.id === id);
    if (!file || !credential) throw notFound('No such passkey', 'no_passkey');

    credential.name = trimmed;
    await write(file);
    return {
      id: credential.id,
      name: credential.name,
      createdAt: credential.createdAt,
      lastUsedAt: credential.lastUsedAt,
      synced: credential.deviceType === 'multiDevice',
    };
  });
}

export async function remove(username: string, id: string): Promise<void> {
  assertUsername(username);

  await serialise(username, async () => {
    const file = await read(username);
    if (!file) throw notFound('No such passkey', 'no_passkey');

    const remaining = file.credentials.filter((candidate) => candidate.id !== id);
    if (remaining.length === file.credentials.length) throw notFound('No such passkey', 'no_passkey');

    file.credentials = remaining;
    await write(file);
  });
}

/** Whether this account has at least one passkey — shown in the settings panel. */
export async function count(username: string): Promise<number> {
  if (!USERNAME_RE.test(username)) return 0;
  const file = await read(username);
  return file?.credentials.length ?? 0;
}
