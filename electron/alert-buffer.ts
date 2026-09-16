/**
 * 告警环形缓冲
 *
 * 在主进程内存中维护最近 N 条告警，供 UI 拉取历史。
 */
import type { Alert } from '../src/monitor/AlertManager';

export class AlertBuffer {
  private buffer: Alert[] = [];

  constructor(private capacity: number) {}

  push(alert: Alert): void {
    this.buffer.push(alert);
    while (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
  }

  /** 返回告警列表（最新在前） */
  list(): Alert[] {
    return [...this.buffer].reverse();
  }

  /** 确认并移除指定名称的告警，返回移除数量 */
  acknowledge(name: string): number {
    const before = this.buffer.length;
    this.buffer = this.buffer.filter((a) => a.name !== name);
    return before - this.buffer.length;
  }

  clear(): void {
    this.buffer = [];
  }

  get size(): number {
    return this.buffer.length;
  }
}
