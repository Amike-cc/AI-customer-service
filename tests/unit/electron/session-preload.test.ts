import type { Session } from 'electron';
import {
  registerFramePreload,
  unregisterFramePreload,
} from '../../../electron/session-preload';

describe('session preload compatibility', () => {
  it('uses registerPreloadScript when available', () => {
    const registerPreloadScript = jest.fn().mockReturnValue('modern-id');
    const ses = { registerPreloadScript } as unknown as Session;

    expect(registerFramePreload(ses, 'C:/fingerprint.js')).toBe('modern-id');
    expect(registerPreloadScript).toHaveBeenCalledWith({
      type: 'frame',
      filePath: 'C:/fingerprint.js',
    });
  });

  it('falls back to setPreloads without duplicating the script', () => {
    const setPreloads = jest.fn();
    const ses = {
      getPreloads: jest.fn().mockReturnValue(['C:/existing.js']),
      setPreloads,
    } as unknown as Session;

    expect(registerFramePreload(ses, 'C:/fingerprint.js')).toBe(
      'legacy:C:/fingerprint.js',
    );
    expect(setPreloads).toHaveBeenCalledWith([
      'C:/existing.js',
      'C:/fingerprint.js',
    ]);
  });

  it('removes a legacy preload on cleanup', () => {
    const setPreloads = jest.fn();
    const ses = {
      getPreloads: jest
        .fn()
        .mockReturnValue(['C:/fingerprint.js', 'C:/other.js']),
      setPreloads,
    } as unknown as Session;

    unregisterFramePreload(
      ses,
      'legacy:C:/fingerprint.js',
      'C:/fingerprint.js',
    );

    expect(setPreloads).toHaveBeenCalledWith(['C:/other.js']);
  });
});
