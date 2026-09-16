/**
 * 多 LLM Provider 配置面板
 *
 * 在全局设置中管理 7 个大模型提供商（DeepSeek / Qwen / OpenAI / Claude / Kimi / GLM / Baichuan）
 * - 查看 / 修改 enabled、tier、model、api_url、timeout_ms
 * - 单独设置 / 测试每个 provider 的 API Key（DPAPI 加密存储）
 * - 设为默认 provider
 * - 测试 provider 连接（healthCheck）
 *
 * 注意：enabled / tier / model / api_url / timeout_ms 的修改写入
 * data/llm_provider_overrides.json，需重启软件生效。
 * API Key 修改立即生效（deepseek）或需重启生效（其他 provider）。
 *
 * 2026-07：移除 Ollama 本地模型支持（用户明确不需要），从 8 个 provider 减为 7 个。
 */
import { useEffect, useState, useCallback } from 'react';
import {
  ChevronDown,
  ChevronRight,
  KeyRound,
  Eye,
  EyeOff,
  ExternalLink,
  Save,
  TestTube,
  RotateCcw,
  Star,
  Boxes,
} from 'lucide-react';
import { Card } from '../common/Card';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { Badge } from '../common/Badge';
import { useToast } from '../common/Toast';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { ConfirmDialog } from '../common/ConfirmDialog';
import type {
  LlmProviderInfo,
  LlmProvidersResult,
  ProviderType,
  ModelTier,
  ProviderOverride,
} from '../../types/api';
import styles from './LlmProvidersPanel.module.css';

const PROVIDER_ICON: Record<ProviderType, string> = {
  deepseek: '🧠',
  qwen: '🌐',
  openai: '✨',
  claude: '🎭',
  kimi: '🌙',
  glm: '⚡',
  baichuan: '🏔️',
};

const TIER_LABEL: Record<ModelTier, string> = {
  tier1: 'Tier1·本地/低延迟',
  tier2: 'Tier2·中等',
  tier3: 'Tier3·高质量',
};

type ConfirmAction = 'disable' | 'set-default' | 'reset';

function collectProviderUpdates(draft: ProviderOverride): ProviderOverride {
  const updates: ProviderOverride = {};
  if (typeof draft.enabled === 'boolean') updates.enabled = draft.enabled;
  if (draft.tier) updates.tier = draft.tier;
  if (typeof draft.model === 'string' && draft.model.trim()) updates.model = draft.model.trim();
  if (typeof draft.api_url === 'string' && draft.api_url.trim()) updates.api_url = draft.api_url.trim();
  if (typeof draft.timeout_ms === 'number' && draft.timeout_ms > 0) updates.timeout_ms = draft.timeout_ms;
  return updates;
}

