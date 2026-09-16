import { ipcMain } from 'electron';
import fs from 'fs-extra';
import path from 'path';
import type { Backend } from '../src/backend';
import { TemplateLibrary, type TemplateCategory } from '../src/kb/TemplateLibrary';
import { VersionManager, type VersionComponent, type RollbackWriter } from '../src/kb/VersionManager';
import { PermissionChecker, type PermissionAction } from '../src/kb/PermissionChecker';
import { ReviewWorkflow } from '../src/kb/ReviewWorkflow';
import { AccuracyMonitor } from '../src/monitor/AccuracyMonitor';
import { RuleEngine } from '../src/rules/RuleEngine';
import { resolveResource } from '../src/paths';

function validateString(val: unknown, name: string, maxLen = 10000): string {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new Error(`${name} 不能为空`);
  }
  if (val.length > maxLen) {
    throw new Error(`${name} 超过最大长度 ${maxLen}`);
  }
  return val.trim();
}

function validateShopId(val: unknown): string {
  const id = validateString(val, 'shopId', 64);
  if (!/^\d+$/.test(id)) throw new Error('shopId 必须为数字');
  return id;
}

function resolveRuleEngine(backend: Backend, shopId?: string) {
  if (!shopId) return backend.ruleEngine;
  const id = validateShopId(shopId);
  const runningEngine = backend.supervisor.getRuleEngine(id);
  if (runningEngine) return runningEngine;

  const shop = backend.db.shops.get(id);
  if (!shop) throw new Error(`店铺 ${id} 不存在`);
  const biz = backend.db.shopBusiness.getOrDefault(id);
  return new RuleEngine(
    backend.config,
    id,
    {
      deliveryAddress: biz.deliveryAddress,
      deliveryTime: biz.deliveryTime,
      freightInsurance: biz.freightInsurance,
      expressCompanies: biz.expressCompanies,
      freeShipping: biz.freeShipping,
      freeShippingCondition: biz.freeShippingCondition,
      mainCategory: biz.mainCategory,
    },
    shop.platform,
  );
}

function logError(backend: Backend, handler: string, err: unknown, extra?: Record<string, unknown>): void {
  backend.logger.error({ err, handler, ...extra }, `IPC ${handler} 失败`);
}

