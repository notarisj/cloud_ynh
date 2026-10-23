import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Point the server at a throwaway data directory. Called before anything from
 * src/ is imported, because the configuration is read once, at import time.
 */
export function useScratchDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-test-'));
  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = dir;
  process.env.JWT_SECRET = 'test-secret';
  process.env.ENABLE_THUMBNAILS = 'false';
  process.env.DEV_USER = 'alice';
  return dir;
}
