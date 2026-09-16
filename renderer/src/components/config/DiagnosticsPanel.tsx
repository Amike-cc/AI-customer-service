import { useState } from 'react';
import { Stethoscope, CheckCircle2, XCircle, AlertTriangle, SkipForward, Copy, MessageSquare, Activity, Gauge, Database, Cpu, Zap } from 'lucide-react';
import { Card } from '../common/Card';
import { Button } from '../common/Button';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { Select } from '../common/Select';
import { Input } from '../common/Input';
import { useToast } from '../common/Toast';
import { useShops } from '../../hooks/useShops';
import type { DiagnosticResult, DiagnosticSummary, AutoReplyDiagnosticReport, TestReplyResult, SystemHealthReport } from '../../types/api';
import styles from './DiagnosticsPanel.module.css';

const CATEGORY_LABELS: Record<string, string> = {
  config: '配置',
  python: 'Python 环境',
  models: '模型文件',
  files: '文件检查',
  runtime: '运行时',
};

const STATUS_ICONS = {
  pass: <CheckCircle2 size={16} className={styles.iconPass} />,
  fail: <XCircle size={16} className={styles.iconFail} />,
  warn: <AlertTriangle size={16} className={styles.iconWarn} />,
  skip: <SkipForward size={16} className={styles.iconSkip} />,
};

