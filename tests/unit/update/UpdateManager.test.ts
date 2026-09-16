import { EventEmitter } from 'node:events';

jest.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '2.0.0' },
  BrowserWindow: { getAllWindows: () => [] },
}));
jest.mock('electron-updater', () => ({ autoUpdater: {} }));

import { UpdateManager, type AutoUpdaterLike } from '../../../electron/update-manager';

class FakeUpdater extends EventEmitter implements AutoUpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowPrerelease = true;
  allowDowngrade = true;
  checkForUpdates = jest.fn(async () => undefined);
  downloadUpdate = jest.fn(async () => undefined);
  quitAndInstall = jest.fn();
}

describe('UpdateManager', () => {
  it('tracks available, download progress and downloaded states', async () => {
    const updater = new FakeUpdater();
    const states: string[] = [];
    const manager = new UpdateManager({
      updater,
      packaged: true,
      currentVersion: '2.0.0',
      broadcast: (state) => states.push(state.status),
    });

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    const checking = manager.check();
    updater.emit('checking-for-update');
    await checking;
    updater.emit('update-available', {
      version: '2.1.0',
      releaseDate: '2026-09-16T00:00:00.000Z',
      releaseNotes: '修复稳定性问题',
    });
    expect(manager.getState()).toMatchObject({ status: 'available', version: '2.1.0' });

    const downloading = manager.download();
    updater.emit('download-progress', { percent: 42, transferred: 42, total: 100 });
    expect(manager.getState()).toMatchObject({ status: 'downloading', percent: 42 });
    updater.emit('update-downloaded', {
      version: '2.1.0',
      releaseDate: '2026-09-16T00:00:00.000Z',
      releaseNotes: '修复稳定性问题',
    });
    await downloading;
    expect(manager.getState()).toMatchObject({ status: 'downloaded', percent: 100 });
    expect(states).toEqual(expect.arrayContaining(['checking', 'available', 'downloading', 'downloaded']));

    const result = manager.install();
    expect(result.ok).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    manager.dispose();
  });

  it('does not access update servers in development mode', async () => {
    const updater = new FakeUpdater();
    const manager = new UpdateManager({ updater, packaged: false, currentVersion: '2.0.0' });
    const result = await manager.check();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('开发模式');
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    manager.dispose();
  });
});
