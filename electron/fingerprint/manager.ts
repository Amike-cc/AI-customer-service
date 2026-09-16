import path from 'path';
import fs from 'fs';
import type { ShopFingerprint } from './types';
import { generateFingerprint } from './generator';
import { PRELOAD_TEMPLATE } from './preload-template-content';
import { resolveData } from '../../src/paths';

// 指纹数据可写，必须放在 userData 而非安装目录（DATA-PATH-001）
const FINGERPRINT_DIR = resolveData(undefined, 'data', 'electron', 'fingerprints');

function getFingerprintPath(shopId: string): string {
  return path.join(FINGERPRINT_DIR, `shop_${shopId}.json`);
}

function getPreloadPath(shopId: string): string {
  return path.join(FINGERPRINT_DIR, `shop_${shopId}_preload.js`);
}

export class FingerprintManager {
  private static ensureDir(): void {
    if (!fs.existsSync(FINGERPRINT_DIR)) {
      fs.mkdirSync(FINGERPRINT_DIR, { recursive: true });
    }
  }

  static getOrCreateFingerprint(shopId: string): ShopFingerprint {
    this.ensureDir();
    const fpPath = getFingerprintPath(shopId);

    if (fs.existsSync(fpPath)) {
      try {
        const data = fs.readFileSync(fpPath, 'utf-8');
        const fp = JSON.parse(data) as ShopFingerprint;
        if (fp.shopId === shopId) return fp;
      } catch {}
    }

    const fp = generateFingerprint(shopId);
    fs.writeFileSync(fpPath, JSON.stringify(fp, null, 2), 'utf-8');
    return fp;
  }

  static preparePreloadScript(shopId: string, fp: ShopFingerprint): string {
    this.ensureDir();
    const preloadPath = getPreloadPath(shopId);

    const fpJson = JSON.stringify(fp);
    const script = PRELOAD_TEMPLATE.replace('__FINGERPRINT_DATA__', fpJson);

    fs.writeFileSync(preloadPath, script, 'utf-8');
    return preloadPath;
  }

  static getPreloadPath(shopId: string): string {
    return getPreloadPath(shopId);
  }

  static removeFingerprint(shopId: string): void {
    const fpPath = getFingerprintPath(shopId);
    const preloadPath = getPreloadPath(shopId);
    try { if (fs.existsSync(fpPath)) fs.unlinkSync(fpPath); } catch {}
    try { if (fs.existsSync(preloadPath)) fs.unlinkSync(preloadPath); } catch {}
  }
}
