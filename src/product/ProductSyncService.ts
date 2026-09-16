import type { ShopSupervisor } from '../shop/ShopSupervisor';
import type { ProductManager } from './ProductManager';
import type { Product } from './ProductMatcher';
import type { AppLogger } from '../logging/logger';
import type { PlatformId } from '../platform';
import type { IWebviewManager } from '../cdp/types';
import fs from 'fs-extra';
import path from 'path';

import { SCRAPE_PRODUCT_LIST_SCRIPT, DIAGNOSE_SIDEBAR_SCRIPT, DIAGNOSE_LIST_PAGE_SCRIPT_SIMPLE, SCRAPE_PRODUCT_DETAIL_SCRIPT, DETAIL_PAGE_PRELOAD_SCRIPT, DETAILED_DIAG_SCRIPT, LIST_PAGE_PRELOAD_SCRIPT, PLATFORM_PRODUCT_URLS, RawProduct } from './scrape-scripts';
export interface SyncResult {
  shopId: string;
  total: number;
  imported: number;
  updated: number;
  removed: number;
  skipped: number;
  errors: string[];
  syncedAt: number;
  /** 单个商品同步失败详情 */
  failedProducts?: Array<{ productId: string; name: string; reason: string }>;
}

export interface SyncProgress {
  phase: 'opening' | 'scanning' | 'saving' | 'done' | 'error';
  page?: number;
  found?: number;
  total?: number;
  message?: string;
}

export interface SyncStatus {
  shopId: string;
  lastSyncAt: number | null;
  lastResult: SyncResult | null;
  productCount: number;
}

export class ProductSyncService {
  private readonly activeSyncs = new Map<string, Promise<SyncResult>>();

  /** 抖店后台导航关键词，用于检测侧边栏文本 */
  private static readonly SIDEBAR_NAV_KEYWORDS = [
    '返回首页', '巨量千川', '推广管理', '广告数据', '资金管理',
    '精选联盟', '电商罗盘', '服务市场', '学习中心', '规则中心', '功能中心',
    '课程中心', '案例中心', '最新直播', '商品管理', '订单管理', '售后工作台',
    '账户中心', '流量运营', '搜索运营', '短视频运营', '直播管理', '图文运营',
    '商城运营', '营销活动', '活动广场', '优惠券', '单品直降', '营销管理',
    '付费推广', '千川推广', '联盟推广', '订单发货', '卡券管理', '发货中心',
    '订单报备', '包裹中心', '物流工具', '电子面单', '物流服务', '物流诊断',
    '售后小助手', '售后挽单助手', '商品创建', '评价管理', '库存管理',
    '渠道品管理', '商品诊断', '商品托管', '商机中心', '商品成长', '商品工具',
    '商品素材', '源头好货', '竞拍管理', '店铺管理', '账号管理', '商家体验分',
    '违规管理', '店铺保障', '申诉中心', '店铺装修', '商家权益', '保险服务',
    '申请关店', '用户运营', '用户触达', '会员运营', '会员权益', '保证金账户',
    '抖店贷款', '账单管理', '返佣管理', '发票管理', '历史报表',
  ];

  /**
   * 检测文本是否为抖店后台侧边栏导航文本。
   * 匹配5个以上导航关键词则判定为侧边栏文本。
   */
  private static isSidebarNavText(text: string | undefined | null): boolean {
    if (!text || text.length < 10) return false;
    let matchCount = 0;
    for (const kw of ProductSyncService.SIDEBAR_NAV_KEYWORDS) {
      if (text.includes(kw)) matchCount++;
      if (matchCount >= 5) return true;
    }
    return false;
  }

