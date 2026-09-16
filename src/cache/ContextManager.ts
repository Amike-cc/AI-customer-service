/**
 * 对话上下文管理器
 * 详见 docs/17-数据持久化与配置管理.md §17.4.1
 * 详见 docs/21-进程模型与运行细节.md §21.5
 */
import type { AppLogger } from '../logging/logger';
import type { Database } from '../db/Database';
import type { Config } from '../config/schema';
import type { ConversationMessage } from '../db/repos/ConversationContextRepo';

export interface ContextMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  productId?: string;
}

export class ContextManager {
  private clearTimers = new Map<string, NodeJS.Timeout>();
  private hotContextCache = new Map<string, { messages: ConversationMessage[]; expireAt: number }>();
  /** 关闭标志：clearAllTimers（进程退出）后置 true，防止已关闭的 db 被写操作抛 uncaughtException */
  private closed = false;
  private static readonly HOT_CACHE_TTL_MS = 300_000; // 5 分钟

  constructor(
    private config: Config,
    private db: Database,
    private logger: AppLogger,
  ) {}

  /** 收到消息时调用，重置 5 分钟空闲计时器 */
  onMessage(shopId: string, sessionId: string): void {
    const key = `${shopId}:${sessionId}`;
    const existing = this.clearTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(
      () => {
        if (this.closed) return;
        try {
          this.clearContext(shopId, sessionId, 'idle_5min');
        } catch (err) {
          this.logger?.debug({ shopId, sessionId, err }, 'idle 清空上下文失败（可能数据库已关闭）');
        }
        this.clearTimers.delete(key);
      },
      this.config.deepseek.context_idle_clear_ms,
    );
    timer.unref?.();
    this.clearTimers.set(key, timer);

    if (!this.closed) {
      try {
        this.db.shopState.updateLastMessageAt(shopId, Date.now());
      } catch (err) {
        this.logger?.debug({ shopId, sessionId, err }, '更新最后消息时间失败（可能数据库已关闭）');
      }
    }
  }

  /** 添加用户消息到上下文 */
  addUserMessage(shopId: string, sessionId: string, content: string, productId?: string): void {
    this.db.conversation.add({
      shopId,
      sessionId,
      role: 'user',
      content,
      productId,
    });
    this.invalidateHotCache(shopId, sessionId);
    this.onMessage(shopId, sessionId);
  }

  /** 添加 AI 回复到上下文 */
  addAssistantMessage(
    shopId: string,
    sessionId: string,
    content: string,
    tokenCount?: number,
    productId?: string,
  ): void {
    this.db.conversation.add({
      shopId,
      sessionId,
      role: 'assistant',
      content,
      productId,
      tokenCount,
    });
    this.invalidateHotCache(shopId, sessionId);
  }

  /** 获取最近 N 轮上下文（用于 DeepSeek API 调用） */
  getRecentMessages(shopId: string, sessionId: string): ConversationMessage[] {
    return this.db.conversation.getRecent(
      shopId,
      sessionId,
      this.config.deepseek.context_rounds,
    );
  }

  /** 估算文本的 token 数（中文约 2 字符/token，英文约 4 字符/token，混合取 2.5） */
  static estimateTokens(text: string): number {
    return Math.ceil(text.length / 2);
  }

