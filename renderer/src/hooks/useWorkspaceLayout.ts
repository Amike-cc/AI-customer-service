import { useCallback, useEffect, useRef, useState } from 'react';
import {
  computeWorkspaceLayout,
  BREAKPOINT_WIDE,
  type WorkspaceLayoutState,
} from '../../../src/workspace/layout';

export type { WorkspaceLayoutState };
export { computeWorkspaceLayout };

/**
 * 工作台布局协调器。
 *
 * 布局计算集中在 src/workspace/layout.ts（渲染层与主进程共用同一份逻辑）。
 * 本 Hook 负责按窗口宽度重算并把结果上报主进程（workspace:setLayout），
 * 使主进程能为 WebContentsView 计算出与 React 区一致的 bounds。
 */
export function useWorkspaceLayout(requested: boolean) {
  const [layout, setLayout] = useState<WorkspaceLayoutState>(() =>
    computeWorkspaceLayout(
      typeof window === 'undefined' ? BREAKPOINT_WIDE : window.innerWidth,
      requested,
    ),
  );
  const lastSentRef = useRef<string>('');

  const sync = useCallback(() => {
    const width = typeof window === 'undefined' ? BREAKPOINT_WIDE : window.innerWidth;
    const next = computeWorkspaceLayout(width, requested);
    setLayout(next);
    // 上报主进程；去重避免 resize 抖动造成 IPC 风暴
    const key = `${next.sidebarWidth}|${next.rightPanelWidth}|${next.rightPanelVisible}`;
    if (key !== lastSentRef.current) {
      lastSentRef.current = key;
      void window.api.workspace?.setLayout?.({
        sidebarWidth: next.sidebarWidth,
        rightPanelWidth: next.rightPanelWidth,
        rightPanelVisible: next.rightPanelVisible,
      });
    }
  }, [requested]);

  useEffect(() => {
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [sync]);

  return layout;
}
