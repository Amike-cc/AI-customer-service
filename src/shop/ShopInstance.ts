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
import fs from 'fs';
import { ShopSupervisorDeps, StartShopOptions } from './ShopSupervisor';
import crypto from 'crypto';
import { getPlatformDeepseekConfig, type PlatformDeepseekConfig } from '../config/schema';
import type { ShopConfig } from '../db/repos/ShopConfigRepo';
import { ShopStateMachine, type StateName, type StateMachineCallbacks } from '../state/ShopStateMachine';
import { WebviewClient } from '../cdp/WebviewClient';
import type { CdpMessage, IWebContents } from '../cdp/types';
import { RuleEngine, type ShopConfigInfo } from '../rules/RuleEngine';
import { ContextManager } from '../cache/ContextManager';
import { ProductMatcher } from '../product/ProductMatcher';
import type { AgentContext } from '../agents/types';
import type { IntentResult, ComplexityResult } from '../intent/types';
import { ConversionEngine } from '../conversion/ConversionEngine';
import { EmotionDetector, type IEmotionDetector } from '../intent/EmotionDetector';
import { LlmIntentRecognizer } from '../intent/LlmIntentRecognizer';
import { TemplateLibrary } from '../kb/TemplateLibrary';
import { getPlatform } from '../platform';
import type { BuyerProfileService } from '../buyer/BuyerProfileService';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type { ToolContext } from '../tools/types';
import { AGENT_ROLE_NAMES, type AgentRole } from '../tools/types';
import { resolveResource } from '../paths';

export interface ActiveSession {
  sessionId: string;
  productId?: string;
  lastMessageAt: number;
}

export interface TestReplyResult {
  shopId: string;
  reply: string;
  matchedRule?: string;
  productMatch?: { productId: string; confidence: number; matchType: string };
  sensitiveHits: string[];
  tokenInput: number;
  tokenOutput: number;
  latencyMs: number;
  pipeline: Array<{ step: string; status: 'ok' | 'skip' | 'fail'; detail?: string }>;
}

export class ShopInstance extends EventEmitter {
  private stateMachine: ShopStateMachine;
  private webviewClient: WebviewClient | null = null;
  private webContents: IWebContents | null = null;
  private productMatcher: ProductMatcher | null = null;
  private ruleEngine: RuleEngine;
  private contextManager: ContextManager;
  private emotionDetector: IEmotionDetector;
  private llmIntentRecognizer: LlmIntentRecognizer | null = null;
  private templateLibrary: TemplateLibrary;
  /** 跨会话买家记忆服务（null 表示未注入，跳过画像构建） */
  private buyerProfileService: BuyerProfileService | null = null;
  /** Function calling 工具注册中心（null 表示未注入，Agent 不执行业务动作） */
  private toolRegistry: ToolRegistry | null = null;
  private conversionEngine: ConversionEngine | null = null;
  private stopped = false;
  private sessions = new Map<string, ActiveSession>();
  private visualPollInFlight = false;
  private processedMessageHashes = new Map<string, number>();
  private recentSentReplies = new Map<string, number>();
  private lastResponseTokenOutput = 0;
  private lastReplyModelVersion = 'unknown';
  private processingSessions = new Set<string>();
  private pendingSessionMessages = new Map<string, CdpMessage>();
  private latestSessionMessages = new Map<string, CdpMessage>();
  /** 飞鸽系统信号去重：sessionId + text 摘要 → 触发时间戳，避免同一信号重复触发 manualTakeover */
  private processedAgentJoinSignals = new Map<string, number>();
  /** 会话级转人工标记：sessionId → 触发时间戳。
   *  场景：售后问题 + AI 解答不了（fallback_response/LLM 熔断/低置信度）时触发。
   *  标记后该会话不再由 AI 自动回复，等待人工客服接管。
   *  24 小时后自动过期（cleanupExpiredHashes 清理），让人工未处理时可重新由 AI 接管。 */
  private transferredSessions = new Map<string, number>();
  /** 平台生效的 AI 配置（全局配置 + 平台覆盖），用于 fallback_response/max_tokens/prompt_template 等平台级参数 */
  private platformDeepseekConfig: PlatformDeepseekConfig;
  private promptTemplateCache: string | null = null;
  private recoveryAttempts = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
  private static readonly DEDUP_MAX_SIZE = 500;
  private static readonly REPLY_ECHO_TTL_MS = 180 * 24 * 60 * 60 * 1000;
  private static readonly REPLY_ECHO_MAX_SIZE = 1000;
  private static readonly REPLY_TEXT_GUARD_TTL_MS = 24 * 60 * 60 * 1000;
  private static readonly REPLY_GUARD_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
  private static readonly SEND_RETRY_DELAY_MS = 2000;
  private static readonly MESSAGE_SETTLE_MS = 800;
  /** replyGuard 记录超过此时间且页面 DOM 仍显示未回复，视为陈旧误判，清除后重新回复。
   *  15秒阈值：发送后验证会立即检测，但网络延迟或页面渲染可能需要额外时间，
   *  15秒足够覆盖正常发送流程，同时让超时消息尽快被重新回复。 */
  private static readonly STALE_REPLY_GUARD_MS = 15 * 1000;
  private static readonly MAX_RECOVERY_ATTEMPTS = 3;
  private static readonly RECOVERY_DELAYS_MS = [5000, 15000, 45000];
  private static readonly RECOVERY_JITTER_MS = 3000; // 随机抖动上限，避免多店铺同时恢复
  /** 会话级冷却期，同一会话处理完成后 15 秒内不再处理新消息 */
  private sessionCooldowns = new Map<string, number>();
  private static readonly SESSION_COOLDOWN_MS = 15 * 1000;
  /** 存储 WebContents 事件监听器引用，用于 stop() 时清理 */
  private didFinishLoadHandler: (() => Promise<void>) | null = null;
  private crashHandlerRefs: (() => void)[] = [];
  /** 一次性定时器集合，stop() 时统一清理，避免重启/停止后回调仍触发导致异常 */
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  /** 崩溃恢复调度哨兵：一次崩溃的多个同步事件（crashed/destroyed/render-process-gone）只应触发一次恢复 */
  private recoveryScheduled = false;
  /**
   * 发送闸门版本号。人工接管或切换 AI 开关时递增，使所有在途自动回复任务失效。
   * 自动回复在发送前必须再次校验该值未变化，否则丢弃（SAFE-TAKEOVER-001 / SAFE-AI-OFF-001）。
   */
  private controlEpoch = 0;

