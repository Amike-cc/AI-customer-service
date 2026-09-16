import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import type { ShopListItem, ConversationSession, ConversationMessage } from '../../types/api';
import { Select } from '../common/Select';
import { SearchInput } from '../common/SearchInput';
import { Button } from '../common/Button';
import { EmptyState } from '../common/EmptyState';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { useToast } from '../common/Toast';
import { MessageThread } from './MessageThread';
import { truncate, formatRelative, formatTime } from '../../utils/format';
import styles from './SessionViewer.module.css';

interface SessionViewerProps {
  shops: ShopListItem[];
}

export function SessionViewer({ shops }: SessionViewerProps) {
  const [shopId, setShopId] = useState('');
  const [sessions, setSessions] = useState<ConversationSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState('');
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [search, setSearch] = useState('');
  const [searchMode, setSearchMode] = useState<'sessions' | 'messages'>('sessions');
  const [searchResults, setSearchResults] = useState<ConversationMessage[]>([]);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const sessionsRequestRef = useRef(0);
  const messagesRequestRef = useRef(0);
  const searchRequestRef = useRef(0);
  const toast = useToast();

  const loadSessions = useCallback(async (sid: string) => {
    const requestId = ++sessionsRequestRef.current;
    setLoadingSessions(true);
    try {
      const list = await window.api.conversation.sessions(sid, 100);
      if (requestId === sessionsRequestRef.current) setSessions(list);
    } catch (err) {
      if (requestId === sessionsRequestRef.current) {
        toast.show('error', '加载会话列表失败: ' + (err instanceof Error ? err.message : String(err)));
        setSessions([]);
      }
    } finally {
      if (requestId === sessionsRequestRef.current) setLoadingSessions(false);
    }
  }, [toast]);

  const loadMessages = useCallback(async (sid: string, sessionId: string) => {
    const requestId = ++messagesRequestRef.current;
    setLoadingMessages(true);
    try {
      const list = await window.api.conversation.messages(sid, sessionId, 200, 0);
      if (requestId === messagesRequestRef.current) setMessages(list);
    } catch (err) {
      if (requestId === messagesRequestRef.current) {
        toast.show('error', '加载消息失败: ' + (err instanceof Error ? err.message : String(err)));
        setMessages([]);
      }
    } finally {
      if (requestId === messagesRequestRef.current) setLoadingMessages(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!shopId) {
      setSessions([]);
      setCurrentSessionId('');
      setMessages([]);
      return;
    }
    void loadSessions(shopId);
  }, [shopId, loadSessions]);

  useEffect(() => {
    if (!shopId || !currentSessionId) {
      setMessages([]);
      return;
    }
    void loadMessages(shopId, currentSessionId);
  }, [shopId, currentSessionId, loadMessages]);

  const handleRefresh = () => {
    if (shopId) void loadSessions(shopId);
  };

  const handleMessageSearch = useCallback(async (kw: string) => {
    const requestId = ++searchRequestRef.current;
    setSearch(kw);
    if (!shopId || !kw.trim()) {
      setSearchResults([]);
      setLoadingSearch(false);
      return;
    }
    setLoadingSearch(true);
    try {
      const results = await window.api.conversation.search(shopId, kw);
      if (requestId === searchRequestRef.current) setSearchResults(results);
    } catch (err) {
      if (requestId === searchRequestRef.current) {
        toast.show('error', '搜索消息失败: ' + (err instanceof Error ? err.message : String(err)));
        setSearchResults([]);
      }
    } finally {
      if (requestId === searchRequestRef.current) setLoadingSearch(false);
    }
  }, [shopId, toast]);

  const filteredSessions = search && searchMode === 'sessions'
    ? sessions.filter((s) => s.sessionId.toLowerCase().includes(search.toLowerCase()))
    : sessions;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>消息会话查看</h2>
        <Button size="sm" onClick={handleRefresh} loading={loadingSessions} disabled={!shopId}>
          <RefreshCw size={13} />
          刷新
        </Button>
      </div>
      <div className={styles.layout}>
        <div className={styles.sidebar}>
          <Select
            aria-label="选择会话所属店铺"
            value={shopId}
            onChange={(e) => {
              setShopId(e.target.value);
              setCurrentSessionId('');
              setSearchResults([]);
            }}
            options={[
              { value: '', label: '选择店铺' },
              ...shops.map((s) => ({ value: s.shopId, label: s.shopName })),
            ]}
          />
          <div className={styles.searchToggle} role="tablist" aria-label="搜索范围">
            <button
              type="button"
              role="tab"
              aria-selected={searchMode === 'sessions'}
              aria-controls="session-search-panel"
              tabIndex={searchMode === 'sessions' ? 0 : -1}
              className={searchMode === 'sessions' ? styles.modeActive : styles.modeBtn}
              onClick={() => { setSearchMode('sessions'); setSearch(''); setSearchResults([]); }}
            >
              会话搜索
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={searchMode === 'messages'}
              aria-controls="message-search-panel"
              tabIndex={searchMode === 'messages' ? 0 : -1}
              className={searchMode === 'messages' ? styles.modeActive : styles.modeBtn}
              onClick={() => { setSearchMode('messages'); setSearch(''); setSearchResults([]); }}
            >
              消息搜索
            </button>
          </div>
          {searchMode === 'sessions' ? (
            <>
              <SearchInput placeholder="搜索会话ID..." onSearch={setSearch} />
              <p className={styles.listMeta}>当前加载 {sessions.length} 个会话（最多显示最近 100 个）</p>
              <div className={styles.sessionList} id="session-search-panel" role="tabpanel">
                {loadingSessions ? (
                  <LoadingSpinner size={20} />
                ) : filteredSessions.length === 0 ? (
                  <EmptyState
                    title={search && sessions.length > 0 ? '没有匹配的会话' : shopId ? '该店铺暂无会话' : '请先选择店铺'}
                    description={search && sessions.length > 0 ? '请调整会话 ID 搜索关键词。' : shopId ? '等待客户发起会话' : '从上方选择店铺后查看会话'}
                  />
                ) : (
                  filteredSessions.map((s) => (
                    <button
                      type="button"
                      key={s.sessionId}
                      className={[
                        styles.sessionItem,
                        currentSessionId === s.sessionId && styles.active,
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => setCurrentSessionId(s.sessionId)}
                      aria-pressed={currentSessionId === s.sessionId}
                      aria-label={`会话 ${s.sessionId}，${s.messageCount} 条消息`}
                    >
                      <div className={styles.sessionId}>{truncate(s.sessionId, 20)}</div>
                      <div className={styles.sessionMeta}>
                        {s.messageCount} 条 · {formatRelative(s.lastMessageAt)}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </>
          ) : (
            <>
              <SearchInput placeholder="搜索消息内容..." onSearch={handleMessageSearch} />
              <div className={styles.sessionList} id="message-search-panel" role="tabpanel">
                {loadingSearch ? (
                  <LoadingSpinner size={20} />
                ) : searchResults.length === 0 ? (
                  <EmptyState message={search ? '无匹配消息' : '输入关键词搜索消息'} />
                ) : (
                  searchResults.map((m) => (
                    <button
                      type="button"
                      key={m.id}
                      className={styles.sessionItem}
                      onClick={() => {
                        setCurrentSessionId(m.sessionId);
                        setSearchMode('sessions');
                      }}
                      aria-label={`打开会话 ${m.sessionId} 中的匹配消息`}
                    >
                      <div className={styles.sessionId}>{truncate(m.content, 30)}</div>
                      <div className={styles.sessionMeta}>
                        {m.role} · {formatTime(m.createdAt)}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>
        <div className={styles.detail}>
          {loadingMessages ? (
            <LoadingSpinner size={24} />
          ) : currentSessionId ? (
            <MessageThread messages={messages} />
          ) : (
            <EmptyState message="选择会话查看消息" />
          )}
        </div>
      </div>
    </div>
  );
}
