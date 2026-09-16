/**
 * 配置加载器
 * 详见 docs/20-配置规范.md §20.6
 */
import yaml from 'js-yaml';
import fs from 'fs-extra';
import path from 'path';
import dotenv from 'dotenv';
import { ConfigSchema, type Config } from './schema';

export class ConfigLoader {
  /**
   * 加载配置，优先级从低到高：
   *   default.yaml < production.yaml < .env 环境变量
   */
  static async load(configDir: string): Promise<Config> {
    const defaults = await this.loadYaml(path.join(configDir, 'default.yaml'));

    const prodPath = path.join(configDir, 'production.yaml');
    const prod = (await fs.pathExists(prodPath)) ? await this.loadYaml(prodPath) : {};

    const envPath = path.join(configDir, '.env');
    const env = (await fs.pathExists(envPath)) ? dotenv.parse(await fs.readFile(envPath, 'utf8')) : {};

    const merged = this.mergeDeep(defaults, prod);
    const interpolated = this.interpolateEnv(merged, env);

    const result = ConfigSchema.safeParse(interpolated);
    if (!result.success) {
      const details = JSON.stringify(result.error.format(), null, 2);
      throw new Error(`配置校验失败:\n${details}`);
    }
    return result.data;
  }

  /**
   * 监听配置文件变化，触发回调（防抖 1000ms）
   */
  static watch(configDir: string, onChange: () => void): import('fs').FSWatcher | null {
    const configPath = path.join(configDir, 'default.yaml');
    if (!fs.pathExistsSync(configPath)) return null;
    const watchedFiles = new Set(['default.yaml', 'production.yaml', '.env']);
    let debounce: NodeJS.Timeout | null = null;
    try {
      return fs.watch(configDir, { persistent: false }, (eventType, filename) => {
        if (eventType !== 'change' && eventType !== 'rename') return;
        if (filename && !watchedFiles.has(path.basename(filename.toString()))) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => onChange(), 1000);
      });
    } catch {
      return null;
    }
  }

  private static async loadYaml(filePath: string): Promise<Record<string, unknown>> {
    const content = await fs.readFile(filePath, 'utf8');
    return (yaml.load(content) as Record<string, unknown>) || {};
  }

  private static mergeDeep(target: unknown, source: unknown): unknown {
    if (Array.isArray(source)) return [...source];
    if (Array.isArray(target)) return source;
    if (typeof target !== 'object' || target === null) return source;
    if (typeof source !== 'object' || source === null) return source;
    const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };
    for (const key of Object.keys(source as Record<string, unknown>)) {
      if (key in result) {
        result[key] = this.mergeDeep(result[key], (source as Record<string, unknown>)[key]);
      } else {
        result[key] = (source as Record<string, unknown>)[key];
      }
    }
    return result;
  }

  private static interpolateEnv(obj: unknown, env: Record<string, string>): unknown {
    if (typeof obj === 'string') {
      return obj.replace(/\$\{(\w+)\}/g, (_, k: string) => {
        // 优先级：系统真实环境变量 > .env 文件（dotenv.config 不覆盖已存在的 process.env）
        const val = process.env[k] ?? env[k];
        if (val === undefined) {
          console.warn(`[ConfigLoader] 环境变量 ${k} 未定义，替换为空串`);
          return '';
        }
        return val;
      });
    }
    if (Array.isArray(obj)) return obj.map((v) => this.interpolateEnv(v, env));
    if (obj && typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const k of Object.keys(obj)) {
        result[k] = this.interpolateEnv((obj as Record<string, unknown>)[k], env);
      }
      return result;
    }
    return obj;
  }
}
