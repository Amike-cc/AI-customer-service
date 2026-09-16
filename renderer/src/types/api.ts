export interface ShopListItem {
  shopId: string;
  shopName: string;
  platform: string;
  enabled: boolean;
  autoReply: boolean;
  loginStatus: 'logged_out' | 'logging_in' | 'logged_in';
  lastLoginAt: number | null;
  createdAt: number;
  updatedAt: number;
  state: string | null;
  stateRecord: unknown;
}

/** 语气风格 */
export type PersonaTone = 'professional' | 'friendly' | 'lively' | 'cute';

/** 店铺人设配置（控制 AI 回复的语气和拟人化程度） */
export interface ShopPersona {
  /** 语气风格 */
  tone: PersonaTone;
  /** 客服人设昵称（如"小柚子"），空字符串表示不设置 */
  nickname: string;
  /** 口头禅列表（最多 5 个） */
  catchphrases: string[];
  /** 是否使用表情符号 */
  useEmojis: boolean;
  /** 自定义人设描述（最多 200 字） */
  description: string;
}

export interface ShopBusinessConfig {
  shopId: string;
  deliveryAddress: string;
  deliveryTime: string;
  freightInsurance: boolean;
  expressCompanies: string[];
  freeShipping: boolean;
  freeShippingCondition: string;
  mainCategory: string;
  /** 客服专员映射：专员角色 → 飞鸽客服账号名（用于智能路由转接） */
  agentMappings: Record<string, string>;
  /** 店铺人设（控制 AI 回复的语气和拟人化程度） */
  persona: ShopPersona;
  createdAt: number;
  updatedAt: number;
}

// ============ 多 LLM Provider 配置类型 ============

export type ProviderType =
  | 'deepseek'
  | 'qwen'
  | 'openai'
  | 'claude'
  | 'kimi'
  | 'glm'
  | 'baichuan';

export type ModelTier = 'tier1' | 'tier2' | 'tier3';

export interface ProviderOverride {
  enabled?: boolean;
  tier?: ModelTier;
  model?: string;
  api_url?: string;
  timeout_ms?: number;
}

export interface LlmProviderInfo {
  type: ProviderType;
  label: string;
  description: string;
  docsUrl: string;
  apiKeysUrl: string;
  enabled: boolean;
  tier: ModelTier | null;
  model: string | null;
  apiUrl: string | null;
  timeoutMs: number | null;
  apiKeyEnvVar: string | null;
  anthropicVersion: string | null;
  apiKeyConfigured: boolean;
  registered: boolean;
  isDefault: boolean;
  hasOverride: boolean;
}

export interface LlmProvidersResult {
  ok: boolean;
  providers?: LlmProviderInfo[];
  defaultProvider?: ProviderType;
  cascade?: {
    enabled: boolean;
    confidence_thresholds: { tier1: number; tier2: number; tier3: number };
    max_depth: number;
  };
  error?: string;
}

export interface LlmApiKeyResult {
  ok: boolean;
  masked?: string;
  configured?: boolean;
  note?: string;
  error?: string;
}

export interface LlmActionResult {
  ok: boolean;
  requiresRestart?: boolean;
  error?: string;
}

export interface LlmTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
}

export interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
  meta: Record<string, unknown>;
}

export interface AlertEntry {
  name: string;
  level: 'info' | 'warn' | 'critical';
  title: string;
  message: string;
  shopId?: string;
  timestamp: number;
}

export interface ConversationSession {
  sessionId: string;
  messageCount: number;
  lastMessageAt: number;
  productId: string | null;
}

export interface ConversationMessage {
  id: number;
  shopId: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  productId?: string;
  tokenCount?: number;
  createdAt: number;
}

/** 统一平台消息（conversation_messages 表，区别于 LLM 上下文的 ConversationMessage） */
export interface PlatformMessage {
  id: number;
  shopId: string;
  sessionId: string;
  messageId: string;
  direction: 'in' | 'out';
  source: string;
  content: string;
  status: string;
  platformRef: string | null;
  createdAt: number;
}

/** 工作台会话摘要使用已有的 ConversationSession 类型 */

