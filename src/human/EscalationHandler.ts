import { EventEmitter } from 'events';
import type { Config } from '../config/schema';
import type { AppLogger } from '../logging/logger';
import type { MetricsCollector } from '../monitor/MetricsCollector';
import type { IntentRepo } from '../db/repos/IntentRepo';
import type { AgentRepo } from '../db/repos/AgentRepo';
import type { EscalationManager } from '../intent/EscalationManager';
import { AgentQueue } from './AgentQueue';
import { WorkloadBalancer } from './WorkloadBalancer';
import type { EscalationRecord } from '../intent/types';
import type { QueueEntry } from './types';

export interface EscalationHandlerDeps {
  config: Config;
  intentRepo: IntentRepo;
  agentRepo: AgentRepo;
  escalationManager: EscalationManager;
  logger: AppLogger;
  metrics: MetricsCollector;
}

export class EscalationHandler extends EventEmitter {
  readonly queue: AgentQueue;
  readonly balancer: WorkloadBalancer;
  private timer: NodeJS.Timeout | null = null;
  /** per-shop 处理互斥：selectAgent → incrementActiveChats 跨 await，
   *  并发进入同一店铺会重复选中同一客服（active_chats 尚未 +1）导致超载 */
  private processingShops = new Set<string>();

  constructor(private deps: EscalationHandlerDeps) {
    super();
    this.queue = new AgentQueue();
    this.balancer = new WorkloadBalancer(deps.agentRepo, deps.logger);
  }

  start(): void {
    if (!this.deps.config.human_collab.enabled) return;
    for (const escalation of this.deps.intentRepo.listPendingEscalations()) {
      this.queue.enqueue(this.toQueueEntry(escalation));
    }
    const intervalMs = this.deps.config.human_collab.queue_poll_interval_ms;
    this.timer = setInterval(() => void this.processQueues(), intervalMs);
    this.timer.unref?.();
    this.deps.logger.info({ intervalMs }, '升级处理器已启动');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async handleEscalation(escalation: EscalationRecord): Promise<void> {
    const entry = this.toQueueEntry(escalation);

    this.queue.enqueue(entry);
    this.deps.metrics.inc('escalation_queued_total', 1, { priority: entry.priority }, escalation.shopId);

    if (this.deps.config.human_collab.auto_transfer_on_escalation) {
      await this.processQueue(escalation.shopId);
    }
  }

  private async processQueues(): Promise<void> {
    const shops = this.getActiveShops();
    for (const shopId of shops) {
      await this.processQueue(shopId);
    }
  }

  private async processQueue(shopId: string): Promise<void> {
    // 互斥：同一店铺同时只有一条分配流程，防止定时器与手动触发并发导致重复分配
    if (this.processingShops.has(shopId)) return;
    this.processingShops.add(shopId);
    try {
      await this.processQueueInternal(shopId);
    } finally {
      this.processingShops.delete(shopId);
    }
  }

  private async processQueueInternal(shopId: string): Promise<void> {
    while (this.queue.size(shopId) > 0) {
      const entry = this.queue.peek(shopId);
      if (!entry) break;

      const agent = await this.balancer.selectAgent(shopId, entry.requiredSkills);
      if (!agent) {
        this.deps.logger.debug({ shopId, queueSize: this.queue.size(shopId) }, '无可用客服，保持排队');
        break;
      }

      try {
        // 先更新 DB 状态，成功后再出队；避免更新失败时 entry 已出队但状态仍为 pending，
        // 被 listPendingEscalations 重新入队形成无限循环
        this.deps.intentRepo.updateEscalationStatus(entry.escalationId, 'assigned', agent.id);
        await this.balancer.incrementActiveChats(agent.id);
        this.queue.dequeue(shopId);

        this.deps.metrics.inc('escalation_transferred_total', 1, { agent: agent.id }, shopId);
        this.deps.logger.info(
          { shopId, escalationId: entry.escalationId, agentId: agent.id, agentName: agent.name },
          '升级已分配',
        );
        this.emit('transferred', {
          escalationId: entry.escalationId,
          agentId: agent.id,
          agentName: agent.name,
        });
      } catch (err) {
        // 更新失败：标记错误状态避免被 listPendingEscalations 重新入队，并出队防止本次循环死循环
        this.deps.logger.warn({ err, shopId, escalationId: entry.escalationId }, '升级分配失败');
        try {
          this.deps.intentRepo.updateEscalationStatus(entry.escalationId, 'error');
        } catch {
          /* 忽略二次写入失败 */
        }
        this.queue.dequeue(shopId);
        break;
      }
    }
  }

  private getActiveShops(): string[] {
    return this.queue.shopIds();
  }

  private toQueueEntry(escalation: EscalationRecord): QueueEntry {
    return {
      escalationId: escalation.id,
      shopId: escalation.shopId,
      sessionId: escalation.sessionId,
      priority: escalation.priority,
      reason: escalation.reason,
      requiredSkills: escalation.requiredSkills,
      enqueuedAt: escalation.createdAt || Date.now(),
      estimatedWaitMs: this.deps.config.human_collab.max_wait_ms,
    };
  }
}
