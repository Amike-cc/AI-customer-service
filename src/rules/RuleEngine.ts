import type { Config } from '../config/schema';
import type { RuleInfo } from './types';
import type { PlatformId } from '../platform';
import fs from 'fs-extra';
import path from 'path';
import { resolveResource, resolveData } from '../paths';

export interface RuleMatchResult {
  matched: boolean;
  answer?: string;
  ruleName?: string;
}

interface CompiledRule {
  name: string;
  pattern: RegExp;
  answer: string;
  priority: number;
  enabled: boolean;
  source: 'default' | 'custom' | 'faq' | 'category' | 'shop_config' | 'platform_default';
}

/** 店铺配置信息（用于生成动态规则） */
export interface ShopConfigInfo {
  deliveryAddress: string;
  deliveryTime: string;
  freightInsurance: boolean;
  expressCompanies: string[];
  freeShipping: boolean;
  freeShippingCondition: string;
  mainCategory: string;
}

interface RawCustomRule {
  name: string;
  pattern: string;
  answer: string;
  priority: number;
  enabled: boolean;
  source: 'custom';
}

interface FaqEntry {
  q: string;
  a: string;
  priority?: number;
  category?: string;
  tags?: string[];
  updatedAt?: number;
}

export interface FaqInfo {
  q: string;
  a: string;
  priority: number;
  category?: string;
  tags?: string[];
  updatedAt?: number;
}

export class RuleEngine {
  private rules: CompiledRule[] = [];
  private customRulesPath: string;
  private fallbackCustomRulesPath: string | null = null;
  private categoryRulesPath: string;
  private faqPath: string | null;
  private shopId: string | undefined;
  private shopConfig: ShopConfigInfo | undefined;
  private mainCategory: string | undefined;
  private platformId: PlatformId | undefined;
  private platformRulesPath: string | null;

  constructor(config: Config, shopId?: string, shopConfig?: ShopConfigInfo, platformId?: PlatformId) {
    this.shopId = shopId;
    this.shopConfig = shopConfig;
    this.mainCategory = shopConfig?.mainCategory;
    this.platformId = platformId;
    this.categoryRulesPath = resolveResource('config', 'rules', 'category-rules.json');

    // 平台专属默认规则文件路径：config/rules/{platformId}/defaults.json
    this.platformRulesPath = platformId
      ? resolveResource('config', 'rules', platformId, 'defaults.json')
      : null;

    if (shopId) {
      // 每个店铺+平台使用独立的规则文件，确保规则管理互相隔离
      // 路径结构：config/rules/{platformId}/{shopId}/custom-rules.json
      const platformDir = platformId || 'common';
      const shopRulePath = resolveResource('config', 'rules', platformDir, shopId, 'custom-rules.json');
      const globalRulePath = resolveResource('config', 'rules', 'custom-rules.json');
      // 旧版规则路径（无平台维度）：config/rules/{shopId}/custom-rules.json
      const legacyShopRulePath = resolveResource('config', 'rules', shopId, 'custom-rules.json');
      // 读取时允许继承旧版或全局规则，但不要在构造阶段复制文件。
      // 店铺第一次真正保存规则时才创建专属文件，避免只读启动和测试产生大量重复目录。
      this.fallbackCustomRulesPath = fs.pathExistsSync(legacyShopRulePath)
        ? legacyShopRulePath
        : globalRulePath;
      this.customRulesPath = shopRulePath;
      // 与其他店铺数据模块（TemplateLibrary/ProductManager/VersionManager）保持一致的目录结构：
      // {data_dir}/data/shops/{shopId}/faq.json，避免 FAQ 与其他店铺数据分居两套目录导致备份/迁移遗漏
      this.faqPath = resolveData(config.app.data_dir, 'data', 'shops', shopId, 'faq.json');
    } else {
      this.customRulesPath = resolveResource('config', 'rules', 'custom-rules.json');
      this.faqPath = null;
    }
    this.reloadRules();
  }

  /** 获取当前规则引擎的平台 ID */
  getPlatformId(): PlatformId | undefined {
    return this.platformId;
  }

  /** 动态更新店铺配置并重载规则（配置变更时调用） */
  setShopConfig(config: ShopConfigInfo | undefined): void {
    this.shopConfig = config;
    this.mainCategory = config?.mainCategory;
    this.reloadRules();
  }

  getRuleShopId(): string | undefined {
    return this.shopId;
  }