export function DiagnosticsPanel() {
  const [summary, setSummary] = useState<DiagnosticSummary | null>(null);
  const [running, setRunning] = useState(false);
  const toast = useToast();

  const runDiagnostics = async () => {
    setRunning(true);
    try {
      const result = await window.api.diagnose.run();
      setSummary(result);
      toast.show('success', `诊断完成: ${result.pass} 通过, ${result.warn} 警告, ${result.fail} 失败`);
    } catch (err) {
      toast.show('error', '诊断失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRunning(false);
    }
  };

  const copyReport = () => {
    if (!summary) return;
    const lines = [
      `系统诊断报告 - ${new Date(summary.runAt).toLocaleString()}`,
      `健康度: ${summary.healthScore}% (${summary.pass}通过/${summary.warn}警告/${summary.fail}失败/${summary.skip}跳过)`,
      '',
      ...summary.results.map((r) => [
        `[${r.status.toUpperCase()}] ${r.name}: ${r.message}`,
        r.detail ? `  详情:\n${r.detail.split('\n').map((line) => `    ${line}`).join('\n')}` : '',
        r.fixSuggestion ? `  修复建议: ${r.fixSuggestion}` : '',
      ].filter(Boolean).join('\n')),
    ];
    void (async () => {
      try {
        await navigator.clipboard.writeText(lines.join('\n'));
        toast.show('success', '诊断报告已复制到剪贴板');
      } catch {
        // 剪贴板写入失败（权限/失焦）时降级提示，不产生 unhandled rejection
        toast.show('error', '复制失败，请手动选择复制');
      }
    })();
  };

  return (
    <Card className={styles.section}>
      <div className={styles.header}>
        <Stethoscope size={16} />
        <h3>系统诊断</h3>
        <div className={styles.actions}>
          {summary && (
            <Button size="sm" onClick={copyReport}>
              <Copy size={12} />
              复制报告
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={runDiagnostics} loading={running}>
            <Stethoscope size={12} />
            {running ? '诊断中...' : '运行诊断'}
          </Button>
        </div>
      </div>

      {running && <LoadingSpinner size={24} />}

      {!running && summary && (
        <div className={styles.content}>
          <div className={styles.healthBar}>
            <div className={styles.healthScore} data-level={getHealthLevel(summary.healthScore)}>
              {summary.healthScore}%
            </div>
            <div className={styles.stats}>
              <span className={styles.statPass}>{summary.pass} 通过</span>
              <span className={styles.statWarn}>{summary.warn} 警告</span>
              <span className={styles.statFail}>{summary.fail} 失败</span>
              {summary.skip > 0 && <span className={styles.statSkip}>{summary.skip} 跳过</span>}
            </div>
          </div>
          <div className={styles.results}>
            {groupByCategory(summary.results).map(([cat, items]) => (
              <div key={cat} className={styles.category}>
                <div className={styles.categoryTitle}>{CATEGORY_LABELS[cat] ?? cat}</div>
                {items.map((r) => (
                  <DiagnosticItem key={r.id} result={r} />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {!running && !summary && (
        <div className={styles.placeholder}>
          点击"运行诊断"检查系统配置是否完整
        </div>
      )}

      <AutoReplyDiagnostics />
      <SystemHealthOverview />
    </Card>
  );
}

function AutoReplyDiagnostics() {
  const { shops } = useShops();
  const [selectedShopId, setSelectedShopId] = useState<string>('');
  const [report, setReport] = useState<AutoReplyDiagnosticReport | null>(null);
  const [testResult, setTestResult] = useState<TestReplyResult | null>(null);
  const [testMessage, setTestMessage] = useState('你好，这个商品有货吗？');
  const [checking, setChecking] = useState(false);
  const [testing, setTesting] = useState(false);
  const toast = useToast();

  const runCheck = async () => {
    if (!selectedShopId) {
      toast.show('warn', '请先选择店铺');
      return;
    }
    setChecking(true);
    setReport(null);
    try {
      const res = await window.api.diagnostic.checkAutoReply(selectedShopId);
      if (res.ok && res.report) {
        setReport(res.report);
        if (res.report.issues.length === 0) {
          toast.show('success', '自动回复配置正常');
        } else {
          toast.show('warn', `发现 ${res.report.issues.length} 个问题`);
        }
      } else {
        toast.show('error', '检查失败: ' + (res.error ?? '未知错误'));
      }
    } catch (err) {
      toast.show('error', '检查失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setChecking(false);
    }
  };

  const runTestReply = async () => {
    if (!selectedShopId) {
      toast.show('warn', '请先选择店铺');
      return;
    }
    if (!testMessage.trim()) {
      toast.show('warn', '请输入测试消息');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await window.api.diagnostic.testReply(selectedShopId, testMessage.trim());
      if (res.ok && res.result) {
        setTestResult(res.result);
        toast.show('success', '测试完成');
      } else {
        toast.show('error', '测试失败: ' + (res.error ?? '未知错误'));
      }
    } catch (err) {
      toast.show('error', '测试失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className={styles.autoReplySection}>
      <div className={styles.header}>
        <MessageSquare size={16} />
        <h3>自动回复诊断</h3>
      </div>

      <div className={styles.autoReplyControls}>
        <Select
          aria-label="选择自动回复诊断店铺"
          value={selectedShopId}
          onChange={(e) => {
            setSelectedShopId(e.target.value);
            setReport(null);
            setTestResult(null);
          }}
          options={[
            { value: '', label: shops.length === 0 ? '暂无可用店铺' : '选择店铺...' },
            ...shops.map((s) => ({ value: s.shopId, label: `${s.shopName} (${s.platform})` })),
          ]}
          disabled={shops.length === 0}
        />
        <Button variant="primary" size="sm" onClick={runCheck} loading={checking}>
          <Activity size={12} />
          {checking ? '检查中...' : '检查配置'}
        </Button>
      </div>

      {checking && <LoadingSpinner size={24} />}

      {!checking && report && (
        <div className={styles.autoReplyReport}>
          <div className={styles.reportHeader}>
            <strong>{report.shopName}</strong>
            <span className={styles.platformTag}>{report.platform}</span>
          </div>
          <div className={styles.reportGrid}>
            <div className={styles.reportItem} data-ok={report.autoReply}>
              <span className={styles.reportLabel}>自动回复</span>
              <span className={styles.reportValue}>{report.autoReply ? '已开启' : '已关闭'}</span>
            </div>
            <div className={styles.reportItem} data-ok={report.loginStatus === 'logged_in'}>
              <span className={styles.reportLabel}>登录状态</span>
              <span className={styles.reportValue}>{formatLoginStatus(report.loginStatus)}</span>
            </div>
            <div className={styles.reportItem} data-ok={report.apiKeyConfigured}>
              <span className={styles.reportLabel}>API Key</span>
              <span className={styles.reportValue}>{report.apiKeyConfigured ? report.apiKeyPreview : '未配置'}</span>
            </div>
            <div className={styles.reportItem} data-ok={report.hasShop}>
              <span className={styles.reportLabel}>店铺状态</span>
              <span className={styles.reportValue}>{report.hasShop ? `运行中（${formatState(report.state)}）` : '未启动'}</span>
            </div>
            <div className={styles.reportItem} data-ok={report.ruleCount > 0}>
              <span className={styles.reportLabel}>规则数量</span>
              <span className={styles.reportValue}>{report.ruleCount} 条</span>
            </div>
          </div>
          {report.issues.length > 0 && (
            <div className={styles.issuesList}>
              <div className={styles.issuesTitle}>
                <AlertTriangle size={14} />
                发现问题
              </div>
              {report.issues.map((issue, idx) => (
                <div key={idx} className={styles.issueItem}>
                  <XCircle size={12} />
                  {issue}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {report && report.hasShop && (
        <div className={styles.testReplySection}>
          <div className={styles.testReplyHeader}>
            <MessageSquare size={14} />
            <span>测试回复</span>
          </div>
          <div className={styles.safetyNote} role="note">仅生成回复预览和执行链路，不会向真实买家发送消息。</div>
          <div className={styles.testReplyInput}>
            <Input
              aria-label="自动回复诊断测试消息"
              value={testMessage}
              onChange={(e) => setTestMessage(e.target.value)}
              placeholder="输入测试消息..."
              maxLength={200}
            />
            <Button size="sm" onClick={runTestReply} loading={testing}>
              {testing ? '测试中...' : '测试'}
            </Button>
          </div>
          {testing && <LoadingSpinner size={20} />}
          {!testing && testResult && (
            <div className={styles.testResult}>
              <div className={styles.testReplyContent}>
                <span className={styles.reportLabel}>AI 回复：</span>
                <span>{testResult.reply || '(空)'}</span>
              </div>
              <div className={styles.testPipeline}>
                {testResult.pipeline.map((p, idx) => (
                  <div key={idx} className={styles.pipelineItem} data-status={p.status}>
                    {p.status === 'ok' ? <CheckCircle2 size={12} /> : p.status === 'fail' ? <XCircle size={12} /> : <SkipForward size={12} />}
                    <span>{p.step}</span>
                    {p.detail && <span className={styles.pipelineDetail}>{p.detail}</span>}
                  </div>
                ))}
              </div>
              <div className={styles.testStats}>
                <span>耗时: {testResult.latencyMs}ms</span>
                <span>Token: {testResult.tokenInput}/{testResult.tokenOutput}</span>
                {testResult.matchedRule && <span>规则: {testResult.matchedRule}</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SystemHealthOverview() {
  const [health, setHealth] = useState<SystemHealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const toast = useToast();

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await window.api.diagnostic.systemHealth();
      if (res.ok && res.health) {
        setHealth(res.health);
        setLastUpdatedAt(Date.now());
      } else {
        toast.show('error', '获取系统健康概览失败: ' + (res.error ?? '未知错误'));
      }
    } catch (err) {
      toast.show('error', '获取系统健康概览失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const formatUptime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  return (
    <div className={styles.autoReplySection}>
      <div className={styles.header}>
        <Gauge size={16} />
        <h3>系统健康概览</h3>
        {lastUpdatedAt && <span className={styles.updatedAt}>最后更新 {new Date(lastUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>}
        <div className={styles.actions}>
          <Button variant="primary" size="sm" onClick={refresh} loading={loading}>
            <Activity size={12} />
            {loading ? '获取中...' : '刷新'}
          </Button>
        </div>
      </div>

      {loading && <LoadingSpinner size={24} />}

      {!loading && health && (
        <div className={styles.healthOverview}>
          <div className={styles.healthGroup}>
            <div className={styles.healthGroupTitle}>
              <Cpu size={14} />
              运行时
            </div>
            <div className={styles.healthGrid}>
              <div className={styles.healthMetric}>
                <span className={styles.reportLabel}>运行时长</span>
                <span className={styles.reportValue}>{formatUptime(health.uptime)}</span>
              </div>
              <div className={styles.healthMetric}>
                <span className={styles.reportLabel}>PID</span>
                <span className={styles.reportValue}>{health.pid}</span>
              </div>
              <div className={styles.healthMetric}>
                <span className={styles.reportLabel}>堆内存</span>
                <span className={styles.reportValue}>{formatBytes(health.memory.heapUsed)} / {formatBytes(health.memory.heapTotal)}</span>
              </div>
              <div className={styles.healthMetric}>
                <span className={styles.reportLabel}>RSS</span>
                <span className={styles.reportValue}>{formatBytes(health.memory.rss)}</span>
              </div>
            </div>
          </div>

          <div className={styles.healthGroup}>
            <div className={styles.healthGroupTitle}>
              <Database size={14} />
              数据库
            </div>
            <div className={styles.healthGrid}>
              <div className={styles.healthMetric}>
                <span className={styles.reportLabel}>WAL 模式</span>
                <span className={styles.reportValue} data-ok={health.database.walMode === 'wal'}>
                  {health.database.walMode}
                </span>
              </div>
              <div className={styles.healthMetric}>
                <span className={styles.reportLabel}>数据库大小</span>
                <span className={styles.reportValue}>{formatBytes(health.database.dbSizeBytes)}</span>
              </div>
              {Object.entries(health.database.tableCounts).map(([table, count]) => (
                <div key={table} className={styles.healthMetric}>
                  <span className={styles.reportLabel}>{table}</span>
                  <span className={styles.reportValue}>{count >= 0 ? `${count} 行` : 'N/A'}</span>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.healthGroup}>
            <div className={styles.healthGroupTitle}>
              <Zap size={14} />
              缓存 & API
            </div>
            <div className={styles.healthGrid}>
              <div className={styles.healthMetric}>
                <span className={styles.reportLabel}>缓存条目</span>
                <span className={styles.reportValue}>{health.cache.totalEntries}</span>
              </div>
              <div className={styles.healthMetric}>
                <span className={styles.reportLabel}>缓存命中次数</span>
                <span className={styles.reportValue}>{health.cache.totalHitCount}</span>
              </div>
              <div className={styles.healthMetric}>
                <span className={styles.reportLabel}>API Key</span>
                <span className={styles.reportValue} data-ok={health.deepseek.apiKeyConfigured}>
                  {health.deepseek.apiKeyConfigured ? '已配置' : '未配置'}
                </span>
              </div>
              <div className={styles.healthMetric}>
                <span className={styles.reportLabel}>熔断器状态</span>
                <span
                  className={styles.reportValue}
                  data-ok={health.deepseek.circuitState === 'closed'}
                >
                  {health.deepseek.circuitState === 'closed'
                    ? '正常'
                    : health.deepseek.circuitState === 'half-open'
                      ? '半开（恢复中）'
                      : '已熔断'}
                </span>
              </div>
              {health.deepseek.circuitState !== 'closed' && (
                <div className={styles.healthMetric}>
                  <span className={styles.reportLabel}>连续失败次数</span>
                  <span className={styles.reportValue}>{health.deepseek.consecutiveFailures}</span>
                </div>
              )}
            </div>
          </div>

          <div className={styles.healthGroup}>
            <div className={styles.healthGroupTitle}>
              <Activity size={14} />
              过去 1 小时指标
            </div>
            <div className={styles.healthGrid}>
              <div className={styles.healthMetric}>
                <span className={styles.reportLabel}>API 调用</span>
                <span className={styles.reportValue}>{health.metrics.apiCalls}</span>
              </div>
              <div className={styles.healthMetric}>
                <span className={styles.reportLabel}>接收消息</span>
                <span className={styles.reportValue}>{health.metrics.messagesReceived}</span>
              </div>
              <div className={styles.healthMetric}>
                <span className={styles.reportLabel}>发送回复</span>
                <span className={styles.reportValue}>{health.metrics.repliesSent}</span>
              </div>
              <div className={styles.healthMetric}>
                <span className={styles.reportLabel}>回复失败</span>
                <span className={styles.reportValue} data-ok={health.metrics.replyFailed === 0}>
                  {health.metrics.replyFailed}
                </span>
              </div>
              <div className={styles.healthMetric}>
                <span className={styles.reportLabel}>敏感词拦截</span>
                <span className={styles.reportValue}>{health.metrics.sensitiveBlocked}</span>
              </div>
              <div className={styles.healthMetric}>
                <span className={styles.reportLabel}>平均 API 延迟</span>
                <span className={styles.reportValue}>{health.metrics.avgApiLatency.toFixed(0)}ms</span>
              </div>
            </div>
          </div>

          <div className={styles.healthGroup}>
            <div className={styles.healthGroupTitle}>
              <MessageSquare size={14} />
              店铺状态 ({health.shops.length})
            </div>
            <div className={styles.shopHealthList}>
              {health.shops.map((s) => (
                <div key={s.shopId} className={styles.shopHealthItem}>
                  <span className={styles.shopHealthName}>{s.shopName}</span>
                  <span className={styles.platformTag}>{s.platform}</span>
                  <span className={styles.shopHealthState} data-ok={s.state === 'Healthy'}>
                    {formatState(s.state)}
                  </span>
                  <span className={styles.shopHealthLogin} data-ok={s.loginStatus === 'logged_in'}>
                    {formatLoginStatus(s.loginStatus)}
                  </span>
                  <span className={styles.shopHealthAuto} data-ok={s.autoReply}>
                    {s.autoReply ? '自动回复' : '手动'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {!loading && !health && (
        <div className={styles.placeholder}>
          点击"刷新"获取系统健康概览
        </div>
      )}
    </div>
  );
}

function DiagnosticItem({ result }: { result: DiagnosticResult }) {
  return (
    <div className={styles.item} data-status={result.status}>
      <div className={styles.itemHeader}>
        {STATUS_ICONS[result.status]}
        <span className={styles.itemName}>{result.name}</span>
        <span className={styles.itemMessage}>{result.message}</span>
      </div>
      {result.detail && <div className={styles.itemDetail}>{result.detail}</div>}
      {result.fixSuggestion && (
        <div className={styles.itemFix}>
          <AlertTriangle size={12} />
          {result.fixSuggestion}
        </div>
      )}
    </div>
  );
}

function getHealthLevel(score: number): 'good' | 'medium' | 'bad' {
  if (score >= 80) return 'good';
  if (score >= 50) return 'medium';
  return 'bad';
}

function formatLoginStatus(status: string): string {
  if (status === 'logged_in') return '已登录';
  if (status === 'logging_in') return '登录中';
  return '未登录';
}

function formatState(state: string | null | undefined): string {
  const labels: Record<string, string> = {
    Healthy: '健康',
    Degrading: '降级运行',
    VisualMode: '视觉模式',
    SilentWait: '静默等待',
    ManualMode: '人工模式',
    Error: '异常',
    Stopped: '已停止',
  };
  return state ? (labels[state] ?? state) : '未启动';
}

function groupByCategory(results: DiagnosticResult[]): Array<[string, DiagnosticResult[]]> {
  const groups = new Map<string, DiagnosticResult[]>();
  for (const r of results) {
    if (!groups.has(r.category)) groups.set(r.category, []);
    groups.get(r.category)!.push(r);
  }
  return Array.from(groups.entries());
}
