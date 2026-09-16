/**
 * IntentRepo 单元测试
 * 详见 src/db/repos/IntentRepo.ts
 */
import { createMockDatabase } from '../helpers/mockDb';
import { IntentRepo } from '@/db/repos/IntentRepo';
import type { IntentClassificationInput } from '@/db/repos/IntentRepo';
import type { EscalationInput } from '@/intent/types';

function makeClassificationInput(
  overrides?: Partial<IntentClassificationInput>,
): IntentClassificationInput {
  return {
    shopId: 'shop1',
    sessionId: 'session1',
    userMessage: '退货怎么办',
    intent: { category: 'after_sales', confidence: 0.9, entities: [] },
    complexity: { level: 'moderate', score: 0.4, reasons: ['multi_question'], shouldEscalate: false },
    ...overrides,
  };
}

function makeEscalationInput(overrides?: Partial<EscalationInput>): EscalationInput {
  return {
    shopId: 'shop1',
    sessionId: 'session1',
    reason: '客户投诉物流太慢',
    priority: 'medium',
    requiredSkills: ['logistics'],
    ...overrides,
  };
}

describe('IntentRepo', () => {
  let db: any;
  let repo: IntentRepo;

  beforeEach(() => {
    db = createMockDatabase();
    db.exec(`
      CREATE TABLE intent_classification (
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
      CREATE TABLE escalation_queue (
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
    `);
    repo = new IntentRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('addClassification', () => {
    it('写入分类记录返回 id', () => {
      const id = repo.addClassification(makeClassificationInput());
      expect(id).toBeGreaterThan(0);
    });

    it('写入 should_escalate=true 时存储为 1', () => {
      repo.addClassification(
        makeClassificationInput({
          complexity: { level: 'complex', score: 0.8, reasons: ['emotional_frustration'], shouldEscalate: true },
        }),
      );
      expect(repo.hasSessionEscalation('shop1', 'session1')).toBe(true);
    });
  });

  describe('listRecent', () => {
    it('按店铺查询', () => {
      repo.addClassification(makeClassificationInput({ shopId: 'shop1' }));
      repo.addClassification(makeClassificationInput({ shopId: 'shop2' }));
      const shop1Records = repo.listRecent('shop1');
      expect(shop1Records.length).toBe(1);
      expect(shop1Records[0].shopId).toBe('shop1');
    });

    it('默认 limit=50', () => {
      for (let i = 0; i < 55; i++) {
        repo.addClassification(makeClassificationInput({ sessionId: `s${i}` }));
      }
      const records = repo.listRecent('shop1');
      expect(records.length).toBe(50);
    });

    it('指定 limit 参数', () => {
      for (let i = 0; i < 10; i++) {
        repo.addClassification(makeClassificationInput({ sessionId: `s${i}` }));
      }
      expect(repo.listRecent('shop1', 5).length).toBe(5);
    });
  });

  describe('getSessionIntents', () => {
    it('按 session 查询', () => {
      repo.addClassification(makeClassificationInput({ sessionId: 'session1' }));
      repo.addClassification(makeClassificationInput({ sessionId: 'session2' }));
      const records = repo.getSessionIntents('shop1', 'session1');
      expect(records.length).toBe(1);
      expect(records[0].sessionId).toBe('session1');
    });
  });

  describe('hasSessionEscalation', () => {
    it('有升级记录返回 true', () => {
      repo.addClassification(
        makeClassificationInput({
          complexity: { level: 'complex', score: 0.8, reasons: [], shouldEscalate: true },
        }),
      );
      expect(repo.hasSessionEscalation('shop1', 'session1')).toBe(true);
    });

    it('无升级记录返回 false', () => {
      repo.addClassification(makeClassificationInput());
      expect(repo.hasSessionEscalation('shop1', 'session1')).toBe(false);
    });

    it('无任何记录返回 false', () => {
      expect(repo.hasSessionEscalation('shop1', 'session1')).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('清理旧记录', () => {
      const oldTime = Date.now() - 31 * 86400000;
      db.prepare(
        `INSERT INTO intent_classification (shop_id, session_id, user_message, category, confidence, complexity_level, complexity_score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('shop1', 'session1', '旧记录', 'greeting', 0.9, 'simple', 0.1, oldTime);

      const deleted = repo.cleanup(30 * 86400000);
      expect(deleted).toBe(1);
      expect(repo.listRecent('shop1').length).toBe(0);
    });

    it('不清理新记录', () => {
      repo.addClassification(makeClassificationInput());
      const deleted = repo.cleanup(30 * 86400000);
      expect(deleted).toBe(0);
    });
  });

  describe('addEscalation', () => {
    it('写入升级记录返回 id', () => {
      const id = repo.addEscalation(makeEscalationInput());
      expect(id).toBeGreaterThan(0);
    });
  });

  describe('listEscalations', () => {
    it('查询全部并验证记录字段', () => {
      repo.addEscalation(makeEscalationInput({ sessionId: 's1' }));
      repo.updateEscalationStatus(
        repo.addEscalation(makeEscalationInput({ sessionId: 's2' })),
        'resolved',
        undefined,
        '已解决',
      );
      const all = repo.listEscalations('shop1');
      expect(all.length).toBe(2);
      const resolved = all.find((e) => e.status === 'resolved');
      expect(resolved).toBeDefined();
      expect(resolved!.resolution).toBe('已解决');
    });

    it('不传 status 查询全部', () => {
      repo.addEscalation(makeEscalationInput({ sessionId: 's1' }));
      repo.addEscalation(makeEscalationInput({ sessionId: 's2' }));
      const all = repo.listEscalations('shop1');
      expect(all.length).toBe(2);
    });

    it('requiredSkills JSON 正确解析为数组', () => {
      repo.addEscalation(makeEscalationInput({ requiredSkills: ['logistics', 'refund'] }));
      const records = repo.listEscalations('shop1');
      expect(records[0].requiredSkills).toEqual(['logistics', 'refund']);
    });

    it('按店铺隔离升级记录', () => {
      repo.addEscalation(makeEscalationInput({ shopId: 'shop1' }));
      repo.addEscalation(makeEscalationInput({ shopId: 'shop2' }));
      const all = repo.listEscalations('shop1');
      expect(all).toHaveLength(1);
      expect(all[0].shopId).toBe('shop1');
    });
  });

  describe('updateEscalationStatus', () => {
    it('更新为 assigned', () => {
      const id = repo.addEscalation(makeEscalationInput());
      repo.updateEscalationStatus(id, 'assigned', 'agent001');
      const pending = repo.listEscalations('shop1', 'assigned');
      expect(pending.length).toBe(1);
      expect(pending[0].assignedAgentId).toBe('agent001');
    });

    it('更新为 resolved', () => {
      const id = repo.addEscalation(makeEscalationInput());
      repo.updateEscalationStatus(id, 'resolved', undefined, '问题已解决');
      const records = repo.listEscalations('shop1', 'resolved');
      expect(records.length).toBe(1);
      expect(records[0].resolution).toBe('问题已解决');
    });
  });

  describe('getPendingEscalation', () => {
    it('返回待处理记录', () => {
      repo.addEscalation(makeEscalationInput({ sessionId: 's1', reason: '问题A' }));
      const pending = repo.getPendingEscalation('shop1');
      expect(pending).not.toBeNull();
      expect(pending!.status).toBe('pending');
    });

    it('无待处理记录返回 null', () => {
      expect(repo.getPendingEscalation('shop1')).toBeNull();
    });
  });

  describe('getEscalationStats', () => {
    it('返回统计结果（不抛异常）', () => {
      repo.addEscalation(makeEscalationInput());
      repo.addEscalation(makeEscalationInput({ sessionId: 's2' }));
      const stats = repo.getEscalationStats('shop1', Date.now() - 86400000);
      expect(Array.isArray(stats)).toBe(true);
    });
  });

  describe('getCategoryStats', () => {
    it('返回分类统计（不抛异常）', () => {
      repo.addClassification(makeClassificationInput());
      const stats = repo.getCategoryStats('shop1', Date.now() - 86400000);
      expect(Array.isArray(stats)).toBe(true);
    });
  });
});
