/**
 * 多轮对话状态机管理器
 *
 * 职责：
 * 1. 检测消息是否触发对话场景
 * 2. 维护对话状态（槽位填充进度）
 * 3. 处理每一轮交互：提取槽位 → 返回澄清问题 → 槽位填满时返回完成信号
 * 4. 清理超时对话
 *
 * 使用方式（由 ShopSupervisor.generateReply 集成）：
 *   const activeDialog = manager.getActiveDialog(shopId, sessionId);
 *   if (activeDialog) {
 *     const result = await manager.processTurn(shopId, sessionId, message);
 *     if (result.completed) {
 *       // 调用 LLM 生成完整回复
 *     } else {
 *       // 返回 result.reply（澄清问题）
 *     }
 *   } else {
 *     const scenario = manager.detectScenario(message);
 *     if (scenario) {
 *       manager.startDialog(shopId, sessionId, scenario);
 *       // 返回第一个槽位的 clarifyQuestion
 *     }
 *   }
 */
import type { AppLogger } from '../logging/logger';
import type { Database } from '../db/Database';
import type { ModelGateway } from '../gateway/ModelGateway';
import type {
  DialogScenario,
  DialogState,
  SlotDefinition,
  SlotState,
} from './types';
import { DIALOG_SCENARIOS } from './scenarios';

export interface ProcessTurnResult {
  /** 返回给用户的回复（澄清问题 或 完成提示） */
  reply: string;
  /** 是否所有必填槽位已填满，可以调用 LLM 生成完整回复 */
  completed: boolean;
  /** 是否被用户主动取消 */
  cancelled: boolean;
  /** 更新后的对话状态 */
  state: DialogState;
  /** 完成时的 prompt 模板（已替换槽位占位符） */
  completionPrompt?: string;
}

export class DialogStateManager {
  /** 内置场景列表（运行时可扩展） */
  private scenarios: DialogScenario[];
  /** 跳过 LLM 兜底提取（用于测试与降级） */
  private skipLlmExtraction: boolean;

  constructor(
    private db: Database,
    scenarios: DialogScenario[] = DIALOG_SCENARIOS,
    private gateway: ModelGateway | null = null,
    private logger: AppLogger,
  ) {
    this.scenarios = scenarios;
    this.skipLlmExtraction = !gateway;
  }

  /**
   * 检测消息是否触发对话场景。
   * 触发条件：消息包含任一场景的 triggerKeywords 或匹配 triggerIntent。
   */
  detectScenario(message: string, intent?: string): DialogScenario | null {
    if (!message || message.trim().length === 0) return null;
    const text = message.toLowerCase();
    for (const scenario of this.scenarios) {
      // 意图匹配（优先）
      if (intent && scenario.triggerIntent && scenario.triggerIntent === intent) {
        return scenario;
      }
      // 关键词匹配
      for (const kw of scenario.triggerKeywords) {
        if (text.includes(kw.toLowerCase())) {
          return scenario;
        }
      }
    }
    return null;
  }

  /** 获取指定会话的活跃对话状态 */
  getActiveDialog(shopId: string, sessionId: string): DialogState | null {
    const state = this.db.dialogState.get(shopId, sessionId);
    if (!state) return null;
    if (state.completed || state.cancelled) return null;
    // 超时检查（用实例场景索引，支持构造函数注入的自定义场景）
    const scenario = this.scenarios.find((s) => s.id === state.scenarioId);
    if (scenario && Date.now() - state.lastInteractionAt > scenario.expiryMs) {
      this.logger.info(
        { shopId, sessionId, scenarioId: state.scenarioId, expiredMs: Date.now() - state.lastInteractionAt },
        '对话状态超时，自动结束',
      );
      this.db.dialogState.delete(shopId, sessionId);
      return null;
    }
    return state;
  }

