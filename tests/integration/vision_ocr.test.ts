/**
 * 视觉 OCR 真实识别集成测试
 *
 * 目的：覆盖 VISION_PROTOCOL_TEST 之外的**真实 OCR 推理路径**。
 * 之前的协议测试返回预制空响应，完全不经过 OCR，因此漏掉了
 * "结果解析与 PaddleOCR 3.x 的 OCRResult 不兼容"这一缺陷——视觉兜底
 * 实际上识别不出任何消息，却显示为通过。
 *
 * 该测试调用 vision/selfcheck.py，在合成截图上断言能识别出预期的
 * 买家/卖家文本，并完成左右分类。需要 vision/venv 已安装依赖。
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const venvPython = path.resolve(process.cwd(), 'vision', 'venv', 'Scripts', 'python.exe');
const selfcheck = path.resolve(process.cwd(), 'vision', 'selfcheck.py');
const hasVenv = fs.existsSync(venvPython);

// Windows 上 OCR 冷启动（加载 PaddleOCR 模型）需要较长时间
jest.setTimeout(240_000);

describe('vision service real OCR', () => {
  const maybeIt = hasVenv ? it : it.skip;

  maybeIt('recognizes buyer/seller text from a synthetic screenshot', async () => {
    const { stdout } = await execFileAsync(venvPython, [selfcheck, '--json'], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 200_000,
    });

    // selfcheck 的 JSON 结果可能混在日志之后，取最后一行 JSON
    const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '{}';
    const result = JSON.parse(lastLine) as {
      ok: boolean;
      buyerTexts: string[];
      sellerTexts: string[];
    };

    expect(result.ok).toBe(true);
    expect(result.buyerTexts.length).toBeGreaterThan(0);
    expect(result.sellerTexts.length).toBeGreaterThan(0);
    // 买家消息应识别出左侧内容，卖家消息应识别出右侧内容
    expect(result.buyerTexts.join('')).toContain('你好');
    expect(result.sellerTexts.join('')).toContain('明天发出');
  });
});
