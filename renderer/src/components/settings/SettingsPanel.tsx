import { useState, useEffect, useRef, lazy, Suspense, type KeyboardEvent } from 'react';
import {
  Settings as SettingsIcon,
  Package,
  ListChecks,
  BookOpen,
  ScrollText,
  MessagesSquare,
  FileText,
  Brain,
  Users,
  BarChart3,
  Sparkles,
  Heart,
  DownloadCloud,
} from 'lucide-react';
import type { ShopListItem } from '../../types/api';
import type { SettingsTabKey } from '../../utils/constants';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { LoadingSpinner } from '../common/LoadingSpinner';
import styles from './SettingsPanel.module.css';

const ConfigPanel = lazy(() => import('../config/ConfigPanel').then((m) => ({ default: m.ConfigPanel })));
const ProductManager = lazy(() => import('../products/ProductManager').then((m) => ({ default: m.ProductManager })));
const RuleManager = lazy(() => import('../rules/RuleManager').then((m) => ({ default: m.RuleManager })));
const KnowledgeBase = lazy(() => import('../knowledge/KnowledgeBase').then((m) => ({ default: m.KnowledgeBase })));
const LogAlertPanel = lazy(() => import('../logs/LogAlertPanel').then((m) => ({ default: m.LogAlertPanel })));
const SessionViewer = lazy(() => import('../sessions/SessionViewer').then((m) => ({ default: m.SessionViewer })));
const AuditLogViewer = lazy(() => import('../audit/AuditLogViewer').then((m) => ({ default: m.AuditLogViewer })));
const IntentPanel = lazy(() => import('../analytics/IntentPanel').then((m) => ({ default: m.IntentPanel })));
const AgentPanel = lazy(() => import('../analytics/AgentPanel').then((m) => ({ default: m.AgentPanel })));
const LearningPanel = lazy(() => import('../learning/LearningPanel').then((m) => ({ default: m.LearningPanel })));
const MetricsPanel = lazy(() => import('../analytics/MetricsPanel').then((m) => ({ default: m.MetricsPanel })));
const HealthDashboard = lazy(() => import('../monitor/HealthDashboard').then((m) => ({ default: m.HealthDashboard })));
const UpdatePanel = lazy(() => import('./UpdatePanel').then((m) => ({ default: m.UpdatePanel })));

const PanelFallback = () => (
  <div className={styles.panelFallback} role="status" aria-label="正在加载设置页面">
    <LoadingSpinner size={28} />
    <span>正在加载模块…</span>
  </div>
);

interface SettingsPanelProps {
  shops: ShopListItem[];
  /** 从工作台侧栏进入指定管理模块时使用；未传入时沿用上次本地选择。 */
  initialTab?: SettingsTabKey;
}

type SettingsGroup = '业务配置' | '服务运营' | '系统治理';

interface TabConfig {
  key: SettingsTabKey;
  label: string;
  description: string;
  group: SettingsGroup;
  icon: React.ReactNode;
}

const TAB_CONFIG: TabConfig[] = [
  { key: 'config', label: '系统配置', description: '模型与数据维护', group: '业务配置', icon: <SettingsIcon size={16} /> },
  { key: 'products', label: '商品管理', description: '商品资料、同步与推荐', group: '业务配置', icon: <Package size={16} /> },
  { key: 'rules', label: '规则引擎', description: '快捷规则与回复测试', group: '业务配置', icon: <ListChecks size={16} /> },
  { key: 'knowledge', label: '知识库', description: '话术、FAQ 与内容治理', group: '业务配置', icon: <BookOpen size={16} /> },
  { key: 'sessions', label: '会话查看', description: '历史会话与消息检索', group: '服务运营', icon: <MessagesSquare size={16} /> },
  { key: 'intent', label: '意图分析', description: '咨询意图与升级趋势', group: '服务运营', icon: <Brain size={16} /> },
  { key: 'agents', label: '人工坐席', description: '坐席状态与待接队列', group: '服务运营', icon: <Users size={16} /> },
  { key: 'learning', label: '学习系统', description: '反馈学习与模式沉淀', group: '服务运营', icon: <Sparkles size={16} /> },
  { key: 'logs', label: '日志告警', description: '运行日志与实时告警', group: '系统治理', icon: <ScrollText size={16} /> },
  { key: 'audit', label: '审计日志', description: '关键操作与回复审计', group: '系统治理', icon: <FileText size={16} /> },
  { key: 'metrics', label: '运营指标', description: '服务数据与趋势洞察', group: '系统治理', icon: <BarChart3 size={16} /> },
  { key: 'updates', label: '软件更新', description: '检查版本与安装更新', group: '系统治理', icon: <DownloadCloud size={16} /> },
  { key: 'health', label: '健康监控', description: '店铺和服务实时状态', group: '系统治理', icon: <Heart size={16} /> },
];

