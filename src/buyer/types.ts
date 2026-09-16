/**
 * 跨会话买家记忆 — 类型定义
 *
 * 让 AI 像真人客服一样"认得"老顾客：聚合每个买家的历史咨询/投诉/转化/偏好，
 * 注入 prompt 让回复时自然引用历史交互。
 */
import type { Database } from '../db/Database';
import type { AppLogger } from '../logging/logger';
import type { Config } from '../config/schema';

/** BuyerProfileService 构造参数 */
export interface BuyerServiceConfig {
  db: Database;
  logger: AppLogger;
  /** buyer 配置段（来自 config.buyer） */
  config: Config['buyer'];
}

/** buildBuyerContext 返回结果（保留扩展能力，当前主流程只用 text 字段） */
export interface BuyerContextResult {
  /** 注入 prompt 的画像字符串（空字符串表示新客不注入） */
  text: string;
  /** 是否命中缓存 */
  cached: boolean;
  /** 画像版本号 */
  profileVersion: number;
}
