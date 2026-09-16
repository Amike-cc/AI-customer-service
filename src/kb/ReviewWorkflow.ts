import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import type { Config } from '../config/schema';
import type { AppLogger } from '../logging/logger';

export type ReviewStatus = 'draft' | 'pending_review' | 'approved' | 'rejected' | 'published';

export interface ReviewRecord {
  reviewId: string;
  shopId: string;
  component: 'faq' | 'template' | 'prompt';
  targetId: string;
  status: ReviewStatus;
  author: string;
  reviewer: string | null;
  submittedAt: number;
  reviewedAt: number | null;
  reviewComment: string | null;
  payload: string;
}

export class ReviewWorkflow {
  private currentUser: string;
  /** per-shop 写入队列：串行化读-改-写，防止并发提交/审核互相覆盖 */
  private writeQueues = new Map<string, Promise<unknown>>();

  constructor(private config: Config, private logger?: AppLogger) {
    try {
      this.currentUser = os.userInfo().username;
    } catch {
      this.currentUser = 'default';
    }
  }

  /** 串行化执行写操作（同一店铺排队，不同店铺并行） */
  private withWriteLock<T>(shopId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeQueues.get(shopId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // 吞掉错误避免队列链断裂，同时把结果传给调用方
    this.writeQueues.set(
      shopId,
      next.catch(() => {}),
    );
    return next;
  }

  private getReviewsPath(shopId: string): string {
    return path.join(this.config.app.data_dir, 'data', 'reviews', shopId, 'reviews.json');
  }

  private async readReviews(shopId: string): Promise<ReviewRecord[]> {
    const filePath = this.getReviewsPath(shopId);
    if (!(await fs.pathExists(filePath))) return [];
    try {
      const data = await fs.readJson(filePath);
      return Array.isArray(data.reviews) ? data.reviews : [];
    } catch {
      return [];
    }
  }

  private async writeReviews(shopId: string, reviews: ReviewRecord[]): Promise<void> {
    const filePath = this.getReviewsPath(shopId);
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeJson(filePath, { reviews }, { spaces: 2 });
  }

  async submitForReview(
    shopId: string,
    component: 'faq' | 'template' | 'prompt',
    targetId: string,
    payload: string,
  ): Promise<ReviewRecord> {
    // 读-改-写串行化，防止并发提交互相覆盖
    return this.withWriteLock(shopId, async () => {
      const reviews = await this.readReviews(shopId);
      const record: ReviewRecord = {
        reviewId: this.generateReviewId(),
        shopId,
        component,
        targetId,
        status: 'pending_review',
        author: this.currentUser,
        reviewer: null,
        submittedAt: Date.now(),
        reviewedAt: null,
        reviewComment: null,
        payload,
      };
      reviews.push(record);
      await this.writeReviews(shopId, reviews);
      this.logger?.info({ shopId, component, reviewId: record.reviewId }, '已提交审核');
      return record;
    });
  }

  async approve(reviewId: string, comment: string): Promise<void> {
    const allReviews = await this.listAllReviews();
    const review = allReviews.find((r) => r.reviewId === reviewId);
    if (!review) throw new Error(`审核记录 ${reviewId} 不存在`);
    if (review.status !== 'pending_review') {
      throw new Error(`审核记录 ${reviewId} 状态不是待审核`);
    }
    // 读-改-写串行化，防止并发审核互相覆盖
    await this.withWriteLock(review.shopId, async () => {
      // 锁内重新读取最新状态（排队期间可能已被其他调用修改）
      const latest = (await this.readReviews(review.shopId)).find((r) => r.reviewId === reviewId);
      if (!latest || latest.status !== 'pending_review') {
        throw new Error(`审核记录 ${reviewId} 状态已变更，请刷新后重试`);
      }
      latest.status = 'approved';
      latest.reviewer = this.currentUser;
      latest.reviewedAt = Date.now();
      latest.reviewComment = comment;
      const all = await this.readReviews(review.shopId);
      const updated = all.map((r) => (r.reviewId === reviewId ? latest : r));
      await this.writeReviews(review.shopId, updated);
    });
    this.logger?.info({ reviewId }, '审核已通过');
  }

  async reject(reviewId: string, comment: string): Promise<void> {
    const allReviews = await this.listAllReviews();
    const review = allReviews.find((r) => r.reviewId === reviewId);
    if (!review) throw new Error(`审核记录 ${reviewId} 不存在`);
    if (review.status !== 'pending_review') {
      throw new Error(`审核记录 ${reviewId} 状态不是待审核`);
    }
    // 读-改-写串行化，防止并发审核互相覆盖
    await this.withWriteLock(review.shopId, async () => {
      const latest = (await this.readReviews(review.shopId)).find((r) => r.reviewId === reviewId);
      if (!latest || latest.status !== 'pending_review') {
        throw new Error(`审核记录 ${reviewId} 状态已变更，请刷新后重试`);
      }
      latest.status = 'rejected';
      latest.reviewer = this.currentUser;
      latest.reviewedAt = Date.now();
      latest.reviewComment = comment;
      const all = await this.readReviews(review.shopId);
      const updated = all.map((r) => (r.reviewId === reviewId ? latest : r));
      await this.writeReviews(review.shopId, updated);
    });
    this.logger?.info({ reviewId }, '审核已拒绝');
  }

  async publish(reviewId: string): Promise<ReviewRecord> {
    const allReviews = await this.listAllReviews();
    const review = allReviews.find((r) => r.reviewId === reviewId);
    if (!review) throw new Error(`审核记录 ${reviewId} 不存在`);
    if (review.status !== 'approved') {
      throw new Error(`审核记录 ${reviewId} 状态不是已通过`);
    }
    return this.withWriteLock(review.shopId, async () => {
      const latest = (await this.readReviews(review.shopId)).find((r) => r.reviewId === reviewId);
      if (!latest || latest.status !== 'approved') {
        throw new Error(`审核记录 ${reviewId} 状态已变更，请刷新后重试`);
      }
      latest.status = 'published';
      const all = await this.readReviews(review.shopId);
      const updated = all.map((r) => (r.reviewId === reviewId ? latest : r));
      await this.writeReviews(review.shopId, updated);
      return latest;
    });
  }

  async listPendingReviews(shopId: string): Promise<ReviewRecord[]> {
    const reviews = await this.readReviews(shopId);
    return reviews.filter((r) => r.status === 'pending_review').sort((a, b) => b.submittedAt - a.submittedAt);
  }

  /** 按 reviewId 查找审核记录（供 IPC 层做归属店铺校验） */
  async findReview(reviewId: string): Promise<ReviewRecord | null> {
    const all = await this.listAllReviews();
    return all.find((r) => r.reviewId === reviewId) ?? null;
  }

  async listReviewHistory(shopId: string, component?: 'faq' | 'template' | 'prompt'): Promise<ReviewRecord[]> {
    const reviews = await this.readReviews(shopId);
    const filtered = component ? reviews.filter((r) => r.component === component) : reviews;
    return filtered.sort((a, b) => b.submittedAt - a.submittedAt);
  }

  private async listAllReviews(): Promise<ReviewRecord[]> {
    const baseDir = path.join(this.config.app.data_dir, 'data', 'reviews');
    if (!(await fs.pathExists(baseDir))) return [];
    const all: ReviewRecord[] = [];
    const shops = await fs.readdir(baseDir);
    for (const shop of shops) {
      const shopDir = path.join(baseDir, shop);
      const stat = await fs.stat(shopDir);
      if (!stat.isDirectory()) continue;
      const reviews = await this.readReviews(shop);
      all.push(...reviews);
    }
    return all;
  }

  private generateReviewId(): string {
    const ts = Date.now().toString(36);
    const rand = crypto.randomBytes(4).toString('hex');
    return `r${ts}_${rand}`;
  }
}
