/**
 * 运行时路径解析（DATA-PATH-001）
 *
 * 只读资源（config/、vision/、模板、词库）与可写数据（数据库、店铺 JSON、备份）
 * 必须分离：打包后从开始菜单/桌面快捷方式启动时工作目录不稳定，不能再用
 * process.cwd() 定位资源，也不能把可写数据写进安装目录。
 *
 * 入口（Electron main / CLI）在初始化时调用 configurePaths() 注入真实根目录：
 *   - resourceDir：只读资源根（打包后 app.getAppPath()，开发时项目根）
 *   - dataDir：可写数据根（打包后 userData）
 */
import path from 'path';

let resourceDirOverride: string | null = null;
let dataDirOverride: string | null = null;

export function configurePaths(opts: { resourceDir?: string; dataDir?: string }): void {
  if (opts.resourceDir) resourceDirOverride = path.resolve(opts.resourceDir);
  if (opts.dataDir) dataDirOverride = path.resolve(opts.dataDir);
}

/** 只读资源根目录 */
export function getResourceDir(): string {
  return resourceDirOverride ?? process.cwd();
}

/** 在只读资源根下解析路径（如 config/rules/...） */
export function resolveResource(...segments: string[]): string {
  return path.resolve(getResourceDir(), ...segments);
}

/**
 * 可写数据根目录。未显式注入时回退到按 cwd 解析的 data_dir，
 * 保持开发环境既有行为。
 */
export function getDataDir(configDataDir?: string): string {
  if (dataDirOverride) return dataDirOverride;
  return path.resolve(getResourceDir(), configDataDir ?? 'data');
}

/** 在可写数据根下解析路径 */
export function resolveData(configDataDir: string | undefined, ...segments: string[]): string {
  return path.resolve(getDataDir(configDataDir), ...segments);
}
