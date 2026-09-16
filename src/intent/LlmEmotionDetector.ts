/**
 * LLM 增强情绪检测器
 *
 * 使用 LLM 进行语义级情绪识别，比关键词规则匹配更准确：
 * - 理解上下文语义（如反讽"质量也太好了吧"→ angry、隐式表达"算了不买了"→ slightly_upset）
 * - 缓存机制避免重复调用（5分钟 TTL，相同文本命中缓存直接返回）
 * - Fallback 机制：LLM 失败/超时时回退到 RuleEmotionDetector（EmotionDetector）
 * - 超时控制：LLM 调用 3 秒未返回立即 fallback，不阻塞回复生成主流程
 *
 * 改造说明：原直接调用 DeepSeekClient.chat()，现改为 ModelGateway.route()，
 * 让 DeepSeek 故障时能自动 fallback 到其他 provider。走 directRoute 模式（cascade=false）。
 *
 * 情绪等级：neutral / slightly_upset / anxious / angry
 * 优先级：angry > anxious > slightly_upset > neutral
 */
import type { EmotionLevel } from './types';
import type { ChatMessage } from '../deepseek/DeepSeekClient';
import type { GatewayRequest } from '../gateway/types';
import type { ModelGateway } from '../gateway/ModelGateway';
import { EmotionDetector, type IEmotionDetector } from './EmotionDetector';

interface CacheEntry {
  emotion: EmotionLevel;
  expireAt: number;
}

const EMOTION_KEYWORDS: readonly EmotionLevel[] = ['neutral', 'slightly_upset', 'anxious', 'angry'];

const SYSTEM_PROMPT = `你是情绪分析助手。分析买家消息的情绪等级，只返回以下一个词，不输出其他任何内容：
- neutral：情绪平稳，正常咨询
- slightly_upset：略有不满，轻微抱怨
- anxious：焦虑急迫，催促或紧迫感
- angry：愤怒，强烈不满，投诉或差评`;

export class LlmEmotionDetector implements IEmotionDetector {
  private readonly ruleDetector: EmotionDetector;
  private readonly gateway: ModelGateway | null;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;
  private readonly llmTimeoutMs: number;

  constructor(
    ruleDetector?: EmotionDetector,
    gateway?: ModelGateway,
    cacheTtlMs = 300000,
    llmTimeoutMs = 3000,
  ) {
    this.ruleDetector = ruleDetector ?? new EmotionDetector();
    this.gateway = gateway ?? null;
    this.cacheTtlMs = cacheTtlMs;
    this.llmTimeoutMs = llmTimeoutMs;
  }

  async detect(text: string, history: ChatMessage[], shopId?: string): Promise<EmotionLevel> {
    // 无 gateway 或文本太短，直接用规则匹配
    if (!this.gateway || text.trim().length < 2) {
      return this.ruleDetector.detect(text, history);
    }

    // 查缓存（相同文本 + 相同历史命中缓存；key 含历史摘要，避免不同上下文串缓存）
    const cacheKey = this.buildCacheKey(text, history);
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    // 规则匹配结果作为 fallback baseline
    const ruleEmotion = await this.ruleDetector.detect(text, history);

    // LLM 检测（带超时控制）
    try {
      const llmEmotion = await this.detectWithLlm(text, history, cacheKey, shopId);
      if (llmEmotion) {
        this.setCache(cacheKey, llmEmotion);
        return llmEmotion;
      }
    } catch {
      // LLM 失败/超时，静默 fallback 到规则匹配
    }

    this.setCache(cacheKey, ruleEmotion);
    return ruleEmotion;
  }

  /** 缓存 key：文本前 200 字符 + 历史摘要哈希，避免不同上下文的相同文本串缓存 */
  private buildCacheKey(text: string, history: ChatMessage[]): string {
    const textPart = text.trim().substring(0, 200);
    const historyPart = history
      .slice(-3)
      .map((m) => `${m.role}:${m.content.slice(0, 30)}`)
      .join('|');
    let hash = 0;
    for (let i = 0; i < historyPart.length; i++) {
      hash = (hash * 31 + historyPart.charCodeAt(i)) | 0;
    }
    return `${textPart}#h${hash.toString(36)}`;
  }

