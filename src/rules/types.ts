export interface RuleInfo {
  name: string;
  pattern: string;
  answer: string;
  priority: number;
  enabled: boolean;
  source: 'default' | 'custom' | 'faq' | 'category' | 'shop_config' | 'platform_default';
}
