/**
 * Electron 主进程入口
 *
 * 职责：
 * 1. 初始化后端业务逻辑（createBackend + ElectronLogTransport）
 * 2. 注入 WebviewManager 管理多账号 WebContentsView
 * 3. 注册 IPC 处理器
 * 4. 创建 BrowserWindow 并加载渲染进程
 * 5. 从数据库加载已注册店铺并启动监控
 * 6. 优雅关闭处理
 */
import { app, BrowserWindow, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { createBackend, type Backend } from '../src/backend';
import { configurePaths } from '../src/paths';
import { registerIpcHandlers } from './ipc-handlers';
import type { LogEntry } from './ipc-handlers';
import { ElectronLogTransport, type WinstonLogInfo } from './log-transport';
import { WebviewManager } from './webview-manager';
import type { StateName } from '../src/state/ShopStateMachine';
import type winston from 'winston';
import { UpdateManager } from './update-manager';

function diagLog(msg: string): void {
  const diagPath = path.join(app.getPath('userData'), 'diagnostics.log');
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(diagPath, line, 'utf-8');
  } catch {
    // ignore
  }
}

let backend: Backend | null = null;
let webviewManager: WebviewManager | null = null;
let mainWindow: BrowserWindow | null = null;
let updateManager: UpdateManager | null = null;

const LOG_BUFFER_CAPACITY = 500;
const logBuffer: LogEntry[] = [];

class BufferedLogTransport extends ElectronLogTransport {
  log(info: WinstonLogInfo, callback: () => void): void {
    const { level, message, timestamp, ...rest } = info;
    const entry: LogEntry = {
      level: typeof level === 'string' ? level : String(level),
      message: typeof message === 'string' ? message : JSON.stringify(message),
      timestamp: timestamp ?? new Date().toISOString(),
      meta: rest ?? {},
    };
    logBuffer.push(entry);
    while (logBuffer.length > LOG_BUFFER_CAPACITY) {
      logBuffer.shift();
    }
    super.log(info, callback);
  }
}

const logTransport = new BufferedLogTransport();

function broadcastStateChange(shopId: string, state: StateName): void {
  const payload = { shopId, state };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send('shop:stateChanged', payload);
    }
  }
}

// 资源根目录：打包后为 app.getAppPath()（含 config/），开发时为项目根。
// 不用 process.cwd()，避免从开始菜单/桌面快捷方式启动时找不到配置（DATA-PATH-001）。
const isPackaged = app.isPackaged;
const resourceDir = isPackaged ? app.getAppPath() : process.cwd();
// 可写数据目录：打包后使用系统 userData（不与安装目录混用），开发时保持项目内路径
const writableDataDir = isPackaged
  ? path.join(app.getPath('userData'), 'data')
  : path.join(resourceDir, 'data', 'electron');
// 在 app.whenReady() 之前设置路径，避免 Electron 访问受限的 AppData 目录
app.setPath('userData', isPackaged ? app.getPath('userData') : writableDataDir);
app.setPath('crashDumps', path.join(writableDataDir, 'crashes'));
configurePaths({ resourceDir, dataDir: writableDataDir });
// 注意：不能调用 app.disableHardwareAcceleration()，否则 WebContentsView 无法通过 GPU 合成渲染到窗口

