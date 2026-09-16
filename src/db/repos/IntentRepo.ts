import type SqliteDatabase from 'better-sqlite3';
import type {
  IntentResult,
  ComplexityResult,
  EscalationRecord,
  EscalationInput,
} from '../../intent/types';

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

export interface IntentClassificationInput {
  shopId: string;
  sessionId: string;
  auditId?: number;
  userMessage: string;
  intent: IntentResult;
  complexity: ComplexityResult;
}

export class IntentRepo {
  constructor(private db: SqliteDatabase.Database) {}

  addClassification(input: IntentClassificationInput): number {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO intent_classification
        (shop_id, session_id, audit_id, user_message, category, confidence,
         complexity_level, complexity_score, entities, should_escalate, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      input.shopId,
      input.sessionId,
      input.auditId ?? null,
      input.userMessage,
      input.intent.category,
      input.intent.confidence,
      input.complexity.level,
      input.complexity.score,
      input.intent.entities.length > 0 ? JSON.stringify(input.intent.entities) : null,
      input.complexity.shouldEscalate ? 1 : 0,
      now,
    );
    return Number(result.lastInsertRowid);
  }

  listRecent(shopId: string, limit: number = 50): IntentClassificationRecord[] {
    return this.db
      .prepare(
        `SELECT id, shop_id AS shopId, session_id AS sessionId, audit_id AS auditId,
           user_message AS userMessage, category, confidence,
           complexity_level AS complexityLevel, complexity_score AS complexityScore,
           entities, should_escalate AS shouldEscalate, created_at AS createdAt
         FROM intent_classification
         WHERE shop_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(shopId, limit) as IntentClassificationRecord[];
  }

  getCategoryStats(shopId: string, sinceMs: number): Array<{ category: string; count: number }> {
    return this.db
      .prepare(
        `SELECT category, COUNT(*) AS count
         FROM intent_classification
         WHERE shop_id = ? AND created_at >= ?
         GROUP BY category ORDER BY count DESC`,
      )
      .all(shopId, sinceMs) as Array<{ category: string; count: number }>;
  }

  getSessionIntents(shopId: string, sessionId: string): IntentClassificationRecord[] {
    return this.db
      .prepare(
        `SELECT id, shop_id AS shopId, session_id AS sessionId, audit_id AS auditId,
           user_message AS userMessage, category, confidence,
           complexity_level AS complexityLevel, complexity_score AS complexityScore,
           entities, should_escalate AS shouldEscalate, created_at AS createdAt
         FROM intent_classification
         WHERE shop_id = ? AND session_id = ?
         ORDER BY created_at ASC`,
      )
      .all(shopId, sessionId) as IntentClassificationRecord[];
  }

  hasSessionEscalation(shopId: string, sessionId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM intent_classification
         WHERE shop_id = ? AND session_id = ? AND should_escalate = 1`,
      )
      .get(shopId, sessionId) as { cnt: number };
    return row.cnt > 0;
  }

  cleanup(olderThanMs: number): number {
    const threshold = Date.now() - olderThanMs;
    return Number(
      this.db.prepare('DELETE FROM intent_classification WHERE created_at < ?').run(threshold)
        .changes,
    );
  }

  addEscalation(input: EscalationInput): number {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO escalation_queue
        (shop_id, session_id, audit_id, reason, priority, status, required_skills, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    );
    const result = stmt.run(
      input.shopId,
      input.sessionId,
      input.auditId ?? null,
      input.reason,
      input.priority,
      JSON.stringify(input.requiredSkills ?? []),
      now,
    );
    return Number(result.lastInsertRowid);
  }

