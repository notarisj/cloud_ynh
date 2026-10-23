import { assertProductionConfig, config, ensureStorageLayout } from './config';
import { createApp } from './app';
import * as trash from './services/trash';
import * as uploads from './services/uploads';
import * as thumbs from './services/thumbs';
import * as shares from './services/shares';

assertProductionConfig();
ensureStorageLayout();

const app = createApp();

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
