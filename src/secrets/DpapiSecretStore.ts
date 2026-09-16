/**
 * DPAPI 密钥存储
 * 详见 docs/17-数据持久化与配置管理.md §17.8
 */
import fs from 'fs-extra';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Config } from '../config/schema';

const execFileAsync = promisify(execFile);

export class DpapiSecretStore {
  private secretsDir: string;
  private cache = new Map<string, string>();

  constructor(private config: Config) {
    this.secretsDir = path.join(config.app.data_dir, 'secrets');
  }

  async set(key: string, value: string): Promise<void> {
    this.assertValidKey(key);
    const encrypted = await this.dpapiProtect(value, 'CurrentUser');
    await fs.ensureDir(this.secretsDir);
    // 原子写入：先写临时文件再 rename，避免崩溃产生半写文件
    const target = this.path(key);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, encrypted, 'utf8');
    await fs.rename(tmp, target);
    await this.restrictFileAcl(target);
    this.cache.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    this.assertValidKey(key);
    if (this.cache.has(key)) return this.cache.get(key)!;
    const filePath = this.path(key);
    if (!(await fs.pathExists(filePath))) return null;

    const encrypted = await fs.readFile(filePath, 'utf8');
    try {
      const plain = await this.dpapiUnprotect(encrypted, 'CurrentUser');
      this.cache.set(key, plain);
      return plain;
    } catch {
      return null;
    }
  }

  clearAll(): void {
    // 字符串不可变，无法清零；如需更高安全级别应使用 Buffer
    this.cache.clear();
  }

  private assertValidKey(key: string): void {
    // key 白名单：仅允许字母数字与 _-，防止路径遍历写入任意文件
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
      throw new Error(`非法密钥名称: ${key}`);
    }
  }

  private path(key: string): string {
    return path.join(this.secretsDir, `${key}.enc`);
  }

  /** 限制密钥文件仅当前用户可读写（icacls 失败仅告警，不影响主流程） */
  private async restrictFileAcl(filePath: string): Promise<void> {
    try {
      const username = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`.replace(/^\\/, '');
      await execFileAsync('icacls', [filePath, '/inheritance:r', '/grant:r', `${username}:(R,W)`]);
    } catch {
      // ACL 设置失败（权限不足等）不阻断，DPAPI 本身已提供加密保护
    }
  }

  private static encodeCommand(command: string): string {
    // -EncodedCommand 需要 UTF-16LE base64；密钥编码在整段命令中，
    // 进程命令行仅暴露 base64 串，不再明文可见
    return Buffer.from(command, 'utf16le').toString('base64');
  }

  private async dpapiProtect(plain: string, scope: string): Promise<string> {
    const bytes = Buffer.from(plain, 'utf8').toString('base64');
    const command =
      `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String(` +
      `[Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String('${bytes}'), $null, '${scope}'))`;
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-EncodedCommand',
      DpapiSecretStore.encodeCommand(command),
    ]);
    return stdout.trim();
  }

  private async dpapiUnprotect(cipher: string, scope: string): Promise<string> {
    const command =
      `Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString(` +
      `[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${cipher}'), $null, '${scope}'))`;
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-EncodedCommand',
      DpapiSecretStore.encodeCommand(command),
    ]);
    return stdout.trim();
  }
}