  /** 进入新对话场景 */
  startDialog(shopId: string, sessionId: string, scenario: DialogScenario): DialogState {
    // 若已有活跃对话，先结束（同会话不能并发多个对话）
    const existing = this.db.dialogState.get(shopId, sessionId);
    if (existing) {
      this.logger.warn(
        { shopId, sessionId, oldScenario: existing.scenarioId, newScenario: scenario.id },
        '会话已有活跃对话，强制结束后再启动新对话',
      );
      this.db.dialogState.delete(shopId, sessionId);
    }
    const now = Date.now();
    const slots: Record<string, SlotState> = {};
    for (const slot of scenario.slots) {
      slots[slot.name] = {
        value: null,
        clarifyCount: 0,
        filledAt: null,
      };
    }
    const state: DialogState = {
      shopId,
      sessionId,
      scenarioId: scenario.id,
      slots,
      currentSlot: scenario.slots.length > 0 ? scenario.slots[0].name : null,
      startedAt: now,
      lastInteractionAt: now,
      turnCount: 0,
      completed: false,
      cancelled: false,
    };
    this.db.dialogState.upsert(state);
    this.logger.info(
      { shopId, sessionId, scenarioId: scenario.id },
      '对话场景已启动',
    );
    return state;
  }

  /**
   * 处理当前对话轮次。
   *
   * @returns ProcessTurnResult
   */
  async processTurn(
    shopId: string,
    sessionId: string,
    message: string,
  ): Promise<ProcessTurnResult> {
    const state = this.db.dialogState.get(shopId, sessionId);
    if (!state) {
      throw new Error(`对话状态不存在: shopId=${shopId}, sessionId=${sessionId}`);
    }
    const scenario = this.scenarios.find((s) => s.id === state.scenarioId);
    if (!scenario) {
      throw new Error(`未知场景 ID: ${state.scenarioId}`);
    }

    // 更新基础状态
    state.lastInteractionAt = Date.now();
    state.turnCount += 1;

    // 检查用户取消
    if (this.isCancelMessage(message, scenario)) {
      state.cancelled = true;
      state.currentSlot = null;
      this.db.dialogState.upsert(state);
      this.logger.info(
        { shopId, sessionId, scenarioId: scenario.id, turnCount: state.turnCount },
        '对话被用户主动取消',
      );
      return {
        reply: '好的，已为您取消。如果还有其他问题，随时告诉我~',
        completed: false,
        cancelled: true,
        state,
      };
    }

    // 检查轮次上限
    if (state.turnCount > scenario.maxTurns) {
      this.logger.warn(
        { shopId, sessionId, scenarioId: scenario.id, turnCount: state.turnCount, maxTurns: scenario.maxTurns },
        '对话超过最大轮次，强制结束',
      );
      state.cancelled = true;
      state.currentSlot = null;
      this.db.dialogState.upsert(state);
      return {
        reply: '抱歉，对话轮次较多，建议转人工客服为您进一步处理~',
        completed: false,
        cancelled: true,
        state,
      };
    }

    // 提取当前槽位
    if (state.currentSlot) {
      const slot = scenario.slots.find((s) => s.name === state.currentSlot);
      if (slot) {
        // 可选槽支持"无/不需要/随便"等回复跳过（clarifyQuestion 中已提示）
        const skipReply = /^(无|没有|不需要|不用了|随便|都可以|跳过|算了吧)$/i.test(message.trim());
        if (skipReply && !slot.required) {
          const prevCount = state.slots[slot.name]?.clarifyCount ?? 0;
          state.slots[slot.name] = {
            value: '无',
            clarifyCount: prevCount,
            filledAt: Date.now(),
          };
          this.logger.debug(
            { shopId, sessionId, slot: slot.name },
            '可选槽位已跳过（用户回复"无"）',
          );
        } else {
          const extracted = await this.extractSlotValue(slot, message, state);
          if (extracted !== null) {
            // 校验
            const valid = !slot.validate || slot.validate(extracted);
            if (valid) {
              state.slots[slot.name] = {
                value: extracted,
                clarifyCount: state.slots[slot.name]?.clarifyCount ?? 0,
                filledAt: Date.now(),
              };
              this.logger.debug(
                { shopId, sessionId, slot: slot.name, value: extracted },
                '槽位填充成功',
              );
            } else {
              // 防御：旧版本/手工改库导致槽位状态未初始化
              state.slots[slot.name] = state.slots[slot.name] ?? {
                value: null,
                clarifyCount: 0,
                filledAt: null,
              };
              state.slots[slot.name].clarifyCount += 1;
              this.logger.debug(
                { shopId, sessionId, slot: slot.name, value: extracted },
                '槽位值校验失败',
              );
            }
          } else {
            state.slots[slot.name] = state.slots[slot.name] ?? {
              value: null,
              clarifyCount: 0,
              filledAt: null,
            };
            state.slots[slot.name].clarifyCount += 1;
            this.logger.debug(
              { shopId, sessionId, slot: slot.name },
              '槽位提取失败',
            );
          }
        }
      }
    }

    // 推进到下一个未填充的必填槽位
    const nextSlot = this.findNextRequiredSlot(scenario, state);
    if (nextSlot) {
      state.currentSlot = nextSlot.name;
      this.db.dialogState.upsert(state);

      // 检查是否超过澄清上限
      const slotState = state.slots[nextSlot.name];
      if (slotState && slotState.clarifyCount >= nextSlot.maxClarifyAttempts) {
        this.logger.warn(
          { shopId, sessionId, slot: nextSlot.name, attempts: slotState.clarifyCount },
          '槽位澄清次数超限，结束对话',
        );
        state.cancelled = true;
        state.currentSlot = null;
        this.db.dialogState.upsert(state);
        return {
          reply: `抱歉，多次未能获取您的${nextSlot.description}，建议转人工客服为您处理~`,
          completed: false,
          cancelled: true,
          state,
        };
      }

      return {
        reply: nextSlot.clarifyQuestion,
        completed: false,
        cancelled: false,
        state,
      };
    }

    // 所有必填槽位已填满，对话完成
    state.completed = true;
    state.currentSlot = null;
    this.db.dialogState.upsert(state);
    this.logger.info(
      { shopId, sessionId, scenarioId: scenario.id, turnCount: state.turnCount },
      '对话场景已完成，可调用 LLM 生成最终回复',
    );

    const completionPrompt = this.fillCompletionPrompt(scenario, state);
    return {
      reply: scenario.closingHint ?? '已为您处理完成，是否还有其他问题？',
      completed: true,
      cancelled: false,
      state,
      completionPrompt,
    };
  }

