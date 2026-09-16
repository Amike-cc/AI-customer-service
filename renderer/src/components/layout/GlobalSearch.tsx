import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import styles from './GlobalSearch.module.css';

interface SearchGroup {
  type: string;
  items: Array<Record<string, unknown>>;
}

interface GlobalSearchProps {
  onSelectResult?: (type: string, item: Record<string, unknown>) => void;
}

const TYPE_LABELS: Record<string, string> = {
  messages: '消息',
  shops: '店铺',
  products: '商品',
  orders: '订单',
};

/**
 * 顶部全局搜索（UI-SEARCH-001）。
 *
 * revision 用于丢弃迟到响应：每次输入自增，旧请求返回时版本不匹配就忽略，
 * 避免慢请求覆盖最新关键词的结果。
 */
export function GlobalSearch({ onSelectResult }: GlobalSearchProps) {
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const revisionRef = useRef(0);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const runSearch = useCallback(async (kw: string) => {
    const trimmed = kw.trim();
    if (!trimmed) {
      setGroups([]);
      setLoading(false);
      return;
    }
    const revision = ++revisionRef.current;
    setLoading(true);
    try {
      const res = await window.api.search.global(trimmed, { limit: 20 });
      // 迟到响应：版本已变化则丢弃，不覆盖最新关键词的结果
      if (revision !== revisionRef.current) return;
      if (res.ok && Array.isArray(res.groups)) {
        setGroups(res.groups as SearchGroup[]);
      } else {
        setGroups([]);
      }
    } catch {
      if (revision === revisionRef.current) setGroups([]);
    } finally {
      if (revision === revisionRef.current) setLoading(false);
    }
  }, []);

  // 输入防抖 300ms
  useEffect(() => {
    const timer = setTimeout(() => void runSearch(query), 300);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  // 点击外部关闭结果面板
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const total = groups.reduce((n, g) => n + (g.items?.length ?? 0), 0);

  return (
    <div className={styles.wrap} ref={boxRef}>
      <div className={styles.inputWrap}>
        <Search size={14} className={styles.icon} />
        <input
          className={styles.input}
          value={query}
          placeholder="搜索会话、商品或订单"
          aria-label="全局搜索"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
        />
        {query && (
          <button
            className={styles.clear}
            onClick={() => {
              setQuery('');
              setGroups([]);
            }}
            aria-label="清除搜索"
          >
            <X size={13} />
          </button>
        )}
      </div>
      {open && query.trim() && (
        <div className={styles.results} role="listbox" aria-label="搜索结果">
          {loading && <div className={styles.hint}>搜索中…</div>}
          {!loading && total === 0 && <div className={styles.hint}>无匹配结果</div>}
          {!loading &&
            total > 0 &&
            groups.map(
              (group) =>
                group.items.length > 0 && (
                  <div key={group.type} className={styles.group}>
                    <div className={styles.groupTitle}>
                      {TYPE_LABELS[group.type] ?? group.type}（{group.items.length}）
                    </div>
                    <ul className={styles.list}>
                      {group.items.slice(0, 8).map((item, idx) => (
                        <li key={String(item.id ?? item.shopId ?? item.productId ?? item.orderRef ?? idx)} className={styles.item}>
                          <button
                            type="button"
                            className={styles.itemButton}
                            onClick={() => {
                              onSelectResult?.(group.type, item);
                              setOpen(false);
                            }}
                          >
                            <span className={styles.itemText}>
                              {String(item.content ?? item.shopName ?? item.name ?? item.orderRef ?? item.messageId ?? '')}
                            </span>
                            <span className={styles.itemMeta}>{String(item.sessionId ?? item.sku ?? item.platform ?? item.shopId ?? '')}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ),
            )}
        </div>
      )}
    </div>
  );
}
