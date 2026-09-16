/**
 * 查询店铺业务信息工具
 *
 * 当买家询问"哪里发货"、"什么快递"、"包邮吗"、"有运费险吗"时调用。
 * 数据源：ShopBusinessConfigRepo（shop_business_config 表，由"全局设置→业务参数"配置）
 */
import type { Tool } from './types';

export const QueryShopInfoTool: Tool = {
  name: 'query_shop_info',
  description:
    '查询店铺业务信息（发货地址、发货时长、合作快递、包邮政策、运费险等）。当买家询问发货地、快递公司、是否包邮、运费险时调用。',
  parameters: {
    type: 'object',
    properties: {
      field: {
        type: 'string',
        description: '要查询的字段名',
        enum: [
          'delivery_address',
          'delivery_time',
          'express_companies',
          'free_shipping',
          'freight_insurance',
          'main_category',
          'all',
        ],
      },
    },
    required: ['field'],
  },

  async execute(args, ctx) {
    const field = String(args.field ?? 'all').trim();

    const config = ctx.db.shopBusiness.getOrDefault(ctx.shopId);

    // 如果店铺未配置任何业务信息，提示
    const hasAnyConfig =
      config.deliveryAddress ||
      config.deliveryTime ||
      config.expressCompanies.length > 0 ||
      config.freeShipping ||
      config.freeShippingCondition ||
      config.mainCategory;

    if (!hasAnyConfig) {
      return '店铺业务信息尚未配置，请引导买家联系人工客服或前往"全局设置→业务参数"配置';
    }

    switch (field) {
      case 'delivery_address':
        return config.deliveryAddress
          ? `发货地址：${config.deliveryAddress}`
          : '店铺未配置发货地址';

      case 'delivery_time':
        return config.deliveryTime
          ? `发货时长：${config.deliveryTime}`
          : '店铺未配置发货时长';

      case 'express_companies':
        return Array.isArray(config.expressCompanies) && config.expressCompanies.length > 0
          ? `合作快递：${config.expressCompanies.join('、')}`
          : '店铺未配置合作快递公司';

      case 'free_shipping': {
        if (!config.freeShipping) {
          return config.freeShippingCondition
            ? `包邮政策：${config.freeShippingCondition}`
            : '店铺未开启包邮服务';
        }
        return config.freeShippingCondition
          ? `包邮政策：全场包邮（${config.freeShippingCondition}）`
          : '包邮政策：全场包邮';
      }

      case 'freight_insurance':
        return config.freightInsurance
          ? '运费险：本店提供运费险，退换货无需买家承担运费'
          : '运费险：本店未提供运费险';

      case 'main_category':
        return config.mainCategory
          ? `主营类目：${config.mainCategory}`
          : '店铺未配置主营类目';

      case 'all':
      default: {
        const lines: string[] = ['店铺业务信息：'];
        if (config.deliveryAddress) lines.push(`- 发货地址：${config.deliveryAddress}`);
        if (config.deliveryTime) lines.push(`- 发货时长：${config.deliveryTime}`);
        if (config.expressCompanies.length > 0) {
          lines.push(`- 合作快递：${config.expressCompanies.join('、')}`);
        }
        if (config.freeShipping) {
          lines.push(
            config.freeShippingCondition
              ? `- 包邮政策：全场包邮（${config.freeShippingCondition}）`
              : '- 包邮政策：全场包邮',
          );
        } else if (config.freeShippingCondition) {
          lines.push(`- 包邮政策：${config.freeShippingCondition}`);
        }
        if (config.freightInsurance) lines.push('- 运费险：提供');
        if (config.mainCategory) lines.push(`- 主营类目：${config.mainCategory}`);
        return lines.join('\n');
      }
    }
  },
};
