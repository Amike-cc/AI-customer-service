/**
 * 平台消息会话合并单元测试（UI-SESSION-001）
 *
 * mergePlatformSessions 决定工作台会话列表的内容与顺序，两个数据源
 * （LLM 上下文会话 / 平台消息会话）合并逻辑必须稳定。
 */
import { mergePlatformSessions } from '@/db/repos/ConversationMessageRepo';

describe('mergePlatformSessions', () => {
  it('合并两个来源并按最后活跃时间倒序', () => {
    const merged = mergePlatformSessions(
      [{ sessionId: 'a', lastMessageAt: 100, messageCount: 1 }],
      [{ sessionId: 'b', lastMessageAt: 200, messageCount: 3 }],
    );
    expect(merged.map((s) => s.sessionId)).toEqual(['b', 'a']);
  });

  it('同一会话取较新时间并累加消息数', () => {
    const merged = mergePlatformSessions(
      [{ sessionId: 'a', lastMessageAt: 100, messageCount: 2 }],
      [{ sessionId: 'a', lastMessageAt: 300, messageCount: 5 }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({ sessionId: 'a', lastMessageAt: 300, messageCount: 7 });
  });

  it('上下文会话时间更新时保留较新时间', () => {
    const merged = mergePlatformSessions(
      [{ sessionId: 'a', lastMessageAt: 500, messageCount: 1 }],
      [{ sessionId: 'a', lastMessageAt: 100, messageCount: 1 }],
    );
    expect(merged[0].lastMessageAt).toBe(500);
    expect(merged[0].messageCount).toBe(2);
  });

  it('遵守 limit 截断且不改动输入', () => {
    const ctx = [{ sessionId: 'a', lastMessageAt: 1, messageCount: 1 }];
    const msgs = [
      { sessionId: 'b', lastMessageAt: 3, messageCount: 1 },
      { sessionId: 'c', lastMessageAt: 2, messageCount: 1 },
    ];
    const merged = mergePlatformSessions(ctx, msgs, 2);
    expect(merged).toHaveLength(2);
    expect(merged.map((s) => s.sessionId)).toEqual(['b', 'c']);
    // 输入对象不被就地修改
    expect(ctx[0]).toEqual({ sessionId: 'a', lastMessageAt: 1, messageCount: 1 });
  });

  it('空输入返回空数组', () => {
    expect(mergePlatformSessions([], [])).toEqual([]);
  });

  it('合并会话时保留最新消息方向和人工发送标记', () => {
    const merged = mergePlatformSessions(
      [{ sessionId: 'a', lastMessageAt: 100, messageCount: 2, lastDirection: 'in' }],
      [{ sessionId: 'a', lastMessageAt: 300, messageCount: 1, lastDirection: 'out', hasManual: true }],
    );
    expect(merged[0]).toEqual({
      sessionId: 'a',
      lastMessageAt: 300,
      messageCount: 3,
      lastDirection: 'out',
      hasManual: true,
    });
  });
});
