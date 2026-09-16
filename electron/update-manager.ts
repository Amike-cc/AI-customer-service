import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateInfo, ProgressInfo } from 'builder-util-runtime';
import type { UpdateDownloadedEvent } from 'electron-updater/out/types';
import type { UpdateActionResult, UpdateState } from '../shared/update-types';

type UpdateEvent =
  | 'checking-for-update'
  | 'update-available'
  | 'update-not-available'
  | 'download-progress'
  | 'update-downloaded'
  | 'error';

export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  on(event: UpdateEvent, listener: (...args: never[]) => void): AutoUpdaterLike;
  removeListener(event: UpdateEvent, listener: (...args: never[]) => void): AutoUpdaterLike;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateManagerOptions {
  updater?: AutoUpdaterLike;
  packaged?: boolean;
  currentVersion?: string;
  broadcast?: (state: UpdateState) => void;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

const defaultUpdater = autoUpdater as unknown as AutoUpdaterLike;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function releaseNotesToText(notes: unknown): string | undefined {
  if (typeof notes === 'string') return notes.trim() || undefined;
  if (!Array.isArray(notes)) return undefined;
  const text = notes
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const value = item as { note?: unknown; version?: unknown };
      const note = typeof value.note === 'string' ? value.note.trim() : '';
      const version = typeof value.version === 'string' ? value.version.trim() : '';
      return version && note ? `v${version}\n${note}` : note;
    })
    .filter(Boolean)
    .join('\n\n');
  return text || undefined;
}

export class UpdateManager {
  private readonly updater: AutoUpdaterLike;
  private readonly packaged: boolean;
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly broadcast: (state: UpdateState) => void;
  private state: UpdateState;
  private busy = false;
  private listeners: Array<{ event: UpdateEvent; listener: (...args: never[]) => void }> = [];

  constructor(options: UpdateManagerOptions = {}) {
    this.updater = options.updater ?? defaultUpdater;
    this.packaged = options.packaged ?? app.isPackaged;
    this.logger = options.logger ?? console;
    this.broadcast =
      options.broadcast ??
      ((state) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send('app:update:state', state);
        }
      });
    this.state = {
      status: 'idle',
      currentVersion: options.currentVersion ?? app.getVersion(),
    };
    this.configure();
  }

  private configure(): void {
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = true;
    this.updater.allowPrerelease = false;
    this.updater.allowDowngrade = false;

    this.listen('checking-for-update', () => this.setState({ status: 'checking', error: undefined }));
    this.listen('update-available', (info: UpdateInfo) => {
      this.setState({
        status: 'available',
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: releaseNotesToText(info.releaseNotes),
        percent: 0,
        error: undefined,
      });
    });
    this.listen('update-not-available', () => {
      this.setState({ status: 'not-available', version: undefined, error: undefined });
    });
    this.listen('download-progress', (progress: ProgressInfo) => {
      this.setState({
        status: 'downloading',
        percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
        transferred: progress.transferred,
        total: progress.total,
        error: undefined,
      });
    });
    this.listen('update-downloaded', (event: UpdateDownloadedEvent) => {
      this.setState({
        status: 'downloaded',
        version: event.version,
        releaseDate: event.releaseDate,
        releaseNotes: releaseNotesToText(event.releaseNotes),
        percent: 100,
        error: undefined,
      });
    });
    this.listen('error', (error: Error) => {
      const message = errorMessage(error);
      this.logger.error('自动更新失败', message);
      this.setState({ status: 'error', error: message });
    });
  }

  private listen(event: UpdateEvent, listener: (...args: never[]) => void): void {
    this.updater.on(event, listener);
    this.listeners.push({ event, listener });
  }

  private setState(patch: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, ...patch, currentVersion: this.state.currentVersion, checkedAt: Date.now() };
    this.broadcast(this.state);
    return this.state;
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  async check(): Promise<UpdateActionResult> {
    if (!this.packaged) {
      const state = this.setState({ status: 'not-available', error: '开发模式不会检查更新，请使用打包版本' });
      return { ok: false, state, error: state.error };
    }
    if (this.busy) return { ok: false, state: this.getState(), error: '更新操作正在进行中' };
    this.busy = true;
    try {
      await this.updater.checkForUpdates();
      return { ok: true, state: this.getState() };
    } catch (error) {
      const message = errorMessage(error);
      const state = this.setState({ status: 'error', error: message });
      return { ok: false, state, error: message };
    } finally {
      this.busy = false;
    }
  }

  async download(): Promise<UpdateActionResult> {
    if (!this.packaged) return this.devModeResult();
    if (this.state.status !== 'available') {
      return { ok: false, state: this.getState(), error: '当前没有可下载的更新' };
    }
    if (this.busy) return { ok: false, state: this.getState(), error: '更新操作正在进行中' };
    this.busy = true;
    try {
      this.setState({ status: 'downloading', percent: 0, error: undefined });
      await this.updater.downloadUpdate();
      return { ok: true, state: this.getState() };
    } catch (error) {
      const message = errorMessage(error);
      const state = this.setState({ status: 'error', error: message });
      return { ok: false, state, error: message };
    } finally {
      this.busy = false;
    }
  }

  install(): UpdateActionResult {
    if (!this.packaged) return this.devModeResult();
    if (this.state.status !== 'downloaded') {
      return { ok: false, state: this.getState(), error: '更新尚未下载完成' };
    }
    this.updater.quitAndInstall(false, true);
    return { ok: true, state: this.getState() };
  }

  private devModeResult(): UpdateActionResult {
    const state = this.setState({ status: 'not-available', error: '开发模式不会检查更新，请使用打包版本' });
    return { ok: false, state, error: state.error };
  }

  dispose(): void {
    for (const { event, listener } of this.listeners) this.updater.removeListener(event, listener);
    this.listeners = [];
  }
}
