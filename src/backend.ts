/**
 * 后端工厂模块
 *
 * 从 index.ts 提取的核心初始化逻辑，返回所有组件引用。
 * 供 Electron 主进程和命令行入口共用。
 */
import path from 'path';
import fs from 'fs-extra';
import { ConfigLoader } from './config/ConfigLoader';
import { createLogger, type AppLogger } from './logging/logger';
import { ShopSupervisor } from './shop/ShopSupervisor';
import type { ShopSupervisorDeps } from './shop/ShopSupervisor';
import { ShopDiscovery } from './shop/ShopDiscovery';
import { MetricsCollector } from './monitor/MetricsCollector';
import { AlertManager } from './monitor/AlertManager';
import { VisionClient } from './vision/VisionClient';
import { DeepSeekClient } from './deepseek/DeepSeekClient';
import { RuleEngine } from './rules/RuleEngine';
import { DpapiSecretStore } from './secrets/DpapiSecretStore';
import { SensitiveWordChecker } from './secrets/SensitiveWordChecker';
import { Database } from './db/Database';
import { RateLimiter } from './cache/RateLimiter';
import { LruCache } from './cache/LruCache';
import { HumanSimulator } from './human/HumanSimulator';
import { DiagnosticsRunner } from './diagnostics/DiagnosticsRunner';
import { ProductManager } from './product/ProductManager';
import { ProductSyncService } from './product/ProductSyncService';
import type { Config } from './config/schema';
import type { IWebviewManager } from './cdp/types';
import { HeadlessWebviewManager } from './cdp/HeadlessWebviewManager';
import type { StateName } from './state/ShopStateMachine';
import type winston from 'winston';

import { ModelRegistry } from './gateway/ModelRegistry';
import { ModelGateway } from './gateway/ModelGateway';
import { ConfidenceEvaluator } from './gateway/ConfidenceEvaluator';
import { DeepSeekProvider } from './gateway/providers/DeepSeekProvider';
import { QwenProvider } from './gateway/providers/QwenProvider';
import { OpenAICompatibleProvider } from './gateway/providers/OpenAICompatibleProvider';
import { ClaudeProvider } from './gateway/providers/ClaudeProvider';
import { ALL_PROVIDER_TYPES, type ProviderType } from './gateway/types';
import { LlmProviderStateStore } from './gateway/LlmProviderStateStore';
import { CostTokenBucket } from './scheduler/CostTokenBucket';
import { BudgetTracker } from './scheduler/BudgetTracker';
import { PrioritySelector } from './scheduler/PrioritySelector';
import { ResourceScheduler } from './scheduler/ResourceScheduler';
import { AfterSalesAgent } from './agents/AfterSalesAgent';
import { LogisticsAgent } from './agents/LogisticsAgent';
import { ProductExpertAgent } from './agents/ProductExpertAgent';
import { PreSalesAgent } from './agents/PreSalesAgent';
import { GeneralAgent } from './agents/GeneralAgent';
import { Orchestrator } from './agents/Orchestrator';
import type { IAgent } from './agents/types';
import { QualityEvaluator } from './learning/QualityEvaluator';
import { PatternMatcher } from './learning/PatternMatcher';
import { WorkTimePolicy, getWorkTimeConfig } from './policy/WorkTimePolicy';
import { DialogStateManager } from './dialog/DialogStateManager';
import { LearningPipeline } from './learning/LearningPipeline';
import type { QualityWeights } from './learning/types';
import { IntentClassifier } from './intent/IntentClassifier';
import { ComplexityAssessor } from './intent/ComplexityAssessor';
import { EscalationManager } from './intent/EscalationManager';
import { LlmIntentRecognizer } from './intent/LlmIntentRecognizer';
import { EscalationHandler } from './human/EscalationHandler';
import { BuyerProfileService } from './buyer/BuyerProfileService';
import { ToolRegistry } from './tools/ToolRegistry';
import { QueryStockTool } from './tools/QueryStockTool';
import { QueryProductTool } from './tools/QueryProductTool';
import { QueryShopInfoTool } from './tools/QueryShopInfoTool';
import { TransferHumanTool } from './tools/TransferHumanTool';
import { EmotionDetector } from './intent/EmotionDetector';
import { LlmEmotionDetector } from './intent/LlmEmotionDetector';

