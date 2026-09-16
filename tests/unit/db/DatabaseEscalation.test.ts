import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { Database } from '@/db/Database';
import { createTestConfig } from '../helpers/testConfig';

describe('Database.resolveEscalation', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aikefu-escalation-'));
    const config = createTestConfig();
    config.app.data_dir = tempDir;
    db = new Database(config);
    await db.migrate();

    db.agent.upsertAgent({
      id: 'agent-1',
      shopId: '10001',
      name: '坐席甲',
      status: 'available',
      maxChats: 3,
    });
  });

  afterEach(async () => {
    await db.close();
    await fs.remove(tempDir);
  });

  it('解决已分配工单时释放坐席负载且重复调用不二次扣减', () => {
    const escalationId = db.intent.addEscalation({
      shopId: '10001',
      sessionId: 'session-1',
      reason: '需要人工处理',
      priority: 'high',
      requiredSkills: ['general'],
    });
    db.intent.updateEscalationStatus(escalationId, 'assigned', 'agent-1');
    db.agent.incrementActiveChats('agent-1');

    expect(db.agent.listByShop('10001')[0].activeChats).toBe(1);

    const firstResult = db.resolveEscalation(escalationId, '问题已解决');
    expect(firstResult).toEqual({
      alreadyResolved: false,
      shopId: '10001',
      releasedAgentId: 'agent-1',
    });
    expect(db.intent.getEscalation(escalationId)?.status).toBe('resolved');
    expect(db.intent.getEscalation(escalationId)?.resolution).toBe('问题已解决');
    expect(db.agent.listByShop('10001')[0].activeChats).toBe(0);

    const secondResult = db.resolveEscalation(escalationId, '重复操作');
    expect(secondResult).toEqual({
      alreadyResolved: true,
      shopId: '10001',
    });
    expect(db.agent.listByShop('10001')[0].activeChats).toBe(0);
  });

  it('解决未分配工单不会修改坐席负载', () => {
    const escalationId = db.intent.addEscalation({
      shopId: '10001',
      sessionId: 'session-2',
      reason: '无需人工',
      priority: 'low',
    });

    const result = db.resolveEscalation(escalationId, '直接解决');
    expect(result.alreadyResolved).toBe(false);
    expect(result.releasedAgentId).toBeUndefined();
    expect(db.agent.listByShop('10001')[0].activeChats).toBe(0);
  });
});