  /** 强制结束对话 */
  endDialog(shopId: string, sessionId: string): void {
    this.db.dialogState.delete(shopId, sessionId);
  }

  /** 清理超时对话 */
  cleanupExpired(): number {
    const expired = this.db.dialogState.listExpired(Date.now(), 500);
    for (const state of expired) {
      this.db.dialogState.delete(state.shopId, state.sessionId);
    }
    if (expired.length > 0) {
      this.logger.info({ count: expired.length }, '已清理超时对话状态');
    }
    return expired.length;
  }

  /** 获取场景列表（用于诊断） */
  getScenarios(): DialogScenario[] {
    return this.scenarios;
  }

  // ============ 私有辅助方法 ============

  private isCancelMessage(message: string, scenario: DialogScenario): boolean {
    const cancelKeywords = scenario.cancelKeywords ?? ['算了', '取消', '不用了'];
    const text = message.trim().toLowerCase();
    // 长消息中的"取消"多为描述性（如"我已经取消重下了""不退了帮我查物流"），不应判定为取消；
    // 仅短消息（≤12 字）或取消词出现在开头时视为主动取消
    if (text.length > 12) {
      return cancelKeywords.some((kw) => text.startsWith(kw.toLowerCase()));
    }
    return cancelKeywords.some((kw) => text.includes(kw.toLowerCase()));
  }

