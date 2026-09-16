/**
 * 工作台布局纯函数（UI-WORKSPACE-001）
 *
 * 渲染层负责 Sidebar/右侧面板的实际渲染，主进程负责 WebContentsView 的 bounds。
 * 两者必须使用同一份计算逻辑，否则 WebContentsView 会盖住 React 区或产生空隙。
 * 这里集中放置纯函数，渲染层与主进程共同引用，并可在单元测试中直接验证。
 *
 * 设计基线（docs/开发文档-综合版.md §3.1）：
 *   - 1440 DIP 及以上：组合左侧栏 382，右侧面板 386
 *   - 1200–1439：组合左侧栏 382，右侧面板 320
 *   - 1000–1199：左侧栏折叠为 96，右侧面板默认收起，中央区至少 560
 *   - 中央区不足 MIN_CENTER_WIDTH 时收起右侧面板
 */
import appLayout from '../../shared/ui-layout.json';

export const SIDEBAR_WIDTH = appLayout.sidebarWidth;
export const TOPBAR_HEIGHT = appLayout.topbarHeight;
export const STATUSBAR_HEIGHT = appLayout.statusbarHeight;

export const RIGHT_PANEL_WIDTH_WIDE = 386;
export const RIGHT_PANEL_WIDTH_COMPACT = 320;
export const BREAKPOINT_WIDE = 1440;
export const BREAKPOINT_COMPACT = 1200;
export const COLLAPSED_SIDEBAR_WIDTH = 96;
export const MIN_CENTER_WIDTH = 560;

export interface WorkspaceLayout {
  sidebarWidth: number;
  rightPanelWidth: number;
  rightPanelVisible: boolean;
}

export interface WorkspaceLayoutState extends WorkspaceLayout {
  /** 视口低于 compact 断点：右侧面板默认收起 */
  compact: boolean;
}

/** 依据视口宽度和用户是否请求右侧面板，推导布局（渲染层与主进程共用） */
export function computeWorkspaceLayout(viewportWidth: number, rightPanelRequested: boolean): WorkspaceLayoutState {
  const compact = viewportWidth < BREAKPOINT_COMPACT;
  const sidebarWidth = compact ? COLLAPSED_SIDEBAR_WIDTH : SIDEBAR_WIDTH;
  const availableAfterSidebar = viewportWidth - sidebarWidth;

  let rightPanelWidth = 0;
  if (rightPanelRequested) {
    if (viewportWidth >= BREAKPOINT_WIDE) rightPanelWidth = RIGHT_PANEL_WIDTH_WIDE;
    else if (viewportWidth >= BREAKPOINT_COMPACT) rightPanelWidth = RIGHT_PANEL_WIDTH_COMPACT;
    else rightPanelWidth = 0;
  }
  let rightPanelVisible = rightPanelRequested && rightPanelWidth > 0;
  if (rightPanelVisible && availableAfterSidebar - rightPanelWidth < MIN_CENTER_WIDTH) {
    rightPanelVisible = false;
    rightPanelWidth = 0;
  }
  return { sidebarWidth, rightPanelWidth, rightPanelVisible, compact };
}

/** 计算中央 WebContentsView 的 bounds（主进程使用） */
export function computeViewBounds(
  width: number,
  height: number,
  layout: WorkspaceLayout,
): { x: number; y: number; width: number; height: number } {
  const availableAfterSidebar = width - layout.sidebarWidth;
  const wantRightPanel = layout.rightPanelVisible && layout.rightPanelWidth > 0;
  const rightPanelWidth =
    wantRightPanel && availableAfterSidebar - layout.rightPanelWidth >= MIN_CENTER_WIDTH ? layout.rightPanelWidth : 0;
  return {
    x: layout.sidebarWidth,
    y: TOPBAR_HEIGHT,
    width: Math.max(0, availableAfterSidebar - rightPanelWidth),
    height: Math.max(0, height - TOPBAR_HEIGHT - STATUSBAR_HEIGHT),
  };
}
