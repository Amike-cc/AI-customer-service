import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Hand,
  PackageSearch,
  Paperclip,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  Star,
  UserCheck,
  Zap,
} from 'lucide-react';
import { Badge } from '../common/Badge';
import { Button } from '../common/Button';
import { useToast } from '../common/Toast';
import type { ShopListItem } from '../../types/api';
import styles from './WorkspacePanel.module.css';

interface WorkspaceCapabilities {
  autoReply: boolean;
  visualDetection: boolean;
  visualAutoSend: boolean;
  pageTransfer: boolean;
  attachmentSend: 'manual_only';
}

interface WorkspaceSnapshot {
  shopId: string;
  shopName: string;
  platform: string;
  autoReply: boolean;
  loginStatus: string;
  state: string | null;
  manualMode: boolean;
  unreadCount: number;
  capabilities?: WorkspaceCapabilities | null;
  capturedAt: number;
}

interface OrderSnapshot {
  orderRef: string;
  summary: string;
  platformUrl: string | null;
  capturedAt: number;
}

interface TransferEventItem {
  id: number;
  sessionId: string;
  status: string;
  kind: string;
  operator: string | null;
  reason: string | null;
  createdAt: number;
}

interface WorkspacePanelProps {
  shop: ShopListItem;
  autoReply: boolean;
  onSetAutoReply: (shopId: string, autoReply: boolean) => void;
  onTakeover: (shopId: string) => void;
  onRelease: (shopId: string) => void;
  onTestReply?: () => void;
  /** 中央区当前模式，用于切换平台页面 / 消息时间线 */
  centerMode?: 'platform' | 'timeline';
  onToggleCenterMode?: () => void;
}

const PLATFORM_LABELS: Record<string, string> = {
  feige: '抖店',
  pinduoduo: '拼多多',
  kuaishou: '快手小店',
  weixin: '微信小店',
};

function stateLabel(state: string | null): {
  text: string;
  color: 'success' | 'warning' | 'danger' | 'info' | 'default';
} {
  switch (state) {
    case 'Healthy':
      return { text: '正常', color: 'success' };
    case 'Degrading':
      return { text: '降级中', color: 'warning' };
    case 'VisualMode':
      return { text: '视觉模式', color: 'info' };
    case 'Recovering':
      return { text: '恢复中', color: 'info' };
    case 'SilentWait':
      return { text: '静默等待', color: 'warning' };
    case 'ManualMode':
      return { text: '人工接管', color: 'warning' };
    case 'Error':
      return { text: '错误', color: 'danger' };
    default:
      return { text: '未知', color: 'default' };
  }
}

