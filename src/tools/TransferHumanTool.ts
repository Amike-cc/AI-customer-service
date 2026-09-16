/**
 * 转人工客服工具
 *
 * 当 AI 判断需要人工介入时调用（如复杂售后、情绪激动的买家、AI 无法回答的问题）。
 * 通过 ToolContext.onTransferHuman 回调通知 ShopSupervisor 触发转人工流程。
 *
 * 智能路由到指定专员：
 *   AI 可通过 agent_role 参数指定目标专员角色（售后/物流/售前/通用），
 *   ShopSupervisor 查店铺配置的 agentMappings 得到飞鸽客服账号名，
 *   再由 WebviewClient 在飞鸽页面执行自动转接操作。
 *
 * 注意：调用此工具后，AI 应继续生成回复告知买家"正在为您转接XX专员"，
 * 真正的转人工动作由 ShopSupervisor 异步触发。
 */
import type { Tool, AgentRole } from './types';
import { AGENT_ROLE_NAMES } from './types';

// 会话级转人工幂等：LLM 工具循环最多 3 轮，可能反复调用 transfer_to_human，
// 同一会话 5 分钟内只触发一次真实转接，避免重复升级记录/重复转接操作
const transferDedup = new Map<string, number>();
const TRANSFER_DEDUP_MS = 5 * 60 * 1000;

export const TransferHumanTool: Tool = {
  name: 'transfer_to_human',
  description:
    '转接人工客服。当遇到以下情况时调用：1) 复杂售后问题（退货纠纷、投诉）；2) 买家情绪激动或明确要求人工；3) AI 无法回答的问题；4) 涉及金额争议。可指定目标专员角色（agent_role），系统会自动在飞鸽页面操作转接到对应客服账号。调用后仍需生成回复告知买家正在转接。',
  parameters: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: '转人工原因（简短描述，如"买家投诉商品质量问题"、"涉及退款金额争议"）',
      },
      urgency: {
        type: 'string',
        description: '紧急程度',
        enum: ['low', 'medium', 'high'],
      },
      agent_role: {
        type: 'string',
        description:
          '目标专员角色（不传则转给通用客服）。after_sales=售后专员（退货/退款/质量/投诉）；logistics=物流专员（快递/发货/地址）；pre_sales=售前专员（商品咨询/尺码/活动）；general=通用客服（其他复杂问题）',
        enum: ['after_sales', 'logistics', 'pre_sales', 'general'],
      },
    },
    required: ['reason'],
  },

  async execute(args, ctx) {
    // 截断 LLM 输出的异常长文本，避免污染转人工回调与日志
    const reason = String(args.reason ?? 'AI 判断需要人工介入').trim().slice(0, 200);
    const urgency = String(args.urgency ?? 'medium').trim().slice(0, 20);
    const agentRole = (args.agent_role as AgentRole | undefined) ?? 'general';

    // 会话级幂等：同一会话短时间内重复调用不再触发真实转接
    const dedupKey = `${ctx.shopId}|${ctx.sessionId}`;
    const now = Date.now();
    // 惰性清理过期条目，避免 Map 无界增长
    if (transferDedup.size > 500) {
      for (const [k, ts] of transferDedup) {
        if (now - ts >= TRANSFER_DEDUP_MS) transferDedup.delete(k);
      }
    }
    if (transferDedup.has(dedupKey)) {
      return '该会话已在转人工流程中（短时间内不重复转接）。请告知买家"已为您转接人工客服，请稍候"。';
    }
    transferDedup.set(dedupKey, now);

    // 触发转人工回调（ShopSupervisor 内部处理实际转接逻辑）
    try {
      ctx.onTransferHuman(`[${urgency}] ${reason}`, agentRole);
    } catch (err) {
      // 回调失败不影响 LLM 流程，返回错误信息让 LLM 降级
      return `转人工触发失败：${err instanceof Error ? err.message : String(err)}。请直接告知买家联系客服热线。`;
    }

    const roleName = AGENT_ROLE_NAMES[agentRole];
    // 返回给 LLM 的确认信息（LLM 会基于此生成最终回复）
    return [
      '已触发转人工流程，原因：' + reason,
      '紧急程度：' + urgency,
      '目标专员：' + roleName + '（系统会自动在飞鸽页面执行转接操作）',
      '请生成回复告知买家：',
      '1) 已为您转接' + roleName + '，请稍候片刻',
      '2) 如紧急可拨打客服热线',
    ].join('\n');
  },
};
