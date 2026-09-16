import { useEffect } from 'react';
import { useToast } from './Toast';

/** 角色中文名映射（与 src/tools/types.ts 的 AGENT_ROLE_NAMES 保持一致） */
const ROLE_NAMES: Record<string, string> = {
  after_sales: '售后专员',
  logistics: '物流专员',
  pre_sales: '售前专员',
  general: '通用客服',
};

/**
 * 转接失败原因 → 中文文案映射
 *
 * 飞鸽新版 UI（2026-07）已移除 i-icon-transfer 图标，所有 transferToAgent 调用
 * 都会返回 'no-transfer-icon'，自动降级为通用人工接管（manualTakeover）。
 * 其他平台不支持页面级转接，会返回 'platform-not-supported'。
 */
const FAILURE_REASON_LABELS: Record<string, string> = {
  'no-transfer-icon': '飞鸽新版页面无转接图标（已下线该功能）',
  'icon-not-visible': '转接图标不可见',
  'drawer-load-timeout': '转接抽屉加载超时',
  'drawer-not-found': '转接抽屉未找到',
  'no-search-input': '搜索框未找到',
  'search-input-failed': '搜索框输入失败',
  'agent-not-found': '目标客服未找到',
  'no-confirm-button': '确认按钮未找到',
  'confirm-failed': '确认按钮点击失败',
  'verify-failed': '转接验证失败',
  'platform-not-supported': '当前平台不支持页面级转接',
  'no-mapping': '未配置该角色的客服账号映射',
  'no-webview': 'Webview 不可用',
  'exception': '执行异常',
};

/**
 * 全局转接事件通知器
 *
 * 监听 main 进程的 transfer:success / transfer:failed 事件，显示 Toast 通知。
 * 必须放在 ToastProvider 内部使用（调用 useToast）。
 *
 * 通知效果：
 * - 转接成功：绿色 Toast「已自动转接到 [专员角色]（[客服账号名]），AI 自动回复已暂停」
 * - 转接失败：黄色 Toast「转接失败：[中文原因]，已降级为人工接管」
 */
export function TransferNotifier() {
  const toast = useToast();

  useEffect(() => {
    const unsubscribe = window.api.shop.onTransferEvent((data) => {
      const roleName = ROLE_NAMES[data.role ?? ''] ?? '人工客服';
      if (data.type === 'success') {
        toast.show(
          'success',
          `已自动转接到${roleName}（${data.agentName ?? '未知客服'}），AI 自动回复已暂停`,
        );
      } else {
        const reasonLabel = FAILURE_REASON_LABELS[data.reason ?? ''] ?? data.reason ?? '未知错误';
        toast.show(
          'warn',
          `转接失败：${reasonLabel}，已降级为人工接管`,
        );
      }
    });
    return unsubscribe;
  }, [toast]);

  return null;
}
