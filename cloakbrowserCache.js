'use strict';

import fs from 'fs';
import path from 'path';
import os from 'os';

let _once = null;

export async function ensureAndPruneCloakbrowserCache() {
  if (_once) return _once;

  _once = (async () => {
    const { ensureBinary, binaryInfo, checkForUpdate } = await import('cloakbrowser');

    const cacheDir =
      process.env.CLOAKBROWSER_CACHE_DIR ||
      path.join(os.homedir(), '.cloakbrowser');

    // 1) Ensure current effective binary exists. (May download baseline) 【1-1e546b】
    let exePath = await ensureBinary();

    // 2) Synchronously check/download newer binary if available. 【1-1e546b】
    const updatedTo = await checkForUpdate().catch(() => null);

    // 3) Re-resolve effective binary after update, if any. 【1-1e546b】
    if (updatedTo) {
      exePath = await ensureBinary();
    }

    const info = binaryInfo ? binaryInfo() : null;
    if (info?.version) console.log('[cloakbrowser-cache] effective version:', info.version);
    console.log('[cloakbrowser-cache] effective binary:', exePath);

    // Derive keep dir from the executable path (most reliable)
    const keepDir = path.basename(path.dirname(exePath)); // chromium-<version>
    if (!keepDir.startsWith('chromium-')) {
      console.warn('[cloakbrowser-cache] cannot derive keepDir; skipping prune');
      return info || { path: exePath };
    }

    // 4) Prune all other cached versions
    let removed = 0;
    try {
      const entries = fs.readdirSync(cacheDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (!e.name.startsWith('chromium-')) continue;
        if (e.name === keepDir) continue;

        fs.rmSync(path.join(cacheDir, e.name), { recursive: true, force: true });
        removed += 1;
      }
    } catch (e) {
      console.warn('[cloakbrowser-cache] prune failed:', e?.message || e);
    }

    console.log(`[cloakbrowser-cache] kept ${keepDir}; removed ${removed} old version(s)`);
    return info || { path: exePath };
  })();

  return _once;
}