  private loadDefaultRules(): CompiledRule[] {
    return [
      {
        name: 'greeting',
        pattern: /^(你好|您好|hi|hello|哈喽|在吗|在不在|有人吗|有人|亲|老板在吗|客服在吗|hello啊|嗨|hey|诶)/i,
        answer: '亲，您好！很高兴为您服务，请问有什么可以帮您？',
        priority: 100,
        enabled: true,
        source: 'default',
      },
      {
        name: 'human_service',
        // 只匹配强转人工意图词，避免裸词"客服"拦截"客服推荐下尺码"等普通咨询
        pattern: /(转人工|转接人工|找人工|接人工|人工客服|真人客服|人工.*处理|找.*真人|不要.*机器人|不想.*机器人|不是.*机器人|我要.*人工|给我.*人工|请.*人工|麻烦.*人工)/i,
        answer: '亲，这类问题需要人工客服核实处理，请稍候由人工客服为您服务。',
        priority: 95,
        enabled: true,
        source: 'default',
      },
      {
        name: 'thanks',
        // 以感谢开头但带真实问题（"谢谢，什么时候发货？"）时不应只回"不客气"，
        // 排除以问句/疑问词结尾的消息，让后续规则继续匹配真实问题
        pattern: /^(谢谢|感谢|多谢|thanks|thx|谢啦|辛苦了|谢了|3q|3Q|感激)[^\n]{0,20}$(?<!\?|？|吗|呢|呀|啊|吧|什么时候|怎么|为什么|多少|多久)/i,
        answer: '不客气，有问题随时联系我们哦~祝您购物愉快！',
        priority: 90,
        enabled: true,
        source: 'default',
      },
      {
        name: 'size_inquiry',
        pattern: /(尺码|尺寸|多大|多大码|什么码|多大号|身高.*体重|多高.*多重|推荐.*码|选.*码|穿.*码|多少斤|斤.*穿|多高|身高|体重|胖.*穿|瘦.*穿|合适.*码|码数|号型|多大尺码|尺寸表|尺码表|尺码建议|适合.*斤|适合.*高)/i,
        answer: '亲，建议您参考商品详情页的尺码表哦~您可以告诉我身高体重，我帮您推荐合适的尺码。【尺码表】在详情页向下滑动即可查看。',
        priority: 85,
        enabled: true,
        source: 'default',
      },
      {
        name: 'emoji_only',
        pattern: /^[\s\p{Emoji}\p{Punctuation}]+$/u,
        answer: '亲，请问有什么具体问题需要咨询呢？',
        priority: 80,
        enabled: true,
        source: 'default',
      },
      {
        name: 'return_policy',
        pattern: /(退货|退款|退钱|退.*货|不想要了|七天|7天|无理由|退.*款|破损|错发|漏发|损坏|发错|退掉|不要了|退货.*怎么|怎么.*退货|退.*流程|申请.*退|退.*申请)/i,
        answer: '亲，售后问题需要人工客服为您核实处理，我帮您转接人工客服，请稍等~',
        priority: 95,
        enabled: true,
        source: 'default',
      },
      {
        name: 'exchange_policy',
        pattern: /(换货|换.*货|换.*码|换.*颜色|换.*款|调换|15天|十五天|换一个|换个|换.*大小|换.*尺码)/i,
        answer: '亲，换货问题需要人工客服为您核实处理，我帮您转接人工客服，请稍等~',
        priority: 94,
        enabled: true,
        source: 'default',
      },
      {
        name: 'invoice_inquiry',
        pattern: /(发票|开票|抬头|税号|专票|普票|电子发票|开发票|能开.*票|开.*发票|发票.*怎么)/i,
        answer: '亲，是否支持开票及可开票类型请以订单详情页的开票入口为准；如页面没有入口，请联系人工客服核实。',
        priority: 73,
        enabled: true,
        source: 'default',
      },
      {
        name: 'shipping_time',
        pattern: /(什么时候|几天|多久|多长时间).*(发货|到货|送达|收到|发出|寄出|能到|送到|到.*手里|到手)/i,
        answer: '亲，预计发货和送达时间请以商品页、订单页显示为准；下单后可在订单详情中查看最新进度。',
        priority: 70,
        enabled: true,
        source: 'default',
      },
      {
        name: 'logistics_query',
        pattern: /(物流|快递|单号|到哪了|什么时候到|催.*快递|查.*物流|中通|圆通|申通|韵达|顺丰|ems|EMS|快递.*到了|快递.*发|快递.*单号|物流.*单号|到哪了|走到哪|快递.*慢|快递.*催)/i,
        answer: '亲，请在订单详情页查看实时物流信息。若物流长时间未更新，可通过订单售后入口联系人工客服核实。',
        priority: 65,
        enabled: true,
        source: 'default',
      },
      {
        name: 'activity_inquiry',
        pattern: /(活动|优惠|满减|促销|打折|折扣|赠品|满赠|大促|618|双11|双12|年货节|有.*活动|有.*优惠|有什么.*优惠|满.*减|打折吗|便宜.*吗|优惠.*有)/i,
        answer: '亲，当前可用优惠请以商品详情页和结算页显示为准；优惠能否叠加也以结算页实际结果为准。',
        priority: 60,
        enabled: true,
        source: 'default',
      },
      {
        name: 'coupon_inquiry',
        pattern: /(优惠券|券|红包|优惠券.*怎么|领.*券|用.*券|券.*叠加|券.*使用|有.*券|发.*券|送.*券|领券|券.*怎么用|券.*怎么领)/i,
        answer: '亲，优惠券可在【我的优惠券】中查看和使用哦~下单时在结算页选择可用优惠券即可。优惠券不可叠加使用，以使用规则为准。如有疑问请联系人工客服。',
        priority: 55,
        enabled: true,
        source: 'default',
      },
      {
        name: 'payment_inquiry',
        pattern: /(支付|付款|怎么.*付|怎么.*支付|货到付款|分期|花呗|信用卡|支付宝|微信支付|怎么.*付款|付款方式|支持.*支付|支持.*付款|能.*分期|花呗.*分期)/i,
        answer: '亲，可用支付方式和是否支持分期请以下单结算页显示为准。',
        priority: 50,
        enabled: true,
        source: 'default',
      },
      {
        name: 'shipping_insurance',
        pattern: /(运费险|退货运费险|退运险|退货.*运费)/i,
        answer: '亲，是否包含运费险请查看商品详情页“保障/服务”区域；页面显示“运费险”即表示该商品支持，已下单也可在订单详情中查看。',
        priority: 52,
        enabled: true,
        source: 'default',
      },
      {
        name: 'shipping_origin',
        pattern: /(哪里发货|哪发货|从哪里发|从哪发|发货地|哪个仓|什么仓发)/i,
        answer: '亲，发货仓库会根据库存和收货地址实际分配，下单前无法准确确认具体城市；请以下单后的订单详情和物流信息为准。',
        priority: 51,
        enabled: true,
        source: 'default',
      },
      {
        name: 'stock_inquiry',
        pattern: /(有货吗|库存|现货|还有吗|有没有货|什么时候.*有货|补货|到货|没货|缺货|断货|还有.*件|库存.*多少|还有多少|有现货吗)/i,
        answer: '亲，商品库存以页面显示为准哦~显示"有货"即可直接下单。如显示"无货"，建议关注店铺等候补货通知，或联系人工客服咨询补货时间。',
        priority: 45,
        enabled: true,
        source: 'default',
      },
      {
        name: 'price_inquiry',
        pattern: /(多少钱|价格|价位|卖多少|怎么卖|便宜点|能不能便宜|最低价|算便宜|优惠点|多少.*钱|卖.*钱|卖.*多少|价格.*多少|能便宜|能优惠|打折吗|能少吗|少点)/i,
        answer: '亲，商品价格以页面显示为准哦~我们承诺价格透明，不议价。【当前优惠】请关注店铺活动和优惠券，下单更划算。如有大额采购需求请联系人工客服。',
        priority: 40,
        enabled: true,
        source: 'default',
      },
      {
        name: 'material_inquiry',
        pattern: /(材质|材料|什么.*做的|成分|面料|纯棉|涤纶|材质.*安全|环保|无毒|什么材料|什么面料|材质.*什么|用的.*材料|是.*材质|面料.*什么)(?!.*对比|.*区别|.*推荐|.*哪个|.*比.*好)/i,
        answer: '亲，商品材质请以详情页“产品参数”或“面料/成分”标注为准；如果您告诉我具体商品和想确认的成分，我可以继续帮您查看。',
        priority: 35,
        enabled: true,
        source: 'default',
      },
      {
        name: 'complaint_apology',
        pattern: /(投诉|差评|曝光|举报|骗子|坑人|太差了|什么破|垃圾|退款.*不退|不解决|纠纷|维权|12315|消费者协会|什么.*东西|什么.*质量|质量.*差|太.*差|差.*评|差评.*给|给.*差评)/i,
        answer: '亲，非常抱歉给您带来不好的体验！这类问题需要人工客服为您处理，我帮您转接人工客服，请稍等~',
        priority: 97,
        enabled: true,
        source: 'default',
      },
      {
        name: 'closing',
        pattern: /^(好的|收到|知道了|明白|了解|嗯嗯|ok|OK|行|好的吧|就这样|嗯|噢|哦|好滴|好勒|收到啦)/i,
        answer: '好的亲，如有其他问题随时联系我哦~祝您生活愉快，期待下次为您服务！',
        priority: 25,
        enabled: true,
        source: 'default',
      },
      {
        name: 'after_sales_progress',
        pattern: /(退款.*进度|退货.*到了|审核.*多久|退款.*多久|退货.*进度|退款.*到账|退款.*查询|售后.*进度|退货.*审核|退款.*什么时候|退款.*什么时候到|退款.*到了吗|退款.*到了|退款.*到了没|退款.*成功|退款.*到账.*吗)/i,
        answer: '亲，售后进度需要人工核实您的订单，已为您转接人工客服，请稍候~',
        priority: 96,
        enabled: true,
        source: 'default',
      },
      {
        name: 'order_modification',
        pattern: /(修改.*订单|改.*订单|取消.*订单|退.*订单|改.*地址|改.*收货|修改.*地址|换.*地址|补发|赔偿|补偿|赔.*钱|退.*钱|少发|漏发|没收到货|没收到|地址.*写.*错|地址.*错|改.*电话|改.*名字|收货.*改|订单.*改|取消.*下单|不想要.*订单)/i,
        answer: '亲，订单修改和补发赔偿问题需要人工客服为您处理，我帮您转接人工客服，请稍等~',
        priority: 96,
        enabled: true,
        source: 'default',
      },
      {
        name: 'authenticity_inquiry',
        pattern: /(正品|真伪|假货|是不是真的|真的假的|正品吗|真假|真货|假一|专柜验货|正品保障|是真.*吗|假.*吗|正品.*吗|真品|真货吗|假的吗|不是.*正品|正品.*吗)/i,
        answer: '亲，商品来源和保障范围请以商品详情页的品牌授权、正品保障等标识为准；如需进一步核实，请联系人工客服。',
        priority: 72,
        enabled: true,
        source: 'default',
      },
      {
        name: 'product_comparison',
        pattern: /(对比|区别|差异|哪个好|比.*好|哪款好|有什么不同|有什么区别|两款.*区别|哪个.*推荐|哪个.*好|哪.*更好|哪.*适合|区别.*什么|不同.*什么|差异.*什么)/i,
        answer: '亲，每款商品都有各自特色哦~建议您根据需求选择。【对比建议】请告诉我您的具体需求和使用场景，我帮您推荐最合适的款式。商品详情页也有详细参数对比，供您参考。',
        priority: 68,
        enabled: true,
        source: 'default',
      },
      {
        name: 'membership_inquiry',
        pattern: /(会员|积分|等级|权益|会员日|会员卡|升级.*会员|会员.*等级|积分.*兑换|积分.*怎么|vip|VIP|积分.*多少|会员.*什么|会员.*权益|积分.*什么用)/i,
        answer: '亲，会员体系以店铺活动为准哦~【会员权益】通常包含专属折扣、积分兑换、生日礼遇等。积分可在下单时抵扣，具体规则请关注店铺会员中心页面。如有疑问可联系人工客服。',
        priority: 58,
        enabled: true,
        source: 'default',
      },
      {
        name: 'shipping_cost_inquiry',
        pattern: /(运费|邮费|包邮|免邮|免运费|运费.*多少|邮费.*多少|要不要邮费|收不收邮费|运费.*吗|邮费.*吗|包不包邮|免费.*邮|邮.*免)/i,
        answer: '亲，运费以结算页面显示为准哦~【包邮说明】部分商品满额包邮，具体以商品页面标识为准。偏远地区可能需要补运费差价，以下单页面实际显示为准。',
        priority: 43,
        enabled: true,
        source: 'default',
      },
      {
        name: 'store_hours',
        pattern: /(营业时间|几点.*下班|几点.*上班|客服.*时间|在线时间|什么时候.*客服|客服.*几点|客服.*下班|客服.*在线|几点.*客服|在线.*吗|在.*吗.*客服)/i,
        answer: '亲，人工客服在线时间请以店铺页面显示为准；非在线时段可以先留言，工作人员上线后会处理。',
        priority: 28,
        enabled: true,
        source: 'default',
      },
      {
        name: 'product_recommendation',
        pattern: /(推荐|推荐.*款|有什么.*推荐|哪个.*好|推荐.*买|买什么|推荐.*商品|适合.*买|有什么.*好|好.*推荐|爆款|热销|什么.*卖.*好|推荐.*下)/i,
        answer: '亲，您可以告诉我您的需求（如用途、预算、偏好），我来为您推荐合适的商品哦~也可以参考店铺首页的热销榜单，都是买家们的好评之选！',
        priority: 38,
        enabled: true,
        source: 'default',
      },
      {
        name: 'color_variants',
        pattern: /(什么颜色|有哪些颜色|颜色|几色|多少.*颜色|有什么色|色.*选择|色.*可选|有.*颜色|色系)/i,
        answer: '亲，商品可选颜色请在详情页查看哦~【颜色选择】在商品页面的规格区域可以选择您喜欢的颜色。如某个颜色显示缺货，建议关注补货或联系人工客服咨询。',
        priority: 42,
        enabled: true,
        source: 'default',
      },
      {
        name: 'spec_inquiry',
        pattern: /(规格|参数|配置|多大.*容量|容量.*多少|多大.*尺寸|重量|多重|多少.*克|多少.*kg|多少.*斤|规格.*什么|参数.*什么|详细.*参数|具体.*参数)/i,
        answer: '亲，商品规格参数请在详情页"产品参数"中查看哦~如有具体参数疑问，请告诉我您想了解的内容，我帮您确认。',
        priority: 33,
        enabled: true,
        source: 'default',
      },
      {
        name: 'usage_inquiry',
        pattern: /(怎么用|怎么.*使用|使用.*方法|用法|使用说明|操作.*方法|怎么操作|如何.*使用|怎么.*装|安装.*方法|怎么.*装|用.*什么)/i,
        answer: '亲，商品使用方法请参考详情页的【使用说明】或附带的说明书哦~如有具体使用问题，请详细描述您遇到的情况，我帮您解答。',
        priority: 30,
        enabled: true,
        source: 'default',
      },
    ];
  }

