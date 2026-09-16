import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  ClipboardList,
  Image as ImageIcon,
  MoreHorizontal,
  Paperclip,
  Send,
  Smile,
  Sparkles,
  Type,
  UserRound,
} from 'lucide-react';
import type { PlatformMessage, ShopListItem } from '../../types/api';
import { getPlatformTheme } from '../../utils/constants';
import { useToast } from '../common/Toast';
import styles from './SessionTimeline.module.css';

interface SessionSummary {
  sessionId: string;
  lastMessageAt: number;
  messageCount: number;
}

interface OrderSnapshotView {
  orderRef?: string;
  summary: string;
  platformUrl?: string | null;
  capturedAt?: number;
}

interface BuyerProfileView {
  buyerName?: string;
  vipLevel?: number;
  tags?: string[];
  remarks?: string | null;
  consultationCount?: number;
  conversionCount?: number;
  lastSeenAt?: number;
}

interface SessionTimelineProps {
  shopId: string;
  shop?: ShopListItem | null;
  autoReply?: boolean;
  onOpenPlatform?: () => void;
  focusSessionId?: string | null;
  showControlPanelButton?: boolean;
  controlPanelOpen?: boolean;
  onToggleControlPanel?: () => void;
}

const PLATFORM_LABELS: Record<string, string> = {
  feige: '抖店',
  pinduoduo: '拼多多',
  kuaishou: '快手小店',
  weixin: '微信小店',
};

