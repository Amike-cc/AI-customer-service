/**
 * Function Calling 工具框架 — 类型定义
 *
 * 让 AI 从"话术机"升级为"能执行业务动作的智能体"。
 * 兼容 OpenAI function calling 格式（DeepSeek API 完全兼容）。
 *
 * 调用流程：
 *   1. BaseAgent.execute() 把 ToolRegistry.getDefinitions() 传给 LLM
 *   2. LLM 返回 tool_calls（要调用的工具名+参数）
 *   3. ToolRegistry.execute() 执行对应工具，返回结果
 *   4. 结果作为 'tool' role 消息回传给 LLM
 *   5. LLM 基于工具结果生成最终回复
 *
 * 安全设计：
 *   - 所有 Tool 只做读取型操作（不修改订单/不发券）
 *   - TransferHumanTool 通过回调通知 ShopSupervisor，由后者触发转人工流程
 *   - 工具执行 try/catch 包裹，失败返回错误信息而非抛错
 */
import type { ProductMatcher } from '../product/ProductMatcher';
import type { Database } from '../db/Database';

/** 专员角色（用于智能路由到指定专员） */
export type AgentRole = 'after_sales' | 'logistics' | 'pre_sales' | 'general';

/** 专员角色中文名（用于 Prompt 和日志显示） */
export const AGENT_ROLE_NAMES: Record<AgentRole, string> = {
  after_sales: '售后专员',
  logistics: '物流专员',
  pre_sales: '售前专员',
  general: '通用客服',
};

/** 专员角色适用场景（用于 PromptBuilder 指导 AI 选择） */
export const AGENT_ROLE_SCENARIOS: Record<AgentRole, string> = {
  after_sales: '退货退款、商品质量问题、损坏补发、投诉纠纷',
  logistics: '快递查询、催发货、改地址、物流异常、签收问题',
  pre_sales: '商品咨询、尺码推荐、活动优惠、库存查询',
  general: '复杂问题、跨类目问题、AI 无法判断的混合问题',
};

/** 工具定义（OpenAI function calling 格式） */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, ToolParameterProperty>;
      required: string[];
    };
  };
}

/** 工具参数属性（JSON Schema 子集） */
export interface ToolParameterProperty {
  type: 'string' | 'number' | 'boolean' | 'array';
  description: string;
  enum?: string[];
  items?: ToolParameterProperty;
}

/** LLM 返回的工具调用请求 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** 参数 JSON 字符串 */
    arguments: string;
  };
}

/** 工具执行结果（作为 'tool' role 消息回传给 LLM） */
export interface ToolResult {
  tool_call_id: string;
  role: 'tool';
  /** 工具返回的内容（字符串） */
  content: string;
}

/** 工具执行上下文（由 ShopSupervisor 在 generateReply 中构造） */
export interface ToolContext {
  shopId: string;
  sessionId: string;
  platform: string;
  /** 商品匹配器（QueryStockTool / QueryProductTool 用） */
  productMatcher: ProductMatcher | null;
  /** 数据库（QueryShopInfoTool 用） */
  db: Database;
  /** 转人工触发回调（TransferHumanTool 用）
   *  reason: 转人工原因
   *  agentRole: 可选，指定目标专员角色（用于智能路由到指定专员） */
  onTransferHuman: (reason: string, agentRole?: AgentRole) => void;
}

/** 工具接口 */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolDefinition['function']['parameters'];
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}
