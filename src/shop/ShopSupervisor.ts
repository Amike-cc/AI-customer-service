/**
 * 店铺监督器
 * 详见 docs/16-状态机设计.md §16.4 和 docs/开发文档-v2.md §4
 *
 * 单店铺业务编排闭环：
 *   创建 WebContentsView → WebviewClient 连接 → 状态机驱动
 *   → 消息识别（Webview 轮询）→ AI 应答（规则→DeepSeek）
 *   → 发送回复（人工模拟）→ 上下文/限流/监控
 */
import { EventEmitter } from 'events';
import type { AppLogger } from '../logging/logger';
import type { Config } from '../config/schema';
import type { Database } from '../db/Database';
import type { ShopConfig } from '../db/repos/ShopConfigRepo';
import type { StateName } from '../state/ShopStateMachine';
import type { IWebviewManager } from '../cdp/types';
import type { VisionClient } from '../vision/VisionClient';
import { DeepSeekClient } from '../deepseek/DeepSeekClient';
import type { ModelGateway } from '../gateway/ModelGateway';
import { RuleEngine, type ShopConfigInfo } from '../rules/RuleEngine';
import { MetricsCollector } from '../monitor/MetricsCollector';
import { AlertManager } from '../monitor/AlertManager';
import { RateLimiter } from '../cache/RateLimiter';
import { LruCache } from '../cache/LruCache';
import { HumanSimulator } from '../human/HumanSimulator';
import { SensitiveWordChecker } from '../secrets/SensitiveWordChecker';
import type { Orchestrator } from '../agents/Orchestrator';
import type { PatternMatcher } from '../learning/PatternMatcher';
import type { IntentClassifier } from '../intent/IntentClassifier';
import type { ComplexityAssessor } from '../intent/ComplexityAssessor';
import type { EscalationManager } from '../intent/EscalationManager';
import type { EscalationHandler } from '../human/EscalationHandler';
import type { IEmotionDetector } from '../intent/EmotionDetector';
import { LlmIntentRecognizer } from '../intent/LlmIntentRecognizer';
import { TemplateLibrary } from '../kb/TemplateLibrary';
import type { WorkTimePolicy } from '../policy/WorkTimePolicy';
import type { DialogStateManager } from '../dialog/DialogStateManager';
import type { BuyerProfileService } from '../buyer/BuyerProfileService';
import type { ToolRegistry } from '../tools/ToolRegistry';
import { TestReplyResult, ShopInstance } from './ShopInstance';

export interface ShopSupervisorDeps {
  config: Config;
  db: Database;
  logger: AppLogger;
  metrics: MetricsCollector;
  alertManager: AlertManager;
  visionClient: VisionClient;
  deepseekClient: DeepSeekClient;
  /**
   * 模型网关：用于 LLM 二次验证等主回复路径的 LLM 调用，让多 provider 真正生效。
   * DeepSeek 故障时自动 fallback 到 tier2/tier3 其他 provider（Qwen/OpenAI/Claude 等）。
   * 注意：runTestReply 诊断路径仍直接用 deepseekClient，绕过 ModelGateway，以隔离测试 DeepSeek 真实状态。
   */
  gateway: ModelGateway;
  orchestrator: Orchestrator;
  ruleEngine: RuleEngine;
  sensitiveChecker: SensitiveWordChecker;
  webviewManager: IWebviewManager;
  rateLimiter: RateLimiter;
  lruCache: LruCache;
  humanSimulator: HumanSimulator;
  patternMatcher?: PatternMatcher;
  intentClassifier?: IntentClassifier;
  complexityAssessor?: ComplexityAssessor;
  escalationManager?: EscalationManager;
  escalationHandler?: EscalationHandler;
  emotionDetector?: IEmotionDetector;
  llmIntentRecognizer?: LlmIntentRecognizer;
  templateLibrary?: TemplateLibrary;
  workTimePolicy?: WorkTimePolicy;
  dialogStateManager?: DialogStateManager;
  buyerProfileService?: BuyerProfileService;
  toolRegistry?: ToolRegistry;
  onStateChange?: (shopId: string, state: StateName) => void;
}

export interface StartShopOptions {}

export class ShopSupervisor extends EventEmitter {
  private shops = new Map<string, ShopInstance>();

  constructor(private deps: ShopSupervisorDeps) {
    super();
  }

  hasShop(shopId: string): boolean {
    return this.shops.has(shopId);
  }

  get shopCount(): number {
    return this.shops.size;
  }

  async startShop(shopConfig: ShopConfig, options?: StartShopOptions): Promise<void> {
    if (this.shops.has(shopConfig.shopId)) {
      throw new Error(`店铺 ${shopConfig.shopId} 已启动`);
    }
    const instance = new ShopInstance(shopConfig, this.deps);
    this.shops.set(shopConfig.shopId, instance);

    // 转发 ShopInstance 的 transfer 事件到 ShopSupervisor（供 ipc-handlers 订阅广播到渲染层）
    instance.on('transfer:success', (data) => this.emit('transfer:success', data));
    instance.on('transfer:failed', (data) => this.emit('transfer:failed', data));
    // 转发平台消息记录事件（统一工作台消息时间线实时推送）
    instance.on('message:recorded', (data) => this.emit('message:recorded', data));

    try {
      await instance.start(options);
    } catch (err) {
      this.shops.delete(shopConfig.shopId);
      throw err;
    }
  }

  async stopShop(shopId: string): Promise<void> {
    const instance = this.shops.get(shopId);
    if (!instance) return;
    try {
      await instance.stop();
    } catch (err) {
      this.deps.logger.error({ shopId, err }, '停止店铺异常，强制清理');
    }
    this.shops.delete(shopId);
  }