  private loadRawCustomRules(): RawCustomRule[] {
    try {
      const rulesPath = fs.pathExistsSync(this.customRulesPath)
        ? this.customRulesPath
        : this.fallbackCustomRulesPath;
      if (!rulesPath || !fs.pathExistsSync(rulesPath)) return [];
      const data = fs.readJsonSync(rulesPath);
      const rawRules: Array<Record<string, unknown>> = data.rules ?? [];
      const result: RawCustomRule[] = [];
      for (const r of rawRules) {
        result.push({
          name: String(r.name),
          pattern: String(r.pattern),
          answer: String(r.answer),
          priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 50,
          enabled: r.enabled !== false,
          source: 'custom',
        });
      }
      return result;
    } catch {
      return [];
    }
  }

  private compileRule(raw: RawCustomRule): CompiledRule | null {
    try {
      return {
        name: raw.name,
        pattern: new RegExp(raw.pattern, 'i'),
        answer: raw.answer,
        priority: raw.priority,
        enabled: raw.enabled,
        source: 'custom',
      };
    } catch {
      return null;
    }
  }

  private loadCustomRules(): CompiledRule[] {
    return this.loadRawCustomRules()
      .map((r) => this.compileRule(r))
      .filter((r): r is CompiledRule => r !== null);
  }

