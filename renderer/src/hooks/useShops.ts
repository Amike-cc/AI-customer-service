import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShopListItem } from '../types/api';

function normalizeMutationError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string' && error.trim()) return new Error(error);
  return new Error(fallbackMessage);
}

function assertMutationSucceeded(result: unknown, fallbackMessage: string): void {
  if (typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === true) {
    return;
  }

  const error = typeof result === 'object' && result !== null
    ? (result as { error?: unknown }).error
    : undefined;
  throw new Error(typeof error === 'string' && error.trim() ? error : fallbackMessage);
}

export function useShops() {
  const [shops, setShops] = useState<ShopListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeShopId, setActiveShopId] = useState<string | null>(null);
  const [loginStatuses, setLoginStatuses] = useState<Record<string, string>>({});
  const mountedRef = useRef(true);
  const retryCountRef = useRef(0);
  const refreshingRef = useRef(false);
  const stateRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 视图切换串行化：主进程 ensureAndMount 耗时可达秒级，并发切换时
  // 完成顺序 ≠ 点击顺序会导致 activeShopId 与真实视图不一致。
  // 关键：IPC 必须延迟执行（排队到前一个完成后才发起），而不是并发发起后仅串联 Promise。
  const viewSwitchQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  // 视图操作版本号：后发操作拥有最终优先级，迟到响应（revision 不匹配）必须丢弃。
  const viewRevisionRef = useRef(0);

  const refresh = useCallback(async () => {
    // in-flight 去重：避免轮询/事件/手动刷新叠加出并发请求
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const list = await window.api.shop.list();
      if (mountedRef.current) {
        setShops(list);
        setError(null);
        retryCountRef.current = 0;
        const statuses: Record<string, string> = {};
        for (const s of list) {
          statuses[s.shopId] = s.loginStatus;
        }
        setLoginStatuses(statuses);
        setLoading(false);
      }
    } catch (err) {
      if (mountedRef.current) {
        setLoading(false);
        retryCountRef.current += 1;
        const errMsg = err instanceof Error ? err.message : String(err);
        setError(`获取店铺列表失败: ${errMsg}`);
        console.error('获取店铺失败:', err);
      }
    } finally {
      refreshingRef.current = false;
    }
  }, []);

  const runMutation = useCallback((
    invoke: () => Promise<unknown>,
    fallbackMessage: string,
    refreshAfterSuccess = false,
  ): Promise<void> => {
    const task = (async () => {
      try {
        const result = await invoke();
        assertMutationSucceeded(result, fallbackMessage);
        if (mountedRef.current) setError(null);
        if (refreshAfterSuccess) await refresh();
      } catch (cause) {
        const mutationError = normalizeMutationError(cause, fallbackMessage);
        if (mountedRef.current) setError(`操作失败: ${mutationError.message}`);
        throw mutationError;
      }
    })();

    // App 中的视图切换使用 fire-and-forget；预先附加拒绝处理器避免未处理
    // Promise，同时仍把原 Promise 返回给 Sidebar，以便其展示具体错误。
    void task.catch(() => {});
    return task;
  }, [refresh]);

  const takeover = useCallback((shopId: string) => runMutation(
    () => window.api.shop.takeover(shopId),
    '人工接管失败',
    true,
  ), [runMutation]);

  const release = useCallback((shopId: string) => runMutation(
    () => window.api.shop.release(shopId),
    '释放控制失败',
    true,
  ), [runMutation]);

  const addAccount = useCallback((shopName: string, platform?: string) => runMutation(
    () => window.api.shop.addAccount(shopName, platform ?? 'feige'),
    '添加店铺失败',
    true,
  ), [runMutation]);

  const removeAccount = useCallback((shopId: string) => runMutation(
    () => window.api.shop.removeAccount(shopId),
    '删除店铺失败',
    true,
  ), [runMutation]);

  const switchView = useCallback((shopId: string) => {
    // 递增版本号：本次操作拥有当前最高优先级，任何更早的迟到响应都将失效
    const revision = ++viewRevisionRef.current;
    // 关键改动：把 IPC 调用放进队列回调里延迟执行。
    // 之前 runMutation 在 call 时就已发起 IPC，仅串联返回的 Promise，
    // 导致 A、B 快速点击时两个 ensureAndMount 并发，A 后完成会把 UI 设回 A。
    const task = viewSwitchQueueRef.current
      .catch(() => { /* 前序失败不影响本次排队 */ })
      .then(() => runMutation(
        () => window.api.shop.switchView(shopId),
        '切换店铺失败',
      ))
      .then(() => {
        // revision 不是最新则说明后续又发起了新的切换/退出，丢弃本次结果
        if (viewRevisionRef.current !== revision) return;
        if (mountedRef.current) setActiveShopId(shopId);
      })
      .catch(() => {
        // 错误已由 runMutation 中的 setError 呈现
      });
    viewSwitchQueueRef.current = task.catch(() => {});
    return task;
  }, [runMutation]);

  const exitView = useCallback(() => {
    // 退出视图同样占用最新版本号，使所有在途切换失效（VIEW-02）
    const revision = ++viewRevisionRef.current;
    const task = viewSwitchQueueRef.current
      .catch(() => { /* 前序失败不影响本次排队 */ })
      .then(() => runMutation(
        () => window.api.shop.exitView(),
        '退出店铺视图失败',
      ))
      .then(() => {
        if (viewRevisionRef.current !== revision) return;
        if (mountedRef.current) setActiveShopId(null);
      })
      .catch(() => {
        // 错误已由 runMutation 中的 setError 呈现
      });
    viewSwitchQueueRef.current = task.catch(() => {});
    return task;
  }, [runMutation]);

  const startShop = useCallback((shopId: string) => runMutation(
    () => window.api.shop.start(shopId),
    '启动店铺失败',
    true,
  ), [runMutation]);

  const forceReLogin = useCallback((shopId: string) => runMutation(
    () => window.api.shop.forceReLogin(shopId),
    '重新登录失败',
  ), [runMutation]);

  const reloadShop = useCallback((shopId: string) => runMutation(
    () => window.api.shop.reload(shopId),
    '刷新店铺页面失败',
  ), [runMutation]);

  const stopShop = useCallback((shopId: string) => runMutation(
    () => window.api.shop.stop(shopId),
    '停止店铺失败',
    true,
  ), [runMutation]);

  const renameShop = useCallback((shopId: string, newName: string) => runMutation(
    () => window.api.shop.rename(shopId, newName),
    '重命名店铺失败',
    true,
  ), [runMutation]);

  const setAutoReply = useCallback((shopId: string, autoReply: boolean) => runMutation(
    () => window.api.shop.setAutoReply(shopId, autoReply),
    '切换 AI 自动回复失败',
    true,
  ), [runMutation]);

  const markRead = useCallback((shopId: string) => runMutation(
    () => window.api.shop.markRead(shopId),
    '标记消息已读失败',
    true,
  ), [runMutation]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();

    const unsubState = window.api.shop.onStateChanged(() => {
      // 状态变化频繁时全量 refresh() 会造成 IPC 风暴与 UI 抖动，
      // 这里做 200ms 节流合并多次状态变化为一次刷新。
      if (stateRefreshTimerRef.current) clearTimeout(stateRefreshTimerRef.current);
      stateRefreshTimerRef.current = setTimeout(() => {
        void refresh();
      }, 200);
    });

    const unsubLogin = window.api.shop.onLoginStatusChanged((data) => {
      if (mountedRef.current) {
        setLoginStatuses((prev) => ({ ...prev, [data.shopId]: data.status }));
      }
    });

    const unsubName = window.api.shop.onNameUpdated((data) => {
      if (mountedRef.current) {
        setShops((prev) =>
          prev.map((s) => (s.shopId === data.shopId ? { ...s, shopName: data.shopName } : s)),
        );
      }
    });

    void window.api.shop.getActiveShop().then(({ shopId }) => {
      if (mountedRef.current) {
        setActiveShopId(shopId);
      }
    });

    const timer = setInterval(() => {
      void refresh();
    }, 15000);

    return () => {
      mountedRef.current = false;
      unsubState();
      unsubLogin();
      unsubName();
      clearInterval(timer);
      if (stateRefreshTimerRef.current) clearTimeout(stateRefreshTimerRef.current);
    };
  }, [refresh]);

  return {
    shops,
    loading,
    error,
    refresh,
    takeover,
    release,
    addAccount,
    removeAccount,
    switchView,
    exitView,
    startShop,
    forceReLogin,
    reloadShop,
    stopShop,
    renameShop,
    setAutoReply,
    markRead,
    activeShopId,
    loginStatuses,
  };
}