  /**
   * 查找下一个未填充槽位：必填槽位优先，全部必填完成后推进可选槽位。
   * 原实现只推进必填槽，可选槽（如穿衣偏好）永远不会被询问也不会被提取，
   * 导致 completionPrompt 中的可选变量永远为空。
   */
  private findNextRequiredSlot(
    scenario: DialogScenario,
    state: DialogState,
  ): SlotDefinition | null {
    // 优先未填的必填槽
    for (const slot of scenario.slots) {
      if (!slot.required) continue;
      const slotState = state.slots[slot.name];
      if (!slotState) continue;
      if (slotState.value === null) return slot;
    }
    // 必填全填完，再推进可选槽（clarifyQuestion 已提示可答"无"跳过）
    for (const slot of scenario.slots) {
      if (slot.required) continue;
      const slotState = state.slots[slot.name];
      if (!slotState) continue;
      if (slotState.value === null && slotState.clarifyCount < (slot.maxClarifyAttempts ?? 1)) {
        return slot;
      }
    }
    return null;
  }

  /**
   * 提取槽位值：先正则，失败回退 LLM
   */
  private async extractSlotValue(
    slot: SlotDefinition,
    message: string,
    state: DialogState,
  ): Promise<string | null> {
    // 1. 正则提取
    if (slot.extractor.regex && slot.extractor.regex.length > 0) {
      for (const regex of slot.extractor.regex) {
        const m = regex.exec(message);
        if (m) {
          // 有捕获组优先取捕获组；无捕获组（如 /修身/）用完整匹配
          if (m.length >= 2 && m[1]) return m[1].trim();
          if (m[0]) return m[0].trim();
        }
      }
    }

    // 2. LLM 兜底提取
    if (slot.extractor.llmPrompt && !this.skipLlmExtraction && this.gateway) {
      try {
        const llmReply = await this.extractWithLlm(slot, message, state);
        if (llmReply && llmReply.trim().length > 0) {
          // LLM 提取的结果可能包含解释，截取首行
          const trimmed = llmReply.trim().split('\n')[0].trim();
          if (trimmed && trimmed.length < 200) {
            return trimmed;
          }
        }
      } catch (err) {
        this.logger.warn(
          { err, slot: slot.name, shopId: state.shopId, sessionId: state.sessionId },
          'LLM 槽位提取失败',
        );
      }
    }

    return null;
  }

  private async extractWithLlm(slot: SlotDefinition, message: string, state: DialogState): Promise<string | null> {
    if (!this.gateway) return null;
    const prompt = `${slot.extractor.llmPrompt}\n用户消息：${message}\n请直接输出提取结果，不要其他解释。若无相关内容，输出"NONE"。`;
    try {
      // 走 ModelGateway directRoute 模式（cascade=false）
      // 槽位抽取是轻量调用，maxTokens=100 限制输出，temperature=0 保证稳定
      const result = await this.gateway.route({
        shopId: state.shopId,
        sessionId: state.sessionId,
        messages: [
          { role: 'system', content: '你是一个信息抽取助手，只输出抽取到的关键信息，不要任何解释或前缀。' },
          { role: 'user', content: prompt },
        ],
        preferredTier: 'tier2',
        cascade: false,
        maxTokens: 100,
        temperature: 0,
      });
      const content = result?.content?.trim() ?? '';
      if (content && content.toUpperCase() !== 'NONE' && content !== '无') {
        return content;
      }
    } catch (err) {
      this.logger.debug({ err, slot: slot.name }, 'LLM 抽取调用失败');
    }
    return null;
  }

  private fillCompletionPrompt(scenario: DialogScenario, state: DialogState): string {
    let prompt = scenario.completionPrompt;
    for (const [name, slotState] of Object.entries(state.slots)) {
      const placeholder = new RegExp(`\\{${name}\\}`, 'g');
      prompt = prompt.replace(placeholder, slotState.value ?? '未提供');
    }
    return prompt;
  }
}