  /** 按店铺主营类目加载专属规则知识库 */
  private loadCategoryRules(): CompiledRule[] {
    if (!this.mainCategory) return [];
    try {
      if (!fs.pathExistsSync(this.categoryRulesPath)) return [];
      const data = fs.readJsonSync(this.categoryRulesPath);
      const categoryRules: Array<Record<string, unknown>> = data[this.mainCategory] ?? [];
      const result: CompiledRule[] = [];
      for (const r of categoryRules) {
        try {
          result.push({
            name: String(r.name),
            pattern: new RegExp(String(r.pattern), 'i'),
            answer: String(r.answer),
            priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 50,
            enabled: r.enabled !== false,
            source: 'category',
          });
        } catch {
          // 跳过无效的类目规则
        }
      }
      return result;
    } catch {
      return [];
    }
  }

  /** 加载平台专属默认规则（从 config/rules/{platformId}/defaults.json） */
  private loadPlatformDefaultRules(): CompiledRule[] {
    if (!this.platformRulesPath || !fs.pathExistsSync(this.platformRulesPath)) {
      // 平台规则文件不存在时，使用内置平台规则
      return this.loadBuiltinPlatformRules();
    }
    try {
      const data = fs.readJsonSync(this.platformRulesPath);
      const rawRules: Array<Record<string, unknown>> = data.rules ?? [];
      const result: CompiledRule[] = [];
      for (const r of rawRules) {
        try {
          result.push({
            name: String(r.name),
            pattern: new RegExp(String(r.pattern), 'i'),
            answer: String(r.answer),
            priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 70,
            enabled: r.enabled !== false,
            source: 'platform_default',
          });
        } catch {
          // 跳过无效的平台规则
        }
      }
      return result;
    } catch {
      return this.loadBuiltinPlatformRules();
    }
  }

