/**
 * 对话状态 Repository
 *
 * 持久化多轮对话状态（槽位填充进度），避免进程崩溃丢失对话上下文。
 *
 * 表结构（见 Database.migrate）：
 *   dialog_state(shop_id, session_id, scenario_id, slots, current_slot,
 *               started_at, last_interaction_at, turn_count, completed, cancelled)
 *   PRIMARY KEY (shop_id, session_id)
 */
import type SqliteDatabase from 'better-sqlite3';
import type { DialogState, SlotState } from '../../dialog/types';

interface DialogStateRow {
  shop_id: string;
  session_id: string;
  scenario_id: string;
  slots: string;
  current_slot: string | null;
  started_at: number;
  last_interaction_at: number;
  turn_count: number;
  completed: number;
  cancelled: number;
}

export class DialogStateRepo {
  constructor(private db: SqliteDatabase.Database) {}

  /** 获取指定会话的对话状态 */
  get(shopId: string, sessionId: string): DialogState | null {
    const row = this.db
      .prepare(
        `SELECT * FROM dialog_state WHERE shop_id = ? AND session_id = ?`,
      )
      .get(shopId, sessionId) as DialogStateRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** 写入或更新对话状态（upsert） */
  upsert(state: DialogState): void {
    this.db
      .prepare(
        `INSERT INTO dialog_state
           (shop_id, session_id, scenario_id, slots, current_slot,
            started_at, last_interaction_at, turn_count, completed, cancelled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop_id, session_id) DO UPDATE SET
           scenario_id = excluded.scenario_id,
           slots = excluded.slots,
           current_slot = excluded.current_slot,
           started_at = excluded.started_at,
           last_interaction_at = excluded.last_interaction_at,
           turn_count = excluded.turn_count,
           completed = excluded.completed,
           cancelled = excluded.cancelled`,
      )
      .run(
        state.shopId,
        state.sessionId,
        state.scenarioId,
        JSON.stringify(state.slots),
        state.currentSlot,
        state.startedAt,
        state.lastInteractionAt,
        state.turnCount,
        state.completed ? 1 : 0,
        state.cancelled ? 1 : 0,
      );
  }

  /** 删除指定会话的对话状态 */
  delete(shopId: string, sessionId: string): void {
    this.db
      .prepare(`DELETE FROM dialog_state WHERE shop_id = ? AND session_id = ?`)
      .run(shopId, sessionId);
  }

  /** 清理指定店铺的全部对话状态（用于店铺删除） */
  deleteAll(shopId: string): number {
    const result = this.db
      .prepare(`DELETE FROM dialog_state WHERE shop_id = ?`)
      .run(shopId);
    return result.changes;
  }

  /** 列出超时的对话状态（用于定期清理） */
  listExpired(beforeTs: number, limit = 100): DialogState[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM dialog_state
         WHERE last_interaction_at < ? AND completed = 0 AND cancelled = 0
         LIMIT ?`,
      )
      .all(beforeTs, limit) as DialogStateRow[];
    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(r: DialogStateRow): DialogState {
    let slots: Record<string, SlotState> = {};
    try {
      const parsed = JSON.parse(r.slots || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        slots = parsed as Record<string, SlotState>;
      }
    } catch {
      // 旧数据或损坏的 JSON，使用空对象
    }
    return {
      shopId: r.shop_id,
      sessionId: r.session_id,
      scenarioId: r.scenario_id,
      slots,
      currentSlot: r.current_slot,
      startedAt: r.started_at,
      lastInteractionAt: r.last_interaction_at,
      turnCount: r.turn_count,
      completed: r.completed === 1,
      cancelled: r.cancelled === 1,
    };
  }
}
