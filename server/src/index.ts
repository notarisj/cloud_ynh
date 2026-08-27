import path from 'path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { assertProductionConfig, config, ensureStorageLayout } from './config';
import { requireProxySecret } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { authRouter } from './routes/auth';
import { filesRouter } from './routes/files';
import { mediaRouter } from './routes/media';
import { ssoRouter } from './routes/sso';
import { syncRouter } from './routes/sync';
import { trashRouter } from './routes/trash';
import { uploadRouter } from './routes/upload';
import * as trash from './services/trash';
import * as uploads from './services/uploads';
import * as thumbs from './services/thumbs';
import * as shares from './services/shares';

assertProductionConfig();
ensureStorageLayout();

const app = express();

// nginx is the only thing in front, and it is on loopback. Trusting exactly one
// hop keeps req.ip honest for the login rate limiter without letting a client
// forge X-Forwarded-For.
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.set('etag', false);

//=================================================
// Security headers
//=================================================

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // The SPA sets inline styles for progress bars and grid sizing.
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Thumbnails and previews are same-origin; blob: covers client-side
        // object URLs used while an upload is still in flight.
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'self'", 'blob:'],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    // Previews are served from this origin into <img> and <video> on the same
    // origin; the default "same-origin" policy would block the SPA's own use.
    crossOriginResourcePolicy: { policy: 'same-origin' },
  }),
);

if (!config.isProd) {
  app.use(cors({ origin: ['http://localhost:5173'], credentials: true }));
}

//=================================================
// Health
//=================================================

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

//=================================================
// API
//=================================================
// Body parsing is mounted per-router rather than globally: the chunk endpoint
// takes raw bytes and must never have a parser read the stream first.

const json = express.json({ limit: '256kb' });

// The SSOwat bridge. Reachable only through the SSO-protected nginx location.
app.use('/api/sso', requireProxySecret, ssoRouter);

// Everything a native client talks to.
app.use('/api/v1/auth', requireProxySecret, json, authRouter);
app.use('/api/v1/files', requireProxySecret, json, filesRouter);
app.use('/api/v1/trash', requireProxySecret, json, trashRouter);
app.use('/api/v1/sync', requireProxySecret, syncRouter);
app.use('/api/v1/media', requireProxySecret, mediaRouter);

// Upload: JSON on the control endpoints, untouched streams on the chunk PUT
// and the multipart POST.
app.use(
  '/api/v1/upload',
  requireProxySecret,
  (req, res, next) => {
    const raw = req.method === 'PUT' || req.path.endsWith('/simple');
    if (raw) {
      next();
      return;
    }
    json(req, res, next);
  },
  uploadRouter,
);

//=================================================
// Static SPA
//=================================================

if (config.isProd) {
  const spaDir = path.resolve(__dirname, '../../dist');

  app.use(
    express.static(spaDir, {
      index: false,
      // Vite fingerprints asset filenames, so they can be cached hard.
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  // Client-side routing: anything that is not an API call or a hashed asset is
  // the app shell. API paths must keep returning JSON 404s, and a missing
  // asset must 404 rather than resolve to HTML — a stale index.html asking for
  // a build that no longer exists is much easier to diagnose as "404 on
  // index-abc123.js" than as "unexpected token '<'".
  app.get(/^(?!\/api\/|\/assets\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(spaDir, 'index.html'));
  });
}

app.use(notFoundHandler);
app.use(errorHandler);

//=================================================
// Background maintenance
//=================================================

function schedule(label: string, task: () => Promise<void>, intervalMs: number): void {
  const run = () => {
    task().catch((err) => console.error(`[cloud] ${label} failed:`, err));
  };
  run();
  const timer = setInterval(run, intervalMs);
  // Never hold the process open for a maintenance tick.
  timer.unref();
}

schedule('trash purge', trash.purgeExpired, 24 * 3600 * 1000);
schedule('share registry sweep', async () => {
  await shares.prune();
}, 24 * 3600 * 1000);
schedule('stale upload sweep', uploads.purgeStale, 3600 * 1000);
schedule('thumbnail cache sweep', thumbs.sweepCache, 6 * 3600 * 1000);

//=================================================
// Listen
//=================================================

// Loopback only: everything from outside arrives through nginx, which is what
// makes the proxy-secret check meaningful.
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`[cloud] listening on http://127.0.0.1:${config.port}`);
  console.log(`[cloud] mode: ${config.isProd ? 'production' : 'development'}`);
  console.log(`[cloud] data: ${config.storage.dataDir}`);
});

// Uploads and downloads can legitimately idle; the default 5s header timeout
// would kill a slow mobile connection mid-chunk.
server.requestTimeout = 0;
server.headersTimeout = 120_000;
server.keepAliveTimeout = 75_000;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[cloud] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    // Do not let an in-flight 4 GB download hold the restart hostage forever.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

export default app;
