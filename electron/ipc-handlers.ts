/**
 * IPC 处理器注册
 *
 * 注册所有 ipcMain.handle 处理器，并订阅后端事件推送到渲染进程。
 */
import { ipcMain, BrowserWindow, shell } from 'electron';
import fs from 'fs-extra';
import path from 'path';
import type { Backend } from '../src/backend';
import type { WebviewManager } from './webview-manager';
import { RuleEngine } from '../src/rules/RuleEngine';
import { AlertBuffer } from './alert-buffer';
import { registerKbIpcHandlers } from './ipc-handlers-kb';
import { VersionManager } from '../src/kb/VersionManager';
import type { ShopBusinessConfigUpdate } from '../src/db/repos/ShopBusinessConfigRepo';
import { mergePlatformSessions } from '../src/db/repos/ConversationMessageRepo';
import { resolveResource, resolveData } from '../src/paths';
import {
  ALL_PROVIDER_TYPES,
  PROVIDER_META,
  type ProviderType,
} from '../src/gateway/types';
import { OpenAICompatibleProvider } from '../src/gateway/providers/OpenAICompatibleProvider';
import { ClaudeProvider } from '../src/gateway/providers/ClaudeProvider';
import { QwenProvider } from '../src/gateway/providers/QwenProvider';
import type { ProviderOverride } from '../src/gateway/LlmProviderStateStore';

export type LogEntry = {
  level: string;
  message: string;
  timestamp: string;
  meta: Record<string, unknown>;
};

export interface IpcContext {
  alertBuffer: AlertBuffer;
  logBuffer: LogEntry[];
}

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

