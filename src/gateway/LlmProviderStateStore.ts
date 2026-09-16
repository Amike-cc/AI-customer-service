/**
 * LLM Provider 运行时状态存储
 *
 * 持久化用户在 UI 中对 gateway.providers 的修改（enabled / tier / model / api_url / timeout_ms）
 * 到 data/llm_provider_overrides.json，启动时与 YAML 配置合并。
 *
 * 这是配置 YAML 之上的运行时覆盖层，仅作用于 gateway.providers 子段。
 * 不修改 default.yaml / production.yaml，保证升级时不丢失用户配置。
 */
import fs from 'fs-extra';
import path from 'path';
import type { Config } from '../config/schema';
import type { ProviderType } from './types';

export type ModelTier = 'tier1' | 'tier2' | 'tier3';

const VALID_TIERS: ModelTier[] = ['tier1', 'tier2', 'tier3'];

export interface ProviderOverride {
  enabled?: boolean;
  tier?: ModelTier;
  model?: string;
  api_url?: string;
  timeout_ms?: number;
}

type ProviderOverrideMap = Partial<Record<ProviderType, ProviderOverride>>;

export class LlmProviderStateStore {
  private readonly stateFile: string;
  private overrides: ProviderOverrideMap = {};
  private defaultProvider: ProviderType | null = null;

  constructor(dataDir: string) {
    this.stateFile = path.join(dataDir, 'llm_provider_overrides.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        const text = fs.readFileSync(this.stateFile, 'utf8');
        const parsed = JSON.parse(text) as {
          providers?: ProviderOverrideMap;
          default_provider?: ProviderType;
        };
        if (parsed?.providers && typeof parsed.providers === 'object') {
          // 过滤已废弃的 'local' provider（2026-07 移除 Ollama 后的向后兼容处理）
          // 旧 override 文件中可能残留 local 条目，静默忽略并删除，不抛错
          const filtered: ProviderOverrideMap = {};
          for (const [key, value] of Object.entries(parsed.providers)) {
            if (key !== 'local') {
              filtered[key as ProviderType] = value;
            }
          }
          this.overrides = filtered;
        }
        if (parsed?.default_provider && (parsed.default_provider as string) !== 'local') {
          this.defaultProvider = parsed.default_provider;
        }
      }
    } catch {
      this.overrides = {};
      this.defaultProvider = null;
    }
  }

  private save(): void {
    try {
      fs.ensureDirSync(path.dirname(this.stateFile));
      const payload = {
        providers: this.overrides,
        ...(this.defaultProvider ? { default_provider: this.defaultProvider } : {}),
      };
      fs.writeFileSync(this.stateFile, JSON.stringify(payload, null, 2), 'utf8');
    } catch {
      // 持久化失败不抛出，仅记录；下次启动仍可用内存中的覆盖
    }
  }

  /** 获取某 provider 的覆盖配置（可能为空） */
  get(pt: ProviderType): ProviderOverride | undefined {
    return this.overrides[pt];
  }

  /** 获取所有覆盖 */
  getAll(): ProviderOverrideMap {
    return { ...this.overrides };
  }

  /** 更新某 provider 的覆盖（合并写入），并持久化 */
  update(pt: ProviderType, partial: ProviderOverride): void {
    // tier 枚举校验：无效值（如 tier9）会让 provider 从所有 tier 查询中静默消失
    if (partial.tier !== undefined && !VALID_TIERS.includes(partial.tier)) {
      throw new Error(`无效的模型层级 tier=${partial.tier}（可选值：${VALID_TIERS.join(', ')}）`);
    }
    const existing = this.overrides[pt] ?? {};
    this.overrides[pt] = { ...existing, ...partial };
    this.save();
  }

  /** 重置某 provider 的覆盖（恢复 YAML 默认值） */
  reset(pt: ProviderType): void {
    delete this.overrides[pt];
    this.save();
  }

  /** 获取覆盖的默认 provider（null 表示使用 YAML 中的 default_provider） */
  getDefaultProvider(): ProviderType | null {
    return this.defaultProvider;
  }

  /** 设置默认 provider，并持久化 */
  setDefaultProvider(pt: ProviderType): void {
    this.defaultProvider = pt;
    this.save();
  }

  /**
   * 将覆盖应用到 Config 对象（原地修改 config.gateway.providers 和 config.gateway.default_provider）
   * 在 backend 初始化、创建 Provider 实例之前调用
   */
  applyTo(config: Config): void {
    const providers = config.gateway.providers;
    for (const pt of Object.keys(this.overrides) as ProviderType[]) {
      const ov = this.overrides[pt];
      if (!ov) continue;
      const target = providers[pt as keyof typeof providers] as Record<string, unknown>;
      if (!target) continue;
      if (typeof ov.enabled === 'boolean') target.enabled = ov.enabled;
      if (ov.tier) {
        // 加载时同样校验：非法 tier 跳过并告警，避免 provider 静默从 tier 查询中消失
        if (VALID_TIERS.includes(ov.tier as ModelTier)) {
          target.tier = ov.tier;
        } else {
          console.warn(`[LlmProviderStateStore] 忽略无效 tier=${ov.tier}（provider=${pt}）`);
        }
      }
      if (typeof ov.model === 'string') target.model = ov.model;
      if (typeof ov.api_url === 'string') target.api_url = ov.api_url;
      if (typeof ov.timeout_ms === 'number') target.timeout_ms = ov.timeout_ms;
    }
    if (this.defaultProvider) {
      config.gateway.default_provider = this.defaultProvider;
    }
  }
}
