import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, UserCheck, Users } from 'lucide-react';
import type { EscalationRecord, HumanAgent, QueueEntry, ShopListItem } from '../../types/api';
import { formatRelative } from '../../utils/format';
import { Button } from '../common/Button';
import { Card } from '../common/Card';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { Modal } from '../common/Modal';
import { Select } from '../common/Select';
import { useToast } from '../common/Toast';
import styles from './AgentPanel.module.css';

const AGENT_STATUS_LABELS: Record<HumanAgent['status'], string> = {
  available: '空闲',
  busy: '忙碌',
  offline: '离线',
};

const AGENT_STATUS_CLASSES: Record<HumanAgent['status'], string> = {
  available: styles.statusAvailable,
  busy: styles.statusBusy,
  offline: styles.statusOffline,
};

const PRIORITY_LABELS: Record<EscalationRecord['priority'], string> = {
  urgent: '紧急',
  high: '高',
  medium: '中',
  low: '低',
};

const PRIORITY_CLASSES: Record<EscalationRecord['priority'], string> = {
  urgent: styles.priorityUrgent,
  high: styles.priorityHigh,
  medium: styles.priorityMedium,
  low: styles.priorityLow,
};

const PRIORITY_ORDER: Record<EscalationRecord['priority'], number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

interface AgentPanelProps {
  shops: ShopListItem[];
}

