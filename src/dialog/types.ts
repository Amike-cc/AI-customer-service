/**
 * 多轮对话状态机类型定义
 *
 * 槽位填充机制：通过多轮交互收集信息，信息齐全后批量调用 LLM 生成完整回复。
 */

/**
 * 槽位提取器
 * - regex: 优先正则提取（成本低、确定性强）
 * - llmPrompt: 正则未匹配时回退到 LLM 提取（覆盖自然语言变体）
 */
export interface SlotExtractor {
  /** 正则数组（按顺序尝试，第一个匹配成功即返回捕获组） */
  regex?: RegExp[];
  /** LLM 兜底提取提示词 */
  llmPrompt?: string;
}

/**
 * 槽位定义
 */
export interface SlotDefinition {
  /** 槽位名称，如 'height' */
  name: string;
  /** 描述，如 '客户身高（cm）' */
  description: string;
  /** 是否必填（true：未填则继续询问；false：可选，跳过即可） */
  required: boolean;
  /** 提取器 */
  extractor: SlotExtractor;
  /** 值校验函数（返回 false 时视为无效，继续询问） */
  validate?: (value: string) => boolean;
  /** 澄清问题，如 "请问您的身高是多少厘米？" */
  clarifyQuestion: string;
  /** 最大澄清次数（超过则放弃该槽位，必填槽位将结束对话） */
  maxClarifyAttempts: number;
}

/**
 * 对话场景定义
 */
export interface DialogScenario {
  /** 场景 ID，如 'size_recommendation' */
  id: string;
  /** 场景名称，如 '尺码推荐' */
  name: string;
  /** 触发关键词列表（任一命中即触发场景） */
  triggerKeywords: string[];
  /** 触发意图（可选，与关键词为或关系） */
  triggerIntent?: string;
  /** 槽位列表（按顺序填充） */
  slots: SlotDefinition[];
  /** 槽位填满后注入到 LLM 的系统提示词，支持 {slotName} 占位符 */
  completionPrompt: string;
  /** 最大轮次限制 */
  maxTurns: number;
  /** 无消息超时（毫秒） */
  expiryMs: number;
  /** 用户主动中断的关键词（如 "算了"、"不买了"） */
  cancelKeywords?: string[];
  /** 对话完成后的结束语（注入到回复末尾） */
  closingHint?: string;
}

/**
 * 对话状态中的槽位值
 */
export interface SlotState {
  /** 提取到的值，未填为 null */
  value: string | null;
  /** 已询问次数 */
  clarifyCount: number;
  /** 填充时间戳 */
  filledAt: number | null;
}

/**
 * 对话状态
 */
export interface DialogState {
  shopId: string;
  sessionId: string;
  scenarioId: string;
  /** 槽位状态：name -> SlotState */
  slots: Record<string, SlotState>;
  /** 当前需要填充的槽位名（null 表示对话已结束） */
  currentSlot: string | null;
  /** 对话开始时间 */
  startedAt: number;
  /** 最后交互时间 */
  lastInteractionAt: number;
  /** 已进行的轮次数 */
  turnCount: number;
  /** 是否已完成（所有必填槽位填充） */
  completed: boolean;
  /** 是否被取消 */
  cancelled: boolean;
}
