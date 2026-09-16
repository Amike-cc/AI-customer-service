import { EventEmitter } from 'events';
import type { IntentRepo } from '../db/repos/IntentRepo';
import type { MetricsCollector } from '../monitor/MetricsCollector';
import type { AppLogger } from '../logging/logger';
import type { ComplexityResult, EscalationRecord, EscalationInput, EscalationPriority } from './types';

export class EscalationManager extends EventEmitter {
  constructor(
    private repo: IntentRepo,
    private logger: AppLogger,
    private metrics: MetricsCollector,
  ) {
    super();
  }

  async requestEscalation(
    shopId: string,
    sessionId: string,
    complexity: ComplexityResult,
    auditId?: number,
  ): Promise<EscalationRecord> {
    const priority = this.determinePriority(complexity);
    const requiredSkills = this.determineRequiredSkills(complexity);
    // reasons 为空但 score 超阈值时补真实原因（原实现退化为占位符，且
    // determineRequiredSkills 只能得到 general 导致人工分配不准确）
    const reason = complexity.reasons.length > 0
      ? complexity.reasons.join(';')
      : complexity.shouldEscalate
        ? 'high_complexity'
        : 'complexity_threshold';

    const input: EscalationInput = {
      shopId,
      sessionId,
      auditId,
      reason,
      priority,
      requiredSkills,
    };

    const id = this.repo.addEscalation(input);
    this.metrics.inc('escalation_requested_total', 1, { priority }, shopId);
    this.logger.info(
      { shopId, sessionId, escalationId: id, priority, reason },
      '升级请求已创建',
    );

    const record: EscalationRecord = {
      id,
      shopId,
      sessionId,
      auditId,
      reason,
      priority,
      status: 'pending',
      requiredSkills,
      createdAt: Date.now(),
    };

    this.emit('escalation', record);
    return record;
  }

  async resolveEscalation(id: number, resolution: string): Promise<void> {
    this.repo.updateEscalationStatus(id, 'resolved', undefined, resolution);
    this.metrics.inc('escalation_resolved_total', 1);
    this.logger.info({ escalationId: id }, '升级已解决');
  }

  listPending(shopId: string): EscalationRecord[] {
    return this.repo.listEscalations(shopId, 'pending');
  }

  listAll(shopId: string, status?: string): EscalationRecord[] {
    return this.repo.listEscalations(shopId, status);
  }

  assignToAgent(id: number, agentId: string): void {
    this.repo.updateEscalationStatus(id, 'assigned', agentId);
    this.metrics.inc('escalation_assigned_total', 1);
  }

  private determinePriority(complexity: ComplexityResult): EscalationPriority {
    if (complexity.score >= 0.8 || complexity.reasons.includes('emotional_frustration')) {
      return 'urgent';
    }
    if (complexity.score >= 0.6) {
      return 'high';
    }
    if (complexity.score >= 0.3) {
      return 'medium';
    }
    return 'low';
  }

  private determineRequiredSkills(complexity: ComplexityResult): string[] {
    const skills: string[] = [];
    if (complexity.reasons.includes('emotional_frustration')) {
      skills.push('complaint');
    }
    if (complexity.reasons.includes('order_context')) {
      skills.push('after_sales');
    }
    if (complexity.reasons.includes('multi_question')) {
      skills.push('general');
    }
    if (skills.length === 0) {
      skills.push('general');
    }
    return skills;
  }
}
