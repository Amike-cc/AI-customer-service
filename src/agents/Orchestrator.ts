/**
 * 编排器：负责任务分解、Agent 路由、结果聚合
 * 替换 ShopSupervisor.generateReply 中对 deepseekClient 的直接调用
 *
 * Agent 路由算法：
 * 1. 对每个 Agent 计算匹配分数（场景精确匹配 +100，关键词匹配 +10*权重）
 * 2. 按分数排序取最高分
 * 3. 验证 Agent.canHandle()
 * 4. 无匹配时返回 GeneralAgent（兜底）
 */
import type { IAgent, AgentContext, AgentResult } from './types';
import type { AppLogger } from '../logging/logger';
import type { Config } from '../config/schema';
import type { MetricsCollector } from '../monitor/MetricsCollector';

export interface OrchestratorDeps {
  agents: IAgent[];
  logger: AppLogger;
  metrics: MetricsCollector;
  config: Config;
}

interface AgentMatch {
  agent: IAgent;
  score: number;
}

export class Orchestrator {
  constructor(private deps: OrchestratorDeps) {}

  async orchestrate(ctx: AgentContext): Promise<AgentResult> {
    const agent = this.routeToAgent(ctx);

    this.deps.metrics.inc('agent_invoke_total', 1, { agent: agent.agentId }, ctx.shopId);
    this.deps.logger.debug(
      { shopId: ctx.shopId, agent: agent.agentId, scenario: ctx.scenario },
      'Agent 路由完成',
    );

    const result = await agent.execute(ctx);

    this.deps.metrics.observe(
      'agent_confidence',
      result.confidence,
      { agent: result.agentId },
      ctx.shopId,
    );
    this.deps.metrics.inc(
      'agent_token_total',
      result.tokenInput + result.tokenOutput,
      { agent: result.agentId },
      ctx.shopId,
    );

    return result;
  }

  private routeToAgent(ctx: AgentContext): IAgent {
    const candidates: AgentMatch[] = [];
    const text = ctx.userMessage.toLowerCase();

    for (const agent of this.deps.agents) {
      let score = 0;

      // 场景命中优先，直接返回该场景对应的 Agent（权重归一化避免不同 Agent
      // 的 priority 差异扭曲场景命中与关键词命中的相对权重）
      if (ctx.scenario && agent.capabilities.scenarios.includes(ctx.scenario)) {
        score += 100;
      }

      for (const keyword of agent.capabilities.keywords) {
        if (text.includes(keyword.toLowerCase())) {
          score += 10 * (keyword.length / Math.max(text.length, 1));
        }
      }

      // 归一化：priority 除以最大值（而非固定 50），避免 after_sales(90) 等
      // 高优先级 Agent 在相同命中下系统性压过其他 Agent
      const maxPriority = Math.max(...this.deps.agents.map((a) => a.capabilities.priority), 1);
      score *= agent.capabilities.priority / maxPriority;

      if (score > 0) {
        candidates.push({ agent, score });
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    for (const { agent } of candidates) {
      if (agent.canHandle(ctx)) {
        return agent;
      }
    }

    return this.getGeneralAgent();
  }

  private getGeneralAgent(): IAgent {
    const general = this.deps.agents.find((a) => a.agentId === 'general');
    if (general) return general;
    // 兜底：没有 general Agent 且 agents 为空时返回明确的错误提示 Agent，
    // 避免 execute 抛 TypeError 崩溃
    return this.deps.agents[0] ?? {
      agentId: 'general',
      name: '兜底客服',
      description: '无可用 Agent 时的兜底',
      capabilities: {
        priority: 1,
        keywords: [],
        scenarios: [],
        agentRole: 'general' as const,
      },
      async canHandle(): Promise<boolean> {
        return true;
      },
      async execute(): Promise<AgentResult> {
        return {
          agentId: 'general',
          content: '抱歉，系统暂时无法处理您的请求，请稍后重试或联系人工客服~',
          model: 'fallback',
          confidence: 0,
          tokenInput: 0,
          tokenOutput: 0,
          latencyMs: 0,
          truncated: false,
          cached: false,
        };
      },
    };
  }
}