  listEscalations(
    shopId: string,
    status?: string,
  ): EscalationRecord[] {
    const sql = status
      ? `SELECT id, shop_id AS shopId, session_id AS sessionId, audit_id AS auditId,
           reason, priority, status, assigned_agent_id AS assignedAgentId,
           required_skills AS requiredSkillsJson, created_at AS createdAt,
           assigned_at AS assignedAt, resolved_at AS resolvedAt, resolution
         FROM escalation_queue
         WHERE shop_id = ? AND status = ?
         ORDER BY priority DESC, created_at ASC`
      : `SELECT id, shop_id AS shopId, session_id AS sessionId, audit_id AS auditId,
           reason, priority, status, assigned_agent_id AS assignedAgentId,
           required_skills AS requiredSkillsJson, created_at AS createdAt,
           assigned_at AS assignedAt, resolved_at AS resolvedAt, resolution
         FROM escalation_queue
         WHERE shop_id = ?
         ORDER BY priority DESC, created_at ASC`;

    const rows = (status
      ? this.db.prepare(sql).all(shopId, status)
      : this.db.prepare(sql).all(shopId)) as Array<
      EscalationRecord & { requiredSkillsJson: string }
    >;

    return rows.map((r) => {
      const { requiredSkillsJson, ...rest } = r;
      return {
        ...rest,
        requiredSkills: JSON.parse(requiredSkillsJson || '[]'),
      } as EscalationRecord;
    });
  }

  updateEscalationStatus(
    id: number,
    status: string,
    agentId?: string,
    resolution?: string,
  ): void {
    const now = Date.now();
    if (status === 'assigned' && agentId) {
      this.db
        .prepare(
          `UPDATE escalation_queue SET status = ?, assigned_agent_id = ?, assigned_at = ? WHERE id = ?`,
        )
        .run(status, agentId, now, id);
    } else if (status === 'resolved') {
      this.db
        .prepare(
          `UPDATE escalation_queue SET status = ?, resolved_at = ?, resolution = ? WHERE id = ?`,
        )
        .run(status, now, resolution ?? null, id);
    } else {
      this.db.prepare('UPDATE escalation_queue SET status = ? WHERE id = ?').run(status, id);
    }
  }

  getEscalationStats(
    shopId: string,
    sinceMs: number,
  ): Array<{ status: string; count: number }> {
    return this.db
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM escalation_queue
         WHERE shop_id = ? AND created_at >= ?
         GROUP BY status`,
      )
      .all(shopId, sinceMs) as Array<{ status: string; count: number }>;
  }

  getPendingEscalation(shopId: string): EscalationRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, shop_id AS shopId, session_id AS sessionId, audit_id AS auditId,
           reason, priority, status, assigned_agent_id AS assignedAgentId,
           required_skills AS requiredSkillsJson, created_at AS createdAt,
           assigned_at AS assignedAt, resolved_at AS resolvedAt, resolution
         FROM escalation_queue
         WHERE shop_id = ? AND status = 'pending'
         ORDER BY priority DESC, created_at ASC LIMIT 1`,
      )
      .get(shopId) as (EscalationRecord & { requiredSkillsJson: string }) | undefined;

    if (!row) return null;
    const { requiredSkillsJson, ...rest } = row;
    return {
      ...rest,
      requiredSkills: JSON.parse(requiredSkillsJson || '[]'),
    } as EscalationRecord;
  }

  getEscalation(id: number): EscalationRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, shop_id AS shopId, session_id AS sessionId, audit_id AS auditId,
           reason, priority, status, assigned_agent_id AS assignedAgentId,
           required_skills AS requiredSkillsJson, created_at AS createdAt,
           assigned_at AS assignedAt, resolved_at AS resolvedAt, resolution
         FROM escalation_queue WHERE id = ?`,
      )
      .get(id) as (EscalationRecord & { requiredSkillsJson: string }) | undefined;
    if (!row) return null;
    const { requiredSkillsJson, ...rest } = row;
    return { ...rest, requiredSkills: JSON.parse(requiredSkillsJson || '[]') } as EscalationRecord;
  }

  listPendingEscalations(): EscalationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, shop_id AS shopId, session_id AS sessionId, audit_id AS auditId,
           reason, priority, status, assigned_agent_id AS assignedAgentId,
           required_skills AS requiredSkillsJson, created_at AS createdAt,
           assigned_at AS assignedAt, resolved_at AS resolvedAt, resolution
         FROM escalation_queue WHERE status = 'pending'
         ORDER BY created_at ASC`,
      )
      .all() as Array<EscalationRecord & { requiredSkillsJson: string }>;
    return rows.map(({ requiredSkillsJson, ...record }) => ({
      ...record,
      requiredSkills: JSON.parse(requiredSkillsJson || '[]'),
    })) as EscalationRecord[];
  }
}
