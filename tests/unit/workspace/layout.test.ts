/**
 * 工作台布局纯函数单元测试（UI-WORKSPACE-001）
 *
 * 渲染层与主进程共用这份计算，测试同时覆盖两侧关心的一致性约束：
 *   - 侧栏/右侧面板在不同窗口宽度下的宽度选择
 *   - 中央区不足最小宽度时收起右侧面板
 *   - WebContentsView bounds 不与右侧面板重叠
 */
import {
  computeWorkspaceLayout,
  computeViewBounds,
  SIDEBAR_WIDTH,
  COLLAPSED_SIDEBAR_WIDTH,
  RIGHT_PANEL_WIDTH_WIDE,
  RIGHT_PANEL_WIDTH_COMPACT,
  TOPBAR_HEIGHT,
  STATUSBAR_HEIGHT,
  MIN_CENTER_WIDTH,
} from '@/workspace/layout';

describe('computeWorkspaceLayout', () => {
  it('1440 及以上：组合侧栏与宽版右侧面板', () => {
    const layout = computeWorkspaceLayout(1600, true);
    expect(layout.sidebarWidth).toBe(SIDEBAR_WIDTH);
    expect(layout.rightPanelWidth).toBe(RIGHT_PANEL_WIDTH_WIDE);
    expect(layout.rightPanelVisible).toBe(true);
    expect(layout.compact).toBe(false);
  });

  it('1200–1439：右侧面板 320 且中央区保持最小宽度', () => {
    const layout = computeWorkspaceLayout(1300, true);
    expect(layout.rightPanelWidth).toBe(RIGHT_PANEL_WIDTH_COMPACT);
    expect(layout.rightPanelVisible).toBe(true);
  });

  it('1264 宽度仍显示右侧面板，避免接待控制区消失', () => {
    const layout = computeWorkspaceLayout(1264, true);
    expect(layout.rightPanelWidth).toBe(320);
    expect(layout.rightPanelVisible).toBe(true);
  });

  it('低于 1200：侧栏折叠、右侧面板收起', () => {
    const layout = computeWorkspaceLayout(1100, true);
    expect(layout.sidebarWidth).toBe(COLLAPSED_SIDEBAR_WIDTH);
    expect(layout.rightPanelVisible).toBe(false);
    expect(layout.rightPanelWidth).toBe(0);
    expect(layout.compact).toBe(true);
  });

  it('未请求右侧面板时不显示', () => {
    const layout = computeWorkspaceLayout(1600, false);
    expect(layout.rightPanelVisible).toBe(false);
    expect(layout.rightPanelWidth).toBe(0);
  });

  it('中央区不足最小宽度时收起右侧面板', () => {
    // 紧凑断点使用 320 DIP：382 + 560 + 320 - 1 时，中央区不足最小宽度。
    const layout = computeWorkspaceLayout(SIDEBAR_WIDTH + MIN_CENTER_WIDTH + RIGHT_PANEL_WIDTH_COMPACT - 1, true);
    expect(layout.rightPanelVisible).toBe(false);
  });
});

describe('computeViewBounds', () => {
  it('右侧面板可见时中央区让出面板宽度', () => {
    const layout = computeWorkspaceLayout(1600, true);
    const bounds = computeViewBounds(1600, 900, layout);
    expect(bounds.x).toBe(SIDEBAR_WIDTH);
    expect(bounds.y).toBe(TOPBAR_HEIGHT);
    // 中央区 + 右侧面板 = 除侧栏外的可用宽度，两者不重叠
    expect(bounds.width).toBe(1600 - SIDEBAR_WIDTH - RIGHT_PANEL_WIDTH_WIDE);
    expect(bounds.height).toBe(900 - TOPBAR_HEIGHT - STATUSBAR_HEIGHT);
  });

  it('右侧面板收起时中央区占满', () => {
    const layout = computeWorkspaceLayout(1600, false);
    const bounds = computeViewBounds(1600, 900, layout);
    expect(bounds.width).toBe(1600 - SIDEBAR_WIDTH);
  });

  it('窄窗口下不产生负宽度', () => {
    const layout = computeWorkspaceLayout(1000, true);
    const bounds = computeViewBounds(1000, 500, layout);
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThanOrEqual(0);
  });

  it('WebContentsView 与右侧面板不重叠（bounds 右边界 <= 面板左边界）', () => {
    const layout = computeWorkspaceLayout(1600, true);
    const bounds = computeViewBounds(1600, 900, layout);
    const panelLeft = 1600 - layout.rightPanelWidth;
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(panelLeft);
  });
});