  /** 内置的平台专属规则（各平台特有的业务场景） */
  private loadBuiltinPlatformRules(): CompiledRule[] {
    if (!this.platformId) return [];
    const rules: CompiledRule[] = [];

    if (this.platformId === 'feige') {
      // 飞鸽（抖音电商）平台专属规则
      rules.push(
        {
          name: 'feige_live_stream',
          pattern: /(直播|直播间|主播|主播说|直播价|直播专属|直播福利|几点直播|直播.*多久)/i,
          answer: '亲，直播相关信息请关注店铺直播间哦~直播间通常有专属优惠，欢迎来直播间互动！',
          priority: 75,
          enabled: true,
          source: 'platform_default',
        },
        {
          name: 'feige_douyin_promo',
          pattern: /(抖音.*券|抖音.*优惠|抖音.*活动|粉丝券|关注券)/i,
          answer: '亲，抖音专属优惠请关注我们的抖音店铺首页和直播间哦~关注店铺可领取粉丝专属优惠券。',
          priority: 72,
          enabled: true,
          source: 'platform_default',
        },
      );
    } else if (this.platformId === 'pinduoduo') {
      // 拼多多平台专属规则
      rules.push(
        {
          name: 'pinduoduo_group_buy',
          pattern: /(拼单|拼团|团购|单独买|拼着买|拼团价|单独价|几人团|拼团.*多久|拼单.*多久)/i,
          answer: '亲，拼团更优惠哦~您可以发起拼单，等待其他买家参与；也可以选择单独购买（价格略高）。拼团有效期通常为24小时，超时自动退款。',
          priority: 82,
          enabled: true,
          source: 'platform_default',
        },
        {
          name: 'pinduoduo_bargain',
          pattern: /(砍价|砍一刀|帮忙砍|免费拿|砍价.*群)/i,
          answer: '亲，砍价活动请通过拼多多APP参与哦~分享砍价链接给好友帮忙砍价，砍到0元即可免费获得商品。',
          priority: 70,
          enabled: true,
          source: 'platform_default',
        },
        {
          name: 'pinduoduo_subsidy',
          pattern: /(百亿补贴|补贴价|官方补贴|补贴.*多少)/i,
          answer: '亲，百亿补贴商品由平台官方补贴，价格更优惠！补贴金额以页面显示为准，数量有限，先到先得~',
          priority: 76,
          enabled: true,
          source: 'platform_default',
        },
      );
    } else if (this.platformId === 'kuaishou') {
      // 快手小店平台专属规则
      rules.push(
        {
          name: 'kuaishou_live',
          pattern: /(直播|直播间|主播|快手.*直播|短视频|小黄车)/i,
          answer: '亲，直播相关信息请关注我们的快手直播间哦~直播间有小黄车可以直接下单，还有专属直播优惠！',
          priority: 75,
          enabled: true,
          source: 'platform_default',
        },
      );
    } else if (this.platformId === 'weixin') {
      // 微信小店平台专属规则
      rules.push(
        {
          name: 'weixin_mini_program',
          pattern: /(小程序|小程序.*买|微信.*买|视频号|视频号.*直播)/i,
          answer: '亲，您可以通过我们的微信小程序或视频号直播间下单哦~微信小店购物更便捷，支持微信支付。',
          priority: 72,
          enabled: true,
          source: 'platform_default',
        },
      );
    }

    return rules;
  }

