/**
 * Electron Preload 脚本
 *
 * 通过 contextBridge 暴露白名单 API 给渲染进程。
 * 安全约束：contextIsolation: true, nodeIntegration: false, sandbox: true
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

export interface ShopListItem {
  shopId: string;
  shopName: string;
  platform: string;
  enabled: boolean;
  autoReply: boolean;
  loginStatus: string;
  lastLoginAt: number | null;
  createdAt: number;
  updatedAt: number;
  state: string | null;
  stateRecord: unknown;
}

export interface ShopPersona {
  tone: 'professional' | 'friendly' | 'lively' | 'cute';
  nickname: string;
  catchphrases: string[];
  useEmojis: boolean;
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
  agentMappings: Record<string, string>;
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

const api = {
  app: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
  },
  shop: {
    list: (): Promise<ShopListItem[]> => ipcRenderer.invoke('shop:list'),
    takeover: (shopId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('shop:takeover', shopId),
    release: (shopId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('shop:release', shopId),
    setAutoReply: (shopId: string, autoReply: boolean): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('shop:setAutoReply', shopId, autoReply),
    addAccount: (shopName: string, platform?: string): Promise<{ ok: boolean; shopId: string }> =>
      ipcRenderer.invoke('shop:addAccount', shopName, platform ?? 'feige'),
    removeAccount: (shopId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('shop:removeAccount', shopId),
    switchView: (shopId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('shop:switchView', shopId),
    exitView: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('shop:exitView'),
    getLoginStatus: (shopId: string): Promise<{ loginStatus: string }> =>
      ipcRenderer.invoke('shop:getLoginStatus', shopId),
    forceReLogin: (shopId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('shop:forceReLogin', shopId),
    reload: (shopId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('shop:reload', shopId),
    getActiveShop: (): Promise<{ shopId: string | null }> =>
      ipcRenderer.invoke('shop:getActiveShop'),
    start: (shopId: string): Promise<{ ok: boolean; state: string | null }> =>
      ipcRenderer.invoke('shop:start', shopId),
    stop: (shopId: string): Promise<{ ok: boolean; state: string | null }> =>
      ipcRenderer.invoke('shop:stop', shopId),
    rename: (shopId: string, newName: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('shop:rename', shopId, newName),
    markRead: (shopId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('shop:markRead', shopId),
    sendReply: (
      shopId: string,
      text: string,
      opts?: { sessionId?: string; clientMessageId?: string },
    ): Promise<{ ok: boolean; status?: 'sent' | 'duplicate'; clientMessageId?: string | null; error?: string }> =>
      ipcRenderer.invoke('shop:sendReply', shopId, text, opts),
    getBusinessConfig: (shopId: string): Promise<{ ok: boolean; config?: ShopBusinessConfig; error?: string }> =>
      ipcRenderer.invoke('shop:getBusinessConfig', shopId),
    updateBusinessConfig: (shopId: string, updates: Partial<ShopBusinessConfig>): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('shop:updateBusinessConfig', shopId, updates),
    onStateChanged: (cb: (data: unknown) => void): (() => void) => {
      const handler = (_evt: unknown, data: unknown): void => cb(data);
      ipcRenderer.on('shop:stateChanged', handler);
      return () => ipcRenderer.off('shop:stateChanged', handler);
    },
    onLoginStatusChanged: (cb: (data: { shopId: string; status: string; oldStatus?: string }) => void): (() => void) => {
      const handler = (_evt: unknown, data: unknown): void =>
        cb(data as { shopId: string; status: string; oldStatus?: string });
      ipcRenderer.on('shop:loginStatusChanged', handler);
      return () => ipcRenderer.off('shop:loginStatusChanged', handler);
    },
    onNameUpdated: (cb: (data: { shopId: string; shopName: string }) => void): (() => void) => {
      const handler = (_evt: unknown, data: unknown): void =>
        cb(data as { shopId: string; shopName: string });
      ipcRenderer.on('shop:nameUpdated', handler);
      return () => ipcRenderer.off('shop:nameUpdated', handler);
    },
    onTransferEvent: (
      cb: (data: {
        type: 'success' | 'failed';
        shopId: string;
        sessionId: string;
        role?: string;
        agentName?: string;
        reason?: string;
      }) => void,
    ): (() => void) => {
      const successHandler = (_evt: unknown, data: unknown): void =>
        cb({ ...(data as Record<string, unknown>), type: 'success' } as never);
      const failedHandler = (_evt: unknown, data: unknown): void =>
        cb({ ...(data as Record<string, unknown>), type: 'failed' } as never);
      ipcRenderer.on('transfer:success', successHandler);
      ipcRenderer.on('transfer:failed', failedHandler);
      return () => {
        ipcRenderer.off('transfer:success', successHandler);
        ipcRenderer.off('transfer:failed', failedHandler);
      };
    },
  },
  deepseek: {
    onError: (cb: (data: unknown) => void): (() => void) => {
      const handler = (_evt: unknown, data: unknown): void => cb(data);
      ipcRenderer.on('deepseek:error', handler);
      return () => ipcRenderer.off('deepseek:error', handler);
    },
  },
  config: {
    get: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('config:get'),
    getApiKey: (): Promise<string> => ipcRenderer.invoke('config:getApiKey'),
    updateApiKey: (key: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('config:updateApiKey', key),
    // 多 LLM Provider 配置
    getLlmProviders: (): Promise<LlmProvidersResult> =>
      ipcRenderer.invoke('config:getLlmProviders'),
    getLlmApiKey: (providerType: ProviderType): Promise<LlmApiKeyResult> =>
      ipcRenderer.invoke('config:getLlmApiKey', providerType),
    updateLlmApiKey: (providerType: ProviderType, newKey: string): Promise<LlmActionResult> =>
      ipcRenderer.invoke('config:updateLlmApiKey', providerType, newKey),
    updateLlmProvider: (
      providerType: ProviderType,
      updates: ProviderOverride,
    ): Promise<LlmActionResult> =>
      ipcRenderer.invoke('config:updateLlmProvider', providerType, updates),
    resetLlmProvider: (providerType: ProviderType): Promise<LlmActionResult> =>
      ipcRenderer.invoke('config:resetLlmProvider', providerType),
    setDefaultLlmProvider: (providerType: ProviderType): Promise<LlmActionResult> =>
      ipcRenderer.invoke('config:setDefaultLlmProvider', providerType),
    testLlmProvider: (providerType: ProviderType): Promise<LlmTestResult> =>
      ipcRenderer.invoke('config:testLlmProvider', providerType),
  },
  log: {
    subscribe: (): Promise<{ ok: boolean; bufferSize: number }> =>
      ipcRenderer.invoke('log:subscribe'),
    history: (limit?: number, offset?: number): Promise<{ entries: LogEntry[]; total: number; offset: number; limit: number }> =>
      ipcRenderer.invoke('log:history', limit ?? 200, offset ?? 0),
    onStream: (cb: (entry: LogEntry) => void): (() => void) => {
      const handler = (_evt: unknown, entry: LogEntry): void => cb(entry);
      ipcRenderer.on('log:stream', handler);
      return () => ipcRenderer.off('log:stream', handler);
    },
  },
  alert: {
    list: (): Promise<AlertEntry[]> => ipcRenderer.invoke('alert:list'),
    acknowledge: (name: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('alert:acknowledge', name),
    onStream: (cb: (alert: AlertEntry) => void): (() => void) => {
      const handler = (_evt: unknown, alert: AlertEntry): void => cb(alert);
      ipcRenderer.on('alert:stream', handler);
      return () => ipcRenderer.off('alert:stream', handler);
    },
    onRecovered: (cb: (info: unknown) => void): (() => void) => {
      const handler = (_evt: unknown, info: unknown): void => cb(info);
      ipcRenderer.on('alert:recovered', handler);
      return () => ipcRenderer.off('alert:recovered', handler);
    },
  },
  conversation: {
    sessions: (shopId: string, limit?: number): Promise<ConversationSession[]> =>
      ipcRenderer.invoke('conversation:sessions', shopId, limit),
    messages: (
      shopId: string,
      sessionId: string,
      limit?: number,
      offset?: number,
    ): Promise<ConversationMessage[]> =>
      ipcRenderer.invoke('conversation:messages', shopId, sessionId, limit, offset),
    search: (shopId: string, keyword: string, limit?: number): Promise<ConversationMessage[]> =>
      ipcRenderer.invoke('conversation:search', shopId, keyword, limit),
    // 独立平台消息（统一工作台）
    platformSessions: (
      shopId: string,
      limit?: number,
    ): Promise<
      Array<{
        sessionId: string;
        lastMessageAt: number;
        messageCount: number;
        lastDirection?: 'in' | 'out';
        hasManual?: boolean;
      }>
    > =>
      ipcRenderer.invoke('conversation:platformSessions', shopId, limit),
    stream: (shopId: string, sessionId: string, afterMessageId?: number, limit?: number): Promise<unknown[]> =>
      ipcRenderer.invoke('conversation:stream', shopId, sessionId, afterMessageId, limit),
    sendText: (
      shopId: string,
      sessionId: string,
      text: string,
      clientMessageId?: string,
      messageVersion?: number,
    ): Promise<{ ok: boolean; status?: 'sent' | 'duplicate'; clientMessageId?: string | null; error?: string }> =>
      ipcRenderer.invoke('conversation:sendText', shopId, sessionId, text, clientMessageId, messageVersion),
    sendAttachment: (
      shopId: string,
      sessionId: string | undefined,
      file: { name?: string; size?: number; type?: string },
      clientMessageId?: string,
    ): Promise<{ ok: boolean; status?: string; message?: string; error?: string }> =>
      ipcRenderer.invoke('conversation:sendAttachment', shopId, sessionId, file, clientMessageId),
    draft: (
      shopId: string,
      sessionId: string,
      draft?: string,
    ): Promise<{ ok: boolean; draft: string }> =>
      ipcRenderer.invoke('conversation:draft', shopId, sessionId, draft),
    onMessage: (cb: (data: unknown) => void): (() => void) => {
      const handler = (_evt: unknown, data: unknown): void => cb(data);
      ipcRenderer.on('conversation:message', handler);
      return () => ipcRenderer.off('conversation:message', handler);
    },
  },
  workspace: {
    getSnapshot: (shopId: string): Promise<{ ok: boolean; snapshot?: unknown; error?: string }> =>
      ipcRenderer.invoke('workspace:getSnapshot', shopId),
    setLayout: (layout: {
      sidebarWidth?: number;
      rightPanelWidth?: number;
      rightPanelVisible?: boolean;
    }): Promise<{ ok: boolean; layout: unknown }> =>
      ipcRenderer.invoke('workspace:setLayout', layout),
  },
  search: {
    global: (
      query: string,
      opts?: { types?: string[]; shopIds?: string[]; limit?: number },
    ): Promise<{ ok: boolean; query?: string; groups?: unknown[]; total?: number; error?: string }> =>
      ipcRenderer.invoke('search:global', query, opts),
  },
  order: {
    summary: (
      shopId: string,
      sessionId: string,
      orderRef: string,
    ): Promise<{ ok: boolean; snapshot?: unknown; message?: string; error?: string }> =>
      ipcRenderer.invoke('order:summary', shopId, sessionId, orderRef),
    capture: (
      shopId: string,
      sessionId?: string,
    ): Promise<{ ok: boolean; snapshot?: unknown; message?: string; error?: string }> =>
      ipcRenderer.invoke('order:capture', shopId, sessionId),
  },
  transfer: {
    history: (shopId: string, sessionId?: string, limit?: number): Promise<unknown[]> =>
      ipcRenderer.invoke('transfer:history', shopId, sessionId, limit),
  },
  audit: {
    list: (shopId: string, limit?: number): Promise<AuditLogEntry[]> =>
      ipcRenderer.invoke('audit:list', shopId, limit),
  },
  metrics: {
    summary: (sinceMs?: number, shopId?: string): Promise<MetricsSummary> =>
      ipcRenderer.invoke('metrics:summary', sinceMs ?? Date.now() - 3600000, shopId),
    history: (
      metricName: string,
      sinceMs: number,
      untilMs?: number,
      shopId?: string,
    ): Promise<MetricsHistory> =>
      ipcRenderer.invoke('metrics:history', metricName, sinceMs, untilMs, shopId),
  },
  diagnose: {
    run: (): Promise<DiagnosticSummary> => ipcRenderer.invoke('diagnose:run'),
    health: (): Promise<{ status: string; uptime: number; memory: { heapUsed: number; heapTotal: number } }> =>
      ipcRenderer.invoke('diagnose:health'),
    viewState: (): Promise<{ ok: boolean; state?: Record<string, unknown>; error?: string }> =>
      ipcRenderer.invoke('diagnose:viewState'),
  },
  diagnostic: {
    checkAutoReply: (shopId: string): Promise<{ ok: boolean; report?: AutoReplyDiagnosticReport; error?: string }> =>
      ipcRenderer.invoke('diagnostic:checkAutoReply', shopId),
    testReply: (shopId: string, message: string): Promise<{ ok: boolean; result?: TestReplyResult; error?: string }> =>
      ipcRenderer.invoke('diagnostic:testReply', shopId, message),
    systemHealth: (): Promise<{ ok: boolean; health?: SystemHealthReport; error?: string }> =>
      ipcRenderer.invoke('diagnostic:systemHealth'),
  },
  db: {
    backup: (): Promise<{ ok: boolean; path: string }> =>
      ipcRenderer.invoke('db:backup'),
  },
  rule: {
    list: (shopId?: string): Promise<RuleInfo[]> => ipcRenderer.invoke('rule:list', shopId),
    add: (shopId: string, rule: RuleInfo): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rule:add', shopId, rule),
    update: (shopId: string, name: string, updates: Partial<RuleInfo>): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rule:update', shopId, name, updates),
    delete: (shopId: string, name: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('rule:delete', shopId, name),
    reload: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('rule:reload'),
    importJson: (shopId: string, json: string): Promise<{ imported: number; errors: string[] }> =>
      ipcRenderer.invoke('rule:import', shopId, json),
    exportJson: (shopId?: string): Promise<string> =>
      ipcRenderer.invoke('rule:export', shopId),
    test: (shopId: string, text: string): Promise<RuleMatchResult> =>
      ipcRenderer.invoke('rule:test', shopId, text),
  },
  faq: {
    list: (shopId: string): Promise<FaqInfo[]> => ipcRenderer.invoke('faq:list', shopId),
    add: (shopId: string, faq: FaqInfo): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('faq:add', shopId, faq),
    update: (shopId: string, index: number, updates: Partial<FaqInfo>): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('faq:update', shopId, index, updates),
    delete: (shopId: string, index: number): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('faq:delete', shopId, index),
    exportJson: (shopId?: string): Promise<string> =>
      ipcRenderer.invoke('faq:export', shopId),
    importJson: (shopId: string, json: string): Promise<{ imported: number; errors: string[] }> =>
      ipcRenderer.invoke('faq:import', shopId, json),
  },
  product: {
    list: (shopId: string): Promise<Product[]> => ipcRenderer.invoke('product:list', shopId),
    get: (shopId: string, productId: string): Promise<Product | null> =>
      ipcRenderer.invoke('product:get', shopId, productId),
    add: (shopId: string, product: Product): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('product:add', shopId, product),
    update: (shopId: string, productId: string, updates: Partial<Product>): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('product:update', shopId, productId, updates),
    delete: (shopId: string, productId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('product:delete', shopId, productId),
    importJson: (shopId: string, json: string): Promise<ImportResult> =>
      ipcRenderer.invoke('product:import', shopId, json),
    sync: (shopId: string): Promise<SyncResult> =>
      ipcRenderer.invoke('product:sync', shopId),
    onSyncProgress: (callback: (progress: SyncProgress) => void): (() => void) => {
      const handler = (_evt: IpcRendererEvent, data: SyncProgress) => callback(data);
      ipcRenderer.on('sync:progress', handler);
      return () => ipcRenderer.removeListener('sync:progress', handler);
    },
    getSyncStatus: (shopId: string): Promise<SyncStatus | null> =>
      ipcRenderer.invoke('product:syncStatus', shopId),
    diagnoseSidebar: (shopId: string): Promise<{ ok: boolean; data?: string; error?: string }> =>
      ipcRenderer.invoke('product:diagnoseSidebar', shopId),
    diagnoseListPage: (shopId: string): Promise<{ ok: boolean; data?: string; error?: string }> =>
      ipcRenderer.invoke('product:diagnoseListPage', shopId),
  },
  test: {
    reply: (shopId: string, message: string): Promise<TestReplyResult> =>
      ipcRenderer.invoke('test:reply', shopId, message),
  },
  kb: {
    getPrompt: (): Promise<string> => ipcRenderer.invoke('kb:getPrompt'),
    savePrompt: (content: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('kb:savePrompt', content),
    getSensitiveWords: (): Promise<SensitiveWordEntry[]> =>
      ipcRenderer.invoke('kb:getSensitiveWords'),
    saveSensitiveWords: (words: SensitiveWordEntry[]): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('kb:saveSensitiveWords', words),
    reloadSensitiveWords: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('kb:reloadSensitiveWords'),
    getCategories: (shopId?: string): Promise<string[]> =>
      ipcRenderer.invoke('kb:getCategories', shopId),
    listTemplates: (shopId?: string, category?: string): Promise<Template[]> =>
      ipcRenderer.invoke('kb:listTemplates', shopId, category),
    getTemplate: (shopId: string, templateId: string): Promise<Template | null> =>
      ipcRenderer.invoke('kb:getTemplate', shopId, templateId),
    saveTemplate: (shopId: string, template: Partial<Template>): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('kb:saveTemplate', shopId, template),
    deleteTemplate: (shopId: string, templateId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('kb:deleteTemplate', shopId, templateId),
    searchTemplates: (query: string): Promise<Template[]> =>
      ipcRenderer.invoke('kb:searchTemplates', query),
    recommendTemplates: (text: string, limit?: number): Promise<Template[]> =>
      ipcRenderer.invoke('kb:recommendTemplates', text, limit),
    getCategoryStats: (shopId?: string): Promise<CategoryStats[]> =>
      ipcRenderer.invoke('kb:getCategoryStats', shopId),
    importTemplates: (shopId: string, json: string): Promise<{ imported: number; errors: string[] }> =>
      ipcRenderer.invoke('kb:importTemplates', shopId, json),
    exportTemplates: (shopId?: string, category?: string): Promise<string> =>
      ipcRenderer.invoke('kb:exportTemplates', shopId, category),
    listFaqsByCategory: (shopId: string, category?: string): Promise<FaqInfo[]> =>
      ipcRenderer.invoke('kb:listFaqsByCategory', shopId, category),
    exportKnowledge: (shopId?: string): Promise<string> =>
      ipcRenderer.invoke('kb:exportKnowledge', shopId),
    importKnowledge: (json: string, shopId?: string): Promise<{ imported: number }> =>
      ipcRenderer.invoke('kb:importKnowledge', json, shopId),
    listVersions: (shopId: string, component?: string): Promise<KbVersion[]> =>
      ipcRenderer.invoke('kb:listVersions', shopId, component),
    rollback: (shopId: string, versionId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('kb:rollback', shopId, versionId),
    deleteVersion: (versionId: string, shopId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('kb:deleteVersion', versionId, shopId),
    getPermissions: (shopId: string): Promise<ShopPermissions> =>
      ipcRenderer.invoke('kb:getPermissions', shopId),
    updatePermissions: (shopId: string, permissions: Partial<ShopPermissions>): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('kb:updatePermissions', shopId, permissions),
    checkPermission: (shopId: string, action: string): Promise<boolean> =>
      ipcRenderer.invoke('kb:checkPermission', shopId, action),
    submitForReview: (shopId: string, component: string, targetId: string, payload: string): Promise<ReviewRecord> =>
      ipcRenderer.invoke('kb:submitForReview', shopId, component, targetId, payload),
    approveReview: (reviewId: string, comment: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('kb:approveReview', reviewId, comment),
    rejectReview: (reviewId: string, comment: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('kb:rejectReview', reviewId, comment),
    listPendingReviews: (shopId: string): Promise<ReviewRecord[]> =>
      ipcRenderer.invoke('kb:listPendingReviews', shopId),
    listReviewHistory: (shopId: string, component?: string): Promise<ReviewRecord[]> =>
      ipcRenderer.invoke('kb:listReviewHistory', shopId, component),
    getAccuracyStats: (shopId: string, period: string): Promise<AccuracyStats> =>
      ipcRenderer.invoke('kb:getAccuracyStats', shopId, period),
    getAccuracyTrend: (shopId: string, days: number): Promise<AccuracyTrendPoint[]> =>
      ipcRenderer.invoke('kb:getAccuracyTrend', shopId, days),
    getOptimizationSuggestions: (shopId: string): Promise<OptimizationSuggestion[]> =>
      ipcRenderer.invoke('kb:getOptimizationSuggestions', shopId),
  },
  feedback: {
    add: (
      auditId: number,
      shopId: string,
      sessionId: string,
      rating: number,
      comment?: string,
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('feedback:add', auditId, shopId, sessionId, rating, comment),
    list: (shopId: string, limit?: number): Promise<FeedbackEntry[]> =>
      ipcRenderer.invoke('feedback:list', shopId, limit),
    stats: (shopId: string): Promise<FeedbackStats> =>
      ipcRenderer.invoke('feedback:stats', shopId),
  },
  learning: {
    patterns: (shopId: string): Promise<LearnedPatternEntry[]> =>
      ipcRenderer.invoke('learning:patterns', shopId),
    runs: (shopId?: string, limit?: number): Promise<LearningRunEntry[]> =>
      ipcRenderer.invoke('learning:runs', shopId, limit),
    trigger: (shopId?: string): Promise<{ ok: boolean; collectedCount: number; cleanedCount: number; scoredCount: number; extractedCount: number; validatedCount: number }> =>
      ipcRenderer.invoke('learning:trigger', shopId),
    stats: (shopId: string): Promise<LearningStats> =>
      ipcRenderer.invoke('learning:stats', shopId),
  },
  intent: {
    recent: (shopId: string, limit?: number): Promise<unknown[]> =>
      ipcRenderer.invoke('intent:recent', shopId, limit),
    stats: (shopId: string, sinceMs?: number): Promise<{ categoryStats: unknown[]; escalationStats: unknown[] }> =>
      ipcRenderer.invoke('intent:stats', shopId, sinceMs),
  },
  escalation: {
    list: (shopId: string, status?: string): Promise<unknown[]> =>
      ipcRenderer.invoke('escalation:list', shopId, status),
    resolve: (escalationId: number, resolution?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('escalation:resolve', escalationId, resolution),
    stats: (shopId: string, sinceMs?: number): Promise<Array<{ status: string; count: number }>> =>
      ipcRenderer.invoke('escalation:stats', shopId, sinceMs),
  },
  agent: {
    queue: (shopId: string): Promise<unknown[]> =>
      ipcRenderer.invoke('agent:queue', shopId),
    list: (shopId: string): Promise<unknown[]> =>
      ipcRenderer.invoke('agent:list', shopId),
    refresh: (shopId: string): Promise<{ ok: boolean; agents: unknown[]; error?: string }> =>
      ipcRenderer.invoke('agent:refresh', shopId),
    assign: (escalationId: number, agentId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('agent:assign', escalationId, agentId),
  },
  view: {
    hideForModal: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('view:hideForModal'),
    restoreAfterModal: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('view:restoreAfterModal'),
  },
  buyer: {
    profile: (shopId: string, platform: string, buyerName: string): Promise<{ ok: boolean; profile?: unknown; error?: string }> =>
      ipcRenderer.invoke('buyer:profile', shopId, platform, buyerName),
    list: (shopId: string, platform: string, limit?: number): Promise<{ ok: boolean; profiles?: unknown[]; error?: string }> =>
      ipcRenderer.invoke('buyer:list', shopId, platform, limit),
    stats: (shopId: string, platform: string): Promise<{ ok: boolean; stats?: unknown; error?: string }> =>
      ipcRenderer.invoke('buyer:stats', shopId, platform),
    updateTags: (shopId: string, platform: string, buyerName: string, tags: string[]): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('buyer:updateTags', shopId, platform, buyerName, tags),
    updateRemark: (shopId: string, platform: string, buyerName: string, remark: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('buyer:updateRemark', shopId, platform, buyerName, remark),
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
