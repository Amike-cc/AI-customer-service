/**
 * 工具注册中心
 *
 * 职责：
 *   1. register(tool)：注册工具
 *   2. getDefinitions()：返回所有工具定义（传给 LLM 的 tools 参数）
 *   3. execute(toolCalls, ctx)：批量执行工具调用，返回结果
 *
 * 设计原则：
 *   - 单例（在 backend.ts 中创建一次，注入 Orchestrator/Agent）
 *   - Tool 本身无状态，状态通过 ToolContext 传入
 *   - 执行失败不抛错，返回错误信息让 LLM 自己降级
 */
import type { Tool, ToolCall, ToolContext, ToolDefinition, ToolResult } from './types';

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  /** 注册工具 */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  /** 获取所有工具定义（传给 LLM 的 tools 参数） */
  getDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const tool of this.tools.values()) {
      defs.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      });
    }
    return defs;
  }

  /**
   * 批量执行工具调用
   * - 工具不存在：返回错误信息
   * - 执行失败：返回错误信息（不抛错）
   * - 参数解析失败：返回错误信息
   */
  async execute(toolCalls: ToolCall[], ctx: ToolContext): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of toolCalls) {
      const tool = this.tools.get(call.function.name);
      if (!tool) {
        results.push({
          tool_call_id: call.id,
          role: 'tool',
          content: `错误：未找到工具 "${call.function.name}"`,
        });
        continue;
      }

      let args: Record<string, unknown>;
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch (err) {
        results.push({
          tool_call_id: call.id,
          role: 'tool',
          content: `错误：参数 JSON 解析失败 - ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      try {
        const content = await tool.execute(args, ctx);
        results.push({
          tool_call_id: call.id,
          role: 'tool',
          content,
        });
      } catch (err) {
        results.push({
          tool_call_id: call.id,
          role: 'tool',
          content: `错误：工具执行失败 - ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return results;
  }

  /** 已注册工具数量 */
  get size(): number {
    return this.tools.size;
  }
}
