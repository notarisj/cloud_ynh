import { config as loadDotenv } from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

// The systemd unit passes the .env through EnvironmentFile, so in production
// the variables are already in the environment. Loading the file again is
// harmless (dotenv never overwrites) and is what makes `npm run dev` work.
loadDotenv({ path: path.resolve(__dirname, '../.env') });

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

const NODE_ENV = str('NODE_ENV', 'development');
const IS_PROD = NODE_ENV === 'production';

/**
 * Outside production a missing signing key is a development environment that
 * has not been set up yet, not a security decision — and leaving it empty
 * turns every listing into an opaque 500 from deep inside the JWT library.
 * A throwaway key per process keeps `npm run dev` working; production refuses
 * to start instead, in assertProductionConfig().
 */
function jwtSecret(): string {
  const configured = str('JWT_SECRET');
  if (configured || IS_PROD) return configured;

  const ephemeral = crypto.randomBytes(48).toString('base64url');
  console.warn('[cloud] JWT_SECRET is not set — using a throwaway key for this development run.');
  return ephemeral;
}

const DATA_DIR = path.resolve(str('DATA_DIR', path.resolve(__dirname, '../.devdata')));

export const config = {
  isProd: IS_PROD,
  port: int('PORT', 3010),

  appId: str('APP_ID', 'cloud'),
  /** Sub-path the app is served under, e.g. "/cloud". Always without a trailing slash. */
  appPath: str('APP_PATH', '/').replace(/\/+$/, ''),
  publicUrl: str('APP_PUBLIC_URL', 'http://localhost:5173').replace(/\/+$/, ''),

  storage: {
    dataDir: DATA_DIR,
    /**
     * One private root per account. Every byte a user owns lives here —
     * including the items they share, which are published by reference rather
     * than by being moved somewhere else.
     */
    usersDir: path.join(DATA_DIR, 'users'),
    metaDir: path.join(DATA_DIR, '.meta'),
    trashDir: path.join(DATA_DIR, '.meta', 'trash'),
    thumbsDir: path.join(DATA_DIR, '.meta', 'thumbs'),
    uploadsDir: path.join(DATA_DIR, '.meta', 'uploads'),
    tokensDir: path.join(DATA_DIR, '.meta', 'tokens'),
    /** The share registry: which items are published under "/shared". */
    sharesFile: path.join(DATA_DIR, '.meta', 'shares.json'),
    /** One file per account holding that account's registered passkeys. */
    passkeysDir: path.join(DATA_DIR, '.meta', 'passkeys'),
    /**
     * Left over from the releases where "shared" was a physical folder anyone
     * could write into. Nothing serves it any more; the upgrade script moves
     * it aside, and the API only looks at it to warn an admin who restored an
     * older backup.
     */
    legacySharedDir: path.join(DATA_DIR, 'shared'),
    // ENABLE_SHARED is the historical name for this switch and is still what
    // the YunoHost package writes, so both spellings are accepted.
    sharingEnabled: bool('ENABLE_SHARING', bool('ENABLE_SHARED', true)),
    userQuotaBytes: int('USER_QUOTA_BYTES', 0),
    maxUploadBytes: int('MAX_UPLOAD_BYTES', 20 * 1024 ** 3),
  },

  previews: {
    enabled: bool('ENABLE_THUMBNAILS', true),
    cacheBytes: int('THUMBNAIL_CACHE_MB', 512) * 1024 * 1024,
  },

  auth: {
    proxySecret: str('PROXY_SECRET'),
    jwtSecret: jwtSecret(),
    accessTtl: int('ACCESS_TOKEN_TTL', 900),
    refreshTtl: int('REFRESH_TOKEN_TTL', 30 * 24 * 3600),
    ldapUrl: str('LDAP_URL', 'ldap://127.0.0.1:389'),
    ldapDnTemplate: str('LDAP_USER_DN_TEMPLATE', 'uid={username},ou=users,dc=yunohost,dc=org'),
    requiredPermission: str('REQUIRED_PERMISSION', 'cloud.main'),
    adminGroup: str('ADMIN_GROUP', 'admins'),
    loginRateLimit: int('LOGIN_RATE_LIMIT', 10),
    /** Identity every request is attributed to when running outside production. */
    devUser: str('DEV_USER', 'dev'),
    /** Whether that identity is treated as an administrator. */
    devAdmin: bool('DEV_ADMIN', true),
  },

  /**
   * Passkeys (WebAuthn).
   *
   * A second, independent way in. The YunoHost portal remains the front door —
   * it is what the SSO bridge trusts — but a passkey lets someone sign in to
   * this app directly with a fingerprint, a face or a hardware key, with no
   * password to phish and nothing shared between sites. The relying-party ID
   * is the bare domain: it is baked into every credential at registration, so
   * changing it invalidates every passkey already enrolled.
   */
  passkeys: {
    enabled: bool('ENABLE_PASSKEYS', true),
    rpName: str('PASSKEY_RP_NAME', 'Cloud'),
    rpId: str('PASSKEY_RP_ID') || hostOf(str('APP_PUBLIC_URL', 'http://localhost:5173')),
    /**
     * Origins a ceremony may come from. Exactly one in production — the app's
     * own — plus the Vite dev server when running locally.
     */
    origins: originsFor(str('APP_PUBLIC_URL', 'http://localhost:5173'), IS_PROD),
    /** How long a registration or sign-in ceremony may take. */
    challengeTtlMs: int('PASSKEY_CHALLENGE_TTL', 300) * 1000,
  },
} as const;

