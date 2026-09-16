/**
 * 视觉服务 DPI 换算集成测试
 *
 * 覆盖真实缺陷：captureRegion 来自 Electron getBounds()（DIP），而 Win32 截图
 * 使用物理像素。在 125%/150% 缩放的显示器上不换算会截错区域，导致视觉输入错位。
 *
 * 该测试调用 vision/selftest_scale.py，用假 win32 模块捕获传给 BitBlt 的坐标，
 * 断言不同 scaleFactor 下 DIP 被正确换算为物理像素。
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const venvPython = path.resolve(process.cwd(), 'vision', 'venv', 'Scripts', 'python.exe');
const selfTest = path.resolve(process.cwd(), 'vision', 'selftest_scale.py');
const hasVenv = fs.existsSync(venvPython);

jest.setTimeout(60_000);

describe('vision DPI scaling', () => {
  const maybeIt = hasVenv ? it : it.skip;

  maybeIt('converts DIP capture region to physical pixels by scaleFactor', async () => {
    const { stdout } = await execFileAsync(venvPython, [selfTest], { timeout: 50_000 });
    expect(stdout).toContain('DPI 换算自检: 通过');
    // 1.25 倍应把 276,60,800x700 换算为 345,75,1000x875
    expect(stdout).toContain('scaleFactor=1.25');
    expect(stdout).not.toContain('-> FAIL');
  });
});