export interface MetricsSummary {
  since: number;
  shopId: string | null;
  apiCalls: number;
  tokensInput: number;
  tokensOutput: number;
  messagesReceived: number;
  repliesSent: number;
  replyFailed: number;
  rateLimitRejected: number;
  sensitiveBlocked: number;
  stateTransitions: number;
  avgApiLatency: number;
}

export interface MetricsBucket {
  bucketStart: number;
  total: number;
  count: number;
}

export interface MetricsHistory {
  metricName: string;
  since: number;
  until: number;
  bucketMs: number;
  shopId: string | null;
  buckets: MetricsBucket[];
}

export interface DiagnosticResult {
  id: string;
  name: string;
  category: 'config' | 'python' | 'models' | 'files' | 'runtime';
  status: 'pass' | 'fail' | 'warn' | 'skip';
  message: string;
  detail?: string;
  fixSuggestion?: string;
}

export interface DiagnosticSummary {
  results: DiagnosticResult[];
  total: number;
  pass: number;
  warn: number;
  fail: number;
  skip: number;
  healthScore: number;
  runAt: number;
}

export interface RuleInfo {
  name: string;
  pattern: string;
  answer: string;
  priority: number;
  enabled: boolean;
  source: 'default' | 'custom' | 'faq';
}

export interface RuleMatchResult {
  matched: boolean;
  answer?: string;
  ruleName?: string;
}

export interface FaqInfo {
  q: string;
  a: string;
  priority: number;
  category?: string;
  tags?: string[];
  updatedAt?: number;
}

export interface Product {
  product_id: string;
  name: string;
  sku: string;
  specs: Array<{ name: string; values: string[] }>;
  attrs: Array<{ name: string; value: string }>;
  variants: Array<{ spec: string; price: number; stock: number; sku: string }>;
  shipping: { free_shipping: boolean; delivery_days: string; logistics: string[] };
  after_sales: { return_days: number; exchange_days: number; policy: string };
  faq: Array<{ q: string; a: string }>;
  keywords: string[];
  active: boolean;
  description?: string;
  category?: string;
  images?: string[];
  createdAt?: string;
  updatedAt?: string;
  /** 销量 */
  sales?: number;
}

export interface ImportResult {
  imported: number;
  errors: string[];
}

export interface SyncResult {
  shopId: string;
  total: number;
  imported: number;
  updated: number;
  removed: number;
  skipped: number;
  errors: string[];
  syncedAt: number;
  failedProducts?: Array<{ productId: string; name: string; reason: string }>;
}

export interface SyncProgress {
  phase: 'opening' | 'scanning' | 'saving' | 'done' | 'error';
  page?: number;
  found?: number;
  total?: number;
  message?: string;
}

export interface SyncStatus {
  shopId: string;
  lastSyncAt: number | null;
  lastResult: SyncResult | null;
  productCount: number;
}

export type TemplateCategory =
  | 'greeting' | 'pre_sales' | 'after_sales' | 'logistics'
  | 'activity' | 'complaint' | 'closing';

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

export type VersionComponent = 'prompt' | 'faq' | 'rules' | 'sensitive' | 'templates';

export interface KbVersion {
  versionId: string;
  shopId: string;
  createdAt: number;
  createdBy: string;
  component: VersionComponent;
  action: 'update' | 'import' | 'rollback';
  snapshot: string;
  description: string;
}

export interface ShopPermissions {
  shopId: string;
  allowedUsers: string[];
  editors: string[];
  reviewers: string[];
  publishers: string[];
  updatedAt: number;
}

export type ReviewStatus = 'draft' | 'pending_review' | 'approved' | 'rejected' | 'published';

export interface ReviewRecord {
  reviewId: string;
  shopId: string;
  component: 'faq' | 'template' | 'prompt';
  targetId: string;
  status: ReviewStatus;
  author: string;
  reviewer: string | null;
  submittedAt: number;
  reviewedAt: number | null;
  reviewComment: string | null;
  payload: string;
}