  /**
   * 调用 LLM 进行情绪检测
   * 使用轻量级调用：maxTokens=10, temperature=0，降低成本和延迟
   * 走 ModelGateway directRoute 模式（cascade=false），单 provider 失败立即回退规则匹配
   */
  private async detectWithLlm(
    text: string,
    history: ChatMessage[],
    cacheKey: string,
    shopId?: string,
  ): Promise<EmotionLevel | null> {
    if (!this.gateway) return null;

    // 取最近 3 条历史消息作为上下文
    const recentHistory = history
      .slice(-3)
      .map((m) => `${m.role === 'user' ? '买家' : '客服'}：${m.content}`)
      .join('\n');
    const userContent = recentHistory
      ? `消息历史：\n${recentHistory}\n\n当前消息：${text}`
      : `买家消息：${text}`;

    const req: GatewayRequest = {
      // 透传真实店铺：此前硬编码 'emotion-detect' 会让店铺级预算/成本统计失效
      shopId: shopId ?? 'emotion-detect',
      sessionId: 'emotion-detect',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      preferredTier: 'tier2',
      cascade: false,
      maxTokens: 10,
      temperature: 0,
    };

    const llmPromise = this.gateway.route(req);

    // 超时后 LLM 请求仍在后台执行（gateway 无 abort 接口），
    // 晚到的结果仅在缓存尚未被写入（本次已回退规则结果）时不覆盖——
    // 避免规则结果与 LLM 结果不一致时下次同文本返回不同情绪
    void llmPromise
      .then((resp) => {
        const emo = this.parseEmotion(resp.content);
        if (emo && !this.hasFreshCache(cacheKey)) this.setCache(cacheKey, emo);
      })
      .catch(() => {
        // 忽略后台结果
      });

    // 带超时控制：LLM 慢于 llmTimeoutMs 时立即 fallback，不阻塞回复生成
    const timeoutPromise = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error('LLM emotion detect timeout')), this.llmTimeoutMs);
      t.unref?.();
    });

    const resp = await Promise.race([llmPromise, timeoutPromise]);
    return this.parseEmotion(resp.content);
  }

  /**
   * 解析 LLM 返回的情绪等级
   * 容错处理：词边界匹配（"not angry"/"情绪不angry" 不误判 angry），不匹配返回 null
   */
  private parseEmotion(content: string): EmotionLevel | null {
    const lower = content.trim().toLowerCase();
    for (const kw of EMOTION_KEYWORDS) {
      const re = new RegExp(`(?:^|[^a-z])${kw}(?:[^a-z]|$)`);
      if (!re.test(lower)) continue;
      // 排除否定前缀："not angry"、"不 angry"、"非 angry"、"无 angry"
      const negRe = new RegExp(`(?:not|no|非|不|无)[^a-z]{0,3}${kw}`);
      if (negRe.test(lower)) continue;
      return kw;
    }
    return null;
  }

  private getCached(key: string): EmotionLevel | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expireAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.emotion;
  }

  /** 缓存中是否存在未过期条目 */
  private hasFreshCache(key: string): boolean {
    const entry = this.cache.get(key);
    return !!entry && Date.now() <= entry.expireAt;
  }

  private setCache(key: string, emotion: EmotionLevel): void {
    this.cache.set(key, { emotion, expireAt: Date.now() + this.cacheTtlMs });
    // 硬上限：超过 1000 条时先清过期项，仍超限则按插入顺序淘汰最旧（Map 保持插入序）
    if (this.cache.size > 1000) {
      const now = Date.now();
      for (const [k, v] of this.cache) {
        if (now > v.expireAt) this.cache.delete(k);
      }
      while (this.cache.size > 1000) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }
  }
}