export function registerIpcHandlers(
  backend: Backend,
  logBuffer: LogEntry[] = [],
): IpcContext {
  const alertBuffer = new AlertBuffer(200);

  // ============ 事件订阅 → 推送渲染进程 ============

  backend.alertManager.on('alert', (alert) => {
    alertBuffer.push(alert);
    broadcast('alert:stream', alert);
  });

  backend.alertManager.on('recovered', (info) => {
    broadcast('alert:recovered', info);
  });

  backend.deepseekClient.on('chatError', (data) => {
    broadcast('deepseek:error', data);
  });

  // ShopSupervisor 本身不发出 transition 事件，ShopInstance 内部转发到 db.shopState。
  // 这里通过周期性轮询由前端主动拉取状态，无需额外订阅。

  // ============ 应用相关 ============

  // 允许通过外部浏览器打开的域名白名单（平台官网/商家后台及必要辅助域名）
  const OPEN_EXTERNAL_ALLOWED_HOSTS = [
    'jinritemai.com',
    'pinduoduo.com',
    'kuaishou.com',
    'weixin.qq.com',
    'qq.com',
    'taobao.com',
    'jd.com',
  ];

  ipcMain.handle('app:openExternal', async (_evt, url: string) => {
    try {
      const trimmed = typeof url === 'string' ? url.trim() : '';
      if (!trimmed) throw new Error('URL 不能为空');
      let parsed: URL;
      try {
        parsed = new URL(trimmed);
      } catch {
        throw new Error('URL 格式无效');
      }
      // 仅放行 https 且域名匹配白名单（含子域名），拦截 file:/mailto:/自定义协议与任意站点
      if (parsed.protocol !== 'https:') throw new Error('仅允许 https 链接');
      const host = parsed.hostname.toLowerCase();
      const allowed = OPEN_EXTERNAL_ALLOWED_HOSTS.some(
        (d) => host === d || host.endsWith('.' + d),
      );
      if (!allowed) throw new Error('链接域名不在白名单内');
      await shell.openExternal(parsed.toString());
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, url }, '打开外部链接失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ============ 店铺相关 ============

  ipcMain.handle('shop:list', async () => {
    try {
      const shops = backend.db.shops.list();
      backend.logger.debug({ shopCount: shops.length }, 'shop:list 查询成功');
      return shops.map((s) => {
        const state = backend.supervisor.getShopState(s.shopId);
        let stateRecord: ReturnType<typeof backend.db.shopState.get> | null = null;
        try {
          stateRecord = backend.db.shopState.get(s.shopId);
        } catch (err) {
          backend.logger.warn({ err, shopId: s.shopId }, 'shop:list 读取店铺状态失败，忽略');
        }
        return {
          shopId: s.shopId,
          shopName: s.shopName,
          platform: s.platform,
          enabled: s.enabled,
          autoReply: s.autoReply,
          loginStatus: s.loginStatus,
          lastLoginAt: s.lastLoginAt,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          state,
          stateRecord: stateRecord
            ? { ...stateRecord, unreadCount: stateRecord.unreadCount ?? 0 }
            : null,
        };
      });
    } catch (err) {
      // 数据库异常必须让渲染层看到错误状态，不能伪装成"没有店铺"（UI-ERROR-001）
      backend.logger.error({ err }, 'shop:list 查询失败');
      throw new Error(`获取店铺列表失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  ipcMain.handle('shop:takeover', async (_evt, shopId: string) => {
    try {
      const id = validateShopId(shopId);
      await backend.supervisor.manualTakeover(id);
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, shopId }, '人工接管失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('shop:release', async (_evt, shopId: string) => {
    try {
      const id = validateShopId(shopId);
      await backend.supervisor.manualRelease(id);
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, shopId }, '人工释放失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('shop:setAutoReply', async (_evt, shopId: string, autoReply: boolean) => {
    try {
      const id = validateShopId(shopId);
      backend.supervisor.setAutoReply(id, autoReply);
      if (autoReply && !backend.supervisor.hasShop(id)) {
        const shopConfig = backend.db.shops.get(id);
        if (!shopConfig) throw new Error(`店铺 ${id} 不存在`);
        try {
          await backend.supervisor.startShop(shopConfig);
          backend.logger.info({ shopId: id }, 'AI 开启，自动启动店铺监控');
        } catch (err) {
          backend.supervisor.setAutoReply(id, false);
          throw new Error(`启动失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, shopId }, '设置自动回复失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('shop:addAccount', async (_evt, shopName: string, platform?: string) => {
    try {
      backend.logger.info({ shopName, platform, argType: typeof shopName }, 'shop:addAccount 调用');
      const name = validateString(shopName, 'shopName', 100);
      // 使用时间戳 + 进程 pid + 随机数，避免同毫秒创建账号时 shopId 撞号
      const shopId = String(Date.now()) + String(process.pid) + Math.floor(Math.random() * 1000);
      const plat = (platform && typeof platform === 'string') ? platform : 'feige';
      backend.logger.info({ shopId, shopName: name, platform: plat }, '开始创建店铺');
      backend.db.shops.add({
        shopId,
        shopName: name,
        platform: plat as 'feige' | 'pinduoduo' | 'kuaishou' | 'weixin',
        enabled: true,
        // 新账号必须由用户在界面中明确确认后才能向真实买家自动回复。
        autoReply: false,
        loginStatus: 'logged_out',
        lastLoginAt: null,
        });
      const shopConfig = backend.db.shops.get(shopId);
      if (!shopConfig) {
        backend.logger.error({ shopId }, '数据库写入后读回失败');
        throw new Error('账号创建失败');
      }
      backend.logger.info({ shopId }, '数据库写入成功，开始启动店铺');
      try {
        await backend.supervisor.startShop(shopConfig);
      } catch (err) {
        // 回滚时同样原子清理全部关联数据（startShop 可能已写入 shop_business_config 等）
        backend.db.deleteShopData(shopId);
        backend.logger.error({ shopId, err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }, '新账号启动失败，已回滚');
        throw err;
      }
      backend.logger.info({ shopId, shopName: name }, '新账号已添加');
      return { ok: true, shopId };
    } catch (err) {
      backend.logger.error({ err, shopName }, '添加店铺失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('shop:removeAccount', async (_evt, shopId: string) => {
    try {
      const id = validateShopId(shopId);
      await backend.supervisor.stopShop(id);
      if (backend.webviewManager.getActiveShopId() === id) {
        backend.webviewManager.setActiveShopId(null);
        backend.supervisor.setActiveShop(null);
      }
      // 原子删除店铺及其全部关联数据（含外键引用表），避免约束错误与孤儿数据
      backend.db.deleteShopData(id);
      backend.logger.info({ shopId: id }, '账号已删除');
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, shopId }, '删除店铺失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('shop:switchView', async (_evt, shopId: string) => {
    try {
      const id = validateShopId(shopId);
      backend.logger.info({ shopId: id }, 'shop:switchView: 收到切换请求');
      const shopConfig = backend.db.shops.get(id);
      const platform = shopConfig?.platform ?? 'feige';
      const webUrl = backend.config.platforms[platform]?.web_url || '';
      backend.logger.info({ shopId: id, platform, webUrl }, 'shop:switchView: 开始 ensureAndMount');
      await backend.webviewManager.ensureAndMount(id, webUrl, platform);
      backend.logger.info({ shopId: id }, 'shop:switchView: ensureAndMount 成功');
      // 活跃店铺使用快速轮询，其他店铺进入后台模式
      backend.supervisor.setActiveShop(id);
      backend.logger.info({ shopId: id }, 'shop:switchView: setActiveShop 成功');
      backend.db.shopState.markRead(id);
      // 诊断：记录 mount 后的 view 状态
      const viewState = backend.webviewManager.diagnoseViews?.();
      backend.logger.info({ shopId: id, viewState }, 'shop:switchView: mount 后 view 状态');
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, shopId }, '切换视图失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('shop:exitView', async () => {
    backend.webviewManager.setActiveShopId(null);
    backend.supervisor.setActiveShop(null);
    return { ok: true };
  });

  ipcMain.handle('shop:getLoginStatus', async (_evt, shopId: string) => {
    try {
      const id = validateShopId(shopId);
      return { loginStatus: backend.webviewManager.getLoginStatus(id) };
    } catch (err) {
      backend.logger.error({ err, shopId }, '获取登录状态失败');
      return { loginStatus: 'unknown', error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('shop:forceReLogin', async (_evt, shopId: string) => {
    try {
      const id = validateShopId(shopId);
      const shopConfig = backend.db.shops.get(id);
      const platform = shopConfig?.platform ?? 'feige';
      const webUrl = backend.config.platforms[platform]?.web_url || '';
      await backend.webviewManager.ensureAndMount(id, webUrl, platform);
      await backend.webviewManager.forceReLogin(id);
      backend.logger.info({ shopId: id, platform }, '已触发强制重新登录');
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, shopId }, '强制重新登录失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('shop:reload', async (_evt, shopId: string) => {
    try {
      const id = validateShopId(shopId);
      backend.webviewManager.reloadShop(id);
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, shopId }, '店铺页面刷新失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('shop:getActiveShop', async () => {
    return { shopId: backend.webviewManager.getActiveShopId() };
  });

  ipcMain.handle('view:hideForModal', async () => {
    backend.webviewManager.hideActiveViewForModal?.();
    return { ok: true };
  });

  ipcMain.handle('view:restoreAfterModal', async () => {
    backend.webviewManager.restoreActiveViewAfterModal?.();
    return { ok: true };
  });

  ipcMain.handle('shop:start', async (_evt, shopId: string) => {
    try {
      const id = validateShopId(shopId);
      if (backend.supervisor.hasShop(id)) {
        throw new Error(`店铺 ${id} 已在运行`);
      }
      const shopConfig = backend.db.shops.get(id);
      if (!shopConfig) {
        throw new Error(`店铺 ${id} 不存在`);
      }
      await backend.supervisor.startShop(shopConfig);
      backend.logger.info({ shopId: id }, '店铺已手动启动');
      return { ok: true, state: backend.supervisor.getShopState(id) };
    } catch (err) {
      backend.logger.error({ err, shopId }, '手动启动店铺失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('shop:stop', async (_evt, shopId: string) => {
    try {
      const id = validateShopId(shopId);
      if (!backend.supervisor.hasShop(id)) {
        return { ok: true, state: null };
      }
      await backend.supervisor.stopShop(id);
      // 若停止的是活跃店铺，清理活跃状态
      if (backend.webviewManager.getActiveShopId() === id) {
        backend.webviewManager.setActiveShopId(null);
        backend.supervisor.setActiveShop(null);
      }
      backend.logger.info({ shopId: id }, '店铺已手动停止');
      return { ok: true, state: null };
    } catch (err) {
      backend.logger.error({ err, shopId }, '手动停止店铺失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('shop:rename', async (_evt, shopId: string, newName: string) => {
    try {
      const id = validateShopId(shopId);
      const name = validateString(newName, '新店铺名称', 100);
      if (!backend.db.shops.get(id)) throw new Error(`店铺 ${id} 不存在`);
      backend.db.shops.rename(id, name);
      backend.logger.info({ shopId: id, newName: name }, '店铺已重命名');
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, shopId }, '店铺重命名失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('shop:getBusinessConfig', async (_evt, shopId: string) => {
    try {
      const id = validateShopId(shopId);
      // 不存在店铺明确报错，不用默认值伪装成已配置（UI-ERROR-001）
      if (!backend.db.shops.get(id)) throw new Error(`店铺 ${id} 不存在`);
      const config = backend.db.shopBusiness.getOrDefault(id);
      return { ok: true, config };
    } catch (err) {
      backend.logger.error({ err, shopId }, '获取店铺配置失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('shop:updateBusinessConfig', async (_evt, shopId: string, updates: Record<string, unknown>) => {
    try {
      const id = validateShopId(shopId);
      if (!backend.db.shops.get(id)) throw new Error(`店铺 ${id} 不存在`);
      backend.db.shopBusiness.upsert(id, updates as ShopBusinessConfigUpdate);
      // 店铺配置变更后清空该店铺的回复缓存，确保后续回复基于最新配置生成
      backend.lruCache.invalidateShop(id);
      // 重新读取完整配置并通知规则引擎重载（融合店铺配置动态规则 + 类目专属规则）
      const biz = backend.db.shopBusiness.getOrDefault(id);
      backend.supervisor.updateShopConfig(id, {
        deliveryAddress: biz.deliveryAddress,
        deliveryTime: biz.deliveryTime,
        freightInsurance: biz.freightInsurance,
        expressCompanies: biz.expressCompanies,
        freeShipping: biz.freeShipping,
        freeShippingCondition: biz.freeShippingCondition,
        mainCategory: biz.mainCategory,
      });
      backend.logger.info({ shopId: id, updates: Object.keys(updates) }, '店铺配置已更新，已清空回复缓存并重载规则引擎');
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, shopId }, '更新店铺配置失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('shop:markRead', async (_evt, shopId: string) => {
    try {
      const id = validateShopId(shopId);
      // 不存在店铺返回明确错误，不静默成功（UI-ERROR-001）
      if (!backend.db.shops.get(id)) throw new Error(`店铺 ${id} 不存在`);
      backend.db.shopState.markRead(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(
    'shop:sendReply',
    async (_evt, shopId: string, text: string, opts?: { sessionId?: string; clientMessageId?: string }) => {
      try {
        const id = validateShopId(shopId);
        const reply = validateString(text, 'text', 5000);
        const sessionId = opts?.sessionId ? validateString(opts.sessionId, 'sessionId', 200) : undefined;
        const clientMessageId = opts?.clientMessageId
          ? validateString(opts.clientMessageId, 'clientMessageId', 128)
          : undefined;
        const result = await backend.supervisor.sendManualReply(id, reply, {
          sessionId,
          clientMessageId,
        });
        return { ok: true, status: result.status, clientMessageId: result.clientMessageId };
      } catch (err) {
        backend.logger.error({ shopId, err }, '快捷回复发送失败');
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  (backend.webviewManager as unknown as WebviewManager).on('loginStatusChanged', (data: { shopId: string; status: string; oldStatus?: string }) => {
    backend.db.shops.setLoginStatus(data.shopId, data.status as 'logged_out' | 'logging_in' | 'logged_in');
    broadcast('shop:loginStatusChanged', data);
  });

  // 店铺名称抓取成功后同步到数据库并广播到渲染进程
  (backend.webviewManager as unknown as WebviewManager).on('shopNameUpdated', (data: { shopId: string; shopName: string }) => {
    try {
      const existing = backend.db.shops.get(data.shopId);
      // 仅当新名称与当前名称不同时才更新（避免无意义的写库和 UI 刷新）
      if (existing && existing.shopName === data.shopName) return;
      backend.db.shops.rename(data.shopId, data.shopName);
      backend.logger.info({ shopId: data.shopId, shopName: data.shopName }, '店铺名称已从平台同步更新');
      broadcast('shop:nameUpdated', data);
    } catch (err) {
      backend.logger.error({ err, shopId: data.shopId }, '店铺名称同步到数据库失败');
    }
  });

  // 订阅自动恢复事件，记录日志并广播到渲染进程
  (backend.webviewManager as unknown as WebviewManager).on('recovery-scheduled', (data: { shopId: string; attempt: number; delayMs: number }) => {
    backend.logger.info({ ...data }, '自动恢复任务已安排');
    broadcast('shop:recoveryScheduled', data);
  });
  (backend.webviewManager as unknown as WebviewManager).on('recovery-start', (data: { shopId: string; attempt: number }) => {
    backend.logger.info({ ...data }, '自动恢复开始执行');
    broadcast('shop:recoveryStart', data);
  });
  (backend.webviewManager as unknown as WebviewManager).on('recovery-failed', (data: { shopId: string; err: unknown }) => {
    backend.logger.warn({ ...data, err: data.err instanceof Error ? data.err.message : String(data.err) }, '自动恢复失败');
    broadcast('shop:recoveryFailed', data);
  });
  (backend.webviewManager as unknown as WebviewManager).on('recovery-exhausted', (data: { shopId: string; attempts: number }) => {
    backend.logger.error({ ...data }, '自动恢复已耗尽重试次数，需要人工介入');
    broadcast('shop:recoveryExhausted', data);
  });

  // ============ 转接事件订阅（智能路由转接客服功能） ============

  // ShopSupervisor 在 startShop 中已将 ShopInstance 的 transfer 事件冒泡上来
  // 这里订阅后通过 broadcast 推送到渲染层，由 TransferNotifier 组件接收并显示 Toast
  backend.supervisor.on('transfer:success', (data: { shopId: string; sessionId: string; agentName: string; role: string; reason: string }) => {
    backend.logger.info({ ...data }, '转接成功事件已广播到渲染层');
    // 持久化转接事件（与通知使用同一结果）
    try {
      backend.db.transferEvents.add({
        shopId: data.shopId,
        sessionId: data.sessionId,
        eventId: `transfer:${data.shopId}:${data.sessionId}:${Date.now()}`,
        status: 'succeeded',
        kind: data.agentName ? 'page_transfer' : 'manual_takeover',
        operator: data.agentName,
        reason: data.reason,
      });
    } catch (err) {
      backend.logger.warn({ err, ...data }, '持久化转接成功事件失败');
    }
    broadcast('transfer:success', data);
  });

  backend.supervisor.on('transfer:failed', (data: { shopId: string; sessionId: string; reason: string; role?: string; agentName?: string }) => {
    backend.logger.warn({ ...data }, '转接失败事件已广播到渲染层');
    try {
      backend.db.transferEvents.add({
        shopId: data.shopId,
        sessionId: data.sessionId,
        eventId: `transfer:${data.shopId}:${data.sessionId}:${Date.now()}`,
        status: 'failed',
        kind: data.agentName ? 'page_transfer' : 'manual_takeover',
        operator: data.agentName,
        reason: data.reason,
      });
    } catch (err) {
      backend.logger.warn({ err, ...data }, '持久化转接失败事件失败');
    }
    broadcast('transfer:failed', data);
  });

  // 平台消息实时推送（统一工作台消息时间线）
  backend.supervisor.on('message:recorded', (data: unknown) => {
    broadcast('conversation:message', data);
  });

  // ============ 配置相关 ============

  ipcMain.handle('config:get', async () => {
    const c = backend.config;
    return {
      app: {
        name: c.app.name,
        version: c.app.version,
        log_level: c.app.log_level,
        data_dir: c.app.data_dir,
        max_shops: c.app.max_shops,
        single_instance: c.app.single_instance,
      },
      vision: {
        enabled: c.vision.enabled,
        python_path: c.vision.python_path,
        script_path: c.vision.script_path,
        start_timeout_ms: c.vision.start_timeout_ms,
        request_timeout_ms: c.vision.request_timeout_ms,
        poll_interval_ms: c.vision.poll_interval_ms,
        max_restart_per_hour: c.vision.max_restart_per_hour,
      },
      ocr: c.ocr,
      cdp: c.cdp,
      deepseek: {
        api_url: c.deepseek.api_url,
        model: c.deepseek.model,
        temperature: c.deepseek.temperature,
        max_tokens: c.deepseek.max_tokens,
        top_p: c.deepseek.top_p,
        timeout_ms: c.deepseek.timeout_ms,
        stream: c.deepseek.stream,
        retry_count: c.deepseek.retry_count,
        retry_interval_ms: c.deepseek.retry_interval_ms,
        context_rounds: c.deepseek.context_rounds,
        context_idle_clear_ms: c.deepseek.context_idle_clear_ms,
        fallback_response: c.deepseek.fallback_response,
        scenarios: c.deepseek.scenarios,
        prompt_template: c.deepseek.prompt_template,
        sensitive_words_dict: c.deepseek.sensitive_words_dict,
        balance: c.deepseek.balance,
      },
      ratelimit: c.ratelimit,
      cache: c.cache,
      human_simulator: c.human_simulator,
      silent_wait: c.silent_wait,
      product: c.product,
      logging: {
        level: c.logging.level,
        retention_days: c.logging.retention_days,
        rotation_max_bytes: c.logging.rotation_max_bytes,
        audit_retention_days: c.logging.audit_retention_days,
        sanitize: c.logging.sanitize,
      },
      monitor: {
        metrics_flush_interval_ms: c.monitor.metrics_flush_interval_ms,
        metrics_retention_days: c.monitor.metrics_retention_days,
        alert: {
          dedup_window_ms: c.monitor.alert.dedup_window_ms,
          feishu_webhook: c.monitor.alert.feishu_webhook ? '已配置' : '未配置',
        },
      },
      security: {
        api_key_store: c.security.api_key_store,
        api_key_env_var: c.security.api_key_env_var,
        audit_all_replies: c.security.audit_all_replies,
        reply_output_check: c.security.reply_output_check,
        max_consecutive_sensitive: c.security.max_consecutive_sensitive,
      },
      platforms: {
        feige: { web_url: c.platforms.feige.web_url },
        pinduoduo: { web_url: c.platforms.pinduoduo.web_url },
        kuaishou: { web_url: c.platforms.kuaishou.web_url },
        weixin: { web_url: c.platforms.weixin.web_url },
      },
      platform_overrides: c.platform_overrides,
      agents: c.agents,
      gateway: c.gateway,
      scheduler: c.scheduler,
      learning: c.learning,
      intent: {
        enabled: c.intent.enabled,
        complexity_threshold: c.intent.complexity_threshold,
        confidence_threshold: c.intent.confidence_threshold,
        history_weight: c.intent.history_weight,
      },
      conversion: {
        enabled: c.conversion.enabled,
        max_recommendations: c.conversion.max_recommendations,
        cross_sell_threshold: c.conversion.cross_sell_threshold,
        recommendation_cooldown_ms: c.conversion.recommendation_cooldown_ms,
      },
      human_collab: {
        enabled: c.human_collab.enabled,
        queue_poll_interval_ms: c.human_collab.queue_poll_interval_ms,
        max_wait_ms: c.human_collab.max_wait_ms,
        default_max_chats: c.human_collab.default_max_chats,
        auto_transfer_on_escalation: c.human_collab.auto_transfer_on_escalation,
      },
      work_time: c.work_time,
      buyer: c.buyer,
    };
  });

  ipcMain.handle('config:getApiKey', async () => {
    const key = backend.deepseekClient.currentApiKey;
    if (!key) return '';
    // 只返回前 8 位和后 4 位，中间用 * 替换
    if (key.length <= 12) return '****';
    return `${key.slice(0, 8)}${'*'.repeat(Math.max(0, key.length - 12))}${key.slice(-4)}`;
  });

  ipcMain.handle('config:updateApiKey', async (_evt, newKey: string) => {
    try {
      if (!newKey || typeof newKey !== 'string' || newKey.trim().length === 0) {
        throw new Error('API Key 不能为空');
      }
      const trimmed = newKey.trim();
      backend.deepseekClient.updateApiKey(trimmed);
      await backend.secretStore.set('deepseek_api_key', trimmed);
      backend.logger.info('API Key 已更新并写入 DPAPI 加密存储（不再写入明文 .env）');
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err }, 'API Key 更新失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ============ 多 LLM Provider 配置 ============

  /** 返回所有 LLM Provider 的当前配置 + 运行时状态 */
  ipcMain.handle('config:getLlmProviders', async () => {
    try {
      const cfg = backend.config;
      const providers = cfg.gateway.providers;
      const defaultProvider =
        backend.llmStateStore.getDefaultProvider() ?? cfg.gateway.default_provider;
      const result = await Promise.all(
        ALL_PROVIDER_TYPES.map(async (pt) => {
          const meta = PROVIDER_META[pt];
          // 读取该 provider 的配置段（不同 provider 字段不同，统一处理）
          // 合并 YAML 默认值 + 运行时覆盖，让 UI 直接显示「重启后将生效」的最终态
          const rawCfg = (providers[pt as keyof typeof providers] ?? {}) as Record<string, unknown>;
          const override = backend.llmStateStore.get(pt) ?? {};
          const providerCfg: Record<string, unknown> = { ...rawCfg, ...override };
          const secretKey = pt === 'deepseek' ? 'deepseek_api_key' : `llm_api_key_${pt}`;
          let apiKeyConfigured = false;
          try {
            // 使用 get() 而非 has()，因为 DpapiSecretStore 未实现 has()
            // 对于已配置的 provider，第二次起命中内存缓存，开销极低
            const stored = await backend.secretStore.get(secretKey);
            apiKeyConfigured = !!stored;
          } catch {
            // secretStore 异常时按未配置处理
          }
          // 只有已经注册且当前可用的 Provider 才算“当前生效”。
          // 例如 DeepSeek 已启用但缺少 Key 时，适配器会保留以支持热更新，
          // 但不能在 UI 中显示为已生效。
          const registeredProvider = backend.modelRegistry.get(pt);
          const registered = !!registeredProvider?.capability.available;
          // 使用 null 替代 undefined，避免 IPC 序列化时丢失字段
          return {
            type: pt,
            label: meta.label,
            description: meta.description,
            docsUrl: meta.docsUrl,
            apiKeysUrl: meta.apiKeysUrl,
            enabled: !!providerCfg.enabled,
            tier: (providerCfg.tier as 'tier1' | 'tier2' | 'tier3' | undefined) ?? null,
            model: (providerCfg.model as string | undefined) ?? null,
            apiUrl: (providerCfg.api_url as string | undefined) ?? null,
            timeoutMs: (providerCfg.timeout_ms as number | undefined) ?? null,
            apiKeyEnvVar: (providerCfg.api_key_env_var as string | undefined) ?? null,
            anthropicVersion: (providerCfg.anthropic_version as string | undefined) ?? null,
            apiKeyConfigured,
            registered,
            isDefault: pt === defaultProvider,
            hasOverride: Object.keys(override).length > 0,
          };
        }),
      );
      return {
        ok: true,
        providers: result,
        defaultProvider,
        cascade: cfg.gateway.cascade,
      };
    } catch (err) {
      backend.logger.error({ err }, 'config:getLlmProviders 失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err), providers: [] };
    }
  });

  /** 获取指定 provider 的脱敏 API Key */
  ipcMain.handle('config:getLlmApiKey', async (_evt, providerType: ProviderType) => {
    try {
      if (!ALL_PROVIDER_TYPES.includes(providerType)) {
        throw new Error(`不支持的 provider 类型: ${providerType}`);
      }
      const secretKey = providerType === 'deepseek' ? 'deepseek_api_key' : `llm_api_key_${providerType}`;
      const key = await backend.secretStore.get(secretKey);
      if (!key) {
        return { ok: true, masked: '', configured: false };
      }
      // 脱敏：前 6 位 + 中间 * + 后 4 位
      let masked: string;
      if (key.length <= 12) {
        masked = '****';
      } else {
        masked = `${key.slice(0, 6)}${'*'.repeat(Math.max(0, key.length - 10))}${key.slice(-4)}`;
      }
      return { ok: true, masked, configured: true };
    } catch (err) {
      backend.logger.error({ err, providerType }, 'config:getLlmApiKey 失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** 保存指定 provider 的 API Key（写入 DPAPI 加密存储） */
  ipcMain.handle(
    'config:updateLlmApiKey',
    async (_evt, providerType: ProviderType, newKey: string) => {
      try {
        if (!ALL_PROVIDER_TYPES.includes(providerType)) {
          throw new Error(`不支持的 provider 类型: ${providerType}`);
        }
        if (!newKey || typeof newKey !== 'string' || newKey.trim().length === 0) {
          throw new Error('API Key 不能为空');
        }
        const trimmed = newKey.trim();
        const secretKey =
          providerType === 'deepseek' ? 'deepseek_api_key' : `llm_api_key_${providerType}`;
        await backend.secretStore.set(secretKey, trimmed);
        // 若是 deepseek，同步更新 DeepSeekClient 内存中的 key
        if (providerType === 'deepseek') {
          backend.deepseekClient.updateApiKey(trimmed);
        }
        backend.logger.info({ providerType }, 'LLM API Key 已写入 DPAPI 加密存储');
        return { ok: true, requiresRestart: providerType !== 'deepseek' };
      } catch (err) {
        backend.logger.error({ err, providerType }, 'config:updateLlmApiKey 失败');
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  /** 更新 provider 的运行时配置（enabled / tier / model / api_url / timeout_ms） */
  ipcMain.handle(
    'config:updateLlmProvider',
    async (_evt, providerType: ProviderType, updates: ProviderOverride) => {
      try {
        if (!ALL_PROVIDER_TYPES.includes(providerType)) {
          throw new Error(`不支持的 provider 类型: ${providerType}`);
        }
        backend.llmStateStore.update(providerType, updates);
        backend.logger.info({ providerType, updates }, 'LLM Provider 配置已更新（需重启生效）');
        return { ok: true, requiresRestart: true };
      } catch (err) {
        backend.logger.error({ err, providerType }, 'config:updateLlmProvider 失败');
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  /** 重置 provider 配置为 YAML 默认值 */
  ipcMain.handle('config:resetLlmProvider', async (_evt, providerType: ProviderType) => {
    try {
      if (!ALL_PROVIDER_TYPES.includes(providerType)) {
        throw new Error(`不支持的 provider 类型: ${providerType}`);
      }
      backend.llmStateStore.reset(providerType);
      backend.logger.info({ providerType }, 'LLM Provider 配置已重置为 YAML 默认值');
      return { ok: true, requiresRestart: true };
    } catch (err) {
      backend.logger.error({ err, providerType }, 'config:resetLlmProvider 失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** 设置默认 provider */
  ipcMain.handle('config:setDefaultLlmProvider', async (_evt, providerType: ProviderType) => {
    try {
      if (!ALL_PROVIDER_TYPES.includes(providerType)) {
        throw new Error(`不支持的 provider 类型: ${providerType}`);
      }
      backend.llmStateStore.setDefaultProvider(providerType);
      backend.logger.info({ providerType }, '默认 LLM Provider 已设置（需重启生效）');
      return { ok: true, requiresRestart: true };
    } catch (err) {
      backend.logger.error({ err, providerType }, 'config:setDefaultLlmProvider 失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** 测试 provider 连接（healthCheck） */
  ipcMain.handle('config:testLlmProvider', async (_evt, providerType: ProviderType) => {
    try {
      if (!ALL_PROVIDER_TYPES.includes(providerType)) {
        throw new Error(`不支持的 provider 类型: ${providerType}`);
      }
      const start = Date.now();
      // 1. 优先使用已注册的 provider
      const registered = backend.modelRegistry.get(providerType);
      if (registered) {
        const ok = await Promise.race([
          registered.healthCheck(),
          new Promise<boolean>((_, reject) =>
            setTimeout(() => reject(new Error('健康检查超时（10s）')), 10000),
          ),
        ]);
        return { ok, latencyMs: Date.now() - start, message: ok ? '连接成功' : '健康检查返回失败' };
      }
      // 2. 未注册则创建临时实例进行测试
      const secretKey = providerType === 'deepseek' ? 'deepseek_api_key' : `llm_api_key_${providerType}`;
      const apiKey = await backend.secretStore.get(secretKey);
      if (!apiKey) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          message: '未配置 API Key，无法测试',
        };
      }
      const cfg = backend.config;
      let ok = false;
      if (providerType === 'claude') {
        const temp = new ClaudeProvider(apiKey, cfg, cfg.gateway.providers.claude.tier);
        ok = await temp.healthCheck();
      } else if (providerType === 'qwen') {
        const temp = new QwenProvider(apiKey, cfg, cfg.gateway.providers.qwen.tier);
        ok = await temp.healthCheck();
      } else if (
        providerType === 'openai' ||
        providerType === 'kimi' ||
        providerType === 'glm' ||
        providerType === 'baichuan'
      ) {
        const temp = new OpenAICompatibleProvider(
          providerType,
          apiKey,
          cfg,
          cfg.gateway.providers[providerType as 'openai'].tier,
        );
        ok = await temp.healthCheck();
      } else if (providerType === 'deepseek') {
        // DeepSeek 已通过 client 测试
        ok = !!backend.deepseekClient.currentApiKey;
      }
      return {
        ok,
        latencyMs: Date.now() - start,
        message: ok ? '连接成功' : '健康检查失败，请检查 API Key / 网络 / 模型名',
      };
    } catch (err) {
      backend.logger.error({ err, providerType }, 'config:testLlmProvider 失败');
      return {
        ok: false,
        latencyMs: 0,
        message: '测试失败: ' + (err instanceof Error ? err.message : String(err)),
      };
    }
  });

  // ============ 日志相关 ============

  ipcMain.handle('log:history', async (_evt, limit: number = 200, offset: number = 0) => {
    const total = logBuffer.length;
    const start = Math.max(0, total - offset - limit);
    const end = total - offset;
    const page = logBuffer.slice(start, end).reverse();
    return { entries: page, total, offset, limit };
  });

  // log:stream 事件由 ElectronLogTransport 直接发送，这里提供注册接口
  ipcMain.handle('log:subscribe', async () => {
    return { ok: true, bufferSize: logBuffer.length };
  });

  // ============ 告警相关 ============

  ipcMain.handle('alert:list', async () => {
    return alertBuffer.list();
  });

  ipcMain.handle('alert:acknowledge', async (_evt, name: string) => {
    const removed = alertBuffer.acknowledge(name);
    backend.logger.info({ alertName: name, removed }, '告警已确认');
    return { ok: true, removed };
  });

  // ============ 会话相关 ============

  ipcMain.handle('conversation:sessions', async (_evt, shopId: string, limit?: number) => {
    const id = validateShopId(shopId);
    return backend.db.conversation.listSessions(id, limit ?? 50);
  });

  ipcMain.handle(
    'conversation:messages',
    async (_evt, shopId: string, sessionId: string, limit?: number, offset?: number) => {
      const sid = validateShopId(shopId);
      const sessId = validateString(sessionId, 'sessionId', 128);
      return backend.db.conversation.listMessages(sid, sessId, limit ?? 100, offset ?? 0);
    },
  );

  ipcMain.handle('conversation:search', async (_evt, shopId: string, keyword: string, limit?: number) => {
    const sid = validateShopId(shopId);
    const kw = validateString(keyword, '搜索关键词', 200);
    return backend.db.conversation.searchMessages(sid, kw, limit ?? 100);
  });

  // ============ 统一工作台相关 ============

  /** 工作台快照：能力、当前会话、AI/健康状态和数据时间 */
  ipcMain.handle('workspace:getSnapshot', async (_evt, shopId: string) => {
    try {
      const id = validateShopId(shopId);
      const shop = backend.db.shops.get(id);
      if (!shop) return { ok: false, error: `店铺 ${id} 不存在` };
      const state = backend.supervisor.getShopState(id);
      const stateRecord = (() => {
        try { return backend.db.shopState.get(id); } catch { return null; }
      })();
      return {
        ok: true,
        snapshot: {
          shopId: id,
          shopName: shop.shopName,
          platform: shop.platform,
          autoReply: shop.autoReply,
          loginStatus: backend.webviewManager.getLoginStatus(id),
          state,
          manualMode: state === 'ManualMode',
          unreadCount: stateRecord?.unreadCount ?? 0,
          capabilities: backend.supervisor.getShopCapabilities(id),
          capturedAt: Date.now(),
        },
      };
    } catch (err) {
      backend.logger.error({ err, shopId }, '获取工作台快照失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** 独立平台消息：按会话查询，afterMessageId 用于断线补齐 */
  ipcMain.handle(
    'conversation:stream',
    async (_evt, shopId: string, sessionId: string, afterMessageId?: number, limit?: number) => {
      const id = validateShopId(shopId);
      const sessId = validateString(sessionId, 'sessionId', 128);
      const after = typeof afterMessageId === 'number' && afterMessageId > 0 ? afterMessageId : undefined;
      const lim = typeof limit === 'number' && limit > 0 ? Math.min(limit, 500) : 100;
      return backend.db.conversationMessages.listBySession(id, sessId, lim, after);
    },
  );

  /** 平台会话列表：合并 LLM 上下文会话与已记录的平台消息会话，供工作台会话区选择 */
  ipcMain.handle('conversation:platformSessions', async (_evt, shopId: string, limit?: number) => {
    const id = validateShopId(shopId);
    const lim = typeof limit === 'number' && limit > 0 ? Math.min(limit, 200) : 50;
    return mergePlatformSessions(
      backend.db.conversation.listSessions(id, lim),
      backend.db.conversationMessages.listRecentSessions(id, lim),
      lim,
    );
  });

  /** 发送人工文本：绑定会话与幂等 clientMessageId */
  ipcMain.handle(
    'conversation:sendText',
    async (
      _evt,
      shopId: string,
      sessionId: string,
      text: string,
      clientMessageId?: string,
      _messageVersion?: number,
    ) => {
      try {
        const id = validateShopId(shopId);
        const sessId = validateString(sessionId, 'sessionId', 128);
        const reply = validateString(text, 'text', 5000);
        const cmid = clientMessageId ? validateString(clientMessageId, 'clientMessageId', 128) : undefined;
        const result = await backend.supervisor.sendManualReply(id, reply, {
          sessionId: sessId,
          clientMessageId: cmid,
        });
        return { ok: true, status: result.status, clientMessageId: result.clientMessageId };
      } catch (err) {
        backend.logger.error({ err, shopId, sessionId }, '会话发送失败');
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  /** 发送附件：当前平台无附件能力时返回 manual_only，不伪造成功 */
  ipcMain.handle(
    'conversation:sendAttachment',
    async (
      _evt,
      shopId: string,
      sessionId: string | undefined,
      file: { name?: string; size?: number; type?: string },
      _clientMessageId?: string,
    ) => {
      try {
        const id = validateShopId(shopId);
        // sessionId 可省略：附件选择阶段会话可能尚未确定，此时不写消息记录
        const sessId = sessionId ? validateString(sessionId, 'sessionId', 128) : '';
        // 大小与类型白名单校验
        const ALLOWED_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.doc', '.docx', '.xlsx'];
        const MAX_BYTES = 20 * 1024 * 1024;
        const name = typeof file?.name === 'string' ? file.name : '';
        const dot = name.lastIndexOf('.');
        const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
        if (!ALLOWED_EXT.includes(ext)) {
          throw new Error(`不支持的文件类型: ${ext || '未知'}`);
        }
        if (typeof file?.size === 'number' && file.size > MAX_BYTES) {
          throw new Error('文件超过 20MB 限制');
        }
        // 尚未实现平台级附件发送：明确返回 manual_only，由用户在平台页面发送。
        // 只有在会话已确定时才记录占位消息，避免污染会话时间线。
        if (sessId) {
          backend.db.conversationMessages.upsert({
            shopId: id,
            sessionId: sessId,
            messageId: `attachment:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
            direction: 'out',
            source: 'manual',
            content: `[附件] ${name}`,
            status: 'manual_only',
          });
        }
        return {
          ok: true,
          status: 'manual_only' as const,
          message: '当前平台不支持通过工作台发送附件，请在平台页面发送',
        };
      } catch (err) {
        backend.logger.error({ err, shopId }, '附件发送失败');
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  /** 会话草稿：本地持久化，切换会话不串草稿 */
  ipcMain.handle(
    'conversation:draft',
    async (_evt, shopId: string, sessionId: string, draft?: string) => {
      const id = validateShopId(shopId);
      const sessId = validateString(sessionId, 'sessionId', 128);
      if (typeof draft === 'string') {
        backend.db.conversationDrafts.save(id, sessId, draft);
        return { ok: true, draft };
      }
      const record = backend.db.conversationDrafts.get(id, sessId);
      return { ok: true, draft: record?.draft ?? '' };
    },
  );

  /** 全局搜索：按店铺/类型分组，取消旧请求由渲染层 revision 负责 */
  ipcMain.handle(
    'search:global',
    async (_evt, query: string, opts?: { types?: string[]; shopIds?: string[]; limit?: number }) => {
      try {
        const kw = validateString(query, '搜索关键词', 200);
        const lim = typeof opts?.limit === 'number' && opts.limit > 0 ? Math.min(opts.limit, 100) : 20;
        const requestedShopIds = Array.isArray(opts?.shopIds) && opts.shopIds.length > 0
          ? opts.shopIds.map(validateShopId)
          : backend.db.shops.list().map((s) => s.shopId);
        const types = new Set(opts?.types ?? ['messages', 'shops', 'products', 'orders']);
        const groups: Array<{ type: string; items: unknown[] }> = [];

        if (types.has('messages')) {
          const items: unknown[] = [];
          for (const sid of requestedShopIds) {
            for (const m of backend.db.conversationMessages.search(sid, kw, lim)) {
              items.push(m);
              if (items.length >= lim) break;
            }
            if (items.length >= lim) break;
          }
          groups.push({ type: 'messages', items });
        }
        if (types.has('shops')) {
          const items = backend.db.shops.list()
            .filter((s) => requestedShopIds.includes(s.shopId) && s.shopName.includes(kw))
            .slice(0, lim);
          groups.push({ type: 'shops', items });
        }
        if (types.has('products')) {
          const items: unknown[] = [];
          for (const sid of requestedShopIds) {
            const products = await backend.productManager.listProducts(sid);
            for (const product of products) {
              const haystack = [product.name, product.sku, ...(product.keywords ?? [])].join(' ');
              if (!haystack.toLowerCase().includes(kw.toLowerCase())) continue;
              items.push({
                shopId: sid,
                productId: product.product_id,
                name: product.name,
                sku: product.sku,
                price: product.variants?.[0]?.price ?? null,
              });
              if (items.length >= lim) break;
            }
            if (items.length >= lim) break;
          }
          groups.push({ type: 'products', items });
        }
        if (types.has('orders')) {
          groups.push({ type: 'orders', items: backend.db.orderSnapshots.search(requestedShopIds, kw, lim) });
        }
        return { ok: true, query: kw, groups, total: groups.reduce((n, g) => n + g.items.length, 0) };
      } catch (err) {
        backend.logger.error({ err, query }, '全局搜索失败');
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  /** 只读订单摘要：命中缓存则返回，未命中返回空状态由渲染层提示 */
  ipcMain.handle(
    'order:summary',
    async (_evt, shopId: string, sessionId: string, orderRef: string) => {
      const id = validateShopId(shopId);
      const sessId = validateString(sessionId, 'sessionId', 128);
      const ref = validateString(orderRef, 'orderRef', 128);
      const snapshot = backend.db.orderSnapshots.get(id, sessId, ref);
      if (!snapshot) {
        return { ok: true, snapshot: null, message: '暂无订单摘要' };
      }
      return { ok: true, snapshot };
    },
  );

  /** 从平台页面抓取并缓存只读订单摘要（ORDER-SUMMARY-001）。sessionId 可省略。 */
  ipcMain.handle(
    'order:capture',
    async (_evt, shopId: string, sessionId?: string) => {
      try {
        const id = validateShopId(shopId);
        const sessId = sessionId ? validateString(sessionId, 'sessionId', 128) : undefined;
        const captured = await backend.supervisor.captureOrderSnapshot(id, sessId);
        if (!captured) {
          return { ok: true, snapshot: null, message: '当前平台或页面暂无可读取的订单摘要' };
        }
        return { ok: true, snapshot: captured };
      } catch (err) {
        backend.logger.error({ err, shopId, sessionId }, '抓取订单摘要失败');
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  /** 转接记录：持久化 transfer_events，区分页面转接/通用接管 */
  ipcMain.handle(
    'transfer:history',
    async (_evt, shopId: string, sessionId?: string, limit?: number) => {
      const id = validateShopId(shopId);
      const lim = typeof limit === 'number' && limit > 0 ? Math.min(limit, 200) : 50;
      if (sessionId) {
        const sessId = validateString(sessionId, 'sessionId', 128);
        return backend.db.transferEvents.listBySession(id, sessId, lim);
      }
      return backend.db.transferEvents.listByShop(id, lim);
    },
  );

  /** 工作台布局：主进程统一计算 WebContentsView bounds */
  ipcMain.handle(
    'workspace:setLayout',
    async (
      _evt,
      layout: { sidebarWidth?: number; rightPanelWidth?: number; rightPanelVisible?: boolean },
    ) => {
      const applied = backend.webviewManager.setWorkspaceLayout?.(layout ?? {});
      return { ok: true, layout: applied ?? null };
    },
  );

  // ============ 审计相关 ============

  ipcMain.handle('audit:list', async (_evt, shopId: string, limit?: number) => {
    const id = validateShopId(shopId);
    return backend.db.audit.listRecent(id, limit ?? 50);
  });

  // ============ 指标相关 ============

  ipcMain.handle(
    'metrics:summary',
    async (_evt, sinceMs: number = Date.now() - 3600000, shopId?: string) => {
      const since =
        typeof sinceMs === 'number' && sinceMs > 0 ? sinceMs : Date.now() - 3600000;
      const sid = shopId ? validateShopId(shopId) : undefined;
      const db = backend.db;
      const tokenByType = db.metrics.sumByTag('token_consumed_total', since, 'type', sid);
      // 修复：avgApiLatency 直接从 ai_reply_audit.latency_ms 计算，比通过 metrics 表的
      // api_latency_ms_avg 聚合更准确（metrics 表存的是每轮 flush 的平均值，且 metric_name
      // 为 api_latency_ms_avg 而非 api_latency_ms，旧实现永远返回 0）
      return {
        since,
        shopId: sid ?? null,
        apiCalls: db.metrics.sumMetric('api_call_total', since, sid),
        tokensInput: tokenByType.get('input') ?? 0,
        tokensOutput: tokenByType.get('output') ?? 0,
        messagesReceived: db.metrics.sumMetric('message_received_total', since, sid),
        repliesSent: db.metrics.sumMetric('reply_sent_total', since, sid),
        replyFailed: db.metrics.sumMetric('reply_failed_total', since, sid),
        rateLimitRejected: db.metrics.sumMetric('rate_limit_rejected_total', since, sid),
        sensitiveBlocked: db.metrics.sumMetric('sensitive_block_total', since, sid),
        stateTransitions: db.metrics.sumMetric('state_transition_total', since, sid),
        avgApiLatency: db.audit.avgLatencySince(since, sid),
      };
    },
  );

  ipcMain.handle(
    'metrics:history',
    async (_evt, metricName: string, sinceMs: number, untilMs?: number, shopId?: string) => {
      const name = validateString(metricName, '指标名', 100);
      const since = typeof sinceMs === 'number' && sinceMs > 0 ? sinceMs : Date.now() - 3600000;
      const until = typeof untilMs === 'number' && untilMs > 0 ? untilMs : Date.now();
      // 自适应桶大小：根据时间窗口选择合适的粒度，避免长查询返回过多空桶
      // < 1h: 1 分钟桶 | < 1d: 5 分钟桶 | < 7d: 1 小时桶 | >= 7d: 1 天桶
      const rangeMs = until - since;
      const bucketMs =
        rangeMs <= 3600000
          ? 60000
          : rangeMs <= 86400000
            ? 300000
            : rangeMs <= 7 * 86400000
              ? 3600000
              : 86400000;
      const sid = shopId ? validateShopId(shopId) : undefined;
      const buckets = backend.db.metrics.listBuckets(name, since, until, bucketMs, sid);
      return {
        metricName: name,
        since,
        until,
        bucketMs,
        shopId: sid ?? null,
        buckets,
      };
    },
  );

  // ============ 诊断相关 ============

  ipcMain.handle('diagnose:run', async () => {
    return backend.diagnostics.runAll();
  });

  ipcMain.handle('diagnose:health', async () => {
    return backend.diagnostics.healthCheck();
  });

  // 诊断：返回所有 WebContentsView 的当前状态
  ipcMain.handle('diagnose:viewState', async () => {
    try {
      const state = backend.webviewManager.diagnoseViews?.();
      backend.logger.info({ state }, '诊断: WebContentsView 状态');
      // 同时捕获活跃店铺的页面截图和 viewport 信息
      const activeId = backend.webviewManager.getActiveShopId();
      if (activeId) {
        try {
          const wc = backend.webviewManager.getCapturableWebContents?.(activeId) as
            | Electron.WebContents
            | null
            | undefined;
          if (wc && !wc.isDestroyed()) {
            const viewport = await wc.executeJavaScript('JSON.stringify({innerWidth: window.innerWidth, innerHeight: window.innerHeight, visibilityState: document.visibilityState, hidden: document.hidden, bodyChildCount: document.body ? document.body.childElementCount : -1, bodyTextLength: document.body ? document.body.innerText.length : 0})');
            const image = await wc.capturePage();
            // 诊断截图写入可写数据目录的 logs 下，避免打包后写进安装目录
            const screenshotPath = resolveData(
              backend.config.app.data_dir,
              'logs',
              `feige-diag-${Date.now()}.png`,
            );
            await fs.writeFile(screenshotPath, image.toPNG());
            backend.logger.info({ shopId: activeId, viewport, screenshotPath }, '诊断: 活跃店铺页面截图已保存');
          }
        } catch (err) {
          backend.logger.warn({ err, shopId: activeId }, '诊断: 捕获页面截图失败');
        }
      }
      return { ok: true, state };
    } catch (err) {
      backend.logger.error({ err }, '诊断: 获取 view 状态失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 诊断：检查指定店铺的自动回复配置状态
  ipcMain.handle('diagnostic:checkAutoReply', async (_evt, shopId: string) => {
    try {
      const id = validateShopId(shopId);
      const shopConfig = backend.db.shops.get(id);
      if (!shopConfig) {
        return { ok: false, error: `店铺 ${id} 不存在` };
      }
      const loginStatus = backend.webviewManager.getLoginStatus(id);
      const hasShop = backend.supervisor.hasShop(id);
      const state = backend.supervisor.getShopState(id);
      const apiKey = backend.deepseekClient.currentApiKey;
      const apiKeyConfigured = !!apiKey && apiKey.length > 0;
      const ruleEngine = backend.supervisor.getRuleEngine(id);
      const ruleCount = ruleEngine ? ruleEngine.listRules().length : 0;
      const platformUrl = backend.config.platforms[shopConfig.platform]?.web_url || '';
      return {
        ok: true,
        report: {
          shopId: id,
          shopName: shopConfig.shopName,
          platform: shopConfig.platform,
          autoReply: shopConfig.autoReply,
          loginStatus,
          hasShop,
          state,
          apiKeyConfigured,
          apiKeyPreview: apiKeyConfigured
            ? `${apiKey.slice(0, 8)}${'*'.repeat(Math.max(0, apiKey.length - 12))}${apiKey.slice(-4)}`
            : '未配置',
          ruleCount,
          platformUrl,
          issues: [
            ...(shopConfig.autoReply ? [] : ['自动回复已关闭']),
            ...(loginStatus === 'logged_out' ? ['平台登录已过期'] : []),
            ...(!apiKeyConfigured ? ['DeepSeek API Key 未配置'] : []),
            ...(!hasShop ? ['店铺未启动'] : []),
            ...(ruleCount === 0 ? ['规则引擎无规则'] : []),
          ],
        },
      };
    } catch (err) {
      backend.logger.error({ err, shopId }, '诊断自动回复失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 诊断：测试回复（执行完整 AI 管线但不发送）
  ipcMain.handle('diagnostic:testReply', async (_evt, shopId: string, message: string) => {
    try {
      const id = validateShopId(shopId);
      const msg = validateString(message, '测试消息', 1000);
      const result = await backend.supervisor.testReply(id, msg);
      return { ok: true, result };
    } catch (err) {
      backend.logger.error({ err, shopId }, '测试回复失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('diagnostic:systemHealth', async () => {
    try {
      const mem = process.memoryUsage();
      const db = backend.db;
      const since = Date.now() - 3600000;

      const tableCounts = db.transaction(() => {
        // 表名必须与 Database.ts 中实际创建的表一致（此前 audit_log/feedback 等旧名导致显示 -1）
        const tables = ['shop_config', 'ai_reply_audit', 'dialogue_feedback', 'quality_scores', 'learned_patterns', 'metrics', 'escalation_queue', 'conversation_context', 'intent_classification'];
        const counts: Record<string, number> = {};
        for (const t of tables) {
          try {
            const row = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number };
            counts[t] = row.c;
          } catch {
            counts[t] = -1;
          }
        }
        return counts;
      });

      let walMode = 'unknown';
      let dbSizeBytes = 0;
      try {
        const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string };
        walMode = journal?.journal_mode ?? 'unknown';
      } catch {}
      try {
        const dbPath = backend.config.app.data_dir
          ? path.join(backend.config.app.data_dir, 'app.db')
          : 'data/app.db';
        const stat = await fs.stat(dbPath);
        dbSizeBytes = stat.size;
      } catch {}

      const cacheStats = backend.lruCache.getStats();
      const circuit = backend.deepseekClient.getCircuitState();
      const shops = backend.db.shops.list();
      const shopStatuses = shops.map((s) => ({
        shopId: s.shopId,
        shopName: s.shopName,
        platform: s.platform,
        autoReply: s.autoReply,
        loginStatus: backend.webviewManager.getLoginStatus(s.shopId),
        state: backend.supervisor.getShopState(s.shopId),
      }));

      const metrics = {
        apiCalls: db.metrics.sumMetric('api_call_total', since),
        messagesReceived: db.metrics.sumMetric('message_received_total', since),
        repliesSent: db.metrics.sumMetric('reply_sent_total', since),
        replyFailed: db.metrics.sumMetric('reply_failed_total', since),
        sensitiveBlocked: db.metrics.sumMetric('sensitive_block_total', since),
        // 指标名不匹配修复：metrics 表落库为 api_latency_ms_avg，此处直接取 audit 表真实延迟
        avgApiLatency: db.audit.avgLatencySince(since),
      };

      return {
        ok: true,
        health: {
          uptime: process.uptime(),
          pid: process.pid,
          memory: {
            heapUsed: mem.heapUsed,
            heapTotal: mem.heapTotal,
            rss: mem.rss,
            external: mem.external,
          },
          database: {
            walMode,
            dbSizeBytes,
            tableCounts,
          },
          cache: cacheStats,
          deepseek: {
            apiKeyConfigured: !!backend.deepseekClient.currentApiKey,
            circuitState: circuit.state,
            consecutiveFailures: circuit.consecutiveFailures,
            circuitOpenedAt: circuit.openedAt,
          },
          shops: shopStatuses,
          metrics,
          timestamp: Date.now(),
        },
      };
    } catch (err) {
      backend.logger.error({ err }, '获取系统健康概览失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('db:backup', async () => {
    try {
      const backupPath = await backend.db.backup();
      backend.logger.info({ backupPath }, '数据库备份完成');
      return { ok: true, path: backupPath };
    } catch (err) {
      backend.logger.error({ err }, '数据库备份失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ============ 规则引擎相关 ============

  function resolveRuleEngine(shopId?: string): RuleEngine {
    if (!shopId) return backend.ruleEngine;
    const id = validateShopId(shopId);
    const runningEngine = backend.supervisor.getRuleEngine(id);
    if (runningEngine) return runningEngine;

    // 停止中的店铺仍允许管理规则，但必须使用该店铺自己的持久化路径，
    // 绝不能静默回退到全局 RuleEngine。
    const shop = backend.db.shops.get(id);
    if (!shop) throw new Error(`店铺 ${id} 不存在`);
    const biz = backend.db.shopBusiness.getOrDefault(id);
    return new RuleEngine(backend.config, id, {
      deliveryAddress: biz.deliveryAddress,
      deliveryTime: biz.deliveryTime,
      freightInsurance: biz.freightInsurance,
      expressCompanies: biz.expressCompanies,
      freeShipping: biz.freeShipping,
      freeShippingCondition: biz.freeShippingCondition,
      mainCategory: biz.mainCategory,
    }, shop.platform);
  }

  ipcMain.handle('rule:list', async (_evt, shopId?: string) => {
    return resolveRuleEngine(shopId).listRules();
  });

  ipcMain.handle('rule:add', async (_evt, shopId: string | undefined, rule: Record<string, unknown>) => {
    try {
      const name = validateString(rule?.name, '规则名称', 50);
      const pattern = validateString(rule?.pattern, '规则正则', 500);
      const answer = validateString(rule?.answer, '规则回复', 2000);
      const validated = { ...rule, name, pattern, answer } as unknown as Parameters<typeof backend.ruleEngine.addRule>[0];
      resolveRuleEngine(shopId).addRule(validated);
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, shopId }, '添加规则失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('rule:update', async (_evt, shopId: string | undefined, name: string, updates: Record<string, unknown>) => {
    try {
      const n = validateString(name, '规则名称', 50);
      resolveRuleEngine(shopId).updateRule(n, updates);
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, shopId, name }, '更新规则失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('rule:delete', async (_evt, shopId: string | undefined, name: string) => {
    try {
      const n = validateString(name, '规则名称', 50);
      resolveRuleEngine(shopId).deleteRule(n);
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, shopId, name }, '删除规则失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('rule:reload', async () => {
    backend.supervisor.reloadAllRules();
    return { ok: true };
  });

  ipcMain.handle('rule:import', async (_evt, shopId: string | undefined, json: string) => {
    try {
      const j = validateString(json, '规则 JSON', 100000);
      return resolveRuleEngine(shopId).importRules(j);
    } catch (err) {
      backend.logger.error({ err, shopId }, '导入规则失败');
      return { imported: 0, errors: [err instanceof Error ? err.message : String(err)] };
    }
  });

  ipcMain.handle('rule:export', async (_evt, shopId?: string) => {
    try {
      const rules = resolveRuleEngine(shopId).listRules();
      return JSON.stringify({ rules }, null, 2);
    } catch (err) {
      backend.logger.error({ err, shopId }, '导出规则失败');
      return '[]';
    }
  });

  ipcMain.handle('rule:test', async (_evt, shopId: string | undefined, text: string) => {
    const t = validateString(text, '测试文本', 5000);
    return resolveRuleEngine(shopId).match(t);
  });

  // ============ FAQ 管理相关 ============

  ipcMain.handle('faq:list', async (_evt, shopId?: string) => {
    return resolveRuleEngine(shopId).listFaqs();
  });

  ipcMain.handle('faq:add', async (_evt, shopId: string, faq: Record<string, unknown>) => {
    try {
      const q = validateString(faq.q, '问题', 500);
      const a = validateString(faq.a, '回复', 2000);
      const priority = Number(faq.priority) || 75;
      resolveRuleEngine(shopId).addFaq({ q, a, priority });
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, shopId }, '添加FAQ失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('faq:update', async (_evt, shopId: string, index: number, updates: Record<string, unknown>) => {
    try {
      const upd: Partial<{ q: string; a: string; priority: number }> = {};
      if (updates.q !== undefined) upd.q = validateString(updates.q, '问题', 500);
      if (updates.a !== undefined) upd.a = validateString(updates.a, '回复', 2000);
      if (updates.priority !== undefined) upd.priority = Number(updates.priority) || 75;
      resolveRuleEngine(shopId).updateFaq(index, upd);
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, shopId, index }, '更新FAQ失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('faq:delete', async (_evt, shopId: string, index: number) => {
    try {
      resolveRuleEngine(shopId).deleteFaq(index);
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, shopId, index }, '删除FAQ失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('faq:export', async (_evt, shopId?: string) => {
    try {
      const faqs = resolveRuleEngine(shopId).listFaqs();
      return JSON.stringify({ faqs }, null, 2);
    } catch (err) {
      backend.logger.error({ err, shopId }, '导出FAQ失败');
      return '[]';
    }
  });

  ipcMain.handle('faq:import', async (_evt, shopId: string, json: string) => {
    try {
      const id = validateShopId(shopId);
      const j = validateString(json, 'FAQ JSON', 100000);
      let data: unknown;
      try {
        data = JSON.parse(j);
      } catch {
        throw new Error('JSON 格式无效');
      }
      const arr: Array<{ q?: string; a?: string; priority?: number }> = Array.isArray(data)
        ? (data as Array<{ q?: string; a?: string; priority?: number }>)
        : Array.isArray((data as { faqs?: unknown }).faqs)
          ? ((data as { faqs: Array<{ q?: string; a?: string; priority?: number }> }).faqs)
          : [];
      const engine = resolveRuleEngine(id);
      let imported = 0;
      const errors: string[] = [];
      for (const f of arr) {
        if (!f.q || !f.a) {
          errors.push(`FAQ 缺少 q/a: ${JSON.stringify(f).slice(0, 80)}`);
          continue;
        }
        engine.addFaq({ q: f.q, a: f.a, priority: f.priority ?? 75 });
        imported++;
      }
      return { imported, errors };
    } catch (err) {
      backend.logger.error({ err, shopId }, '导入FAQ失败');
      return { imported: 0, errors: [err instanceof Error ? err.message : String(err)] };
    }
  });

  // ============ 商品管理相关 ============

  ipcMain.handle('product:list', async (_evt, shopId: string) => {
    const id = validateShopId(shopId);
    return backend.productManager.listProducts(id);
  });

  ipcMain.handle('product:get', async (_evt, shopId: string, productId: string) => {
    const id = validateShopId(shopId);
    const pid = validateString(productId, 'productId', 64);
    return backend.productManager.getProduct(id, pid);
  });

  ipcMain.handle('product:add', async (_evt, shopId: string, product: Record<string, unknown>) => {
    try {
      const id = validateShopId(shopId);
      await backend.productManager.addProduct(id, product as unknown as Parameters<typeof backend.productManager.addProduct>[1]);
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, shopId }, '添加商品失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('product:update', async (_evt, shopId: string, productId: string, updates: Record<string, unknown>) => {
    try {
      const id = validateShopId(shopId);
      const pid = validateString(productId, 'productId', 64);
      await backend.productManager.updateProduct(id, pid, updates);
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, shopId, productId }, '更新商品失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('product:delete', async (_evt, shopId: string, productId: string) => {
    try {
      const id = validateShopId(shopId);
      const pid = validateString(productId, 'productId', 64);
      await backend.productManager.deleteProduct(id, pid);
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, shopId, productId }, '删除商品失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('product:import', async (_evt, shopId: string, json: string) => {
    const id = validateShopId(shopId);
    const j = validateString(json, '商品 JSON', 100000);
    return backend.productManager.importProducts(id, j);
  });

  ipcMain.handle('product:sync', async (evt, shopId: string) => {
    const id = validateShopId(shopId);
    const sender = evt.sender;
    return backend.productSyncService.syncShopProducts(id, (progress) => {
      sender.send('sync:progress', { shopId: id, ...progress });
    });
  });

  ipcMain.handle('product:syncStatus', async (_evt, shopId: string) => {
    const id = validateShopId(shopId);
    return backend.productSyncService.getSyncStatus(id);
  });

  ipcMain.handle('product:diagnoseSidebar', async (_evt, shopId: string) => {
    const id = validateShopId(shopId);
    try {
      const result = await backend.productSyncService.diagnoseProductSidebar(id);
      return { ok: true, data: result };
    } catch (err) {
      backend.logger.error({ err, shopId: id }, '商品面板诊断失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('product:diagnoseListPage', async (_evt, shopId: string) => {
    const id = validateShopId(shopId);
    try {
      const result = await backend.productSyncService.diagnoseProductListPage(id);
      return { ok: true, data: result };
    } catch (err) {
      backend.logger.error({ err, shopId: id }, '商家后台商品页面诊断失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ============ 测试回复相关 ============

  ipcMain.handle('test:reply', async (_evt, shopId: string, message: string) => {
    try {
      const id = validateShopId(shopId);
      const msg = validateString(message, '测试消息', 5000);
      return backend.supervisor.testReply(id, msg);
    } catch (err) {
      backend.logger.error({ err, shopId }, '测试回复失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ============ 知识库相关 ============

  const promptPath = resolveResource('config', 'prompt', 'customer-service.md');
  const sensitiveWordsPath = resolveResource('config', 'dict', 'sensitive-words.txt');
  // 全局配置（prompt/sensitive）的版本管理使用 'global' 作为虚拟 shopId
  const globalVersionMgr = new VersionManager(backend.config, backend.logger);
  const GLOBAL_SHOP_ID = 'global';

  ipcMain.handle('kb:getPrompt', async () => {
    if (await fs.pathExists(promptPath)) {
      return await fs.readFile(promptPath, 'utf8');
    }
    return '';
  });

  ipcMain.handle('kb:savePrompt', async (_evt, content: string) => {
    try {
      const c = validateString(content, 'Prompt 内容', 50000);
      // 修改前创建版本快照（便于回滚 = 撤销）
      try {
        const prev = (await fs.pathExists(promptPath)) ? await fs.readFile(promptPath, 'utf8') : '';
        await globalVersionMgr.createVersion(GLOBAL_SHOP_ID, 'prompt', prev, '保存 Prompt 前快照', 'update');
      } catch (err) {
        backend.logger.warn({ err }, '创建 Prompt 版本快照失败（不阻断主流程）');
      }
      await fs.ensureDir(path.dirname(promptPath));
      await fs.writeFile(promptPath, c, 'utf8');
      backend.logger.info('Prompt 模板已更新');
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err }, '保存 Prompt 失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('kb:getSensitiveWords', async () => {
    if (!(await fs.pathExists(sensitiveWordsPath))) {
      return [];
    }
    const raw = await fs.readFile(sensitiveWordsPath, 'utf8');
    const words: Array<{ word: string; category: string; action: string }> = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split('|');
      if (parts.length === 3) {
        words.push({ word: parts[0].trim(), category: parts[1].trim(), action: parts[2].trim() });
      }
    }
    return words;
  });

  ipcMain.handle('kb:saveSensitiveWords', async (_evt, words: Array<{ word: string; category: string; action: string }>) => {
    try {
      if (!Array.isArray(words)) {
        throw new Error('敏感词列表格式无效');
      }
      // 修改前创建版本快照
      try {
        const prev = (await fs.pathExists(sensitiveWordsPath)) ? await fs.readFile(sensitiveWordsPath, 'utf8') : '';
        await globalVersionMgr.createVersion(GLOBAL_SHOP_ID, 'sensitive', prev, '保存敏感词库前快照', 'update');
      } catch (err) {
        backend.logger.warn({ err }, '创建敏感词版本快照失败（不阻断主流程）');
      }
      await fs.ensureDir(path.dirname(sensitiveWordsPath));
      const lines: string[] = [
        '# 敏感词库',
        '# 格式：词语|类别|处理方式',
        '# 处理方式：block(拦截不发送) | warn(告警但发送) | replace(替换为***)',
        '# 详见 docs/21-进程模型与运行细节.md §21.6',
        '',
      ];
      const byCategory = new Map<string, Array<{ word: string; category: string; action: string }>>();
      for (const w of words) {
        const cat = w.category || 'other';
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push(w);
      }
      for (const [cat, items] of byCategory) {
        lines.push(`# ========== ${cat} ==========`);
        for (const item of items) {
          const word = validateString(item.word, '敏感词', 50);
          const action = item.action === 'block' || item.action === 'warn' || item.action === 'replace' ? item.action : 'warn';
          lines.push(`${word}|${cat}|${action}`);
        }
        lines.push('');
      }
      await fs.writeFile(sensitiveWordsPath, lines.join('\n'), 'utf8');
      backend.logger.info({ count: words.length }, '敏感词库已更新');
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err }, '保存敏感词库失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('kb:reloadSensitiveWords', async () => {
    await backend.sensitiveChecker.reload();
    backend.logger.info('敏感词库已重新加载');
    return { ok: true };
  });

  // ============ 对话反馈相关 ============

  ipcMain.handle(
    'feedback:add',
    async (_evt, auditId: number, shopId: string, sessionId: string, rating: number, comment?: string) => {
      try {
        const aid = typeof auditId === 'number' && auditId > 0 ? auditId : NaN;
        if (Number.isNaN(aid)) throw new Error('auditId 无效');
        const sid = validateShopId(shopId);
        const r = typeof rating === 'number' && (rating === 1 || rating === -1) ? rating : NaN;
        if (Number.isNaN(r)) throw new Error('rating 必须为 1 或 -1');
        const cmt = comment ? validateString(comment, '反馈备注', 1000) : undefined;

        // 归属校验：auditId 必须属于传入的 shopId，防止跨店铺越权污染反馈/质量/学习数据（DATA-01）
        const auditRecord = backend.db.audit.findById(aid);
        if (!auditRecord || auditRecord.shopId !== sid) {
          throw new Error(`审计记录 ${aid} 不属于店铺 ${sid}`);
        }
        if (sessionId && auditRecord.sessionId && auditRecord.sessionId !== sessionId) {
          backend.logger.warn(
            { shopId: sid, auditId: aid, auditSession: auditRecord.sessionId, sessionId },
            '反馈的会话与审计记录不一致，仍以审计记录为准写入',
          );
        }

        backend.db.feedback.add({
          auditId: aid,
          shopId: sid,
          sessionId,
          rating: r,
          comment: cmt,
        });

        backend.db.quality.updateFeedbackScore(aid, r > 0 ? 1.0 : 0.0);

        // auditRecord 已在上方归属校验中取得（同一次查询），直接复用
        if (auditRecord.modelVersion.startsWith('learned:')) {
          const patternId = Number(auditRecord.modelVersion.split(':')[1]);
          if (!Number.isNaN(patternId) && patternId > 0 && backend.patternMatcher) {
            backend.patternMatcher.recordFeedback(patternId, r);
          }
        }

        return { ok: true };
      } catch (err) {
        backend.logger.error({ err, shopId, auditId }, '添加反馈失败');
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle('feedback:list', async (_evt, shopId: string, limit?: number) => {
    const sid = validateShopId(shopId);
    const lim = typeof limit === 'number' && limit > 0 ? Math.min(limit, 500) : 100;
    return backend.db.feedback.listByShop(sid, lim);
  });

  ipcMain.handle('feedback:stats', async (_evt, shopId: string) => {
    const sid = validateShopId(shopId);
    return backend.db.feedback.getStats(sid);
  });

  // ============ 学习管道相关 ============

  ipcMain.handle('learning:patterns', async (_evt, shopId: string) => {
    const sid = validateShopId(shopId);
    // 返回全部状态（含 deprecated），前端"已弃用"筛选此前永远为空（死功能）
    return backend.db.learning.listPatterns(sid);
  });

  ipcMain.handle('learning:runs', async (_evt, shopId?: string, limit?: number) => {
    const lim = typeof limit === 'number' && limit > 0 ? Math.min(limit, 100) : 10;
    const sid = shopId ? validateShopId(shopId) : null;
    return backend.db.learning.listRuns(sid, lim);
  });

  ipcMain.handle('learning:trigger', async (_evt, shopId?: string) => {
    try {
      const sid = shopId ? validateShopId(shopId) : undefined;
      if (!backend.learningPipeline) {
        throw new Error('学习管道未启用');
      }
      const result = await backend.learningPipeline.run(sid);
      return { ok: true, ...result };
    } catch (err) {
      backend.logger.error({ err, shopId }, '学习管道触发失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('learning:stats', async (_evt, shopId: string) => {
    const sid = validateShopId(shopId);
    const patterns = backend.db.learning.listPatterns(sid);
    const totalMatches = patterns.reduce((s, p) => s + p.matchCount, 0);
    const positive = patterns.reduce((s, p) => s + (p.feedbackSum > 0 ? p.feedbackSum : 0), 0);
    const negative = patterns.reduce((s, p) => s + (p.feedbackSum < 0 ? -p.feedbackSum : 0), 0);
    const avgQuality =
      patterns.length > 0
        ? patterns.reduce((s, p) => s + p.avgQuality, 0) / patterns.length
        : 0;
    return {
      totalPatterns: patterns.length,
      activePatterns: patterns.filter((p) => p.status === 'active').length,
      totalMatches,
      avgQuality,
      positiveFeedback: positive,
      negativeFeedback: negative,
    };
  });

  // ============ 意图分析相关 ============

  ipcMain.handle('intent:recent', async (_evt, shopId: string, limit?: number) => {
    const id = validateShopId(shopId);
    const lim = typeof limit === 'number' && limit > 0 ? Math.min(limit, 500) : 50;
    return backend.db.intent.listRecent(id, lim);
  });

  ipcMain.handle('intent:stats', async (_evt, shopId: string, sinceMs?: number) => {
    const id = validateShopId(shopId);
    const since = typeof sinceMs === 'number' && sinceMs > 0 ? sinceMs : Date.now() - 86400000;
    return {
      categoryStats: backend.db.intent.getCategoryStats(id, since),
      escalationStats: backend.db.intent.getEscalationStats(id, since),
    };
  });

  // ============ 升级队列相关 ============

  ipcMain.handle('escalation:list', async (_evt, shopId: string, status?: string) => {
    const id = validateShopId(shopId);
    return backend.db.intent.listEscalations(id, status);
  });

  ipcMain.handle('escalation:resolve', async (_evt, escalationId: number, resolution?: string) => {
    try {
      if (typeof escalationId !== 'number' || escalationId <= 0) throw new Error('escalationId 无效');
      const res = resolution ? validateString(resolution, '处理结果', 1000) : undefined;
      backend.db.intent.updateEscalationStatus(escalationId, 'resolved', undefined, res);
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, escalationId }, '解决升级失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('escalation:stats', async (_evt, shopId: string, sinceMs?: number) => {
    const id = validateShopId(shopId);
    const since = typeof sinceMs === 'number' && sinceMs > 0 ? sinceMs : Date.now() - 86400000;
    return backend.db.intent.getEscalationStats(id, since);
  });

  // ============ 人工坐席相关 ============

  ipcMain.handle('agent:queue', async (_evt, shopId: string) => {
    const id = validateShopId(shopId);
    return backend.escalationHandler?.queue.list(id) ?? [];
  });

  ipcMain.handle('agent:list', async (_evt, shopId: string) => {
    const id = validateShopId(shopId);
    return backend.db.agent.listByShop(id);
  });

  ipcMain.handle('agent:refresh', async (_evt, shopId: string) => {
    const id = validateShopId(shopId);
    try {
      const agents = backend.db.agent.listByShop(id);
      return { ok: true, agents };
    } catch (err) {
      return { ok: false, agents: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('agent:assign', async (_evt, escalationId: unknown, agentId: unknown) => {
    try {
      if (
        typeof escalationId !== 'number' ||
        !Number.isSafeInteger(escalationId) ||
        escalationId <= 0
      ) {
        throw new Error('escalationId 无效');
      }
      const validatedAgentId = validateString(agentId, 'agentId', 128);

      const assignment = backend.db.transaction(() => {
        const escalation = backend.db.intent.getEscalation(escalationId);
        if (!escalation) throw new Error('升级工单不存在');
        if (escalation.status !== 'pending') throw new Error('升级工单已被处理，请刷新后重试');

        const agent = backend.db.agent
          .listByShop(escalation.shopId)
          .find((candidate) => candidate.id === validatedAgentId);
        if (!agent) throw new Error('所选客服不存在或不属于当前店铺');
        if (agent.status !== 'available') throw new Error('所选客服当前不可接待');
        if (agent.activeChats >= agent.maxChats) throw new Error('所选客服已达到最大接待量');

        backend.db.intent.updateEscalationStatus(escalationId, 'assigned', validatedAgentId);
        backend.db.agent.incrementActiveChats(validatedAgentId);
        return { escalation, agent };
      });

      backend.escalationHandler?.queue.remove(assignment.escalation.shopId, escalationId);
      backend.metrics.inc(
        'escalation_assigned_total',
        1,
        { agent: assignment.agent.id },
        assignment.escalation.shopId,
      );
      backend.logger.info(
        {
          shopId: assignment.escalation.shopId,
          escalationId,
          agentId: assignment.agent.id,
          agentName: assignment.agent.name,
        },
        '升级工单已手动分配',
      );
      return { ok: true };
    } catch (err) {
      backend.logger.error({ err, escalationId, agentId }, '手动分配升级工单失败');
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerKbIpcHandlers(backend);

  // ============================================================
  // 跨会话买家记忆（Buyer Profile）
  // ============================================================
  ipcMain.handle('buyer:profile', async (_evt, shopId: unknown, platform: unknown, buyerName: unknown) => {
    try {
      const id = validateShopId(shopId);
      if (typeof platform !== 'string' || typeof buyerName !== 'string') {
        return { ok: false, error: 'platform 和 buyerName 必须为字符串' };
      }
      const profile = backend.db.buyerProfiles.get(id, platform, buyerName);
      return { ok: true, profile };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('buyer:list', async (_evt, shopId: unknown, platform: unknown, limit?: unknown) => {
    try {
      const id = validateShopId(shopId);
      if (typeof platform !== 'string') {
        return { ok: false, error: 'platform 必须为字符串' };
      }
      const profiles = backend.db.buyerProfiles.listByShop(id, platform, Number(limit) || 200);
      return { ok: true, profiles };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('buyer:stats', async (_evt, shopId: unknown, platform: unknown) => {
    try {
      const id = validateShopId(shopId);
      if (typeof platform !== 'string') {
        return { ok: false, error: 'platform 必须为字符串' };
      }
      const stats = backend.db.buyerProfiles.getStats(id, platform);
      return { ok: true, stats };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(
    'buyer:updateTags',
    async (_evt, shopId: unknown, platform: unknown, buyerName: unknown, tags: unknown) => {
      try {
        const id = validateShopId(shopId);
        if (typeof platform !== 'string' || typeof buyerName !== 'string' || !Array.isArray(tags)) {
          return { ok: false, error: '参数类型错误' };
        }
        backend.db.buyerProfiles.addTags(id, platform, buyerName, tags.map(String));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'buyer:updateRemark',
    async (_evt, shopId: unknown, platform: unknown, buyerName: unknown, remark: unknown) => {
      try {
        const id = validateShopId(shopId);
        if (
          typeof platform !== 'string' ||
          typeof buyerName !== 'string' ||
          typeof remark !== 'string'
        ) {
          return { ok: false, error: '参数类型错误' };
        }
        // 复用 BuyerProfileService 的清洗逻辑（trim、slice、缓存清理、日志）
        backend.buyerProfileService?.updateBuyerRemark(id, platform, buyerName, remark);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  return { alertBuffer, logBuffer };
}

function broadcast(channel: string, data: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send(channel, data);
    }
  }
}
