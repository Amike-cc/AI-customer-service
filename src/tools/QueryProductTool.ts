/**
 * 查询商品详情工具
 *
 * 当买家询问"这个商品怎么样"、"详细介绍一下"、"有什么颜色/尺码"时调用。
 * 数据源：ProductMatcher 加载的 products.json
 */
import type { Tool } from './types';

export const QueryProductTool: Tool = {
  name: 'query_product',
  description:
    '查询商品详情（描述、价格、规格、图片等）。当买家询问商品详细信息、规格参数、价格时调用。需提供商品名称或关键词。',
  parameters: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: '商品名称或关键词',
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
      return '商品库未加载，无法查询商品详情';
    }

    if (ctx.productMatcher.count === 0) {
      return '商品库为空，请先同步商品数据';
    }

    const matches = ctx.productMatcher.match(keyword);
    if (matches.length === 0) {
      return `未找到匹配"${keyword}"的商品`;
    }

    // 取第一个匹配商品的完整详情
    const m = matches[0];
    const product = ctx.productMatcher.getProduct(m.productId);
    if (!product) {
      return `商品 ${m.productId} 不存在`;
    }

    const lines: string[] = [`商品详情：${product.name}`];
    lines.push(`商品ID：${product.product_id}`);
    if (product.description) {
      // 描述截断保护
      const desc = product.description.length > 500 ? product.description.slice(0, 500) + '...' : product.description;
      lines.push(`描述：${desc}`);
    }
    if (product.category) {
      lines.push(`分类：${product.category}`);
    }
    if (Array.isArray(product.images) && product.images.length > 0) {
      lines.push(`图片数：${product.images.length} 张`);
    }
    // 商品属性：材质/品牌/产地等键值对
    if (Array.isArray(product.attrs) && product.attrs.length > 0) {
      lines.push('属性：');
      for (const a of product.attrs) {
        lines.push(`  - ${a.name}：${a.value}`);
      }
    }
    // 商品规格：颜色/尺码等（规格名 + 可选值列表）
    if (Array.isArray(product.specs) && product.specs.length > 0) {
      lines.push('规格：');
      for (const s of product.specs) {
        lines.push(`  - ${s.name}：${s.values.join(' / ')}`);
      }
    }
    // SKU 变体：含具体价格/库存
    if (Array.isArray(product.variants) && product.variants.length > 0) {
      lines.push('SKU 变体：');
      for (const v of product.variants.slice(0, 5)) {
        lines.push(`  - ${v.spec}：¥${v.price}，库存 ${v.stock} 件`);
      }
    }
    // 物流信息
    if (product.shipping) {
      // logistics 字段可能缺失或为空数组，容错避免 TypeError
      const logistics = Array.isArray(product.shipping.logistics)
        ? product.shipping.logistics.join('/')
        : (product.shipping.logistics || '未知');
      lines.push(`物流：${product.shipping.delivery_days} 发货，${logistics}`);
      if (product.shipping.free_shipping) {
        lines.push('  包邮');
      }
    }
    // 售后信息
    if (product.after_sales) {
      lines.push(`售后：${product.after_sales.policy}（退货${product.after_sales.return_days}天/换货${product.after_sales.exchange_days}天）`);
    }

    return lines.join('\n');
  },
};
