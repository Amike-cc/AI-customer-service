import fs from 'fs-extra';
import path from 'path';
import { resolveResource, resolveData } from '../paths';
import type { Config } from '../config/schema';
import type { AppLogger } from '../logging/logger';

export type TemplateCategory =
  | 'greeting'
  | 'pre_sales'
  | 'after_sales'
  | 'logistics'
  | 'activity'
  | 'complaint'
  | 'transfer'
  | 'closing';

export interface Template {
  id: string;
  category: TemplateCategory;
  scenario: string;
  content: string;
  tags: string[];
  priority: number;
  enabled: boolean;
  source: 'builtin' | 'custom';
  updatedAt?: number;
}

export interface CategoryStats {
  category: TemplateCategory;
  total: number;
  enabled: number;
  builtin: number;
  custom: number;
}

const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  greeting: '问候',
  pre_sales: '售前咨询',
  after_sales: '售后处理',
  logistics: '物流查询',
  activity: '活动优惠',
  complaint: '投诉处理',
  transfer: '转接专员',
  closing: '结束语',
};

export class TemplateLibrary {
  private builtinTemplates: Template[] = [];
  private customTemplates: Template[] = [];
  private builtinPath: string;
  private customPath: string | null = null;
  private shopId: string | undefined;

  constructor(config: Config, shopId?: string, private logger?: AppLogger) {
    this.shopId = shopId;
    this.builtinPath = resolveResource('config', 'templates', 'standard-templates.json');
    if (shopId) {
      this.customPath = resolveData(config.app.data_dir, 'data', 'shops', shopId, 'templates.json');
    }
    this.load();
  }

  private load(): void {
    this.builtinTemplates = this.loadBuiltin();
    this.customTemplates = this.loadCustom();
  }

  private loadBuiltin(): Template[] {
    try {
      if (!fs.pathExistsSync(this.builtinPath)) return [];
      const data = fs.readJsonSync(this.builtinPath);
      const templates: Template[] = (data.templates ?? []) as Template[];
      return templates.map((t) => ({ ...t, source: 'builtin' as const }));
    } catch (err) {
      this.logger?.warn({ err }, '加载预置模板失败');
      return [];
    }
  }

  private loadCustom(): Template[] {
    if (!this.customPath || !fs.pathExistsSync(this.customPath)) return [];
    try {
      const data = fs.readJsonSync(this.customPath);
      const templates: Template[] = (data.templates ?? []) as Template[];
      return templates.map((t) => ({ ...t, source: 'custom' as const }));
    } catch (err) {
      this.logger?.warn({ err }, '加载自定义模板失败');
      return [];
    }
  }

  private saveCustom(): void {
    if (!this.customPath) return;
    try {
      fs.ensureDirSync(path.dirname(this.customPath));
      fs.writeJsonSync(this.customPath, { templates: this.customTemplates }, { spaces: 2 });
    } catch (err) {
      this.logger?.error({ err }, '保存自定义模板失败');
      throw err;
    }
  }

  listTemplates(category?: TemplateCategory): Template[] {
    const customIds = new Set(this.customTemplates.map((t) => t.id));
    const builtins = this.builtinTemplates.filter((t) => !customIds.has(t.id));
    const all = [...builtins, ...this.customTemplates];
    if (category) return all.filter((t) => t.category === category);
    return all;
  }

  getTemplate(id: string): Template | null {
    const custom = this.customTemplates.find((t) => t.id === id);
    if (custom) return custom;
    return this.builtinTemplates.find((t) => t.id === id) ?? null;
  }

  searchTemplates(query: string): Template[] {
    const lower = query.toLowerCase().trim();
    if (!lower) return this.listTemplates();
    const all = this.listTemplates();
    return all.filter((t) => {
      return (
        t.scenario.toLowerCase().includes(lower) ||
        t.content.toLowerCase().includes(lower) ||
        t.tags.some((tag) => tag.toLowerCase().includes(lower)) ||
        t.category.toLowerCase().includes(lower)
      );
    });
  }

