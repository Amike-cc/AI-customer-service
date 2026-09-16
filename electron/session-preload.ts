import type { Session } from 'electron';

type SessionWithLegacyPreloads = Session & {
  getPreloads?: () => string[];
  setPreloads?: (preloads: string[]) => void;
};

const LEGACY_PREFIX = 'legacy:';

/**
 * Register a frame preload on Electron 35+.
 *
 * Electron 30 does not expose registerPreloadScript. Its setPreloads API is a
 * compatible fallback for the fingerprint script: the script is idempotent and
 * is loaded before page scripts in the isolated preload world.
 */
export function registerFramePreload(ses: Session, filePath: string): string {
  const modern = ses as Session & {
    registerPreloadScript?: (registration: {
      type: 'frame';
      filePath: string;
    }) => string;
  };

  if (typeof modern.registerPreloadScript === 'function') {
    return modern.registerPreloadScript({ type: 'frame', filePath });
  }

  const legacy = ses as SessionWithLegacyPreloads;
  if (typeof legacy.getPreloads === 'function' && typeof legacy.setPreloads === 'function') {
    const preloads = legacy.getPreloads();
    if (!preloads.includes(filePath)) {
      legacy.setPreloads([...preloads, filePath]);
    }
    return `${LEGACY_PREFIX}${filePath}`;
  }

  throw new Error('当前 Electron 版本不支持注册 preload 脚本');
}

export function unregisterFramePreload(
  ses: Session,
  registrationId: string | undefined,
  filePath?: string,
): void {
  if (!registrationId) {
    return;
  }

  if (registrationId.startsWith(LEGACY_PREFIX)) {
    const legacy = ses as SessionWithLegacyPreloads;
    if (filePath && typeof legacy.getPreloads === 'function' && typeof legacy.setPreloads === 'function') {
      legacy.setPreloads(legacy.getPreloads().filter((item) => item !== filePath));
    }
    return;
  }

  const modern = ses as Session & {
    unregisterPreloadScript?: (id: string) => void;
  };
  if (typeof modern.unregisterPreloadScript === 'function') {
    modern.unregisterPreloadScript(registrationId);
  }
}
