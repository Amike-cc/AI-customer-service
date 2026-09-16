/**
 * 数据库模块
 * 详见 docs/17-数据持久化与配置管理.md §17.4
 */
import SqliteDatabase from 'better-sqlite3';
import type { Config } from '../config/schema';
import path from 'path';
import fs from 'fs-extra';
import { ConversationContextRepo } from './repos/ConversationContextRepo';
import { ShopStateRepo } from './repos/ShopStateRepo';
import { MetricsRepo } from './repos/MetricsRepo';
import { AuditRepo } from './repos/AuditRepo';
import { ShopConfigRepo } from './repos/ShopConfigRepo';
import { FeedbackRepo } from './repos/FeedbackRepo';
import { QualityRepo } from './repos/QualityRepo';
import { LearningRepo } from './repos/LearningRepo';
import { IntentRepo } from './repos/IntentRepo';
import { AgentRepo } from './repos/AgentRepo';
import { ReplyGuardRepo } from './repos/ReplyGuardRepo';
import { ShopBusinessConfigRepo } from './repos/ShopBusinessConfigRepo';
import { PendingMessageRepo } from './repos/PendingMessageRepo';
import { DialogStateRepo } from './repos/DialogStateRepo';
import { BuyerProfileRepo } from './repos/BuyerProfileRepo';
import { MessageOutboxRepo } from './repos/MessageOutboxRepo';
import { ConversationMessageRepo } from './repos/ConversationMessageRepo';
import { ConversationDraftRepo } from './repos/ConversationDraftRepo';
import { TransferEventRepo } from './repos/TransferEventRepo';
import { OrderSnapshotRepo } from './repos/OrderSnapshotRepo';

export class Database {
  private db: SqliteDatabase.Database;
  readonly conversation: ConversationContextRepo;
  readonly shopState: ShopStateRepo;
  readonly metrics: MetricsRepo;
  readonly audit: AuditRepo;
  readonly shops: ShopConfigRepo;
  readonly feedback: FeedbackRepo;
  readonly quality: QualityRepo;
  readonly learning: LearningRepo;
  readonly intent: IntentRepo;
  readonly agent: AgentRepo;
  readonly replyGuard: ReplyGuardRepo;
  readonly shopBusiness: ShopBusinessConfigRepo;
  readonly pendingMessages: PendingMessageRepo;
  readonly dialogState: DialogStateRepo;
  readonly buyerProfiles: BuyerProfileRepo;
  readonly outbox: MessageOutboxRepo;
  readonly conversationMessages: ConversationMessageRepo;
  readonly conversationDrafts: ConversationDraftRepo;
  readonly transferEvents: TransferEventRepo;
  readonly orderSnapshots: OrderSnapshotRepo;

