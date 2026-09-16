import fs from 'fs-extra';
import path from 'path';
import { resolveResource } from '../paths';
import crypto from 'crypto';
import os from 'os';
import type { Config } from '../config/schema';
import type { AppLogger } from '../logging/logger';

/**
 * 回滚后实际写回目标文件所需的上下文。
 * 由 IPC 层在调用 rollback 前注入，避免 VersionManager 直接依赖 RuleEngine / TemplateLibrary。
 */
export interface RollbackWriter {
  /** 写回 prompt 文件内容 */
  writePrompt?: (content: string) => Promise<void>;
  /** 写回敏感词库文件内容 */
  writeSensitiveWords?: (content: string) => Promise<void>;
  /** 写回店铺模板 JSON（包含 templates 数组的 JSON 字符串） */
  writeTemplates?: (shopId: string, json: string) => Promise<void>;
  /** 写回 FAQ JSON（[{q,a,priority}] 字符串） */
  writeFaqs?: (shopId: string, json: string) => Promise<void>;
  /** 写回规则 JSON（{rules:[...]} 字符串） */
  writeRules?: (shopId: string, json: string) => Promise<void>;
}

export type VersionComponent = 'prompt' | 'faq' | 'rules' | 'sensitive' | 'templates';

export interface KbVersion {
  versionId: string;
  shopId: string;
  createdAt: number;
  createdBy: string;
  component: VersionComponent;
  action: 'update' | 'import' | 'rollback';
  snapshot: string;
  description: string;
}

export class VersionManager {
  private currentUser: string;
  /** 全量版本列表缓存，避免 getVersion 每次全目录扫描（L-11） */
  private versionCache: KbVersion[] | null = null;

  constructor(private config: Config, private logger?: AppLogger) {
    try {
      this.currentUser = os.userInfo().username;
    } catch {
      this.currentUser = 'default';
    }
  }

  private getVersionsDir(shopId: string, component?: VersionComponent): string {
    const base = path.join(this.config.app.data_dir, 'data', 'versions', shopId);
    if (component) return path.join(base, component);
    return base;
  }

  async createVersion(
    shopId: string,
    component: VersionComponent,
    snapshot: string,
    description: string,
    action: 'update' | 'import' | 'rollback' = 'update',
  ): Promise<KbVersion> {
    const version: KbVersion = {
      versionId: this.generateVersionId(),
      shopId,
      createdAt: Date.now(),
      createdBy: this.currentUser,
      component,
      action,
      snapshot,
      description,
    };
    const dir = this.getVersionsDir(shopId, component);
    await fs.ensureDir(dir);
    const filePath = path.join(dir, `${version.versionId}.json`);
    await fs.writeJson(filePath, version, { spaces: 2 });
    this.versionCache = null;
    this.logger?.info({ shopId, component, versionId: version.versionId }, '版本快照已创建');
    return version;
  }

