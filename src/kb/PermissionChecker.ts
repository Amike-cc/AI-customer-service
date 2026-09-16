import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { Config } from '../config/schema';
import type { AppLogger } from '../logging/logger';

export interface ShopPermissions {
  shopId: string;
  allowedUsers: string[];
  editors: string[];
  reviewers: string[];
  publishers: string[];
  updatedAt: number;
}

export type PermissionAction = 'access' | 'edit' | 'review' | 'publish';

const EMPTY_PERMISSIONS: Omit<ShopPermissions, 'shopId' | 'updatedAt'> = {
  allowedUsers: [],
  editors: [],
  reviewers: [],
  publishers: [],
};

export class PermissionChecker {
  private currentUser: string;

  constructor(private config: Config, private logger?: AppLogger) {
    try {
      this.currentUser = os.userInfo().username;
    } catch {
      this.currentUser = 'default';
    }
  }

  getCurrentUser(): string {
    return this.currentUser;
  }

  private getPermissionsPath(shopId: string): string {
    return path.join(this.config.app.data_dir, 'data', 'shops', shopId, 'permissions.json');
  }

  async getPermissions(shopId: string): Promise<ShopPermissions> {
    const filePath = this.getPermissionsPath(shopId);
    if (!(await fs.pathExists(filePath))) {
      return {
        shopId,
        ...EMPTY_PERMISSIONS,
        updatedAt: Date.now(),
      };
    }
    try {
      const data = await fs.readJson(filePath);
      return {
        shopId,
        allowedUsers: Array.isArray(data.allowedUsers) ? data.allowedUsers : [],
        editors: Array.isArray(data.editors) ? data.editors : [],
        reviewers: Array.isArray(data.reviewers) ? data.reviewers : [],
        publishers: Array.isArray(data.publishers) ? data.publishers : [],
        updatedAt: data.updatedAt ?? Date.now(),
      };
    } catch (err) {
      this.logger?.warn({ shopId, err }, '读取权限文件失败');
      return { shopId, ...EMPTY_PERMISSIONS, updatedAt: Date.now() };
    }
  }

  async updatePermissions(shopId: string, permissions: Partial<ShopPermissions>): Promise<void> {
    const current = await this.getPermissions(shopId);
    const updated: ShopPermissions = {
      shopId,
      allowedUsers: Array.isArray(permissions.allowedUsers) ? permissions.allowedUsers : current.allowedUsers,
      editors: Array.isArray(permissions.editors) ? permissions.editors : current.editors,
      reviewers: Array.isArray(permissions.reviewers) ? permissions.reviewers : current.reviewers,
      publishers: Array.isArray(permissions.publishers) ? permissions.publishers : current.publishers,
      updatedAt: Date.now(),
    };
    const filePath = this.getPermissionsPath(shopId);
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeJson(filePath, updated, { spaces: 2 });
    this.logger?.info({ shopId }, '权限配置已更新');
  }

  async check(shopId: string, action: PermissionAction): Promise<boolean> {
    const perms = await this.getPermissions(shopId);
    return this.checkPermissions(perms, action, this.currentUser);
  }

  private checkPermissions(perms: ShopPermissions, action: PermissionAction, user: string): boolean {
    if (perms.allowedUsers.length === 0 && perms.editors.length === 0 && perms.reviewers.length === 0 && perms.publishers.length === 0) {
      return true;
    }
    switch (action) {
      case 'access':
        return perms.allowedUsers.includes(user) || perms.editors.includes(user) || perms.reviewers.includes(user) || perms.publishers.includes(user);
      case 'edit':
        return perms.editors.includes(user) || perms.publishers.includes(user);
      case 'review':
        return perms.reviewers.includes(user) || perms.publishers.includes(user);
      case 'publish':
        return perms.publishers.includes(user);
      default:
        return false;
    }
  }

  async assertPermission(shopId: string, action: PermissionAction): Promise<void> {
    const allowed = await this.check(shopId, action);
    if (!allowed) {
      throw new Error(`用户 ${this.currentUser} 无 ${action} 权限访问店铺 ${shopId} 的知识库`);
    }
  }
}