  constructor(private config: Config) {
    const dbPath = path.join(config.app.data_dir, 'app.db');
    fs.ensureDirSync(path.dirname(dbPath));
    this.db = new SqliteDatabase(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.conversation = new ConversationContextRepo(this.db);
    this.shopState = new ShopStateRepo(this.db);
    this.metrics = new MetricsRepo(this.db);
    this.audit = new AuditRepo(this.db);
    this.shops = new ShopConfigRepo(this.db);
    this.feedback = new FeedbackRepo(this.db);
    this.quality = new QualityRepo(this.db);
    this.learning = new LearningRepo(this.db);
    this.intent = new IntentRepo(this.db);
    this.agent = new AgentRepo(this.db);
    this.replyGuard = new ReplyGuardRepo(this.db);
    this.shopBusiness = new ShopBusinessConfigRepo(this.db);
    this.pendingMessages = new PendingMessageRepo(this.db);
    this.dialogState = new DialogStateRepo(this.db);
    this.buyerProfiles = new BuyerProfileRepo(this.db);
    this.outbox = new MessageOutboxRepo(this.db);
    this.conversationMessages = new ConversationMessageRepo(this.db);
    this.conversationDrafts = new ConversationDraftRepo(this.db);
    this.transferEvents = new TransferEventRepo(this.db);
    this.orderSnapshots = new OrderSnapshotRepo(this.db);
  }

  async migrate(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_context (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        product_id TEXT,
        token_count INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_shop_session_time
        ON conversation_context (shop_id, session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS shop_state (
        shop_id TEXT PRIMARY KEY,
        current_state TEXT NOT NULL,
        previous_state TEXT,
        entered_at INTEGER NOT NULL,
        silent_wait_count INTEGER DEFAULT 0,
        cdp_recover_attempts INTEGER DEFAULT 0,
        last_message_at INTEGER,
        context_version INTEGER DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT,
        metric_name TEXT NOT NULL,
        metric_value REAL NOT NULL,
        tags TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_query
        ON metrics (shop_id, metric_name, created_at DESC);

      CREATE TABLE IF NOT EXISTS ai_reply_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_message TEXT NOT NULL,
        ai_reply TEXT NOT NULL,
        model_version TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        product_id TEXT,
        token_input INTEGER,
        token_output INTEGER,
        latency_ms INTEGER,
        confidence REAL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_query
        ON ai_reply_audit (shop_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS shop_config (
        shop_id TEXT PRIMARY KEY,
        shop_name TEXT NOT NULL,
        feige_client_path TEXT,
        window_title_pattern TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS context_clear_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        cleared_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dialogue_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        audit_id INTEGER NOT NULL UNIQUE,
        shop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        rating INTEGER NOT NULL,
        comment TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (audit_id) REFERENCES ai_reply_audit(id)
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_shop
        ON dialogue_feedback (shop_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS quality_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        audit_id INTEGER NOT NULL,
        shop_id TEXT NOT NULL,
        confidence_score REAL NOT NULL,
        latency_score REAL NOT NULL,
        structure_score REAL NOT NULL,
        safety_score REAL NOT NULL,
        feedback_score REAL NOT NULL,
        overall_score REAL NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (audit_id) REFERENCES ai_reply_audit(id)
      );
      CREATE INDEX IF NOT EXISTS idx_quality_shop
        ON quality_scores (shop_id, overall_score DESC);

      CREATE TABLE IF NOT EXISTS learned_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT NOT NULL,
        question_pattern TEXT NOT NULL,
        answer_template TEXT NOT NULL,
        question_hash TEXT NOT NULL,
        match_count INTEGER DEFAULT 0,
        feedback_sum INTEGER DEFAULT 0,
        avg_quality REAL DEFAULT 0,
        source_audit_ids TEXT,
        status TEXT DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(shop_id, question_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_patterns_shop
        ON learned_patterns (shop_id, status, avg_quality DESC);

      CREATE TABLE IF NOT EXISTS learning_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL,
        collected_count INTEGER NOT NULL,
        extracted_count INTEGER NOT NULL,
        validated_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        metrics_json TEXT
      );

      CREATE TABLE IF NOT EXISTS intent_classification (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        audit_id INTEGER,
        user_message TEXT NOT NULL,
        category TEXT NOT NULL,
        confidence REAL NOT NULL,
        complexity_level TEXT NOT NULL,
        complexity_score REAL NOT NULL,
        entities TEXT,
        should_escalate INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_intent_shop_time
        ON intent_classification (shop_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_intent_session
        ON intent_classification (session_id, created_at);

      CREATE TABLE IF NOT EXISTS escalation_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        audit_id INTEGER,
        reason TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'medium',
        status TEXT NOT NULL DEFAULT 'pending',
        assigned_agent_id TEXT,
        required_skills TEXT,
        created_at INTEGER NOT NULL,
        assigned_at INTEGER,
        resolved_at INTEGER,
        resolution TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_escalation_shop_status
        ON escalation_queue (shop_id, status, priority DESC);

      CREATE TABLE IF NOT EXISTS human_agents (
        id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'offline',
        active_chats INTEGER DEFAULT 0,
        max_chats INTEGER DEFAULT 5,
        skills TEXT,
        last_assigned_at INTEGER,
        detected_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agents_shop_status
        ON human_agents (shop_id, status);

      CREATE TABLE IF NOT EXISTS reply_delivery_guard (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message_key TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        message_text TEXT NOT NULL,
        source_message_id TEXT,
        replied_at INTEGER NOT NULL,
        UNIQUE(shop_id, session_id, message_key)
      );
      CREATE INDEX IF NOT EXISTS idx_reply_guard_text
        ON reply_delivery_guard (shop_id, session_id, text_hash, replied_at DESC);

      CREATE TABLE IF NOT EXISTS shop_business_config (
        shop_id TEXT PRIMARY KEY,
        delivery_address TEXT NOT NULL DEFAULT '',
        delivery_time TEXT NOT NULL DEFAULT '',
        freight_insurance INTEGER NOT NULL DEFAULT 0,
        express_companies TEXT NOT NULL DEFAULT '[]',
        free_shipping INTEGER NOT NULL DEFAULT 0,
        free_shipping_condition TEXT NOT NULL DEFAULT '',
        main_category TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (shop_id) REFERENCES shop_config(shop_id)
      );

      CREATE TABLE IF NOT EXISTS pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        buyer_name TEXT NOT NULL,
        message_text TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        processed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_pending_shop_processed
        ON pending_messages (shop_id, processed_at, received_at);

      CREATE TABLE IF NOT EXISTS dialog_state (
        shop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        slots TEXT NOT NULL,
        current_slot TEXT,
        started_at INTEGER NOT NULL,
        last_interaction_at INTEGER NOT NULL,
        turn_count INTEGER DEFAULT 0,
        completed INTEGER DEFAULT 0,
        cancelled INTEGER DEFAULT 0,
        PRIMARY KEY (shop_id, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_dialog_expired
        ON dialog_state (last_interaction_at, completed, cancelled);

      CREATE TABLE IF NOT EXISTS buyer_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        buyer_name TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        consultation_count INTEGER DEFAULT 0,
        message_count INTEGER DEFAULT 0,
        complaint_count INTEGER DEFAULT 0,
        conversion_count INTEGER DEFAULT 0,
        refund_count INTEGER DEFAULT 0,
        escalation_count INTEGER DEFAULT 0,
        preferred_categories TEXT DEFAULT '[]',
        preferred_specs TEXT DEFAULT '{}',
        price_sensitivity TEXT,
        vip_level INTEGER DEFAULT 0,
        tags TEXT DEFAULT '[]',
        remarks TEXT,
        last_session_id TEXT,
        last_product_id TEXT,
        profile_version INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(shop_id, platform, buyer_name)
      );
      CREATE INDEX IF NOT EXISTS idx_buyer_profiles_shop_platform
        ON buyer_profiles (shop_id, platform, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_buyer_profiles_shop_vip
        ON buyer_profiles (shop_id, vip_level DESC, last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'sent',
        platform_ref TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(shop_id, session_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_conv_messages_session
        ON conversation_messages (shop_id, session_id, id);

      CREATE TABLE IF NOT EXISTS message_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT 'out',
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        sent_at INTEGER,
        UNIQUE(shop_id, client_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_session
        ON message_outbox (shop_id, session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_outbox_status
        ON message_outbox (status, updated_at);

      CREATE TABLE IF NOT EXISTS conversation_drafts (
        shop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        draft TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (shop_id, session_id)
      );

      CREATE TABLE IF NOT EXISTS transfer_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        status TEXT NOT NULL,
        kind TEXT NOT NULL,
        operator TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(shop_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_transfer_events_session
        ON transfer_events (shop_id, session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS order_snapshots (
        shop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        order_ref TEXT NOT NULL,
        summary TEXT NOT NULL,
        platform_url TEXT,
        captured_at INTEGER NOT NULL,
        PRIMARY KEY (shop_id, session_id, order_ref)
      );
    `);

    // 链哈希字段（幂等迁移）
    this.migrateAddColumn('ai_reply_audit', 'prev_hash', 'TEXT');

    // 自动回复开关（幂等迁移，默认开启）
    this.migrateAddColumn('shop_config', 'auto_reply', 'INTEGER NOT NULL DEFAULT 1');

    // 网页版登录状态字段（幂等迁移）
    this.migrateAddColumn('shop_config', 'login_status', "TEXT NOT NULL DEFAULT 'logged_out'");
    this.migrateAddColumn('shop_config', 'last_login_at', 'INTEGER');

    // 未读消息计数（幂等迁移，默认 0）
    this.migrateAddColumn('shop_state', 'unread_count', 'INTEGER NOT NULL DEFAULT 0');

    // 多平台支持（幂等迁移，默认飞鸽）
    this.migrateAddColumn('shop_config', 'platform', "TEXT NOT NULL DEFAULT 'feige'");

    // 注：delivery_time 已在 shop_business_config 的 CREATE TABLE 中定义，无需 ALTER 迁移

    // 客服专员映射（智能路由到指定专员功能，幂等迁移）
    // 存储 JSON 字符串：{"after_sales":"客服晓晓","logistics":"客服小芳",...}
    this.migrateAddColumn('shop_business_config', 'agent_mappings', "TEXT NOT NULL DEFAULT '{}'");

    // 店铺人设（语气拟人化功能，幂等迁移）
    // 存储 JSON 字符串：{"tone":"friendly","nickname":"小柚子","catchphrases":["~哦","哈"],"useEmojis":true,"description":"..."}
    this.migrateAddColumn('shop_business_config', 'persona', "TEXT NOT NULL DEFAULT '{}'");

    // 反馈唯一约束（幂等迁移）：同一 audit 只保留一条反馈，防止重复 👍/👎 污染准确率统计
    // 先清理重复数据再建唯一索引（保留最新一条）
    this.db.exec(
      `DELETE FROM dialogue_feedback WHERE id NOT IN (
         SELECT MAX(id) FROM dialogue_feedback GROUP BY audit_id
       );`,
    );
    // 唯一索引创建失败（如重复数据未清干净）时记录日志而非静默吞掉
    try {
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_audit_unique ON dialogue_feedback(audit_id)');
    } catch (err) {
      console.error('[db] 创建反馈唯一索引失败:', err);
    }
  }

  /**
   * 幂等添加列：列已存在（duplicate column）时忽略，其他真实错误（磁盘满/语法错）抛出
   */
  private migrateAddColumn(table: string, column: string, definition: string): void {
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/duplicate column name/i.test(msg)) {
        // 列已存在：幂等迁移的正常情况
        return;
      }
      // 真实错误：磁盘满、SQL 语法错误等——不得静默吞掉
      console.error(`[db] 迁移 ${table}.${column} 失败:`, err);
      throw err;
    }
  }

  prepare(sql: string): SqliteDatabase.Statement {
    return this.db.prepare(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * 解决升级工单，并在同一事务内释放已分配坐席的活跃会话额度。
   * 已解决的工单保持幂等，不会重复扣减坐席负载。
   */
  resolveEscalation(
    id: number,
    resolution?: string,
  ): { alreadyResolved: boolean; shopId: string; releasedAgentId?: string } {
    return this.transaction(() => {
      const escalation = this.intent.getEscalation(id);
      if (!escalation) throw new Error('升级工单不存在');

      if (escalation.status === 'resolved') {
        return {
          alreadyResolved: true,
          shopId: escalation.shopId,
        };
      }

      const releasedAgentId = escalation.status === 'assigned' ? escalation.assignedAgentId : undefined;
      this.intent.updateEscalationStatus(id, 'resolved', undefined, resolution);
      if (releasedAgentId) {
        this.agent.decrementActiveChats(releasedAgentId);
      }

      return {
        alreadyResolved: false,
        shopId: escalation.shopId,
        releasedAgentId,
      };
    });
  }

  /**
   * 删除店铺及其全部关联数据（原子事务）
   * 依赖顺序：先删外键引用子表，再删主表 shop_config
   */
  deleteShopData(shopId: string): void {
    const cleanup = this.db.transaction(() => {
      // 外键引用 ai_reply_audit 的子表必须先删
      this.db.prepare('DELETE FROM dialogue_feedback WHERE shop_id = ?').run(shopId);
      this.db.prepare('DELETE FROM quality_scores WHERE shop_id = ?').run(shopId);
      // 店铺相关业务表
      this.db.prepare('DELETE FROM ai_reply_audit WHERE shop_id = ?').run(shopId);
      this.db.prepare('DELETE FROM conversation_context WHERE shop_id = ?').run(shopId);
      this.db.prepare('DELETE FROM context_clear_log WHERE shop_id = ?').run(shopId);
      this.db.prepare('DELETE FROM metrics WHERE shop_id = ?').run(shopId);
      this.db.prepare('DELETE FROM dialog_state WHERE shop_id = ?').run(shopId);
      this.db.prepare('DELETE FROM buyer_profiles WHERE shop_id = ?').run(shopId);
      this.db.prepare('DELETE FROM reply_delivery_guard WHERE shop_id = ?').run(shopId);
      this.db.prepare('DELETE FROM pending_messages WHERE shop_id = ?').run(shopId);
      this.db.prepare('DELETE FROM learned_patterns WHERE shop_id = ?').run(shopId);
      this.db.prepare('DELETE FROM learning_runs WHERE shop_id = ?').run(shopId);
      this.db.prepare('DELETE FROM intent_classification WHERE shop_id = ?').run(shopId);
      this.db.prepare('DELETE FROM escalation_queue WHERE shop_id = ?').run(shopId);
      this.db.prepare('DELETE FROM human_agents WHERE shop_id = ?').run(shopId);
      this.db.prepare('DELETE FROM shop_state WHERE shop_id = ?').run(shopId);
      // 统一工作台新增表
      this.db.prepare('DELETE FROM conversation_messages WHERE shop_id = ?').run(shopId);
      this.db.prepare('DELETE FROM message_outbox WHERE shop_id = ?').run(shopId);
      this.db.prepare('DELETE FROM conversation_drafts WHERE shop_id = ?').run(shopId);
      this.db.prepare('DELETE FROM transfer_events WHERE shop_id = ?').run(shopId);
      this.db.prepare('DELETE FROM order_snapshots WHERE shop_id = ?').run(shopId);
      // 外键引用 shop_config 的表
      this.db.prepare('DELETE FROM shop_business_config WHERE shop_id = ?').run(shopId);
      // 最后删除主表
      this.db.prepare('DELETE FROM shop_config WHERE shop_id = ?').run(shopId);
    });
    cleanup();
  }

  async backup(backupDir?: string): Promise<string> {
    const dir = backupDir ?? path.join(this.config.app.data_dir, 'backups');
    await fs.ensureDir(dir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `app-backup-${timestamp}.db`;
    const backupPath = path.join(dir, filename);
    await this.db.backup(backupPath);
    const backupFiles = (await fs.readdir(dir))
      .filter((name) => /^app-backup-.*\.db$/.test(name))
      .map((name) => ({ name, path: path.join(dir, name) }));
    const withStats = await Promise.all(backupFiles.map(async (file) => ({
      ...file,
      mtimeMs: (await fs.stat(file.path)).mtimeMs,
    })));
    const expired = withStats
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(this.config.app.backup_retention_count);
    await Promise.all(expired.map((file) => fs.remove(file.path)));
    return backupPath;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
