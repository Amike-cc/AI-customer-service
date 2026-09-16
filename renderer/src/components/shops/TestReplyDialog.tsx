import { useState } from 'react';
import { Check, Minus, X, FlaskConical, Send, Zap, ShieldCheck } from 'lucide-react';
import type { ShopListItem, TestReplyResult } from '../../types/api';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { useToast } from '../common/Toast';
import styles from './TestReplyDialog.module.css';

interface TestReplyDialogProps {
  shop: ShopListItem;
  onClose: () => void;
}

export function TestReplyDialog({ shop, onClose }: TestReplyDialogProps) {
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TestReplyResult | null>(null);
  const toast = useToast();

  const handleSubmit = async () => {
    const text = message.trim();
    if (!text) {
      toast.show('warn', '请输入测试消息');
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const res = await window.api.test.reply(shop.shopId, text);
      // 主进程失败时返回 {ok:false, error}（不 reject），成功时直接返回 TestReplyResult。
      // 必须检查失败标志，否则 result.pipeline.map 对 undefined 抛 TypeError 导致应用白屏
      if (res && typeof res === 'object' && 'ok' in res && !(res as { ok: boolean }).ok) {
        toast.show('error', (res as { error?: string }).error ?? '测试失败');
        return;
      }
      setResult(res as TestReplyResult);
    } catch (err) {
      toast.show('error', '测试失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={(
        <span className={styles.dialogHeader}>
          <FlaskConical size={16} />
          测试回复 · <span className={styles.shopName}>{shop.shopName}</span>
        </span>
      )}
      width={620}
      closeOnOverlay={false}
      footer={<Button onClick={onClose} disabled={loading}>关闭</Button>}
    >
      <div className={styles.content}>
        <div className={styles.previewNotice} role="note">
          <ShieldCheck size={16} />
          <span>仅生成回复预览，不会发送给真实买家。</span>
        </div>

        <div className={styles.inputArea}>
          <label className={styles.inputLabel} htmlFor="test-reply-message">模拟买家消息</label>
          <textarea
            id="test-reply-message"
            className={styles.textarea}
            placeholder="输入测试消息，如：你好 / 收纳盒多少钱 / 发货时间"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={3}
            disabled={loading}
          />
          <div className={styles.inputActions}>
            <Button variant="primary" size="md" onClick={handleSubmit} loading={loading} disabled={!message.trim()}>
              <Send size={13} />
              执行测试
            </Button>
          </div>
        </div>

        {result && (
          <div className={styles.resultSection}>
            <div>
              <div className={styles.sectionTitle}>
                <Zap size={13} />
                执行管线
              </div>
              <div className={styles.pipeline}>
                {result.pipeline.map((step, idx) => (
                  <div
                    key={idx}
                    className={[
                      styles.pipelineStep,
                      step.status === 'ok' && styles.stepOk,
                      step.status === 'skip' && styles.stepSkip,
                      step.status === 'fail' && styles.stepFail,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <span className={styles.stepIcon}>
                      {step.status === 'ok' && <Check size={13} />}
                      {step.status === 'skip' && <Minus size={13} />}
                      {step.status === 'fail' && <X size={13} />}
                    </span>
                    <span className={styles.stepName}>{step.step}</span>
                    <span className={styles.stepDetail}>{step.detail ?? ''}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className={styles.replyBlock}>
              <div className={styles.replyLabel}>AI 回复</div>
              <div className={styles.replyText}>{result.reply || '(空回复)'}</div>
            </div>

            <div className={styles.metaGrid}>
              {result.matchedRule && (
                <div className={styles.metaItem}>
                  <span className={styles.metaLabel}>命中规则</span>
                  <span className={styles.metaValue}>{result.matchedRule}</span>
                </div>
              )}
              {result.productMatch && (
                <div className={styles.metaItem}>
                  <span className={styles.metaLabel}>商品匹配</span>
                  <span className={styles.metaValue}>
                    {result.productMatch.productId} ({(result.productMatch.confidence * 100).toFixed(0)}%)
                  </span>
                </div>
              )}
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Token 输入</span>
                <span className={styles.metaValue}>{result.tokenInput}</span>
              </div>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Token 输出</span>
                <span className={styles.metaValue}>{result.tokenOutput}</span>
              </div>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>延迟</span>
                <span className={styles.metaValue}>{result.latencyMs} ms</span>
              </div>
              {result.sensitiveHits.length > 0 && (
                <div className={styles.sensitiveHits}>
                  <span className={styles.metaLabel}>敏感词命中</span>
                  <div className={styles.sensitiveList}>
                    {result.sensitiveHits.map((w) => (
                      <span key={w} className={styles.sensitiveTag}>
                        {w}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

      </div>
    </Modal>
  );
}