  /**
   * 过滤无效描述（侧边栏导航文本、JavaScript 代码、HTML 脚本标签等），返回有效描述或 undefined。
   */
  private static filterValidDescription(text: string | undefined | null): string | undefined {
    if (!text || text.length < 10) return undefined;
    if (ProductSyncService.isSidebarNavText(text)) return undefined;
    // 过滤 JavaScript 代码（如 window.gfdatav1=...）、CSS、HTML 脚本内容
    const trimmed = text.trimStart();
    // JS 代码特征
    if (/^(window\.|var\s|function\s|\(\s*function|\(\(\)\s*=>|try\s*\{|<script|<!\[CDATA|const\s|let\s)/i.test(trimmed)) {
      return undefined;
    }
    // CSS 代码特征（如 [class*=xxx], .selector {, @media 等）
    if (/^(\[class|\.[-a-z]|#\w+\s*\{|@media|@import|@keyframes|:root\s*\{|html\s*\{|body\s*\{)/i.test(trimmed)) {
      return undefined;
    }
    // 包含大量 CSS 属性的特征
    if (/(position:\s*(absolute|relative|fixed)|display:\s*(flex|grid|block|none)|margin:\s*\d|padding:\s*\d|background:\s*#|font-size:\s*\d)/.test(trimmed.substring(0, 200))) {
      return undefined;
    }
    // 过滤包含 JSON/JS 赋值的文本（如 xxx={"env":"prod"}）
    if (/\w+\s*=\s*\{["\w]/.test(trimmed.substring(0, 100))) {
      return undefined;
    }
    // 过滤纯 JSON 字符串（不是自然语言描述）
    if (/^\s*\{["\w]/.test(trimmed) && /\}\s*$/.test(trimmed.trimEnd())) {
      return undefined;
    }
    return text;
  }

  /**
   * 当 API 无法获取商品描述时，从商品名称、分类、属性、规格、价格等信息构建合成描述。
   * 抖店列表 API 的 description/desc_detail/buy_desc/combo_desc 等字段均为空，
   * 详情 API 端点已弃用（404），消费者端页面有反爬检测，因此需要合成描述供客服使用。
   */
  private static buildSyntheticDescription(
    name: string,
    category: string | undefined,
    specs: Array<{ name: string; values: string[] }> | undefined,
    variants: Array<{ spec: string; price: number; stock: number; sku: string }> | undefined,
    attrs: Array<{ name: string; value: string }> | undefined,
  ): string {
    const parts: string[] = [];
    if (name) parts.push(`商品名称：${name}`);
    if (category) parts.push(`分类：${category}`);
    // 商品属性（材质、产地、成分含量等）
    if (attrs && attrs.length > 0) {
      const attrLines = attrs
        .filter((a) => a.name && a.value)
        .map((a) => `${a.name}：${a.value}`);
      if (attrLines.length > 0) parts.push(attrLines.join('\n'));
    }
    // 销售规格（颜色、尺码等，用于 SKU 组合）
    if (specs && specs.length > 0) {
      const specLines = specs
        .filter((s) => s.name && s.values && s.values.length > 0)
        .map((s) => `${s.name}：${s.values.join('、')}`);
      if (specLines.length > 0) parts.push(specLines.join('\n'));
    }
    if (variants && variants.length > 0) {
      const prices = variants.map((v) => v.price).filter((p) => p > 0);
      if (prices.length > 0) {
        const minPrice = Math.min(...prices);
        const maxPrice = Math.max(...prices);
        const priceStr = minPrice === maxPrice
          ? `￥${minPrice.toFixed(2)}`
          : `￥${minPrice.toFixed(2)} ~ ￥${maxPrice.toFixed(2)}`;
        parts.push(`价格：${priceStr}`);
      }
      const totalStock = variants.reduce((sum, v) => sum + (v.stock || 0), 0);
      if (totalStock > 0) parts.push(`库存：${totalStock}件`);
    }
    return parts.length > 0 ? parts.join('\n') : '';
  }

  /**
   * 提取图片 URL 的基础部分（去除尺寸后缀和 CDN 转换参数），用于去重。
   * 例如：webp_m_xxx_sx_123_www800-800 和 webp_m_xxx_sx_123_www1080-1080 视为同一图片。
   * 同时规范化 CDN 主机名（p3-aio / p9-aio → aio）和路径前缀（/obj/）。
   */
  private static getImageBaseUrl(url: string): string {
    if (!url) return url;
    // 规范化 CDN 主机名：pN-aio.ecombdimg.com → aio.ecombdimg.com
    let normalized = url.replace(/https?:\/\/p\d+-aio\./, 'https://aio.');
    // 去除 /obj/ 路径前缀差异
    normalized = normalized.replace(/\/obj\//, '/');
    // 去除 ~tplv-... 后缀（CDN 图片处理参数）
    const tplvIdx = normalized.indexOf('~tplv-');
    if (tplvIdx > 0) normalized = normalized.substring(0, tplvIdx);
    // 去除 _wwwNNN-NNN 尺寸后缀
    const wwwIdx = normalized.indexOf('_www');
    if (wwwIdx > 0) normalized = normalized.substring(0, wwwIdx);
    // 去除 _sx_NNNN 库存后缀
    const sxIdx = normalized.indexOf('_sx_');
    if (sxIdx > 0) normalized = normalized.substring(0, sxIdx);
    return normalized;
  }

  /**
   * 合并图片列表：优先保留新抓取的图片，再补充已有图片，去重。
   * 避免列表页仅抓到 1 张缩略图时覆盖已有的多张图片（详情页抓取失败或手动配置的图片）。
   * 按基础 URL 去重，避免同一图片的不同尺寸版本重复出现。
   */
  private static mergeImages(rawImages: string[] | undefined, existingImages: string[] | undefined): string[] {
    const raw = Array.isArray(rawImages) ? rawImages.filter((u): u is string => !!u) : [];
    const existing = Array.isArray(existingImages) ? existingImages.filter((u): u is string => !!u) : [];
    if (raw.length === 0) return existing;
    if (existing.length === 0) return raw;
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const url of raw.concat(existing)) {
      if (!url) continue;
      const baseUrl = ProductSyncService.getImageBaseUrl(url);
      if (!seen.has(baseUrl)) {
        seen.add(baseUrl);
        merged.push(url);
      }
    }
    return merged;
  }

  constructor(
    private supervisor: ShopSupervisor,
    private productManager: ProductManager,
    private logger: AppLogger,
    private dataDir: string,
    private webviewManager?: IWebviewManager,
  ) {}

  /**
   * 诊断客服会话页面右侧边栏的 DOM 结构。
   */
  async diagnoseProductSidebar(shopId: string): Promise<string> {
    if (!this.supervisor.hasShopStarted(shopId)) {
      throw new Error(`店铺 ${shopId} 未启动`);
    }
    this.logger.info({ shopId }, '开始诊断商品面板 DOM 结构');
    const result = await this.supervisor.executeScriptOnShop(shopId, DIAGNOSE_SIDEBAR_SCRIPT);
    this.logger.info({ shopId }, '商品面板诊断完成');
    return typeof result === 'string' ? result : JSON.stringify(result);
  }

  /**
   * 诊断客服会话页面的商品面板 DOM 结构。
   * 在客服会话页面执行脚本，收集右侧边栏商品相关信息。
   */
  async diagnoseProductListPage(shopId: string): Promise<string> {
    if (!this.supervisor.hasShopStarted(shopId)) {
      throw new Error(`店铺 ${shopId} 未启动`);
    }
    const platformId = this.supervisor.getShopPlatform(shopId) || 'feige';
    const productUrl = PLATFORM_PRODUCT_URLS[platformId as PlatformId];
    if (!this.webviewManager) {
      throw new Error('当前运行环境不支持打开商家后台商品管理页');
    }

    this.logger.info({ shopId, platformId, productUrl }, '开始诊断商家后台商品管理页');
    const result = await this.webviewManager.diagnoseWithNetworkCapture(
      shopId,
      productUrl,
      DIAGNOSE_LIST_PAGE_SCRIPT_SIMPLE,
      12_000,
      90_000,
    );
    const scriptData = this.parseJsonObject(result.scriptResult);
    const output = {
      ...scriptData,
      apiRequests: result.apiRequests.slice(0, 500),
      apiRequestCount: result.apiRequests.length,
    };
    this.logger.info(
      { shopId, platformId, apiRequestCount: result.apiRequests.length },
      '商家后台商品管理页诊断完成',
    );
    return JSON.stringify(output);
  }

  /**
   * 自动诊断：对所有已启动的店铺执行详细诊断，并把完整结果保存到文件。
   * 用于启动后自动分析客服会话页面 DOM 结构，优化抓取脚本。
   */
  async autoDiagnoseAndSave(shopId: string): Promise<void> {
    if (!this.supervisor.hasShopStarted(shopId)) {
      this.logger.warn({ shopId }, '自动诊断跳过：店铺未启动');
      return;
    }
    try {
      this.logger.info({ shopId }, '自动诊断：开始执行详细诊断');
      const result = await this.supervisor.executeScriptOnShop(shopId, DETAILED_DIAG_SCRIPT);
      const jsonStr = typeof result === 'string' ? result : JSON.stringify(result);
      const diagDir = path.join(this.dataDir, 'data', 'logs');
      await fs.ensureDir(diagDir);
      const diagPath = path.join(diagDir, `auto-diag-${shopId}.json`);
      await fs.writeFile(diagPath, jsonStr, 'utf-8');

      // 输出摘要到日志，便于排查
      let summary: Record<string, unknown> = {};
      try {
        const data = JSON.parse(jsonStr);
        summary = {
          url: data.url,
          bodyTextLength: data.bodyTextLength,
          foundTextsKeys: Object.keys(data.foundTexts || {}),
          priceElementCount: (data.priceElements || []).length,
          productImageCount: (data.productImages || []).length,
          dataIdElementCount: (data.dataIdElements || []).length,
          sidebarCandidateCount: (data.sidebarCandidates || []).length,
          productLikeElementCount: (data.productLikeElements || []).length,
          iframeCount: (data.iframes || []).length,
        };
      } catch {
        // ignore
      }
      this.logger.info({ shopId, diagPath, summary }, '自动诊断：详细结果已保存');
    } catch (err) {
      this.logger.error({ shopId, err: err instanceof Error ? err.message : String(err) }, '自动诊断失败');
    }
  }

  /**
   * 自动同步：执行商品抓取并把原始结果（含 debug 信息）保存到文件。
   * 用于启动后自动测试抓取脚本效果。
   * 根据店铺所属平台使用对应的抓取脚本。
   */
  async autoSyncAndSave(shopId: string): Promise<void> {
    if (!this.supervisor.hasShopStarted(shopId)) {
      this.logger.warn({ shopId }, '自动同步跳过：店铺未启动');
      return;
    }
    try {
      const platformId = this.supervisor.getShopPlatform(shopId) || 'feige';
      this.logger.info({ shopId, platformId }, '自动同步：开始执行平台专属抓取脚本');
      const scriptResult = await this.executeProductScrape(shopId, platformId);
      const jsonStr = typeof scriptResult === 'string' ? scriptResult : JSON.stringify(scriptResult);
      const syncDir = path.join(this.dataDir, 'data', 'logs');
      await fs.ensureDir(syncDir);
      const syncPath = path.join(syncDir, `auto-sync-${shopId}.json`);
      await fs.writeFile(syncPath, jsonStr, 'utf-8');

      let summary: Record<string, unknown> = {};
      try {
        const data = JSON.parse(jsonStr);
        summary = {
          productCount: (data.products || []).length,
          errorCount: (data.errors || []).length,
          errors: (data.errors || []).slice(0, 5),
          debugSteps: (data.debug || {}).steps || [],
          productNames: (data.products || []).slice(0, 10).map(function(p: RawProduct) { return p.name; }),
        };
      } catch {
        // ignore
      }
      this.logger.info({ shopId, syncPath, summary }, '自动同步：抓取结果已保存');
    } catch (err) {
      this.logger.error({ shopId, err: err instanceof Error ? err.message : String(err) }, '自动同步失败');
    }
  }

  async syncShopProducts(shopId: string, onProgress?: (progress: SyncProgress) => void): Promise<SyncResult> {
    const active = this.activeSyncs.get(shopId);
    if (active) {
      this.logger.info({ shopId }, '商品同步任务已在执行，复用当前任务');
      return active;
    }

    const task = this.performSyncShopProducts(shopId, onProgress).finally(() => {
      this.activeSyncs.delete(shopId);
    });
    this.activeSyncs.set(shopId, task);
    return task;
  }

  private async performSyncShopProducts(shopId: string, onProgress?: (progress: SyncProgress) => void): Promise<SyncResult> {
    const startedAt = Date.now();
    const platformId = this.supervisor.getShopPlatform(shopId) || 'feige';
    this.logger.info({ shopId, platformId }, '开始同步商品数据');

    onProgress?.({ phase: 'opening', message: '正在打开商品管理页面...' });

    if (!this.supervisor.hasShopStarted(shopId)) {
      throw new Error(`店铺 ${shopId} 未启动，无法同步商品`);
    }

    const errors: string[] = [];
    const failedProducts: Array<{ productId: string; name: string; reason: string }> = [];
    let rawProducts: RawProduct[] = [];

    try {
      const scriptResult = await this.executeProductScrape(shopId, platformId);

      const jsonStr = typeof scriptResult === 'string' ? scriptResult : JSON.stringify(scriptResult);
      let parsed: { products: RawProduct[]; errors: string[]; debug: unknown };

      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        errors.push('抓取脚本返回数据解析失败');
        this.logger.error({ shopId, jsonStrPreview: jsonStr.substring(0, 500) }, '商品同步：脚本返回数据解析失败');
        parsed = { products: [], errors: [], debug: null };
      }

      if (parsed.errors && parsed.errors.length > 0) {
        errors.push(...parsed.errors);
      }

      rawProducts = parsed.products || [];
      onProgress?.({ phase: 'scanning', found: rawProducts.length, message: `已发现 ${rawProducts.length} 个商品，正在保存...` });

      const debugData = parsed.debug as {
        steps?: Array<Record<string, unknown>>;
        apiProductCount?: number;
        preloadApiCount?: number;
        cdpApiCount?: number;
        apiSampleUrl?: string;
        apiSampleTopKeys?: string[];
        apiSampleProductKeys?: string[];
        apiSampleProduct?: Record<string, unknown>;
        apiSampleProductUrl?: string;
        firstApiProductKeys?: string[];
        firstApiProduct?: Record<string, unknown>;
        rawApiProductKeys?: string[];
        rawApiProductSample?: Record<string, unknown>;
        rawDescFields?: string[];
        rawSpecFields?: string[];
        rawAttrFields?: string[];
        allApiUrls?: string[];
        preloadApiDataCount?: number;
        scannedApiUrlCount?: number;
        totalApiDataCount?: number;
        allRequestUrlCount?: number;
        scannedApiSuccess?: Array<Record<string, unknown>>;
        scannedApiErrors?: Array<Record<string, unknown>>;
        debugStatusTexts?: Array<Record<string, unknown>>;
        detailApiFetch?: { attempted: number; succeeded: number; failed: number; errors: Array<Record<string, unknown>> };
        detailApiFirstResponse?: Record<string, unknown>;
        detailApiFirstSuccess?: Record<string, unknown>;
        productFormatNewSample?: Record<string, unknown>;
        categoryDetailKeys?: string[];
        categoryDetailSample?: Record<string, unknown>;
      } | null;
      const debugSteps = debugData?.steps || (parsed as unknown as { steps?: Array<Record<string, unknown>> }).steps || [];
      const debugStatusTexts = debugData?.debugStatusTexts || [];
      const productNames = rawProducts.slice(0, 10).map((p) => p.name);
      this.logger.info(
        {
          shopId, productCount: rawProducts.length, productNames, debugSteps,
          apiProductCount: debugData?.apiProductCount,
          preloadApiCount: debugData?.preloadApiCount,
          cdpApiCount: debugData?.cdpApiCount,
          apiSampleUrl: debugData?.apiSampleUrl,
          apiSampleTopKeys: debugData?.apiSampleTopKeys,
          apiSampleProductKeys: debugData?.apiSampleProductKeys,
          apiSampleProduct: debugData?.apiSampleProduct,
          apiSampleProductUrl: debugData?.apiSampleProductUrl,
          firstApiProductKeys: debugData?.firstApiProductKeys,
          firstApiProduct: debugData?.firstApiProduct,
          rawApiProductKeys: debugData?.rawApiProductKeys,
          rawApiProductSample: debugData?.rawApiProductSample,
          rawDescFields: debugData?.rawDescFields,
          rawSpecFields: debugData?.rawSpecFields,
          rawAttrFields: debugData?.rawAttrFields,
          allApiUrls: debugData?.allApiUrls,
          preloadApiDataCount: debugData?.preloadApiDataCount,
          scannedApiUrlCount: debugData?.scannedApiUrlCount,
          totalApiDataCount: debugData?.totalApiDataCount,
          allRequestUrlCount: debugData?.allRequestUrlCount,
          scannedApiSuccess: debugData?.scannedApiSuccess,
          scannedApiErrors: debugData?.scannedApiErrors,
          debugStatusTexts,
          detailApiFetch: debugData?.detailApiFetch,
          detailApiFirstResponse: debugData?.detailApiFirstResponse,
          detailApiFirstSuccess: debugData?.detailApiFirstSuccess,
          productFormatNewSample: debugData?.productFormatNewSample,
          categoryDetailKeys: debugData?.categoryDetailKeys,
          categoryDetailSample: debugData?.categoryDetailSample,
        },
        '商品同步：商家后台商品管理页抓取完成',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ shopId, err: msg }, '商品同步失败');
      errors.push(msg);
      onProgress?.({ phase: 'error', message: `同步失败: ${msg}` });
    }

    // ===== 阶段3：逐商品详情页抓取，补充完整商品信息 =====
    if (platformId === 'feige' && this.webviewManager && rawProducts.length > 0) {
      const DETAIL_PAGE_TIMEOUT = 90_000;
      const DETAIL_WAIT_MS = 22_000;
      const DETAIL_DELAY_MS = 800;

      let detailScraped = 0;
      let detailSkipped = 0;
      let detailFailed = 0;
      let detailRedirected = 0;
      const totalProducts = rawProducts.length;

      onProgress?.({ phase: 'scanning', found: totalProducts, message: `正在抓取商品详情 (0/${totalProducts})...` });

      for (let di = 0; di < rawProducts.length; di++) {
        const raw = rawProducts[di];
        if (!raw.productId || !/^[A-Za-z0-9_-]{6,64}$/.test(raw.productId)) continue;

        // 跳过已有足够详情的商品
        const hasDescription = raw.description && raw.description.length > 10;
        const hasCategory = raw.category && raw.category.length > 1;
        const hasSpecs = raw.specs && raw.specs.length > 0;
        const hasAttrs = raw.attrs && raw.attrs.length > 0;
        const hasImages = raw.images && raw.images.length > 1;
        if (hasDescription && hasCategory && hasSpecs && hasAttrs && hasImages) {
          detailSkipped++;
          continue;
        }

        // /ffa/g/product/detail 和 /ffa/g/product/edit 已废弃并会重定向到服务市场。
        // 仅抓取列表 API 返回的真实详情 URL；没有 URL 时保留列表数据/已有详情，避免每件商品空等超时。
        const detailUrl = raw.url && raw.url.startsWith('http') ? raw.url : '';
        if (!detailUrl) {
          detailSkipped++;
          continue;
        }

        try {
          await new Promise<void>((r) => setTimeout(r, DETAIL_DELAY_MS));
          const detailResult = await this.webviewManager.scrapeUrlInHiddenWindow(
            shopId,
            detailUrl,
            SCRAPE_PRODUCT_DETAIL_SCRIPT,
            DETAIL_PAGE_TIMEOUT,
            DETAIL_WAIT_MS,
            DETAIL_PAGE_PRELOAD_SCRIPT,
          );

          const detailStr = typeof detailResult === 'string' ? detailResult : JSON.stringify(detailResult);
          let detail: { description?: string; category?: string; specs?: Array<{ name: string; values: string[] }>; attrs?: Array<{ name: string; value: string }>; images?: string[]; debug?: unknown };
          try {
            detail = JSON.parse(detailStr);
          } catch {
            detailFailed++;
            this.logger.warn({ shopId, productId: raw.productId, detailStr: detailStr?.substring(0, 200) }, '详情页抓取结果JSON解析失败');
            continue;
          }

          this.logger.info(
            { shopId, productId: raw.productId, name: raw.name?.substring(0, 30),
              hasDesc: !!(detail.description && detail.description.length > 10),
              descLen: detail.description?.length || 0,
              hasCategory: !!detail.category,
              specCount: detail.specs?.length || 0,
              attrCount: detail.attrs?.length || 0,
              imgCount: detail.images?.length || 0,
              descPreview: detail.description?.substring(0, 100),
              debug: detail.debug },
            '详情页抓取结果',
          );

          // 检测详情页是否被客户端重定向到抖店服务市场首页
          // 仅对 fxg.jinritemai.com 的编辑页/详情页路由检测（消费者端页面 haohuo.jinritemai.com 不会重定向）
          const detailDbg = (detail.debug || {}) as { bodyTextLength?: number; bodyTextSnippet?: string; currentUrl?: string };
          const bodySnippet = (detailDbg.bodyTextSnippet || '').substring(0, 600);
          const bodyLen = detailDbg.bodyTextLength || 0;
          const currentDetailUrl = detailDbg.currentUrl || detailUrl || '';
          const isEditPageUrl = currentDetailUrl.includes('fxg.jinritemai.com') && currentDetailUrl.includes('/ffa/g/product/');
          const isServiceMarketRedirect = isEditPageUrl && bodyLen > 0 && bodyLen < 2000
            && (bodySnippet.includes('服务市场是什么') || bodySnippet.includes('巨量千川'));
          if (isServiceMarketRedirect) {
            detailRedirected++;
            this.logger.warn(
              { shopId, productId: raw.productId, name: raw.name, bodyTextLength: bodyLen,
                currentUrl: detailDbg.currentUrl, detailIndex: di, totalProducts },
              '商品编辑页已重定向到抖店服务市场首页（/ffa/g/product/detail 与 /ffa/g/product/edit 路由均已被抖店废弃），该商品将尝试使用消费者端详情页URL',
            );
            // 编辑页重定向不中止整个阶段，仅跳过当前商品（其他商品可能使用消费者端URL）
            continue;
          }

          if (detail.description) {
            // 验证描述不是侧边栏导航文本
            const navKeywords = ['返回首页', '巨量千川', '推广管理', '广告数据', '资金管理',
              '精选联盟', '电商罗盘', '服务市场', '学习中心', '规则中心', '功能中心',
              '课程中心', '案例中心', '最新直播', '商品管理', '订单管理', '售后工作台',
              '账户中心', '流量运营', '搜索运营', '短视频运营', '直播管理', '图文运营',
              '商城运营', '营销活动', '活动广场', '优惠券', '单品直降', '营销管理',
              '付费推广', '千川推广', '联盟推广', '订单发货', '卡券管理', '发货中心',
              '订单报备', '包裹中心', '物流工具', '电子面单', '物流服务', '物流诊断',
              '售后小助手', '售后挽单助手', '商品创建', '评价管理', '库存管理',
              '渠道品管理', '商品诊断', '商品托管', '商机中心', '商品成长', '商品工具',
              '商品素材', '源头好货', '竞拍管理', '店铺管理', '账号管理', '商家体验分',
              '违规管理', '店铺保障', '申诉中心', '店铺装修', '商家权益', '保险服务',
              '申请关店', '用户运营', '用户触达', '会员运营', '会员权益', '保证金账户',
              '抖店贷款', '账单管理', '返佣管理', '发票管理', '历史报表'];
            let matchCount = 0;
            for (const kw of navKeywords) {
              if (detail.description.includes(kw)) matchCount++;
              if (matchCount >= 5) break;
            }
            if (matchCount < 5) {
              raw.description = detail.description;
            } else {
              this.logger.debug({ shopId, productId: raw.productId, descPreview: detail.description.substring(0, 100) }, '详情页描述疑似侧边栏文本，已过滤');
            }
          }
          if (detail.category && !raw.category) raw.category = detail.category;
          if (detail.specs && detail.specs.length > 0 && (!raw.specs || raw.specs.length === 0)) raw.specs = detail.specs;
          if (detail.attrs && detail.attrs.length > 0 && (!raw.attrs || raw.attrs.length === 0)) raw.attrs = detail.attrs;
          if (detail.images && detail.images.length > 0) {
            if (!raw.images || raw.images.length === 0) {
              raw.images = detail.images;
            } else {
              // 合并：保留列表页已有图片，补充详情页新图片
              const existingUrls = new Set(raw.images);
              for (const img of detail.images) {
                if (!existingUrls.has(img)) {
                  raw.images.push(img);
                }
              }
            }
            if (!raw.imageUrl && raw.images.length > 0) raw.imageUrl = raw.images[0];
          }

          detailScraped++;
          if (detailScraped % 5 === 0 || detailScraped === 1) {
            onProgress?.({ phase: 'scanning', found: totalProducts, message: `正在抓取商品详情 (${detailScraped}/${totalProducts})...` });
          }
        } catch (err) {
          detailFailed++;
          this.logger.warn(
            { shopId, productId: raw.productId, name: raw.name, err: err instanceof Error ? err.message : String(err) },
            '商品详情页抓取失败',
          );
        }
      }

      this.logger.info(
        { shopId, detailScraped, detailSkipped, detailFailed, detailRedirected, totalProducts,
          detailRouteDeprecated: detailRedirected > 0 },
        '商品详情页抓取阶段完成',
      );
      if (detailRedirected > 0) {
        onProgress?.({ phase: 'scanning', found: totalProducts,
          message: `详情页路由已废弃（${detailRedirected} 个商品重定向到服务市场首页），已跳过详情抓取，仅同步列表页数据` });
      }
    }

    // 智能合并：保留现有商品的规格、物流、售后等字段
    const products: Product[] = [];
    let imported = 0;
    let updated = 0;
    let removed = 0;
    let skipped = 0;

    const existing = await this.productManager.listProducts(shopId);
    const existingMap = new Map(existing.map((p) => [p.product_id, p]));

    const seenProductIds = new Set<string>();
    const seenNames = new Set<string>();
    for (const raw of rawProducts) {
      const name = this.normalizeProductName(raw.name);
      const scrapedId = typeof raw.productId === 'string' ? raw.productId.trim() : '';
      const hasStableId = /^[A-Za-z0-9_-]{6,64}$/.test(scrapedId);

      // 数据校验
      if (!name) {
        failedProducts.push({ productId: scrapedId || 'unknown', name: raw.name || '', reason: '商品名称为空或无效' });
        skipped++;
        continue;
      }
      if (platformId === 'feige' && !hasStableId) {
        failedProducts.push({ productId: scrapedId || 'unknown', name, reason: '商品ID无效' });
        skipped++;
        continue;
      }
      if (name.length > 200) {
        failedProducts.push({ productId: scrapedId, name: name.substring(0, 50) + '...', reason: `商品名称过长(${name.length}字)` });
        skipped++;
        continue;
      }

      // 非飞鸽平台无稳定商品 ID：用名称哈希生成稳定 ID，
      // 避免每次同步都生成 sync_时间戳_N 新 ID 导致商品库无限膨胀（重复同步互相覆盖）
      const productId = hasStableId || (platformId !== 'feige' && scrapedId)
        ? scrapedId
        : `sync_${this.hashName(name)}`;

      if (seenProductIds.has(productId)) {
        skipped++;
        continue;
      }
      if (seenNames.has(name)) {
        failedProducts.push({ productId, name, reason: '商品名称重复' });
        skipped++;
        continue;
      }
      seenProductIds.add(productId);
      seenNames.add(name);

      const existingProduct = existingMap.get(productId);

      const variants = this.mergeVariants(existingProduct, raw, productId);

      // 价格和库存数据缺失不影响导入，仅记录日志
      if (variants.length === 0) {
        this.logger?.warn({ shopId, productId, name }, '商品同步：价格和库存数据缺失，将以空 variants 导入');
      }

      const product: Product = {
        product_id: productId,
        name,
        sku: raw.sku || existingProduct?.sku || productId,
        // 列表接口经常返回空 specs/attrs；空数组不应覆盖此前从详情页或人工维护的完整数据。
        specs: Array.isArray(raw.specs) && raw.specs.length > 0 ? raw.specs : (existingProduct?.specs ?? []),
        attrs: Array.isArray(raw.attrs) && raw.attrs.length > 0 ? raw.attrs : (existingProduct?.attrs ?? []),
        variants,
        shipping: existingProduct?.shipping ?? {
          free_shipping: false,
          delivery_days: '2-3天',
          logistics: ['中通'],
        },
        after_sales: existingProduct?.after_sales ?? {
          return_days: 7,
          exchange_days: 15,
          policy: '7天无理由退货',
        },
        faq: existingProduct?.faq ?? [],
        keywords: existingProduct?.keywords ?? this.extractKeywords(name),
        active: typeof raw.active === 'boolean' ? raw.active : (existingProduct?.active ?? true),
        // 描述优先级：API 原始描述 > 已有真实描述 > 合成描述
        // 合成描述（以"商品名称："开头）每次同步都重新生成，确保 attrs/specs 分离后内容正确
        description: ProductSyncService.filterValidDescription(raw.description)
          || (existingProduct?.description && !existingProduct.description.startsWith('商品名称：')
              ? ProductSyncService.filterValidDescription(existingProduct.description) : '')
          || ProductSyncService.buildSyntheticDescription(
            name,
            raw.category || existingProduct?.category,
            Array.isArray(raw.specs) && raw.specs.length > 0 ? raw.specs : (existingProduct?.specs ?? []),
            variants,
            Array.isArray(raw.attrs) && raw.attrs.length > 0 ? raw.attrs : (existingProduct?.attrs ?? []),
          ),
        category: raw.category || existingProduct?.category,
        images: ProductSyncService.mergeImages(raw.images, existingProduct?.images),
        createdAt: raw.createdAt || existingProduct?.createdAt,
        updatedAt: raw.updatedAt || existingProduct?.updatedAt,
        sales: typeof raw.sales === 'number' ? raw.sales : (existingProduct?.sales ?? 0),
      };

      if (existingProduct) {
        updated++;
      } else {
        imported++;
      }
      products.push(product);
    }

    if (products.length > 0) {
      const json = JSON.stringify({ products });
      await this.productManager.importProducts(shopId, json);
      // 清理历史残留的合成 ID 商品（sync_时间戳_N 旧格式、gen_N 已下架残留）：
      //   仅清理「库中存在且本次同步未抓取到」的合成 ID 商品——
      //   gen_N 商品本次会被重新导入（覆盖更新），若不加「未抓取到」条件会把刚导入的商品全部删除
      const fetchedProductIds = new Set(products.map((p) => p.product_id));
      const staleSyntheticIds = existing
        .map((product) => product.product_id)
        .filter((id) => /^(?:gen_\d+|sync_\d+_\d+)$/.test(id) && !fetchedProductIds.has(id));
      removed = await this.productManager.removeProducts(shopId, staleSyntheticIds);
      await this.supervisor.reloadProductCatalog(shopId);
    }

    if (platformId === 'feige' && rawProducts.length > 0 && products.length === 0) {
      errors.push('抓取结果中没有带真实商品ID的有效商品，本地商品库未修改');
    }

    if (failedProducts.length > 0) {
      this.logger.warn(
        { shopId, failedCount: failedProducts.length, failedProducts: failedProducts.slice(0, 20) },
        '商品同步：部分商品校验失败',
      );
    }

    const result: SyncResult = {
      shopId,
      total: products.length,
      imported,
      updated,
      removed,
      skipped,
      errors,
      syncedAt: startedAt,
      failedProducts: failedProducts.length > 0 ? failedProducts : undefined,
    };

    await this.saveSyncStatus(shopId, result);
    this.logger.info(
      { shopId, total: result.total, imported, updated, removed, skipped, failed: failedProducts.length, durationMs: Date.now() - startedAt },
      '商品同步完成',
    );

    onProgress?.({ phase: 'done', total: result.total, message: `同步完成: ${result.total} 个商品` });

    return result;

  }

  private async executeProductScrape(shopId: string, platformId: string): Promise<unknown> {
    if (!this.webviewManager) {
      throw new Error('当前运行环境不支持商家后台商品同步');
    }
    const productUrl = PLATFORM_PRODUCT_URLS[platformId as PlatformId];
    if (!productUrl) throw new Error(`暂不支持平台 ${platformId} 的商品后台同步`);
    this.logger.info({ shopId, platformId, productUrl }, '商品同步：打开商家后台商品管理页');
    return this.webviewManager.scrapeUrlInHiddenWindow(
      shopId,
      productUrl,
      SCRAPE_PRODUCT_LIST_SCRIPT,
      240_000,
      10_000,
      LIST_PAGE_PRELOAD_SCRIPT,
    );
  }

  private parseJsonObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return { raw: value.substring(0, 10_000) };
      }
    }
    return {};
  }

  private normalizeProductName(value: unknown): string {
    if (typeof value !== 'string') return '';
    const name = value.replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 200) return '';
    if (/^(立减|满减|优惠|券后)[\d.]+元?$/.test(name)) return '';
    if (/^[¥￥]?[\d,.]+(?:元|件)?$/.test(name)) return '';
    return name;
  }

  private mergeVariants(existingProduct: Product | undefined, raw: RawProduct, productId: string): Product['variants'] {
    const existing = existingProduct?.variants ?? [];
    const price = typeof raw.price === 'number' && Number.isFinite(raw.price) && raw.price >= 0
      ? raw.price
      : undefined;
    const stock = typeof raw.stock === 'number' && Number.isFinite(raw.stock) && raw.stock >= 0
      ? Math.floor(raw.stock)
      : undefined;
    const priceLow = typeof raw.priceLow === 'number' && Number.isFinite(raw.priceLow) && raw.priceLow > 0
      ? raw.priceLow
      : undefined;
    const priceHigh = typeof raw.priceHigh === 'number' && Number.isFinite(raw.priceHigh) && raw.priceHigh > 0
      ? raw.priceHigh
      : undefined;

    // 优先使用从详情 API 获取的 SKU 数据生成 variants
    if (raw.skus && raw.skus.length > 0) {
      const skuVariants = raw.skus
        .map((sku): Product['variants'][0] | null => {
          const s = sku as Record<string, unknown>;
          const skuPrice = typeof s.price === 'number' ? s.price / 100 :
                           typeof s.price === 'string' ? parseFloat(s.price) / 100 : 0;
          const skuStock = typeof s.stock_num === 'number' ? s.stock_num :
                           typeof s.stock === 'number' ? s.stock :
                           typeof s.quantity === 'number' ? s.quantity : 0;
          const skuId = typeof s.sku_id === 'string' ? s.sku_id :
                       typeof s.sku_id === 'number' ? String(s.sku_id) :
                       typeof s.id === 'string' ? s.id :
                       typeof s.id === 'number' ? String(s.id) : '';
          // 从 spec_detail 提取规格组合名称
          let specName = '默认';
          const specDetail = s.spec_detail || s.spec_list || s.specs;
          if (Array.isArray(specDetail)) {
            const parts = specDetail
              .map((d: Record<string, unknown>) => (d.spec_value || d.value || d.name || '') as string)
              .filter(Boolean);
            if (parts.length > 0) specName = parts.join('+');
          }
          if (skuPrice > 0 || skuStock > 0 || skuId) {
            // 防御：skuStock 可能为无法解析的字符串，避免 NaN 入库
            const safeStock = Number.isFinite(skuStock) && skuStock >= 0 ? Math.floor(skuStock) : 0;
            return { spec: specName, price: skuPrice || price || 0, stock: safeStock, sku: skuId || raw.sku || productId };
          }
          return null;
        })
        .filter((v): v is Product['variants'][0] => v !== null);
      if (skuVariants.length > 0) return skuVariants;
    }

    // 无 SKU 数据时，基于 specs（销售规格）创建真实 SKU 组合
    // 优先选值最多的规格作为主规格：单值→1个 variant（用真实规格值命名），
    // 多值→为每个规格值创建一个 variant（如材质有2个值→2个 variant）
    const specs = Array.isArray(raw.specs) ? raw.specs : [];
    const primarySpec = specs
      .filter((s) => s.values && s.values.length > 0)
      .sort((a, b) => (b.values?.length || 0) - (a.values?.length || 0))[0];
    if (primarySpec && primarySpec.values && primarySpec.values.length > 0) {
      const values = primarySpec.values;
      const numVariants = values.length;
      const totalStock = stock ?? 0;
      const perStock = Math.floor(totalStock / numVariants);
      const remainder = totalStock - perStock * numVariants;
      const variants: Product['variants'] = values.map((value, index) => {
        // 价格分配：单值用 price||priceLow；多值时第一个用 priceLow，最后一个用 priceHigh，中间按比例插值
        let vPrice = price ?? priceLow ?? 0;
        if (numVariants > 1 && priceLow !== undefined && priceHigh !== undefined && priceLow !== priceHigh) {
          if (index === 0) vPrice = priceLow;
          else if (index === numVariants - 1) vPrice = priceHigh;
          else {
            const ratio = index / (numVariants - 1);
            vPrice = Math.round((priceLow + (priceHigh - priceLow) * ratio) * 100) / 100;
          }
        }
        // 库存分配：平均分配总库存，余数加到第一个
        const vStock = perStock + (index === 0 ? remainder : 0);
        return { spec: value, price: vPrice, stock: vStock, sku: raw.sku || productId };
      });
      return variants;
    }

    // 无 specs 但有价格范围 → 创建两个 variant，库存分配到第一个
    if (priceLow !== undefined && priceHigh !== undefined && priceLow !== priceHigh) {
      const variants: Product['variants'] = [
        { spec: '基础款', price: priceLow, stock: stock ?? 0, sku: raw.sku || productId },
        { spec: '升级款', price: priceHigh, stock: 0, sku: raw.sku || productId },
      ];
      return variants;
    }

    if (existing.length === 0) {
      if (price === undefined && stock === undefined && priceLow === undefined) return [];
      return [{
        spec: '默认',
        price: price ?? priceLow ?? 0,
        stock: stock ?? 0,
        sku: raw.sku || productId,
      }];
    }

    if (existing.length === 1) {
      return [{
        ...existing[0],
        price: price ?? priceLow ?? existing[0].price,
        stock: stock ?? existing[0].stock,
        sku: raw.sku || existing[0].sku,
      }];
    }

    return existing;
  }

  async getSyncStatus(shopId: string): Promise<SyncStatus | null> {
    const statusPath = this.getSyncStatusPath(shopId);
    if (!(await fs.pathExists(statusPath))) {
      const count = (await this.productManager.listProducts(shopId)).length;
      return { shopId, lastSyncAt: null, lastResult: null, productCount: count };
    }
    try {
      const data = await fs.readJson(statusPath);
      const count = (await this.productManager.listProducts(shopId)).length;
      return {
        shopId,
        lastSyncAt: data.syncedAt ?? null,
        lastResult: data ?? null,
        productCount: count,
      };
    } catch {
      return { shopId, lastSyncAt: null, lastResult: null, productCount: 0 };
    }
  }

  private extractKeywords(name: string): string[] {
    const cleaned = name.replace(/[（）()【】\[\]{}「」『』<>《》]/g, ' ').trim();
    const parts = cleaned.split(/[\s,，、;；]+/).filter((s) => s.length >= 2);
    return Array.from(new Set(parts)).slice(0, 10);
  }

  /** 商品名称 → 稳定哈希 ID（非飞鸽平台无真实商品 ID 时使用，保证重复同步覆盖同一商品） */
  private hashName(name: string): string {
    let hash = 0;
    const str = name.trim();
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    // 正数化 + 16 位长度
    return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 8);
  }

  private getSyncStatusPath(shopId: string): string {
    return path.join(this.dataDir, 'data', 'shops', shopId, 'sync-status.json');
  }

  private async saveSyncStatus(shopId: string, result: SyncResult): Promise<void> {
    const statusPath = this.getSyncStatusPath(shopId);
    await fs.ensureDir(path.dirname(statusPath));
    await fs.writeJson(statusPath, result, { spaces: 2 });
  }
}