const TAB_GROUPS: SettingsGroup[] = ['业务配置', '服务运营', '系统治理'];

export function SettingsPanel({ shops, initialTab = 'config' }: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTabKey>(initialTab);
  const tabListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initialTab !== 'config') {
      setActiveTab(initialTab);
      localStorage.setItem('settingsTab', initialTab);
      return;
    }
    const saved = localStorage.getItem('settingsTab') as SettingsTabKey | null;
    if (saved && TAB_CONFIG.some((t) => t.key === saved)) {
      setActiveTab(saved);
    }
  }, [initialTab]);

  const handleTabChange = (tab: SettingsTabKey) => {
    setActiveTab(tab);
    localStorage.setItem('settingsTab', tab);
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const tabs = Array.from(tabListRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const currentIndex = tabs.indexOf(event.currentTarget);
    if (currentIndex < 0) return;

    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = TAB_CONFIG[nextIndex];
    handleTabChange(nextTab.key);
    tabs[nextIndex]?.focus();
  };

  return (
    <div className={styles.container}>
      <aside className={styles.navigation} aria-label="管理中心导航">
        <div className={styles.navigationHeader}>
          <span className={styles.eyebrow}>CONTROL CENTER</span>
          <h1>管理中心</h1>
          <p>配置客服能力并查看服务运行状态</p>
        </div>
        <div className={styles.tabList} ref={tabListRef} role="tablist" aria-label="管理中心模块">
          {TAB_GROUPS.map((group) => (
            <div className={styles.tabGroup} key={group}>
              <span className={styles.groupLabel}>{group}</span>
              <div className={styles.groupItems}>
                {TAB_CONFIG.filter((tab) => tab.group === group).map((tab) => (
                  <button
                    key={tab.key}
                    id={`settings-tab-${tab.key}`}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab.key}
                    aria-controls={`settings-panel-${tab.key}`}
                    tabIndex={activeTab === tab.key ? 0 : -1}
                    className={[styles.tab, activeTab === tab.key && styles.active].filter(Boolean).join(' ')}
                    onClick={() => handleTabChange(tab.key)}
                    onKeyDown={handleTabKeyDown}
                  >
                    <span className={styles.tabIcon}>{tab.icon}</span>
                    <span className={styles.tabCopy}>
                      <span className={styles.tabLabel}>{tab.label}</span>
                      <span className={styles.tabDescription}>{tab.description}</span>
                    </span>
                    <span className={styles.activeIndicator} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className={styles.navigationFooter}>
          <span>13 个核心模块</span>
          <span className={styles.footerDot} />
          <span>配置自动保存</span>
        </div>
      </aside>
      <section
        className={styles.workspace}
        id={`settings-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`settings-tab-${activeTab}`}
        tabIndex={0}
      >
        <div className={styles.content} key={activeTab}>
          <ErrorBoundary>
            <Suspense fallback={<PanelFallback />}>
              {activeTab === 'config' && <ConfigPanel />}
              {activeTab === 'products' && <ProductManager shops={shops} />}
              {activeTab === 'rules' && <RuleManager shops={shops} />}
              {activeTab === 'knowledge' && <KnowledgeBase shops={shops} />}
              {activeTab === 'logs' && <LogAlertPanel />}
              {activeTab === 'sessions' && <SessionViewer shops={shops} />}
              {activeTab === 'audit' && <AuditLogViewer shops={shops} />}
              {activeTab === 'intent' && <IntentPanel shops={shops} />}
              {activeTab === 'agents' && <AgentPanel shops={shops} />}
              {activeTab === 'learning' && <LearningPanel shops={shops} />}
              {activeTab === 'metrics' && <MetricsPanel shops={shops} />}
              {activeTab === 'health' && <HealthDashboard shops={shops} />}
              {activeTab === 'updates' && <UpdatePanel />}
            </Suspense>
          </ErrorBoundary>
        </div>
      </section>
    </div>
  );
}
