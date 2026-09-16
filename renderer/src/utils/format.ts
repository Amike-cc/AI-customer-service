export function formatTime(ts: number | string): string {
  const d = new Date(ts);
  return (
    d.toLocaleTimeString('zh-CN', { hour12: false }) +
    '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

export function formatDate(ts: number | string): string {
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { hour12: false });
}

export function formatRelative(ts: number | string): string {
  const now = Date.now();
  const t = new Date(ts).getTime();
  const diff = now - t;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
  if (diff < 604800000) return Math.floor(diff / 86400000) + '天前';
  return formatDate(ts);
}

export function formatNumber(n: number): string {
  if (n === undefined || n === null || isNaN(n)) return '0';
  return n.toLocaleString('en-US');
}

export function maskApiKey(key: string): string {
  if (!key) return '未配置';
  if (key.length <= 12) return '****';
  return key.slice(0, 8) + '*'.repeat(Math.max(0, key.length - 12)) + key.slice(-4);
}

export function truncate(str: string, maxLen: number): string {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}
