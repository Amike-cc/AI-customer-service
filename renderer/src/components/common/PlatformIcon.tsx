import { SiTiktok, SiWechat, SiKuaishou } from 'react-icons/si';
import { Store } from 'lucide-react';

/**
 * 平台品牌图标统一组件。
 *
 * 设计取舍：
 * - feige → SiTiktok（飞鸽是抖音电商客服工具，故使用抖音/TikTok 品牌图标）
 * - weixin → SiWechat（微信）
 * - kuaishou → SiKuaishou（快手）
 * - pinduoduo → 自定义 SVG「拼」字图标
 *   （simple-icons 库未收录拼多多，已验证 pinduoduo/pdd/temu/duoduo 等 slug 均 404；
 *    11px 极小尺寸下单汉字比缩小 logo 更清晰，且无外部依赖）
 * - 其他未知平台 → lucide Store 图标（与 Sidebar 顶部图标风格一致）
 *
 * 颜色处理：组件内部不传 color，让 react-icons 默认使用 currentColor 继承父级
 * （调用方 Sidebar/ProductManager/RuleManager 已通过 style={{color: theme.color}} 设置）。
 */

export type PlatformId = string;

interface PlatformIconProps {
  platform: PlatformId;
  /** 图标尺寸（像素）。默认 11，适配 Sidebar .platformTag 16px 高度。
   *  对于 24px 高度的 .platformBadge，建议传入 14。 */
  size?: number;
  className?: string;
}

export function PlatformIcon({ platform, size = 11, className }: PlatformIconProps) {
  switch (platform) {
    case 'feige':
      return <SiTiktok size={size} className={className} />;
    case 'weixin':
      return <SiWechat size={size} className={className} />;
    case 'kuaishou':
      return <SiKuaishou size={size} className={className} />;
    case 'pinduoduo':
      return <PinduoduoLogo size={size} className={className} />;
    default:
      return <Store size={size} className={className} />;
  }
}

/**
 * 拼多多品牌 logo 替代：圆角红方块 + 白色「拼」字。
 *
 * simple-icons 库无 pinduoduo slug，故采用内联 SVG 实现：
 * - 红色固定为 #e02e24（与 PLATFORM_THEMES.pinduoduo.color 一致，不继承父级 color，
 *   因为拼多多图标本身就是品牌色块+白字，颜色不应该随主题切换）
 * - viewBox 24x24，文字 fontSize=14 居中渲染
 * - 字体优先 PingFang SC（macOS）/Microsoft YaHei（Windows），跨平台兼容
 */
function PinduoduoLogo({ size = 11, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-label="拼多多"
      role="img"
      className={className}
    >
      <rect x="2" y="2" width="20" height="20" rx="5" fill="#e02e24" />
      <text
        x="12"
        y="12"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="14"
        fontWeight="700"
        fill="#ffffff"
        fontFamily="'PingFang SC', 'Microsoft YaHei', sans-serif"
      >
        拼
      </text>
    </svg>
  );
}
