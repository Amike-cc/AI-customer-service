/**
 * Agent 抽象基类
 * 所有具体 Agent 继承此类，实现 buildMessages() 和 preferredTier()
 */
import type { IAgent, AgentContext, AgentResult, AgentCapability } from './types';
import type { ModelTier } from '../scheduler/types';
import type { ModelGateway } from '../gateway/ModelGateway';
import type { GatewayResponse } from '../gateway/types';
import type { ResourceScheduler } from '../scheduler/ResourceScheduler';
import type { AppLogger } from '../logging/logger';
import type { ChatMessage } from '../deepseek/DeepSeekClient';
import { PromptBuilder } from './PromptBuilder';

export abstract class BaseAgent implements IAgent {
  abstract readonly agentId: string;
  abstract readonly capabilities: AgentCapability;
  protected promptBuilder = new PromptBuilder();

  constructor(
    protected gateway: ModelGateway,
    protected scheduler: ResourceScheduler,
    protected logger: AppLogger,
  ) {}

  abstract canHandle(ctx: AgentContext): boolean;

  /**
   * 执行 Agent：构建消息 → 调用 LLM → 处理 function calling 工具循环
   *
   * Function calling 流程（当 ctx.toolRegistry 存在时启用）：
   *   1. 把 ToolRegistry.getDefinitions() 作为 tools 传给 LLM
   *   2. LLM 返回 tool_calls（要调用的工具名+参数）
   *   3. ToolRegistry.execute() 执行工具，返回结果
   *   4. 把 assistant tool_calls 消息 + tool 结果消息追加到 messages
   *   5. 再次调用 LLM（带上工具结果），循环直到无 tool_calls 或达到 MAX_TOOL_ROUNDS
   */
  async execute(ctx: AgentContext): Promise<AgentResult> {
    const initialMessages = this.buildMessages(ctx);
    const tier = this.preferredTier();
    const toolRegistry = ctx.toolRegistry;
    const toolContext = ctx.toolContext;
    const hasTools = !!(toolRegistry && toolContext && toolRegistry.size > 0);
    const toolDefs = hasTools ? toolRegistry!.getDefinitions() : undefined;

    const MAX_TOOL_ROUNDS = 3;
    let currentMessages = initialMessages;
    let totalTokenInput = 0;
    let totalTokenOutput = 0;
    let totalLatency = 0;
    let lastResult: GatewayResponse | null = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await this.gateway.route({
        shopId: ctx.shopId,
        sessionId: ctx.sessionId,
        messages: currentMessages,
        productId: ctx.productId,
        scenario: ctx.scenario,
        preferredTier: tier,
        platformOverrides: ctx.platformOverrides,
        tools: toolDefs,
        tool_choice: hasTools ? 'auto' : undefined,
      });

      totalTokenInput += result.tokenInput;
      totalTokenOutput += result.tokenOutput;
      totalLatency += result.latencyMs;
      lastResult = result;

      // 无 tool_calls 或未启用 function calling，返回最终结果
      if (!result.toolCalls || result.toolCalls.length === 0 || !hasTools) {
        return this.toAgentResult(result, totalTokenInput, totalTokenOutput, totalLatency);
      }

      // 执行工具调用（ToolRegistry 内部 try/catch 包裹，失败返回错误信息而非抛错）
      const toolResults = await toolRegistry!.execute(result.toolCalls, toolContext!);

      // 把 assistant 的 tool_calls 消息 + tool 结果消息追加到 messages，进入下一轮
      currentMessages = [
        ...currentMessages,
        {
          role: 'assistant' as const,
          content: result.content || '',
          tool_calls: result.toolCalls,
        },
        ...toolResults.map((tr) => ({
          role: 'tool' as const,
          content: tr.content,
          tool_call_id: tr.tool_call_id,
        })),
      ];

      this.logger.debug(
        { agentId: this.agentId, round, toolCalls: result.toolCalls.length },
        'Function calling 工具执行完成，进入下一轮',
      );
    }

    // 达到 MAX_TOOL_ROUNDS 上限，返回最后一次结果
    this.logger.warn(
      { agentId: this.agentId, rounds: MAX_TOOL_ROUNDS },
      'Function calling 达到最大轮数限制，返回当前结果',
    );
    return this.toAgentResult(lastResult!, totalTokenInput, totalTokenOutput, totalLatency);
  }

  /** 把 GatewayResponse 转为 AgentResult，累加多轮 token 消耗与总延迟 */
  private toAgentResult(
    result: GatewayResponse,
    totalTokenInput: number,
    totalTokenOutput: number,
    totalLatency: number,
  ): AgentResult {
    return {
      content: result.content,
      agentId: this.agentId,
      model: result.model,
      tokenInput: totalTokenInput,
      tokenOutput: totalTokenOutput,
      // 多轮工具调用的总耗时（原实现只取最后一轮，监控数据失真）
      latencyMs: totalLatency > 0 ? totalLatency : result.latencyMs,
      confidence: result.confidence,
      truncated: result.truncated,
      cached: result.cached,
      cascadeChain: result.cascadeChain,
    };
  }

  protected abstract buildMessages(ctx: AgentContext): ChatMessage[];

  protected abstract preferredTier(): ModelTier;

  protected getSystemPrompt(): string {
    return '';
  }
}
