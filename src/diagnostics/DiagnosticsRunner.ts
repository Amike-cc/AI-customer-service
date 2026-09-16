import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import type { Config } from '../config/schema';
import type { Database } from '../db/Database';
import type { VisionClient } from '../vision/VisionClient';
import type { AppLogger } from '../logging/logger';
import type { DiagnosticResult, DiagnosticSummary, HealthStatus } from './types';
import { resolveResource, resolveData } from '../paths';

const execFileAsync = promisify(execFile);

export interface DiagnosticsDeps {
  config: Config;
  db: Database;
  visionClient: VisionClient;
  logger: AppLogger;
  getApiKey: () => string;
  getShopCount?: () => number;
  /** 允许测试或便携版覆盖 PaddleOCR 自动下载的模型缓存目录。 */
  getModelCacheDirs?: () => string[];
}

interface ModelDirectoryInfo {
  path: string;
  complete: boolean;
  sizeBytes: number;
}

export class DiagnosticsRunner {
  constructor(private deps: DiagnosticsDeps) {}

  async runAll(): Promise<DiagnosticSummary> {
    this.deps.logger.info('开始运行系统诊断');
    const checks: Array<() => Promise<DiagnosticResult>> = [
      () => this.checkApiKey(),
      () => this.checkPython(),
      () => this.checkVenv(),
      () => this.checkPythonDeps(),
      () => this.checkPaddleOcrModels(),
      () => this.checkPromptTemplate(),
      () => this.checkSensitiveWords(),
      () => this.checkDataDir(),
      () => this.checkPlatformWebUrls(),
      () => this.checkShops(),
      () => this.checkVisionService(),
    ];

    const results: DiagnosticResult[] = [];
    for (const check of checks) {
      try {
        const result = await check();
        results.push(result);
      } catch (err) {
        results.push({
          id: 'unknown',
          name: '未知检查',
          category: 'runtime',
          status: 'fail',
          message: `检查执行异常: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const pass = results.filter((r) => r.status === 'pass').length;
    const warn = results.filter((r) => r.status === 'warn').length;
    const fail = results.filter((r) => r.status === 'fail').length;
    const skip = results.filter((r) => r.status === 'skip').length;
    const healthScore = Math.round((pass / results.length) * 100);

    this.deps.logger.info({ pass, warn, fail, healthScore }, '系统诊断完成');
    return { results, total: results.length, pass, warn, fail, skip, healthScore, runAt: Date.now() };
  }

  healthCheck(): HealthStatus {
    return {
      healthy: true,
      dbConnected: true,
      visionRunning: this.deps.visionClient.isStarted,
      apiKeyConfigured: this.deps.getApiKey().length > 0,
      shopCount: this.deps.getShopCount?.() ?? 0,
      uptimeMs: process.uptime() * 1000,
    };
  }

  private async checkApiKey(): Promise<DiagnosticResult> {
    const id = 'api_key';
    const name = 'DeepSeek API Key';
    const envVar = this.deps.config.security.api_key_env_var;
    const envKey = process.env[envVar];
    const apiKey = this.deps.getApiKey();

    if (apiKey.length > 0) {
      const masked = apiKey.length > 12
        ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`
        : '****';
      return {
        id, name, category: 'config', status: 'pass',
        message: `API Key 已配置 (${masked})`,
        detail: envKey ? `来源: 环境变量 ${envVar}` : '来源: Windows DPAPI 加密存储',
      };
    }

    return {
      id, name, category: 'config', status: 'warn',
      message: 'API Key 未配置',
      detail: `未在 Windows DPAPI 加密存储或环境变量 ${envVar} 中检测到 Key`,
      fixSuggestion: `请在“全局设置 → 系统配置 → 大模型配置”中安全保存 Key，或设置环境变量 ${envVar}`,
    };
  }

  private async checkPython(): Promise<DiagnosticResult> {
    const id = 'python';
    const name = 'Python 环境';
    try {
      const { stdout } = await execFileAsync('python', ['--version'], { timeout: 5000 });
      const version = stdout.trim();
      const match = version.match(/Python (\d+)\.(\d+)\.(\d+)/);
      if (!match) {
        return { id, name, category: 'python', status: 'warn', message: `Python 版本无法解析: ${version}` };
      }
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      if (major < 3 || (major === 3 && minor < 10)) {
        return {
          id, name, category: 'python', status: 'fail',
          message: `Python 版本过低: ${version}，需要 3.10+`,
          fixSuggestion: '请安装 Python 3.10 或更高版本',
        };
      }
      return { id, name, category: 'python', status: 'pass', message: version };
    } catch {
      return {
        id, name, category: 'python', status: 'fail',
        message: 'Python 未安装或不在 PATH 中',
        fixSuggestion: '请从 https://python.org 安装 Python 3.10+ 并添加到 PATH',
      };
    }
  }

  private async checkVenv(): Promise<DiagnosticResult> {
    const id = 'venv';
    const name = 'Python 虚拟环境';
    const venvPython = resolveResource(this.deps.config.vision.python_path);
    const exists = await fs.pathExists(venvPython);
    if (exists) {
      return { id, name, category: 'python', status: 'pass', message: '虚拟环境已创建', detail: venvPython };
    }
    return {
      id, name, category: 'python', status: 'fail',
      message: '虚拟环境不存在',
      detail: `期望路径: ${venvPython}`,
      fixSuggestion: '运行 vision/setup-vision.ps1 创建虚拟环境并安装依赖',
    };
  }

  private async checkPythonDeps(): Promise<DiagnosticResult> {
    const id = 'python_deps';
    const name = 'Python 依赖包';
    const venvPython = resolveResource(this.deps.config.vision.python_path);
    if (!(await fs.pathExists(venvPython))) {
      return { id, name, category: 'python', status: 'skip', message: '虚拟环境未创建，跳过依赖检查' };
    }
    try {
      const { stdout } = await execFileAsync(venvPython, ['-c', 'import cv2, paddleocr, win32gui, numpy; print("ok")'], { timeout: 15000 });
      if (stdout.trim() === 'ok') {
        return { id, name, category: 'python', status: 'pass', message: '所有核心依赖已安装' };
      }
      return { id, name, category: 'python', status: 'warn', message: `依赖检查输出异常: ${stdout.trim()}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        id, name, category: 'python', status: 'fail',
        message: '部分依赖未安装',
        detail: msg,
        fixSuggestion: '运行 vision/setup-vision.ps1 或手动执行 pip install -r vision/requirements.txt',
      };
    }
  }

  private async checkPaddleOcrModels(): Promise<DiagnosticResult> {
    const id = 'paddle_models';
    const name = 'PaddleOCR 模型';
    const cachedModels = await this.findCachedPaddleModels();
    const cachedDet = cachedModels.find((model) => this.isModelKind(model.path, 'det'));
    const cachedRec = cachedModels.find((model) => this.isModelKind(model.path, 'rec'));
    const availableDet = Boolean(cachedDet?.complete);
    const availableRec = Boolean(cachedRec?.complete);
    const coreCount = Number(availableDet) + Number(availableRec);

    const detailLines: string[] = [];
    if (cachedModels.length > 0) {
      detailLines.push(`正在使用的自动下载缓存（${cachedModels.length} 个）：`);
      for (const model of cachedModels) {
        detailLines.push(`  ${this.formatModelDirectory(path.basename(model.path), model)}`);
      }
    } else {
      detailLines.push('自动下载缓存：未发现');
    }

    if (availableDet && availableRec) {
      return {
        id,
        name,
        category: 'models',
        status: 'pass',
        message: `核心模型完整（检测、识别），共发现 ${cachedModels.length} 个自动缓存模型`,
        detail: detailLines.join('\n'),
      };
    }
    return {
      id, name, category: 'models', status: 'warn',
      message: `PaddleOCR 核心模型不完整（${coreCount}/2）`,
      detail: detailLines.join('\n'),
      fixSuggestion: '首次启动视觉服务时 PaddleOCR 会自动下载标准模型，需要网络连接',
    };
  }

  private getPaddleModelCacheRoots(): string[] {
    const overridden = this.deps.getModelCacheDirs?.();
    if (overridden) return overridden;
    const homeDir = os.homedir();
    return [
      path.join(homeDir, '.paddlex', 'official_models'),
      path.join(homeDir, '.paddleocr', 'whl'),
      path.join(homeDir, '.cache', 'paddleocr'),
    ];
  }

  private async findCachedPaddleModels(): Promise<ModelDirectoryInfo[]> {
    const directories = new Set<string>();
    for (const root of this.getPaddleModelCacheRoots()) {
      await this.collectModelDirectories(root, directories, 0, 4);
    }

    const inspected = await Promise.all(
      Array.from(directories).map((directory) => this.inspectModelDirectory(directory)),
    );
    return inspected
      .filter((model) => model.complete)
      .sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));
  }

  private async collectModelDirectories(
    directory: string,
    output: Set<string>,
    depth: number,
    maxDepth: number,
  ): Promise<void> {
    if (depth > maxDepth || !(await fs.pathExists(directory))) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    if (this.hasModelArtifacts(fileNames)) output.add(directory);
    if (depth === maxDepth) return;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await this.collectModelDirectories(path.join(directory, entry.name), output, depth + 1, maxDepth);
      }
    }
  }

  private async inspectModelDirectory(directory: string): Promise<ModelDirectoryInfo> {
    if (!(await fs.pathExists(directory))) return { path: directory, complete: false, sizeBytes: 0 };
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return { path: directory, complete: false, sizeBytes: 0 };
    }
    const files = entries.filter((entry) => entry.isFile());
    let sizeBytes = 0;
    for (const file of files) {
      try {
        sizeBytes += (await fs.stat(path.join(directory, file.name))).size;
      } catch {
        // 单个附属文件无法读取时仍继续检查其余模型文件。
      }
    }
    return {
      path: directory,
      complete: this.hasModelArtifacts(files.map((file) => file.name)),
      sizeBytes,
    };
  }

  private hasModelArtifacts(fileNames: string[]): boolean {
    const normalized = fileNames.map((file) => file.toLowerCase());
    const hasWeights = normalized.some((file) =>
      file.endsWith('.pdiparams') || file.endsWith('.onnx') || file.endsWith('.nb'));
    const hasDescriptor = normalized.some((file) =>
      file.endsWith('.pdmodel') || file.endsWith('.json') || file.endsWith('.yml') || file.endsWith('.yaml'));
    return hasWeights && hasDescriptor;
  }

  private isModelKind(directory: string, kind: 'det' | 'rec'): boolean {
    const name = path.basename(directory).toLowerCase();
    return kind === 'det'
      ? /(?:ocr|text).*det|det.*(?:ocr|text)/.test(name)
      : /(?:ocr|text).*rec|rec.*(?:ocr|text)/.test(name);
  }

  private formatModelDirectory(label: string, model: ModelDirectoryInfo): string {
    const state = model.complete ? '完整' : model.sizeBytes > 0 ? '不完整' : '缺失';
    const size = model.sizeBytes > 0 ? `，${this.formatBytes(model.sizeBytes)}` : '';
    return `${label}: ${state}${size} · ${model.path}`;
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  private async checkPromptTemplate(): Promise<DiagnosticResult> {
    const id = 'prompt_template';
    const name = 'Prompt 模板';
    const promptPath = resolveResource(this.deps.config.deepseek.prompt_template);
    if (await fs.pathExists(promptPath)) {
      const stat = await fs.stat(promptPath);
      if (stat.size > 0) {
        return { id, name, category: 'files', status: 'pass', message: 'Prompt 模板存在且有内容' };
      }
      return { id, name, category: 'files', status: 'warn', message: 'Prompt 模板文件为空' };
    }
    return {
      id, name, category: 'files', status: 'fail',
      message: 'Prompt 模板文件不存在',
      detail: `期望路径: ${promptPath}`,
      fixSuggestion: '创建 config/prompt/customer-service.md 客服提示词模板',
    };
  }

  private async checkSensitiveWords(): Promise<DiagnosticResult> {
    const id = 'sensitive_words';
    const name = '敏感词词典';
    const dictPath = resolveResource(this.deps.config.deepseek.sensitive_words_dict);
    if (await fs.pathExists(dictPath)) {
      const content = await fs.readFile(dictPath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
      return {
        id, name, category: 'files', status: 'pass',
        message: `敏感词词典存在，${lines.length} 个词条`,
      };
    }
    return {
      id, name, category: 'files', status: 'fail',
      message: '敏感词词典不存在',
      detail: `期望路径: ${dictPath}`,
      fixSuggestion: '创建 config/dict/sensitive-words.txt 敏感词词典文件',
    };
  }

  private async checkDataDir(): Promise<DiagnosticResult> {
    const id = 'data_dir';
    const name = '数据目录';
    const dataDir = resolveData(this.deps.config.app.data_dir);
    try {
      await fs.ensureDir(dataDir);
      const testFile = path.join(dataDir, '.write_test');
      await fs.writeFile(testFile, 'ok');
      await fs.remove(testFile);
      return { id, name, category: 'files', status: 'pass', message: '数据目录可读写', detail: dataDir };
    } catch (err) {
      return {
        id, name, category: 'files', status: 'fail',
        message: '数据目录不可写',
        detail: `${dataDir}: ${err instanceof Error ? err.message : String(err)}`,
        fixSuggestion: '检查数据目录权限或修改 config 中的 data_dir',
      };
    }
  }

  private async checkPlatformWebUrls(): Promise<DiagnosticResult> {
    const id = 'platform_web_urls';
    const name = '平台网页版地址';
    const platforms = this.deps.config.platforms;
    if (!platforms || Object.keys(platforms).length === 0) {
      return {
        id, name, category: 'config', status: 'fail',
        message: '平台网页版地址未配置',
        fixSuggestion: '请在 config/production.yaml 中设置 platforms 配置',
      };
    }
    const results: string[] = [];
    for (const [key, cfg] of Object.entries(platforms)) {
      const webUrl = (cfg as { web_url?: string }).web_url;
      if (webUrl) {
        try {
          new URL(webUrl);
          results.push(`${key}: ${webUrl}`);
        } catch {
          results.push(`${key}: 格式无效`);
        }
      }
    }
    return {
      id, name, category: 'config', status: 'pass',
      message: `${results.length} 个平台地址已配置`,
      detail: results.join(', '),
    };
  }

  private async checkShops(): Promise<DiagnosticResult> {
    const id = 'shops';
    const name = '已注册店铺';
    try {
      const shops = this.deps.db.shops.list();
      if (shops.length > 0) {
        return {
          id, name, category: 'runtime', status: 'pass',
          message: `已注册 ${shops.length} 个店铺`,
          detail: shops.map((s) => s.shopName).join(', '),
        };
      }
      return {
        id, name, category: 'runtime', status: 'warn',
        message: '未注册任何店铺',
        fixSuggestion: '请在软件左侧"店铺管理"中点击"添加店铺"按钮添加客服店铺账号',
      };
    } catch (err) {
      return {
        id, name, category: 'runtime', status: 'fail',
        message: '查询店铺列表失败',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async checkVisionService(): Promise<DiagnosticResult> {
    const id = 'vision_service';
    const name = '视觉服务状态';
    if (!this.deps.config.vision.enabled) {
      return { id, name, category: 'runtime', status: 'skip', message: '视觉服务未启用' };
    }
    if (this.deps.visionClient.isStarted) {
      return { id, name, category: 'runtime', status: 'pass', message: '视觉服务已启动' };
    }
    return {
      id, name, category: 'runtime', status: 'warn',
      message: '视觉服务未启动',
      fixSuggestion: '检查 Python venv 和依赖是否安装，运行 vision/setup-vision.ps1',
    };
  }
}