function formatTime(timestamp: number) {
  if (!timestamp) return '刚刚';
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function sessionLabel(session: SessionSummary, index: number) {
  return session.sessionId || '买家-' + (index + 1);
}

export function SessionTimeline({
  shopId,
  shop,
  autoReply = true,
  onOpenPlatform,
  focusSessionId,
  showControlPanelButton = false,
  controlPanelOpen = false,
  onToggleControlPanel,
}: SessionTimelineProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<PlatformMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [composerTab, setComposerTab] = useState('快捷回复');
  const [loading, setLoading] = useState(false);
  const [contextPanel, setContextPanel] = useState<'order' | 'buyer' | null>(null);
  const [orderSnapshot, setOrderSnapshot] = useState<OrderSnapshotView | null>(null);
  const [buyerProfile, setBuyerProfile] = useState<BuyerProfileView | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Array<{ id: string; label: string; content: string; meta?: string }>>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const messageIds = useRef(new Set<number>());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const toast = useToast();

  const loadSessions = useCallback(async () => {
    const next = await window.api.conversation.platformSessions(shopId, 50);
    setSessions(next);
    setActiveSessionId((current) =>
      focusSessionId && next.some((item) => item.sessionId === focusSessionId)
        ? focusSessionId
        : current && next.some((item) => item.sessionId === current)
          ? current
          : (next[0]?.sessionId ?? null),
    );
  }, [focusSessionId, shopId]);

  useEffect(() => {
    if (focusSessionId && sessions.some((item) => item.sessionId === focusSessionId)) {
      setActiveSessionId(focusSessionId);
    }
  }, [focusSessionId, sessions]);

  const loadMessages = useCallback(
    async (sessionId: string) => {
      const next = await window.api.conversation.stream(shopId, sessionId, undefined, 200);
      messageIds.current = new Set(next.map((item) => item.id));
      setMessages(next);
      const saved = await window.api.conversation.draft(shopId, sessionId);
      if (saved.ok) setDraft(saved.draft);
    },
    [shopId],
  );

  useEffect(() => {
    let disposed = false;
    void loadSessions().catch((error) => console.error('加载会话失败:', error));
    const unsubscribe = window.api.conversation.onMessage((payload) => {
      const item = payload as Partial<PlatformMessage>;
      if (disposed || item.shopId !== shopId || !item.sessionId || typeof item.id !== 'number') return;
      if (item.sessionId !== activeSessionId || messageIds.current.has(item.id)) return;
      messageIds.current.add(item.id);
      setMessages((current) => [...current, item as PlatformMessage]);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [activeSessionId, loadSessions, shopId]);

  useEffect(() => {
    if (activeSessionId) {
      void loadMessages(activeSessionId).catch((error) => console.error('加载消息失败:', error));
    } else {
      setMessages([]);
      setDraft('');
    }
  }, [activeSessionId, loadMessages]);

  const activeSession = useMemo(
    () => sessions.find((item) => item.sessionId === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );
  const platformTheme = getPlatformTheme(shop?.platform ?? 'feige');
  const platformLabel = PLATFORM_LABELS[shop?.platform ?? 'feige'] ?? shop?.platform ?? '平台';
  const loginStatus = shop?.loginStatus ?? 'logged_in';

  const persistDraft = useCallback(
    async (value: string) => {
      if (!activeSessionId) return;
      setDraft(value);
      await window.api.conversation.draft(shopId, activeSessionId, value);
    },
    [activeSessionId, shopId],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !activeSessionId || loading) return;
    setLoading(true);
    try {
      const clientMessageId =
        'ui-' + shopId + '-' + activeSessionId + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const result = await window.api.conversation.sendText(shopId, activeSessionId, text, clientMessageId);
      if (result.ok) {
        setDraft('');
        await window.api.conversation.draft(shopId, activeSessionId, '');
        await loadMessages(activeSessionId);
        await loadSessions();
      } else {
        toast.show('error', result.error ?? '发送回复失败');
      }
    } finally {
      setLoading(false);
    }
  }, [activeSessionId, draft, loadMessages, loadSessions, loading, shopId, toast]);

  const handleAttachment = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (!activeSessionId) {
        toast.show('info', '请先选择会话');
        return;
      }
      try {
        const result = await window.api.conversation.sendAttachment(shopId, activeSessionId, {
          name: file.name,
          size: file.size,
          type: file.type,
        });
        if (!result.ok) {
          toast.show('error', result.error ?? '附件处理失败');
        } else if (result.status === 'manual_only') {
          toast.show('warn', result.message ?? '请在平台原页完成附件发送');
        } else {
          toast.show('success', result.message ?? '附件已处理');
          await loadMessages(activeSessionId);
        }
      } catch (error) {
        toast.show('error', error instanceof Error ? error.message : '附件处理失败');
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [activeSessionId, loadMessages, shopId, toast],
  );

  const insertEmoji = useCallback(() => {
    if (!activeSessionId) {
      toast.show('info', '请先选择会话');
      return;
    }
    void persistDraft(`${draft}🙂`);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [activeSessionId, draft, persistDraft, toast]);

  const openOrder = useCallback(async () => {
    setContextPanel('order');
    setContextLoading(true);
    try {
      if (!activeSessionId) {
        setOrderSnapshot(null);
        toast.show('info', '请先选择会话');
        return;
      }
      const result = await window.api.order.capture(shopId, activeSessionId);
      if (!result.ok) {
        setOrderSnapshot(null);
        toast.show('error', result.error ?? '读取订单失败');
        return;
      }
      setOrderSnapshot((result.snapshot as OrderSnapshotView | null) ?? null);
      if (!result.snapshot) toast.show('info', result.message ?? '当前会话暂无订单摘要');
    } catch (error) {
      setOrderSnapshot(null);
      toast.show('error', error instanceof Error ? error.message : '读取订单失败');
    } finally {
      setContextLoading(false);
    }
  }, [activeSessionId, shopId, toast]);

  const openBuyer = useCallback(async () => {
    setContextPanel('buyer');
    setContextLoading(true);
    try {
      if (!activeSessionId) {
        setBuyerProfile(null);
        toast.show('info', '请先选择会话');
        return;
      }
      const result = await window.api.buyer.profile(shopId, shop?.platform ?? 'feige', activeSessionId);
      if (!result.ok) {
        setBuyerProfile(null);
        toast.show('error', result.error ?? '读取买家画像失败');
        return;
      }
      setBuyerProfile((result.profile as BuyerProfileView | null) ?? null);
      if (!result.profile) toast.show('info', '当前买家暂无画像记录');
    } catch (error) {
      setBuyerProfile(null);
      toast.show('error', error instanceof Error ? error.message : '读取买家画像失败');
    } finally {
      setContextLoading(false);
    }
  }, [activeSessionId, shop?.platform, shopId, toast]);

  const refreshCurrentSession = useCallback(async () => {
    setMoreOpen(false);
    await loadSessions();
    if (activeSessionId) await loadMessages(activeSessionId);
    toast.show('success', '会话已刷新');
  }, [activeSessionId, loadMessages, loadSessions, toast]);

  useEffect(() => {
    let disposed = false;
    const loadSuggestions = async () => {
      setSuggestionsLoading(true);
      try {
        if (composerTab === '商品') {
          if (!window.api.product?.list) return;
          const products = await window.api.product.list(shopId);
          if (!disposed) {
            setSuggestions(
              (products as Array<{ product_id?: string; name?: string; sku?: string; variants?: Array<{ price?: number }> }>)
                .slice(0, 8)
                .map((product, index) => ({
                  id: product.product_id ?? `product-${index}`,
                  label: product.name ?? '未命名商品',
                  content: product.name ?? '',
                  meta: product.sku || (product.variants?.[0]?.price != null ? `¥${product.variants[0].price}` : undefined),
                })),
            );
          }
        } else if (composerTab === '订单') {
          if (!activeSessionId || !window.api.order?.capture) {
            if (!disposed) setSuggestions([]);
            return;
          }
          const result = await window.api.order.capture(shopId, activeSessionId);
          if (!disposed) {
            const snapshot = result.snapshot as OrderSnapshotView | null | undefined;
            setSuggestions(
              result.ok && snapshot
                ? [{ id: snapshot.orderRef ?? 'order', label: snapshot.orderRef ?? '当前订单', content: snapshot.summary }]
                : [],
            );
          }
        } else {
          if (!window.api.kb?.listTemplates) return;
          const templates = await window.api.kb.listTemplates(shopId);
          if (!disposed) {
            setSuggestions(
              (templates as Array<{ id?: string; scenario?: string; content?: string; category?: string }>)
                .filter((template) => template.content)
                .slice(0, 8)
                .map((template, index) => ({
                  id: template.id ?? `template-${index}`,
                  label: template.scenario || (composerTab === '知识库' ? '知识库话术' : '快捷回复'),
                  content: template.content ?? '',
                  meta: template.category,
                })),
            );
          }
        }
      } catch (error) {
        if (!disposed) {
          setSuggestions([]);
          console.error('加载编辑器推荐失败:', error);
        }
      } finally {
        if (!disposed) setSuggestionsLoading(false);
      }
    };
    void loadSuggestions();
    return () => {
      disposed = true;
    };
  }, [activeSessionId, composerTab, shopId]);

  const insertSuggestion = useCallback(
    (content: string) => {
      if (!activeSessionId) {
        toast.show('info', '请先选择会话');
        return;
      }
      const next = draft.trim() ? `${draft}\n${content}` : content;
      void persistDraft(next);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [activeSessionId, draft, persistDraft, toast],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <section className={styles.wrap} aria-label="统一工作台">
      <header className={styles.workspaceHeader}>
        <div className={styles.buyerIdentity}>
          <div className={styles.buyerAvatar}>
            <UserRound size={18} />
          </div>
          <div className={styles.buyerCopy}>
            <strong className={styles.buyerName}>{activeSessionId ?? '暂无会话'}</strong>
            <span className={styles.buyerShop}>
              {shop?.shopName ?? '请选择店铺'} · {platformLabel}
            </span>
          </div>
          <span className={autoReply ? styles.aiPill : styles.aiPillOff}>
            <Sparkles size={13} />
            AI {autoReply ? '已开启' : '已关闭'}
          </span>
        </div>
        <div className={styles.headerActions}>
          {showControlPanelButton && (
            <button
              type="button"
              className={styles.headerButton}
              aria-pressed={controlPanelOpen}
              onClick={onToggleControlPanel}
            >
              <Sparkles size={15} />
              {controlPanelOpen ? '关闭接待控制' : '接待控制'}
            </button>
          )}
          <button type="button" className={styles.headerButton} onClick={() => void openOrder()}>
            <ClipboardList size={15} />
            订单
          </button>
          <button type="button" className={styles.headerButton} onClick={() => void openBuyer()}>
            <UserRound size={15} />
            买家
          </button>
          <div className={styles.moreWrap}>
            <button
              type="button"
              className={styles.moreButton}
              aria-label="更多操作"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((value) => !value)}
            >
              <MoreHorizontal size={17} />
            </button>
            {moreOpen && (
              <div className={styles.moreMenu} role="menu">
                <button type="button" role="menuitem" onClick={() => void refreshCurrentSession()}>
                  刷新当前会话
                </button>
                <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); onOpenPlatform?.(); }}>
                  打开平台原页
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {contextPanel && (
        <section className={styles.contextPanel} aria-label={contextPanel === 'order' ? '订单摘要' : '买家画像'}>
          <div className={styles.contextHeader}>
            <strong>{contextPanel === 'order' ? '订单摘要（只读）' : '买家画像'}</strong>
            <button type="button" onClick={() => setContextPanel(null)} aria-label="关闭上下文面板">
              关闭
            </button>
          </div>
          {contextLoading ? (
            <span className={styles.contextHint}>正在读取…</span>
          ) : contextPanel === 'order' ? (
            orderSnapshot ? (
              <div className={styles.contextBody}>
                <span>{orderSnapshot.orderRef ?? '当前订单'}</span>
                <p>{orderSnapshot.summary}</p>
                {orderSnapshot.platformUrl && <span className={styles.contextMeta}>可从平台原页继续处理</span>}
              </div>
            ) : <span className={styles.contextHint}>暂无订单摘要</span>
          ) : buyerProfile ? (
            <div className={styles.contextBody}>
              <span>{buyerProfile.buyerName ?? activeSessionId}</span>
              <p>VIP {buyerProfile.vipLevel ?? 0} · 咨询 {buyerProfile.consultationCount ?? 0} 次 · 转化 {buyerProfile.conversionCount ?? 0} 次</p>
              {buyerProfile.tags && buyerProfile.tags.length > 0 && <span className={styles.contextMeta}>标签：{buyerProfile.tags.join('、')}</span>}
              {buyerProfile.remarks && <span className={styles.contextMeta}>备注：{buyerProfile.remarks}</span>}
            </div>
          ) : <span className={styles.contextHint}>暂无买家画像记录</span>}
        </section>
      )}

      <div className={styles.modeSwitch} role="tablist" aria-label="工作台视图">
        <button type="button" role="tab" aria-selected="true" className={styles.modeActive}>
          统一工作台
        </button>
        <button type="button" role="tab" aria-selected="false" className={styles.modeInactive} onClick={onOpenPlatform}>
          平台原页
        </button>
      </div>

      {loginStatus === 'logged_out' && (
        <div className={styles.loginBanner} role="alert">
          <div>
            <strong>{platformLabel}店铺尚未登录</strong>
            <span>登录平台原页后才能接收买家消息和使用客服工作台。</span>
          </div>
          <button type="button" onClick={onOpenPlatform} disabled={!onOpenPlatform}>
            去平台登录
          </button>
        </div>
      )}
      {loginStatus === 'logging_in' && (
        <div className={styles.loginBannerInfo} role="status">
          正在检测 {platformLabel} 登录状态，请稍候…
        </div>
      )}

      <div className={styles.sessionBar} role="tablist" aria-label="买家会话列表">
        {sessions.length === 0 ? (
          <span className={styles.emptySession}>暂无实时会话</span>
        ) : (
          sessions.map((session, index) => (
            <button
              key={session.sessionId}
              type="button"
              role="tab"
              aria-selected={activeSessionId === session.sessionId}
              className={activeSessionId === session.sessionId ? styles.sessionChipActive : styles.sessionChip}
              onClick={() => setActiveSessionId(session.sessionId)}
            >
              <span className={styles.sessionName}>{sessionLabel(session, index)}</span>
              <span className={styles.sessionCount}>{session.messageCount}</span>
            </button>
          ))
        )}
      </div>

      <div className={styles.thread}>
        {messages.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon} style={{ background: platformTheme.bgColor, color: platformTheme.color }}>
              <MessagePlaceholder />
            </div>
            <strong>{activeSession ? '等待新的买家消息' : '从左侧选择一个会话'}</strong>
            <span>消息会在平台连接正常后自动显示在这里</span>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={message.direction === 'out' ? styles.messageRowOut : styles.messageRowIn}>
              <div className={styles.messageAvatar}>
                {message.direction === 'out' ? <Sparkles size={14} /> : <UserRound size={14} />}
              </div>
              <div className={styles.messageBody}>
                <div className={styles.messageMeta}>
                  <span>{message.direction === 'out' ? '客服' : '买家'}</span>
                  <span>{formatTime(message.createdAt)}</span>
                </div>
                <div className={styles.bubble}>{message.content}</div>
                {message.source && (
                  <div className={styles.sourceChips}>
                    <span>{message.source}</span>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <footer className={styles.composer}>
        <div className={styles.composerTabs}>
          {['快捷回复', '知识库', '商品', '订单'].map((tab) => (
            <button
              key={tab}
              type="button"
              className={composerTab === tab ? styles.composerTabActive : styles.composerTab}
              onClick={() => setComposerTab(tab)}
            >
              {tab === '快捷回复' && <Sparkles size={13} />}
              {tab === '知识库' && <Type size={13} />}
              {tab === '商品' && <ImageIcon size={13} />}
              {tab === '订单' && <ClipboardList size={13} />}
              {tab}
            </button>
          ))}
        </div>
        <div className={styles.suggestionPanel} aria-label={`${composerTab}推荐`}>
          {suggestionsLoading ? (
            <span className={styles.suggestionHint}>正在加载{composerTab}…</span>
          ) : suggestions.length === 0 ? (
            <span className={styles.suggestionHint}>{activeSessionId ? `暂无${composerTab}内容` : '选择会话后查看推荐内容'}</span>
          ) : (
            suggestions.map((item) => (
              <button key={item.id} type="button" className={styles.suggestionItem} onClick={() => insertSuggestion(item.content)}>
                <span>{item.label}</span>
                {item.meta && <small>{item.meta}</small>}
              </button>
            ))
          )}
        </div>
        <textarea
          ref={inputRef}
          aria-label="回复输入框"
          className={styles.input}
          value={draft}
          placeholder={activeSessionId ? '输入回复内容，Ctrl + Enter 发送' : '请选择会话后开始回复'}
          disabled={!activeSessionId}
          onChange={(event) => void persistDraft(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className={styles.composerFooter}>
          <div className={styles.composerTools}>
            <input
              ref={fileInputRef}
              type="file"
              className={styles.hiddenInput}
              accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.zip"
              onChange={(event) => void handleAttachment(event.target.files?.[0])}
            />
            <button
              type="button"
              aria-label="添加附件"
              className={styles.toolButton}
              onClick={() => {
                if (fileInputRef.current) fileInputRef.current.accept = 'image/*,.pdf,.doc,.docx,.xls,.xlsx,.zip';
                fileInputRef.current?.click();
              }}
            >
              <Paperclip size={16} />
            </button>
            <button
              type="button"
              aria-label="选择图片"
              className={styles.toolButton}
              onClick={() => {
                if (fileInputRef.current) fileInputRef.current.accept = 'image/*';
                fileInputRef.current?.click();
              }}
            >
              <ImageIcon size={16} />
            </button>
            <button type="button" aria-label="插入表情" className={styles.toolButton} onClick={insertEmoji}>
              <Smile size={16} />
            </button>
            <span className={styles.shortcut}>支持 Ctrl + Enter</span>
          </div>
          <div className={styles.sendArea}>
            <span className={styles.counter}>{draft.length}/2000</span>
            <button
              type="button"
              aria-label="发送回复"
              className={styles.sendButton}
              disabled={!draft.trim() || !activeSessionId || loading}
              onClick={() => void send()}
            >
              <Send size={15} />
              发送
            </button>
          </div>
        </div>
      </footer>
    </section>
  );
}

function MessagePlaceholder() {
  return <span className={styles.placeholderGlyph}>✦</span>;
}