async function bootstrap(): Promise<void> {
  diagLog('bootstrap 开始');

  // 环境变量预校验
  const configDir = path.join(resourceDir, 'config');
  const requiredFiles = [
    { file: path.join(configDir, 'default.yaml'), label: '默认配置文件' },
    { file: path.join(configDir, 'prompt', 'customer-service.md'), label: 'Prompt 模板' },
    { file: path.join(configDir, 'dict', 'sensitive-words.txt'), label: '敏感词库' },
  ];
  const missingFiles: string[] = [];
  for (const { file, label } of requiredFiles) {
    if (!fs.existsSync(file)) {
      missingFiles.push(`${label} (${file})`);
    }
  }
  if (missingFiles.length > 0) {
    const msg = `环境校验失败，缺少以下文件:\n${missingFiles.join('\n')}`;
    diagLog(msg);
    console.error(msg);
    return;
  }
  diagLog('环境校验通过');

  webviewManager = new WebviewManager();
  diagLog('WebviewManager 已创建');
  try {
    diagLog('开始调用 createBackend...');
    backend = await createBackend({
      extraTransports: [logTransport as unknown as winston.transport],
      webviewManager,
      onStateChange: broadcastStateChange,
      resourceDir,
      dataDir: writableDataDir,
    });
    diagLog('createBackend 成功');
  } catch (err) {
    const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    diagLog(`createBackend 失败: ${errMsg}`);
    console.error('后端初始化失败:', err);
  }

  diagLog(`backend 是否为 null: ${backend === null}`);
  createWindow();
  diagLog('createWindow 完成');
  updateManager = new UpdateManager();
  diagLog('更新服务已初始化');

  if (backend) {
    diagLog('开始注册 IPC 处理器');
    // 注入 logger 到 WebviewManager，使其能记录登录检测和自动恢复日志
    webviewManager.setLogger(backend.logger);
    registerIpcHandlers(backend, logBuffer, updateManager);
    diagLog('IPC 处理器已注册');
    if (app.isPackaged) {
      setTimeout(() => {
        void updateManager?.check();
      }, 10_000);
    }
    void startShops(backend);
    // per-shop keepalive 已在 ensureView() 中启动，无需全量 reload
    // 全量 reload 会打断正在进行的客服对话，已移除
  } else {
    diagLog('backend 为 null，跳过 IPC 注册和店铺启动');
  }
}

async function startShops(bk: Backend): Promise<void> {
  const shops = bk.db.shops.list();
  if (shops.length === 0) {
    bk.logger.info({ shopCount: 0 }, '系统启动完成（无店铺）');
    return;
  }

  const startTime = Date.now();
  bk.logger.info({ shopCount: shops.length }, '开始并行启动店铺');

  // 限制并发数，避免资源争抢
  const CONCURRENCY = 5;
  const results: PromiseSettledResult<void>[] = [];

  for (let i = 0; i < shops.length; i += CONCURRENCY) {
    const batch = shops.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (shopConfig) => {
        await bk.supervisor.startShop(shopConfig);
        bk.logger.info(
          { shopId: shopConfig.shopId, shopName: shopConfig.shopName, autoReply: shopConfig.autoReply },
          '店铺已启动监控',
        );
      }),
    );
    results.push(...batchResults);
  }

  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    failed.forEach((r) => {
      const err = (r as PromiseRejectedResult).reason;
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? err.stack : undefined;
      bk.logger.error({ err: errMsg, stack: errStack, fullErr: err }, '店铺启动监控失败');
    });
  }

  const elapsed = Date.now() - startTime;
  bk.logger.info(
    { shopCount: bk.supervisor.shopCount, failed: failed.length, elapsedMs: elapsed },
    '系统启动完成',
  );

  // 所有店铺默认进入后台模式（DOM click），等用户在 UI 中选择活跃店铺后切换为前台模式（humanClick）
  bk.supervisor.setActiveShop(null);
  bk.logger.info('所有店铺已进入后台模式，等待用户选择活跃店铺');

  }

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 700,
    title: '飞鸽AI客服',
    // 与 renderer 默认浅色主题一致，避免冷启动先闪出深色背景。
    backgroundColor: '#f3f5fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  webviewManager?.attachToWindow(mainWindow);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 仅放行 https + 平台域名白名单，其余一律拒绝（拦截 file:/mailto:/自定义协议与钓鱼站点）
    const allowedHosts = ['jinritemai.com', 'pinduoduo.com', 'kuaishou.com', 'weixin.qq.com', 'qq.com'];
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') {
        const host = parsed.hostname.toLowerCase();
        if (allowedHosts.some((d) => host === d || host.endsWith('.' + d))) {
          void shell.openExternal(parsed.toString());
        }
      }
    } catch {
      // 忽略无法解析的 URL
    }
    return { action: 'deny' };
  });

  void mainWindow.loadFile(path.join(__dirname, '../../dist/renderer/index.html'));
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

void app.whenReady().then(() => {
  void bootstrap();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  void shutdown();
});

async function shutdown(): Promise<void> {
  updateManager?.dispose();
  updateManager = null;
  webviewManager?.destroyAll();
  if (backend) {
    try {
      await backend.shutdown();
    } catch (err) {
      backend.logger.error({ err }, '关闭失败');
    }
  }
  app.quit();
}

// 防止多个实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
