import type { AgentRepo } from '../db/repos/AgentRepo';
import type { AppLogger } from '../logging/logger';
import type { HumanAgent } from './types';

export class WorkloadBalancer {
  constructor(
    private repo: AgentRepo,
    private logger: AppLogger,
  ) {}

  async selectAgent(shopId: string, requiredSkills: string[]): Promise<HumanAgent | null> {
    const availableAgents = this.repo.getAvailableAgents(shopId);
    if (availableAgents.length === 0) {
      this.logger.debug({ shopId }, '无可用客服');
      return null;
    }

    const scored = availableAgents.map((agent) => {
      const loadScore = agent.maxChats > 0 ? (1 - agent.activeChats / agent.maxChats) : 0;

      const skillMatchCount = requiredSkills.filter((s) => agent.skills.includes(s)).length;
      const skillScore = requiredSkills.length > 0 ? skillMatchCount / requiredSkills.length : 0.5;

      const now = Date.now();
      const timeSinceLastAssign = agent.lastAssignedAt ? now - agent.lastAssignedAt : 60000;
      const timeBonus = Math.min(timeSinceLastAssign / 60000, 1);

      const score = loadScore * 0.5 + skillScore * 0.3 + timeBonus * 0.2;

      return { agent, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const selected = scored[0];

    this.logger.debug(
      { shopId, agentId: selected.agent.id, agentName: selected.agent.name, score: selected.score },
      '选中客服',
    );

    return selected.agent;
  }

  async updateAgentStatus(agentId: string, status: 'available' | 'busy' | 'offline'): Promise<void> {
    this.repo.updateStatus(agentId, status);
  }

  async incrementActiveChats(agentId: string): Promise<void> {
    this.repo.incrementActiveChats(agentId);
  }

  async decrementActiveChats(agentId: string): Promise<void> {
    this.repo.decrementActiveChats(agentId);
  }

  listAgents(shopId: string): HumanAgent[] {
    return this.repo.listByShop(shopId);
  }

  upsertDetectedAgents(
    shopId: string,
    detectedAgents: Array<{ id: string; name: string }>,
  ): void {
    for (const a of detectedAgents) {
      this.repo.upsertAgent({
        id: a.id,
        shopId,
        name: a.name,
        status: 'available',
      });
    }
  }
}
