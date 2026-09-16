import { useEffect, useMemo, useState } from 'react';
import { Check, Download, RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react';
import type { UpdateState } from '../../../../shared/update-types';
import { Button } from '../common/Button';
import styles from './UpdatePanel.module.css';

const DEFAULT_STATE: UpdateState = { status: 'idle', currentVersion: '未知' };

const STATUS_COPY: Record<UpdateState['status'], string> = {
  idle: '尚未检查更新',
  checking: '正在检查更新…',
  available: '发现新版本',
  'not-available': '当前已是最新版本',
  downloading: '正在下载更新…',
  downloaded: '更新已下载完成',
  error: '更新检查失败',
};

function formatDate(value?: string): string {
  if (!value) return '';
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(timestamp);
}

export function UpdatePanel() {
  const [state, setState] = useState<UpdateState>(DEFAULT_STATE);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    let mounted = true;
    const updateApi = window.api.update;
    if (!updateApi) {
      setState({ status: 'error', currentVersion: '未知', error: '更新服务未初始化' });
      return () => {
        mounted = false;
      };
    }
    const unsubscribe = updateApi.onStateChanged((next) => {
      if (mounted) setState(next);
    });
    void updateApi
      .getState()
      .then((next) => {
        if (mounted) setState(next);
      })
      .catch((error: unknown) => {
        if (mounted) setActionError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const action = async (method: 'check' | 'download' | 'install') => {
    setBusy(true);
    setActionError('');
    try {
      const result = await window.api.update[method]();
      setState(result.state);
      if (!result.ok && result.error) setActionError(result.error);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const primaryAction = useMemo(() => {
    if (state.status === 'available')
      return { label: '下载更新', icon: <Download size={15} />, method: 'download' as const };
    if (state.status === 'downloaded')
      return { label: '立即重启安装', icon: <RotateCcw size={15} />, method: 'install' as const };
    return { label: '检查更新', icon: <RefreshCw size={15} />, method: 'check' as const };
  }, [state.status]);

  const progress = Math.round(state.percent ?? 0);
  const isDevMode = state.error?.includes('开发模式') || state.error?.includes('浏览器预览');

  return (
    <div className={styles.container}>
      <div className={styles.hero}>
        <div className={styles.icon}>
          <Download size={22} />
        </div>
        <div>
          <span className={styles.eyebrow}>APPLICATION UPDATE</span>
          <h2>软件更新</h2>
          <p>保持客服工作台处于最新版本，更新前会保留本地店铺与知识库数据。</p>
        </div>
      </div>

      <section className={styles.card} aria-live="polite">
        <div className={styles.versionRow}>
          <div>
            <span className={styles.label}>当前版本</span>
            <strong>v{state.currentVersion || '未知'}</strong>
          </div>
          <div className={[styles.status, styles[`status_${state.status}`]].join(' ')}>
            {state.status === 'downloaded' ? (
              <Check size={15} />
            ) : state.status === 'error' ? (
              <TriangleAlert size={15} />
            ) : (
              <span className={styles.statusDot} />
            )}
            <span>{STATUS_COPY[state.status]}</span>
          </div>
        </div>

        {state.version && state.status !== 'not-available' && (
          <div className={styles.updateInfo}>
            <div>
              <span className={styles.label}>目标版本</span>
              <strong>v{state.version}</strong>
            </div>
            {state.releaseDate && <span className={styles.date}>{formatDate(state.releaseDate)}</span>}
          </div>
        )}

        {state.status === 'downloading' && (
          <div className={styles.progressBlock}>
            <div className={styles.progressMeta}>
              <span>下载进度</span>
              <strong>{progress}%</strong>
            </div>
            <div className={styles.progressTrack}>
              <div className={styles.progressBar} style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {state.releaseNotes && (
          <div className={styles.notes}>
            <span className={styles.label}>版本说明</span>
            <pre>{state.releaseNotes}</pre>
          </div>
        )}

        {(state.error || actionError) && (
          <div className={styles.error} role="alert">
            <TriangleAlert size={15} />
            <span>{actionError || state.error}</span>
          </div>
        )}

        <div className={styles.actions}>
          <Button
            variant="primary"
            onClick={() => void action(primaryAction.method)}
            loading={busy}
            disabled={state.status === 'checking' || state.status === 'downloading'}
          >
            {primaryAction.icon}
            {primaryAction.label}
          </Button>
          {state.status === 'error' && !isDevMode && (
            <Button variant="ghost" onClick={() => void action('check')} disabled={busy}>
              重试
            </Button>
          )}
        </div>
      </section>

      <p className={styles.tip}>
        更新服务使用 GitHub Releases。正式安装包会在发布新版本后显示更新；开发模式不会访问更新服务器。
      </p>
    </div>
  );
}
