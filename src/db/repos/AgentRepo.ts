import type SqliteDatabase from 'better-sqlite3';
import type { HumanAgent, AgentStatus, AgentRepoRecord } from '../../human/types';

export class AgentRepo {
  constructor(private db: SqliteDatabase.Database) {}

  upsertAgent(agent: {
    id: string;
    shopId: string;
    name: string;
    status?: AgentStatus;
    maxChats?: number;
    skills?: string[];
  }): void {
    const now = Date.now();
    const existing = this.db
      .prepare('SELECT id FROM human_agents WHERE id = ?')
      .get(agent.id) as { id: string } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE human_agents SET name = ?, status = ?, max_chats = ?, skills = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          agent.name,
          agent.status ?? 'available',
          agent.maxChats ?? 5,
          JSON.stringify(agent.skills ?? []),
          now,
          agent.id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO human_agents
            (id, shop_id, name, status, active_chats, max_chats, skills, detected_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        )
        .run(
          agent.id,
          agent.shopId,
          agent.name,
          agent.status ?? 'available',
          agent.maxChats ?? 5,
          JSON.stringify(agent.skills ?? []),
          now,
          now,
        );
    }
  }

  listByShop(shopId: string): HumanAgent[] {
    const rows = this.db
      .prepare(
        `SELECT id, shop_id AS shopId, name, status,
           active_chats AS activeChats, max_chats AS maxChats,
           skills AS skillsJson, last_assigned_at AS lastAssignedAt,
           detected_at AS detectedAt, updated_at AS updatedAt
         FROM human_agents
         WHERE shop_id = ?
         ORDER BY status ASC, active_chats ASC`,
      )
      .all(shopId) as Array<AgentRepoRecord & { skillsJson: string }>;

    return rows.map((r) => {
      const { skillsJson, ...rest } = r;
      return {
        ...rest,
        skills: JSON.parse(skillsJson || '[]'),
      } as HumanAgent;
    });
  }

  getAvailableAgents(shopId: string): HumanAgent[] {
    const rows = this.db
      .prepare(
        `SELECT id, shop_id AS shopId, name, status,
           active_chats AS activeChats, max_chats AS maxChats,
           skills AS skillsJson, last_assigned_at AS lastAssignedAt,
           detected_at AS detectedAt, updated_at AS updatedAt
         FROM human_agents
         WHERE shop_id = ? AND status = 'available' AND active_chats < max_chats
         ORDER BY active_chats ASC, last_assigned_at ASC NULLS FIRST`,
      )
      .all(shopId) as Array<AgentRepoRecord & { skillsJson: string }>;

    return rows.map((r) => {
      const { skillsJson, ...rest } = r;
      return {
        ...rest,
        skills: JSON.parse(skillsJson || '[]'),
      } as HumanAgent;
    });
  }

  updateStatus(agentId: string, status: AgentStatus): void {
    const now = Date.now();
    this.db
      .prepare('UPDATE human_agents SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, agentId);
  }

  incrementActiveChats(agentId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE human_agents
         SET active_chats = active_chats + 1, last_assigned_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, agentId);
  }

  decrementActiveChats(agentId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE human_agents
         SET active_chats = MAX(0, active_chats - 1), updated_at = ?
         WHERE id = ?`,
      )
      .run(now, agentId);
  }

  setSkills(agentId: string, skills: string[]): void {
    const now = Date.now();
    this.db
      .prepare('UPDATE human_agents SET skills = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(skills), now, agentId);
  }
}
