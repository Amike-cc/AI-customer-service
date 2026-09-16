/**
 * PermissionChecker 单元测试
 */
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { PermissionChecker } from '@/kb/PermissionChecker';
import { createTestConfig } from '../helpers/testConfig';

describe('PermissionChecker', () => {
  let tmpDir: string;
  let checker: PermissionChecker;
  let currentUser: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `perm-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const config = createTestConfig({ app: { data_dir: tmpDir } } as any);
    checker = new PermissionChecker(config);
    currentUser = checker.getCurrentUser();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('getPermissions 无文件返回空权限', async () => {
    const perms = await checker.getPermissions('shop1');
    expect(perms.shopId).toBe('shop1');
    expect(perms.allowedUsers).toEqual([]);
    expect(perms.editors).toEqual([]);
    expect(perms.reviewers).toEqual([]);
    expect(perms.publishers).toEqual([]);
  });

  it('updatePermissions 写入并读取一致', async () => {
    await checker.updatePermissions('shop1', {
      allowedUsers: ['user1', 'user2'],
      editors: ['user1'],
    });
    const perms = await checker.getPermissions('shop1');
    expect(perms.allowedUsers).toEqual(['user1', 'user2']);
    expect(perms.editors).toEqual(['user1']);
    expect(perms.reviewers).toEqual([]);
  });

  it('check 所有列表为空时返回 true（默认允许）', async () => {
    const canAccess = await checker.check('shop1', 'access');
    expect(canAccess).toBe(true);
    const canEdit = await checker.check('shop1', 'edit');
    expect(canEdit).toBe(true);
    const canPublish = await checker.check('shop1', 'publish');
    expect(canPublish).toBe(true);
  });

  it('check 编辑权限仅 editors/publishers 可用', async () => {
    await checker.updatePermissions('shop1', {
      allowedUsers: [currentUser],
      editors: [currentUser],
    });
    const canEdit = await checker.check('shop1', 'edit');
    expect(canEdit).toBe(true);

    await checker.updatePermissions('shop1', {
      allowedUsers: [currentUser],
      editors: ['other_user'],
    });
    const cannotEdit = await checker.check('shop1', 'edit');
    expect(cannotEdit).toBe(false);
  });

  it('check 审核权限仅 reviewers/publishers 可用', async () => {
    await checker.updatePermissions('shop1', {
      reviewers: [currentUser],
    });
    const canReview = await checker.check('shop1', 'review');
    expect(canReview).toBe(true);

    await checker.updatePermissions('shop1', {
      reviewers: ['other_user'],
    });
    const cannotReview = await checker.check('shop1', 'review');
    expect(cannotReview).toBe(false);
  });

  it('check 发布权限仅 publishers 可用', async () => {
    await checker.updatePermissions('shop1', {
      publishers: [currentUser],
    });
    const canPublish = await checker.check('shop1', 'publish');
    expect(canPublish).toBe(true);

    await checker.updatePermissions('shop1', {
      publishers: ['other_user'],
      editors: [currentUser],
    });
    const cannotPublish = await checker.check('shop1', 'publish');
    expect(cannotPublish).toBe(false);
  });

  it('assertPermission 无权限抛错', async () => {
    await checker.updatePermissions('shop1', {
      publishers: ['other_user'],
    });
    await expect(checker.assertPermission('shop1', 'publish')).rejects.toThrow();
  });
});
