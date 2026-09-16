import path from 'path';
import { ConfigLoader } from '@/config/ConfigLoader';
import fs from 'fs-extra';
import os from 'os';

describe('ConfigLoader', () => {
  it('loads production array overrides and keeps night throttling disabled', async () => {
    const config = await ConfigLoader.load(path.resolve('config'));

    expect(config.ratelimit.enabled).toBe(false);
    expect(config.ratelimit.night_factor).toBe(1);
    expect(config.ratelimit.night_hours).toEqual([0, 0]);
    expect(config.ratelimit.per_shop_per_minute).toBe(8);
  });

  it('配置无效时抛出异常而不是终止进程', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-loader-'));
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await fs.writeFile(path.join(dir, 'default.yaml'), 'app: {}\n', 'utf8');
      await expect(ConfigLoader.load(dir)).rejects.toThrow('配置校验失败');
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      fs.removeSync(dir);
    }
  });
});