export function registerKbIpcHandlers(backend: Backend): void {
  const templateLib = (shopId?: string) => new TemplateLibrary(backend.config, shopId, backend.logger);
  const versionMgr = new VersionManager(backend.config, backend.logger);
  const permChecker = new PermissionChecker(backend.config, backend.logger);
  const reviewWf = new ReviewWorkflow(backend.config, backend.logger);
  const accuracyMonitor = new AccuracyMonitor(backend.db, backend.alertManager, backend.logger);

  const promptPath = resolveResource('config', 'prompt', 'customer-service.md');
  const sensitiveWordsPath = resolveResource('config', 'dict', 'sensitive-words.txt');

  /**
   * 在写操作前创建版本快照（保存"修改前"状态，便于回滚 = 撤销）。
   * 失败不阻断主流程，仅记录告警。
   */
  const snapshotBefore = async (
    shopId: string,
    component: VersionComponent,
    description: string,
    action: 'update' | 'import' = 'update',
  ): Promise<void> => {
    try {
      let snapshot = '';
      switch (component) {
        case 'prompt': {
          snapshot = (await fs.pathExists(promptPath)) ? await fs.readFile(promptPath, 'utf8') : '';
          break;
        }
        case 'sensitive': {
          snapshot = (await fs.pathExists(sensitiveWordsPath)) ? await fs.readFile(sensitiveWordsPath, 'utf8') : '';
          break;
        }
        case 'templates': {
          const lib = templateLib(shopId);
          snapshot = lib.exportTemplates();
          break;
        }
        case 'faq': {
          const engine = resolveRuleEngine(backend, shopId);
          snapshot = JSON.stringify({ faqs: engine.listFaqs() }, null, 2);
          break;
        }
        case 'rules': {
          const engine = resolveRuleEngine(backend, shopId);
          snapshot = JSON.stringify({ rules: engine.listRules() }, null, 2);
          break;
        }
      }
      await versionMgr.createVersion(shopId, component, snapshot, description, action);
    } catch (err) {
      backend.logger.warn({ err, shopId, component, description }, '创建版本快照失败（不阻断主流程）');
    }
  };

  /**
   * 权限校验：失败抛错。当前为单用户场景，默认空权限允许；配置后才校验。
   */
  const assertEdit = async (shopId: string): Promise<void> => {
    await permChecker.assertPermission(shopId, 'edit');
  };

  const assertReview = async (shopId: string): Promise<void> => {
    await permChecker.assertPermission(shopId, 'review');
  };

  /**
   * 全局写入校验：一旦任一店铺配置了非空权限，当前用户必须在至少一个店铺
   * 具备 publish 权限，才能修改全局文件（prompt/敏感词）。
   */
  const assertAnyPublish = async (): Promise<void> => {
    const shopsDir = path.join(backend.config.app.data_dir, 'data', 'shops');
    let anyConfigured = false;
    try {
      if (await fs.pathExists(shopsDir)) {
        const entries = await fs.readdir(shopsDir);
        for (const entry of entries) {
          const permsPath = path.join(shopsDir, entry, 'permissions.json');
          if (!(await fs.pathExists(permsPath))) continue;
          const perms = await permChecker.getPermissions(entry);
          const configured =
            perms.allowedUsers.length > 0 || perms.editors.length > 0 ||
            perms.reviewers.length > 0 || perms.publishers.length > 0;
          if (!configured) continue;
          anyConfigured = true;
          if (await permChecker.check(entry, 'publish')) return;
        }
      }
    } catch (err) {
      backend.logger.warn({ err }, '校验全局发布权限失败');
    }
    if (anyConfigured) {
      throw new Error('当前用户无全局知识库发布权限');
    }
  };

  /**
   * 构建 rollback writer：将快照内容写回实际存储（faq/rules 需通过 RuleEngine）。
   */
  const buildRollbackWriter = (): RollbackWriter => ({
    writePrompt: async (content) => {
      await fs.ensureDir(path.dirname(promptPath));
      await fs.writeFile(promptPath, content, 'utf8');
    },
    writeSensitiveWords: async (content) => {
      await fs.ensureDir(path.dirname(sensitiveWordsPath));
      await fs.writeFile(sensitiveWordsPath, content, 'utf8');
      await backend.sensitiveChecker.reload();
    },
    writeTemplates: async (shopId, json) => {
      const templatesPath = path.join(backend.config.app.data_dir, 'data', 'shops', shopId, 'templates.json');
      await fs.ensureDir(path.dirname(templatesPath));
      await fs.writeFile(templatesPath, json, 'utf8');
    },
    writeFaqs: async (shopId, json) => {
      const engine = resolveRuleEngine(backend, shopId);
      const parsed = JSON.parse(json) as { faqs?: Array<{ q: string; a: string; priority?: number }> };
      const faqs = parsed.faqs ?? [];
      // 清空并重新导入：通过 list+delete 逐个清理，再 add
      const existing = engine.listFaqs();
      for (let i = existing.length - 1; i >= 0; i--) {
        try { engine.deleteFaq(i); } catch { /* 忽略单条删除失败 */ }
      }
      for (const f of faqs) {
        if (f.q && f.a) engine.addFaq({ q: f.q, a: f.a, priority: f.priority ?? 75 });
      }
    },
    writeRules: async (shopId, json) => {
      const engine = resolveRuleEngine(backend, shopId);
      // 清空并重新导入
      const existing = engine.listRules();
      for (const r of existing) {
        try { engine.deleteRule(r.name); } catch { /* 忽略 */ }
      }
      engine.importRules(json);
    },
  });

  // ============ 话术模板 ============

  ipcMain.handle('kb:listTemplates', async (_evt, shopId?: string, category?: string) => {
    try {
      const lib = templateLib(shopId || undefined);
      return lib.listTemplates(category as TemplateCategory | undefined);
    } catch (err) {
      logError(backend, 'kb:listTemplates', err, { shopId });
      return [];
    }
  });

  ipcMain.handle('kb:getTemplate', async (_evt, shopId: string, templateId: string) => {
    try {
      const lib = templateLib(shopId);
      return lib.getTemplate(templateId);
    } catch (err) {
      logError(backend, 'kb:getTemplate', err, { shopId, templateId });
      return null;
    }
  });

  ipcMain.handle('kb:saveTemplate', async (_evt, shopId: string, template: Record<string, unknown>) => {
    try {
      const id = validateShopId(shopId);
      await assertEdit(id);
      const lib = templateLib(id);
      const existing = template.id ? lib.getTemplate(String(template.id)) : null;
      // 修改前创建版本快照
      await snapshotBefore(id, 'templates', `保存模板 ${template.id ?? '(new)'}`);
      if (existing) {
        lib.updateTemplate(String(template.id), template);
      } else {
        lib.addTemplate({
          id: String(template.id ?? `tpl_${Date.now()}`),
          category: template.category as TemplateCategory,
          scenario: String(template.scenario ?? ''),
          content: validateString(template.content, '模板内容', 5000),
          tags: Array.isArray(template.tags) ? template.tags as string[] : [],
          priority: Number(template.priority) || 50,
          enabled: template.enabled !== false,
        });
      }
      return { ok: true };
    } catch (err) {
      logError(backend, 'kb:saveTemplate', err, { shopId });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('kb:deleteTemplate', async (_evt, shopId: string, templateId: string) => {
    try {
      const id = validateShopId(shopId);
      await assertEdit(id);
      const lib = templateLib(id);
      // 修改前创建版本快照
      await snapshotBefore(id, 'templates', `删除模板 ${templateId}`);
      lib.deleteTemplate(templateId);
      return { ok: true };
    } catch (err) {
      logError(backend, 'kb:deleteTemplate', err, { shopId, templateId });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('kb:searchTemplates', async (_evt, query: string) => {
    try {
      const lib = templateLib();
      return lib.searchTemplates(query);
    } catch (err) {
      logError(backend, 'kb:searchTemplates', err, { query });
      return [];
    }
  });

  ipcMain.handle('kb:recommendTemplates', async (_evt, text: string, limit?: number) => {
    try {
      const lib = templateLib();
      return lib.recommendTemplates(text, limit ?? 5);
    } catch (err) {
      logError(backend, 'kb:recommendTemplates', err, { text });
      return [];
    }
  });

  ipcMain.handle('kb:getCategoryStats', async (_evt, shopId?: string) => {
    try {
      const lib = templateLib(shopId || undefined);
      return lib.getCategoryStats();
    } catch (err) {
      logError(backend, 'kb:getCategoryStats', err, { shopId });
      return [];
    }
  });

  ipcMain.handle('kb:importTemplates', async (_evt, shopId: string, json: string) => {
    try {
      const id = validateShopId(shopId);
      await assertEdit(id);
      const lib = templateLib(id);
      // 修改前创建版本快照
      await snapshotBefore(id, 'templates', '导入模板前快照', 'import');
      return lib.importTemplates(json);
    } catch (err) {
      logError(backend, 'kb:importTemplates', err, { shopId });
      return { imported: 0, errors: [err instanceof Error ? err.message : String(err)] };
    }
  });

  ipcMain.handle('kb:exportTemplates', async (_evt, shopId?: string, category?: string) => {
    try {
      const lib = templateLib(shopId || undefined);
      return lib.exportTemplates(category as TemplateCategory | undefined);
    } catch (err) {
      logError(backend, 'kb:exportTemplates', err, { shopId });
      return '[]';
    }
  });

  // ============ FAQ 分类查询 ============

  ipcMain.handle('kb:listFaqsByCategory', async (_evt, shopId: string, category?: string) => {
    try {
      const id = validateShopId(shopId);
      const engine = resolveRuleEngine(backend, id);
      const faqs = engine.listFaqs();
      if (!category || category === 'all') return faqs;
      return faqs.filter((f) => (f.category ?? 'general') === category);
    } catch (err) {
      logError(backend, 'kb:listFaqsByCategory', err, { shopId, category });
      return [];
    }
  });

  ipcMain.handle('kb:getCategories', async (_evt, shopId?: string) => {
    try {
      const lib = templateLib(shopId || undefined);
      const stats = lib.getCategoryStats();
      return stats;
    } catch (err) {
      logError(backend, 'kb:getCategories', err, { shopId });
      return [];
    }
  });

  // ============ 知识库批量导入导出 ============

  ipcMain.handle('kb:exportKnowledge', async (_evt, shopId?: string) => {
    try {
      const exportData: Record<string, unknown> = {};

      const promptPath = resolveResource('config', 'prompt', 'customer-service.md');
      if (await fs.pathExists(promptPath)) {
        exportData.prompt = await fs.readFile(promptPath, 'utf8');
      }

      const sensitiveWordsPath = resolveResource('config', 'dict', 'sensitive-words.txt');
      if (await fs.pathExists(sensitiveWordsPath)) {
        exportData.sensitiveWords = await fs.readFile(sensitiveWordsPath, 'utf8');
      }

      const lib = templateLib(shopId || undefined);
      exportData.templates = lib.listTemplates();

      if (shopId) {
        const engine = resolveRuleEngine(backend, shopId);
        exportData.faqs = engine.listFaqs();
      }

      return JSON.stringify(exportData, null, 2);
    } catch (err) {
      logError(backend, 'kb:exportKnowledge', err, { shopId });
      return '{}';
    }
  });

  ipcMain.handle('kb:importKnowledge', async (_evt, json: string, shopId?: string) => {
    try {
      const j = validateString(json, '知识库 JSON', 500000);
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(j);
      } catch {
        throw new Error('JSON 格式无效');
      }

      // 权限校验（若指定 shopId；否则要求全局发布权限）
      if (shopId) {
        const id = validateShopId(shopId);
        await assertEdit(id);
      } else {
        await assertAnyPublish();
      }

      let imported = 0;

      if (data.prompt && typeof data.prompt === 'string') {
        const promptPath = resolveResource('config', 'prompt', 'customer-service.md');
        // 修改前快照
        try {
          const prev = (await fs.pathExists(promptPath)) ? await fs.readFile(promptPath, 'utf8') : '';
          await versionMgr.createVersion('global', 'prompt', prev, '导入知识库前 Prompt 快照', 'import');
        } catch (err) {
          backend.logger.warn({ err }, '导入知识库时创建 prompt 快照失败');
        }
        await fs.ensureDir(path.dirname(promptPath));
        await fs.writeFile(promptPath, data.prompt, 'utf8');
        imported++;
      }

      if (data.sensitiveWords && typeof data.sensitiveWords === 'string') {
        const sensitiveWordsPath = resolveResource('config', 'dict', 'sensitive-words.txt');
        try {
          const prev = (await fs.pathExists(sensitiveWordsPath)) ? await fs.readFile(sensitiveWordsPath, 'utf8') : '';
          await versionMgr.createVersion('global', 'sensitive', prev, '导入知识库前敏感词快照', 'import');
        } catch (err) {
          backend.logger.warn({ err }, '导入知识库时创建敏感词快照失败');
        }
        await fs.ensureDir(path.dirname(sensitiveWordsPath));
        await fs.writeFile(sensitiveWordsPath, data.sensitiveWords, 'utf8');
        imported++;
      }

      if (Array.isArray(data.templates) && shopId) {
        const id = validateShopId(shopId);
        const lib = templateLib(id);
        await snapshotBefore(id, 'templates', '导入知识库前模板快照', 'import');
        lib.importTemplates(JSON.stringify({ templates: data.templates }));
        imported += data.templates.length;
      }

      if (Array.isArray(data.faqs) && shopId) {
        const id = validateShopId(shopId);
        await snapshotBefore(id, 'faq', '导入知识库前 FAQ 快照', 'import');
        const engine = resolveRuleEngine(backend, id);
        for (const faq of data.faqs) {
          const f = faq as { q: string; a: string; priority?: number };
          if (f.q && f.a) {
            engine.addFaq({ q: f.q, a: f.a, priority: f.priority ?? 75 });
            imported++;
          }
        }
      }

      return { imported };
    } catch (err) {
      logError(backend, 'kb:importKnowledge', err, { shopId });
      return { imported: 0 };
    }
  });

  // ============ 版本管理 ============

  ipcMain.handle('kb:listVersions', async (_evt, shopId: string, component?: string) => {
    try {
      const id = validateShopId(shopId);
      return versionMgr.listVersions(id, component as VersionComponent | undefined);
    } catch (err) {
      logError(backend, 'kb:listVersions', err, { shopId, component });
      return [];
    }
  });

  ipcMain.handle('kb:rollback', async (_evt, shopId: string, versionId: string) => {
    try {
      const id = validateShopId(shopId);
      await assertEdit(id);
      // 注入 writer 使回滚真正写回实际文件
      await versionMgr.rollback(id, versionId, buildRollbackWriter());
      return { ok: true };
    } catch (err) {
      logError(backend, 'kb:rollback', err, { shopId, versionId });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('kb:deleteVersion', async (_evt, versionId: string, shopId: string) => {
    try {
      const vid = validateString(versionId, 'versionId', 128);
      // 必填 shopId：先校验编辑权限，再让 VersionManager 校验版本归属，防止跨店铺越权删除
      const id = validateShopId(shopId);
      await assertEdit(id);
      await versionMgr.deleteVersion(vid, id);
      return { ok: true };
    } catch (err) {
      logError(backend, 'kb:deleteVersion', err, { versionId, shopId });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ============ 权限控制 ============

  ipcMain.handle('kb:getPermissions', async (_evt, shopId: string) => {
    try {
      const id = validateShopId(shopId);
      return permChecker.getPermissions(id);
    } catch (err) {
      logError(backend, 'kb:getPermissions', err, { shopId });
      return null;
    }
  });

  ipcMain.handle('kb:updatePermissions', async (_evt, shopId: string, permissions: Record<string, unknown>) => {
    try {
      const id = validateShopId(shopId);
      // 权限文件已配置（非空）后，更新必须持有 publish 权限，防止任意调用方自我提权
      const current = await permChecker.getPermissions(id);
      const isConfigured =
        current.allowedUsers.length > 0 || current.editors.length > 0 ||
        current.reviewers.length > 0 || current.publishers.length > 0;
      if (isConfigured) {
        await permChecker.assertPermission(id, 'publish');
      }
      await permChecker.updatePermissions(id, permissions);
      return { ok: true };
    } catch (err) {
      logError(backend, 'kb:updatePermissions', err, { shopId });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('kb:checkPermission', async (_evt, shopId: string, action: string) => {
    try {
      const id = validateShopId(shopId);
      return permChecker.check(id, action as PermissionAction);
    } catch (err) {
      logError(backend, 'kb:checkPermission', err, { shopId, action });
      return false;
    }
  });

  // ============ 内容审核工作流 ============

  ipcMain.handle('kb:submitForReview', async (_evt, shopId: string, component: string, targetId: string, payload: string) => {
    try {
      const id = validateShopId(shopId);
      await assertEdit(id);
      return reviewWf.submitForReview(id, component as 'faq' | 'template' | 'prompt', targetId, payload);
    } catch (err) {
      logError(backend, 'kb:submitForReview', err, { shopId, component, targetId });
      throw err;
    }
  });

  ipcMain.handle('kb:approveReview', async (_evt, reviewId: string, comment: string) => {
    try {
      const rid = validateString(reviewId, 'reviewId', 128);
      // 按 reviewId 反查归属店铺，校验 review 权限
      const review = await reviewWf.findReview(rid);
      if (!review) throw new Error(`审核记录 ${rid} 不存在`);
      await assertReview(review.shopId);
      await reviewWf.approve(rid, comment);
      return { ok: true };
    } catch (err) {
      logError(backend, 'kb:approveReview', err, { reviewId });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('kb:rejectReview', async (_evt, reviewId: string, comment: string) => {
    try {
      const rid = validateString(reviewId, 'reviewId', 128);
      // 按 reviewId 反查归属店铺，校验 review 权限
      const review = await reviewWf.findReview(rid);
      if (!review) throw new Error(`审核记录 ${rid} 不存在`);
      await assertReview(review.shopId);
      await reviewWf.reject(rid, comment);
      return { ok: true };
    } catch (err) {
      logError(backend, 'kb:rejectReview', err, { reviewId });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('kb:listPendingReviews', async (_evt, shopId: string) => {
    try {
      const id = validateShopId(shopId);
      return reviewWf.listPendingReviews(id);
    } catch (err) {
      logError(backend, 'kb:listPendingReviews', err, { shopId });
      return [];
    }
  });

  ipcMain.handle('kb:listReviewHistory', async (_evt, shopId: string, component?: string) => {
    try {
      const id = validateShopId(shopId);
      return reviewWf.listReviewHistory(id, component as 'faq' | 'template' | 'prompt' | undefined);
    } catch (err) {
      logError(backend, 'kb:listReviewHistory', err, { shopId, component });
      return [];
    }
  });

  // ============ 准确率监控 ============

  ipcMain.handle('kb:getAccuracyStats', async (_evt, shopId: string, period: string) => {
    try {
      const id = validateShopId(shopId);
      return accuracyMonitor.getStats(id, period as 'day' | 'week' | 'month');
    } catch (err) {
      logError(backend, 'kb:getAccuracyStats', err, { shopId, period });
      return null;
    }
  });

  ipcMain.handle('kb:getAccuracyTrend', async (_evt, shopId: string, days: number) => {
    try {
      const id = validateShopId(shopId);
      return accuracyMonitor.getTrend(id, days);
    } catch (err) {
      logError(backend, 'kb:getAccuracyTrend', err, { shopId, days });
      return [];
    }
  });

  ipcMain.handle('kb:getOptimizationSuggestions', async (_evt, shopId: string) => {
    try {
      const id = validateShopId(shopId);
      return accuracyMonitor.getOptimizationSuggestions(id);
    } catch (err) {
      logError(backend, 'kb:getOptimizationSuggestions', err, { shopId });
      return [];
    }
  });

  // 准确率告警定时巡检（每 30 分钟）：checkAndAlert 此前从未接线，准确率严重偏低无法触发告警
  const accuracyAlertTimer = setInterval(() => {
    try {
      const shops = backend.db.shops.list();
      for (const shop of shops) {
        accuracyMonitor.checkAndAlert(shop.shopId);
      }
    } catch (err) {
      backend.logger.warn({ err }, '准确率告警巡检失败');
    }
  }, 30 * 60 * 1000);
  accuracyAlertTimer.unref?.();
}
