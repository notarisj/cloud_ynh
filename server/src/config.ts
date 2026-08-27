import { config as loadDotenv } from 'dotenv';
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
    /** One private root per account. */
    usersDir: path.join(DATA_DIR, 'users'),
    /** Common area, when the admin enabled it. */
    sharedDir: path.join(DATA_DIR, 'shared'),
    metaDir: path.join(DATA_DIR, '.meta'),
    trashDir: path.join(DATA_DIR, '.meta', 'trash'),
    thumbsDir: path.join(DATA_DIR, '.meta', 'thumbs'),
    uploadsDir: path.join(DATA_DIR, '.meta', 'uploads'),
    tokensDir: path.join(DATA_DIR, '.meta', 'tokens'),
    sharedEnabled: bool('ENABLE_SHARED', true),
    userQuotaBytes: int('USER_QUOTA_BYTES', 0),
    maxUploadBytes: int('MAX_UPLOAD_BYTES', 20 * 1024 ** 3),
  },

  previews: {
    enabled: bool('ENABLE_THUMBNAILS', true),
    cacheBytes: int('THUMBNAIL_CACHE_MB', 512) * 1024 * 1024,
  },

  auth: {
    proxySecret: str('PROXY_SECRET'),
    jwtSecret: str('JWT_SECRET'),
    accessTtl: int('ACCESS_TOKEN_TTL', 900),
    refreshTtl: int('REFRESH_TOKEN_TTL', 30 * 24 * 3600),
    ldapUrl: str('LDAP_URL', 'ldap://127.0.0.1:389'),
    ldapDnTemplate: str('LDAP_USER_DN_TEMPLATE', 'uid={username},ou=users,dc=yunohost,dc=org'),
    requiredPermission: str('REQUIRED_PERMISSION', 'cloud.main'),
    adminGroup: str('ADMIN_GROUP', 'admins'),
    loginRateLimit: int('LOGIN_RATE_LIMIT', 10),
    /** Identity every request is attributed to when running outside production. */
    devUser: str('DEV_USER', 'dev'),
  },
} as const;

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
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (config.storage.sharedEnabled) {
    fs.mkdirSync(config.storage.sharedDir, { recursive: true });
  }
}