  /** 根据店铺配置信息生成动态规则（发货地址、运费险、快递、包邮） */
  private loadShopConfigRules(): CompiledRule[] {
    if (!this.shopConfig) return [];
    const cfg = this.shopConfig;
    const rules: CompiledRule[] = [];

    // 发货地址
    if (cfg.deliveryAddress) {
      rules.push({
        name: 'shop_delivery_address',
        pattern: /(哪里发货|从哪发|发货地|发货地址|产地发货|哪里寄|从哪里发|发货.*哪里|什么地方发货)/i,
        answer: `亲，我们的发货地址是：${cfg.deliveryAddress}~`,
        priority: 78,
        enabled: true,
        source: 'shop_config',
      });
    }

    // 发货时长
    if (cfg.deliveryTime) {
      rules.push({
        name: 'shop_delivery_time',
        pattern: /(什么时候发货|多久发货|几天发货|发货.*多久|发货.*时间|什么时候发|当天发|当天发货|发货快吗|发货.*快|多久发出|几小时.*发货)/i,
        answer: `亲，下单后${cfg.deliveryTime}安排发货~`,
        priority: 78,
        enabled: true,
        source: 'shop_config',
      });
    }

    // 运费险
    rules.push({
      name: 'shop_freight_insurance',
      pattern: /(运费险|退货运费|运费.*保险|退货.*运费|有运费险|运费险.*吗)/i,
      answer: cfg.freightInsurance
        ? '亲，我们提供运费险服务，退换货时运费由保险公司承担，请放心购买~'
        : '亲，本店暂不提供运费险服务，如有退换货需求请联系客服处理~',
      priority: 78,
      enabled: true,
      source: 'shop_config',
    });

    // 合作快递
    if (cfg.expressCompanies.length > 0) {
      rules.push({
        name: 'shop_express',
        pattern: /(发什么快递|什么快递|快递公司|发.*快递|哪个快递|用什么快递|合作快递)/i,
        answer: `亲，我们合作的快递公司有：${cfg.expressCompanies.join('、')}~我们会根据您的收货地址选择最合适的快递。`,
        priority: 78,
        enabled: true,
        source: 'shop_config',
      });
    }

    // 包邮政策
    rules.push({
      name: 'shop_free_shipping',
      pattern: /(包邮|免邮|免运费|运费.*多少|邮费|包邮.*吗|免邮.*吗)/i,
      answer: cfg.freeShipping
        ? `亲，${cfg.freeShippingCondition || '本店全场包邮'}，请放心购买~`
        : '亲，运费根据您的收货地址自动计算，具体费用在下单页面可以看到哦~',
      priority: 78,
      enabled: true,
      source: 'shop_config',
    });

    return rules;
  }