export interface Backend {
  config: Config;
  logger: AppLogger;
  db: Database;
  supervisor: ShopSupervisor;
  discovery: ShopDiscovery;
  metrics: MetricsCollector;
  alertManager: AlertManager;
  visionClient: VisionClient;
  deepseekClient: DeepSeekClient;
  ruleEngine: RuleEngine;
  sensitiveChecker: SensitiveWordChecker;
  webviewManager: IWebviewManager;
  rateLimiter: RateLimiter;
  lruCache: LruCache;
  humanSimulator: HumanSimulator;
  secretStore: DpapiSecretStore;
  diagnostics: DiagnosticsRunner;
  productManager: ProductManager;
  productSyncService: ProductSyncService;
  orchestrator: Orchestrator;
  modelGateway: ModelGateway;
  modelRegistry: ModelRegistry;
  llmStateStore: LlmProviderStateStore;
  resourceScheduler: ResourceScheduler;
  qualityEvaluator: QualityEvaluator;
  patternMatcher: PatternMatcher;
  learningPipeline: LearningPipeline;
  intentClassifier: IntentClassifier;
  complexityAssessor: ComplexityAssessor;
  escalationManager: EscalationManager;
  escalationHandler?: EscalationHandler;
  buyerProfileService?: BuyerProfileService;
  toolRegistry?: ToolRegistry;
  shutdown(): Promise<void>;
}

export interface CreateBackendOptions {
  /** 额外的 winston transports（用于日志转发到 UI） */
  extraTransports?: winston.transport[];
  /** 自定义 API Key（优先于环境变量和 DPAPI） */
  apiKey?: string;
  /** Webview 管理器（Electron 入口注入，CLI 入口不传） */
  webviewManager?: IWebviewManager;
  /** 店铺状态变更回调（Electron 入口注入，用于广播到渲染进程） */
  onStateChange?: (shopId: string, state: StateName) => void;
  /**
   * 只读资源根目录（含 config/）。打包后应为 app.getAppPath()，开发时为项目根。
   * 传入后不再依赖 process.cwd()，使从开始菜单/桌面快捷方式启动也能找到配置（DATA-PATH-001）。
   */
  resourceDir?: string;
  /** 可写数据根目录（数据库、店铺 JSON、备份）。打包后应为 userData 路径。 */
  dataDir?: string;
}

