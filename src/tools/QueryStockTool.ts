/**
 * 查询商品库存工具
 *
 * 当买家询问"XX 有货吗"、"还有现货吗"时，LLM 可调用此工具查实际库存。
 * 数据源：ProductMatcher 加载的 products.json（已同步的商品数据）
 *
 * 注意：返回的是结构化文本，由 LLM 转化为自然语言回复。
 */
import type { Tool } from './types';

export const QueryStockTool: Tool = {
  name: 'query_stock',
  description:
    '查询商品库存。当买家询问某商品是否有货、库存数量、是否现货时调用。需提供商品名称或关键词。',
  parameters: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: '商品名称或关键词，如"黑色连衣裙"、"夏季短袖"',
      },
    },
    required: ['keyword'],
  },

  async execute(args, ctx) {
    const keyword = String(args.keyword ?? '').trim();
    if (!keyword) {
      return '请提供要查询的商品名称或关键词';
    }

    if (!ctx.productMatcher) {
      return '商品库未加载，无法查询库存';
    }

    if (ctx.productMatcher.count === 0) {
      return '商品库为空，请先同步商品数据';
    }

    // 用 ProductMatcher 匹配商品
    const matches = ctx.productMatcher.match(keyword);
    if (matches.length === 0) {
      return `未找到匹配"${keyword}"的商品`;
    }

    // 取前 3 个匹配商品，返回库存信息
    const lines: string[] = [`匹配到 ${matches.length} 个商品，前 ${Math.min(3, matches.length)} 个：`];
    for (let i = 0; i < Math.min(3, matches.length); i++) {
      const m = matches[i];
      const product = ctx.productMatcher.getProduct(m.productId);
      if (!product) continue;

      // 库存数据在 variants 数组中
      const variants = product.variants;
      // stock 可能是字符串（如 "10件"）或 NaN，防御后避免回复"NaN 件"
      const totalStock = variants.reduce((sum, v) => {
        const stock = Number(v.stock);
        return sum + (Number.isFinite(stock) && stock > 0 ? stock : 0);
      }, 0);

      lines.push(`【${i + 1}】${product.name}`);
      lines.push(`  商品ID：${product.product_id}`);
      if (variants.length > 0) {
        lines.push(`  总库存：${totalStock} 件`);
        lines.push('  规格库存：');
        for (const v of variants.slice(0, 5)) {
          lines.push(`    - ${v.spec}：${v.stock} 件，¥${v.price}（sku：${v.sku}）`);
        }
      } else {
        lines.push('  暂无规格库存信息');
      }
    }

    return lines.join('\n');
  },
};
