/**
 * AgentQueue 单元测试
 * 详见 src/human/AgentQueue.ts
 * 纯内存逻辑，无需 DB
 */
import { AgentQueue } from '@/human/AgentQueue';
import type { QueueEntry } from '@/human/types';

function makeQueueEntry(overrides?: Partial<QueueEntry>): QueueEntry {
  return {
    escalationId: 1,
    shopId: 'shop1',
    sessionId: 's1',
    priority: 'medium',
    reason: '客户投诉物流太慢',
    requiredSkills: [],
    enqueuedAt: Date.now(),
    estimatedWaitMs: 60000,
    ...overrides,
  };
}

describe('AgentQueue', () => {
  let queue: AgentQueue;

  beforeEach(() => {
    queue = new AgentQueue();
  });

  describe('enqueue', () => {
    it('入队后 size 增加', () => {
      const size = queue.enqueue(makeQueueEntry({ escalationId: 1 }));
      expect(size).toBe(1);
      expect(queue.size('shop1')).toBe(1);
    });

    it('多条入队后 size 累加', () => {
      queue.enqueue(makeQueueEntry({ escalationId: 1 }));
      queue.enqueue(makeQueueEntry({ escalationId: 2 }));
      queue.enqueue(makeQueueEntry({ escalationId: 3 }));
      expect(queue.size('shop1')).toBe(3);
    });
  });

  describe('dequeue', () => {
    it('出队返回队首并减少 size', () => {
      queue.enqueue(makeQueueEntry({ escalationId: 1 }));
      const entry = queue.dequeue('shop1');
      expect(entry).not.toBeNull();
      expect(entry!.escalationId).toBe(1);
      expect(queue.size('shop1')).toBe(0);
    });

    it('空队列出队返回 null', () => {
      expect(queue.dequeue('shop1')).toBeNull();
    });
  });

  describe('peek', () => {
    it('查看队首但不移除', () => {
      queue.enqueue(makeQueueEntry({ escalationId: 1 }));
      queue.enqueue(makeQueueEntry({ escalationId: 2 }));
      const entry = queue.peek('shop1');
      expect(entry).not.toBeNull();
      expect(entry!.escalationId).toBe(1);
      expect(queue.size('shop1')).toBe(2);
    });

    it('空队列 peek 返回 null', () => {
      expect(queue.peek('shop1')).toBeNull();
    });
  });

  describe('优先级排序', () => {
    it('按优先级 urgent > high > medium > low 出队', () => {
      queue.enqueue(makeQueueEntry({ escalationId: 1, priority: 'low' }));
      queue.enqueue(makeQueueEntry({ escalationId: 2, priority: 'urgent' }));
      queue.enqueue(makeQueueEntry({ escalationId: 3, priority: 'medium' }));
      queue.enqueue(makeQueueEntry({ escalationId: 4, priority: 'high' }));

      expect(queue.dequeue('shop1')!.escalationId).toBe(2); // urgent
      expect(queue.dequeue('shop1')!.escalationId).toBe(4); // high
      expect(queue.dequeue('shop1')!.escalationId).toBe(3); // medium
      expect(queue.dequeue('shop1')!.escalationId).toBe(1); // low
    });

    it('同优先级按入队时间 FIFO', () => {
      const baseTime = Date.now();
      queue.enqueue(makeQueueEntry({ escalationId: 1, priority: 'medium', enqueuedAt: baseTime }));
      queue.enqueue(makeQueueEntry({ escalationId: 2, priority: 'medium', enqueuedAt: baseTime + 1000 }));

      expect(queue.dequeue('shop1')!.escalationId).toBe(1);
      expect(queue.dequeue('shop1')!.escalationId).toBe(2);
    });
  });

  describe('店铺隔离', () => {
    it('size 按店铺独立计算', () => {
      queue.enqueue(makeQueueEntry({ escalationId: 1, shopId: 'shop1' }));
      queue.enqueue(makeQueueEntry({ escalationId: 2, shopId: 'shop1' }));
      queue.enqueue(makeQueueEntry({ escalationId: 3, shopId: 'shop2' }));

      expect(queue.size('shop1')).toBe(2);
      expect(queue.size('shop2')).toBe(1);
    });

    it('dequeue 按店铺隔离', () => {
      queue.enqueue(makeQueueEntry({ escalationId: 1, shopId: 'shop1' }));
      queue.enqueue(makeQueueEntry({ escalationId: 2, shopId: 'shop2' }));

      expect(queue.dequeue('shop1')!.escalationId).toBe(1);
      expect(queue.dequeue('shop2')!.escalationId).toBe(2);
    });
  });

  describe('list', () => {
    it('返回队列副本，修改不影响内部状态', () => {
      queue.enqueue(makeQueueEntry({ escalationId: 1 }));
      const list = queue.list('shop1');
      list.pop();
      list.push(makeQueueEntry({ escalationId: 999 }));
      expect(queue.size('shop1')).toBe(1);
      expect(queue.peek('shop1')!.escalationId).toBe(1);
    });
  });

  describe('remove', () => {
    it('删除指定项后 size 减少', () => {
      queue.enqueue(makeQueueEntry({ escalationId: 1 }));
      queue.enqueue(makeQueueEntry({ escalationId: 2 }));
      queue.enqueue(makeQueueEntry({ escalationId: 3 }));

      const removed = queue.remove('shop1', 2);
      expect(removed).toBe(true);
      expect(queue.size('shop1')).toBe(2);

      // 确认被删除项不出现在 dequeue 中
      const ids: number[] = [];
      let entry: QueueEntry | null;
      while ((entry = queue.dequeue('shop1'))) {
        ids.push(entry.escalationId);
      }
      expect(ids).not.toContain(2);
    });

    it('删除不存在的项返回 false', () => {
      queue.enqueue(makeQueueEntry({ escalationId: 1 }));
      expect(queue.remove('shop1', 999)).toBe(false);
      expect(queue.size('shop1')).toBe(1);
    });

    it('空队列 remove 返回 false', () => {
      expect(queue.remove('shop1', 1)).toBe(false);
    });
  });

  describe('clear', () => {
    it('清空指定店铺队列', () => {
      queue.enqueue(makeQueueEntry({ escalationId: 1, shopId: 'shop1' }));
      queue.enqueue(makeQueueEntry({ escalationId: 2, shopId: 'shop1' }));
      queue.enqueue(makeQueueEntry({ escalationId: 3, shopId: 'shop2' }));

      queue.clear('shop1');
      expect(queue.size('shop1')).toBe(0);
      expect(queue.size('shop2')).toBe(1);
    });
  });
});
