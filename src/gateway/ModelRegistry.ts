/**
 * Provider 注册表
 * 管理所有已注册的 Provider，支持按层级查询
 */
import type { IModelProvider } from './providers/IModelProvider';
import type { ProviderType } from './types';
import type { ModelTier } from '../scheduler/types';

export class ModelRegistry {
  private providers = new Map<ProviderType, IModelProvider>();
  private tierMapping = new Map<ModelTier, ProviderType[]>();

  register(provider: IModelProvider): void {
    this.providers.set(provider.provider, provider);
    const tierProviders = this.tierMapping.get(provider.tier) ?? [];
    if (!tierProviders.includes(provider.provider)) {
      tierProviders.push(provider.provider);
    }
    this.tierMapping.set(provider.tier, tierProviders);
  }

  unregister(providerType: ProviderType): void {
    const provider = this.providers.get(providerType);
    if (provider) {
      this.providers.delete(providerType);
      const tierProviders = this.tierMapping.get(provider.tier);
      if (tierProviders) {
        const idx = tierProviders.indexOf(providerType);
        if (idx >= 0) tierProviders.splice(idx, 1);
        if (tierProviders.length === 0) this.tierMapping.delete(provider.tier);
      }
    }
  }

  getByTier(tier: ModelTier): IModelProvider[] {
    const types = this.tierMapping.get(tier) ?? [];
    return types.map((t) => this.providers.get(t)!).filter(Boolean);
  }

  get(provider: ProviderType): IModelProvider | undefined {
    return this.providers.get(provider);
  }

  getAvailableByTier(tier: ModelTier): IModelProvider | undefined {
    const providers = this.getByTier(tier);
    return providers.find((p) => p.capability.available);
  }

  getAll(): IModelProvider[] {
    return Array.from(this.providers.values());
  }

  /** Provider 热更新 tier 后重建层级索引。 */
  refreshTierMapping(): void {
    this.tierMapping.clear();
    for (const provider of this.providers.values()) {
      const tierProviders = this.tierMapping.get(provider.tier) ?? [];
      tierProviders.push(provider.provider);
      this.tierMapping.set(provider.tier, tierProviders);
    }
  }

  getTiers(): ModelTier[] {
    return Array.from(this.tierMapping.keys()).sort();
  }

  async checkAll(): Promise<Map<ProviderType, boolean>> {
    const results = new Map<ProviderType, boolean>();
    for (const [type, provider] of this.providers) {
      try {
        results.set(type, await provider.healthCheck());
      } catch {
        results.set(type, false);
      }
    }
    return results;
  }
}
