/**
 * Orchestrator + Agents 单元测试
 */
import { Orchestrator } from '@/agents/Orchestrator';
import { AfterSalesAgent } from '@/agents/AfterSalesAgent';
import { LogisticsAgent } from '@/agents/LogisticsAgent';
import { ProductExpertAgent } from '@/agents/ProductExpertAgent';
import { GeneralAgent } from '@/agents/GeneralAgent';
import type { ModelGateway } from '@/gateway/ModelGateway';
import type { ResourceScheduler } from '@/scheduler/ResourceScheduler';
import type { AppLogger } from '@/logging/logger';
import type { MetricsCollector } from '@/monitor/MetricsCollector';
import type { Config } from '@/config/schema';
import type { GatewayRequest, GatewayResponse } from '@/gateway/types';
import type { AgentResult } from '@/agents/types';

function makeMockGateway(response?: Partial<GatewayResponse>): ModelGateway {
  const defaultResponse: GatewayResponse = {
    content: 'mock reply',
    model: 'deepseek-v4-flash',
    tokenInput: 100,
    tokenOutput: 50,
    latencyMs: 500,
    cached: false,
    truncated: false,
    confidence: 0.9,
    provider: 'deepseek',
    costYuan: 0.05,
  };
  return {
    route: jest.fn().mockResolvedValue({ ...defaultResponse, ...response }),
  } as unknown as ModelGateway;
}

function makeMockScheduler(): ResourceScheduler {
  return {
    acquire: jest.fn().mockResolvedValue({ allowed: true, allocatedTier: 'tier3' }),
    recordCost: jest.fn(),
    getDailyCost: jest.fn().mockReturnValue(0),
    getGlobalDailyCost: jest.fn().mockReturnValue(0),
    setShopPriority: jest.fn(),
  } as unknown as ResourceScheduler;
}

function makeMockDeps() {
  return {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as AppLogger,
    metrics: { inc: jest.fn(), observe: jest.fn(), set: jest.fn() } as unknown as MetricsCollector,
    config: {} as Config,
  };
}

function makeAgents(gateway: ModelGateway, scheduler: ResourceScheduler) {
  const deps = makeMockDeps();
  return [
    new AfterSalesAgent(gateway, scheduler, deps.logger),
    new LogisticsAgent(gateway, scheduler, deps.logger),
    new ProductExpertAgent(gateway, scheduler, deps.logger),
    new GeneralAgent(gateway, scheduler, deps.logger),
  ];
}

describe('Agent 集群', () => {
  it('含"退货"关键词的消息路由到 AfterSalesAgent', async () => {
    const gateway = makeMockGateway();
    const scheduler = makeMockScheduler();
    const agents = makeAgents(gateway, scheduler);
    const orchestrator = new Orchestrator({ agents, ...makeMockDeps() });

    const result = await orchestrator.orchestrate({
      shopId: 'shop1',
      sessionId: 'session1',
      userMessage: '我要退货，商品有质量问题',
      history: [],
    });

    expect(result.agentId).toBe('after_sales');
    expect(gateway.route).toHaveBeenCalledWith(
      expect.objectContaining({ preferredTier: 'tier3' }),
    );
  });

  it('含"物流"关键词的消息路由到 LogisticsAgent', async () => {
    const gateway = makeMockGateway();
    const scheduler = makeMockScheduler();
    const agents = makeAgents(gateway, scheduler);
    const orchestrator = new Orchestrator({ agents, ...makeMockDeps() });

    const result = await orchestrator.orchestrate({
      shopId: 'shop1',
      sessionId: 'session1',
      userMessage: '我的快递什么时候到？',
      history: [],
    });

    expect(result.agentId).toBe('logistics');
    expect(gateway.route).toHaveBeenCalledWith(
      expect.objectContaining({ preferredTier: 'tier2' }),
    );
  });

  it('含"尺码"关键词的消息路由到 ProductExpertAgent', async () => {
    const gateway = makeMockGateway();
    const scheduler = makeMockScheduler();
    const agents = makeAgents(gateway, scheduler);
    const orchestrator = new Orchestrator({ agents, ...makeMockDeps() });

    const result = await orchestrator.orchestrate({
      shopId: 'shop1',
      sessionId: 'session1',
      userMessage: '这款衣服XL码多大？',
      history: [],
    });

    expect(result.agentId).toBe('product_expert');
  });

  it('无匹配关键词时路由到 GeneralAgent', async () => {
    const gateway = makeMockGateway();
    const scheduler = makeMockScheduler();
    const agents = makeAgents(gateway, scheduler);
    const orchestrator = new Orchestrator({ agents, ...makeMockDeps() });

    const result = await orchestrator.orchestrate({
      shopId: 'shop1',
      sessionId: 'session1',
      userMessage: '你好，在吗？',
      history: [],
    });

    expect(result.agentId).toBe('general');
  });

  it('scenario 精确匹配优先于关键词', async () => {
    const gateway = makeMockGateway();
    const scheduler = makeMockScheduler();
    const agents = makeAgents(gateway, scheduler);
    const orchestrator = new Orchestrator({ agents, ...makeMockDeps() });

    await orchestrator.orchestrate({
      shopId: 'shop1',
      sessionId: 'session1',
      userMessage: '请问一下',
      scenario: 'after_sales',
      history: [],
    });

    expect(gateway.route).toHaveBeenCalledWith(
      expect.objectContaining({ preferredTier: 'tier3' }),
    );
  });

  it('Agent execute 返回正确的 AgentResult', async () => {
    const gateway = makeMockGateway({ confidence: 0.85, content: '售后回复内容' });
    const scheduler = makeMockScheduler();
    const agents = makeAgents(gateway, scheduler);
    const orchestrator = new Orchestrator({ agents, ...makeMockDeps() });

    const result = await orchestrator.orchestrate({
      shopId: 'shop1',
      sessionId: 'session1',
      userMessage: '我要退款',
      history: [],
    });

    expect(result.content).toBe('售后回复内容');
    expect(result.agentId).toBe('after_sales');
    expect(result.confidence).toBe(0.85);
  });

  it('AfterSalesAgent.canHandle 正确匹配', () => {
    const gateway = makeMockGateway();
    const scheduler = makeMockScheduler();
    const agent = new AfterSalesAgent(gateway, scheduler, makeMockDeps().logger);
    expect(agent.canHandle({ userMessage: '我要退货' } as never)).toBe(true);
    expect(agent.canHandle({ userMessage: '你好' } as never)).toBe(false);
  });

  it('GeneralAgent.canHandle 总是返回 true', () => {
    const gateway = makeMockGateway();
    const scheduler = makeMockScheduler();
    const agent = new GeneralAgent(gateway, scheduler, makeMockDeps().logger);
    expect(agent.canHandle({ userMessage: '任意内容' } as never)).toBe(true);
  });
});
