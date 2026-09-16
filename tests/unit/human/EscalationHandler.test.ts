import { EscalationHandler } from '@/human/EscalationHandler';
import type { IntentRepo } from '@/db/repos/IntentRepo';
import type { AgentRepo } from '@/db/repos/AgentRepo';
import type { EscalationManager } from '@/intent/EscalationManager';
import type { MetricsCollector } from '@/monitor/MetricsCollector';
import type { AppLogger } from '@/logging/logger';
import { createTestConfig } from '../helpers/testConfig';

const escalation = {
  id: 7,
  shopId: 'shop1',
  sessionId: 'session1',
  reason: 'human_request',
  priority: 'high' as const,
  status: 'pending' as const,
  requiredSkills: ['general'],
  createdAt: Date.now(),
};

function createHandler(availableAgents: Array<{ id: string; name: string; shopId: string; status: string; skills: string[]; activeChats: number; maxChats: number; lastAssignedAt: number | null }>) {
  const intentRepo = {
    getEscalation: jest.fn().mockReturnValue(escalation),
    updateEscalationStatus: jest.fn(),
    listPendingEscalations: jest.fn().mockReturnValue([]),
  } as unknown as jest.Mocked<IntentRepo>;
  const agentRepo = {
    getAvailableAgents: jest.fn().mockReturnValue(availableAgents),
    incrementActiveChats: jest.fn(),
    decrementActiveChats: jest.fn(),
    updateStatus: jest.fn(),
    upsertAgent: jest.fn(),
    listByShop: jest.fn().mockReturnValue(availableAgents),
  } as unknown as jest.Mocked<AgentRepo>;
  const handler = new EscalationHandler({
    config: createTestConfig(),
    intentRepo,
    agentRepo,
    escalationManager: {} as EscalationManager,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as AppLogger,
    metrics: { inc: jest.fn() } as unknown as MetricsCollector,
  });
  return { handler, intentRepo, agentRepo };
}

describe('EscalationHandler manual assignment', () => {
  it('updates persistence only after an agent is selected', async () => {
    const agent = { id: 'agent1', name: '客服小芳', shopId: 'shop1', status: 'available', skills: ['general'], activeChats: 0, maxChats: 5, lastAssignedAt: null };
    const { handler, intentRepo, agentRepo } = createHandler([agent]);

    await handler.handleEscalation(escalation);

    expect(intentRepo.updateEscalationStatus).toHaveBeenCalledWith(7, 'assigned', 'agent1');
    expect(agentRepo.incrementActiveChats).toHaveBeenCalledWith('agent1');
  });

  it('keeps the escalation pending when no agent is available', async () => {
    const { handler, intentRepo, agentRepo } = createHandler([]);

    await handler.handleEscalation(escalation);

    expect(intentRepo.updateEscalationStatus).not.toHaveBeenCalled();
    expect(agentRepo.incrementActiveChats).not.toHaveBeenCalled();
  });
});