  constructor(
    private shopConfig: ShopConfig,
    private deps: ShopSupervisorDeps,
  ) {
    super();
    this.contextManager = new ContextManager(deps.config, deps.db, deps.logger);
    // 加载平台生效的 AI 配置（全局配置 + 平台覆盖）
    this.platformDeepseekConfig = getPlatformDeepseekConfig(deps.config, shopConfig.platform);
    this.emotionDetector = this.deps.emotionDetector ?? new EmotionDetector();
    this.buyerProfileService = this.deps.buyerProfileService ?? null;
    this.toolRegistry = this.deps.toolRegistry ?? null;
    this.llmIntentRecognizer = this.deps.llmIntentRecognizer
      ?? (deps.config.intent.enabled ? new LlmIntentRecognizer(deps.gateway, deps.config) : null);
    this.templateLibrary = this.deps.templateLibrary
      ?? new TemplateLibrary(deps.config, shopConfig.shopId, deps.logger);
    // 创建规则引擎时传入店铺配置和平台 ID，加载平台专属规则、类目专属规则和店铺配置动态规则
    const bizConfig = deps.db.shopBusiness.getOrDefault(shopConfig.shopId);
    this.ruleEngine = new RuleEngine(deps.config, shopConfig.shopId, {
      deliveryAddress: bizConfig.deliveryAddress,
      deliveryTime: bizConfig.deliveryTime,
      freightInsurance: bizConfig.freightInsurance,
      expressCompanies: bizConfig.expressCompanies,
      freeShipping: bizConfig.freeShipping,
      freeShippingCondition: bizConfig.freeShippingCondition,
      mainCategory: bizConfig.mainCategory,
    }, shopConfig.platform);
    this.stateMachine = this.createStateMachine();
    // error 事件兜底：transition 回调异常（如 db 已关闭）会导致 EventEmitter 抛未处理异常，注册监听避免进程崩溃
    this.stateMachine.on('error', (err) => {
      this.deps.logger.error(
        { shopId: this.shopConfig.shopId, err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err) },
        '店铺状态机异常',
      );
    });
    this.stateMachine.on('transition', (e) => {
      this.deps.logger.info({ shopId: this.shopConfig.shopId, from: e.from, to: e.to }, '状态切换');
      this.deps.metrics.inc('state_transition_total', 1, { from: e.from, to: e.to }, this.shopConfig.shopId);
      this.deps.db.shopState.upsert({
        shopId: this.shopConfig.shopId,
        currentState: e.to,
        previousState: e.from,
        enteredAt: e.context.enteredAt,
        silentWaitCount: e.context.silentWaitCount,
        cdpRecoverAttempts: e.context.cdpRecoverAttempts,
        lastMessageAt: Date.now(),
        contextVersion: 0,
      });
      this.deps.onStateChange?.(this.shopConfig.shopId, e.to);
    });
    this.stateMachine.on('alert', (a: { level: string; message: string }) => {
      void this.deps.alertManager.fire({
        name: `state_${a.level}`,
        level: a.level as 'info' | 'warn' | 'critical',
        title: `店铺 ${this.shopConfig.shopName} 状态告警`,
        message: a.message,
        shopId: this.shopConfig.shopId,
      });
    });
    this.loadReplyGuardsFromAudit();
  }

  get currentState(): StateName {
    return this.stateMachine.currentState;
  }

  /** 获取该店铺的平台标识 */
  getPlatform(): string {
    return this.shopConfig.platform;
  }

  /** 获取平台级 AI 参数覆盖（传给 DeepSeekClient 优先于全局配置） */
  private getPlatformOverrides() {
    const cfg = this.platformDeepseekConfig;
    const overrides: {
      model?: string;
      temperature?: number;
      max_tokens?: number;
      top_p?: number;
      fallback_response?: string;
    } = {};
    // 仅传递与全局配置不同的字段，减少不必要的覆盖
    const globalCfg = this.deps.config.deepseek;
    if (cfg.model !== globalCfg.model) overrides.model = cfg.model;
    if (cfg.temperature !== globalCfg.temperature) overrides.temperature = cfg.temperature;
    if (cfg.max_tokens !== globalCfg.max_tokens) overrides.max_tokens = cfg.max_tokens;
    if (cfg.top_p !== globalCfg.top_p) overrides.top_p = cfg.top_p;
    if (cfg.fallback_response !== globalCfg.fallback_response) overrides.fallback_response = cfg.fallback_response;
    return Object.keys(overrides).length > 0 ? overrides : undefined;
  }

  setAutoReplyFlag(autoReply: boolean): void {
    const changed = this.shopConfig.autoReply !== autoReply;
    this.shopConfig.autoReply = autoReply;
    if (changed) {
      // 开关变化即递增 controlEpoch：关闭 AI 时让生成中的自动回复在发送前失效；
      // 开启 AI 时同样递增，避免开关瞬间的旧任务在新一轮中误发（SAFE-AI-OFF-001）。
      this.controlEpoch += 1;
      this.deps.logger.info(
        { shopId: this.shopConfig.shopId, shopName: this.shopConfig.shopName, autoReply, controlEpoch: this.controlEpoch },
        autoReply ? 'AI 已开启，恢复所有功能' : 'AI 已关闭，停止所有功能调用',
      );
      // 同步更新 WebviewClient 扫描器开关：autoReply 为 false 时扫描器跳过，避免点击菜单项覆盖用户操作
      this.webviewClient?.setAutoReplyEnabled(autoReply);
    }
  }

  /** 当前发送闸门版本号（用于自动回复发送前校验） */
  getControlEpoch(): number {
    return this.controlEpoch;
  }

  /**
   * 从平台页面抓取当前会话的只读订单摘要并缓存（ORDER-SUMMARY-001）。
   *
   * 仅做只读读取，不提供发货/退款/改价等交易写操作。
   * 当前仅 feige（抖店）有订单面板 adapter；其他平台返回空并提示人工查看。
   *
   * sessionId 通常由调用方传入；省略时读取平台页面当前选中会话，
   * 避免调用方为了调用本方法而伪造一个会话标识。
   */
  async captureOrderSnapshot(sessionId?: string): Promise<{ orderRef: string; summary: string; platformUrl: string | null } | null> {
    const { shopId, platform } = this.shopConfig;
    if (platform !== 'feige') {
      this.deps.logger.info({ shopId, platform }, '当前平台无订单面板 adapter，跳过订单抓取');
      return null;
    }
    if (!this.webviewClient || !this.webviewClient.isConnected) return null;

    // 未显式传入会话时，从平台页面读取当前选中会话作为归属
    const resolvedSessionId = sessionId?.trim()
      || (await this.webviewClient.getCurrentSessionId())
      || '';
    if (!resolvedSessionId) {
      this.deps.logger.info({ shopId }, '无法确定当前会话，跳过订单抓取');
      return null;
    }

    const raw = await this.webviewClient.detectOrderInfo();
    if (!raw) return null;

    // 尝试从文本中解析订单号作为稳定 orderRef；解析不到则用内容哈希兜底
    const refMatch = raw.match(/订单(?:编号|号)[：:\s]*([A-Za-z0-9\-]+)/);
    const orderRef = refMatch?.[1]
      ?? `snapshot-${crypto.createHash('md5').update(raw).digest('hex').slice(0, 12)}`;

    this.deps.db.orderSnapshots.upsert({
      shopId,
      sessionId: resolvedSessionId,
      orderRef,
      summary: raw,
    });
    this.deps.logger.info({ shopId, sessionId: resolvedSessionId, orderRef }, '已抓取并缓存订单摘要');
    // 平台原页跳转地址交由渲染层按当前会话构造，这里只返回缓存键
    return { orderRef, summary: raw, platformUrl: null };
  }

  /**
   * 店铺能力声明（VISION-SEND-001）。
   *
   * 明确区分"能识别"和"能自动发送"，避免 UI 或文档把视觉模式描述成完整自动回复闭环。
   * 当前视觉模式只做识别与人工提示，不实现受控自动发送：
   * 没有稳定会话关联和可靠回执前，自动发送会带来发错会话的风险。
   */
  getCapabilities(): {
    autoReply: boolean;
    visualDetection: boolean;
    visualAutoSend: boolean;
    pageTransfer: boolean;
    attachmentSend: 'manual_only';
  } {
    return {
      autoReply: this.shopConfig.autoReply,
      visualDetection: this.deps.config.vision.enabled && this.deps.visionClient.isStarted,
      // 视觉模式仅识别，需人工回复（VISION-SEND-001 未实现受控发送）
      visualAutoSend: false,
      pageTransfer: this.shopConfig.platform === 'feige',
      attachmentSend: 'manual_only',
    };
  }

  /**
   * 记录一条平台消息到统一消息模型（工作台消息时间线数据源）。
   * 按 messageId 幂等，写入后 emit 'message:recorded' 供 IPC 层推送到渲染进程。
   */
  private recordPlatformMessage(input: {
    sessionId: string;
    direction: 'in' | 'out';
    content: string;
    source: string;
    messageId?: string;
    status?: string;
  }): void {
    try {
      const messageId = input.messageId
        || `${input.direction}:${crypto.createHash('md5').update(`${input.sessionId}|${input.content}|${input.direction}`).digest('hex')}`;
      this.deps.db.conversationMessages.upsert({
        shopId: this.shopConfig.shopId,
        sessionId: input.sessionId,
        messageId,
        direction: input.direction,
        source: input.source,
        content: input.content,
        status: input.status,
      });
      this.emit('message:recorded', {
        shopId: this.shopConfig.shopId,
        sessionId: input.sessionId,
        messageId,
        direction: input.direction,
        source: input.source,
        content: input.content,
        status: input.status ?? 'sent',
        createdAt: Date.now(),
      });
    } catch (err) {
      // 消息记录失败不能阻断主流程
      this.deps.logger.debug({ err, shopId: this.shopConfig.shopId }, '记录平台消息失败');
    }
  }

  /**
   * 自动发送闸门校验：停止、AI 关闭、人工接管或 epoch 变化时不允许自动发送。
   * 人工手动发送不经过此校验（不受 AI 开关和接管影响）。
   */
  isAutoSendAllowed(epochAtStart: number): boolean {
    if (this.stopped) return false;
    if (!this.shopConfig.autoReply) return false;
    if (this.stateMachine.currentState === 'ManualMode') return false;
    return epochAtStart === this.controlEpoch;
  }

  /** 切换后台模式：非活跃店铺降低轮询频率以减少资源占用 */
  setBackgroundMode(background: boolean): void {
    this.webviewClient?.setBackgroundMode(background);
  }

  reloadRules(): void {
    this.ruleEngine.reloadRules();
  }

  /** 更新店铺配置并重载规则引擎（配置变更时调用） */
  updateShopConfig(config: ShopConfigInfo | undefined): void {
    this.ruleEngine.setShopConfig(config);
  }

  getRuleEngine(): RuleEngine {
    return this.ruleEngine;
  }

  /** 清理本店铺过期会话上下文（由 ShopSupervisor.cleanupIdleContexts 调用） */
  cleanupIdleContext(): number {
    return this.contextManager.cleanupIdle();
  }

  async reloadProductCatalog(): Promise<void> {
    const matcher = new ProductMatcher(this.deps.config, this.shopConfig.shopId);
    await matcher.load();
    this.productMatcher = matcher;
    if (this.deps.config.conversion.enabled) {
      this.conversionEngine = new ConversionEngine(
        this.deps.config,
        matcher,
      );
    }
    this.deps.logger.info(
      { shopId: this.shopConfig.shopId, count: matcher.count },
      '商品库已重新加载',
    );
  }

  async start(_options?: StartShopOptions): Promise<void> {
    const { shopId, shopName } = this.shopConfig;
    this.deps.logger.info({ shopId, shopName }, '店铺启动中');

    // 1. 加载商品库
    this.productMatcher = new ProductMatcher(this.deps.config, shopId);
    try {
      await this.productMatcher.load();
      this.deps.logger.info({ shopId, count: this.productMatcher.count }, '商品库已加载');
    } catch (err) {
      this.deps.logger.warn({ shopId, err }, '商品库加载失败，仅规则引擎可用');
    }
    if (this.deps.config.conversion.enabled) {
      this.conversionEngine = new ConversionEngine(
        this.deps.config,
        this.productMatcher,
      );
    }

    // 2. 创建 WebContentsView 并加载平台网页版
    const platform = this.shopConfig.platform;
    const webUrl = this.deps.config.platforms[platform].web_url || getPlatform(platform).defaultWebUrl;

    const webContents = await this.deps.webviewManager.ensureView(shopId, webUrl, platform);
    this.webContents = webContents;

    // 监听 webview 崩溃/销毁，自动恢复
    this.registerCrashHandler(webContents);

    // 监听页面加载完成，reload 后自动重装 Observer
    // 同时检测页面加载失败（chrome-error://chromewebdata/）并自动重新加载
    let lastErrorReloadAt = 0;
    this.didFinishLoadHandler = async () => {
      if (this.stopped || !this.webviewClient) return;
      const currentUrl = webContents.getURL();
      // 检测页面加载失败（chrome-error:// 或 about:blank）
      if (currentUrl.startsWith('chrome-error://') || currentUrl === 'about:blank') {
        const now = Date.now();
        if (now - lastErrorReloadAt > 10000) {
          lastErrorReloadAt = now;
          this.deps.logger.warn(
            { shopId, url: currentUrl, targetUrl: webUrl },
            '页面加载失败（chrome-error），10秒后自动重新加载',
          );
          this.scheduleTimer(() => {
            if (!this.stopped) {
              webContents.loadURL(webUrl).catch((err) => {
                this.deps.logger.warn({ shopId, err }, '重新加载页面失败');
              });
            }
          }, 10000);
        }
        return;
      }
      // 诊断页面加载状态：获取 URL、标题、body 文本和 DOM 结构
      try {
        const diagResult = await webContents.executeJavaScript(`(function() {
          var bodyText = (document.body && document.body.innerText) || '';
          var title = document.title || '';
          var url = window.location.href || '';
          // 检测飞鸽特有 DOM 元素
          var feigeSelectors = [
            '.chatd-root', '.chatd-default',
            '[class*="chatd-root"]', '[class*="chatd-default"]',
            '[class*="chat-list"]', '[class*="message-list"]',
            '[class*="conversation"]', '#im-input-box textarea',
            'textarea[class*="inputArea"]'
          ];
          var foundSelectors = [];
          for (var i = 0; i < feigeSelectors.length; i++) {
            if (document.querySelector(feigeSelectors[i])) {
              foundSelectors.push(feigeSelectors[i]);
            }
          }
          // 检测登录表单
          var loginForm = !!(document.querySelector('input[type="password"]') ||
            document.querySelector('[class*="login"]') ||
            document.querySelector('[class*="qrcode"]'));
          // 检测登录过期文本
          var expiredTexts = ['登录过期', '请重新登录', '暂无会话权限', '子账号管理', '账号权限'];
          var matchedExpired = '';
          for (var j = 0; j < expiredTexts.length; j++) {
            if (bodyText.indexOf(expiredTexts[j]) !== -1) {
              matchedExpired = expiredTexts[j];
              break;
            }
          }
          // 收集主要 DOM 元素的 class 列表
          var domClasses = [];
          var allElements = document.querySelectorAll('[class]');
          var seen = {};
          for (var n = 0; n < allElements.length && domClasses.length < 30; n++) {
            var cls = (allElements[n].className || '').toString();
            if (cls && !seen[cls] && cls.length < 200) {
              seen[cls] = true;
              domClasses.push(cls);
            }
          }
          return {
            url: url,
            title: title,
            bodyTextSnippet: bodyText.substring(0, 500),
            foundSelectors: foundSelectors,
            loginForm: loginForm,
            matchedExpired: matchedExpired,
            domClasses: domClasses,
            elementCount: document.querySelectorAll('*').length
          };
        })()`);
        this.deps.logger.info(
          { shopId, platform, diag: diagResult },
          '页面加载诊断: did-finish-load',
        );
      } catch (err) {
        this.deps.logger.warn({ shopId, err: err instanceof Error ? err.message : String(err) }, '页面加载诊断失败');
      }

      this.webviewClient.resetObserver();
      this.scheduleTimer(() => {
        if (!this.stopped && this.webviewClient) {
          void this.webviewClient.probe();
        }
      }, 3000);
    };
    webContents.on('did-finish-load', this.didFinishLoadHandler);

    // 3. 创建 WebviewClient 并连接
    this.webviewClient = new WebviewClient(webContents, getPlatform(platform).selectors, this.deps.config, platform);
    this.webviewClient.setLogger(this.deps.logger);
    this.webviewClient.resetObserver();
    try {
      await this.webviewClient.connect();
    } catch (err) {
      this.deps.logger.error({ shopId, err }, 'Webview 连接失败，进入 VisualMode');
    }

    // 4. 注册消息回调（仅当有 webviewClient 时）
    if (this.webviewClient) {
      this.webviewClient.onMessage((msg) => void this.handleIncomingMessage(msg));
      this.webviewClient.onRevoke((sessionId, revokedText) => {
        this.contextManager.removeLastUserMessage(this.shopConfig.shopId, sessionId, revokedText);
      });
    }

    // 5. 启动状态机（默认 Degrading → 自动尝试进入 Healthy/VisualMode）
    this.stateMachine.start();

    // 6. 注册非工作时间策略处理器（若启用）
    if (this.deps.workTimePolicy) {
      this.deps.workTimePolicy.registerProcessor(shopId, async (pendingMsg) => {
        // 工作时间恢复后，将暂存消息按正常消息流程处理
        // 复用 handleIncomingMessage 入口，构造 CdpMessage
        const syntheticMsg: CdpMessage = {
          sessionId: pendingMsg.sessionId,
          from: 'buyer',
          text: pendingMsg.messageText,
          timestamp: pendingMsg.receivedAt,
          messageId: `pending-${pendingMsg.sessionId}-${pendingMsg.receivedAt}`,
        };
        try {
          await this.handleIncomingMessage(syntheticMsg);
        } catch (err) {
          this.deps.logger.error(
            { err, shopId: pendingMsg.shopId, sessionId: pendingMsg.sessionId },
            '处理暂存消息时异常',
          );
          throw err;
        }
      });
      this.deps.logger.info({ shopId }, '已注册非工作时间策略处理器');
    }

    this.deps.logger.info({ shopId, state: this.stateMachine.currentState }, '店铺启动完成');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    this.recoveryScheduled = false;
    // 清理所有尚未触发的一次性定时器，避免停止后回调仍访问已销毁资源
    for (const t of this.pendingTimers) {
      clearTimeout(t);
    }
    this.pendingTimers.clear();
    this.recoveryAttempts = 0;
    const { shopId } = this.shopConfig;
    this.deps.logger.info({ shopId }, '店铺停止中');

    void this.stateMachine.transition('ManualMode');
    this.stateMachine.destroy();

    // 清理 WebContents 事件监听器，防止内存泄漏
    if (this.webContents && !this.webContents.isDestroyed()) {
      if (this.didFinishLoadHandler) {
        this.webContents.off('did-finish-load', this.didFinishLoadHandler);
        this.didFinishLoadHandler = null;
      }
      for (const handler of this.crashHandlerRefs) {
        this.webContents.off('crashed', handler);
        this.webContents.off('destroyed', handler);
      }
      this.webContents.off('render-process-gone', this.crashHandlerRefs[2] ?? (() => {}));
      this.crashHandlerRefs = [];
    }
    this.webContents = null;

    try {
      await this.webviewClient?.disconnect();
    } catch (err) {
      this.deps.logger.warn({ shopId, err }, 'Webview 断开失败');
    }

    this.deps.webviewManager.removeView(shopId);

    this.contextManager.clearAllTimers();
    this.deps.rateLimiter.reset(shopId);
    this.deps.lruCache.invalidateShop(shopId);
    this.processingSessions.clear();
    this.pendingSessionMessages.clear();
    this.latestSessionMessages.clear();
    this.recentSentReplies.clear();
    this.sessionCooldowns.clear();
    this.processedAgentJoinSignals.clear();
    this.transferredSessions.clear();

    // 注销非工作时间策略处理器并清理本店铺定时器
    // （stopPendingTimer 是全局清理，会误停其他店铺的定时器，必须按店铺注销）
    this.deps.workTimePolicy?.unregisterProcessor(shopId);

    // 清理所有活跃对话状态
    if (this.deps.dialogStateManager) {
      for (const sid of this.sessions.keys()) {
        this.deps.dialogStateManager.endDialog(shopId, sid);
      }
    }

    this.deps.logger.info({ shopId }, '店铺已停止');
  }

  async manualTakeover(): Promise<void> {
    this.deps.logger.info({ shopId: this.shopConfig.shopId }, '人工接管');
    // 先递增 controlEpoch，使所有在途自动回复任务立即失效（即使状态转换尚未完成）
    this.controlEpoch += 1;
    // 等待状态机真正进入 ManualMode，调用方据此确认自动发送已被阻断
    await this.stateMachine.onManualTakeover();
    // 人工接管时暂停所有会话计时
    for (const sid of this.sessions.keys()) {
      this.contextManager.pauseTimer(this.shopConfig.shopId, sid);
    }
  }

  async manualRelease(): Promise<void> {
    this.deps.logger.info({ shopId: this.shopConfig.shopId }, '人工释放');
    // 人工已接管处理完毕并释放：清除全部转人工标记，
    // 否则这些会话的买家消息在 24 小时内被 handleIncomingMessage 顶部拦截，AI 无法恢复回复
    const releasedCount = this.transferredSessions.size;
    this.transferredSessions.clear();
    if (releasedCount > 0) {
      this.deps.logger.info(
        { shopId: this.shopConfig.shopId, releasedCount },
        '人工释放：已清除转人工会话标记，AI 恢复回复',
      );
    }
    // 外部客户端嵌入模式且无 CDP 时，webviewClient 为 null，直接进入 VisualMode
    const target: StateName = this.webviewClient?.isConnected ? 'Healthy' : 'VisualMode';
    // 等待状态恢复完成，避免 UI 认为已释放但状态机仍在 ManualMode
    await this.stateMachine.onManualRelease(target);
    // 释放后递增 epoch，确保接管期间滞留的旧任务不会在恢复后补发
    this.controlEpoch += 1;
  }

  // ============ 崩溃恢复 ============

  /** 注册一次性定时器并纳入 pendingTimers，stop() 时统一清理 */
  private scheduleTimer(callback: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      callback();
    }, delayMs);
    this.pendingTimers.add(timer);
    timer.unref?.();
  }

  private registerCrashHandler(webContents: IWebContents): void {
    const handleCrashed = () => {
      if (this.stopped) return;
      this.deps.logger.warn({ shopId: this.shopConfig.shopId }, 'WebContents 崩溃，将尝试自动恢复');
      this.handleWebviewCrash();
    };
    const handleDestroyed = () => {
      if (this.stopped) return;
      this.deps.logger.warn({ shopId: this.shopConfig.shopId }, 'WebContents 被销毁，将尝试自动恢复');
      this.handleWebviewCrash();
    };
    const handleRenderGone = () => {
      if (this.stopped) return;
      this.deps.logger.warn({ shopId: this.shopConfig.shopId }, '渲染进程异常退出，将尝试自动恢复');
      this.handleWebviewCrash();
    };

    webContents.on('crashed', handleCrashed);
    webContents.on('destroyed', handleDestroyed);
    webContents.on('render-process-gone', handleRenderGone);

    this.crashHandlerRefs = [handleCrashed, handleDestroyed, handleRenderGone];
  }

  private handleWebviewCrash(): void {
    if (this.stopped || this.recoveryScheduled) return;
    // 立即设置哨兵，避免一次崩溃的 crashed/destroyed/render-process-gone 同步连续触发导致多次计数
    this.recoveryScheduled = true;
    if (this.recoveryAttempts >= ShopInstance.MAX_RECOVERY_ATTEMPTS) {
      this.recoveryScheduled = false;
      this.deps.logger.error(
        { shopId: this.shopConfig.shopId, attempts: this.recoveryAttempts },
        '店铺恢复失败，已达最大重试次数',
      );
      void this.stateMachine.transition('Error');
      void this.deps.alertManager.fire({
        name: 'shop_recovery_failed',
        level: 'critical',
        title: `店铺 ${this.shopConfig.shopName} 恢复失败`,
        message: `已尝试 ${this.recoveryAttempts} 次恢复，均失败`,
        shopId: this.shopConfig.shopId,
      });
      return;
    }

    const baseDelay = ShopInstance.RECOVERY_DELAYS_MS[this.recoveryAttempts] ?? 45000;
    // 添加随机抖动，避免多店铺同时崩溃时产生惊群效应
    const jitter = Math.floor(Math.random() * ShopInstance.RECOVERY_JITTER_MS);
    const delay = baseDelay + jitter;
    this.recoveryAttempts += 1;
    this.deps.logger.info(
      { shopId: this.shopConfig.shopId, attempt: this.recoveryAttempts, delayMs: delay, baseMs: baseDelay, jitterMs: jitter },
      '计划自动恢复店铺',
    );

    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      this.recoveryScheduled = false;
      void this.attemptRecovery();
    }, delay);
    if (this.recoveryTimer.unref) this.recoveryTimer.unref();
  }

  private async attemptRecovery(): Promise<void> {
    if (this.stopped) return;
    const { shopId } = this.shopConfig;
    this.deps.logger.info({ shopId, attempt: this.recoveryAttempts }, '开始恢复店铺');

    try {
      // 断开旧连接
      try {
        await this.webviewClient?.disconnect();
      } catch {
        // 忽略断开错误
      }
      // 清理旧 WebContents 上的事件监听器（crashed/destroyed/render-process-gone/did-finish-load），
      // 避免重复注册导致一次崩溃多次触发恢复，以及监听器泄漏
      const oldWc = this.webContents;
      if (oldWc && !oldWc.isDestroyed()) {
        for (const h of this.crashHandlerRefs) {
          oldWc.off('crashed', h);
          oldWc.off('destroyed', h);
        }
        if (this.crashHandlerRefs[2]) {
          oldWc.off('render-process-gone', this.crashHandlerRefs[2]);
        }
        if (this.didFinishLoadHandler) {
          oldWc.off('did-finish-load', this.didFinishLoadHandler);
        }
      }
      this.crashHandlerRefs = [];
      this.didFinishLoadHandler = null;
      this.deps.webviewManager.removeView(shopId);

      // 重新创建 WebContentsView
      const platform = this.shopConfig.platform;
      const webUrl = this.deps.config.platforms[platform].web_url || getPlatform(platform).defaultWebUrl;
      const webContents = await this.deps.webviewManager.ensureView(shopId, webUrl, platform);
      this.registerCrashHandler(webContents);

      // 重新创建 WebviewClient
      this.webviewClient = new WebviewClient(webContents, getPlatform(platform).selectors, this.deps.config, platform);
      this.webviewClient.setLogger(this.deps.logger);
      this.webviewClient.resetObserver();
      await this.webviewClient.connect();
      this.webviewClient.onMessage((msg) => void this.handleIncomingMessage(msg));
      this.webviewClient.onRevoke((sessionId, revokedText) => {
        this.contextManager.removeLastUserMessage(this.shopConfig.shopId, sessionId, revokedText);
      });

      // 重置恢复计数
      this.recoveryAttempts = 0;
      void this.stateMachine.transition('Degrading');
      this.deps.logger.info({ shopId }, '店铺恢复成功');
    } catch (err) {
      this.deps.logger.error({ shopId, err, attempt: this.recoveryAttempts }, '店铺恢复尝试失败');
      this.handleWebviewCrash();
    }
  }

  // ============ 状态机回调实现 ============

  private createStateMachine(): ShopStateMachine {
    const callbacks: StateMachineCallbacks = {
      onCdpHeartbeat: async () => {
        if (!this.webviewClient) return false;
        const ok = await this.webviewClient.heartbeat();
        if (ok) {
          this.stateMachine.onCdpHeartbeatSuccess();
        } else {
          // 补发心跳失败指标：AlertManager 的 cdp_heartbeat_failure 规则依赖该指标，
          // 否则监控盲区中的"自动重启飞鸽"恢复动作永远不会触发
          this.deps.metrics.inc('cdp_heartbeat_failure_total', 1, undefined, this.shopConfig.shopId);
          this.stateMachine.onCdpHeartbeatFailure();
        }
        return ok;
      },
      onCdpRecoverProbe: async () => {
        if (!this.webviewClient) return false;
        return this.webviewClient.probe();
      },
      onVisualPoll: async () => {
        await this.runVisualPoll();
      },
      onSilentWaitEnd: async () => {
        this.deps.logger.info({ shopId: this.shopConfig.shopId }, 'SilentWait 结束，恢复处理');
      },
      onEnterError: () => {
        this.deps.metrics.set('shop_in_error', 1, undefined, this.shopConfig.shopId);
        void this.deps.alertManager.fire({
          name: 'shop_enter_error',
          level: 'critical',
          title: `店铺 ${this.shopConfig.shopName} 进入 Error`,
          message: '店铺进入 Error 状态，需人工介入',
          shopId: this.shopConfig.shopId,
        });
      },
      onEnterDegrading: async () => {
        this.deps.metrics.inc('degrading_total', 1, undefined, this.shopConfig.shopId);
        // Degrading 时尝试重连 Webview
        try {
          await this.connectWebviewWithRetry();
        } catch {
          // 重连失败由 onCdpRecoverProbe 在 VisualMode 中继续尝试
        }
      },
      onEnterVisualMode: async () => {
        this.deps.metrics.inc('visual_mode_total', 1, undefined, this.shopConfig.shopId);
        // 补发活跃指标：AlertManager 的 visual_mode_active 规则依赖该指标
        this.deps.metrics.set('visual_mode_active', 1, undefined, this.shopConfig.shopId);
        if (!this.deps.config.vision.enabled) {
          this.deps.logger.warn({ shopId: this.shopConfig.shopId }, '视觉模式已禁用，将依赖 CDP 拉取');
        }
      },
      onExitVisualMode: async () => {
        this.deps.metrics.set('visual_mode_active', 0, undefined, this.shopConfig.shopId);
      },
    };

    const timerConfig = {
      heartbeatIntervalMs: this.deps.config.cdp.heartbeat.interval_ms,
      recoverProbeIntervalMs: this.deps.config.cdp.recover_probe.interval_ms,
      recoverCooldownMs: this.deps.config.cdp.recover_probe.cooldown_after_failure_ms,
      recoverVerifyCount: this.deps.config.cdp.recover_probe.verify_count,
      recoverVerifyIntervalMs: this.deps.config.cdp.recover_probe.verify_interval_ms,
      recoverVerifyTimeoutMs: this.deps.config.cdp.recover_probe.verify_timeout_ms,
      visualPollIntervalMs: this.deps.config.vision.poll_interval_ms,
      // Degrading 超时必须 ≥ 重连总时长（max_retries × retry_interval_ms），
      // 否则重连第 5~10 秒成功时状态已转 Error，店铺永久卡死（Error 无自动恢复定时器）
      degradingTimeoutMs: Math.max(
        5000,
        this.deps.config.cdp.max_retries * this.deps.config.cdp.retry_interval_ms + 2000,
      ),
      silentWaitDurationMs: this.deps.config.silent_wait.duration_ms,
      silentWaitMaxConsecutive: this.deps.config.silent_wait.max_consecutive,
    };

    return new ShopStateMachine(this.shopConfig.shopId, 'Degrading', callbacks, timerConfig);
  }

  private async connectWebviewWithRetry(): Promise<void> {
    if (!this.webviewClient) return;
    const { max_retries, retry_interval_ms } = this.deps.config.cdp;
    let lastErr: unknown;
    for (let i = 0; i < max_retries; i++) {
      try {
        await this.webviewClient.connect();
        this.deps.logger.info({ shopId: this.shopConfig.shopId }, 'Webview 连接成功');
        if (this.stateMachine.currentState === 'Degrading' || this.stateMachine.currentState === 'VisualMode') {
          void this.stateMachine.transition('Healthy');
        }
        return;
      } catch (err) {
        lastErr = err;
        this.deps.logger.debug({ shopId: this.shopConfig.shopId, attempt: i + 1, err }, 'Webview 连接重试');
        await new Promise((r) => {
          const t = setTimeout(r, retry_interval_ms);
          t.unref?.();
        });
      }
    }
    throw lastErr;
  }

  // ============ 消息处理 ============

  private async handleIncomingMessage(msg: CdpMessage): Promise<void> {
    if (this.stopped) return;
    // AI 关闭时，停止所有功能调用（不处理消息、不触发回复、不调用 AI）
    if (!this.shopConfig.autoReply) {
      return;
    }
    // 人工接管中：立即停止 AI 自动回复（发送闸门入口检查）
    // 用局部变量读取，避免 TS 对属性访问路径做收窄影响后续的 ManualMode 判断
    const entryState = this.stateMachine.currentState;
    if (entryState === 'ManualMode') {
      this.deps.logger.debug(
        { shopId: this.shopConfig.shopId, sessionId: msg.sessionId },
        '人工接管中，跳过自动回复',
      );
      return;
    }
    // 记录本次处理开始时的发送闸门版本；发送前需再次校验，接管/关闭 AI 会使其中途失效
    const epochAtStart = this.controlEpoch;
    // 会话已转人工（售后问题 AI 解答不了时触发）：跳过 AI 回复，等待人工客服接管
    if (msg.from === 'buyer' && this.transferredSessions.has(msg.sessionId)) {
      this.deps.logger.debug(
        { shopId: this.shopConfig.shopId, sessionId: msg.sessionId, platform: this.shopConfig.platform },
        '会话已转人工，跳过 AI 回复',
      );
      return;
    }
    if (msg.from !== 'buyer') {
      // 飞鸽系统信号识别：当检测到"客服XXX接入"/"已接入人工客服"等关键词时，
      // 飞鸽平台已自动切换到人工客服，AI 应感知并切换到 ManualMode 暂停自动回复
      // 场景：买家发"人工"消息 → 飞鸽系统拦截 → 客服接入 → AI 应停止回复后续消息
      // 去重：使用 sessionId + text 摘要作为 key，避免同一信号重复触发 manualTakeover
      //
      // 关键约束（2026-07-21 修复）：
      //   之前匹配 /人工客服为您服务/ 会导致 AI 自己的回复被误判为系统信号
      //   （AI 回复 "亲，这类问题需要人工客服核实处理，请稍候由人工客服为您服务。"）
      //   现在改为：
      //   1. 排除 AI 自己发的回复（通过"亲，"开头 + "人工客服核实处理"等措辞识别）
      //   2. 只匹配真正的系统信号："客服XXX接入" / "已接入人工客服"
      if (this.shopConfig.platform === 'feige' && (msg.from === 'seller' || msg.from === 'system')) {
        const text = msg.text || '';
        // 排除 AI 自己发的回复（避免误判）
        const isAiReplyEcho =
          text.startsWith('亲，') ||
          text.startsWith('亲 ') ||
          text.startsWith('亲~') ||
          /人工客服核实处理/.test(text) ||
          /我帮您联系人工客服/.test(text) ||
          /请联系人工客服/.test(text);
        // 匹配飞鸽系统的"客服接入"信号（真实样本："客服唯衣美服装工作室接入"）
        // 注意：不匹配"人工客服为您服务"，因为 AI 回复也用这个措辞
        const isAgentJoinSignal = !isAiReplyEcho && (
          /客服[^，。！？\s]{1,30}接入/.test(text) ||
          /已接入人工客服/.test(text)
        );
        if (isAgentJoinSignal && this.stateMachine.currentState !== 'ManualMode') {
          const dedupKey = `feige_agent_join:${msg.sessionId}:${text.slice(0, 50)}`;
          if (!this.processedAgentJoinSignals.has(dedupKey)) {
            this.processedAgentJoinSignals.set(dedupKey, Date.now());
            this.deps.logger.info(
              { shopId: this.shopConfig.shopId, platform: 'feige', sessionId: msg.sessionId, from: msg.from, text: text.slice(0, 80) },
              '检测到飞鸽系统人工客服接入信号，切换到 ManualMode',
            );
            this.deps.metrics.inc(
              'transfer_human_total',
              1,
              { source: 'system_signal', agent_role: 'general', platform: 'feige' },
              this.shopConfig.shopId,
            );
            // 异步触发人工接管 + emit transfer:success 事件让 UI 通知
            void this.manualTakeover().then(() => {
              this.emit('transfer:success', {
                shopId: this.shopConfig.shopId,
                sessionId: msg.sessionId,
                agentName: '飞鸽人工客服',
                role: 'general' as AgentRole,
                reason: '飞鸽系统自动接入人工客服',
              });
            }).catch((err) => {
              this.deps.logger.error({ shopId: this.shopConfig.shopId, err }, '飞鸽系统信号触发人工接管失败');
            });
          }
          return;
        }
      }
      this.deps.logger.debug(
        { shopId: this.shopConfig.shopId, platform: this.shopConfig.platform, from: msg.from, text: msg.text.slice(0, 40) },
        '非买家消息，跳过自动回复',
      );
      return;
    }
    const { shopId } = this.shopConfig;
    const sessionId = msg.sessionId;

    if (this.isOwnReplyEcho(msg.text)) {
      this.markMessageProcessed(msg.text, msg.timestamp, sessionId, msg.messageId);
      this.deps.metrics.inc('self_reply_echo_blocked_total', 1, undefined, shopId);
      this.deps.logger.warn(
        { shopId, sessionId, platform: this.shopConfig.platform, text: msg.text.slice(0, 120) },
        '检测到自身客服回复回声，已阻止重复回复',
      );
      return;
    }

    if (this.isInvalidObservedSessionId(sessionId)) {
      this.markMessageProcessed(msg.text, msg.timestamp, sessionId, msg.messageId);
      this.deps.metrics.inc('invalid_session_message_blocked_total', 1, undefined, shopId);
      this.deps.logger.warn(
        { shopId, sessionId, platform: this.shopConfig.platform, text: msg.text.slice(0, 120) },
        '会话标识来自页面导航，已阻止自动回复',
      );
      return;
    }

    const sanitizedText = this.sanitizeIncomingBuyerText(msg.text);
    if (!sanitizedText) {
      this.markMessageProcessed(msg.text, msg.timestamp, sessionId, msg.messageId);
      this.deps.metrics.inc('page_chrome_message_blocked_total', 1, undefined, shopId);
      this.deps.logger.warn(
        { shopId, sessionId, platform: this.shopConfig.platform, text: msg.text.slice(0, 160) },
        '检测到页面控件或系统卡片文本，已阻止自动回复',
      );
      return;
    }
    if (sanitizedText !== msg.text) {
      msg = { ...msg, text: sanitizedText };
      if (this.isOwnReplyEcho(msg.text)) {
        this.markMessageProcessed(msg.text, msg.timestamp, sessionId, msg.messageId);
        this.deps.metrics.inc('self_reply_echo_blocked_total', 1, undefined, shopId);
        return;
      }
    }

    if (this.hasSuccessfulReplyGuard(msg)) {
      this.markMessageProcessed(msg.text, msg.timestamp, sessionId, msg.messageId);
      this.deps.metrics.inc('duplicate_reply_blocked_total', 1, undefined, shopId);
      this.deps.logger.info(
        { shopId, sessionId, messageId: msg.messageId, text: msg.text.slice(0, 80) },
        '买家消息已成功回复过，跳过重复回复',
      );
      return;
    }

    // 消息去重：防止 reload 后历史消息被重新处理
    if (this.isMessageProcessed(msg.text, msg.timestamp, sessionId, msg.messageId)) {
      this.deps.logger.debug({ shopId, sessionId, text: msg.text.slice(0, 40) }, '消息已处理过，跳过');
      return;
    }

    this.deps.metrics.inc('message_received_total', 1, { from: msg.from }, shopId);
    this.deps.logger.debug({ shopId, sessionId, text: msg.text.slice(0, 80) }, '收到买家消息');

    // 记录到统一平台消息模型（工作台消息时间线）
    this.recordPlatformMessage({
      sessionId,
      direction: 'in',
      content: msg.text,
      source: msg.from,
      messageId: msg.messageId,
      status: 'received',
    });

    this.deps.db.shopState.incrementUnread(shopId);
    this.deps.onStateChange?.(shopId, this.stateMachine.currentState);

    // 登录状态检查：登录过期时不尝试回复，避免 sendReplyFast 失败
    const loginStatus = this.deps.webviewManager?.getLoginStatus(shopId);
    if (loginStatus === 'logged_out') {
      this.deps.logger.warn({ shopId, sessionId, platform: this.shopConfig.platform }, '平台登录已过期，跳过自动回复');
      return;
    }

    // === 非工作时间策略 ===
    // 工作时间外收到消息时：暂存消息到 pending_messages 表，发送预设话术，跳过后续 generateReply
    if (this.deps.workTimePolicy?.enabled && !this.deps.workTimePolicy.isWorkingNow()) {
      try {
        this.deps.db.pendingMessages.add({
          shopId,
          sessionId,
          buyerName: sessionId,
          messageText: msg.text,
          receivedAt: Date.now(),
        });
        this.deps.logger.info({ shopId, sessionId, text: msg.text.slice(0, 80) }, '非工作时间，消息已暂存');
      } catch (err) {
        this.deps.logger.warn({ err, shopId, sessionId }, '暂存消息失败，继续走默认管线');
      }
      // 发送前闸门校验：等待期间若发生人工接管或关闭 AI，则不再发送预设话术
      if (!this.isAutoSendAllowed(epochAtStart)) {
        this.deps.logger.info({ shopId, sessionId }, '非工作时间话术发送前闸门失效，放弃发送');
        return;
      }
      const offHoursReply = this.deps.workTimePolicy.buildOffHoursReply();
      // 发送预设话术（避免生成 AI 回复，但仍走发送通道保证一致性）
      const sent = await this.sendReply(offHoursReply);
      if (!sent) {
        this.deps.logger.warn({ shopId, sessionId }, '非工作时间话术发送失败，下次工作时间会重新处理');
      }
      return;
    }

    this.latestSessionMessages.set(sessionId, msg);

    // 会话冷却期检查：同一会话处理完成后 15 秒内不再处理新消息
    const cooldownUntil = this.sessionCooldowns.get(sessionId);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      this.deps.logger.debug(
        { shopId, sessionId, remainingMs: cooldownUntil - Date.now() },
        '会话冷却期内，跳过消息处理',
      );
      return;
    }

    // Keep only the latest buyer message while a reply for this conversation is in flight.
    if (this.processingSessions.has(sessionId)) {
      const pending = this.pendingSessionMessages.get(sessionId);
      if (pending && this.isSameMessage(pending, msg)) {
        return;
      }
      if (pending) {
        this.markMessageProcessed(pending.text, pending.timestamp, sessionId, pending.messageId);
      }
      this.pendingSessionMessages.set(sessionId, msg);
      this.deps.logger.debug({ shopId, sessionId, text: msg.text.slice(0, 80) }, '会话正在处理中，已替换为最新买家消息');
      return;
    }

    // 标记消息已处理
    this.markMessageProcessed(msg.text, msg.timestamp, sessionId, msg.messageId);
    this.processingSessions.add(sessionId);
    let userContextAdded = false;
    let retryDelayMs: number | null = null;

    try {
      // Give consecutive buyer messages a short window to settle. If a newer
      // message arrives, this one is superseded and must not produce a reply.
      await this.sleep(ShopInstance.MESSAGE_SETTLE_MS);
      if (!this.isLatestSessionMessage(sessionId, msg)) {
        this.deps.logger.debug({ shopId, sessionId, text: msg.text.slice(0, 80) }, '买家已发送更新消息，跳过旧消息回复');
        return;
      }

      const now = Date.now();
      // 更新会话信息
      const session = this.sessions.get(sessionId) ?? {
        sessionId,
        lastMessageAt: now,
      };
      session.lastMessageAt = now;
      this.sessions.set(sessionId, session);

      // 标记识别成功
      this.stateMachine.onIdentifySuccess();

      // 限流检查
      if (!this.deps.rateLimiter.tryAcquire(shopId)) {
        this.unmarkMessageProcessed(msg.text, msg.timestamp, sessionId, msg.messageId);
        retryDelayMs = Math.ceil(60_000 / this.deps.config.ratelimit.per_shop_per_minute);
        this.deps.metrics.inc('rate_limit_rejected_total', 1, undefined, shopId);
        this.deps.logger.warn({ shopId, sessionId, retryDelayMs }, '限流触发，消息稍后重试');
        this.deps.db.audit.add({
          shopId,
          sessionId,
          userMessage: msg.text,
          aiReply: '',
          modelVersion: 'rate_limited',
          promptHash: '',
          productId: msg.productId,
          tokenInput: 0,
          tokenOutput: 0,
          latencyMs: 0,
          confidence: 0,
        });
        return;
      }

      // Only persist context after the request has acquired reply capacity.
      this.contextManager.addUserMessage(shopId, sessionId, msg.text, msg.productId);
      userContextAdded = true;

      // 生成回复
      const replyStartAt = Date.now();
      const generatedReply = await this.generateReply(msg, session);
      if (!generatedReply) return;
      const replyGeneratedAt = Date.now();

      // 人工模拟延迟：缓存/规则命中时跳过延迟以保障 5 秒响应
      const mv = this.lastReplyModelVersion;
      const isFastReply = mv.startsWith('cache') || mv.startsWith('rule:') || mv.startsWith('learned:') || mv.endsWith(':no_reply');
      const fullDelay = this.deps.humanSimulator.getReplyDelayMs();
      const aiDelayMax = this.deps.config.human_simulator.ai_reply_delay_max_ms ?? 1500;
      const delayMs = isFastReply ? 0 : Math.min(fullDelay, aiDelayMax);
      if (delayMs > 0) {
        await this.sleep(delayMs);
      }

      if (!this.isLatestSessionMessage(sessionId, msg)) {
        if (userContextAdded) {
          this.contextManager.removeLastUserMessage(shopId, sessionId, msg.text);
          userContextAdded = false;
        }
        this.deps.logger.debug({ shopId, sessionId, text: msg.text.slice(0, 80) }, '回复生成期间收到更新消息，取消旧回复');
        return;
      }

      // 发送前闸门：生成/延迟期间发生人工接管或关闭 AI 时，本条自动回复必须失效
      if (!this.isAutoSendAllowed(epochAtStart)) {
        if (userContextAdded) {
          this.contextManager.removeLastUserMessage(shopId, sessionId, msg.text);
          userContextAdded = false;
        }
        this.deps.metrics.inc('auto_send_blocked_total', 1, undefined, shopId);
        this.deps.logger.info(
          {
            shopId,
            sessionId,
            state: this.stateMachine.currentState,
            autoReply: this.shopConfig.autoReply,
            epochAtStart,
            controlEpoch: this.controlEpoch,
          },
          '发送前闸门失效（人工接管或 AI 关闭），已阻止自动发送',
        );
        return;
      }

      const tokenOutput = this.lastResponseTokenOutput;

      // 解析订单备注指令 [REMARK:备注内容] / [APPEND_REMARK:内容] / [UPDATE_REMARK:内容]
      const { reply: replyAfterRemark, remarkContent, remarkMode } = this.parseRemarkTag(generatedReply);
      // 解析买家标签/备注指令 [BUYER_TAG:...] [BUYER_REMARK:...]
      const { reply: replyToSend, buyerTags, buyerRemark } = this.parseBuyerTagMark(replyAfterRemark);

      // 先发送回复（备注操作在回复发送成功后执行，避免 sendInputEvent 冲突）
      // 发送前校验会话：生成期间用户切到别的会话时，本条回复作废（MSG-01）
      const sent = await this.sendReply(replyToSend, { expectedSessionId: sessionId });
      if (!sent) {
        this.unmarkMessageProcessed(msg.text, msg.timestamp, sessionId, msg.messageId);
        retryDelayMs = ShopInstance.SEND_RETRY_DELAY_MS;
        if (userContextAdded) {
          this.contextManager.removeLastUserMessage(shopId, sessionId, msg.text);
          userContextAdded = false;
        }
        return;
      }
      this.recordSuccessfulReplyGuard(msg);
      this.registerSentReply(generatedReply);
      // 记录自动回复到统一平台消息模型（出向）
      this.recordPlatformMessage({
        sessionId,
        direction: 'out',
        content: replyToSend,
        source: 'ai',
        status: 'sent',
      });
      const replySentAt = Date.now();
      this.deps.logger.info(
        {
          shopId,
          sessionId,
          modelVersion: mv,
          generateMs: replyGeneratedAt - replyStartAt,
          delayMs,
          sendMs: replySentAt - replyGeneratedAt,
          totalMs: replySentAt - replyStartAt,
        },
        '自动回复耗时',
      );
      this.contextManager.addAssistantMessage(shopId, sessionId, replyToSend, tokenOutput);
      this.deps.metrics.inc('reply_sent_total', 1, undefined, shopId);
      this.deps.db.shopState.markRead(shopId);
      this.deps.onStateChange?.(shopId, this.stateMachine.currentState);

      // 异步记录买家交互（不阻塞主流程；用于跨会话记忆与 VIP 自动升级）
      if (this.buyerProfileService) {
        queueMicrotask(() => {
          try {
            this.buyerProfileService?.recordInteraction({
              shopId,
              platform: this.shopConfig.platform,
              // BUYER-ID-001：优先稳定 buyerId，缺失时回退到 sessionId（低置信度）
              buyerName: msg.buyerId ?? msg.sessionId,
              buyerId: msg.buyerId,
              identityConfidence: msg.buyerId ? 'high' : 'low',
              sessionId: msg.sessionId,
              productId: session.productId,
              isComplaint: this.isComplaintMessage(msg.text),
            });
          } catch (err) {
            this.deps.logger.warn({ err, shopId, sessionId: msg.sessionId }, '记录买家交互失败');
          }
        });
      }

      // 回复发送成功后，异步执行订单备注操作（延迟1.5秒确保回复发送完成）
      if (remarkContent) {
        this.deps.logger.info(
          { shopId, sessionId, remarkContent, remarkMode },
          '识别到订单备注请求，回复已发送，开始执行备注',
        );
        // 延迟执行备注，确保回复发送完全完成
        this.scheduleTimer(() => {
          this.executeOrderRemark(remarkContent, remarkMode).catch((err) => {
            this.deps.logger.warn(
              { shopId, sessionId, err: String(err) },
              '订单备注执行失败',
            );
          });
        }, 1500);
      }

      // 异步写入买家标签/备注到买家档案（不阻塞主流程；不需要 1.5s 延迟，因为不操作 DOM）
      if ((buyerTags.length > 0 || buyerRemark) && this.buyerProfileService) {
        queueMicrotask(() => {
          try {
            if (buyerTags.length > 0) {
              this.buyerProfileService?.addBuyerTags(
                shopId,
                this.shopConfig.platform,
                msg.sessionId,
                buyerTags,
              );
            }
            if (buyerRemark) {
              this.buyerProfileService?.updateBuyerRemark(
                shopId,
                this.shopConfig.platform,
                msg.sessionId,
                buyerRemark,
              );
            }
          } catch (err) {
            this.deps.logger.warn({ err, shopId, sessionId: msg.sessionId }, '写入买家标签/备注失败');
          }
        });
      }
    } catch (err) {
      this.unmarkMessageProcessed(msg.text, msg.timestamp, sessionId, msg.messageId);
      if (userContextAdded) {
        this.contextManager.removeLastUserMessage(shopId, sessionId, msg.text);
      }
      this.deps.logger.error(
        {
          shopId,
          sessionId,
          platform: this.shopConfig.platform,
          shopName: this.shopConfig.shopName,
          err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
          messageText: msg.text.slice(0, 100),
        },
        '自动回复失败',
      );
      this.deps.metrics.inc('reply_failed_total', 1, undefined, shopId);
      this.deps.db.audit.add({
        shopId,
        sessionId,
        userMessage: msg.text,
        aiReply: '',
        modelVersion: 'send_failed',
        promptHash: '',
        productId: msg.productId,
        tokenInput: 0,
        tokenOutput: 0,
        latencyMs: 0,
        confidence: 0,
      });
      this.stateMachine.onIdentifyFailure();
    } finally {
      this.processingSessions.delete(sessionId);
      const next = this.pendingSessionMessages.get(sessionId);
      this.pendingSessionMessages.delete(sessionId);
      const shouldRetry = retryDelayMs !== null && !next && this.isLatestSessionMessage(sessionId, msg);
      // 仅当没有排队待处理消息且无需重试时才设置冷却期；
      // 若设置冷却后再重试，重试会在 handleIncomingMessage 顶部的冷却检查被拦截，
      // 导致发送失败/限流的重试逻辑完全失效（消息被静默丢弃）。
      if (!next && !shouldRetry) {
        this.sessionCooldowns.set(sessionId, Date.now() + ShopInstance.SESSION_COOLDOWN_MS);
      }
      if (next) {
        queueMicrotask(() => void this.handleIncomingMessage(next));
      } else if (shouldRetry && retryDelayMs !== null) {
        this.scheduleTimer(() => void this.handleIncomingMessage(msg), retryDelayMs);
      } else if (this.isLatestSessionMessage(sessionId, msg)) {
        this.latestSessionMessages.delete(sessionId);
      }
    }
  }

  private detectScenario(text: string): string | undefined {
    const scenarios = this.deps.config.deepseek.scenarios;
    if (!scenarios) return undefined;
    for (const [name, cfg] of Object.entries(scenarios)) {
      if (cfg.keywords && cfg.keywords.some((kw) => text.includes(kw))) {
        return name;
      }
    }
    return undefined;
  }

  /** 简单投诉关键词检测（用于买家画像 complaint_count 增量） */
  private isComplaintMessage(text: string): boolean {
    const keywords = ['投诉', '差评', '举报', '工商', '12315', '曝光', '消费者协会'];
    return keywords.some((kw) => text.includes(kw));
  }

  /**
   * 构造 Function Calling 工具执行上下文
   * 把 ShopInstance 的 productMatcher / db / 转人工回调封装为 ToolContext
   */
  private buildToolContext(shopId: string, sessionId: string): ToolContext {
    return {
      shopId,
      sessionId,
      platform: this.shopConfig.platform,
      productMatcher: this.productMatcher,
      db: this.deps.db,
      onTransferHuman: (reason: string, agentRole?: AgentRole) =>
        this.onTransferHuman(sessionId, reason, agentRole),
    };
  }

  /**
   * TransferHumanTool 回调：AI 判定需要转人工时触发
   * 切换状态机到"人工接管"，记录转人工原因
   * 若指定 agentRole，则通过 agentMappings 查表后执行飞鸽页面转接
   */
  private onTransferHuman(sessionId: string, reason: string, agentRole?: AgentRole): void {
    const role = agentRole ?? 'general';
    const roleName = AGENT_ROLE_NAMES[role];
    this.deps.logger.warn(
      { shopId: this.shopConfig.shopId, sessionId, reason, agentRole: role, roleName },
      'AI 触发转人工（Function Calling）',
    );
    this.deps.metrics.inc(
      'transfer_human_total',
      1,
      { source: 'ai_tool', agent_role: role },
      this.shopConfig.shopId,
    );

    // 异步触发转接流程，不阻塞工具执行
    void this.executeTransfer(sessionId, reason, role).catch((err) => {
      this.deps.logger.error(
        { shopId: this.shopConfig.shopId, sessionId, err },
        '转接流程异常',
      );
    });
  }

  /**
   * 执行转接到指定专员
   * 1. 平台分发：仅飞鸽平台支持页面级 transferToAgent，其他平台直接降级
   * 2. 飞鸽：查表得到飞鸽客服账号名 → 调用 WebviewClient.transferToAgent 操作飞鸽页面
   *    - 若配置了 agent_mappings[role]：优先匹配指定客服
   *    - 若未配置或配置无效：transferToAgent 内部会回退到列表中第一个在线客服
   * 3. 同时切换状态机到 ManualMode 暂停 AI 自动回复
   * 4. 失败时降级为通用人工接管
   *
   * 注意（2026-07-21 验证确认）：
   *   飞鸽新版 UI 会话区右上角确实存在 i-icon-transfer 图标（位置 x=783, y=51），
   *   之前的"已移除 transfer 图标"判断是基于无会话的 workspace 页面调研，错误。
   *   实际图标需要先点开会话才会在聊天面板 header 中出现。
   *   transferToAgent 流程：点击图标 → 等待抽屉 → 选择客服 → 填备注 → 确认 → 验证。
   */
  private async executeTransfer(
    sessionId: string,
    reason: string,
    role: AgentRole,
  ): Promise<void> {
    const { shopId, platform } = this.shopConfig;

    // 0. 平台分发：仅飞鸽支持页面级转接专员，其他平台直接降级为通用人工接管
    if (platform !== 'feige') {
      this.deps.logger.info(
        { shopId, sessionId, role, platform },
        '当前平台不支持页面级转接专员，降级为通用人工接管',
      );
      await this.manualTakeover().catch(() => {});
      this.emit('transfer:failed', { shopId, sessionId, reason: 'platform-not-supported', role, platform });
      return;
    }

    // 1. 查表得到目标飞鸽客服账号名（可选：未配置时转移给任意在线客服）
    const bizConfig = this.deps.db.shopBusiness.getOrDefault(shopId);
    const configuredAgentName = bizConfig.agentMappings?.[role];
    // 校验配置的客服名是否有效（不能为空字符串、不能等于店铺名本身）
    let agentName: string | undefined;
    if (configuredAgentName && configuredAgentName.trim().length > 0) {
      const shopName = this.shopConfig.shopName || '';
      // 若配置的客服名与店铺名相同，说明配置错误，跳过 → 转移给任意在线客服
      if (shopName && configuredAgentName.trim() === shopName.trim()) {
        this.deps.logger.warn(
          { shopId, sessionId, role, configuredAgentName, shopName },
          '飞鸽客服账号映射配置错误（等于店铺名），将转移给任意在线客服',
        );
      } else {
        agentName = configuredAgentName.trim();
      }
    }
    if (!agentName) {
      this.deps.logger.info(
        { shopId, sessionId, role },
        '未配置该角色的飞鸽客服账号映射，将转移给任意在线客服',
      );
    }

    // 2. 检查 WebviewClient 是否可用
    if (!this.webviewClient) {
      this.deps.logger.warn({ shopId, sessionId }, 'WebviewClient 不可用，降级为通用转人工');
      await this.manualTakeover().catch(() => {});
      this.emit('transfer:failed', { shopId, sessionId, reason: 'no-webview', role });
      return;
    }

    // 3. 调用 WebviewClient.transferToAgent 执行飞鸽页面操作
    //    agentName 为空时 transferToAgent 内部会自动选择列表中第一个在线客服
    const result = await this.webviewClient.transferToAgent(agentName, reason);
    if (result.ok) {
      this.deps.logger.info(
        { shopId, sessionId, agentName: agentName || '(any-online)', role, reason },
        '飞鸽转接成功',
      );
      this.emit('transfer:success', { shopId, sessionId, agentName: agentName || '(any-online)', role, reason });
      // 同时切换状态机到 ManualMode（暂停 AI 自动回复，避免AI在转接完成后继续回复买家）
      await this.manualTakeover().catch((err) => {
        this.deps.logger.error({ shopId, sessionId, err }, '转接后切换状态机失败');
      });
    } else {
      this.deps.logger.warn(
        { shopId, sessionId, agentName: agentName || '(any-online)', role, reason, failedReason: result.reason },
        '飞鸽转接失败，降级为通用转人工',
      );
      // 降级：仅切换状态机 + 通知 UI
      await this.manualTakeover().catch(() => {});
      this.emit('transfer:failed', {
        shopId,
        sessionId,
        reason: result.reason,
        role,
        agentName: agentName || '(any-online)',
      });
    }
  }

  private async generateReply(msg: CdpMessage, session: ActiveSession): Promise<string | null> {
    const { shopId } = this.shopConfig;
    const text = msg.text.trim();

    const normalizedText = ShopInstance.normalizeQuestion(text);
    const questionHash = crypto.createHash('md5').update(normalizedText).digest('hex');

    let reply: string | null = null;
    let modelVersion = 'unknown';
    let tokenInput = 0;
    let tokenOutput = 0;
    let latencyMs = 0;
    let confidence = 0.5;
    let fromCache = false;
    /** 对话状态机已处理：跳过 LRU 缓存写入，避免后续命中缓存跳过状态机 */
    let dialogHandled = false;
    /** 意图识别结果（在 step 1c 中赋值）。提升到方法作用域以便 step 5b 转人工判断使用 */
    let intent: IntentResult | null = null;
    /** 复杂度评估结果（在 step 1c 中赋值）。提升到方法作用域以便 step 5b 转人工判断使用 */
    let complexity: ComplexityResult | null = null;

    // 1. 精确缓存命中
    const cached = this.deps.lruCache.get(shopId, questionHash, session.productId);
    if (cached) {
      this.deps.metrics.inc('cache_hit_total', 1, { type: 'exact' }, shopId);
      reply = cached;
      modelVersion = 'cache';
      confidence = 0.5;
      fromCache = true;
    } else {
      // 1b. 语义缓存命中（bigram Jaccard 相似度）
      const semantic = this.deps.lruCache.getSemantic(shopId, normalizedText, session.productId);
      if (semantic) {
        this.deps.metrics.inc('cache_hit_total', 1, { type: 'semantic' }, shopId);
        this.deps.logger.info(
          { shopId, similarity: semantic.similarity },
          '语义缓存命中',
        );
        reply = semantic.answer;
        modelVersion = 'cache:semantic';
        confidence = 0.5;
        fromCache = true;
      } else {
        // 1c. 意图预评估（对话状态机之前执行，意图结果供状态机场景触发使用）
        if (this.deps.intentClassifier && this.deps.complexityAssessor) {
          const historyForIntent = this.contextManager.getRecentMessagesWithTokenLimit(
            shopId,
            msg.sessionId,
            4096,
          );
          intent = this.deps.intentClassifier.classify(text, historyForIntent);
          const hasSessionEsc = this.deps.db.intent.hasSessionEscalation(shopId, msg.sessionId);
          complexity = this.deps.complexityAssessor.assess(text, intent, historyForIntent, hasSessionEsc);
          this.deps.db.intent.addClassification({
            shopId,
            sessionId: msg.sessionId,
            userMessage: text,
            intent,
            complexity,
          });
          this.deps.metrics.inc('intent_classified_total', 1, { category: intent.category }, shopId);

          // 低置信度时 LLM 二次验证
          if (intent && intent.confidence < 0.5 && this.llmIntentRecognizer) {
            try {
              const enhanced = await this.llmIntentRecognizer.recognize(
                text,
                historyForIntent.map((m) => ({ role: m.role, content: m.content })),
                shopId,
              );
              if (enhanced.intent.confidence > intent.confidence) {
                intent = enhanced.intent;
                this.deps.metrics.inc('llm_intent_override_total', 1, { category: intent.category }, shopId);
                this.deps.logger.info(
                  { shopId, enhancedCategory: enhanced.intent.category, confidence: enhanced.intent.confidence },
                  'LLM 二次验证覆盖意图',
                );
              }
            } catch (err) {
              this.deps.logger.warn({ shopId, err }, 'LLM 二次验证失败，使用关键词识别结果');
            }
          }
        }

        // 1c2. 多轮对话状态机（活跃对话 / 触发新场景；传入意图供场景匹配）
        // 注：活跃对话时跳过 LRU 缓存，避免状态机被缓存跳过
        const dialogResult = await this.checkDialogState(shopId, msg, session, text, intent?.category);
        if (dialogResult.handled) {
          reply = dialogResult.reply;
          modelVersion = dialogResult.modelVersion;
          confidence = 0.9;
          dialogHandled = true;
        } else {

        // 2. 规则引擎优先
        const ruleResult = this.ruleEngine.match(text);
        if (ruleResult.matched && ruleResult.answer) {
          this.deps.metrics.inc('rule_hit_total', 1, { rule: ruleResult.ruleName ?? '' }, shopId);
          reply = ruleResult.answer;
          modelVersion = `rule:${ruleResult.ruleName}`;
          confidence = 0.9;
        } else {
          // 2b. 学习模式匹配（规则未命中时尝试已学习模式）
          let patternMatched = false;
          if (this.deps.patternMatcher) {
            const patternResult = this.deps.patternMatcher.match(shopId, text);
            if (patternResult.matched && patternResult.answer) {
              this.deps.metrics.inc(
                'pattern_hit_total',
                1,
                { type: patternResult.matchType ?? 'exact' },
                shopId,
              );
              reply = patternResult.answer;
              modelVersion = `learned:${patternResult.patternId}`;
              confidence = 0.85;
              patternMatched = true;
            }
          }

          if (!patternMatched) {
            // 3. 商品匹配（用于注入上下文）
            let productContext = '';
            if (this.productMatcher && this.deps.config.product.match_algorithm !== 'exact') {
              const matches = this.productMatcher.match(text);
              if (matches.length > 0) {
                const top = matches[0];
                session.productId = top.productId;
                const product = this.productMatcher.getProduct(top.productId);
                if (product) {
                  productContext = this.buildProductContext(product);
                }
              }
            }

            // 3b. 订单备注请求检测：检测到备注请求或确认时，注入订单信息到上下文
            // 提前获取历史记录，用于判断买家是否在确认备注
            const maxContextTokens = 32768 - this.platformDeepseekConfig.max_tokens - 2000;
            const history = this.contextManager.getRecentMessagesWithTokenLimit(
              shopId,
              msg.sessionId,
              maxContextTokens,
            );

            const isRemarkRequest = ShopInstance.isRemarkRequest(text);
            const isRemarkConfirm = ShopInstance.isRemarkConfirm(text, history);
            const isOrderQuery = ShopInstance.isOrderRelatedQuery(text);
            if ((isRemarkRequest || isRemarkConfirm || isOrderQuery) && this.webviewClient && this.webviewClient.isConnected) {
              try {
                const orderInfo = await this.webviewClient.detectOrderInfo();
                if (orderInfo) {
                  productContext += (productContext ? '\n\n' : '') + '当前会话订单信息：\n' + orderInfo;
                  this.deps.logger.info(
                    { shopId, sessionId: msg.sessionId, isRemarkRequest, isRemarkConfirm, isOrderQuery, orderInfoPreview: orderInfo.slice(0, 100) },
                    '检测到订单相关查询，已注入订单信息',
                  );
                }
              } catch (err) {
                this.deps.logger.warn({ shopId, err: String(err) }, '注入订单信息失败');
              }
            }

            // 3a. 购买意图检测 + 推荐注入
            if (this.conversionEngine && this.deps.config.conversion.enabled) {
              const historyForConv = this.contextManager.getRecentMessagesWithTokenLimit(
                shopId,
                msg.sessionId,
                2048,
              );
              const purchaseIntent = this.conversionEngine.detectIntent(text, intent, historyForConv);
              if (purchaseIntent.hasIntent) {
                const recs = this.conversionEngine.recommend(
                  text,
                  session.productId,
                  purchaseIntent,
                  historyForConv,
                  shopId,
                  msg.sessionId,
                );
                if (recs.length > 0) {
                  productContext += this.buildRecommendationContext(recs);
                }
              }
            }

            // 4. Multi-Agent 调用（带场景路由 + token 限制的上下文）
            const scenario = this.detectScenario(text);

            // 情绪检测
            const emotion = await this.emotionDetector.detect(
              text,
              history.map((m) => ({ role: m.role, content: m.content })),
              shopId,
            );

            // 对话阶段识别
            const conversationPhase = this.contextManager.inferPhase(history);

            // 上下文摘要
            const contextSummary = this.contextManager.summarizeContext(history);

            // 模板知识注入
            let knowledgeContext = '';
            if (this.templateLibrary) {
              const recommendations = this.templateLibrary.recommendTemplates(text, 3);
              if (recommendations && recommendations.length > 0) {
                knowledgeContext = recommendations
                  .map((t: { scenario: string; content: string }) => `[${t.scenario}] ${t.content}`)
                  .join('\n');
              }
            }

            // 跨会话买家画像注入（先认人再讲货）
            let buyerContext = '';
            if (this.buyerProfileService) {
              try {
                buyerContext = this.buyerProfileService.buildBuyerContext(
                  shopId,
                  this.shopConfig.platform,
                  msg.sessionId,
                );
              } catch (err) {
                this.deps.logger.warn(
                  { shopId, sessionId: msg.sessionId, err },
                  '买家画像构建失败，跳过',
                );
              }
            }

            const agentCtx: AgentContext = {
              shopId,
              sessionId: msg.sessionId,
              productId: session.productId,
              scenario,
              productContext,
              knowledgeContext,
              history,
              userMessage: text,
              emotion,
              conversationPhase,
              contextSummary,
              shopName: this.shopConfig.shopName,
              platform: this.shopConfig.platform,
              platformOverrides: this.getPlatformOverrides(),
              buyerContext,
              toolRegistry: this.toolRegistry ?? undefined,
              toolContext: this.toolRegistry ? this.buildToolContext(shopId, msg.sessionId) : undefined,
              images: msg.images,
            };

            const agentResult = await this.deps.orchestrator.orchestrate(agentCtx);

            tokenInput = agentResult.tokenInput;
            tokenOutput = agentResult.tokenOutput;
            latencyMs = agentResult.latencyMs;
            reply = agentResult.content;
            modelVersion = `${agentResult.model}:${agentResult.agentId}`;
            confidence = agentResult.confidence;

            if (agentResult.truncated) {
              this.deps.logger.warn(
                { shopId, sessionId: msg.sessionId, tokenOutput: agentResult.tokenOutput },
                'AI 回复续写后仍被截断，请检查 max_tokens 配置',
              );
            }

            // 4b. 升级检查（复杂问题或低置信度时触发）
            if (
              complexity?.shouldEscalate ||
              (confidence < this.deps.config.intent.confidence_threshold && !patternMatched)
            ) {
              if (this.deps.escalationManager) {
                try {
                  await this.deps.escalationManager.requestEscalation(
                    shopId,
                    msg.sessionId,
                    complexity ?? { level: 'moderate', score: 0.5, reasons: ['low_confidence'], shouldEscalate: true },
                    undefined,
                  );
                } catch (err) {
                  this.deps.logger.warn({ err, shopId }, '升级请求失败');
                }
              }
            }
          }
        }
        }  // 1c. dialogState else 闭合
      }
    }

    // 5. 统一敏感词检查（缓存/规则/DeepSeek 均需检查）
    if (reply === null) {
      reply = this.platformDeepseekConfig.fallback_response;
      modelVersion = `${modelVersion}:no_reply`;
    }
    const sensitiveResult = this.deps.sensitiveChecker.check(reply);
    if (!sensitiveResult.passed) {
      this.deps.metrics.inc('sensitive_block_total', 1, undefined, shopId);
      this.deps.logger.warn({ shopId, hits: sensitiveResult.hits.length, source: modelVersion }, '回复命中敏感词，使用兜底');
      reply = this.platformDeepseekConfig.fallback_response;
      modelVersion = `${modelVersion}:sensitive_blocked`;
    } else {
      // warn 类型敏感词：记录告警日志（不阻断回复）
      const warnHits = sensitiveResult.hits.filter((h) => h.action === 'warn');
      if (warnHits.length > 0) {
        this.deps.logger.warn(
          { shopId, hits: warnHits.map((h) => ({ word: h.word, category: h.category })), source: modelVersion },
          '回复命中 warn 类型敏感词，已记录告警（继续发送）',
        );
      }
      reply = this.deps.sensitiveChecker.sanitize(reply);
    }

    // 5b. 售后问题 + AI 解答不了 → 主动转移会话到在线客服
    // 场景：买家提售后问题（退货/退款/换货/质量问题），但 AI 无法给出有效回复（兜底/熔断/低置信度），
    //       此时继续由 AI 回复只会激怒买家，应主动转移会话给在线人工客服。
    // 实现：
    //   - 飞鸽平台：主动调用 executeTransfer 操作页面，转移给指定专员（after_sales 角色）
    //     失败时降级为通用转人工（manualTakeover 切换状态机 + 通知 UI）
    //   - 其他平台：仅会话级标记（transferredSessions），等待人工客服接管
    //   - 会话级标记 transferredSessions 防止 AI 在转接期间继续回复
    //   - 24 小时后自动过期（cleanupExpiredHashes 清理），让人工未处理时可重新由 AI 接管
    if (
      (intent?.category === 'after_sales' || intent?.category === 'human_request') &&
     !this.transferredSessions.has(msg.sessionId) &&
     this.stateMachine.currentState !== 'ManualMode' &&
      !modelVersion.startsWith('rule:') &&
      !modelVersion.startsWith('learned:') &&
      !modelVersion.startsWith('dialog:') &&
      (reply === this.platformDeepseekConfig.fallback_response ||
        modelVersion.includes('fallback') ||
        modelVersion.includes('circuit-open') ||
        modelVersion.includes('no_reply') ||
        confidence < this.deps.config.intent.confidence_threshold)
    ) {
      // 立即标记会话为已转人工，防止 AI 在 executeTransfer 异步执行期间继续回复
      this.transferredSessions.set(msg.sessionId, Date.now());
      const isHumanRequest = intent?.category === 'human_request';
      const transferRole: AgentRole = isHumanRequest ? 'general' : 'after_sales';
      const transferReason = isHumanRequest
        ? `买家要求转人工（intent=human_request, model=${modelVersion}）`
        : `售后问题 AI 解答不了（intent=after_sales, model=${modelVersion}, confidence=${confidence.toFixed(2)}）`;
      this.deps.logger.warn(
        {
          shopId,
          sessionId: msg.sessionId,
          platform: this.shopConfig.platform,
          intentCategory: intent.category,
          modelVersion,
          confidence,
          replyPreview: reply.slice(0, 60),
          userMessage: text.slice(0, 60),
        },
        isHumanRequest ? '买家要求转人工，触发会话转移' : '售后问题 AI 解答不了，触发会话转移',
      );
      this.deps.metrics.inc(
        'transfer_human_total',
        1,
        { source: isHumanRequest ? 'human_request' : 'after_sales_unresolved', agent_role: transferRole, platform: this.shopConfig.platform },
        shopId,
      );
      // 异步触发转移流程（不阻塞当前响应返回）
      // executeTransfer 内部会根据平台分发：
      //   - 飞鸽：调用 WebviewClient.transferToAgent 操作页面，主动转移给在线客服
      //   - 其他平台：降级为 manualTakeover（仅切换状态机 + 通知 UI）
      void this.executeTransfer(msg.sessionId, transferReason, transferRole).catch((err) => {
        this.deps.logger.error(
          { shopId, sessionId: msg.sessionId, err },
          '售后转接流程异常',
        );
        // 转移失败时回滚 transferredSessions 标记，让 AI 可在下一条消息时重新尝试
        // 仅对临时性错误回滚（页面未响应、webContents 销毁等）
        // 对永久性错误（如店铺已停止）保留标记，避免无限重试
        const errMsg = err instanceof Error ? err.message : String(err);
        const isTransientError = /webContents|destroyed|not connected|timeout|超时|未响应/i.test(errMsg);
        if (isTransientError) {
          this.transferredSessions.delete(msg.sessionId);
          this.deps.logger.info(
            { shopId, sessionId: msg.sessionId, err: errMsg },
            '临时性错误，已回滚 transferredSessions 标记，AI 可重新回复',
          );
        }
      });
      // 创建 escalation 记录入队（用于审计 + 人工分配兜底）
      if (this.deps.escalationManager) {
        try {
          void this.deps.escalationManager.requestEscalation(
            shopId,
            msg.sessionId,
            complexity ?? { level: 'complex', score: 0.7, reasons: ['after_sales_unresolved'], shouldEscalate: true },
            undefined,
          );
        } catch (err) {
          this.deps.logger.warn({ shopId, err }, '售后转人工 escalation 入队失败');
        }
      }
      // 返回 null 表示不发送 AI 回复（让买家等待人工客服接管）
      return null;
    }

    // 6. 统一写入审计
    this.deps.db.audit.add({
      shopId,
      sessionId: msg.sessionId,
      userMessage: text,
      aiReply: reply,
      modelVersion,
      promptHash: questionHash,
      productId: session.productId,
      tokenInput,
      tokenOutput,
      latencyMs,
      confidence,
    });

    // 7. 写入 LRU 缓存（仅非缓存命中且非对话状态机处理时写入）
    // 兜底/熔断/无法回答的回复不写缓存：LLM 恢复后同一问题应重新生成，
    // 否则会被缓存的兜底文案顶住直到缓存过期
    const isFallbackReply =
      modelVersion.includes(':no_reply') ||
      modelVersion.includes('fallback') ||
      modelVersion.includes('circuit-open') ||
      modelVersion.includes('sensitive_blocked');
    if (!fromCache && !dialogHandled && !isFallbackReply) {
      this.deps.lruCache.set(shopId, questionHash, reply, session.productId, normalizedText);
    }

    this.lastResponseTokenOutput = tokenOutput;
    this.lastReplyModelVersion = modelVersion;
    return reply;
  }

  /**
   * 多轮对话状态机检查（在 generateReply 中调用）。
   *
   * 1. 活跃对话存在 → processTurn 返回澄清问题或完成信号
   * 2. 无活跃对话但触发场景 → startDialog 返回首个槽位的 clarifyQuestion
   * 3. 都不匹配 → 返回 { handled: false }，由后续管线处理
   *
   * 注：对话完成时调用 LLM 生成完整回复（completionPrompt + 历史上下文）。
   */
  private async checkDialogState(
    shopId: string,
    msg: CdpMessage,
    session: ActiveSession,
    text: string,
    intentCategory?: string,
  ): Promise<{ handled: boolean; reply: string; modelVersion: string }> {
    if (!this.deps.dialogStateManager) {
      return { handled: false, reply: '', modelVersion: '' };
    }
    const manager = this.deps.dialogStateManager;
    const sessionId = msg.sessionId;

    // 1. 活跃对话存在 → 处理当前轮次
    const activeDialog = manager.getActiveDialog(shopId, sessionId);
    if (activeDialog) {
      try {
        const result = await manager.processTurn(shopId, sessionId, text);
        if (result.cancelled) {
          return {
            handled: true,
            reply: result.reply,
            modelVersion: 'dialog:cancelled',
          };
        }
        if (result.completed) {
          // 槽位填满：调用 LLM 生成完整回复
          const history = this.contextManager.getRecentMessagesWithTokenLimit(
            shopId,
            sessionId,
            4096 - this.platformDeepseekConfig.max_tokens - 500,
          );
          const messages = [
            { role: 'system' as const, content: result.completionPrompt ?? '请基于收集到的信息生成专业回复。' },
            ...history,
            { role: 'user' as const, content: text },
          ];
          try {
            // 走 ModelGateway：tier3 + cascade=true（主回复二次验证路径关键节点，需高可靠性）
            // DeepSeek 故障时自动级联到 OpenAI/Claude 等同 tier provider
            const llmResult = await this.deps.gateway.route({
              shopId,
              sessionId,
              messages,
              preferredTier: 'tier3',
              cascade: true,
            });
            const llmReply = llmResult?.content ?? '';
            this.lastResponseTokenOutput = llmResult?.tokenOutput ?? 0;
            const closingHint = result.state ? ' ' + (manager.getScenarios().find(s => s.id === result.state.scenarioId)?.closingHint ?? '') : '';
            return {
              handled: true,
              reply: (llmReply + closingHint).trim(),
              modelVersion: 'dialog:completed',
            };
          } catch (err) {
            this.deps.logger.error({ err, shopId, sessionId }, '对话完成时 LLM 调用失败');
            return {
              handled: true,
              reply: '抱歉，系统暂时无法处理您的请求，请稍后重试或联系人工客服~',
              modelVersion: 'dialog:llm_error',
            };
          }
        }
        // 仍需澄清
        return {
          handled: true,
          reply: result.reply,
          modelVersion: 'dialog:clarify',
        };
      } catch (err) {
        this.deps.logger.error({ err, shopId, sessionId }, '处理对话状态失败，结束对话');
        manager.endDialog(shopId, sessionId);
        return {
          handled: true,
          reply: '抱歉，对话处理异常，请重新描述您的需求~',
          modelVersion: 'dialog:error',
        };
      }
    }

    // 2. 无活跃对话但消息可能触发新场景（传意图：triggerIntent 场景依赖该参数）
    const scenario = manager.detectScenario(text, intentCategory);
    if (scenario) {
      try {
        manager.startDialog(shopId, sessionId, scenario);
        // 返回第一个槽位的 clarifyQuestion
        const firstSlot = scenario.slots[0];
        const firstQuestion = firstSlot?.clarifyQuestion ?? '请问您能提供更多信息吗？';
        this.deps.logger.info(
          { shopId, sessionId, scenarioId: scenario.id, firstSlot: firstSlot?.name },
          '对话场景已触发',
        );
        return {
          handled: true,
          reply: firstQuestion,
          modelVersion: 'dialog:trigger',
        };
      } catch (err) {
        this.deps.logger.error({ err, shopId, sessionId }, '启动对话场景失败');
      }
    }

    return { handled: false, reply: '', modelVersion: '' };
  }

  private buildProductContext(product: {
    name: string;
    sku: string;
    specs: Array<{ name: string; values: string[] }>;
    attrs: Array<{ name: string; value: string }>;
    variants: Array<{ spec: string; price: number; stock: number }>;
    shipping: { free_shipping: boolean; delivery_days: string };
    after_sales: { return_days: number; exchange_days: number; policy: string };
    faq: Array<{ q: string; a: string }>;
  }): string {
    const parts: string[] = [`商品名：${product.name}`, `SKU：${product.sku}`];
    if (product.specs && product.specs.length > 0) {
      parts.push('商品规格：' + product.specs.map((s) => `${s.name}(${s.values.join('/')})`).join(';'));
    }
    if (product.attrs && product.attrs.length > 0) {
      parts.push('商品属性：' + product.attrs.map((a) => `${a.name}:${a.value}`).join(';'));
    }
    if (product.variants.length > 0) {
      parts.push('SKU规格：' + product.variants.map((v) => `${v.spec}(${v.price}元,库存${v.stock})`).join(';'));
    }
    parts.push(`包邮：${product.shipping.free_shipping ? '是' : '否'}`);
    parts.push(`发货：${product.shipping.delivery_days}`);
    parts.push(`售后：${product.after_sales.return_days}天退货，${product.after_sales.exchange_days}天换货`);
    if (product.faq.length > 0) {
      parts.push('常见问题：\n' + product.faq.map((f) => `Q:${f.q}\nA:${f.a}`).join('\n'));
    }
    return parts.join('\n');
  }

  private buildRecommendationContext(recs: Array<{ productName: string; reason: string; strategy: string; spec?: string; price?: number }>): string {
    const lines = recs.map((r) => {
      const spec = r.spec ? ` ${r.spec}` : '';
      const price = r.price !== undefined ? ` ${r.price}元` : '';
      return `- ${r.productName}${spec}${price}（${r.strategy}: ${r.reason}）`;
    });
    return '\n推荐商品：\n' + lines.join('\n');
  }

  private buildChatMessages(
    currentText: string,
    history: Array<{ role: string; content: string }>,
    productContext: string,
  ): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const promptTemplate = this.loadPromptTemplate();
    const shopInfo = this.buildShopInfo();
    const systemContent = promptTemplate
      .replace('{shop_info}', shopInfo)
      .replace('{product_info}', productContext);

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemContent },
    ];

    for (const h of history) {
      if (h.role === 'user' || h.role === 'assistant') {
        messages.push({ role: h.role as 'user' | 'assistant', content: h.content });
      }
    }

    messages.push({ role: 'user', content: currentText });
    return messages;
  }

  private loadPromptTemplate(): string {
    if (this.promptTemplateCache !== null) {
      return this.promptTemplateCache;
    }
    try {
      const promptPath = resolveResource(this.platformDeepseekConfig.prompt_template);
      if (fs.existsSync(promptPath)) {
        this.promptTemplateCache = fs.readFileSync(promptPath, 'utf8');
        return this.promptTemplateCache;
      }
    } catch {}
    this.promptTemplateCache = this.platformDeepseekConfig.prompt_template;
    return this.promptTemplateCache;
  }

  private buildShopInfo(): string {
    const { shopName, platform } = this.shopConfig;
    const parts = [
      `店铺名称：${shopName}`,
      `平台：${getPlatform(platform).name}`,
      `客服模式：AI 自动回复`,
    ];
    // 注入店铺店铺配置（发货地址、运费险、快递、包邮、类目、人设），供 AI 回复时引用
    try {
      const biz = this.deps.db.shopBusiness.getOrDefault(this.shopConfig.shopId);
      if (biz.mainCategory) parts.push(`主营类目：${biz.mainCategory}`);
      if (biz.deliveryAddress) parts.push(`发货地址：${biz.deliveryAddress}`);
      if (biz.deliveryTime) parts.push(`发货时长：${biz.deliveryTime}`);
      parts.push(`运费险：${biz.freightInsurance ? '提供' : '不提供'}`);
      if (biz.expressCompanies.length > 0) {
        parts.push(`合作快递：${biz.expressCompanies.join('、')}`);
      }
      if (biz.freeShipping) {
        parts.push(`包邮：是${biz.freeShippingCondition ? `（${biz.freeShippingCondition}）` : '（全场包邮）'}`);
      } else {
        parts.push(`包邮：否`);
      }
      // 注入店铺人设（语气、昵称、口头禅、表情、自定义描述）
      const persona = biz.persona;
      if (persona) {
        const toneLabels: Record<string, string> = {
          professional: '专业礼貌',
          friendly: '亲切友好',
          lively: '活泼开朗',
          cute: '可爱俏皮',
        };
        const personaParts: string[] = [];
        personaParts.push(`语气风格：${toneLabels[persona.tone] || persona.tone}`);
        if (persona.nickname) personaParts.push(`客服昵称：${persona.nickname}`);
        if (persona.catchphrases.length > 0) {
          personaParts.push(`口头禅（回复末尾偶尔使用，每条最多 1 个）：${persona.catchphrases.join(' / ')}`);
        }
        personaParts.push(`表情符号：${persona.useEmojis ? '可适度使用（如 😊、💕）' : '不使用'}`);
        if (persona.description) personaParts.push(`自定义人设：${persona.description}`);
        parts.push(`【店铺人设】\n${personaParts.join('\n')}`);
      }
    } catch {
      // 读取店铺配置失败时忽略，不影响基础店铺信息
    }
    return parts.join('\n');
  }

  /**
   * 解析 AI 回复中的订单备注指令标记
   *
   * 支持三种标记：
   *   [REMARK:内容]          — 默认追加模式（保留已有备注，安全选项）
   *   [APPEND_REMARK:内容]   — 显式追加模式（同上，更明确）
   *   [UPDATE_REMARK:内容]   — 替换模式（清空已有备注后写入新备注，仅在买家明确要求修改时使用）
   *
   * 返回去除标记后的回复、备注内容、备注模式（无标记时 remarkContent 为空字符串）
   */
  private parseRemarkTag(reply: string): {
    reply: string;
    remarkContent: string;
    remarkMode: 'append' | 'replace';
  } {
    // 优先匹配 [UPDATE_REMARK:xxx]（替换模式）
    const updateMatch = reply.match(/\[UPDATE_REMARK:([^\]]+)\]/);
    if (updateMatch) {
      const remarkContent = updateMatch[1].trim();
      const replyClean = reply.replace(/\s*\[UPDATE_REMARK:[^\]]+\]\s*$/, '').trim();
      return { reply: replyClean, remarkContent, remarkMode: 'replace' };
    }
    // 匹配 [APPEND_REMARK:xxx] 或 [REMARK:xxx]（追加模式，默认）
    const appendMatch = reply.match(/\[(?:APPEND_)?REMARK:([^\]]+)\]/);
    if (appendMatch) {
      const remarkContent = appendMatch[1].trim();
      const replyClean = reply.replace(/\s*\[(?:APPEND_)?REMARK:[^\]]+\]\s*$/, '').trim();
      return { reply: replyClean, remarkContent, remarkMode: 'append' };
    }
    return { reply, remarkContent: '', remarkMode: 'append' };
  }

  /**
   * 解析 AI 回复中的买家标签/备注指令标记
   *
   * 支持两种标记（可同时出现）：
   *   [BUYER_TAG:标签1,标签2]       — 追加到 buyer_profiles.tags（合并去重）
   *   [BUYER_REMARK:自由文本备注]   — 覆盖 buyer_profiles.remarks
   *
   * 返回去除标记后的回复和提取的标签/备注（无标记时为空）
   */
  private parseBuyerTagMark(reply: string): {
    reply: string;
    buyerTags: string[];
    buyerRemark: string;
  } {
    let replyClean = reply;
    const buyerTags: string[] = [];
    let buyerRemark = '';

    // 解析 [BUYER_TAG:标签1,标签2]
    const tagMatch = replyClean.match(/\[BUYER_TAG:([^\]]+)\]/);
    if (tagMatch) {
      buyerTags.push(
        ...tagMatch[1]
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      );
      replyClean = replyClean.replace(/\s*\[BUYER_TAG:[^\]]+\]\s*$/, '').trim();
    }

    // 解析 [BUYER_REMARK:自由文本]
    const remarkMatch = replyClean.match(/\[BUYER_REMARK:([^\]]+)\]/);
    if (remarkMatch) {
      buyerRemark = remarkMatch[1].trim();
      replyClean = replyClean.replace(/\s*\[BUYER_REMARK:[^\]]+\]\s*$/, '').trim();
    }

    return { reply: replyClean, buyerTags, buyerRemark };
  }

  /**
   * 检测买家消息是否为订单备注请求
   *
   * 关键词：备注、标记、记一下、帮我记、留言等
   */
  static isRemarkRequest(text: string): boolean {
    const keywords = ['备注', '标记', '记一下', '帮我记', '留言', '注明', '备注一下', '帮备注'];
    return keywords.some((kw) => text.includes(kw));
  }

  /**
   * 检测买家消息是否与订单相关（用于触发订单信息注入）
   *
   * 涵盖场景：
   * - 订单查询：我的订单、订单状态、订单怎么样了
   * - 发货相关：发货、什么时候发、还没发货、待发货
   * - 物流相关：物流、快递、快递单号、运单、到哪了
   * - 收货相关：收货、签收、确认收货
   * - 售后相关：退款、退货、换货、售后、维修、退款进度
   * - 投诉相关：投诉、差评、申请介入
   *
   * 排除场景（避免误触发）：
   * - 纯打招呼：你好、在吗
   * - 纯商品咨询：这个多少钱、有货吗
   */
  static isOrderRelatedQuery(text: string): boolean {
    const t = text.trim();
    if (t.length < 2) return false;
    const keywords = [
      // 订单查询
      '订单', '订单号', '订单状态', '我的单', '我买的', '我下单', '催单',
      // 发货相关
      '发货', '什么时候发', '还没发', '待发货', '已发货', '不发货', '尽快发货', '催发货',
      // 物流相关
      '物流', '快递', '快递单', '运单', '到哪了', '什么时候到', '几天到', '多久到',
      // 收货相关
      '收货', '签收', '确认收货', '没收到', '没收到货',
      // 售后相关
      '退款', '退货', '换货', '售后', '维修', '退钱', '退款进度', '退款多久',
      // 地址/规格修改
      '改地址', '修改地址', '改尺寸', '换颜色', '换尺码', '改颜色',
      // 投诉相关
      '投诉', '差评', '申请介入', '介入',
    ];
    return keywords.some((kw) => t.includes(kw));
  }

  /**
   * 检测买家消息是否为确认备注
   *
   * 当买家之前要求备注，AI 回复让买家确认订单后，买家回复确认消息。
   * 需要结合上下文历史判断是否是确认备注请求。
   */
  static isRemarkConfirm(
    text: string,
    history: Array<{ role: string; content: string }>,
  ): boolean {
    // 确认关键词
    const confirmKeywords = ['对的', '是的', '确认', '没问题', '对', '是', '没错', '正确', '可以的', '可以', '嗯', '好的'];
    const isConfirm = confirmKeywords.some((kw) => text.trim() === kw || text.includes('确认') || text.includes('对的'));
    if (!isConfirm) return false;

    // 检查最近的 AI 回复是否包含订单确认引导（"请确认"、"确认订单"等）
    const recentAssistant = history
      .filter((m) => m.role === 'assistant')
      .slice(-2);
    for (const msg of recentAssistant) {
      if (
        msg.content.includes('确认') &&
        (msg.content.includes('订单') || msg.content.includes('备注'))
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * 异步执行订单备注操作
   *
   * 通过 WebviewClient 在飞鸽页面中操作订单面板添加/修改备注。
   * - 'append' 模式（默认）：保留已有备注，追加新内容
   * - 'replace' 模式：清空已有备注，写入新内容（仅在买家明确要求修改时使用）
   */
  private async executeOrderRemark(
    remarkContent: string,
    mode: 'append' | 'replace' = 'append',
  ): Promise<void> {
    if (!this.webviewClient || !this.webviewClient.isConnected) {
      this.deps.logger.warn({ shopId: this.shopConfig.shopId }, '订单备注失败：Webview 未连接');
      return;
    }

    try {
      const result = await this.webviewClient.addOrderRemark(remarkContent, mode);
      if (result.success) {
        this.deps.logger.info(
          {
            shopId: this.shopConfig.shopId,
            remarkContent,
            mode,
            existingRemarkPreview: result.existingRemark?.slice(0, 80),
          },
          '订单备注成功',
        );
      } else {
        this.deps.logger.warn(
          { shopId: this.shopConfig.shopId, remarkContent, mode, error: result.error, diag: result.diag?.slice(0, 500) },
          '订单备注失败',
        );
      }
    } catch (err) {
      this.deps.logger.warn(
        { shopId: this.shopConfig.shopId, remarkContent, mode, err: String(err) },
        '订单备注执行异常',
      );
    }
  }

  /** 问题归一化：去除标点、空格、统一大小写，提高缓存命中率 */
  static normalizeQuestion(text: string): string {
    return text
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '')
      .replace(/[，。！？、,.!?；;：:~～\-—_""''""''()（）【】\[\]{}「」『』<>《》\/\\|*&#%@`'"+=]/g, '')
      .replace(/[阿啊呀哦呢吧嘛哈喽]/g, '');
  }

  private async sendReply(
    text: string,
    opts?: { expectedSessionId?: string },
  ): Promise<boolean> {
    const { shopId, platform } = this.shopConfig;

    // Webview 模式：一次性写入完整回复后发送，避免分段发送多条消息
    if (this.webviewClient && this.webviewClient.isConnected) {
      // 发送前重新定位会话：LLM 生成/延迟期间用户切换会话时，禁止把回复发到错误会话
      if (opts?.expectedSessionId) {
        const currentSessionId = await this.webviewClient.getCurrentSessionId();
        if (currentSessionId && currentSessionId !== opts.expectedSessionId) {
          this.deps.logger.warn(
            { shopId, expected: opts.expectedSessionId, current: currentSessionId },
            '发送前会话已切换，取消本次发送',
          );
          this.deps.metrics.inc('send_session_mismatch_total', 1, undefined, shopId);
          return false;
        }
      }
      const result = await this.webviewClient.sendReplyFast(text);
      if (!result.success) {
        if (result.method === 'no-input') {
          // 输入框不存在（页面未选中会话或仍在加载），跳过回复避免错误
          this.deps.logger.warn(
            { shopId, platform, method: result.method, platformName: this.shopConfig.platform },
            '输入框不存在，跳过回复（页面可能未选中会话或仍在加载）',
          );
          return false;
        }
        if (result.method === 'verify-failed') {
          // 发送后验证失败：Enter 键和发送按钮点击都未能清空输入框
          // 不回退到逐字模式（根因是 React 状态/网络问题，逐字模式同样会失败），
          // 也不记录 replyGuard，让视觉轮询在下一轮重试
          this.deps.logger.warn(
            { shopId, platform, method: result.method, replyLength: text.length },
            '发送后验证失败：输入框未清空，消息未真正发送，不记录 replyGuard',
          );
          return false;
        }
        this.deps.logger.warn(
          { shopId, platform, method: result.method, replyLength: text.length },
          'sendReplyFast 失败，回退到逐字模式',
        );
        await this.webviewClient.sendReply(text);
      } else {
        this.deps.logger.debug(
          { shopId, platform, method: result.method, replyLength: text.length },
          '回复已发送',
        );
      }
      return true;
    }

    // 外部客户端嵌入模式（无 CDP）：消息监控通过视觉模式，回复暂不支持
    // 用户可直接在嵌入的客户端窗口中手动回复
    this.deps.logger.warn(
      { shopId, platform, webviewConnected: false, hasExternalClient: this.shopConfig.platform === 'feige' },
      'Webview 不可用，无法发送回复（外部客户端嵌入模式下请手动回复）',
    );
    return false;
  }

  /**
   * 人工手动发送。
   * - sessionId：目标会话，发送前会重新定位当前平台会话并校验，避免发错会话。
   * - clientMessageId：幂等键。相同键若已有 sent 回执，直接返回原回执，不重复发送（MSG-02）。
   * 人工发送不受 AI 开关和人工接管限制（用户显式操作）。
   */
  async sendManualReply(
    text: string,
    opts?: { sessionId?: string; clientMessageId?: string },
  ): Promise<{ status: 'sent' | 'duplicate'; clientMessageId: string | null }> {
    const normalized = text.trim();
    if (!normalized) throw new Error('回复内容不能为空');
    const { shopId } = this.shopConfig;
    const sessionId = opts?.sessionId ?? '';
    const clientMessageId = opts?.clientMessageId?.trim() || null;

    // 幂等检查：已有终态回执则直接返回，不再触发平台发送
    if (clientMessageId) {
      const existing = this.deps.db.outbox.findByClientMessageId(shopId, clientMessageId);
      if (existing && (existing.status === 'sent' || existing.status === 'pending_confirmation')) {
        this.deps.logger.info(
          { shopId, clientMessageId, status: existing.status },
          '人工发送命中幂等回执，跳过重复发送',
        );
        return { status: 'duplicate', clientMessageId };
      }
      // 占位：并发重复请求只会有一个真正发送
      const { created } = this.deps.db.outbox.enqueue({
        shopId,
        sessionId,
        clientMessageId,
        direction: 'out',
        content: normalized,
      });
      if (!created) {
        const current = this.deps.db.outbox.findByClientMessageId(shopId, clientMessageId);
        if (current && current.status !== 'failed') {
          return { status: 'duplicate', clientMessageId };
        }
      }
      this.deps.db.outbox.markStatus(shopId, clientMessageId, 'sending');
    }

    let sent = false;
    try {
      sent = await this.sendReply(normalized, { expectedSessionId: opts?.sessionId });
    } catch (err) {
      if (clientMessageId) {
        this.deps.db.outbox.markStatus(
          shopId,
          clientMessageId,
          'failed',
          err instanceof Error ? err.message : String(err),
        );
      }
      throw err;
    }

    if (!sent) {
      if (clientMessageId) {
        this.deps.db.outbox.markStatus(shopId, clientMessageId, 'failed', '回复发送失败');
      }
      throw new Error('回复发送失败');
    }
    if (clientMessageId) {
      this.deps.db.outbox.markStatus(shopId, clientMessageId, 'sent');
    }
    this.registerSentReply(normalized);
    // 记录人工回复到统一平台消息模型（出向）
    this.recordPlatformMessage({
      sessionId: opts?.sessionId ?? '',
      direction: 'out',
      content: normalized,
      source: 'manual',
      status: 'sent',
    });
    return { status: 'sent', clientMessageId };
  }

  async executeScript(script: string): Promise<unknown> {
    if (!this.webviewClient || !this.webviewClient.isConnected) {
      throw new Error(`店铺 ${this.shopConfig.shopId} Webview 未连接`);
    }
    return this.webviewClient.executeScript(script);
  }

  async runTestReply(message: string): Promise<TestReplyResult> {
    const { shopId } = this.shopConfig;
    const text = message.trim();
    const pipeline: TestReplyResult['pipeline'] = [];
    const startTime = Date.now();

    // 1. 规则引擎匹配
    let matchedRule: string | undefined;
    let reply: string | undefined;
    try {
      const ruleResult = this.ruleEngine.match(text);
      if (ruleResult.matched && ruleResult.answer) {
        matchedRule = ruleResult.ruleName;
        reply = ruleResult.answer;
        pipeline.push({ step: '规则引擎', status: 'ok', detail: `命中规则: ${matchedRule}` });
      } else {
        pipeline.push({ step: '规则引擎', status: 'ok', detail: '未命中规则' });
      }
    } catch (err) {
      pipeline.push({ step: '规则引擎', status: 'fail', detail: String(err) });
    }

    // 2. 商品匹配（用于上下文注入）
    let productMatch: TestReplyResult['productMatch'];
    let productContext = '';
    if (this.productMatcher && !reply) {
      try {
        const matches = this.productMatcher.match(text);
        if (matches.length > 0) {
          const top = matches[0];
          productMatch = {
            productId: top.productId,
            confidence: top.confidence,
            matchType: top.matchType,
          };
          const product = this.productMatcher.getProduct(top.productId);
          if (product) {
            productContext = this.buildProductContext(product);
          }
          pipeline.push({ step: '商品匹配', status: 'ok', detail: `匹配: ${product?.name ?? top.productId}` });
        } else {
          pipeline.push({ step: '商品匹配', status: 'ok', detail: '无匹配' });
        }
      } catch (err) {
        pipeline.push({ step: '商品匹配', status: 'fail', detail: String(err) });
      }
    } else if (reply) {
      pipeline.push({ step: '商品匹配', status: 'skip', detail: '规则已命中，跳过' });
    }

    // 3. DeepSeek 调用（规则未命中时）
    let tokenInput = 0;
    let tokenOutput = 0;
    if (!reply) {
      try {
        const scenario = this.detectScenario(text);
        const chatMessages = this.buildChatMessages(text, [], productContext);
        const response = await this.deps.deepseekClient.chatWithContinuation({
          shopId,
          sessionId: 'test',
          messages: chatMessages,
          scenario,
          platformOverrides: this.getPlatformOverrides(),
        });
        reply = response.content;
        tokenInput = response.tokenInput;
        tokenOutput = response.tokenOutput;
        const truncNote = response.truncated ? ', 续写后仍截断' : '';
        const scenarioNote = scenario ? `, 场景=${scenario}` : '';
        // 检查是否为 fallback 兜底响应（DeepSeekClient 在 API Key 无效/熔断时返回 model='fallback' 或 'circuit-open'）
        // 这种情况下不应该报告 status='ok'，否则会让用户误以为 LLM 真实可用
        if (response.model === 'fallback' || response.model === 'circuit-open') {
          pipeline.push({
            step: 'DeepSeek',
            status: 'fail',
            detail: `LLM 兜底返回（model=${response.model}, ${response.latencyMs}ms）— 可能 API Key 无效、熔断或余额不足`,
          });
        } else {
          pipeline.push({ step: 'DeepSeek', status: 'ok', detail: `${response.model}${scenarioNote}, ${response.latencyMs}ms${truncNote}` });
        }
      } catch (err) {
        pipeline.push({ step: 'DeepSeek', status: 'fail', detail: String(err) });
        reply = this.platformDeepseekConfig.fallback_response;
      }
    } else {
      pipeline.push({ step: 'DeepSeek', status: 'skip', detail: '规则已命中，跳过' });
    }

    // 4. 敏感词检查
    let sensitiveHits: string[] = [];
    try {
      const sensitiveResult = this.deps.sensitiveChecker.check(reply);
      if (!sensitiveResult.passed) {
        sensitiveHits = sensitiveResult.hits.map((h) => h.word);
        reply = this.platformDeepseekConfig.fallback_response;
        pipeline.push({ step: '敏感词检查', status: 'ok', detail: `命中 ${sensitiveHits.length} 个敏感词` });
      } else {
        reply = this.deps.sensitiveChecker.sanitize(reply);
        pipeline.push({ step: '敏感词检查', status: 'ok', detail: '通过' });
      }
    } catch (err) {
      pipeline.push({ step: '敏感词检查', status: 'fail', detail: String(err) });
    }

    return {
      shopId,
      reply: reply ?? '',
      matchedRule,
      productMatch,
      sensitiveHits,
      tokenInput,
      tokenOutput,
      latencyMs: Date.now() - startTime,
      pipeline,
    };
  }

  // ============ 视觉模式轮询 ============

  private async runVisualPoll(): Promise<void> {
    if (this.visualPollInFlight) return;
    // AI 关闭时，跳过视觉轮询（停止所有功能调用）
    if (!this.shopConfig.autoReply) return;

    this.visualPollInFlight = true;
    try {
      this.cleanupExpiredHashes();

      let messages: CdpMessage[] = [];
      const target = this.deps.webviewManager.getVisualCaptureTarget?.(this.shopConfig.shopId);
      if (this.deps.visionClient.isStarted && target) {
        const response = await this.deps.visionClient.detect({
          shopId: this.shopConfig.shopId,
          windowHandle: target.windowHandle,
          captureRegion: target.captureRegion,
          // captureRegion 为 DIP，需带上缩放系数让截图侧换算到物理像素
          scaleFactor: target.scaleFactor,
          mode: 'detect_message',
        });
        if (response.status !== 'ok') {
          throw new Error(response.error ?? 'vision service returned an error');
        }
        // 必须保留买家与卖家两类气泡：findUnrepliedBuyerMessages 依赖
        // "最后一条买家消息之后是否有卖家回复"来判断是否需要回复。
        // 之前只保留买家消息，导致该判断恒为"未回复"，视觉模式会对同一气泡反复回复
        // （仅靠 replyGuard 兜底，且陈旧判定过期后会再次发送）。
        messages = (response.data?.messages ?? [])
          .filter((message) => message.text.trim().length > 0)
          .sort((a, b) => b.bbox[1] - a.bbox[1])
          .map((message) => this.buildVisualMessage(message));
      } else if (this.webviewClient) {
        messages = await this.webviewClient.getLatestMessages();
      }

      // 扫描当前会话中的所有对话，找出未回复的买家气泡消息
      // 策略：从后往前找最后一条买家消息，如果它后面没有卖家回复，则认为该消息未回复
      const unrepliedBuyerMessages = this.findUnrepliedBuyerMessages(messages);

      // 飞鸽系统信号识别：检测"客服XXX接入"/"已接入人工客服"等关键词
      // 场景：买家发"人工"消息 → 飞鸽系统拦截 → 客服接入（from=seller） → AI 应切换到 ManualMode
      // 注意：handleIncomingMessage 不会被调用（因为 unrepliedCount=0），所以必须在此检测
      //
      // 关键约束（2026-07-21 修复）：
      //   之前匹配 /人工客服为您服务/ 会导致 AI 自己的回复被误判为系统信号
      //   现在改为：1. 排除 AI 回复（"亲，"开头等） 2. 只匹配真正系统信号
      //
      // 其他约束：只检查最新一条消息（messages 数组的最后一个元素），
      // 避免扫描历史消息导致应用启动时误判（历史消息中可能包含"客服接入"消息）
      // 去重：使用 sessionId + text 摘要作为 key，避免同一会话重复触发 manualTakeover
      if (this.shopConfig.platform === 'feige' && messages.length > 0) {
        const latestMsg = messages[messages.length - 1];
        const latestText = latestMsg?.text || '';
        // 排除 AI 自己发的回复（避免误判）
        const isAiReplyEcho =
          latestText.startsWith('亲，') ||
          latestText.startsWith('亲 ') ||
          latestText.startsWith('亲~') ||
          /人工客服核实处理/.test(latestText) ||
          /我帮您联系人工客服/.test(latestText) ||
          /请联系人工客服/.test(latestText);
        const isAgentJoinSignal =
          latestMsg &&
          !isAiReplyEcho &&
          (latestMsg.from === 'seller' || latestMsg.from === 'system') &&
          (/客服[^，。！？\s]{1,30}接入/.test(latestText) ||
            /已接入人工客服/.test(latestText));
        if (isAgentJoinSignal && this.stateMachine.currentState !== 'ManualMode') {
          const dedupKey = `feige_agent_join:${latestMsg.sessionId}:${(latestMsg.text || '').slice(0, 50)}`;
          if (!this.processedAgentJoinSignals.has(dedupKey)) {
            this.processedAgentJoinSignals.set(dedupKey, Date.now());
            this.deps.logger.info(
              { shopId: this.shopConfig.shopId, platform: 'feige', sessionId: latestMsg.sessionId, from: latestMsg.from, text: latestMsg.text.slice(0, 80) },
              '检测到飞鸽系统人工客服接入信号，切换到 ManualMode',
            );
            this.deps.metrics.inc(
              'transfer_human_total',
              1,
              { source: 'system_signal', agent_role: 'general', platform: 'feige' },
              this.shopConfig.shopId,
            );
            // 异步触发人工接管 + emit transfer:success 事件让 UI 通知
            void this.manualTakeover().then(() => {
              this.emit('transfer:success', {
                shopId: this.shopConfig.shopId,
                sessionId: latestMsg.sessionId,
                agentName: '飞鸽人工客服',
                role: 'general' as AgentRole,
                reason: '飞鸽系统自动接入人工客服',
              });
            }).catch((err) => {
              this.deps.logger.error({ shopId: this.shopConfig.shopId, err }, '飞鸽系统信号触发人工接管失败');
            });
          }
        }
      }

      this.deps.logger.debug(
        {
          shopId: this.shopConfig.shopId,
          platform: this.shopConfig.platform,
          totalMsgs: messages.length,
          unrepliedCount: unrepliedBuyerMessages.length,
          lastMsgFrom: messages[messages.length - 1]?.from,
          unrepliedText: unrepliedBuyerMessages[0]?.text?.slice(0, 40),
        },
        '视觉轮询扫描会话消息',
      );
      for (const m of unrepliedBuyerMessages) {
        // 已成功回复过的消息跳过（依赖持久化去重记录，避免重复回复）
        if (this.hasSuccessfulReplyGuard(m)) {
          // replyGuard 存在但 findUnrepliedBuyerMessages 仍认为未回复（页面 DOM 无卖家回复）
          // → 可能是 sendReply 返回 true 但网络错误导致消息未真正送达
          // → 如果记录超过 15 秒视为陈旧误判，清除后重新回复
          if (this.isReplyGuardStale(m)) {
            this.deps.logger.warn(
              { shopId: this.shopConfig.shopId, platform: this.shopConfig.platform, sessionId: m.sessionId, messageId: m.messageId, text: m.text.slice(0, 80) },
              '视觉轮询: replyGuard 陈旧（页面仍显示未回复），清除记录并重新回复',
            );
            this.clearStaleReplyGuard(m);
            if (this.isMessageProcessed(m.text, m.timestamp, m.sessionId, m.messageId)) {
              this.unmarkMessageProcessed(m.text, m.timestamp, m.sessionId, m.messageId);
            }
            await this.handleIncomingMessage(m);
          } else {
            this.deps.logger.debug(
              { shopId: this.shopConfig.shopId, platform: this.shopConfig.platform, sessionId: m.sessionId, messageId: m.messageId, text: m.text.slice(0, 80) },
              '视觉轮询: 消息已被成功回复过，跳过（replyGuard 未超时）',
            );
          }
          continue;
        }
        // 未成功回复但被内存去重标记的消息，取消标记以重新触发回复
        if (this.isMessageProcessed(m.text, m.timestamp, m.sessionId, m.messageId)) {
          this.unmarkMessageProcessed(m.text, m.timestamp, m.sessionId, m.messageId);
        }
        await this.handleIncomingMessage(m);
      }
    } catch (err) {
      this.deps.logger.warn(
        {
          shopId: this.shopConfig.shopId,
          err,
          errorMessage: err instanceof Error ? err.message : String(err),
          errorStack: err instanceof Error ? err.stack : undefined,
        },
        '视觉消息拉取失败，尝试 DOM 降级',
      );
      if (this.webviewClient) {
        try {
          const fallbackMessages = await this.webviewClient.getLatestMessages();
          const unrepliedBuyerMessages = this.findUnrepliedBuyerMessages(fallbackMessages);
          // 【临时诊断】DOM 降级后输出 unrepliedCount 日志（确认 DOM 降级路径是否正常工作）
          this.deps.logger.debug(
            {
              shopId: this.shopConfig.shopId,
              platform: this.shopConfig.platform,
              totalMsgs: fallbackMessages.length,
              unrepliedCount: unrepliedBuyerMessages.length,
              lastMsgFrom: fallbackMessages[fallbackMessages.length - 1]?.from,
              unrepliedText: unrepliedBuyerMessages[0]?.text?.slice(0, 40),
              source: 'dom-fallback',
            },
            '视觉轮询扫描会话消息',
          );
          for (const message of unrepliedBuyerMessages) {
            if (this.hasSuccessfulReplyGuard(message)) {
              if (this.isReplyGuardStale(message)) {
                this.deps.logger.warn(
                  { shopId: this.shopConfig.shopId, platform: this.shopConfig.platform, sessionId: message.sessionId, messageId: message.messageId, text: message.text.slice(0, 80) },
                  '视觉轮询(DOM降级): replyGuard 陈旧（页面仍显示未回复），清除记录并重新回复',
                );
                this.clearStaleReplyGuard(message);
                if (this.isMessageProcessed(message.text, message.timestamp, message.sessionId, message.messageId)) {
                  this.unmarkMessageProcessed(message.text, message.timestamp, message.sessionId, message.messageId);
                }
                await this.handleIncomingMessage(message);
              }
              continue;
            }
            if (this.isMessageProcessed(message.text, message.timestamp, message.sessionId, message.messageId)) {
              this.unmarkMessageProcessed(message.text, message.timestamp, message.sessionId, message.messageId);
            }
            await this.handleIncomingMessage(message);
          }
        } catch (fallbackErr) {
          this.deps.logger.debug({ shopId: this.shopConfig.shopId, err: fallbackErr }, 'DOM 消息拉取失败');
        }
      }
    } finally {
      this.visualPollInFlight = false;
    }
  }

  /**
   * 从消息列表中找出未回复的买家消息
   *
   * 扫描策略：从后往前找最后一条买家消息，检查它后面是否有卖家回复。
   * 如果没有卖家回复，则认为该买家消息未回复，需要AI客服自动回复。
   * 如果有卖家回复（包括系统消息中穿插的卖家回复），则认为已回复。
   */
  /**
   * 视觉 OCR 气泡 → 统一消息模型（VISION-DATA-001）。
   *
   * 之前硬编码 sessionId='visual_default'、timestamp=0、无 messageId，导致：
   *   1) 跨店铺共用一个会话标识；
   *   2) 同一会话重复出现的相同文本被 24 小时去重窗口误判为旧消息；
   *   3) 时间恒为 0，无法参与 replyGuard 的陈旧判定。
   *
   * 现在的稳定化策略（全部可在 Node 侧完成，不需要视觉服务返回额外字段）：
   *   - sessionId：店铺作用域稳定标识 visual:{shopId}，避免跨店铺串会话；
   *   - messageId：对 bbox + 文本取稳定哈希，同一气泡每次轮询得到相同 id，
   *     而不同位置/不同文本的相同内容得到不同 id，重复文本不会被误去重；
   *   - timestamp：使用视觉服务返回的采集时间，缺失时取当前时间，保证单调可用。
   */
  private buildVisualMessage(message: {
    bbox: [number, number, number, number];
    text: string;
    isBuyer?: boolean;
    timestamp?: number;
  }): CdpMessage {
    const text = message.text.trim();
    const sessionId = `visual:${this.shopConfig.shopId}`;
    const bboxKey = message.bbox.map((n) => Math.round(n)).join(',');
    const messageId = `visual:${crypto
      .createHash('md5')
      .update(`${sessionId}|${bboxKey}|${text}`)
      .digest('hex')}`;
    const timestamp = typeof message.timestamp === 'number' && message.timestamp > 0
      ? message.timestamp
      : Date.now();
    // 保留视觉服务给出的左右分类：买家气泡在左（isBuyer=true），卖家气泡在右。
    // from 必须是 buyer/seller 二者之一，findUnrepliedBuyerMessages 才能正确判断"是否已回复"。
    const from: 'buyer' | 'seller' = message.isBuyer === false ? 'seller' : 'buyer';
    return { sessionId, from, text, messageId, timestamp };
  }

  private findUnrepliedBuyerMessages(messages: CdpMessage[]): CdpMessage[] {
    if (messages.length === 0) return [];

    // 从后往前找最后一条买家消息
    let lastBuyerIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].from === 'buyer') {
        lastBuyerIndex = i;
        break;
      }
    }
    if (lastBuyerIndex === -1) return [];

    // 会话已转人工（售后 AI 解答不了时触发）：跳过该会话，视为已回复，等待人工客服接管
    if (this.transferredSessions.has(messages[lastBuyerIndex].sessionId)) {
      return [];
    }

    // 检查这条买家消息后面是否有卖家消息
    for (let j = lastBuyerIndex + 1; j < messages.length; j++) {
      if (messages[j].from === 'seller') {
        return []; // 已有卖家回复，不需要再回复
      }
    }

    // 返回未回复的买家消息
    return [messages[lastBuyerIndex]];
  }

  private isMessageProcessed(
    text: string,
    _timestamp: number,
    sessionId: string,
    messageId?: string,
  ): boolean {
    const key = this.createMessageHash(text, sessionId, messageId);
    const now = Date.now();
    const processedAt = this.processedMessageHashes.get(key);
    if (processedAt && now - processedAt < ShopInstance.DEDUP_TTL_MS) {
      return true;
    }
    return false;
  }

  private markMessageProcessed(
    text: string,
    _timestamp: number,
    sessionId: string,
    messageId?: string,
  ): void {
    const key = this.createMessageHash(text, sessionId, messageId);
    this.processedMessageHashes.set(key, Date.now());
    if (this.processedMessageHashes.size > ShopInstance.DEDUP_MAX_SIZE) {
      const entries = [...this.processedMessageHashes.entries()].sort((a, b) => a[1] - b[1]);
      const deleteCount = Math.floor(entries.length / 4);
      for (let i = 0; i < deleteCount; i++) {
        this.processedMessageHashes.delete(entries[i][0]);
      }
    }
  }

  private isLatestSessionMessage(sessionId: string, msg: CdpMessage): boolean {
    const latest = this.latestSessionMessages.get(sessionId);
    return !!latest && this.isSameMessage(latest, msg);
  }

  private isSameMessage(left: CdpMessage, right: CdpMessage): boolean {
    if (left.messageId || right.messageId) {
      return !!left.messageId && left.messageId === right.messageId;
    }
    return this.normalizeObservedText(left.text) === this.normalizeObservedText(right.text)
      && left.productId === right.productId;
  }

  private unmarkMessageProcessed(
    text: string,
    _timestamp: number,
    sessionId: string,
    messageId?: string,
  ): void {
    const key = this.createMessageHash(text, sessionId, messageId);
    this.processedMessageHashes.delete(key);
  }

  private createMessageHash(text: string, sessionId: string, messageId?: string): string {
    const normalized = this.normalizeObservedText(text);
    const identity = messageId ? `id:${messageId}` : `text:${normalized}`;
    return crypto.createHash('md5').update(`${sessionId}|${identity}`).digest('hex');
  }

  private normalizeObservedText(text: string): string {
    const normalized = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => {
        if (!line) return false;
        if (/^(?:昨天\s*)?\d{1,2}:\d{2}(?::\d{2})?$/.test(line)) return false;
        return !/^(?:已读|未读|智能客服|人工|系统消息|商家配置发送|抖音电商智能客服发送)$/.test(line);
      })
      .join('')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '');
    return normalized || text.trim().toLowerCase();
  }

  private isInvalidObservedSessionId(sessionId: string): boolean {
    if (this.shopConfig.platform !== 'feige') return false;
    return /^(?:default|会话|当前会话|留言|智能客服|最近联系)$/.test(sessionId.trim());
  }

  private sanitizeIncomingBuyerText(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (
      /^(?:系统消息|用户正在查看商品，来自电商小助手|商家配置发送)/.test(trimmed)
      || trimmed.includes('来自电商小助手的推荐')
      || trimmed.includes('组件渲染中，请稍后')
    ) {
      return null;
    }

    // 单行 UI 控件 / 系统卡片文本过滤（D-P1-2）
    // 实测：87 条记录显示这些文本被误判为买家消息并触发 AI 回复
    if (
      /^(?:正在加载|加载中|加载失败|加载中\.\.\.|暂无数据|暂无会话权限|登录过期|请重新登录|重新加载)$/.test(trimmed)
    ) {
      return null;
    }
    // 系统关闭会话提示（user_message 示例：'19:07\n用户超时未回复，系统关闭会话'）
    if (/用户超时未回复.*系统关闭会话/.test(trimmed)) {
      return null;
    }
    // 飞鸽用户 ID 字符串（'用户AQCKSVGylDur_HysoB08lDBS-l2XPvr3ATjSGX_SVG9WjSe8j7'）
    if (/^用户[A-Za-z0-9_-]{8,}$/.test(trimmed)) {
      return null;
    }

    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const chromeMarkers = lines.filter((line) =>
      /^(?:列表设置|等待时长|已分组|重复来访|当前会话|最近联系)$/.test(line)
      || /^(?:3分钟内|已超时|人工已)待?回复/.test(line),
    ).length;
    if (chromeMarkers >= 2) {
      const candidates = lines.filter((line) => {
        if (/^(?:列表设置|等待时长|已分组|重复来访|当前会话|最近联系)$/.test(line)) return false;
        if (/^(?:3分钟内|已超时|人工已)待?回复/.test(line)) return false;
        // 系统关闭会话行
        if (/用户超时未回复.*系统关闭会话/.test(line)) return false;
        // 飞鸽用户 ID 行
        if (/^用户[A-Za-z0-9_-]{8,}$/.test(line)) return false;
        if (/^(?:\d+秒|\d{1,2}:\d{2}(?::\d{2})?|\d{1,6}|\(\d+\))$/.test(line)) return false;
        return !/^(?:已读|未读)$/.test(line);
      });
      const lastCandidate = candidates.at(-1);
      return lastCandidate && lastCandidate.length <= 1000 ? lastCandidate : null;
    }

    return trimmed.length <= 4000 ? trimmed : null;
  }

  private registerSentReply(text: string, sentAt: number = Date.now()): void {
    const normalized = this.normalizeObservedText(text);
    if (!normalized) return;
    this.recentSentReplies.set(normalized, sentAt);
    if (this.recentSentReplies.size > ShopInstance.REPLY_ECHO_MAX_SIZE) {
      const oldest = [...this.recentSentReplies.entries()].sort((a, b) => a[1] - b[1]);
      const deleteCount = this.recentSentReplies.size - ShopInstance.REPLY_ECHO_MAX_SIZE;
      for (let i = 0; i < deleteCount; i++) {
        this.recentSentReplies.delete(oldest[i][0]);
      }
    }
  }

  private isOwnReplyEcho(text: string): boolean {
    const normalized = this.normalizeObservedText(text);
    const now = Date.now();
    for (const [reply, sentAt] of this.recentSentReplies) {
      if (now - sentAt >= ShopInstance.REPLY_ECHO_TTL_MS) {
        this.recentSentReplies.delete(reply);
        continue;
      }
      if (normalized === reply || (reply.length >= 6 && normalized.includes(reply))) {
        return true;
      }
    }
    return false;
  }

  private getReplyGuardIdentity(text: string, messageId?: string): {
    messageKey: string;
    textHash: string;
  } {
    const normalized = this.normalizeObservedText(text);
    const textHash = crypto.createHash('sha256').update(normalized).digest('hex');
    const source = messageId ? `id:${messageId}` : `text:${textHash}`;
    const messageKey = crypto.createHash('sha256').update(source).digest('hex');
    return { messageKey, textHash };
  }

  private hasSuccessfulReplyGuard(msg: CdpMessage): boolean {
    try {
      const { messageKey, textHash } = this.getReplyGuardIdentity(msg.text, msg.messageId);
      return this.deps.db.replyGuard.has(
        this.shopConfig.shopId,
        msg.sessionId,
        messageKey,
        textHash,
        Date.now() - ShopInstance.REPLY_TEXT_GUARD_TTL_MS,
      );
    } catch (err) {
      this.deps.logger.debug(
        { shopId: this.shopConfig.shopId, err },
        '查询成功回复去重记录失败，继续使用内存去重',
      );
      return false;
    }
  }

  private recordSuccessfulReplyGuard(msg: CdpMessage, repliedAt: number = Date.now()): void {
    try {
      const { messageKey, textHash } = this.getReplyGuardIdentity(msg.text, msg.messageId);
      this.deps.db.replyGuard.add({
        shopId: this.shopConfig.shopId,
        sessionId: msg.sessionId,
        messageKey,
        textHash,
        messageText: msg.text.slice(0, 4000),
        sourceMessageId: msg.messageId,
        repliedAt,
      });
    } catch (err) {
      this.deps.logger.warn(
        { shopId: this.shopConfig.shopId, sessionId: msg.sessionId, err },
        '保存成功回复去重记录失败',
      );
    }
  }

  /**
   * 检查 replyGuard 记录是否陈旧（sendReply 返回 true 但消息实际未发送到服务器）。
   *
   * 场景：飞鸽页面网络错误（TypeError: Network request failed）导致 sendReply 的 DOM
   * 操作成功但消息未真正送达，replyGuard 记录却已存在。后续视觉轮询发现页面 DOM
   * 仍显示未回复，但被 replyGuard 跳过。
   *
   * 判定：replyGuard 记录存在且距今超过 STALE_REPLY_GUARD_MS（15秒），视为陈旧误判。
   * 15秒阈值给 DOM 渲染留足时间，避免在回复已发送但尚未渲染时误清除。
   *
   * 使用 getRepliedAtAny 双路径查询（messageKey + textHash），因为 loadReplyGuardsFromAudit
   * 重建记录时的 messageKey 与视觉轮询扫描时的 messageKey 可能不同（前者不带 messageId）。
   */
  private isReplyGuardStale(msg: CdpMessage): boolean {
    try {
      const { messageKey, textHash } = this.getReplyGuardIdentity(msg.text, msg.messageId);
      const repliedAt = this.deps.db.replyGuard.getRepliedAtAny(
        this.shopConfig.shopId,
        msg.sessionId,
        messageKey,
        textHash,
      );
      if (repliedAt === null) return false;
      return Date.now() - repliedAt > ShopInstance.STALE_REPLY_GUARD_MS;
    } catch (err) {
      return false;
    }
  }

  /** 清除陈旧的 replyGuard 记录（按 messageKey 和 textHash 同时清除），使后续可重新触发回复 */
  private clearStaleReplyGuard(msg: CdpMessage): boolean {
    try {
      const { messageKey, textHash } = this.getReplyGuardIdentity(msg.text, msg.messageId);
      return this.deps.db.replyGuard.deleteAny(
        this.shopConfig.shopId,
        msg.sessionId,
        messageKey,
        textHash,
      );
    } catch (err) {
      return false;
    }
  }

  private loadReplyGuardsFromAudit(): void {
    try {
      this.deps.db.replyGuard?.cleanup(ShopInstance.REPLY_GUARD_RETENTION_MS);
      const listRecent = this.deps.db.audit.listRecent;
      if (typeof listRecent !== 'function') return;
      const records = listRecent.call(this.deps.db.audit, this.shopConfig.shopId, 1000);
      for (const record of records) {
        if (record.aiReply) {
          this.registerSentReply(record.aiReply, record.createdAt);
        }
        const normalizedUser = this.normalizeObservedText(record.userMessage || '');
        const normalizedReply = this.normalizeObservedText(record.aiReply || '');
        const isSelfReplyEcho = normalizedReply.length >= 6
          && normalizedUser.includes(normalizedReply);
        if (
          record.userMessage
          && record.aiReply
          && !isSelfReplyEcho
          && record.modelVersion !== 'send_failed'
          && record.modelVersion !== 'rate_limited'
        ) {
          this.recordSuccessfulReplyGuard(
            {
              sessionId: record.sessionId,
              from: 'buyer',
              text: record.userMessage,
              timestamp: record.createdAt,
            },
            record.createdAt,
          );
        }
        if (
          record.userMessage
          && Date.now() - record.createdAt < ShopInstance.DEDUP_TTL_MS
          && record.modelVersion !== 'send_failed'
          && record.modelVersion !== 'rate_limited'
        ) {
          const key = this.createMessageHash(record.userMessage, record.sessionId);
          this.processedMessageHashes.set(key, record.createdAt);
        }
      }
    } catch (err) {
      this.deps.logger.debug({ shopId: this.shopConfig.shopId, err }, '加载回复去重记录失败');
    }
  }

  private cleanupExpiredHashes(): void {
    const now = Date.now();
    for (const [key, ts] of this.processedMessageHashes) {
      if (now - ts >= ShopInstance.DEDUP_TTL_MS) {
        this.processedMessageHashes.delete(key);
      }
    }
    // 清理飞鸽系统信号去重记录（24 小时过期，与消息去重 TTL 一致）
    for (const [key, ts] of this.processedAgentJoinSignals) {
      if (now - ts >= ShopInstance.DEDUP_TTL_MS) {
        this.processedAgentJoinSignals.delete(key);
      }
    }
    // 清理会话级转人工标记（24 小时过期，让人工未处理时可重新由 AI 接管）
    for (const [sessionId, ts] of this.transferredSessions) {
      if (now - ts >= ShopInstance.DEDUP_TTL_MS) {
        this.transferredSessions.delete(sessionId);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setTimeout(r, ms);
      t.unref?.();
    });
  }
}