export interface AccuracyStats {
  shopId: string;
  period: 'day' | 'week' | 'month';
  totalReplies: number;
  ruleMatched: number;
  aiReplies: number;
  thumbsUp: number;
  thumbsDown: number;
  noFeedback: number;
  accuracy: number;
  meetsTarget: boolean;
  target: number;
}

export interface AccuracyTrendPoint {
  timestamp: number;
  accuracy: number;
  totalReplies: number;
  thumbsDown: number;
}

export interface OptimizationSuggestion {
  type: 'new_faq' | 'update_rule' | 'review_prompt';
  description: string;
  examples: string[];
  priority: 'high' | 'medium' | 'low';
}

export interface AuditLogEntry {
  id: number;
  shopId: string;
  sessionId: string;
  userMessage: string;
  aiReply: string;
  modelVersion: string;
  promptHash: string;
  productId?: string | null;
  tokenInput?: number | null;
  tokenOutput?: number | null;
  latencyMs?: number | null;
  confidence?: number | null;
  createdAt: number;
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

export interface AutoReplyDiagnosticReport {
  shopId: string;
  shopName: string;
  platform: string;
  autoReply: boolean;
  loginStatus: string;
  hasShop: boolean;
  state: string | null;
  apiKeyConfigured: boolean;
  apiKeyPreview: string;
  ruleCount: number;
  platformUrl: string;
  issues: string[];
}

export interface SystemHealthReport {
  uptime: number;
  pid: number;
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
  };
  database: {
    walMode: string;
    dbSizeBytes: number;
    tableCounts: Record<string, number>;
  };
  cache: {
    totalEntries: number;
    shopEntries: Record<string, number>;
    totalHitCount: number;
    oldestCreatedAt: number | null;
  };
  deepseek: {
    apiKeyConfigured: boolean;
    circuitState: 'closed' | 'open' | 'half-open';
    consecutiveFailures: number;
    circuitOpenedAt: number;
  };
  shops: Array<{
    shopId: string;
    shopName: string;
    platform: string;
    autoReply: boolean;
    loginStatus: string;
    state: string | null;
  }>;
  metrics: {
    apiCalls: number;
    messagesReceived: number;
    repliesSent: number;
    replyFailed: number;
    sensitiveBlocked: number;
    avgApiLatency: number;
  };
  timestamp: number;
}

export interface SensitiveWordEntry {
  word: string;
  category: string;
  action: string;
}

export interface FeedbackEntry {
  id: number;
  auditId: number;
  shopId: string;
  sessionId: string;
  rating: number;
  comment: string | null;
  createdAt: number;
}

export interface FeedbackStats {
  total: number;
  positive: number;
  negative: number;
  positiveRate: number;
}

export interface LearnedPatternEntry {
  id: number;
  shopId: string;
  questionPattern: string;
  answerTemplate: string;
  questionHash: string;
  matchCount: number;
  feedbackSum: number;
  avgQuality: number;
  sourceAuditIds: string | null;
  status: 'active' | 'deprecated';
  createdAt: number;
  updatedAt: number;
}

export interface LearningRunEntry {
  id: number;
  shopId: string | null;
  startedAt: number;
  completedAt: number;
  collectedCount: number;
  extractedCount: number;
  validatedCount: number;
  status: 'running' | 'completed' | 'failed';
  errorMessage: string | null;
  metricsJson: string | null;
}

export interface LearningStats {
  totalPatterns: number;
  activePatterns: number;
  totalMatches: number;
  avgQuality: number;
  positiveFeedback: number;
  negativeFeedback: number;
}

// === 智能化客服系统类型 ===

export interface IntentClassificationRecord {
  id: number;
  shopId: string;
  sessionId: string;
  auditId?: number;
  userMessage: string;
  category: string;
  confidence: number;
  complexityLevel: string;
  complexityScore: number;
  entities: string | null;
  shouldEscalate: number;
  createdAt: number;
}

export interface IntentCategoryStat {
  category: string;
  count: number;
}

export interface EscalationStats {
  categoryStats: IntentCategoryStat[];
  escalationStats: Array<{ status: string; count: number }>;
}