  /** 获取最近上下文，限制总 token 数不超过 maxTokens（从最新向前截断） */
  getRecentMessagesWithTokenLimit(
    shopId: string,
    sessionId: string,
    maxTokens: number,
  ): ConversationMessage[] {
    const cacheKey = `${shopId}:${sessionId}`;
    const now = Date.now();
    const cached = this.hotContextCache.get(cacheKey);
    let allMessages: ConversationMessage[];
    if (cached && cached.expireAt > now) {
      allMessages = cached.messages;
    } else {
      const fetchLimit = this.config.deepseek.context_rounds * 4;
      allMessages = this.db.conversation.getRecent(shopId, sessionId, fetchLimit);
      this.hotContextCache.set(cacheKey, {
        messages: allMessages,
        expireAt: now + ContextManager.HOT_CACHE_TTL_MS,
      });
      // 惰性清理：超过 2000 条时删除全部过期条目，防止热缓存无界增长
      if (this.hotContextCache.size > 2000) {
        for (const [k, v] of this.hotContextCache) {
          if (v.expireAt <= now) this.hotContextCache.delete(k);
        }
      }
    }
    let totalTokens = 0;
    const selected: ConversationMessage[] = [];
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const msgTokens = ContextManager.estimateTokens(allMessages[i].content);
      if (totalTokens + msgTokens > maxTokens) break;
      selected.unshift(allMessages[i]);
      totalTokens += msgTokens;
    }
    if (selected.length < allMessages.length) {
      this.logger.debug(
        { shopId, sessionId, truncated: allMessages.length - selected.length, totalTokens },
        '上下文因 token 限制被截断',
      );
    }
    return selected;
  }

  /** 使热会话缓存失效 */
  private invalidateHotCache(shopId: string, sessionId: string): void {
    this.hotContextCache.delete(`${shopId}:${sessionId}`);
  }

  /** 手动清空上下文 */
  clearContext(shopId: string, sessionId: string, reason: string = 'manual'): void {
    const deleted = this.db.conversation.clear(shopId, sessionId, reason);
    if (deleted > 0) {
      this.logger.debug({ shopId, sessionId, deleted, reason }, '上下文已清空');
    }
    this.invalidateHotCache(shopId, sessionId);
  }

  /** 移除最后一条匹配内容的用户消息（消息撤回时调用） */
  removeLastUserMessage(shopId: string, sessionId: string, content: string): boolean {
    const deleted = this.db.conversation.removeLastUserMessage(shopId, sessionId, content);
    if (deleted > 0) {
      this.logger.debug({ shopId, sessionId, content: content.substring(0, 50) }, '撤回消息已从上下文移除');
      this.invalidateHotCache(shopId, sessionId);
      return true;
    }
    return false;
  }

  /** 人工接管时不清空上下文，但停止计时器 */
  pauseTimer(shopId: string, sessionId: string): void {
    const key = `${shopId}:${sessionId}`;
    const timer = this.clearTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.clearTimers.delete(key);
    }
  }

  /** 清理所有计时器（进程关闭时） */
  clearAllTimers(): void {
    this.closed = true;
    for (const timer of this.clearTimers.values()) {
      clearTimeout(timer);
    }
    this.clearTimers.clear();
    this.hotContextCache.clear();
  }

  /** 定期清理过期上下文（建议每小时执行一次） */
  cleanupIdle(): number {
    return this.db.conversation.cleanupIdle(this.config.deepseek.context_idle_clear_ms);
  }

  /** 推断对话阶段 */
  inferPhase(history: ConversationMessage[]): import('../intent/types').ConversationPhase {
    if (history.length === 0) return 'gathering';

    const userMessages = history.filter((m) => m.role === 'user');
    const assistantMessages = history.filter((m) => m.role === 'assistant');
    const lastUserMsg = userMessages[userMessages.length - 1]?.content ?? '';
    const lastAssistantMsg = assistantMessages[assistantMessages.length - 1]?.content ?? '';

    if (/谢谢|感谢|辛苦|再见|拜拜|好的谢谢/.test(lastUserMsg)) return 'closing';
    if (/好的|同意|确认|可以|行|没问题|就这样|下单了|拍了|付款了/.test(lastUserMsg)) return 'confirming';
    if (/建议|可以|为您|推荐|提供|方案|试试|参考|亲可以/.test(lastAssistantMsg)) return 'proposing';
    if (userMessages.length >= 2) return 'diagnosing';
    return 'gathering';
  }

  /** 生成上下文摘要（规则提取，不用 LLM） */
  summarizeContext(history: ConversationMessage[]): string {
    const userMessages = history.filter((m) => m.role === 'user');
    const assistantMessages = history.filter((m) => m.role === 'assistant');

    const parts: string[] = [];
    const recentUser = userMessages.slice(-2);
    if (recentUser.length > 0) {
      const userText = recentUser.map((m) => m.content.slice(0, 50)).join('；');
      parts.push(`买家询问：${userText}`);
    }
    const recentAssistant = assistantMessages.slice(-1);
    if (recentAssistant.length > 0) {
      const assistantText = recentAssistant[0].content.slice(0, 80);
      parts.push(`客服回复：${assistantText}`);
    }
    const summary = parts.join('。');
    return summary.length > 200 ? summary.slice(0, 200) : summary;
  }
}