export function WorkspacePanel({
  shop,
  autoReply,
  onSetAutoReply,
  onTakeover,
  onRelease,
  onTestReply,
  centerMode = 'platform',
  onToggleCenterMode,
}: WorkspacePanelProps) {
  const toast = useToast();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [transfers, setTransfers] = useState<TransferEventItem[]>([]);
  const [order, setOrder] = useState<OrderSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await window.api.workspace.getSnapshot(shop.shopId);
      if (res.ok && res.snapshot) {
        setSnapshot(res.snapshot as WorkspaceSnapshot);
      }
      const history = await window.api.transfer.history(shop.shopId, undefined, 5);
      setTransfers((history as TransferEventItem[]) ?? []);
    } catch (err) {
      console.error('加载工作台快照失败:', err);
    }
  }, [shop.shopId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  }, [refresh]);

  const manualMode = snapshot?.manualMode ?? shop.state === 'ManualMode';
  const state = stateLabel(snapshot?.state ?? shop.state);
  const loginStatus = snapshot?.loginStatus ?? shop.loginStatus;
  const canEnableAi = loginStatus === 'logged_in';
  const capabilities = snapshot?.capabilities;
  // 仅当店铺状态真的是 VisualMode 时才提示"仅识别、需人工回复"：
  // 视觉服务可用（visualDetection）不等于当前正在用视觉模式，否则会误导 Healthy 店铺
  const visualOnly = (snapshot?.state ?? shop.state) === 'VisualMode' && !capabilities?.visualAutoSend;

  const handleCaptureOrder = useCallback(async () => {
    setBusy(true);
    try {
      // 不传 sessionId：主进程读取平台页面当前会话作为归属
      const res = await window.api.order.capture(shop.shopId);
      if (!res.ok) {
        toast.show('error', res.error ?? '抓取订单失败');
        return;
      }
      if (!res.snapshot) {
        toast.show('info', res.message ?? '暂无可读取的订单摘要');
        return;
      }
      setOrder(res.snapshot as OrderSnapshot);
    } catch (err) {
      toast.show('error', err instanceof Error ? err.message : '抓取订单失败');
    } finally {
      setBusy(false);
    }
  }, [shop.shopId, toast]);

  const handlePickAttachment = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleAttachmentChosen = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      try {
        // 平台级附件发送尚未实现：主进程只会返回 manual_only，提示用户在平台页面发送。
        // sessionId 留空交由主进程按平台当前会话处理。
        const res = await window.api.conversation.sendAttachment(shop.shopId, '', {
          name: file.name,
          size: file.size,
          type: file.type,
        });
        if (!res.ok) {
          toast.show('error', res.error ?? '附件处理失败');
          return;
        }
        toast.show('warn', res.message ?? '请在平台页面发送该附件');
      } catch (err) {
        toast.show('error', err instanceof Error ? err.message : '附件处理失败');
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [shop.shopId, toast],
  );

  const handleToggleAi = useCallback(async () => {
    setBusy(true);
    try {
      await onSetAutoReply(shop.shopId, !autoReply);
      toast.show('success', autoReply ? 'AI 已关闭' : 'AI 已开启');
      await refresh();
    } catch (err) {
      toast.show('error', err instanceof Error ? err.message : '切换失败');
    } finally {
      setBusy(false);
    }
  }, [autoReply, onSetAutoReply, refresh, shop.shopId, toast]);

  const handleTakeover = useCallback(async () => {
    setBusy(true);
    try {
      await onTakeover(shop.shopId);
      toast.show('info', '已进入人工接管，AI 自动发送已停止');
      await refresh();
    } catch (err) {
      toast.show('error', err instanceof Error ? err.message : '接管失败');
    } finally {
      setBusy(false);
    }
  }, [onTakeover, refresh, shop.shopId, toast]);

  const handleRelease = useCallback(async () => {
    setBusy(true);
    try {
      await onRelease(shop.shopId);
      toast.show('success', '已释放接管，AI 恢复');
      await refresh();
    } catch (err) {
      toast.show('error', err instanceof Error ? err.message : '释放失败');
    } finally {
      setBusy(false);
    }
  }, [onRelease, refresh, shop.shopId, toast]);

  return (
    <aside className={styles.panel} aria-label="工作台操作面板">
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <div>
            <span className={styles.panelTitle}>接待控制</span>
            <span className={styles.panelEyebrow} title={shop.shopName}>
              {shop.shopName}
            </span>
          </div>
          <Badge color={state.color}>{state.text}</Badge>
        </div>
        <div className={styles.statusRow}>
          <span className={styles.loginStatus}>
            {snapshot?.loginStatus === 'logged_in'
              ? '已登录'
              : snapshot?.loginStatus === 'logging_in'
                ? '登录中'
                : '未登录'}
          </span>
          <span className={styles.panelPlatform}>{PLATFORM_LABELS[shop.platform] ?? shop.platform}</span>
        </div>
      </header>

      <section className={[styles.section, styles.controlSection].join(' ')} aria-label="AI 开关">
        <div className={styles.sectionTitle}>
          <Zap size={14} />
          AI 自动回复
        </div>
        <Button
          variant={autoReply ? 'primary' : 'default'}
          onClick={() => void handleToggleAi()}
          loading={busy}
          disabled={!autoReply && !canEnableAi}
          className={styles.fullWidth}
        >
          <span className={styles.aiSwitch} aria-hidden="true">
            <span className={autoReply ? styles.aiSwitchOn : styles.aiSwitchOff} />
          </span>
          <span>{autoReply ? '已开启' : '已关闭'}</span>
          <span className={styles.switchHint}>自动识别并回复买家</span>
        </Button>
        <div className={styles.healthLine}>
          <span className={styles.healthDot} />
          <span>运行状态</span>
          <strong>{state.text}</strong>
        </div>
        {!autoReply && !canEnableAi && <p className={styles.hint}>请先登录平台，再开启 AI 自动回复。</p>}
        {visualOnly && <p className={styles.hint}>当前为视觉模式：仅识别买家消息，需人工回复。</p>}
      </section>

      <section className={[styles.section, styles.takeoverSection].join(' ')} aria-label="人工接管">
        <div className={styles.sectionTitle}>
          <Hand size={14} />
          人工接管
        </div>
        {manualMode ? (
          <Button variant="danger" onClick={() => void handleRelease()} loading={busy} className={styles.fullWidth}>
            <UserCheck size={14} />
            释放接管
          </Button>
        ) : (
          <Button variant="default" onClick={() => void handleTakeover()} loading={busy} className={styles.fullWidth}>
            <Hand size={14} />
            立即接管
          </Button>
        )}
        {manualMode && <p className={styles.hint}>接管中：AI 自动生成与发送已停止，人工文字发送仍可用。</p>}
      </section>

      <section className={styles.section} aria-label="订单摘要">
        <div className={styles.sectionTitle}>
          <PackageSearch size={14} />
          订单摘要（只读）
        </div>
        {order ? (
          <pre className={styles.orderSummary}>{order.summary}</pre>
        ) : (
          <p className={styles.empty}>暂无订单摘要</p>
        )}
        <Button size="sm" variant="ghost" onClick={() => void handleCaptureOrder()} loading={busy}>
          <PackageSearch size={13} />
          从平台页面读取
        </Button>
      </section>

      <section className={styles.section} aria-label="当前商品">
        <div className={styles.sectionTitle}>
          <ShoppingBag size={14} />
          当前商品
        </div>
        <div className={styles.productCard}>
          <div className={styles.productThumb}>
            <ShoppingBag size={17} />
          </div>
          <div className={styles.productCopy}>
            <strong>{order ? '已读取平台商品' : '尚未识别商品'}</strong>
            <span>{order ? order.summary.slice(0, 45) : '打开买家会话后自动识别'}</span>
          </div>
        </div>
        <div className={styles.productActions}>
          <Button size="sm" variant="ghost" onClick={() => void handleCaptureOrder()} loading={busy}>
            <PackageSearch size={13} />
            读取商品
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            className={styles.hiddenInput}
            onChange={(e) => void handleAttachmentChosen(e.target.files?.[0])}
          />
          <Button size="sm" variant="ghost" onClick={handlePickAttachment}>
            <Paperclip size={13} />
            附件
          </Button>
        </div>
        <p className={styles.hint}>附件需在平台原页完成发送，工作台只负责识别与记录。</p>
      </section>

      <section className={styles.section} aria-label="回复质量">
        <div className={styles.sectionTitle}>
          <Star size={14} />
          回复质量
        </div>
        <div className={styles.qualityCard}>
          <strong>—</strong>
          <span>暂无足够样本</span>
          <small>回复质量评分将在产生会话后更新</small>
        </div>
      </section>

      <section className={styles.section} aria-label="转接记录">
        <div className={styles.sectionTitle}>
          <RefreshCw size={14} />
          最近转接
        </div>
        {transfers.length === 0 ? (
          <p className={styles.empty}>暂无转接记录</p>
        ) : (
          <ul className={styles.transferList}>
            {transfers.map((t) => (
              <li key={t.id}>
                <span className={styles.transferKind}>{t.kind === 'page_transfer' ? '页面转接' : '通用接管'}</span>
                <span className={styles.transferTime}>{new Date(t.createdAt).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-label="快捷操作">
        <div className={styles.sectionTitle}>
          <ShieldCheck size={14} />
          快捷操作
        </div>
        <div className={styles.actionGrid}>
          <Button size="sm" variant="ghost" onClick={() => onTestReply?.()}>
            <Star size={13} />
            测试回复
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void refresh()}>
            <ShoppingBag size={13} />
            刷新状态
          </Button>
          {onToggleCenterMode && (
            <Button
              size="sm"
              variant={centerMode === 'timeline' ? 'primary' : 'ghost'}
              onClick={onToggleCenterMode}
              className={styles.spanTwo}
            >
              {centerMode === 'timeline' ? '返回平台页面' : '查看消息时间线'}
            </Button>
          )}
        </div>
      </section>
    </aside>
  );
}