  recommendTemplates(text: string, limit = 5): Template[] {
    const lower = text.toLowerCase().trim();
    if (!lower) return [];
    const all = this.listTemplates().filter((t) => t.enabled);
    const scored = all.map((t) => {
      let score = 0;
      for (const tag of t.tags) {
        if (lower.includes(tag.toLowerCase())) score += 2;
      }
      if (lower.includes(t.category.toLowerCase())) score += 1;
      const words = t.scenario.toLowerCase().split(/\s+/);
      for (const word of words) {
        if (word.length >= 2 && lower.includes(word)) score += 1;
      }
      return { template: t, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.template);
  }

  addTemplate(template: Omit<Template, 'source' | 'updatedAt'>): Template {
    if (this.customTemplates.some((t) => t.id === template.id)) {
      throw new Error(`模板 "${template.id}" 已存在`);
    }
    if (this.builtinTemplates.some((t) => t.id === template.id)) {
      throw new Error(`模板 "${template.id}" 与预置模板 ID 冲突`);
    }
    const newTemplate: Template = {
      ...template,
      source: 'custom',
      updatedAt: Date.now(),
    };
    this.customTemplates.push(newTemplate);
    this.saveCustom();
    return newTemplate;
  }

  updateTemplate(id: string, patch: Partial<Template>): Template {
    const idx = this.customTemplates.findIndex((t) => t.id === id);
    if (idx === -1) {
      const builtin = this.builtinTemplates.find((t) => t.id === id);
      if (builtin) {
        const custom: Template = {
          ...builtin,
          ...patch,
          id,
          source: 'custom',
          updatedAt: Date.now(),
        };
        this.customTemplates.push(custom);
        this.saveCustom();
        return custom;
      }
      throw new Error(`模板 "${id}" 不存在`);
    }
    this.customTemplates[idx] = {
      ...this.customTemplates[idx],
      ...patch,
      id,
      source: 'custom',
      updatedAt: Date.now(),
    };
    this.saveCustom();
    return this.customTemplates[idx];
  }

  deleteTemplate(id: string): void {
    const idx = this.customTemplates.findIndex((t) => t.id === id);
    if (idx === -1) {
      throw new Error(`模板 "${id}" 不存在或为预置模板`);
    }
    this.customTemplates.splice(idx, 1);
    this.saveCustom();
  }

  importTemplates(json: string): { imported: number; errors: string[] } {
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      throw new Error('JSON 格式无效');
    }
    let templates: Template[];
    if (Array.isArray(data)) {
      templates = data as Template[];
    } else if (data && typeof data === 'object' && Array.isArray((data as { templates: unknown }).templates)) {
      templates = (data as { templates: Template[] }).templates;
    } else {
      throw new Error('JSON 格式应为数组或 { templates: [...] }');
    }
    const errors: string[] = [];
    let imported = 0;
    for (const t of templates) {
      if (!t.id || !t.content || !t.category) {
        errors.push(`模板缺少 id/content/category: ${JSON.stringify(t).slice(0, 80)}`);
        continue;
      }
      const existing = this.customTemplates.findIndex((c) => c.id === t.id);
      const newT: Template = { ...t, source: 'custom', updatedAt: Date.now() };
      if (existing >= 0) {
        this.customTemplates[existing] = newT;
      } else {
        this.customTemplates.push(newT);
      }
      imported++;
    }
    this.saveCustom();
    return { imported, errors };
  }

  exportTemplates(category?: TemplateCategory): string {
    const templates = category ? this.listTemplates(category) : this.listTemplates();
    return JSON.stringify({ templates }, null, 2);
  }

  getCategoryStats(): CategoryStats[] {
    const all = this.listTemplates();
    const categories: TemplateCategory[] = [
      'greeting', 'pre_sales', 'after_sales', 'logistics',
      'activity', 'complaint', 'transfer', 'closing',
    ];
    return categories.map((cat) => {
      const items = all.filter((t) => t.category === cat);
      return {
        category: cat,
        total: items.length,
        enabled: items.filter((t) => t.enabled).length,
        builtin: items.filter((t) => t.source === 'builtin').length,
        custom: items.filter((t) => t.source === 'custom').length,
      };
    });
  }

  getCategoryLabel(category: TemplateCategory): string {
    return CATEGORY_LABELS[category] ?? category;
  }

  reload(): void {
    this.load();
  }

  get count(): number {
    return this.builtinTemplates.length + this.customTemplates.length;
  }
}