export function LlmProvidersPanel() {
  const [data, setData] = useState<LlmProvidersResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<ProviderType | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const result = await window.api.config.getLlmProviders();
      setData(result);
    } catch (err) {
      toast.show('error', '加载 LLM Provider 列表失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner size={28} />;
  if (!data || !data.ok || !data.providers) {
    return <div className={styles.emptyState}>加载失败：{data?.error ?? '未知错误'}</div>;
  }

  const providerCount = data.providers.length;
  const enabledCount = data.providers.filter((p) => p.enabled).length;
  const registeredCount = data.providers.filter((p) => p.registered).length;

  return (
    <Card className={styles.section}>
      <div className={styles.header}>
        <Boxes size={16} />
        <h3>大模型配置</h3>
        <span className={styles.headerHint}>共 {providerCount} 个 Provider 可选</span>
      </div>

      <div className={styles.summary}>
        <div className={styles.summaryItem}>
          <span className={styles.label}>默认主用:</span>
          <span className={styles.value}>{data.providers.find((p) => p.isDefault)?.label ?? data.defaultProvider}</span>
        </div>
        <div className={styles.summaryItem}>
          <span className={styles.label}>已启用:</span>
          <span className={styles.value}>{enabledCount}/{providerCount}</span>
        </div>
        <div className={styles.summaryItem}>
          <span className={styles.label}>已注册:</span>
          <span className={styles.value}>{registeredCount}/{providerCount}</span>
        </div>
        {data.cascade?.enabled && (
          <div className={styles.summaryItem}>
            <span className={styles.label}>级联模式:</span>
            <span className={styles.value}>开启（按置信度自动切换）</span>
          </div>
        )}
      </div>

      <div className={styles.providerList}>
        {data.providers.map((p) => (
          <ProviderCard
            key={p.type}
            provider={p}
            expanded={expanded === p.type}
            onToggleExpand={() => setExpanded((cur) => (cur === p.type ? null : p.type))}
            onChanged={load}
          />
        ))}
      </div>
    </Card>
  );
}

interface ProviderCardProps {
  provider: LlmProviderInfo;
  expanded: boolean;
  onToggleExpand: () => void;
  onChanged: () => void;
}

function ProviderCard({ provider, expanded, onToggleExpand, onChanged }: ProviderCardProps) {
  const toast = useToast();
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
  const [toggling, setToggling] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);
  const [advanced, setAdvanced] = useState<ProviderOverride>({});
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const baseId = `llm-provider-${provider.type}`;
  const toggleId = `${baseId}-toggle`;
  const detailsId = `${baseId}-details`;
  const switchHintId = `${baseId}-switch-hint`;
  const defaultHintId = `${baseId}-default-hint`;
  const tierHintId = `${baseId}-tier-hint`;
  const apiKeyId = `${baseId}-api-key`;
  const apiKeyHintId = `${baseId}-api-key-hint`;
  const testResultId = `${baseId}-test-result`;
  const modelId = `${baseId}-model`;
  const timeoutId = `${baseId}-timeout`;
  const apiUrlId = `${baseId}-api-url`;
  const pendingUpdates = collectProviderUpdates(advanced);
  const hasAdvancedChanges = Object.keys(pendingUpdates).length > 0;
  const defaultUnavailableReason = !provider.enabled
    ? '请先启用此 Provider，再将其设为默认。'
    : !provider.apiKeyConfigured && !provider.registered
      ? '请先配置可用的 API Key，再将其设为默认。'
      : null;
  const blocksDisable = provider.enabled && provider.isDefault;

  const handleSaveApiKey = async () => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed) {
      toast.show('warn', '请输入 API Key');
      return;
    }
    setSaving(true);
    try {
      const result = await window.api.config.updateLlmApiKey(provider.type, trimmed);
      if (result.ok) {
        toast.show('success', `${provider.label} API Key 已保存${result.requiresRestart ? '，重启后生效' : ''}`);
        setApiKeyInput('');
        onChanged();
      } else {
        toast.show('error', '保存失败: ' + (result.error ?? '未知错误'));
      }
    } catch (err) {
      toast.show('error', '保存失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.api.config.testLlmProvider(provider.type);
      setTestResult({ ok: result.ok, message: result.message, latencyMs: result.latencyMs });
      if (result.ok) {
        toast.show('success', `${provider.label} 连接成功（${result.latencyMs}ms）`);
      } else {
        toast.show('warn', `${provider.label} 测试失败: ${result.message}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestResult({ ok: false, message: msg, latencyMs: 0 });
      toast.show('error', '测试失败: ' + msg);
    } finally {
      setTesting(false);
    }
  };

  const updateEnabled = async (enabled: boolean) => {
    setToggling(true);
    try {
      const result = await window.api.config.updateLlmProvider(provider.type, {
        enabled,
      });
      if (result.ok) {
        toast.show(
          'success',
          `${provider.label} 已${enabled ? '启用' : '禁用'}，重启后生效`,
        );
        onChanged();
      } else {
        toast.show('error', '操作失败: ' + (result.error ?? '未知错误'));
      }
    } catch (err) {
      toast.show('error', '操作失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setToggling(false);
    }
  };

  const requestToggleEnabled = () => {
    if (toggling) return;
    if (!provider.enabled) {
      void updateEnabled(true);
      return;
    }
    if (provider.isDefault) {
      toast.show('warn', '当前默认 Provider 不能直接禁用，请先将其他已启用 Provider 设为默认');
      return;
    }
    setConfirmAction('disable');
  };

  const setAsDefault = async () => {
    setSettingDefault(true);
    try {
      const result = await window.api.config.setDefaultLlmProvider(provider.type);
      if (result.ok) {
        toast.show('success', `${provider.label} 已设为默认 provider，重启后生效`);
        onChanged();
      } else {
        toast.show('error', '设置失败: ' + (result.error ?? '未知错误'));
      }
    } catch (err) {
      toast.show('error', '设置失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSettingDefault(false);
    }
  };

  const requestSetDefault = () => {
    if (provider.isDefault || settingDefault) return;
    if (defaultUnavailableReason) {
      toast.show('warn', defaultUnavailableReason);
      return;
    }
    setConfirmAction('set-default');
  };

  const handleSaveAdvanced = async () => {
    setSaving(true);
    try {
      const updates = collectProviderUpdates(advanced);
      if (Object.keys(updates).length === 0) {
        toast.show('warn', '没有需要保存的变更');
        return;
      }
      const result = await window.api.config.updateLlmProvider(provider.type, updates);
      if (result.ok) {
        toast.show('success', `${provider.label} 配置已更新，重启后生效`);
        setAdvanced({});
        onChanged();
      } else {
        toast.show('error', '保存失败: ' + (result.error ?? '未知错误'));
      }
    } catch (err) {
      toast.show('error', '保存失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  const resetProvider = async () => {
    setSaving(true);
    try {
      const result = await window.api.config.resetLlmProvider(provider.type);
      if (result.ok) {
        toast.show('success', `${provider.label} 已重置为 YAML 默认值，重启后生效`);
        setAdvanced({});
        onChanged();
      } else {
        toast.show('error', '重置失败: ' + (result.error ?? '未知错误'));
      }
    } catch (err) {
      toast.show('error', '重置失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  const requestReset = () => {
    if (saving) return;
    if (!provider.hasOverride) {
      if (hasAdvancedChanges) {
        setAdvanced({});
        toast.show('info', '已清除尚未保存的配置更改');
      }
      return;
    }
    setConfirmAction('reset');
  };

  const handleConfirmAction = async () => {
    const action = confirmAction;
    if (!action) return;
    try {
      if (action === 'disable') {
        if (!provider.enabled || provider.isDefault) {
          toast.show('warn', '当前状态已变化，未执行禁用操作');
          return;
        }
        await updateEnabled(false);
      } else if (action === 'set-default') {
        if (provider.isDefault || defaultUnavailableReason) {
          toast.show('warn', defaultUnavailableReason ?? `${provider.label} 已是当前默认 Provider`);
          return;
        }
        await setAsDefault();
      } else {
        if (!provider.hasOverride) {
          toast.show('info', '当前已没有可重置的配置覆盖');
          return;
        }
        await resetProvider();
      }
    } finally {
      setConfirmAction(null);
    }
  };

  const confirmation = confirmAction === 'disable'
    ? {
        title: `确认禁用 ${provider.label}`,
        message: `禁用后，${provider.label} 将在重启后退出模型路由，可能减少级联可用的备用模型。API Key 不会被删除。`,
        confirmLabel: '确认禁用',
        variant: 'danger' as const,
      }
    : confirmAction === 'set-default'
      ? {
          title: `将 ${provider.label} 设为默认 Provider？`,
          message: '重启后，新的 AI 请求会优先使用此 Provider；请确认其额度、模型和 API Key 均已正确配置。',
          confirmLabel: '设为默认',
          variant: 'default' as const,
        }
      : confirmAction === 'reset'
        ? {
            title: `重置 ${provider.label} 配置？`,
            message: '这会删除该 Provider 的启用状态、层级、模型、API URL 和超时覆盖，恢复 YAML 默认值；API Key 不受影响。',
            confirmLabel: '确认重置',
            variant: 'danger' as const,
          }
        : null;

  return (
    <article
      className={`${styles.providerCard} ${expanded ? styles.expanded : ''}`}
      aria-labelledby={toggleId}
    >
      <div className={`${styles.providerHeader} ${!provider.enabled ? styles.disabled : ''}`}>
        <button
          id={toggleId}
          type="button"
          className={styles.providerToggle}
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-label={`${expanded ? '收起' : '展开'} ${provider.label} 配置`}
        >
          <span className={styles.providerIcon} aria-hidden="true">{PROVIDER_ICON[provider.type]}</span>
          <span className={styles.providerMeta}>
            <span className={styles.providerName}>
              {provider.label}
              {provider.isDefault && (
                <Badge color="warning">
                  <Star size={10} className={styles.inlineIcon} aria-hidden="true" />
                  默认
                </Badge>
              )}
              {provider.hasOverride && <Badge color="info">已覆盖</Badge>}
            </span>
            <span className={styles.providerDesc}>{provider.description}</span>
          </span>
          <span className={styles.providerChevron} aria-hidden="true">
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
        </button>

        <div className={styles.providerActions} role="group" aria-label={`${provider.label} 状态`}>
          <div className={styles.badgeGroup}>
            {provider.enabled ? (
              <Badge color="success">已启用</Badge>
            ) : (
              <Badge color="default">已禁用</Badge>
            )}
            {provider.registered && <Badge color="info">已注册</Badge>}
            {provider.apiKeyConfigured ? (
              <Badge color="success">Key 已配置</Badge>
            ) : (
              <Badge color="danger">Key 未配置</Badge>
            )}
          </div>
          <button
            type="button"
            role="switch"
            className={styles.switchControl}
            aria-label={`${provider.label} Provider 启用状态`}
            aria-checked={provider.enabled}
            aria-disabled={blocksDisable || toggling || undefined}
            aria-describedby={blocksDisable ? switchHintId : undefined}
            aria-busy={toggling || undefined}
            disabled={toggling}
            onClick={requestToggleEnabled}
            title={blocksDisable
              ? '当前默认 Provider 不能直接禁用，请先设置其他默认 Provider'
              : provider.enabled ? '禁用此 Provider' : '启用此 Provider'}
          >
            <span className={styles.switchTrack} aria-hidden="true">
              <span className={styles.switchThumb} />
            </span>
            <span className={styles.switchText}>{provider.enabled ? '已启用' : '已禁用'}</span>
          </button>
          {blocksDisable && (
            <span id={switchHintId} className={styles.srOnly}>
              当前默认 Provider 不能直接禁用，请先将其他已启用 Provider 设为默认。
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <section
          id={detailsId}
          className={styles.providerBody}
          role="region"
          aria-labelledby={toggleId}
        >
          <div className={styles.formGroup}>
            <label htmlFor={apiKeyId}>
              <KeyRound size={12} aria-hidden="true" />
              API Key
            </label>
            <div className={styles.apiKeyRow}>
              <Input
                id={apiKeyId}
                type={showKey ? 'text' : 'password'}
                autoComplete="new-password"
                aria-describedby={apiKeyHintId}
                placeholder={provider.apiKeyConfigured ? '已配置（输入新值覆盖）' : '请输入 API Key'}
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                icon={<KeyRound size={12} aria-hidden="true" />}
              />
              <Button
                size="md"
                onClick={() => setShowKey((value) => !value)}
                aria-controls={apiKeyId}
                aria-pressed={showKey}
                aria-label={`${showKey ? '隐藏' : '显示'} ${provider.label} API Key`}
              >
                {showKey ? <EyeOff size={12} aria-hidden="true" /> : <Eye size={12} aria-hidden="true" />}
                {showKey ? '隐藏' : '显示'}
              </Button>
              <Button
                variant="primary"
                onClick={handleSaveApiKey}
                loading={saving}
                disabled={!apiKeyInput.trim()}
              >
                <Save size={12} aria-hidden="true" />
                保存 Key
              </Button>
            </div>
            <div id={apiKeyHintId} className={styles.hint}>
              当前: {provider.apiKeyConfigured ? '已配置（脱敏显示见日志）' : '未配置'}
              {' · 环境变量: '}
              {provider.apiKeyEnvVar ?? `${provider.type.toUpperCase()}_API_KEY`}
            </div>
          </div>

          <div className={styles.formGroup}>
            <h4 className={styles.formLabel}>连接测试</h4>
            <Button
              size="sm"
              variant="default"
              onClick={handleTest}
              loading={testing}
              aria-describedby={testResult ? testResultId : undefined}
            >
              <TestTube size={12} aria-hidden="true" />
              测试连接
            </Button>
            {testResult && (
              <div
                id={testResultId}
                role={testResult.ok ? 'status' : 'alert'}
                aria-live="polite"
                className={`${styles.testResult} ${
                  testResult.ok ? styles.ok : testResult.latencyMs > 0 ? styles.fail : styles.pending
                }`}
              >
                {testResult.ok ? '✓ ' : '✗ '}
                {testResult.message}
                {testResult.latencyMs > 0 && ` （${testResult.latencyMs}ms）`}
              </div>
            )}
          </div>

          <div className={styles.divider} role="separator" />

          <fieldset className={`${styles.formGroup} ${styles.tierFieldset}`} aria-describedby={tierHintId}>
            <legend>层级（级联模式）</legend>
            <div className={styles.tierSelect}>
              {(['tier1', 'tier2', 'tier3'] as ModelTier[]).map((tier) => {
                const tierId = `${baseId}-${tier}`;
                const selected = (advanced.tier ?? provider.tier) === tier;
                return (
                  <label
                    key={tier}
                    className={`${styles.tierOption} ${selected ? styles.active : ''}`}
                    htmlFor={tierId}
                  >
                    <input
                      id={tierId}
                      className={styles.tierRadio}
                      type="radio"
                      name={`${baseId}-tier`}
                      value={tier}
                      checked={selected}
                      onChange={() => setAdvanced((current) => ({ ...current, tier }))}
                    />
                    <span>{TIER_LABEL[tier]}</span>
                  </label>
                );
              })}
            </div>
            <div id={tierHintId} className={styles.hint}>
              Tier1（本地/低延迟）→ Tier2（中等）→ Tier3（高质量），级联模式按置信度阈值自动选择
            </div>
          </fieldset>

          <div className={styles.advancedGrid}>
            <div className={styles.formGroup}>
              <label htmlFor={modelId}>模型名</label>
              <Input
                id={modelId}
                type="text"
                aria-describedby={`${modelId}-hint`}
                placeholder={provider.model ?? '例如 gpt-4o-mini'}
                value={advanced.model ?? ''}
                onChange={(e) => setAdvanced((current) => ({ ...current, model: e.target.value }))}
              />
              <div id={`${modelId}-hint`} className={styles.hint}>当前: {provider.model ?? '未设置'}</div>
            </div>
            <div className={styles.formGroup}>
              <label htmlFor={timeoutId}>超时（毫秒）</label>
              <Input
                id={timeoutId}
                type="number"
                min={1}
                step={1000}
                aria-describedby={`${timeoutId}-hint`}
                placeholder={String(provider.timeoutMs ?? 30000)}
                value={advanced.timeout_ms ?? ''}
                onChange={(e) =>
                  setAdvanced((current) => ({
                    ...current,
                    timeout_ms: e.target.value ? Number(e.target.value) : undefined,
                  }))
                }
              />
              <div id={`${timeoutId}-hint`} className={styles.hint}>当前: {provider.timeoutMs ?? '默认'}ms</div>
            </div>
          </div>

          <div className={styles.formGroup}>
            <label htmlFor={apiUrlId}>API URL</label>
            <Input
              id={apiUrlId}
              type="url"
              aria-describedby={`${apiUrlId}-hint`}
              placeholder={provider.apiUrl ?? ''}
              value={advanced.api_url ?? ''}
              onChange={(e) => setAdvanced((current) => ({ ...current, api_url: e.target.value }))}
            />
            <div id={`${apiUrlId}-hint`} className={styles.hint}>
              当前: {provider.apiUrl ?? '默认'}
              {provider.anthropicVersion && ` · Anthropic Version: ${provider.anthropicVersion}`}
            </div>
          </div>

          <div className={styles.actionRow}>
            <Button
              variant="primary"
              onClick={handleSaveAdvanced}
              loading={saving}
              disabled={!hasAdvancedChanges}
              title={hasAdvancedChanges ? '保存配置覆盖' : '请先修改配置'}
            >
              <Save size={12} aria-hidden="true" />
              保存配置
            </Button>
            <Button
              variant={provider.hasOverride ? 'danger' : 'default'}
              onClick={requestReset}
              loading={saving}
              disabled={!provider.hasOverride && !hasAdvancedChanges}
              title={provider.hasOverride
                ? '删除配置覆盖并恢复 YAML 默认值'
                : hasAdvancedChanges ? '清除尚未保存的更改' : '当前没有配置覆盖'}
            >
              <RotateCcw size={12} aria-hidden="true" />
              {provider.hasOverride
                ? '重置为默认'
                : hasAdvancedChanges ? '清除未保存更改' : '已是默认配置'}
            </Button>
            {!provider.isDefault ? (
              <>
                <Button
                  variant="default"
                  className={defaultUnavailableReason ? styles.guardedAction : undefined}
                  onClick={requestSetDefault}
                  loading={settingDefault}
                  aria-disabled={Boolean(defaultUnavailableReason) || undefined}
                  aria-describedby={defaultUnavailableReason ? defaultHintId : undefined}
                  title={defaultUnavailableReason ?? `将 ${provider.label} 设为默认 Provider`}
                >
                  <Star size={12} aria-hidden="true" />
                  设为默认
                </Button>
                {defaultUnavailableReason && (
                  <span id={defaultHintId} className={styles.srOnly}>{defaultUnavailableReason}</span>
                )}
              </>
            ) : (
              <span className={styles.currentDefault} role="status">
                <Star size={12} aria-hidden="true" />
                当前默认
              </span>
            )}
            <a
              className={`${styles.externalLink} ${styles.apiKeyLink}`}
              href={provider.apiKeysUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`在浏览器中打开 ${provider.label} API Key 申请页`}
              onClick={(e) => {
                e.preventDefault();
                void window.api.app.openExternal(provider.apiKeysUrl);
              }}
            >
              <ExternalLink size={12} aria-hidden="true" />
              申请 API Key
            </a>
            <a
              className={`${styles.externalLink} ${styles.docsLink}`}
              href={provider.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`在浏览器中打开 ${provider.label} 文档`}
              onClick={(e) => {
                e.preventDefault();
                void window.api.app.openExternal(provider.docsUrl);
              }}
            >
              <ExternalLink size={12} aria-hidden="true" />
              文档
            </a>
          </div>
        </section>
      )}

      <ConfirmDialog
        open={confirmation !== null}
        title={confirmation?.title ?? ''}
        message={confirmation?.message ?? ''}
        confirmLabel={confirmation?.confirmLabel}
        variant={confirmation?.variant}
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleConfirmAction}
      />
    </article>
  );
}