export interface EscalationRecord {
  id: number;
  shopId: string;
  sessionId: string;
  auditId?: number;
  reason: string;
  priority: 'urgent' | 'high' | 'medium' | 'low';
  status: 'pending' | 'assigned' | 'resolved';
  assignedAgentId?: string;
  requiredSkills: string[];
  createdAt: number;
  assignedAt?: number;
  resolvedAt?: number;
  resolution?: string;
}

export interface QueueEntry {
  escalationId: number;
  shopId: string;
  sessionId: string;
  priority: 'urgent' | 'high' | 'medium' | 'low';
  reason: string;
  requiredSkills: string[];
  enqueuedAt: number;
  estimatedWaitMs: number;
}

export interface HumanAgent {
  id: string;
  shopId: string;
  name: string;
  status: 'available' | 'busy' | 'offline';
  activeChats: number;
  maxChats: number;
  skills: string[];
  lastAssignedAt?: number;
  detectedAt: number;
  updatedAt: number;
}

export interface LearningTriggerResult {
  ok: boolean;
  collectedCount: number;
  cleanedCount: number;
  scoredCount: number;
  extractedCount: number;
  validatedCount: number;
}

export interface DeepseekErrorEvent {
  shopId: string;
  sessionId: string;
  errorType: 'auth_failed' | 'insufficient_balance' | 'timeout' | 'rate_limit' | 'error' | 'circuit_open';
  message: string;
  timestamp: number;
}