export function AgentPanel({ shops }: AgentPanelProps) {
  const [shopId, setShopId] = useState('');
  const [agents, setAgents] = useState<HumanAgent[]>([]);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [escalations, setEscalations] = useState<EscalationRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [dataStale, setDataStale] = useState(false);
  const [assignModal, setAssignModal] = useState<{ escalationId: number } | null>(null);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<EscalationRecord | null>(null);
  const [resolvingId, setResolvingId] = useState<number | null>(null);
  const loadRequestId = useRef(0);
  const { show: showToast } = useToast();

  const resetScopeData = useCallback(() => {
    loadRequestId.current += 1;
    setAgents([]);
    setQueue([]);
    setEscalations([]);
    setLastUpdatedAt(null);
    setDataStale(false);
    setLoading(false);
    setAssignModal(null);
    setResolveTarget(null);
  }, []);

  const loadData = useCallback(
    async (showInitialLoading = true): Promise<boolean> => {
      if (!shopId) return false;
      const requestId = ++loadRequestId.current;
      if (showInitialLoading) setLoading(true);

      try {
        const [agentList, queueList, pendingList, assignedList] = await Promise.all([
          window.api.agent.list(shopId),
          window.api.agent.queue(shopId),
          window.api.escalation.list(shopId, 'pending'),
          window.api.escalation.list(shopId, 'assigned'),
        ]);
        if (requestId !== loadRequestId.current) return false;

        const activeEscalations = [
          ...(pendingList as EscalationRecord[]),
          ...(assignedList as EscalationRecord[]),
        ].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt - b.createdAt);

        setAgents(agentList as HumanAgent[]);
        setQueue(queueList as QueueEntry[]);
        setEscalations(activeEscalations);
        setLastUpdatedAt(Date.now());
        setDataStale(false);
        return true;
      } catch (err) {
        if (requestId !== loadRequestId.current) return false;
        setDataStale(true);
        showToast('error', '加载人工坐席数据失败: ' + (err instanceof Error ? err.message : String(err)));
        return false;
      } finally {
        if (requestId === loadRequestId.current && showInitialLoading) {
          setLoading(false);
        }
      }
    },
    [shopId, showToast],
  );

  useEffect(() => {
    const nextShopId = shops.some((shop) => shop.shopId === shopId) ? shopId : (shops[0]?.shopId ?? '');
    if (nextShopId !== shopId) {
      resetScopeData();
      setShopId(nextShopId);
    }
  }, [resetScopeData, shopId, shops]);

  useEffect(() => {
    if (shopId) void loadData();
  }, [loadData, shopId]);

  const handleShopChange = (nextShopId: string) => {
    if (nextShopId === shopId) return;
    resetScopeData();
    setShopId(nextShopId);
  };

  const handleRefresh = async () => {
    if (!shopId || refreshing) return;
    setRefreshing(true);
    try {
      const loaded = await loadData(false);
      if (loaded) {
        showToast('success', '坐席数据已刷新');
      }
    } catch (err) {
      setDataStale(true);
      showToast('error', '刷新失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRefreshing(false);
    }
  };

  const handleAssign = async () => {
    if (!assignModal || !selectedAgent || assigning) return;
    setAssigning(true);
    try {
      if (typeof window.api.agent?.assign !== 'function') {
        throw new Error('当前版本暂未启用人工分配');
      }
      const result = await window.api.agent.assign(assignModal.escalationId, selectedAgent);
      if (!result.ok) throw new Error(result.error ?? '后端未能完成分配');
      showToast('success', '已分配客服');
      setAssignModal(null);
      setSelectedAgent('');
      await loadData(false);
    } catch (err) {
      showToast('error', '分配失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setAssigning(false);
    }
  };

  const handleResolve = async () => {
    const target = resolveTarget;
    if (!target || resolvingId !== null) return;

    setResolvingId(target.id);
    try {
      const result = await window.api.escalation.resolve(target.id, '手动确认问题已解决');
      if (!result.ok) throw new Error('后端未能更新工单状态');
      setResolveTarget(null);
      showToast('success', `升级工单 #${target.id} 已标记为已解决`);
      await loadData(false);
    } catch (err) {
      showToast('error', '解决工单失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setResolvingId(null);
    }
  };

  const availableAgents = agents.filter((agent) => agent.status === 'available' && agent.activeChats < agent.maxChats);
  const canAssign = typeof window.api.agent?.assign === 'function';
  const pendingCount = escalations.filter((item) => item.status === 'pending').length;
  const assignedCount = escalations.filter((item) => item.status === 'assigned').length;
  const selectedShopName = shops.find((shop) => shop.shopId === shopId)?.shopName;
  const lastUpdatedText = lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : null;

  return (
    <div className={styles.container} aria-busy={loading || refreshing}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <h2 className={styles.title}>
            <Users size={18} aria-hidden="true" />
            人工坐席
          </h2>
          <p className={styles.subtitle}>查看坐席负载、实时队列与待处理/已分配升级工单</p>
          <p
            className={[styles.dataStatus, dataStale && styles.dataStatusStale].filter(Boolean).join(' ')}
            role="status"
            aria-live="polite"
          >
            {dataStale
              ? '数据可能已过期'
              : lastUpdatedAt
                ? '数据已更新'
                : shopId
                  ? '正在获取当前店铺数据'
                  : '尚无可用店铺'}
            {lastUpdatedAt && lastUpdatedText && (
              <>
                {' · 最近更新 '}
                <time dateTime={new Date(lastUpdatedAt).toISOString()}>{lastUpdatedText}</time>
              </>
            )}
          </p>
        </div>

        <div className={styles.toolbar} role="group" aria-label="人工坐席数据工具栏">
          <Select
            className={styles.shopSelect}
            aria-label="人工坐席店铺"
            value={shopId}
            onChange={(event) => handleShopChange(event.target.value)}
            options={
              shops.length > 0
                ? shops.map((shop) => ({ value: shop.shopId, label: shop.shopName }))
                : [{ value: '', label: '暂无可用店铺' }]
            }
            disabled={shops.length === 0 || loading || refreshing}
          />
          <Button
            size="sm"
            onClick={() => void handleRefresh()}
            loading={refreshing}
            disabled={!shopId || loading}
            aria-label={selectedShopName ? `刷新${selectedShopName}的人工坐席数据` : '刷新人工坐席数据'}
          >
            <RefreshCw size={13} aria-hidden="true" />
            刷新数据
          </Button>
        </div>
      </header>

      {!shopId ? (
        <div className={styles.pageEmpty} role="status">
          暂无可用店铺，请先在全局设置中添加并启用店铺。
        </div>
      ) : loading ? (
        <LoadingSpinner size={28} />
      ) : (
        <>
          <Card className={styles.section}>
            <h3 className={styles.sectionTitle}>坐席列表（{agents.length}）</h3>
            {agents.length > 0 ? (
              <div className={styles.tableWrap} role="region" aria-label="人工坐席列表，可横向滚动" tabIndex={0}>
                <table className={styles.table}>
                  <caption className={styles.tableCaption}>
                    {selectedShopName ?? '当前店铺'}的人工坐席列表，共 {agents.length} 人
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">名称</th>
                      <th scope="col">状态</th>
                      <th scope="col">活跃会话</th>
                      <th scope="col">最大会话</th>
                      <th scope="col">技能</th>
                      <th scope="col">最后分配</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents.map((agent) => {
                      const loadPercent =
                        agent.maxChats > 0 ? Math.min((agent.activeChats / agent.maxChats) * 100, 100) : 0;
                      const loadClass =
                        agent.maxChats > 0 && agent.activeChats >= agent.maxChats
                          ? styles.loadCritical
                          : agent.maxChats > 0 && agent.activeChats / agent.maxChats > 0.7
                            ? styles.loadWarning
                            : styles.loadHealthy;

                      return (
                        <tr key={agent.id}>
                          <th scope="row" className={styles.agentName}>
                            {agent.name}
                          </th>
                          <td>
                            <span className={`${styles.statusBadge} ${AGENT_STATUS_CLASSES[agent.status]}`}>
                              {AGENT_STATUS_LABELS[agent.status]}
                            </span>
                          </td>
                          <td>
                            <div className={styles.loadBarWrap}>
                              <div
                                className={styles.loadBar}
                                role="progressbar"
                                aria-label={`${agent.name}的会话负载`}
                                aria-valuemin={0}
                                aria-valuemax={agent.maxChats}
                                aria-valuenow={agent.activeChats}
                              >
                                <div
                                  className={`${styles.loadBarFill} ${loadClass}`}
                                  style={{ width: `${loadPercent}%` }}
                                />
                              </div>
                              <span className={styles.loadBarText}>
                                {agent.activeChats}/{agent.maxChats}
                              </span>
                            </div>
                          </td>
                          <td>{agent.maxChats}</td>
                          <td className={styles.skillsCell} title={agent.skills.join('、')}>
                            {agent.skills.length > 0 ? agent.skills.join('、') : '未配置'}
                          </td>
                          <td className={styles.muted}>
                            {agent.lastAssignedAt ? formatRelative(agent.lastAssignedAt) : '暂无'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className={styles.empty} role="status">
                当前店铺暂无坐席记录。点击“刷新数据”重新加载。
              </div>
            )}
          </Card>

          <Card className={styles.section}>
            <h3 className={styles.sectionTitle}>
              升级工单（待处理 {pendingCount} · 已分配 {assignedCount}）
            </h3>
            {!canAssign && (
              <p className={styles.capabilityNote} role="note">
                当前版本暂未启用手动分配；你仍可确认问题后将工单标记为已解决。
              </p>
            )}
            {escalations.length > 0 ? (
              <div className={styles.tableWrap} role="region" aria-label="升级工单列表，可横向滚动" tabIndex={0}>
                <table className={styles.table}>
                  <caption className={styles.tableCaption}>
                    {selectedShopName ?? '当前店铺'}的待处理与已分配升级工单，共 {escalations.length} 个
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">ID</th>
                      <th scope="col">会话</th>
                      <th scope="col">状态</th>
                      <th scope="col">优先级</th>
                      <th scope="col">原因</th>
                      <th scope="col">负责坐席</th>
                      <th scope="col">时间</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {escalations.map((escalation) => {
                      const shortSessionId =
                        escalation.sessionId.length > 12
                          ? `${escalation.sessionId.slice(0, 12)}…`
                          : escalation.sessionId;
                      const isResolving = resolvingId === escalation.id;
                      const isPending = escalation.status === 'pending';
                      const assignedAgentName = escalation.assignedAgentId
                        ? agents.find((item) => item.id === escalation.assignedAgentId)?.name
                        : undefined;
                      const assignDisabled = !isPending || !canAssign || availableAgents.length === 0 || isResolving;

                      return (
                        <tr key={escalation.id} aria-busy={isResolving || undefined}>
                          <th scope="row" className={styles.muted}>
                            {escalation.id}
                          </th>
                          <td className={styles.sessionIdCell} title={escalation.sessionId}>
                            {shortSessionId}
                          </td>
                          <td>
                            <span
                              className={`${styles.statusBadge} ${
                                isPending ? styles.escalationPending : styles.escalationAssigned
                              }`}
                            >
                              {isPending ? '待分配' : '已分配'}
                            </span>
                          </td>
                          <td>
                            <span className={`${styles.priorityBadge} ${PRIORITY_CLASSES[escalation.priority]}`}>
                              {PRIORITY_LABELS[escalation.priority]}
                            </span>
                          </td>
                          <td className={styles.reasonCell} title={escalation.reason}>
                            {escalation.reason}
                          </td>
                          <td className={styles.muted}>
                            {assignedAgentName ?? escalation.assignedAgentId ?? '未分配'}
                          </td>
                          <td className={styles.muted}>{formatRelative(escalation.createdAt)}</td>
                          <td>
                            <div className={styles.actionBtns}>
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => {
                                  setAssignModal({ escalationId: escalation.id });
                                  setSelectedAgent('');
                                }}
                                disabled={assignDisabled}
                                title={
                                  !isPending
                                    ? '工单已分配，无需重复分配'
                                    : !canAssign
                                      ? '当前版本暂未启用人工分配'
                                      : availableAgents.length === 0
                                        ? '暂无可分配的空闲客服'
                                        : undefined
                                }
                                aria-label={`分配升级工单 #${escalation.id}`}
                              >
                                <UserCheck size={12} aria-hidden="true" />
                                分配
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setResolveTarget(escalation)}
                                loading={isResolving}
                                disabled={isResolving}
                                aria-label={`解决升级工单 #${escalation.id}`}
                              >
                                {isResolving ? '解决中' : '解决'}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className={styles.empty} role="status">
                当前店铺暂无待处理或已分配升级工单。
              </div>
            )}
          </Card>

          <Card className={styles.section}>
            <h3 className={styles.sectionTitle}>实时排队（{queue.length}）</h3>
            {queue.length > 0 ? (
              <div className={styles.tableWrap} role="region" aria-label="实时排队列表，可横向滚动" tabIndex={0}>
                <table className={styles.table}>
                  <caption className={styles.tableCaption}>
                    {selectedShopName ?? '当前店铺'}的实时排队列表，共 {queue.length} 个会话
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">升级 ID</th>
                      <th scope="col">会话</th>
                      <th scope="col">优先级</th>
                      <th scope="col">入队时间</th>
                      <th scope="col">预计等待</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queue.map((entry) => {
                      const shortSessionId =
                        entry.sessionId.length > 12 ? `${entry.sessionId.slice(0, 12)}…` : entry.sessionId;
                      return (
                        <tr key={entry.escalationId}>
                          <th scope="row" className={styles.muted}>
                            {entry.escalationId}
                          </th>
                          <td className={styles.sessionIdCell} title={entry.sessionId}>
                            {shortSessionId}
                          </td>
                          <td>
                            <span className={`${styles.priorityText} ${PRIORITY_CLASSES[entry.priority]}`}>
                              {PRIORITY_LABELS[entry.priority]}
                            </span>
                          </td>
                          <td className={styles.muted}>{formatRelative(entry.enqueuedAt)}</td>
                          <td className={styles.muted}>{Math.max(0, Math.round(entry.estimatedWaitMs / 1000))} 秒</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className={styles.empty} role="status">
                当前店铺暂无实时排队会话。
              </div>
            )}
          </Card>
        </>
      )}

      <Modal
        open={!!assignModal}
        onClose={() => {
          if (!assigning) setAssignModal(null);
        }}
        title="分配客服"
        width={420}
        closeOnEscape={!assigning}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAssignModal(null)} disabled={assigning}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void handleAssign()} loading={assigning} disabled={!selectedAgent}>
              确认分配
            </Button>
          </>
        }
      >
        <div className={styles.modalBody}>
          <label className={styles.modalLabel} htmlFor="agent-assignment-select">
            选择空闲客服分配给升级工单 #{assignModal?.escalationId}
          </label>
          <Select
            id="agent-assignment-select"
            className={styles.modalSelect}
            value={selectedAgent}
            onChange={(event) => setSelectedAgent(event.target.value)}
            options={[
              { value: '', label: '请选择客服…' },
              ...availableAgents.map((agent) => ({
                value: agent.id,
                label: `${agent.name} (${agent.activeChats}/${agent.maxChats})`,
              })),
            ]}
            disabled={assigning}
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={!!resolveTarget}
        title="确认解决升级工单"
        message={
          resolveTarget
            ? resolveTarget.status === 'assigned' && resolveTarget.assignedAgentId
              ? `工单 #${resolveTarget.id}（会话 ${resolveTarget.sessionId}）已分配给 ${
                  agents.find((item) => item.id === resolveTarget.assignedAgentId)?.name ??
                  resolveTarget.assignedAgentId
                }。确认解决后将释放该坐席的活跃会话额度。`
              : `工单 #${resolveTarget.id}（会话 ${resolveTarget.sessionId}）将从待处理列表移除。请确认买家问题已经处理完成。`
            : ''
        }
        confirmLabel="确认解决"
        cancelLabel="继续处理"
        onConfirm={handleResolve}
        onCancel={() => {
          if (resolvingId === null) setResolveTarget(null);
        }}
      />
    </div>
  );
}
