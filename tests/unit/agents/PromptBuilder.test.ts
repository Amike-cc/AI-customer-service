/**
 * PromptBuilder 单元测试
 */
import {
  buildSystemPrompt,
  type PromptBuildContext,
  type AgentRole,
} from '@/agents/PromptBuilder';

function makeBaseContext(overrides: Partial<PromptBuildContext> = {}): PromptBuildContext {
  return {
    shopName: '测试店铺',
    platform: '淘宝',
    emotion: 'neutral',
    conversationPhase: 'gathering',
    contextSummary: '客户咨询商品尺码',
    agentRole: 'general',
    ...overrides,
  };
}

describe('PromptBuilder.buildSystemPrompt', () => {
  it('包含角色设定模块（含 shopName 和 platform）', () => {
    const prompt = buildSystemPrompt(makeBaseContext());
    expect(prompt).toContain('【角色设定】');
    expect(prompt).toContain('测试店铺');
    expect(prompt).toContain('淘宝');
  });

  it('包含知识边界模块', () => {
    const prompt = buildSystemPrompt(makeBaseContext());
    expect(prompt).toContain('【知识边界】');
    expect(prompt).toContain('禁止');
  });

  it('包含回复规范模块', () => {
    const prompt = buildSystemPrompt(makeBaseContext());
    expect(prompt).toContain('【回复规范】');
    expect(prompt).toContain('50-200');
  });

  it('包含当前上下文模块（含 conversationPhase 和 contextSummary）', () => {
    const prompt = buildSystemPrompt(
      makeBaseContext({
        conversationPhase: 'proposing',
        contextSummary: '客户已询问价格与发货时间',
      }),
    );
    expect(prompt).toContain('【当前上下文】');
    expect(prompt).toContain('方案提出');
    expect(prompt).toContain('客户已询问价格与发货时间');
  });

  it('angry 情绪时注入共情指令（含"非常抱歉"）', () => {
    const prompt = buildSystemPrompt(makeBaseContext({ emotion: 'angry' }));
    expect(prompt).toContain('非常抱歉');
    expect(prompt).toContain('共情');
  });

  it('anxious 情绪时注入紧迫感回应（含"马上"）', () => {
    const prompt = buildSystemPrompt(makeBaseContext({ emotion: 'anxious' }));
    expect(prompt).toContain('马上');
    expect(prompt).toContain('紧迫');
  });

  it('slightly_upset 情绪时注入安抚语（含"抱歉"）', () => {
    const prompt = buildSystemPrompt(makeBaseContext({ emotion: 'slightly_upset' }));
    expect(prompt).toContain('抱歉');
    expect(prompt).toContain('安抚');
  });

  it('有商品知识时包含商品知识模块', () => {
    const prompt = buildSystemPrompt(
      makeBaseContext({
        productContext: '商品：纯棉T恤，尺码 S/M/L',
        knowledgeContext: '常见问题：尺码偏小一码',
      }),
    );
    expect(prompt).toContain('【商品知识】');
    expect(prompt).toContain('纯棉T恤');
    expect(prompt).toContain('尺码偏小一码');
  });

  it('无商品知识时不包含商品知识模块', () => {
    const prompt = buildSystemPrompt(makeBaseContext());
    expect(prompt).not.toContain('【商品知识】');
  });

  it('包含特殊指令模块', () => {
    const prompt = buildSystemPrompt(
      makeBaseContext({ agentRole: 'after_sales' as AgentRole }),
    );
    expect(prompt).toContain('【特殊指令】');
    expect(prompt).toContain('流程');
  });
});