export interface Api {
  app: {
    openExternal: (url: string) => Promise<void>;
  };
  shop: {
    list: () => Promise<ShopListItem[]>;
    takeover: (shopId: string) => Promise<{ ok: boolean }>;
    release: (shopId: string) => Promise<{ ok: boolean }>;
    setAutoReply: (shopId: string, autoReply: boolean) => Promise<{ ok: boolean }>;
    addAccount: (shopName: string, platform?: string) => Promise<{ ok: boolean; shopId: string }>;
    removeAccount: (shopId: string) => Promise<{ ok: boolean }>;
    switchView: (shopId: string) => Promise<{ ok: boolean }>;
    exitView: () => Promise<{ ok: boolean }>;
    getLoginStatus: (shopId: string) => Promise<{ loginStatus: string }>;
    forceReLogin: (shopId: string) => Promise<{ ok: boolean; error?: string }>;
    reload: (shopId: string) => Promise<{ ok: boolean; error?: string }>;
    getActiveShop: () => Promise<{ shopId: string | null }>;
    start: (shopId: string) => Promise<{ ok: boolean; state: string | null }>;
    stop: (shopId: string) => Promise<{ ok: boolean; state: string | null }>;
    rename: (shopId: string, newName: string) => Promise<{ ok: boolean }>;
    markRead: (shopId: string) => Promise<{ ok: boolean }>;
    sendReply: (
      shopId: string,
      text: string,
      opts?: { sessionId?: string; clientMessageId?: string },
    ) => Promise<{ ok: boolean; status?: 'sent' | 'duplicate'; clientMessageId?: string | null; error?: string }>;
    getBusinessConfig: (shopId: string) => Promise<{ ok: boolean; config?: ShopBusinessConfig; error?: string }>;
    updateBusinessConfig: (shopId: string, updates: Partial<ShopBusinessConfig>) => Promise<{ ok: boolean; error?: string }>;
    onStateChanged: (cb: (data: unknown) => void) => () => void;
    onLoginStatusChanged: (cb: (data: { shopId: string; status: string; oldStatus?: string }) => void) => () => void;
    onNameUpdated: (cb: (data: { shopId: string; shopName: string }) => void) => () => void;
    onTransferEvent: (cb: (data: {
      type: 'success' | 'failed';
      shopId: string;
      sessionId: string;
      role?: string;
      agentName?: string;
      reason?: string;
    }) => void) => () => void;
  };
  deepseek: {
    onError: (cb: (data: DeepseekErrorEvent) => void) => () => void;
  };
  config: {
    get: () => Promise<Record<string, unknown>>;
    getApiKey: () => Promise<string>;
    updateApiKey: (key: string) => Promise<{ ok: boolean }>;
    // 多 LLM Provider 配置
    getLlmProviders: () => Promise<LlmProvidersResult>;
    getLlmApiKey: (providerType: ProviderType) => Promise<LlmApiKeyResult>;
    updateLlmApiKey: (providerType: ProviderType, newKey: string) => Promise<LlmActionResult>;
    updateLlmProvider: (
      providerType: ProviderType,
      updates: ProviderOverride,
    ) => Promise<LlmActionResult>;
    resetLlmProvider: (providerType: ProviderType) => Promise<LlmActionResult>;
    setDefaultLlmProvider: (providerType: ProviderType) => Promise<LlmActionResult>;
    testLlmProvider: (providerType: ProviderType) => Promise<LlmTestResult>;
  };
  log: {
    subscribe: () => Promise<{ ok: boolean; bufferSize: number }>;
    history: (
      limit?: number,
      offset?: number,
    ) => Promise<{ entries: LogEntry[]; total: number; offset: number; limit: number }>;
    onStream: (cb: (entry: LogEntry) => void) => () => void;
  };
  alert: {
    list: () => Promise<AlertEntry[]>;
    acknowledge: (name: string) => Promise<{ ok: boolean }>;
    onStream: (cb: (alert: AlertEntry) => void) => () => void;
    onRecovered: (cb: (info: unknown) => void) => () => void;
  };
  conversation: {
    sessions: (shopId: string, limit?: number) => Promise<ConversationSession[]>;
    messages: (
      shopId: string,
      sessionId: string,
      limit?: number,
      offset?: number,
    ) => Promise<ConversationMessage[]>;
    search: (shopId: string, keyword: string, limit?: number) => Promise<ConversationMessage[]>;
    platformSessions: (
      shopId: string,
      limit?: number,
    ) => Promise<
      Array<{
        sessionId: string;
        lastMessageAt: number;
        messageCount: number;
        lastDirection?: 'in' | 'out';
        hasManual?: boolean;
      }>
    >;
    stream: (shopId: string, sessionId: string, afterMessageId?: number, limit?: number) => Promise<PlatformMessage[]>;
    sendText: (
      shopId: string,
      sessionId: string,
      text: string,
      clientMessageId?: string,
      messageVersion?: number,
    ) => Promise<{ ok: boolean; status?: 'sent' | 'duplicate'; clientMessageId?: string | null; error?: string }>;
    sendAttachment: (
      shopId: string,
      sessionId: string | undefined,
      file: { name?: string; size?: number; type?: string },
      clientMessageId?: string,
    ) => Promise<{ ok: boolean; status?: string; message?: string; error?: string }>;
    draft: (
      shopId: string,
      sessionId: string,
      draft?: string,
    ) => Promise<{ ok: boolean; draft: string }>;
    onMessage: (cb: (data: unknown) => void) => () => void;
  };
  workspace: {
    getSnapshot: (shopId: string) => Promise<{ ok: boolean; snapshot?: unknown; error?: string }>;
    setLayout: (layout: {
      sidebarWidth?: number;
      rightPanelWidth?: number;
      rightPanelVisible?: boolean;
    }) => Promise<{ ok: boolean; layout: unknown }>;
  };
  search: {
    global: (
      query: string,
      opts?: { types?: string[]; shopIds?: string[]; limit?: number },
    ) => Promise<{ ok: boolean; query?: string; groups?: unknown[]; total?: number; error?: string }>;
  };
  order: {
    summary: (
      shopId: string,
      sessionId: string,
      orderRef: string,
    ) => Promise<{ ok: boolean; snapshot?: unknown; message?: string; error?: string }>;
    capture: (
      shopId: string,
      sessionId?: string,
    ) => Promise<{ ok: boolean; snapshot?: unknown; message?: string; error?: string }>;
  };
  transfer: {
    history: (shopId: string, sessionId?: string, limit?: number) => Promise<unknown[]>;
  };
  audit: {
    list: (shopId: string, limit?: number) => Promise<AuditLogEntry[]>;
  };
  metrics: {
    summary: (sinceMs?: number, shopId?: string) => Promise<MetricsSummary>;
    history: (
      metricName: string,
      sinceMs: number,
      untilMs?: number,
      shopId?: string,
    ) => Promise<MetricsHistory>;
  };
  diagnose: {
    run: () => Promise<DiagnosticSummary>;
    health: () => Promise<{ status: string; uptime: number; memory: { heapUsed: number; heapTotal: number } }>;
  };
  diagnostic: {
    checkAutoReply: (shopId: string) => Promise<{ ok: boolean; report?: AutoReplyDiagnosticReport; error?: string }>;
    testReply: (shopId: string, message: string) => Promise<{ ok: boolean; result?: TestReplyResult; error?: string }>;
    systemHealth: () => Promise<{ ok: boolean; health?: SystemHealthReport; error?: string }>;
  };
  db: {
    backup: () => Promise<{ ok: boolean; path: string }>;
  };
  rule: {
    list: (shopId?: string) => Promise<RuleInfo[]>;
    add: (shopId: string, rule: RuleInfo) => Promise<{ ok: boolean }>;
    update: (shopId: string, name: string, updates: Partial<RuleInfo>) => Promise<{ ok: boolean }>;
    delete: (shopId: string, name: string) => Promise<{ ok: boolean }>;
    reload: () => Promise<{ ok: boolean }>;
    test: (shopId: string, text: string) => Promise<RuleMatchResult>;
    importJson: (shopId: string, json: string) => Promise<ImportResult>;
    exportJson: (shopId?: string) => Promise<string>;
  };
  faq: {
    list: (shopId: string) => Promise<FaqInfo[]>;
    add: (shopId: string, faq: FaqInfo) => Promise<{ ok: boolean }>;
    update: (shopId: string, index: number, updates: Partial<FaqInfo>) => Promise<{ ok: boolean }>;
    delete: (shopId: string, index: number) => Promise<{ ok: boolean }>;
    exportJson: (shopId?: string) => Promise<string>;
    importJson: (shopId: string, json: string) => Promise<ImportResult>;
  };
  product: {
    list: (shopId: string) => Promise<Product[]>;
    get: (shopId: string, productId: string) => Promise<Product | null>;
    add: (shopId: string, product: Product) => Promise<{ ok: boolean }>;
    update: (shopId: string, productId: string, updates: Partial<Product>) => Promise<{ ok: boolean }>;
    delete: (shopId: string, productId: string) => Promise<{ ok: boolean }>;
    importJson: (shopId: string, json: string) => Promise<ImportResult>;
    sync: (shopId: string) => Promise<SyncResult>;
    onSyncProgress: (callback: (progress: SyncProgress) => void) => () => void;
    getSyncStatus: (shopId: string) => Promise<SyncStatus | null>;
    diagnoseSidebar: (shopId: string) => Promise<{ ok: boolean; data?: string; error?: string }>;
    diagnoseListPage: (shopId: string) => Promise<{ ok: boolean; data?: string; error?: string }>;
  };
  test: {
    reply: (shopId: string, message: string) => Promise<TestReplyResult>;
  };
  kb: {
    getPrompt: () => Promise<string>;
    savePrompt: (content: string) => Promise<{ ok: boolean }>;
    getSensitiveWords: () => Promise<SensitiveWordEntry[]>;
    saveSensitiveWords: (words: SensitiveWordEntry[]) => Promise<{ ok: boolean }>;
    reloadSensitiveWords: () => Promise<{ ok: boolean }>;
    getCategories: (shopId?: string) => Promise<string[]>;
    listTemplates: (shopId?: string, category?: string) => Promise<Template[]>;
    getTemplate: (shopId: string, templateId: string) => Promise<Template | null>;
    saveTemplate: (shopId: string, template: Partial<Template>) => Promise<{ ok: boolean }>;
    deleteTemplate: (shopId: string, templateId: string) => Promise<{ ok: boolean }>;
    searchTemplates: (query: string) => Promise<Template[]>;
    recommendTemplates: (text: string, limit?: number) => Promise<Template[]>;
    getCategoryStats: (shopId?: string) => Promise<CategoryStats[]>;
    importTemplates: (shopId: string, json: string) => Promise<{ imported: number; errors: string[] }>;
    exportTemplates: (shopId?: string, category?: string) => Promise<string>;
    listFaqsByCategory: (shopId: string, category?: string) => Promise<FaqInfo[]>;
    exportKnowledge: (shopId?: string) => Promise<string>;
    importKnowledge: (json: string, shopId?: string) => Promise<{ imported: number }>;
    listVersions: (shopId: string, component?: string) => Promise<KbVersion[]>;
    rollback: (shopId: string, versionId: string) => Promise<{ ok: boolean }>;
    deleteVersion: (versionId: string, shopId: string) => Promise<{ ok: boolean; error?: string }>;
    getPermissions: (shopId: string) => Promise<ShopPermissions>;
    updatePermissions: (shopId: string, permissions: Partial<ShopPermissions>) => Promise<{ ok: boolean }>;
    checkPermission: (shopId: string, action: string) => Promise<boolean>;
    submitForReview: (shopId: string, component: string, targetId: string, payload: string) => Promise<ReviewRecord>;
    approveReview: (reviewId: string, comment: string) => Promise<{ ok: boolean }>;
    rejectReview: (reviewId: string, comment: string) => Promise<{ ok: boolean }>;
    listPendingReviews: (shopId: string) => Promise<ReviewRecord[]>;
    listReviewHistory: (shopId: string, component?: string) => Promise<ReviewRecord[]>;
    getAccuracyStats: (shopId: string, period: string) => Promise<AccuracyStats>;
    getAccuracyTrend: (shopId: string, days: number) => Promise<AccuracyTrendPoint[]>;
    getOptimizationSuggestions: (shopId: string) => Promise<OptimizationSuggestion[]>;
  };
  feedback: {
    add: (
      auditId: number,
      shopId: string,
      sessionId: string,
      rating: number,
      comment?: string,
    ) => Promise<{ ok: boolean }>;
    list: (shopId: string, limit?: number) => Promise<FeedbackEntry[]>;
    stats: (shopId: string) => Promise<FeedbackStats>;
  };
  learning: {
    patterns: (shopId: string) => Promise<LearnedPatternEntry[]>;
    runs: (shopId?: string, limit?: number) => Promise<LearningRunEntry[]>;
    trigger: (shopId?: string) => Promise<LearningTriggerResult>;
    stats: (shopId: string) => Promise<LearningStats>;
  };
  intent: {
    recent: (shopId: string, limit?: number) => Promise<IntentClassificationRecord[]>;
    stats: (shopId: string, sinceMs?: number) => Promise<EscalationStats>;
  };
  escalation: {
    list: (shopId: string, status?: string) => Promise<EscalationRecord[]>;
    resolve: (escalationId: number, resolution?: string) => Promise<{ ok: boolean }>;
    stats: (shopId: string, sinceMs?: number) => Promise<Array<{ status: string; count: number }>>;
  };
  agent: {
    queue: (shopId: string) => Promise<QueueEntry[]>;
    list: (shopId: string) => Promise<HumanAgent[]>;
    refresh: (shopId: string) => Promise<{ ok: boolean; agents: HumanAgent[]; error?: string }>;
    assign: (escalationId: number, agentId: string) => Promise<{ ok: boolean; error?: string }>;
  };
  view: {
    hideForModal: () => Promise<{ ok: boolean }>;
    restoreAfterModal: () => Promise<{ ok: boolean }>;
  };
  buyer: {
    profile: (
      shopId: string,
      platform: string,
      buyerName: string,
    ) => Promise<{ ok: boolean; profile?: unknown; error?: string }>;
    list: (
      shopId: string,
      platform: string,
      limit?: number,
    ) => Promise<{ ok: boolean; profiles?: unknown[]; error?: string }>;
    stats: (shopId: string, platform: string) => Promise<{ ok: boolean; stats?: unknown; error?: string }>;
    updateTags: (
      shopId: string,
      platform: string,
      buyerName: string,
      tags: string[],
    ) => Promise<{ ok: boolean; error?: string }>;
    updateRemark: (
      shopId: string,
      platform: string,
      buyerName: string,
      remark: string,
    ) => Promise<{ ok: boolean; error?: string }>;
  };
}

declare global {
  interface Window {
    api: Api;
  }
}
