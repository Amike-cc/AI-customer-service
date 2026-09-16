/**
 * TemplateLibrary 单元测试
 */
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { TemplateLibrary, type TemplateCategory } from '@/kb/TemplateLibrary';
import { createTestConfig } from '../helpers/testConfig';

describe('TemplateLibrary', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `tpl-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('加载预置模板（40+ 条，8 分类各 >0）', () => {
    const config = createTestConfig({ app: { data_dir: tmpDir } } as any);
    const lib = new TemplateLibrary(config, undefined);
    const all = lib.listTemplates();
    expect(all.length).toBeGreaterThanOrEqual(40);

    const categories: TemplateCategory[] = [
      'greeting', 'pre_sales', 'after_sales', 'logistics',
      'activity', 'complaint', 'transfer', 'closing',
    ];
    for (const cat of categories) {
      const items = lib.listTemplates(cat);
      expect(items.length).toBeGreaterThan(0);
    }
  });

  it('listTemplates(category) 过滤正确', () => {
    const config = createTestConfig({ app: { data_dir: tmpDir } } as any);
    const lib = new TemplateLibrary(config, undefined);
    const greetingItems = lib.listTemplates('greeting');
    expect(greetingItems.every((t) => t.category === 'greeting')).toBe(true);
    expect(greetingItems.every((t) => t.source === 'builtin')).toBe(true);
  });

  it('addTemplate 新增自定义模板', () => {
    const config = createTestConfig({ app: { data_dir: tmpDir } } as any);
    const lib = new TemplateLibrary(config, 'shop1');
    const before = lib.listTemplates().length;
    lib.addTemplate({
      id: 'test_custom_1',
      category: 'greeting',
      scenario: '测试场景',
      content: '测试内容',
      tags: ['测试'],
      priority: 80,
      enabled: true,
    });
    expect(lib.listTemplates().length).toBe(before + 1);
    const tpl = lib.getTemplate('test_custom_1');
    expect(tpl).not.toBeNull();
    expect(tpl!.source).toBe('custom');
  });

  it('updateTemplate 更新自定义模板', () => {
    const config = createTestConfig({ app: { data_dir: tmpDir } } as any);
    const lib = new TemplateLibrary(config, 'shop1');
    lib.addTemplate({
      id: 'test_upd_1',
      category: 'greeting',
      scenario: '原场景',
      content: '原内容',
      tags: [],
      priority: 50,
      enabled: true,
    });
    lib.updateTemplate('test_upd_1', { scenario: '新场景', priority: 90 });
    const tpl = lib.getTemplate('test_upd_1');
    expect(tpl!.scenario).toBe('新场景');
    expect(tpl!.priority).toBe(90);
  });

  it('updateTemplate 将内置模板转为自定义副本', () => {
    const config = createTestConfig({ app: { data_dir: tmpDir } } as any);
    const lib = new TemplateLibrary(config, 'shop1');
    const builtin = lib.listTemplates('greeting')[0];
    lib.updateTemplate(builtin.id, { content: '修改后的内容' });
    const updated = lib.getTemplate(builtin.id);
    expect(updated!.content).toBe('修改后的内容');
    expect(updated!.source).toBe('custom');
  });

  it('deleteTemplate 删除自定义模板', () => {
    const config = createTestConfig({ app: { data_dir: tmpDir } } as any);
    const lib = new TemplateLibrary(config, 'shop1');
    lib.addTemplate({
      id: 'test_del_1',
      category: 'greeting',
      scenario: '待删除',
      content: '内容',
      tags: [],
      priority: 50,
      enabled: true,
    });
    expect(lib.getTemplate('test_del_1')).not.toBeNull();
    lib.deleteTemplate('test_del_1');
    expect(lib.getTemplate('test_del_1')).toBeNull();
  });

  it('deleteTemplate 内置模板抛错', () => {
    const config = createTestConfig({ app: { data_dir: tmpDir } } as any);
    const lib = new TemplateLibrary(config, 'shop1');
    const builtin = lib.listTemplates('greeting')[0];
    expect(() => lib.deleteTemplate(builtin.id)).toThrow();
  });

  it('searchTemplates 全文搜索', () => {
    const config = createTestConfig({ app: { data_dir: tmpDir } } as any);
    const lib = new TemplateLibrary(config, undefined);
    const results = lib.searchTemplates('问候');
    expect(results.length).toBeGreaterThan(0);
  });

  it('recommendTemplates 按标签评分推荐', () => {
    const config = createTestConfig({ app: { data_dir: tmpDir } } as any);
    const lib = new TemplateLibrary(config, undefined);
    const results = lib.recommendTemplates('你好在吗', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it('importTemplates 批量导入（去重更新）', () => {
    const config = createTestConfig({ app: { data_dir: tmpDir } } as any);
    const lib = new TemplateLibrary(config, 'shop1');
    const json = JSON.stringify({
      templates: [
        { id: 'imp_1', category: 'greeting', scenario: '导入1', content: '内容1', tags: [], priority: 50, enabled: true },
        { id: 'imp_2', category: 'after_sales', scenario: '导入2', content: '内容2', tags: [], priority: 60, enabled: true },
      ],
    });
    const result = lib.importTemplates(json);
    expect(result.imported).toBe(2);
    expect(result.errors).toHaveLength(0);

    const json2 = JSON.stringify({
      templates: [
        { id: 'imp_1', category: 'greeting', scenario: '更新导入1', content: '新内容', tags: [], priority: 70, enabled: true },
      ],
    });
    const result2 = lib.importTemplates(json2);
    expect(result2.imported).toBe(1);
    expect(lib.getTemplate('imp_1')!.scenario).toBe('更新导入1');
  });

  it('exportTemplates 导出 JSON', () => {
    const config = createTestConfig({ app: { data_dir: tmpDir } } as any);
    const lib = new TemplateLibrary(config, undefined);
    const json = lib.exportTemplates();
    const data = JSON.parse(json);
    expect(Array.isArray(data.templates)).toBe(true);
    expect(data.templates.length).toBeGreaterThan(0);
  });

  it('getCategoryStats 统计正确', () => {
    const config = createTestConfig({ app: { data_dir: tmpDir } } as any);
    const lib = new TemplateLibrary(config, undefined);
    const stats = lib.getCategoryStats();
    expect(stats).toHaveLength(8);
    const total = stats.reduce((sum, s) => sum + s.total, 0);
    expect(total).toBeGreaterThanOrEqual(40);
  });
});
