/**
 * VersionManager 单元测试
 */
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { VersionManager, type VersionComponent } from '@/kb/VersionManager';
import { createTestConfig } from '../helpers/testConfig';

describe('VersionManager', () => {
  let tmpDir: string;
  let mgr: VersionManager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `ver-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const config = createTestConfig({ app: { data_dir: tmpDir } } as any);
    mgr = new VersionManager(config);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('createVersion 创建版本文件', async () => {
    const v = await mgr.createVersion('shop1', 'prompt', '{"a":1}', '更新 Prompt', 'update');
    expect(v.versionId).toMatch(/^v/);
    expect(v.shopId).toBe('shop1');
    expect(v.component).toBe('prompt');
    expect(v.action).toBe('update');
    expect(v.snapshot).toBe('{"a":1}');
    expect(v.description).toBe('更新 Prompt');
  });

  it('listVersions 按时间倒序返回', async () => {
    await mgr.createVersion('shop1', 'faq', '{}', 'v1', 'update');
    await new Promise((r) => setTimeout(r, 10));
    await mgr.createVersion('shop1', 'faq', '{}', 'v2', 'update');
    const list = await mgr.listVersions('shop1', 'faq');
    expect(list).toHaveLength(2);
    expect(list[0].description).toBe('v2');
    expect(list[1].description).toBe('v1');
  });

  it('listVersions(component) 按组件过滤', async () => {
    await mgr.createVersion('shop1', 'faq', '{}', 'faq版本', 'update');
    await mgr.createVersion('shop1', 'prompt', '{}', 'prompt版本', 'update');
    const faqList = await mgr.listVersions('shop1', 'faq');
    expect(faqList).toHaveLength(1);
    expect(faqList[0].component).toBe('faq');
    const promptList = await mgr.listVersions('shop1', 'prompt');
    expect(promptList).toHaveLength(1);
    expect(promptList[0].component).toBe('prompt');
  });

  it('getVersion 查找指定版本', async () => {
    const v = await mgr.createVersion('shop1', 'rules', '{}', '规则版本', 'update');
    const found = await mgr.getVersion(v.versionId);
    expect(found).not.toBeNull();
    expect(found!.versionId).toBe(v.versionId);
  });

  it('rollback 创建回滚版本（action=rollback）', async () => {
    const original = await mgr.createVersion('shop1', 'faq', '{"q":1}', '原始版本', 'update');
    await mgr.rollback('shop1', original.versionId);
    const list = await mgr.listVersions('shop1', 'faq');
    const rollbackVersion = list.find((v) => v.action === 'rollback');
    expect(rollbackVersion).toBeDefined();
    expect(rollbackVersion!.snapshot).toBe('{"q":1}');
  });

  it('deleteVersion 删除版本文件', async () => {
    const v = await mgr.createVersion('shop1', 'sensitive', '{}', '待删除', 'update');
    await mgr.deleteVersion(v.versionId);
    const list = await mgr.listVersions('shop1', 'sensitive');
    expect(list).toHaveLength(0);
  });

  it('cleanupOldVersions 保留 keepCount 个', async () => {
    for (let i = 0; i < 5; i++) {
      await mgr.createVersion('shop1', 'templates', '{}', `版本${i}`, 'update');
      await new Promise((r) => setTimeout(r, 5));
    }
    const deleted = await mgr.cleanupOldVersions('shop1', 2);
    expect(deleted).toBe(3);
    const list = await mgr.listVersions('shop1', 'templates');
    expect(list).toHaveLength(2);
  });
});