  reloadRules(): void {
    const defaults = this.loadDefaultRules();
    const platformDefaults = this.loadPlatformDefaultRules();
    const customs = this.loadCustomRules();
    const categories = this.loadCategoryRules();
    const shopConfigs = this.loadShopConfigRules();
    const faqs = this.loadFaqRules();
    // 规则加载顺序：通用默认 → 平台默认 → 店铺配置 → 类目 → 自定义 → FAQ
    // 后加载的同名规则不会覆盖先加载的，但优先级排序后高优先级先匹配
    this.rules = [...defaults, ...platformDefaults, ...shopConfigs, ...categories, ...customs, ...faqs].sort((a, b) => b.priority - a.priority);
  }

  private loadFaqRules(): CompiledRule[] {
    if (!this.faqPath || !fs.pathExistsSync(this.faqPath)) return [];
    try {
      const data = fs.readJsonSync(this.faqPath);
      const entries: FaqEntry[] = Array.isArray(data) ? data : [];
      return entries.map((entry, idx) => ({
        name: `faq_${idx}`,
        pattern: new RegExp(this.escapeRegex(entry.q), 'i'),
        answer: entry.a,
        priority: entry.priority ?? 75,
        enabled: true,
        source: 'faq' as const,
      }));
    } catch {
      return [];
    }
  }

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  match(text: string): RuleMatchResult {
    const trimmed = text.trim();
    // 空/过短消息走 empty_short 罐头回复（emoji_only 等规则处理多字符输入）
    if (!trimmed || trimmed.length < 2) {
      return { matched: true, answer: '亲，请问有什么可以帮您？', ruleName: 'empty_short' };
    }

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.pattern.test(trimmed)) {
        return { matched: true, answer: rule.answer, ruleName: rule.name };
      }
    }
    return { matched: false };
  }

  listRules(): RuleInfo[] {
    return this.rules.map((r) => ({
      name: r.name,
      pattern: r.pattern.source,
      answer: r.answer,
      priority: r.priority,
      enabled: r.enabled,
      source: r.source,
    }));
  }

  addRule(rule: RuleInfo): void {
    if (this.rules.some((r) => r.name === rule.name)) {
      throw new Error(`规则 "${rule.name}" 已存在`);
    }
    // 保存前校验正则合法性，避免无效正则落盘后 reloadRules 静默丢弃导致规则"消失"
    this.assertValidPattern(rule.pattern);
    const customRules = this.loadRawCustomRules();
    customRules.push({
      name: rule.name,
      pattern: rule.pattern,
      answer: rule.answer,
      priority: rule.priority,
      enabled: rule.enabled,
      source: 'custom',
    });
    this.saveCustomRules(customRules);
    this.reloadRules();
  }

  updateRule(name: string, updates: Partial<RuleInfo>): void {
    const customRules = this.loadRawCustomRules();
    const idx = customRules.findIndex((r) => r.name === name);
    if (idx === -1) {
      throw new Error(`自定义规则 "${name}" 不存在`);
    }
    if (updates.pattern !== undefined) {
      this.assertValidPattern(updates.pattern);
      customRules[idx].pattern = updates.pattern;
    }
    if (updates.answer !== undefined) customRules[idx].answer = updates.answer;
    if (updates.priority !== undefined) customRules[idx].priority = updates.priority;
    if (updates.enabled !== undefined) customRules[idx].enabled = updates.enabled;
    this.saveCustomRules(customRules);
    this.reloadRules();
  }

  /** 校验正则表达式合法性，无效时抛出带位置的错误信息 */
  private assertValidPattern(pattern: string): void {
    try {
      new RegExp(pattern, 'i');
    } catch (err) {
      throw new Error(
        `正则表达式无效: ${pattern} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  deleteRule(name: string): void {
    const customRules = this.loadRawCustomRules();
    const filtered = customRules.filter((r) => r.name !== name);
    if (filtered.length === customRules.length) {
      throw new Error(`自定义规则 "${name}" 不存在`);
    }
    this.saveCustomRules(filtered);
    this.reloadRules();
  }

  /** 批量导入规则（JSON 格式） */
  importRules(json: string): { imported: number; errors: string[] } {
    let data: { rules?: Array<Record<string, unknown>> };
    try {
      data = JSON.parse(json);
    } catch {
      return { imported: 0, errors: ['JSON 格式无效'] };
    }

    const rawRules = data.rules;
    if (!Array.isArray(rawRules)) {
      return { imported: 0, errors: ['JSON 中缺少 rules 数组'] };
    }

    const errors: string[] = [];
    let imported = 0;
    // 先合并全部规则到内存，最后一次性 saveCustomRules + reloadRules，
    // 避免每条规则都重写文件并重编译正则（O(N²) 磁盘 IO，L-12）。
    const customRules = this.loadRawCustomRules();
    const existingNames = new Set(customRules.map((r) => r.name));
    for (let i = 0; i < rawRules.length; i++) {
      const r = rawRules[i];
      try {
        const rule: RuleInfo = {
          name: String(r.name),
          pattern: String(r.pattern),
          answer: String(r.answer),
          priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 50,
          enabled: r.enabled !== false,
          source: 'custom',
        };
        // 与 addRule/updateRule 一致：导入前校验正则合法性，
        // 否则无效正则落盘后 reloadRules 静默丢弃，用户导入的规则"消失"且无报错
        this.assertValidPattern(rule.pattern);
        if (existingNames.has(rule.name)) {
          throw new Error(`规则 "${rule.name}" 已存在`);
        }
        customRules.push({
          name: rule.name,
          pattern: rule.pattern,
          answer: rule.answer,
          priority: rule.priority,
          enabled: rule.enabled,
          source: 'custom',
        });
        existingNames.add(rule.name);
        imported += 1;
      } catch (err) {
        errors.push(`第 ${i + 1} 条: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (imported > 0) {
      this.saveCustomRules(customRules);
      this.reloadRules();
    }
    return { imported, errors };
  }

  private saveCustomRules(rules: RawCustomRule[]): void {
    fs.ensureDirSync(path.dirname(this.customRulesPath));
    fs.writeJsonSync(this.customRulesPath, { rules }, { spaces: 2 });
  }

  listFaqs(): FaqInfo[] {
    if (!this.faqPath || !fs.pathExistsSync(this.faqPath)) return [];
    try {
      const data = fs.readJsonSync(this.faqPath);
      const entries: FaqEntry[] = Array.isArray(data) ? data : [];
      return entries.map((e) => ({
        q: e.q,
        a: e.a,
        priority: e.priority ?? 75,
        category: e.category ?? 'general',
        tags: e.tags ?? [],
        updatedAt: e.updatedAt,
      }));
    } catch {
      return [];
    }
  }

  addFaq(faq: FaqInfo): void {
    const entries = this.loadRawFaqs();
    entries.push({
      q: faq.q,
      a: faq.a,
      priority: faq.priority,
      category: faq.category ?? 'general',
      tags: faq.tags ?? [],
      updatedAt: Date.now(),
    });
    this.saveFaqs(entries);
    this.reloadRules();
  }

  updateFaq(index: number, updates: Partial<FaqInfo>): void {
    const entries = this.loadRawFaqs();
    if (index < 0 || index >= entries.length) {
      throw new Error(`FAQ 索引 ${index} 不存在`);
    }
    if (updates.q !== undefined) entries[index].q = updates.q;
    if (updates.a !== undefined) entries[index].a = updates.a;
    if (updates.priority !== undefined) entries[index].priority = updates.priority;
    if (updates.category !== undefined) entries[index].category = updates.category;
    if (updates.tags !== undefined) entries[index].tags = updates.tags;
    entries[index].updatedAt = Date.now();
    this.saveFaqs(entries);
    this.reloadRules();
  }

  deleteFaq(index: number): void {
    const entries = this.loadRawFaqs();
    if (index < 0 || index >= entries.length) {
      throw new Error(`FAQ 索引 ${index} 不存在`);
    }
    entries.splice(index, 1);
    this.saveFaqs(entries);
    this.reloadRules();
  }

  private loadRawFaqs(): FaqEntry[] {
    if (!this.faqPath || !fs.pathExistsSync(this.faqPath)) return [];
    try {
      const data = fs.readJsonSync(this.faqPath);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  private saveFaqs(entries: FaqEntry[]): void {
    if (!this.faqPath) {
      throw new Error('当前引擎非店铺引擎，不支持 FAQ 管理');
    }
    const dir = path.dirname(this.faqPath);
    if (!fs.pathExistsSync(dir)) {
      fs.mkdirpSync(dir);
    }
    fs.writeJsonSync(this.faqPath, entries, { spaces: 2 });
  }
}

