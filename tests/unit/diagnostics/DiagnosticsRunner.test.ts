import { DiagnosticsRunner } from '@/diagnostics/DiagnosticsRunner';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { createTestConfig } from '../helpers/testConfig';

describe('DiagnosticsRunner API Key 状态', () => {
  it('未配置 Key 时给出安全的 UI/环境变量指引，并能反映热更新', async () => {
    let apiKey = '';
    const runner = new DiagnosticsRunner({
      config: createTestConfig(),
      db: {} as never,
      visionClient: { isStarted: true } as never,
      logger: { info: jest.fn() } as never,
      getApiKey: () => apiKey,
      getShopCount: () => 0,
    });

    const missing = await (runner as any).checkApiKey();
    expect(missing.status).toBe('warn');
    expect(missing.fixSuggestion).toContain('全局设置');
    expect(missing.fixSuggestion).not.toContain('.env 文件');
    expect(runner.healthCheck().apiKeyConfigured).toBe(false);

    apiKey = 'sk-1234567890abcdef';
    const configured = await (runner as any).checkApiKey();
    expect(configured.status).toBe('pass');
    expect(runner.healthCheck().apiKeyConfigured).toBe(true);
  });

  it('动态读取当前店铺数量，而不是保存初始化快照', () => {
    let shopCount = 0;
    const runner = new DiagnosticsRunner({
      config: createTestConfig(),
      db: {} as never,
      visionClient: { isStarted: true } as never,
      logger: { info: jest.fn() } as never,
      getApiKey: () => '',
      getShopCount: () => shopCount,
    });

    expect(runner.healthCheck().shopCount).toBe(0);
    shopCount = 4;
    expect(runner.healthCheck().shopCount).toBe(4);
  });
});

describe('DiagnosticsRunner 模型文件检查', () => {
  let tempDir = '';

  afterEach(async () => {
    if (tempDir) await fs.remove(tempDir);
  });

  it('显示 PaddleOCR 自动缓存中的全部模型并以检测、识别核心模型判断完整性', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aikefu-model-diagnostics-'));
    const cacheDir = path.join(tempDir, 'official_models');
    const modelNames = [
      'PP-LCNet_x1_0_doc_ori',
      'PP-OCRv6_medium_det',
      'PP-OCRv6_medium_rec',
      'UVDoc',
    ];
    for (const modelName of modelNames) {
      const modelDir = path.join(cacheDir, modelName);
      await fs.ensureDir(modelDir);
      await fs.writeFile(path.join(modelDir, 'inference.json'), '{}');
      await fs.writeFile(path.join(modelDir, 'inference.pdiparams'), 'weights');
    }

    const runner = new DiagnosticsRunner({
      config: createTestConfig(),
      db: {} as never,
      visionClient: { isStarted: true } as never,
      logger: { info: jest.fn() } as never,
      getApiKey: () => '',
      getModelCacheDirs: () => [cacheDir],
    });

    const result = await (runner as any).checkPaddleOcrModels();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('4 个自动缓存模型');
    for (const modelName of modelNames) expect(result.detail).toContain(modelName);
    expect(result.detail).toContain('\n');
  });

  it('自动缓存只有检测模型而没有识别模型时报告核心模型不完整', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aikefu-model-incomplete-'));
    const cacheDir = path.join(tempDir, 'official_models');
    const detDir = path.join(cacheDir, 'PP-OCRv6_medium_det');
    await fs.ensureDir(detDir);
    await fs.writeFile(path.join(detDir, 'inference.json'), '{}');
    await fs.writeFile(path.join(detDir, 'inference.pdiparams'), 'weights');

    const runner = new DiagnosticsRunner({
      config: createTestConfig(),
      db: {} as never,
      visionClient: { isStarted: false } as never,
      logger: { info: jest.fn() } as never,
      getApiKey: () => '',
      getModelCacheDirs: () => [cacheDir],
    });

    const result = await (runner as any).checkPaddleOcrModels();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('1/2');
    expect(result.detail).toContain('PP-OCRv6_medium_det');
  });

});