export async function createBackend(options?: CreateBackendOptions): Promise<Backend> {
  // 资源目录与数据目录分离：配置只读、数据可写，避免打包后从任意工作目录启动时错位
  const resourceDir = options?.resourceDir ?? process.cwd();
  const configDir = path.resolve(resourceDir, 'config');
  const config = await ConfigLoader.load(configDir);

  // 可写数据目录覆盖（打包后指向 userData，开发时保持项目内路径）
  if (options?.dataDir) {
    config.app.data_dir = options.dataDir;
  }

  const logger = createLogger(config, options?.extraTransports);
  const webviewManager = options?.webviewManager ?? new HeadlessWebviewManager();
  logger.info({ version: config.app.version }, 'AI客服系统启动中');

  const db = new Database(config);
  await db.migrate();

  // 跟踪待完成的备份 Promise，shutdown 时等待其完成后再关闭数据库
  const pendingBackups: Promise<unknown>[] = [];

  // 启动后自动备份数据库（不阻塞启动流程）
  const backupTimeout = setTimeout(() => {
    const p = db.backup()
      .then((path) => logger.info({ path }, '启动时自动备份完成'))
      .catch((err) => logger.warn({ err }, '启动时自动备份失败'));
    pendingBackups.push(p);
  }, 5000);
  backupTimeout.unref?.();

  const envKey = process.env[config.security.api_key_env_var];
  const secretStore = new DpapiSecretStore(config);
  // 优先使用 DPAPI 加密存储（新架构），envKey 作为向后兼容 fallback
  let apiKey: string | null = options?.apiKey ?? null;
  if (!apiKey) {
    apiKey = await secretStore.get('deepseek_api_key');
  }
  if (!apiKey) {
    apiKey = envKey ?? null;
  }
  if (!apiKey) {
    logger.warn(
      { envVar: config.security.api_key_env_var },
      'DeepSeek API Key 未配置；系统将继续启动，请在设置中配置后再启用 AI 回复',
    );
  }
  const effectiveApiKey = apiKey ?? '';

  const metrics = new MetricsCollector(config, db);
  const alertManager = new AlertManager(config, metrics, logger);
  const visionClient = new VisionClient(config, logger);
  // 补发视觉服务退出指标：AlertManager 的 vision_service_exit 规则依赖该指标触发自动恢复
  visionClient.on('exit', (code: number | null) => {
    metrics.inc('vision_service_exit_total', 1, { code: String(code ?? 'unknown') });
  });
  const deepseekClient = new DeepSeekClient(config, effectiveApiKey, metrics);
  const ruleEngine = new RuleEngine(config);
  const sensitiveChecker = new SensitiveWordChecker(config);
  await sensitiveChecker.load();

  const rateLimiter = new RateLimiter(config);
  const lruCache = new LruCache(config);
  const humanSimulator = new HumanSimulator(config);

  // === Multi-Agent + 模型网关 + 资源调度 ===
  // 应用 UI 中保存的 provider 覆盖（enabled/tier/model/api_url/timeout_ms）
  const llmStateStore = new LlmProviderStateStore(config.app.data_dir);
  llmStateStore.applyTo(config);

  // 统一 API Key 读取：先 DPAPI secretStore（llm_api_key_<provider>），再 env var（向后兼容）
  // deepseek 仍读取 deepseek_api_key 以保持向后兼容
  const providerSecretKey = (pt: ProviderType): string =>
    pt === 'deepseek' ? 'deepseek_api_key' : `llm_api_key_${pt}`;

  const getLlmApiKey = async (pt: ProviderType): Promise<string | null> => {
    // 1. DPAPI 加密存储
    const secretKey = providerSecretKey(pt);
    const fromSecret = await secretStore.get(secretKey);
    if (fromSecret) return fromSecret;
    // 2. 环境变量（向后兼容，仅非 deepseek provider 查 env）
    if (pt !== 'deepseek') {
      const envVarName =
        config.gateway.providers[pt as 'qwen'].api_key_env_var ?? `${pt.toUpperCase()}_API_KEY`;
      const fromEnv = process.env[envVarName];
      if (fromEnv) return fromEnv;
    }
    return null;
  };

  const modelRegistry = new ModelRegistry();
  const registeredProviders: ProviderType[] = [];

  // DeepSeek（主用 provider，apiKey 已在上方加载）
  if (config.gateway.providers.deepseek.enabled) {
    const deepseekProvider = new DeepSeekProvider(
      deepseekClient,
      config,
      config.gateway.providers.deepseek.tier,
    );
    modelRegistry.register(deepseekProvider);
    registeredProviders.push('deepseek');
  }

  // 通义千问
  if (config.gateway.providers.qwen.enabled) {
    const qwenApiKey = await getLlmApiKey('qwen');
    if (qwenApiKey) {
      const qwenProvider = new QwenProvider(qwenApiKey, config, config.gateway.providers.qwen.tier);
      modelRegistry.register(qwenProvider);
      registeredProviders.push('qwen');
      logger.info({ tier: config.gateway.providers.qwen.tier }, '通义千问 Provider 已注册');
    } else {
      logger.warn('通义千问已启用但未配置 API Key，跳过注册');
    }
  }

  // OpenAI GPT
  if (config.gateway.providers.openai.enabled) {
    const openaiApiKey = await getLlmApiKey('openai');
    if (openaiApiKey) {
      const openaiProvider = new OpenAICompatibleProvider(
        'openai',
        openaiApiKey,
        config,
        config.gateway.providers.openai.tier,
      );
      modelRegistry.register(openaiProvider);
      registeredProviders.push('openai');
      logger.info({ tier: config.gateway.providers.openai.tier }, 'OpenAI Provider 已注册');
    } else {
      logger.warn('OpenAI 已启用但未配置 API Key，跳过注册');
    }
  }

  // Anthropic Claude
  if (config.gateway.providers.claude.enabled) {
    const claudeApiKey = await getLlmApiKey('claude');
    if (claudeApiKey) {
      const claudeProvider = new ClaudeProvider(
        claudeApiKey,
        config,
        config.gateway.providers.claude.tier,
      );
      modelRegistry.register(claudeProvider);
      registeredProviders.push('claude');
      logger.info({ tier: config.gateway.providers.claude.tier }, 'Anthropic Claude Provider 已注册');
    } else {
      logger.warn('Claude 已启用但未配置 API Key，跳过注册');
    }
  }

  // Moonshot Kimi
  if (config.gateway.providers.kimi.enabled) {
    const kimiApiKey = await getLlmApiKey('kimi');
    if (kimiApiKey) {
      const kimiProvider = new OpenAICompatibleProvider(
        'kimi',
        kimiApiKey,
        config,
        config.gateway.providers.kimi.tier,
      );
      modelRegistry.register(kimiProvider);
      registeredProviders.push('kimi');
      logger.info({ tier: config.gateway.providers.kimi.tier }, 'Moonshot Kimi Provider 已注册');
    } else {
      logger.warn('Kimi 已启用但未配置 API Key，跳过注册');
    }
  }

  // 智谱 GLM
  if (config.gateway.providers.glm.enabled) {
    const glmApiKey = await getLlmApiKey('glm');
    if (glmApiKey) {
      const glmProvider = new OpenAICompatibleProvider(
        'glm',
        glmApiKey,
        config,
        config.gateway.providers.glm.tier,
      );
      modelRegistry.register(glmProvider);
      registeredProviders.push('glm');
      logger.info({ tier: config.gateway.providers.glm.tier }, '智谱 GLM Provider 已注册');
    } else {
      logger.warn('GLM 已启用但未配置 API Key，跳过注册');
    }
  }

  // 百川 Baichuan
  if (config.gateway.providers.baichuan.enabled) {
    const baichuanApiKey = await getLlmApiKey('baichuan');
    if (baichuanApiKey) {
      const baichuanProvider = new OpenAICompatibleProvider(
        'baichuan',
        baichuanApiKey,
        config,
        config.gateway.providers.baichuan.tier,
      );
      modelRegistry.register(baichuanProvider);
      registeredProviders.push('baichuan');
      logger.info({ tier: config.gateway.providers.baichuan.tier }, '百川 Baichuan Provider 已注册');
    } else {
      logger.warn('Baichuan 已启用但未配置 API Key，跳过注册');
    }
  }

  // 注：本地模型 Ollama 已于 2026-07 移除（用户明确不需要本地模型）
  // 如需恢复，重新引入 LocalModelProvider 并在 config.gateway.providers.local 注册

  logger.info(
    { count: registeredProviders.length, providers: registeredProviders, totalSupported: ALL_PROVIDER_TYPES.length },
    'LLM Provider 注册完成',
  );

  const costTokenBucket = new CostTokenBucket(config);
  const budgetTracker = new BudgetTracker(config);
  const prioritySelector = new PrioritySelector(config);
  const resourceScheduler = new ResourceScheduler({
    tokenBucket: costTokenBucket,
    budgetTracker,
    prioritySelector,
    metrics,
    logger,
    config,
  });

  const confidenceEvaluator = new ConfidenceEvaluator();
  const modelGateway = new ModelGateway({
    registry: modelRegistry,
    confidenceEvaluator,
    scheduler: resourceScheduler,
    metrics,
    logger,
    config,
  });

  const agents: IAgent[] = [
    new AfterSalesAgent(modelGateway, resourceScheduler, logger),
    new LogisticsAgent(modelGateway, resourceScheduler, logger),
    new ProductExpertAgent(modelGateway, resourceScheduler, logger),
    new PreSalesAgent(modelGateway, resourceScheduler, logger),
    new GeneralAgent(modelGateway, resourceScheduler, logger),
  ];

  const orchestrator = new Orchestrator({
    agents,
    logger,
    metrics,
    config,
  });

  if (config.vision.enabled) {
    try {
      await visionClient.start();
      logger.info('视觉服务启动成功');
    } catch (err) {
      logger.error({ err }, '视觉服务启动失败，视觉模式不可用');
    }
  }

  await alertManager.start();

  const cleanupTimer = setInterval(() => {
    try {
      const metricsRetentionMs = config.monitor.metrics_retention_days * 86400000;
      const auditRetentionMs = config.logging.audit_retention_days * 86400000;
      const metricsDeleted = db.metrics.cleanup(metricsRetentionMs);
      const auditDeleted = db.audit.cleanup(auditRetentionMs);
      // 清理过期会话上下文（此前 cleanupIdle 无调用者，上下文表依赖单会话 5 分钟清理）
      let contextDeleted = 0;
      try {
        contextDeleted = supervisor.cleanupIdleContexts();
      } catch (err) {
        logger.warn({ err }, '清理过期上下文失败');
      }
      if (metricsDeleted > 0 || auditDeleted > 0 || contextDeleted > 0) {
        logger.info({ metricsDeleted, auditDeleted, contextDeleted }, '数据库定期清理完成');
      }
    } catch (err) {
      // 清理失败绝不能导致进程崩溃（无监听器的 uncaughtException 会直接退出）
      logger.error({ err }, '数据库定期清理失败');
    }
  }, 3600000);
  cleanupTimer.unref?.();

  await fs.ensureDir(path.join(config.app.data_dir, 'data', 'shops'));

  // === 闭环学习系统 ===
  const learningWeights: QualityWeights = {
    confidence: config.learning.weights.confidence,
    latency: config.learning.weights.latency,
    structure: config.learning.weights.structure,
    safety: config.learning.weights.safety,
    feedback: config.learning.weights.feedback,
  };
  const qualityEvaluator = new QualityEvaluator(learningWeights);
  const patternMatcher = new PatternMatcher({
    learningRepo: db.learning,
    config,
    logger,
  });
  const learningPipeline = new LearningPipeline({
    auditRepo: db.audit,
    qualityRepo: db.quality,
    learningRepo: db.learning,
    feedbackRepo: db.feedback,
    qualityEvaluator,
    patternMatcher,
    config,
    logger,
  });

  if (config.learning.enabled) {
    patternMatcher.loadAll();
    learningPipeline.start();
    logger.info('闭环学习系统已启用');
  }

  // === 智能化客服系统模块 ===
  const intentClassifier = new IntentClassifier(config, logger);
  const complexityAssessor = new ComplexityAssessor(config);
  const escalationManager = new EscalationManager(db.intent, logger, metrics);
  // 注入 ModelGateway（让 LLM 意图识别走多 provider 路径，DeepSeek 故障时自动 fallback）
  const llmIntentRecognizer = new LlmIntentRecognizer(modelGateway, config);

  const discovery = new ShopDiscovery(config, db, logger);
  const workTimePolicy = new WorkTimePolicy(getWorkTimeConfig(config), logger, db.pendingMessages);
  // 注入 ModelGateway（让槽位 LLM 抽取走多 provider 路径）
  const dialogStateManager = new DialogStateManager(db, undefined, modelGateway, logger);
  // 跨会话买家记忆服务（让 AI 像真人客服一样认得老顾客）
  const buyerProfileService = new BuyerProfileService({
    db,
    logger,
    config: config.buyer,
  });

  // Function Calling 工具注册中心（让 AI 能执行查库存/查商品/查店铺信息/转人工等业务动作）
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(QueryStockTool);
  toolRegistry.register(QueryProductTool);
  toolRegistry.register(QueryShopInfoTool);
  toolRegistry.register(TransferHumanTool);
  logger.info({ toolCount: toolRegistry.size }, 'Function Calling 工具已注册');

  // LLM 增强情绪检测器（语义级情绪识别，fallback 到关键词规则匹配）
  // 注入 ModelGateway（让情绪检测走多 provider 路径）
  const emotionDetector = new LlmEmotionDetector(new EmotionDetector(), modelGateway);

  const supervisorDeps: ShopSupervisorDeps = {
    config,
    db,
    logger,
    metrics,
    alertManager,
    visionClient,
    deepseekClient,
    // 新增 gateway：让 ShopSupervisor 的 LLM 二次验证走多 provider 路径
    gateway: modelGateway,
    orchestrator,
    ruleEngine,
    sensitiveChecker,
    webviewManager,
    rateLimiter,
    lruCache,
    humanSimulator,
    patternMatcher: config.learning.enabled ? patternMatcher : undefined,
    intentClassifier: config.intent.enabled ? intentClassifier : undefined,
    complexityAssessor: config.intent.enabled ? complexityAssessor : undefined,
    escalationManager: config.intent.enabled ? escalationManager : undefined,
    llmIntentRecognizer: config.intent.enabled ? llmIntentRecognizer : undefined,
    workTimePolicy,
    dialogStateManager,
    buyerProfileService,
    toolRegistry,
    emotionDetector,
    onStateChange: options?.onStateChange,
  };

  // 创建 EscalationHandler（在 supervisor 之后，解决循环依赖）
  let escalationHandler: EscalationHandler | undefined;
  if (config.human_collab.enabled) {
    escalationHandler = new EscalationHandler({
      config,
      intentRepo: db.intent,
      agentRepo: db.agent,
      escalationManager,
      logger,
      metrics,
    });
    supervisorDeps.escalationHandler = escalationHandler;
    escalationManager.on('escalation', (record) => {
      void escalationHandler?.handleEscalation(record);
    });
    escalationHandler.start();
    logger.info('人工协作增强已启用');
  }

  const supervisor = new ShopSupervisor(supervisorDeps);

  const diagnostics = new DiagnosticsRunner({
    config,
    db,
    visionClient,
    logger,
    getApiKey: () => deepseekClient.currentApiKey,
    getShopCount: () => supervisor.shopCount,
  });

  const productManager = new ProductManager(config);
  const productSyncService = new ProductSyncService(
    supervisor,
    productManager,
    logger,
    config.app.data_dir,
    webviewManager,
  );

  const configWatcher = ConfigLoader.watch(configDir, async () => {
    try {
      const newConfig = await ConfigLoader.load(configDir);
      // 运行时 provider 覆盖层在每次 YAML 重载后都必须重新应用。
      llmStateStore.applyTo(newConfig);
      // 所有组件最初接收的是同一个 Config 对象；原地替换顶层字段，
      // 让按调用读取配置的组件立即看到新值。
      Object.assign(config, newConfig);
      deepseekClient.updateConfig(config);
      for (const provider of modelRegistry.getAll()) provider.updateConfig(config);
      modelRegistry.refreshTierMapping();
      resourceScheduler.updateConfig(config);
      supervisor.reloadAllRules();
      workTimePolicy.updateConfig(getWorkTimeConfig(config));
      logger.info('配置已热重载');
    } catch (err) {
      logger.error({ err }, '配置热重载失败');
    }
  });

  const shutdown = async (): Promise<void> => {
    logger.info('开始优雅关闭');
    clearInterval(cleanupTimer);
    // 取消尚未触发的启动备份定时器，避免 shutdown 后仍触发 db.backup()
    clearTimeout(backupTimeout);
    configWatcher?.close();
    // 先停止会写库的异步组件（若返回 Promise 则等待完成），再关闭数据库，
    // 避免其内部异步任务仍在写已关闭的 db
    try { learningPipeline.stop(); } catch (err) { logger.warn({ err }, 'learningPipeline 停止异常'); }
    try { escalationHandler?.stop(); } catch (err) { logger.warn({ err }, 'escalationHandler 停止异常'); }
    await supervisor.stopAll();
    await visionClient.stop();
    await alertManager.stop();
    await metrics.stop();
    // 等待可能的备份完成（备份读取 db，必须在 db.close() 之前）
    await Promise.allSettled(pendingBackups);
    await db.close();
    secretStore.clearAll();
    logger.info('系统已退出');
  };

  return {
    config,
    logger,
    db,
    supervisor,
    discovery,
    metrics,
    alertManager,
    visionClient,
    deepseekClient,
    ruleEngine,
    sensitiveChecker,
    webviewManager,
    rateLimiter,
    lruCache,
    humanSimulator,
    secretStore,
    diagnostics,
    productManager,
    productSyncService,
    orchestrator,
    modelGateway,
    modelRegistry,
    llmStateStore,
    resourceScheduler,
    qualityEvaluator,
    patternMatcher,
    learningPipeline,
    intentClassifier,
    complexityAssessor,
    escalationManager,
    escalationHandler,
    buyerProfileService,
    toolRegistry,
    shutdown,
  };
}
