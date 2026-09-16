/**
 * ReviewWorkflow 单元测试
 */
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { ReviewWorkflow } from '@/kb/ReviewWorkflow';
import { createTestConfig } from '../helpers/testConfig';

describe('ReviewWorkflow', () => {
  let tmpDir: string;
  let wf: ReviewWorkflow;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `rev-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const config = createTestConfig({ app: { data_dir: tmpDir } } as any);
    wf = new ReviewWorkflow(config);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('submitForReview 创建 pending_review 记录', async () => {
    const r = await wf.submitForReview('shop1', 'faq', 'faq_1', '{"q":"测试"}');
    expect(r.reviewId).toMatch(/^r/);
    expect(r.status).toBe('pending_review');
    expect(r.component).toBe('faq');
    expect(r.targetId).toBe('faq_1');
    expect(r.reviewer).toBeNull();
    expect(r.reviewedAt).toBeNull();
  });

  it('approve 状态变为 approved', async () => {
    const r = await wf.submitForReview('shop1', 'template', 'tpl_1', '{}');
    await wf.approve(r.reviewId, '通过');
    const history = await wf.listReviewHistory('shop1');
    const approved = history.find((h) => h.reviewId === r.reviewId);
    expect(approved!.status).toBe('approved');
    expect(approved!.reviewer).not.toBeNull();
    expect(approved!.reviewedAt).not.toBeNull();
    expect(approved!.reviewComment).toBe('通过');
  });

  it('approve 非 pending 状态抛错', async () => {
    const r = await wf.submitForReview('shop1', 'faq', 'faq_1', '{}');
    await wf.approve(r.reviewId, '通过');
    await expect(wf.approve(r.reviewId, '再次通过')).rejects.toThrow();
  });

  it('reject 状态变为 rejected', async () => {
    const r = await wf.submitForReview('shop1', 'prompt', 'prompt_1', '{}');
    await wf.reject(r.reviewId, '内容不合规');
    const history = await wf.listReviewHistory('shop1');
    const rejected = history.find((h) => h.reviewId === r.reviewId);
    expect(rejected!.status).toBe('rejected');
    expect(rejected!.reviewComment).toBe('内容不合规');
  });

  it('publish approved 状态变为 published', async () => {
    const r = await wf.submitForReview('shop1', 'faq', 'faq_1', '{}');
    await wf.approve(r.reviewId, '通过');
    const published = await wf.publish(r.reviewId);
    expect(published.status).toBe('published');
  });

  it('listPendingReviews 只返回 pending', async () => {
    const r1 = await wf.submitForReview('shop1', 'faq', 'faq_1', '{}');
    const r2 = await wf.submitForReview('shop1', 'faq', 'faq_2', '{}');
    await wf.approve(r1.reviewId, '通过');
    const pending = await wf.listPendingReviews('shop1');
    expect(pending).toHaveLength(1);
    expect(pending[0].reviewId).toBe(r2.reviewId);
  });

  it('listReviewHistory 按组件过滤', async () => {
    await wf.submitForReview('shop1', 'faq', 'faq_1', '{}');
    await wf.submitForReview('shop1', 'template', 'tpl_1', '{}');
    const faqHistory = await wf.listReviewHistory('shop1', 'faq');
    expect(faqHistory).toHaveLength(1);
    expect(faqHistory[0].component).toBe('faq');
  });
});
