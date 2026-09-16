/**
 * 预定义对话场景
 *
 * 当前内置 2 个场景：
 * 1. 售前尺码推荐：身高 / 体重 / 偏好（修身/宽松）
 * 2. 退货退款工单：订单号 / 退货原因
 */
import type { DialogScenario } from './types';

export const DIALOG_SCENARIOS: DialogScenario[] = [
  {
    id: 'size_recommendation',
    name: '尺码推荐',
    triggerKeywords: ['尺码', '多大', '尺寸', '合适', '穿多大', '多大码', '推荐码数'],
    slots: [
      {
        name: 'height',
        description: '客户身高（cm）',
        required: true,
        extractor: {
          regex: [
            /(\d{2,3})\s*cm/i,
            /身高\s*[:：]?\s*(\d{2,3})/,
            /(\d{2,3})\s*厘米/,
            /高\s*[:：]?\s*(\d{2,3})/,
            // 仅纯数字消息（如"180"）兜底提取，避免"我今年38""穿38码"误提取
            /^(\d{2,3})\s*$/,
          ],
        },
        validate: (v) => {
          const n = parseInt(v, 10);
          return n >= 100 && n <= 250;
        },
        clarifyQuestion: '请问您的身高是多少厘米？',
        maxClarifyAttempts: 2,
      },
      {
        name: 'weight',
        description: '客户体重（kg）',
        required: true,
        extractor: {
          regex: [
            /(\d{2,3})\s*kg/i,
            /体重\s*[:：]?\s*(\d{2,3})/,
            /(\d{2,3})\s*公斤/,
            /(\d{2,3})\s*斤/,
            /重\s*[:：]?\s*(\d{2,3})/,
          ],
        },
        validate: (v) => {
          const n = parseInt(v, 10);
          return n >= 30 && n <= 200;
        },
        clarifyQuestion: '请问您的体重是多少公斤？',
        maxClarifyAttempts: 2,
      },
      {
        name: 'preference',
        description: '穿衣偏好（修身/宽松）',
        required: false,
        extractor: {
          regex: [/修身/, /宽松/, /合身/, /休闲/],
        },
        clarifyQuestion: '您喜欢修身还是宽松的版型？（可选，不填可直接回复"无"）',
        maxClarifyAttempts: 1,
      },
    ],
    completionPrompt:
      '客户已提供身高 {height}cm、体重 {weight}kg、穿衣偏好 {preference}，' +
      '请基于商品信息推荐合适尺码并说明推荐理由（参考尺码表与体型匹配）。',
    maxTurns: 6,
    expiryMs: 5 * 60 * 1000,
    cancelKeywords: ['算了', '不买了', '取消', '不用了', '结束'],
    closingHint: '尺码推荐完成，是否还有其他问题需要咨询？',
  },
  {
    id: 'refund_ticket',
    name: '退货退款工单',
    triggerKeywords: ['退货', '退款', '退换', '不想要了', '质量问题', '坏了', '退钱'],
    slots: [
      {
        name: 'order_id',
        description: '订单号',
        required: true,
        extractor: {
          regex: [
            /订单号?\s*[:：]?\s*([A-Za-z0-9]{6,32})/,
            /单号\s*[:：]?\s*([A-Za-z0-9]{6,32})/,
            /\b(\d{15,22})\b/,
          ],
        },
        validate: (v) => v.length >= 6 && v.length <= 32,
        clarifyQuestion: '请提供您的订单号（在"我的订单"页面可查看，格式如 1234567890123456）',
        maxClarifyAttempts: 2,
      },
      {
        name: 'reason',
        description: '退货原因',
        required: true,
        extractor: {
          llmPrompt: '从用户消息中提取退货原因，输出简洁关键词（如：质量问题/不喜欢/尺码不合/与描述不符），不超过 20 字。',
        },
        validate: (v) => v.trim().length > 0 && v.length <= 100,
        clarifyQuestion: '请问您退货的具体原因是什么？（如：质量问题、不喜欢、尺码不合、与描述不符等）',
        maxClarifyAttempts: 2,
      },
    ],
    completionPrompt:
      '客户发起退货工单：订单号 {order_id}，原因：{reason}。' +
      '请引导客户完成退货流程：1) 说明退货申请路径；2) 告知退货时效与所需凭证；3) 提醒包装与物流注意事项。',
    maxTurns: 6,
    expiryMs: 10 * 60 * 1000,
    cancelKeywords: ['算了', '不退了', '取消', '不用了'],
    closingHint: '退货工单已记录，是否还有其他问题？',
  },
];
