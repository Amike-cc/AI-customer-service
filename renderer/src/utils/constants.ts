export interface ShopStateConfig {
  label: string;
  color: string;
  bgColor: string;
  active: boolean;
}

/** 平台主题配置：每个平台独立的主题色和标签 */
export interface PlatformThemeConfig {
  label: string;
  shortLabel: string;
  color: string;
  bgColor: string;
}

export const PLATFORM_THEMES: Record<string, PlatformThemeConfig> = {
  feige: {
    // feige 仅作为内部 ID 保留；面向用户的平台名统一为「抖店」
    label: '抖店',
    shortLabel: '抖店',
    color: '#ff2442',
    bgColor: 'rgba(255, 36, 66, 0.15)',
  },
  pinduoduo: {
    label: '拼多多',
    shortLabel: '拼多多',
    color: '#e02e24',
    bgColor: 'rgba(224, 46, 36, 0.15)',
  },
  kuaishou: {
    label: '快手小店',
    shortLabel: '快手小店',
    color: '#ff6a00',
    bgColor: 'rgba(255, 106, 0, 0.15)',
  },
  weixin: {
    label: '微信小店',
    shortLabel: '微信小店',
    color: '#07c160',
    bgColor: 'rgba(7, 193, 96, 0.15)',
  },
};

export function getPlatformTheme(platform: string): PlatformThemeConfig {
  return (
    PLATFORM_THEMES[platform] ?? {
      label: platform,
      shortLabel: platform,
      color: 'var(--accent)',
      bgColor: 'var(--accent-dim)',
    }
  );
}

export const SHOP_STATES: Record<string, ShopStateConfig> = {
  Healthy: { label: '健康', color: 'var(--success)', bgColor: 'var(--success-dim)', active: true },
  Degrading: { label: '降级', color: 'var(--warning)', bgColor: 'var(--warning-dim)', active: true },
  VisualMode: { label: '视觉模式', color: 'var(--info)', bgColor: 'var(--info-dim)', active: true },
  Recovering: { label: '恢复中', color: 'var(--warning)', bgColor: 'var(--warning-dim)', active: true },
  SilentWait: { label: '静默等待', color: 'var(--text-secondary)', bgColor: 'rgba(107,114,128,0.15)', active: false },
  Error: { label: '错误', color: 'var(--danger)', bgColor: 'var(--danger-dim)', active: false },
  ManualMode: { label: '手动模式', color: 'var(--text-secondary)', bgColor: 'rgba(107,114,128,0.15)', active: false },
};

export function getShopStateConfig(state: string | null): ShopStateConfig {
  if (!state) return { label: '未知', color: 'var(--text-muted)', bgColor: 'rgba(107,114,128,0.15)', active: false };
  return (
    SHOP_STATES[state] ?? { label: state, color: 'var(--text-muted)', bgColor: 'rgba(107,114,128,0.15)', active: false }
  );
}

export const LOG_LEVELS: Record<string, { label: string; color: string }> = {
  error: { label: 'ERROR', color: 'var(--danger)' },
  warn: { label: 'WARN', color: 'var(--warning)' },
  warning: { label: 'WARN', color: 'var(--warning)' },
  info: { label: 'INFO', color: 'var(--info)' },
  debug: { label: 'DEBUG', color: 'var(--text-muted)' },
  trace: { label: 'TRACE', color: 'var(--text-muted)' },
};

export const ALERT_LEVELS: Record<string, { label: string; color: string; bgColor: string }> = {
  critical: { label: '严重', color: 'var(--critical)', bgColor: 'var(--critical-dim)' },
  warn: { label: '警告', color: 'var(--warning)', bgColor: 'var(--warning-dim)' },
  info: { label: '信息', color: 'var(--info)', bgColor: 'var(--info-dim)' },
};

export const SETTINGS_TABS = [
  'config',
  'products',
  'rules',
  'knowledge',
  'logs',
  'sessions',
  'audit',
  'intent',
  'agents',
  'learning',
  'metrics',
  'health',
  'updates',
] as const;
export type SettingsTabKey = (typeof SETTINGS_TABS)[number];