/** The bare hostname of a URL — the relying-party ID a credential is bound to. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'localhost';
  }
}

function originsFor(publicUrl: string, isProd: boolean): string[] {
  const origins: string[] = [];
  try {
    origins.push(new URL(publicUrl).origin);
  } catch {
    /* An unparseable APP_PUBLIC_URL leaves only the development origins. */
  }
  if (!isProd) origins.push('http://localhost:5173', 'http://127.0.0.1:5173');
  return [...new Set(origins)];
}

/**
 * Fail fast rather than serve every request as an unauthenticated admin.
 * Both of these are generated at install time, so an empty value in production
 * means the .env was not rendered — starting anyway would be worse than not
 * starting at all.
 */
export function assertProductionConfig(): void {
  if (!IS_PROD) return;

  const missing: string[] = [];
  if (!config.auth.proxySecret) missing.push('PROXY_SECRET');
  if (!config.auth.jwtSecret) missing.push('JWT_SECRET');

  if (missing.length > 0) {
    console.error(
      `[cloud] FATAL: ${missing.join(' and ')} not set. ` +
        'Requests would bypass authentication. Refusing to start.',
    );
    process.exit(1);
  }

  if (!fs.existsSync(config.storage.dataDir)) {
    console.error(`[cloud] FATAL: DATA_DIR ${config.storage.dataDir} does not exist.`);
    process.exit(1);
  }
}

/** Create the fixed parts of the storage tree. Per-user roots are made on demand. */
export function ensureStorageLayout(): void {
  for (const dir of [
    config.storage.usersDir,
    config.storage.metaDir,
    config.storage.trashDir,
    config.storage.thumbsDir,
    config.storage.uploadsDir,
    config.storage.tokensDir,
    config.storage.passkeysDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // A data directory restored from an older release still has the physical
  // shared folder in it. Say so once, loudly enough to be found in the
  // journal, rather than letting the files sit there unreachable and unnoticed.
  try {
    const legacy = fs.readdirSync(config.storage.legacySharedDir).filter((n) => !n.startsWith('.'));
    if (legacy.length > 0) {
      console.warn(
        `[cloud] ${legacy.length} item(s) remain in the old common folder ` +
          `${config.storage.legacySharedDir}. It is no longer served: sharing now publishes ` +
          "items from each user's own files. Move anything worth keeping into a user's " +
          'directory under ' + config.storage.usersDir + '.',
      );
    }
  } catch {
    /* No legacy folder — the normal case. */
  }
}
