import fs from 'fs-extra';
import path from 'path';
import type { Config } from '../config/schema';
import type { Product } from './ProductMatcher';

export interface ImportResult {
  imported: number;
  errors: string[];
}

/**
 * 商品管理器：负责商品 CRUD 操作和 JSON 文件存储。
 *
 * 并发安全：使用 per-shop 写入队列确保同一店铺的写操作串行执行，
 * 避免并发读取-修改-写入导致的数据覆盖。
 * 原子写入：先写入临时文件再原子替换，防止写入中断导致文件损坏。
 */
export class ProductManager {
  constructor(private config: Config) {}

  /** per-shop 写入队列，确保同一店铺的写操作串行执行 */
  private readonly writeQueues = new Map<string, Promise<void>>();

  /** 获取或创建指定店铺的写入队列 */
  private withWriteLock<T>(shopId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeQueues.get(shopId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // 保持队列引用，完成后清理
    this.writeQueues.set(
      shopId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private getFilePath(shopId: string): string {
    return path.join(this.config.app.data_dir, 'data', 'shops', shopId, 'products.json');
  }

  private async readProducts(shopId: string): Promise<Product[]> {
    const filePath = this.getFilePath(shopId);
    if (!(await fs.pathExists(filePath))) return [];
    const data = await fs.readJson(filePath);
    return (data.products as Product[]) ?? [];
  }

  private async writeProducts(shopId: string, products: Product[]): Promise<void> {
    const filePath = this.getFilePath(shopId);
    await fs.ensureDir(path.dirname(filePath));
    // 先写入临时文件再原子替换，防止写入中断导致文件损坏
    const tmpPath = filePath + '.tmp';
    await fs.writeJson(tmpPath, { products }, { spaces: 2 });
    await fs.move(tmpPath, filePath, { overwrite: true });
  }

  async listProducts(shopId: string): Promise<Product[]> {
    return this.readProducts(shopId);
  }

  async getProduct(shopId: string, productId: string): Promise<Product | null> {
    const products = await this.readProducts(shopId);
    return products.find((p) => p.product_id === productId) ?? null;
  }

  async addProduct(shopId: string, product: Product): Promise<void> {
    await this.withWriteLock(shopId, async () => {
      const products = await this.readProducts(shopId);
      if (products.some((p) => p.product_id === product.product_id)) {
        throw new Error(`商品 ${product.product_id} 已存在`);
      }
      products.push(product);
      await this.writeProducts(shopId, products);
    });
  }

  async updateProduct(shopId: string, productId: string, updates: Partial<Product>): Promise<void> {
    await this.withWriteLock(shopId, async () => {
      const products = await this.readProducts(shopId);
      const idx = products.findIndex((p) => p.product_id === productId);
      if (idx === -1) throw new Error(`商品 ${productId} 不存在`);
      // 禁止通过 update 修改 product_id
      const { product_id: _ignored, ...safeUpdates } = updates; // eslint-disable-line @typescript-eslint/no-unused-vars
      void _ignored;
      products[idx] = { ...products[idx], ...safeUpdates, product_id: productId };
      await this.writeProducts(shopId, products);
    });
  }

  async deleteProduct(shopId: string, productId: string): Promise<void> {
    await this.withWriteLock(shopId, async () => {
      const products = await this.readProducts(shopId);
      const filtered = products.filter((p) => p.product_id !== productId);
      if (filtered.length === products.length) throw new Error(`商品 ${productId} 不存在`);
      await this.writeProducts(shopId, filtered);
    });
  }

  async removeProducts(shopId: string, productIds: string[]): Promise<number> {
    if (productIds.length === 0) return 0;
    return this.withWriteLock(shopId, async () => {
      const ids = new Set(productIds);
      const products = await this.readProducts(shopId);
      const filtered = products.filter((product) => !ids.has(product.product_id));
      const removed = products.length - filtered.length;
      if (removed > 0) await this.writeProducts(shopId, filtered);
      return removed;
    });
  }

  async importProducts(shopId: string, json: string): Promise<ImportResult> {
    return this.withWriteLock(shopId, async () => {
      let data: unknown;
      try {
        data = JSON.parse(json);
      } catch {
        throw new Error('JSON 格式无效');
      }

      let newProducts: Product[];
      if (Array.isArray(data)) {
        newProducts = data as Product[];
      } else if (data && typeof data === 'object' && Array.isArray((data as { products: unknown }).products)) {
        newProducts = (data as { products: Product[] }).products;
      } else {
        throw new Error('JSON 格式应为数组或 { products: [...] }');
      }

      const errors: string[] = [];
      const existing = await this.readProducts(shopId);
      const existingIds = new Set(existing.map((p) => p.product_id));
      let imported = 0;

      for (const p of newProducts) {
        if (!p.product_id || !p.name) {
          errors.push(`商品缺少 product_id 或 name: ${JSON.stringify(p).slice(0, 80)}`);
          continue;
        }
        if (existingIds.has(p.product_id)) {
          const idx = existing.findIndex((e) => e.product_id === p.product_id);
          existing[idx] = p;
        } else {
          existing.push(p);
          existingIds.add(p.product_id);
        }
        imported++;
      }

      await this.writeProducts(shopId, existing);
      return { imported, errors };
    });
  }
}
