import type { QueueEntry, QueuePriority } from './types';

const PRIORITY_ORDER: Record<QueuePriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export class AgentQueue {
  private queues = new Map<string, QueueEntry[]>();

  enqueue(entry: QueueEntry): number {
    const queue = this.getOrCreate(entry.shopId);
    if (queue.some((queued) => queued.escalationId === entry.escalationId)) {
      return queue.length;
    }
    queue.push(entry);
    queue.sort((a, b) => {
      const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (p !== 0) return p;
      return a.enqueuedAt - b.enqueuedAt;
    });
    return queue.length;
  }

  dequeue(shopId: string): QueueEntry | null {
    const queue = this.queues.get(shopId);
    if (!queue || queue.length === 0) return null;
    return queue.shift() ?? null;
  }

  peek(shopId: string): QueueEntry | null {
    const queue = this.queues.get(shopId);
    if (!queue || queue.length === 0) return null;
    return queue[0];
  }

  size(shopId: string): number {
    return this.queues.get(shopId)?.length ?? 0;
  }

  list(shopId: string): QueueEntry[] {
    return [...(this.queues.get(shopId) ?? [])];
  }

  remove(shopId: string, escalationId: number): boolean {
    const queue = this.queues.get(shopId);
    if (!queue) return false;
    const idx = queue.findIndex((e) => e.escalationId === escalationId);
    if (idx < 0) return false;
    queue.splice(idx, 1);
    return true;
  }

  clear(shopId: string): void {
    this.queues.delete(shopId);
  }

  shopIds(): string[] {
    return Array.from(this.queues.entries())
      .filter(([, queue]) => queue.length > 0)
      .map(([shopId]) => shopId);
  }

  private getOrCreate(shopId: string): QueueEntry[] {
    if (!this.queues.has(shopId)) {
      this.queues.set(shopId, []);
    }
    return this.queues.get(shopId)!;
  }
}