  async listVersions(shopId: string, component?: VersionComponent): Promise<KbVersion[]> {
    const dir = this.getVersionsDir(shopId, component);
    if (!(await fs.pathExists(dir))) return [];
    try {
      const entries = await fs.readdir(dir);
      const versions: KbVersion[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
          const data = await fs.readJson(path.join(dir, entry));
          versions.push(data as KbVersion);
        } catch {
          continue;
        }
      }
      return versions.sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      return [];
    }
  }

  async getVersion(versionId: string): Promise<KbVersion | null> {
    const versions = await this.listAllVersions();
    return versions.find((v) => v.versionId === versionId) ?? null;
  }

  private async listAllVersions(): Promise<KbVersion[]> {
    if (this.versionCache) return this.versionCache;
    const baseDir = path.join(this.config.app.data_dir, 'data', 'versions');
    if (!(await fs.pathExists(baseDir))) return [];
    const all: KbVersion[] = [];
    const shops = await fs.readdir(baseDir);
    for (const shop of shops) {
      const shopDir = path.join(baseDir, shop);
      const stat = await fs.stat(shopDir);
      if (!stat.isDirectory()) continue;
      const components = await fs.readdir(shopDir);
      for (const comp of components) {
        const compDir = path.join(shopDir, comp);
        const compStat = await fs.stat(compDir);
        if (!compStat.isDirectory()) continue;
        const files = await fs.readdir(compDir);
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          try {
            const data = await fs.readJson(path.join(compDir, file));
            all.push(data as KbVersion);
          } catch {
            continue;
          }
        }
      }
    }
    this.versionCache = all;
    return all;
  }

  async rollback(shopId: string, versionId: string, writer?: RollbackWriter): Promise<KbVersion> {
    const version = await this.getVersion(versionId);
    if (!version) {
      throw new Error(`版本 ${versionId} 不存在`);
    }
    if (version.shopId !== shopId) {
      throw new Error(`版本 ${versionId} 不属于店铺 ${shopId}`);
    }
    // 写回实际配置文件，使回滚真正生效
    if (writer) {
      await this.applySnapshot(version, writer);
    }
    const rollbackVersion = await this.createVersion(
      shopId,
      version.component,
      version.snapshot,
      `回滚到版本 ${versionId}`,
      'rollback',
    );
    this.logger?.info({ shopId, versionId, rollbackId: rollbackVersion.versionId }, '版本已回滚');
    return version;
  }

  /**
   * 将快照内容写回实际配置文件。
   * - prompt/sensitive: 写回共享配置文件（全局生效）
   * - faq/rules/templates: 写回对应店铺数据（按 shopId 隔离）
   */
  private async applySnapshot(version: KbVersion, writer: RollbackWriter): Promise<void> {
    switch (version.component) {
      case 'prompt':
        if (writer.writePrompt) {
          await writer.writePrompt(version.snapshot);
        } else {
          // 默认实现：写回 config/prompt/customer-service.md
          const p = resolveResource('config', 'prompt', 'customer-service.md');
          await fs.ensureDir(path.dirname(p));
          await fs.writeFile(p, version.snapshot, 'utf8');
        }
        break;
      case 'sensitive':
        if (writer.writeSensitiveWords) {
          await writer.writeSensitiveWords(version.snapshot);
        } else {
          // 默认实现：写回 config/dict/sensitive-words.txt
          const p = resolveResource('config', 'dict', 'sensitive-words.txt');
          await fs.ensureDir(path.dirname(p));
          await fs.writeFile(p, version.snapshot, 'utf8');
        }
        break;
      case 'templates':
        if (writer.writeTemplates) {
          await writer.writeTemplates(version.shopId, version.snapshot);
        } else {
          // 默认实现：写回 data/shops/{shopId}/templates.json
          const p = path.join(this.config.app.data_dir, 'data', 'shops', version.shopId, 'templates.json');
          await fs.ensureDir(path.dirname(p));
          await fs.writeFile(p, version.snapshot, 'utf8');
        }
        break;
      case 'faq':
        if (!writer.writeFaqs) {
          throw new Error('回滚 FAQ 需要提供 writeFaqs 回调（需通过 RuleEngine 重新写入）');
        }
        await writer.writeFaqs(version.shopId, version.snapshot);
        break;
      case 'rules':
        if (!writer.writeRules) {
          throw new Error('回滚规则需要提供 writeRules 回调（需通过 RuleEngine 重新写入）');
        }
        await writer.writeRules(version.shopId, version.snapshot);
        break;
    }
  }

  async deleteVersion(versionId: string, shopId?: string): Promise<void> {
    const version = await this.getVersion(versionId);
    if (!version) {
      throw new Error(`版本 ${versionId} 不存在`);
    }
    // 与 rollback 一致：可选校验归属店铺，防止跨店铺越权删除
    if (shopId && version.shopId !== shopId) {
      throw new Error(`版本 ${versionId} 不属于店铺 ${shopId}`);
    }
    const filePath = path.join(
      this.getVersionsDir(version.shopId, version.component),
      `${versionId}.json`,
    );
    if (await fs.pathExists(filePath)) {
      await fs.remove(filePath);
      this.versionCache = null;
      this.logger?.info({ versionId, shopId: version.shopId }, '版本已删除');
    }
  }

  async cleanupOldVersions(shopId: string, keepCount = 50): Promise<number> {
    const components: VersionComponent[] = ['prompt', 'faq', 'rules', 'sensitive', 'templates'];
    let deleted = 0;
    for (const comp of components) {
      const versions = await this.listVersions(shopId, comp);
      if (versions.length <= keepCount) continue;
      const toDelete = versions.slice(keepCount);
      for (const v of toDelete) {
        await this.deleteVersion(v.versionId);
        deleted++;
      }
    }
    if (deleted > 0) {
      this.logger?.info({ shopId, deleted }, '旧版本已清理');
    }
    return deleted;
  }

  private generateVersionId(): string {
    const ts = Date.now().toString(36);
    const rand = crypto.randomBytes(4).toString('hex');
    return `v${ts}_${rand}`;
  }
}