  getShopState(shopId: string): StateName | null {
    return this.shops.get(shopId)?.currentState ?? null;
  }

  async manualTakeover(shopId: string): Promise<void> {
    const instance = this.shops.get(shopId);
    if (!instance) throw new Error(`店铺 ${shopId} 未启动`);
    await instance.manualTakeover();
  }

  async manualRelease(shopId: string): Promise<void> {
    const instance = this.shops.get(shopId);
    if (!instance) throw new Error(`店铺 ${shopId} 未启动`);
    await instance.manualRelease();
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.shops.keys()).map((id) => this.stopShop(id)));
  }

  /**
   * 切换活跃店铺：活跃店铺使用快速轮询，非活跃店铺进入后台模式以降低资源占用。
   * shopId 为 null 时所有店铺都进入后台模式。
   */
  setActiveShop(shopId: string | null): void {
    for (const [id, instance] of this.shops) {
      instance.setBackgroundMode(id !== shopId);
    }
  }

  async testReply(shopId: string, message: string): Promise<TestReplyResult> {
    const instance = this.shops.get(shopId);
    if (!instance) {
      throw new Error(`店铺 ${shopId} 未启动`);
    }
    return instance.runTestReply(message);
  }

  async sendManualReply(
    shopId: string,
    text: string,
    opts?: { sessionId?: string; clientMessageId?: string },
  ): Promise<{ status: 'sent' | 'duplicate'; clientMessageId: string | null }> {
    const instance = this.shops.get(shopId);
    if (!instance) throw new Error(`店铺 ${shopId} 未启动`);
    return instance.sendManualReply(text, opts);
  }

  async executeScriptOnShop(shopId: string, script: string): Promise<unknown> {
    const instance = this.shops.get(shopId);
    if (!instance) {
      throw new Error(`店铺 ${shopId} 未启动`);
    }
    return instance.executeScript(script);
  }

  hasShopStarted(shopId: string): boolean {
    return this.shops.has(shopId);
  }

  /** 获取店铺平台标识（feige/pinduoduo/kuaishou/weixin），未启动返回 null */
  getShopPlatform(shopId: string): string | null {
    const inst = this.shops.get(shopId);
    return inst ? inst.getPlatform() : null;
  }

  /** 获取店铺能力声明（未启动店铺返回 null） */
  getShopCapabilities(shopId: string): ReturnType<ShopInstance['getCapabilities']> | null {
    const inst = this.shops.get(shopId);
    return inst ? inst.getCapabilities() : null;
  }

  /** 抓取只读订单摘要（ORDER-SUMMARY-001）。sessionId 省略时取平台当前会话。 */
  async captureOrderSnapshot(
    shopId: string,
    sessionId?: string,
  ): Promise<{ orderRef: string; summary: string; platformUrl: string | null } | null> {
    const inst = this.shops.get(shopId);
    if (!inst) throw new Error(`店铺 ${shopId} 未启动`);
    return inst.captureOrderSnapshot(sessionId);
  }

  async reloadProductCatalog(shopId: string): Promise<void> {
    const instance = this.shops.get(shopId);
    if (!instance) throw new Error(`店铺 ${shopId} 未启动`);
    await instance.reloadProductCatalog();
  }

  /**
   * 在隐藏窗口中加载指定 URL 并执行脚本（复用店铺登录态）。
   * 用于在商家后台等非客服页面上抓取数据。
   */
  async scrapeUrlInHiddenWindow(shopId: string, url: string, script: string, timeoutMs?: number): Promise<unknown> {
    return this.deps.webviewManager.scrapeUrlInHiddenWindow(shopId, url, script, timeoutMs);
  }

  async diagnoseWithNetworkCapture(
    shopId: string,
    url: string,
    script: string,
    waitMs?: number,
    timeoutMs?: number,
  ): Promise<{
    scriptResult: unknown;
    apiRequests: Array<{ url: string; method: string; statusCode: number; contentType: string; resourceType: string }>;
  }> {
    return this.deps.webviewManager.diagnoseWithNetworkCapture(shopId, url, script, waitMs, timeoutMs);
  }

  setAutoReply(shopId: string, autoReply: boolean): void {
    const instance = this.shops.get(shopId);
    if (instance) {
      instance.setAutoReplyFlag(autoReply);
    }
    this.deps.db.shops.setAutoReply(shopId, autoReply);
    this.deps.logger.info({ shopId, autoReply }, '自动回复开关已更新');
  }

  getRuleEngine(shopId: string): RuleEngine | null {
    return this.shops.get(shopId)?.getRuleEngine() ?? null;
  }

  /** 更新指定店铺的店铺配置并重载规则引擎 */
  updateShopConfig(shopId: string, config: ShopConfigInfo | undefined): void {
    const inst = this.shops.get(shopId);
    if (!inst) return;
    inst.updateShopConfig(config);
    this.deps.logger.info({ shopId, mainCategory: config?.mainCategory }, '店铺配置已更新，规则引擎已重载');
  }

  reloadAllRules(): void {
    this.deps.ruleEngine.reloadRules();
    for (const inst of this.shops.values()) {
      inst.reloadRules();
    }
    this.deps.logger.info('所有店铺规则引擎已重载');
  }

  /** 清理所有店铺的过期会话上下文（由 backend 每小时调用，防止上下文表无限增长） */
  cleanupIdleContexts(): number {
    let total = 0;
    for (const inst of this.shops.values()) {
      try {
        total += inst.cleanupIdleContext();
      } catch (err) {
        this.deps.logger.warn({ err }, '清理过期上下文失败');
      }
    }
    return total;
  }
}

