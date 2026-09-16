/**
 * Electron 日志转发 Transport
 *
 * 将 winston 日志转发到渲染进程，供 UI 实时显示。
 */
import Transport from 'winston-transport';
import { BrowserWindow } from 'electron';

export interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
  meta: Record<string, unknown>;
}

export interface WinstonLogInfo {
  level: string;
  message: string;
  timestamp?: string;
  [key: string]: unknown;
}

export class ElectronLogTransport extends Transport {
  log(info: WinstonLogInfo, callback: () => void): void {
    setImmediate(() => this.emit('logged', info));

    const { level, message, timestamp, ...rest } = info;
    const entry: LogEntry = {
      level: typeof level === 'string' ? level : String(level),
      message: typeof message === 'string' ? message : JSON.stringify(message),
      timestamp: timestamp ?? new Date().toISOString(),
      meta: rest ?? {},
    };

    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      for (const w of windows) {
        if (!w.isDestroyed()) {
          w.webContents.send('log:stream', entry);
        }
      }
    }

    callback();
  }
}
