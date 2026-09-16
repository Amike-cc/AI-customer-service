import type { PlatformId } from '../platform';

export interface RawProduct {
  productId?: string;
  name?: string;
  sku?: string;
  price?: number;
  priceLow?: number;
  priceHigh?: number;
  stock?: number;
  spec?: string;
  url?: string;
  imageUrl?: string;
  images?: string[];
  description?: string;
  category?: string;
  specs?: Array<{ name: string; values: string[] }>;
  attrs?: Array<{ name: string; value: string }>;
  active?: boolean;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  sales?: number;
  /** SKU 列表（从详情 API 获取，列表 API 中为 null） */
  skus?: Array<Record<string, unknown>>;
}

/** 各平台商家后台商品列表 URL */
export const PLATFORM_PRODUCT_URLS: Record<PlatformId, string> = {
  feige: 'https://fxg.jinritemai.com/ffa/g/list',
  pinduoduo: 'https://mms.pinduoduo.com/goods/goods_list',
  kuaishou: 'https://s.kwaixiaodian.com/zone/shop/itemManager',
  weixin: 'https://store.weixin.qq.com/shop/goods/list',
};

/**
 * 诊断脚本：收集客服会话页面右侧边栏中商品相关元素的 DOM 结构信息。
 */
export const DIAGNOSE_SIDEBAR_SCRIPT = `(function() {
  var info = {
    url: window.location.href,
    timestamp: Date.now(),
    foundTexts: {},
    sidebarCandidates: [],
    tabItems: [],
    workStationInfo: null,
    bodyTextSnippet: (document.body.innerText || '').substring(0, 800)
  };

  // 包含飞鸽右侧面板标签页文本（订单/会话搜索/商品/快捷短语），用于间接确认右侧面板状态
  var targetTexts = ['商品', '订单', '快捷短语', '会话搜索', '全部商品', '规格属性', '商品规格', '商品属性', '商品列表', '商品信息', '商品详情', '商品推荐', '最新订单'];
  var MAX_PER_TEXT = 2;

  function getDomPath(el) {
    var path = [];
    var cur = el;
    for (var d = 0; d < 4 && cur; d++) {
      path.push({
        tag: cur.tagName,
        className: (cur.className || '').toString().substring(0, 80),
        id: cur.id || ''
      });
      cur = cur.parentElement;
    }
    return path;
  }

  var allEls = document.querySelectorAll('span, div, a, li, button, p, td, th, h1, h2, h3, h4, h5, h6, label');
  for (var i = 0; i < allEls.length; i++) {
    var el = allEls[i];
    if (el.children.length === 0 || el.tagName === 'A' || el.tagName === 'BUTTON' || el.tagName === 'LI') {
      var t = (el.innerText || '').trim();
      if (t && targetTexts.indexOf(t) >= 0) {
        if (!info.foundTexts[t]) info.foundTexts[t] = [];
        if (info.foundTexts[t].length >= MAX_PER_TEXT) continue;
        var rect = el.getBoundingClientRect();
        info.foundTexts[t].push({
          tag: el.tagName,
          className: (el.className || '').toString().substring(0, 100),
          path: getDomPath(el),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
        });
      }
    }
  }

  // 收集所有 tabItem 元素信息（飞鸽标签页 class: tabItem-CEs_CV）
  var tabItemEls = document.querySelectorAll('[class*="tabItem"]');
  for (var ti = 0; ti < tabItemEls.length && ti < 10; ti++) {
    var tEl = tabItemEls[ti];
    if (tEl.offsetParent === null && tEl.tagName !== 'BODY') continue;
    var tRect = tEl.getBoundingClientRect();
    info.tabItems.push({
      tag: tEl.tagName,
      className: (tEl.className || '').toString().substring(0, 100),
      text: (tEl.innerText || '').trim().substring(0, 30),
      rect: { x: Math.round(tRect.x), y: Math.round(tRect.y), w: Math.round(tRect.width), h: Math.round(tRect.height) }
    });
  }

  // 飞鸽右侧面板容器：id="workStation" 或 class 含 workStation
  var wsEl = document.getElementById('workStation') || document.querySelector('[class*="workStation"]');
  if (wsEl) {
    var wsRect = wsEl.getBoundingClientRect();
    info.workStationInfo = {
      tag: wsEl.tagName,
      id: wsEl.id,
      className: (wsEl.className || '').toString().substring(0, 150),
      rect: { x: Math.round(wsRect.x), y: Math.round(wsRect.y), w: Math.round(wsRect.width), h: Math.round(wsRect.height) },
      childCount: wsEl.children.length,
      textSnippet: (wsEl.innerText || '').trim().substring(0, 300)
    };
  }

  var sidebarSelectors = [
    '#workStation', '[class*="workStation"]',
    '[class*="sidebar"]', '[class*="right-panel"]', '[class*="right-side"]',
    '[class*="aside"]', '[class*="panel-right"]', '[class*="workspace-right"]',
    '[class*="right-wrap"]', '[class*="info-panel"]', '[class*="detail-panel"]'
  ];
  for (var s = 0; s < sidebarSelectors.length; s++) {
    var els = document.querySelectorAll(sidebarSelectors[s]);
    for (var j = 0; j < els.length && j < 2; j++) {
      var text = (els[j].innerText || '').trim();
      if (text.length > 5) {
        info.sidebarCandidates.push({
          selector: sidebarSelectors[s],
          index: j,
          className: (els[j].className || '').toString().substring(0, 100),
          textSnippet: text.substring(0, 150),
          childCount: els[j].children.length
        });
      }
    }
  }

  return JSON.stringify(info);
})()`;

/**
 * 商品列表抓取脚本（异步）：在商家后台商品管理页面执行。
 *
 * 功能：
 * 1. 拦截页面 API 请求获取完整商品数据
 * 2. 自动翻页抓取所有处于"上架"状态的商品
 * 3. 提取完整属性：名称、SKU、价格、库存、图片、分类、规格、状态
 * 4. 兼容多种 DOM 结构（表格行、卡片列表）
 */

/**
 * 商品列表页 Preload 脚本：在页面 JS 执行前拦截 fetch/XHR，捕获 API 响应。
 * 通过 scrapeUrlInHiddenWindow 的 preloadScript 参数注入，确保在 SPA 发起 API 调用前完成拦截。
 */
export const LIST_PAGE_PRELOAD_SCRIPT = `(function() {
  // 当 preload 在 iframe/微前端容器中运行时，window 是 iframe 自己的 window，
  // 导致 __apiCaptures 分散在各 frame 中，主 frame 的脚本读取不到。
  // 解决：优先将捕获数据推送到 window.top.__apiCaptures（同源 iframe 可访问），
  // 跨域时回退到当前 frame 的 window.__apiCaptures。
  var captureTarget;
  try {
    if (window.top && window.top !== window) {
      if (!window.top.__apiCaptures) window.top.__apiCaptures = [];
      captureTarget = window.top;
    } else {
      window.__apiCaptures = window.__apiCaptures || [];
      captureTarget = window;
    }
  } catch(e) {
    // 跨域 iframe 访问 window.top 抛异常，回退到当前 frame
    window.__apiCaptures = window.__apiCaptures || [];
    captureTarget = window;
  }
  if (!captureTarget.__apiCaptures) captureTarget.__apiCaptures = [];

  var origFetch = window.fetch;
  window.fetch = function() {
    var url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url || '');
    return origFetch.apply(this, arguments).then(function(resp) {
      if (resp && resp.clone && /product|goods|spu|item|list|tproduct/i.test(url)) {
        try {
          var cloned = resp.clone();
          cloned.json().then(function(data) {
            try { captureTarget.__apiCaptures.push({ url: url, data: data, timestamp: Date.now() }); } catch(e) {}
          }).catch(function() {});
        } catch(e) {}
      }
      return resp;
    });
  };
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__apiUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    var self = this;
    var url = self.__apiUrl || '';
    if (/product|goods|spu|item|list|tproduct/i.test(url)) {
      self.addEventListener('load', function() {
        try {
          var data = JSON.parse(self.responseText);
          try { captureTarget.__apiCaptures.push({ url: url, data: data, timestamp: Date.now() }); } catch(e) {}
        } catch(e) {}
      });
    }
    return origSend.apply(this, arguments);
  };
})();`;

export const SCRAPE_PRODUCT_LIST_SCRIPT = `(async function() {
  var MAX_PAGES = 200;
  var MAX_TOTAL_MS = 240000;
  var startTime = Date.now();
  var products = [];
  var errors = [];
  var steps = [];
  var debug = { detectedMode: '', selectorStats: {}, pageDomSamples: [], apiProductCount: 0, debugStatusTexts: [] };

  function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }
  function textOf(el) { return ((el && (el.innerText || el.textContent)) || '').trim(); }
  function cleanText(value) { return (value || '').replace(/\\s+/g, ' ').trim(); }
  function validId(value) { return /^[A-Za-z0-9_-]{6,64}$/.test(value || ''); }

  try {
  // ===== API 数据：从 preload 脚本和 CDP 捕获的数据中读取 =====
  // preload 脚本在页面 JS 执行前就拦截了 fetch/XHR，数据存储在 window.__apiCaptures
  // CDP 捕获的 API 响应体存储在 window.__cdpApiResponses
  window.__getAllCapturedApiData = function() {
    var all = [];
    // 先加入 CDP 捕获的数据（更可靠）
    var cdp = window.__cdpApiResponses || [];
    for (var i = 0; i < cdp.length; i++) {
      try {
        var parsed = JSON.parse(cdp[i].body);
        all.push({ url: cdp[i].url, data: parsed });
      } catch(e) {}
    }
    // 再加入 preload 捕获的数据
    var preload = window.__apiCaptures || [];
    for (var j = 0; j < preload.length; j++) {
      all.push(preload[j]);
    }
    return all;
  };
  var allApiData = window.__getAllCapturedApiData();
  debug.apiProductCount = allApiData.length;
  debug.cdpApiCount = (window.__cdpApiResponses || []).length;
  debug.preloadApiCount = (window.__apiCaptures || []).length;
  // 诊断：dump 所有捕获的 API URL 列表
  debug.allApiUrls = allApiData.map(function(e) { return (e.url || '').substring(0, 150); }).slice(0, 100);
  // 诊断：dump 首个 API 捕获条目的结构（URL + 顶层 key + 首个商品对象 key）
  if (allApiData.length > 0) {
    debug.apiSampleUrl = (allApiData[0].url || '').substring(0, 200);
    // 递归查找第一个含 product_id/title 的对象，dump 其 key 列表
    function findFirstProduct(obj, depth) {
      if (!obj || depth > 6) return null;
      if (Array.isArray(obj)) {
        for (var i = 0; i < Math.min(obj.length, 50); i++) {
          var p = findFirstProduct(obj[i], depth + 1);
          if (p) return p;
        }
        return null;
      }
      if (typeof obj !== 'object') return null;
      if (obj.product_id || obj.productId || obj.spu_id || obj.goods_id) return obj;
      var keys = Object.keys(obj);
      for (var k = 0; k < keys.length; k++) {
        var p = findFirstProduct(obj[keys[k]], depth + 1);
        if (p) return p;
      }
      return null;
    }
    // 遍历所有 API 响应（不只是第一个），找到第一个含商品的响应
    for (var ai = 0; ai < allApiData.length; ai++) {
      var apiEntry = allApiData[ai];
      var apiDataItem = apiEntry.data;
      if (!apiDataItem || typeof apiDataItem !== 'object') continue;
      if (ai === 0) {
        debug.apiSampleTopKeys = Object.keys(apiDataItem).slice(0, 20);
      }
      var sampleProduct = findFirstProduct(apiDataItem, 0);
      if (sampleProduct) {
        debug.apiSampleProductKeys = Object.keys(sampleProduct).slice(0, 40);
        debug.apiSampleProductUrl = (apiEntry.url || '').substring(0, 250);
        // dump 所有可能的描述/规格/属性字段名，用于确认 API 是否返回这些字段
        debug.apiSampleProduct = {
          product_id: sampleProduct.product_id || sampleProduct.productId || '',
          title: (sampleProduct.title || sampleProduct.name || '').substring(0, 50),
          allKeys: Object.keys(sampleProduct).slice(0, 40),
          hasDesc: !!(sampleProduct.description || sampleProduct.desc || sampleProduct.desc_info || sampleProduct.desc_v2),
          hasSpecs: !!(sampleProduct.specs || sampleProduct.specifications || sampleProduct.sku_spec || sampleProduct.spec_list),
          hasAttrs: !!(sampleProduct.attrs || sampleProduct.attributes || sampleProduct.props || sampleProduct.prop_list || sampleProduct.properties),
          hasImages: !!(sampleProduct.images || sampleProduct.pic_urls || sampleProduct.main_image || sampleProduct.pics),
          descLen: (sampleProduct.description || sampleProduct.desc || '').length,
          // 列出所有匹配 desc/spec/attr/prop 的字段名
          descFields: Object.keys(sampleProduct).filter(function(k) { return /desc|content|detail|text|info/i.test(k); }),
          specFields: Object.keys(sampleProduct).filter(function(k) { return /spec|sku|variant|norm|format/i.test(k); }),
          attrFields: Object.keys(sampleProduct).filter(function(k) { return /attr|prop|field|param|extend/i.test(k); })
        };
        break;
      }
    }
  }

  // ===== 自适应 DOM 结构检测 =====
  function detectPageStructure() {
    var bodyText = textOf(document.body);
    debug.bodyTextSample = bodyText.substring(0, 500);
    debug.currentUrl = location.href;

    var tables = document.querySelectorAll('table');
    var tableRows = document.querySelectorAll('table tbody tr');
    debug.tableCount = tables.length;
    debug.tableRowCount = tableRows.length;

    var cards = document.querySelectorAll('[class*="card"], [class*="Card"], [class*="product-card"], [class*="goods-card"], [class*="productCard"], [class*="goodsCard"]');
    debug.cardCount = cards.length;

    var listItems = document.querySelectorAll('[class*="list-item"], [class*="ListItem"], [class*="product-item"], [class*="goods-item"]');
    debug.listItemCount = listItems.length;

    var auxoRows = document.querySelectorAll('.auxo-table-row, [class*="auxo-table-row"], [class*="tableRow"]');
    debug.auxoRowCount = auxoRows.length;

    var pagination = document.querySelector('.auxo-pagination, [class*="pagination"], [class*="Pagination"]');
    debug.hasPagination = !!pagination;
    if (pagination) {
      debug.paginationText = textOf(pagination).substring(0, 100);
    }

    if (auxoRows.length >= 3) return 'auxo-table';
    if (tableRows.length >= 3) return 'html-table';
    if (cards.length >= 3) return 'card';
    if (listItems.length >= 3) return 'list';
    return 'unknown';
  }

  // ===== 多模式选择器 =====
  function getProductSelectors(mode) {
    var selectors = {
      'auxo-table': [
        '.auxo-table-row', '[class*="auxo-table-row"]',
        '.auxo-table-tbody .auxo-table-row',
        '[class*="tableRow"]', '[class*="table-row"]'
      ],
      'html-table': [
        'table tbody tr', 'table[class*="product"] tbody tr',
        'table[class*="goods"] tbody tr', '.el-table__body tr'
      ],
      'card': [
        '[class*="product-card"]', '[class*="goods-card"]',
        '[class*="productCard"]', '[class*="goodsCard"]',
        '[class*="card-item"]', '[class*="CardItem"]'
      ],
      'list': [
        '[class*="product-item"]', '[class*="goods-item"]',
        '[class*="list-item"]', '[class*="ListItem"]',
        'li[class*="product"]'
      ]
    };
    return selectors[mode] || selectors['auxo-table'];
  }

  function roots() {
    var result = [document];
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      try {
        var doc = frames[i].contentDocument || frames[i].contentWindow.document;
        if (doc && doc.body) result.push(doc);
      } catch (e) {}
    }
    return result;
  }

  // ===== 商品状态检测 =====
  function extractStatus(rawText) {
    // 上架相关（飞鸽页面状态为"售卖中"，"下架"是按钮文字而非状态）
    if (/售卖中|上架|出售中|在售|已上架|启用/.test(rawText) && !/已下架|待上架/.test(rawText)) return '上架';
    // 下架相关（精确匹配"已下架"，避免匹配到"下架"按钮）
    if (/已下架|仓库中|封禁/.test(rawText)) return '下架';
    // 审核中（精确匹配，避免"审核通过"误判）
    if (/审核中/.test(rawText)) return '审核中';
    // 草稿
    if (/草稿|未上架|待上架/.test(rawText)) return '草稿';
    return '未知';
  }

  function isActiveStatus(rawText) {
    var status = extractStatus(rawText);
    return status === '上架';
  }

  // ===== 商品信息提取 =====
  function extractProductId(el, rawText) {
    var attrs = ['data-product-id', 'data-goods-id', 'data-spu-id', 'data-item-id', 'data-row-key', 'data-id'];
    for (var i = 0; i < attrs.length; i++) {
      var value = el.getAttribute && el.getAttribute(attrs[i]);
      if (validId(value)) return value;
    }

    var links = el.querySelectorAll ? el.querySelectorAll('a[href]') : [];
    for (var l = 0; l < links.length; l++) {
      var href = links[l].getAttribute('href') || '';
      var hrefMatch = href.match(/[?&](?:product_?id|productId|goods_?id|spu_?id|item_?id)=([A-Za-z0-9_-]{6,64})/i)
        || href.match(/\\/(?:product|goods|item)\\/(?:edit|detail)\\/([A-Za-z0-9_-]{6,64})/i)
        || href.match(/productId=([A-Za-z0-9_-]{6,64})/i);
      if (hrefMatch && validId(hrefMatch[1])) return hrefMatch[1];
    }

    var textMatch = rawText.match(/(?:(?:商品)?ID|商品编号|Product ID|SPU)\\s*[:：]?\\s*([A-Za-z0-9_-]{6,64})/i);
    return textMatch && validId(textMatch[1]) ? textMatch[1] : '';
  }

  function extractName(el, rawText) {
    var selectors = [
      '[class*="productName"]', '[class*="product-name"]', '[class*="productTitle"]',
      '[class*="goodsName"]', '[class*="goods-name"]', '[class*="goodsTitle"]',
      '[class*="nameCell"]', '[class*="name-cell"]', '[class*="titleCell"]',
      '[class*="title"]:not([class*="page"])', 'a[href*="product"]', 'a[href*="goods"]'
    ];
    for (var s = 0; s < selectors.length; s++) {
      var node = el.querySelector && el.querySelector(selectors[s]);
      var candidate = cleanText(textOf(node));
      if (isProductName(candidate)) return candidate;
    }

    var image = el.querySelector && el.querySelector('img[alt]');
    var alt = cleanText(image && image.getAttribute('alt'));
    if (isProductName(alt)) return alt;

    var lines = rawText.split('\\n');
    for (var i = 0; i < lines.length; i++) {
      var line = cleanText(lines[i]);
      if (isProductName(line)) return line;
    }
    return '';
  }

  function isProductName(value) {
    if (!value || value.length < 2 || value.length > 200) return false;
    if (/^(编辑|删除|上架|下架|查看|复制|操作|商品ID|商品编号|价格|库存|销量|状态|审核|更多|详情|推广|复制链接|分享|置顶|取消置顶)/.test(value)) return false;
    if (/^(立减|满减|优惠|券后)[\\d.]+元?$/.test(value)) return false;
    if (/^[¥￥]?[\\d,.]+(?:元|件)?$/.test(value)) return false;
    if (/^\\d{1,2}:\\d{2}/.test(value)) return false;
    if (/^(是|否|启用|禁用|开|关)$/.test(value)) return false;
    return true;
  }

  function extractPrice(rawText) {
    var match = rawText.match(/[¥￥]\\s*([\\d,]+(?:\\.\\d{1,2})?)/)
      || rawText.match(/(?:售价|价格|price|金额)\\s*[:：]?\\s*([\\d,]+(?:\\.\\d{1,2})?)/i)
      || rawText.match(/([\\d,]+(?:\\.\\d{1,2})?)\\s*(?:元|¥|￥)/);
    return match ? parseFloat(match[1].replace(/,/g, '')) : null;
  }

  function extractStock(el, rawText) {
    if (el.querySelectorAll) {
      var cells = el.querySelectorAll('td');
      for (var c = 0; c < cells.length; c++) {
        var cellText = cleanText(textOf(cells[c]));
        var stockMatch = cellText.match(/^(\\d+)$/);
        if (stockMatch && parseInt(stockMatch[1]) >= 0 && cellText.indexOf('¥') === -1 && cellText.indexOf('￥') === -1) {
          return parseInt(stockMatch[1], 10);
        }
      }
    }
    var match = rawText.match(/(?:库存|stock|inventory)\\s*[:：]?\\s*(\\d+)/i);
    return match ? parseInt(match[1], 10) : null;
  }

  function extractSales(rawText) {
    var match = rawText.match(/(?:销量|已售|sold)\\s*[:：]?\\s*([\\d,]+)/i);
    return match ? parseInt(match[1].replace(/,/g, ''), 10) : undefined;
  }

  function extractImages(el) {
    var images = [];
    if (el.querySelectorAll) {
      var imgs = el.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) {
        var src = imgs[i].src || imgs[i].getAttribute('data-src') || imgs[i].getAttribute('data-original') || imgs[i].getAttribute('data-lazy-src') || imgs[i].getAttribute('data-url') || '';
        // 排除 SVG 图标、头像、空数据 URI、占位图、导航图标域名
        if (src && !src.startsWith('data:') && src.length > 20 && !src.endsWith('.svg') && images.indexOf(src) === -1
          && !/avatar|icon|logo|aweme-avatar|pigeon-sign|ecombdstatic|placeholder|1x1|blank/.test(src)) {
          // 额外检查：排除太小的图片（可能是图标）
          var rect = imgs[i].getBoundingClientRect();
          if (rect.width >= 30 && rect.height >= 30) {
            images.push(src);
            if (images.length >= 10) break;
          }
        }
      }
    }
    return images;
  }

  function extractCategory() {
    // 从面包屑导航提取分类
    var breadcrumbSelectors = [
      '.auxo-breadcrumb', '[class*="breadcrumb"]', '[class*="Breadcrumb"]',
      '.breadcrumb', '[class*="crumb"]'
    ];
    for (var s = 0; s < breadcrumbSelectors.length; s++) {
      var bc = document.querySelector(breadcrumbSelectors[s]);
      if (bc) {
        var items = bc.querySelectorAll('span, a, li');
        var parts = [];
        for (var i = 0; i < items.length; i++) {
          var t = cleanText(textOf(items[i]));
          if (t && t.length > 1 && t.length < 20 && t !== '/' && t !== '>' && !/^\\d+$/.test(t)) {
            parts.push(t);
          }
        }
        if (parts.length > 0) return parts.join('/');
      }
    }

    // 从页面标题提取
    var titleEl = document.querySelector('title');
    if (titleEl) {
      var titleText = textOf(titleEl);
      var titleMatch = titleText.match(/(?:商品管理|商品列表)\\s*[-–—]\\s*(.+)/);
      if (titleMatch) return titleMatch[1];
    }

    return '';
  }

  // ===== 从 API 拦截数据中提取商品信息 =====
  async function parseApiProducts() {
    var apiData = window.__getAllCapturedApiData ? window.__getAllCapturedApiData() : [];
    debug.preloadApiDataCount = apiData.length;

    // preload 拦截可能漏掉微前端/iframe 内发起的商品 API 请求。
    // 始终扫描网络层捕获的 URL（window.__capturedApiUrls，由 webview-manager 通过
    // ses.webRequest.onCompleted 注入）和 performance entries，主动 refetch 商品列表 API。
    var scannedUrls = {};
    // 收集候选 URL：网络层捕获 + 全量请求列表 + performance entries
    var candidateUrls = [];
    var capturedUrls = window.__capturedApiUrls || [];
    for (var cu = 0; cu < capturedUrls.length; cu++) {
      candidateUrls.push(capturedUrls[cu]);
    }
    // 扫描全量请求列表（window.__allRequestUrls，由 webview-manager 注入，包含最多 200 条请求）
    // 这里的请求不受 capturedApiUrls 的过滤器限制，即使资源类型为 fetch/other 也能被发现
    var allReqUrls = window.__allRequestUrls || [];
    debug.allRequestUrlCount = allReqUrls.length;
    for (var ar = 0; ar < allReqUrls.length; ar++) {
      var arItem = allReqUrls[ar];
      var arUrl = typeof arItem === 'string' ? arItem : (arItem && arItem.url || '');
      if (arUrl) candidateUrls.push(arUrl);
    }
    var perfEntries = performance.getEntriesByType ? performance.getEntriesByType('resource') : (performance.getEntries ? performance.getEntries() : []);
    for (var pe = 0; pe < perfEntries.length; pe++) {
      candidateUrls.push(perfEntries[pe].name || '');
    }
    // 过滤出商品相关 API URL（排除 mcs.zijieapi.com 等监控请求）
    for (var ci = 0; ci < candidateUrls.length; ci++) {
      var cUrl = candidateUrls[ci];
      if (!cUrl || scannedUrls[cUrl]) continue;
      // 匹配商品列表/详情 API（如 /product/tproduct/list, /product/list, /goods/list 等）
      // 注意：此脚本在模板字符串中执行，\/ 需写为 \\/、\. 需写为 \\. 才能在运行时保留反斜杠
      if (/\\/product\\/|\\/goods\\/|\\/spu\\/|\\/item\\/|tproduct|product\\/list|goods\\/list/i.test(cUrl)
          && !/mcs\\.zijieapi|mon\\.zijieapi|monitor|analytics|tracker|log/i.test(cUrl)) {
        scannedUrls[cUrl] = true;
        try {
          // 先尝试 GET（部分 API 同时支持 GET/POST），失败则尝试 POST（带空 body）
          var resp2 = await fetch(cUrl, { credentials: 'include', headers: { 'Accept': 'application/json' } });
          if (!resp2.ok) {
            resp2 = await fetch(cUrl, {
              method: 'POST',
              credentials: 'include',
              headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
              body: '{}',
            });
          }
          if (resp2.ok) {
            var data2 = await resp2.json();
            apiData.push({ url: cUrl, data: data2, timestamp: Date.now() });
            debug.scannedApiSuccess = debug.scannedApiSuccess || [];
            if (debug.scannedApiSuccess.length < 20) {
              debug.scannedApiSuccess.push({
                url: cUrl.substring(0, 200),
                method: resp2.ok ? (data2 ? 'ok' : 'empty') : 'fail',
                topKeys: (data2 && typeof data2 === 'object') ? Object.keys(data2).slice(0, 10) : []
              });
            }
          }
        } catch(e) {
          debug.scannedApiErrors = debug.scannedApiErrors || [];
          if (debug.scannedApiErrors.length < 20) {
            debug.scannedApiErrors.push({ url: cUrl.substring(0, 200), err: String(e).substring(0, 100) });
          }
        }
      }
    }
    debug.scannedApiUrlCount = Object.keys(scannedUrls).length;
    debug.totalApiDataCount = apiData.length;
    if (apiData.length === 0) return [];

    var result = [];
    var seenIds = {};

    for (var a = 0; a < apiData.length; a++) {
      var entry = apiData[a];
      var data = entry.data;

      function extractFrom(obj, depth) {
        if (!obj || depth > 6) return;
        if (Array.isArray(obj)) {
          for (var i = 0; i < obj.length; i++) {
            extractFrom(obj[i], depth + 1);
          }
          return;
        }
        if (typeof obj !== 'object') return;

        // 尝试识别商品对象（支持多种字段名格式）
        var pid = obj.product_id || obj.productId || obj.spu_id || obj.spuId || obj.goods_id || obj.goodsId || obj.item_id || obj.itemId || '';
        var title = obj.title || obj.name || obj.product_name || obj.productName || obj.spu_name || obj.spuName || obj.goods_name || obj.goodsName || '';
        if (pid && title) {
          if (!pid || seenIds[pid]) return;
          seenIds[pid] = true;

          // dump 第一个找到的商品的原始 API 对象结构（所有字段名），用于诊断 description/specs/attrs 缺失
          if (result.length === 0) {
            debug.rawApiProductKeys = Object.keys(obj);
            debug.rawApiProductSample = {};
            var rawKeys = Object.keys(obj);
            for (var rk = 0; rk < rawKeys.length; rk++) {
              var rkKey = rawKeys[rk];
              var rkVal = obj[rkKey];
              if (rkVal === null || rkVal === undefined) {
                debug.rawApiProductSample[rkKey] = 'null';
              } else if (typeof rkVal === 'string') {
                debug.rawApiProductSample[rkKey] = rkVal.substring(0, 100);
              } else if (typeof rkVal === 'number' || typeof rkVal === 'boolean') {
                debug.rawApiProductSample[rkKey] = rkVal;
              } else if (Array.isArray(rkVal)) {
                debug.rawApiProductSample[rkKey] = 'Array(' + rkVal.length + ')';
              } else if (typeof rkVal === 'object') {
                debug.rawApiProductSample[rkKey] = 'Object{' + Object.keys(rkVal).length + '}';
              }
            }
            // 记录包含 desc/spec/attr/prop 字段名
            debug.rawDescFields = rawKeys.filter(function(k) { return /desc|content|detail|text/i.test(k); });
            debug.rawSpecFields = rawKeys.filter(function(k) { return /spec|sku|variant|norm|format/i.test(k); });
            debug.rawAttrFields = rawKeys.filter(function(k) { return /attr|prop|field|param|extend/i.test(k); });
            // dump product_format_new 完整结构（用于诊断 spec 名称为数字 ID 的问题）
            if (obj.product_format_new && typeof obj.product_format_new === 'object') {
              debug.productFormatNewSample = {};
              var pfnKeys = Object.keys(obj.product_format_new);
              for (var pi = 0; pi < pfnKeys.length; pi++) {
                var pfnKey = pfnKeys[pi];
                var pfnVal = obj.product_format_new[pfnKey];
                if (Array.isArray(pfnVal)) {
                  debug.productFormatNewSample[pfnKey] = pfnVal.slice(0, 3).map(function(v) {
                    return typeof v === 'string' ? v : JSON.stringify(v).substring(0, 150);
                  });
                } else {
                  debug.productFormatNewSample[pfnKey] = String(pfnVal).substring(0, 100);
                }
              }
            }
            // dump category_detail 结构（可能包含属性名称映射）
            if (obj.category_detail && typeof obj.category_detail === 'object') {
              debug.categoryDetailKeys = Object.keys(obj.category_detail).slice(0, 15);
              debug.categoryDetailSample = {};
              var cdKeys = Object.keys(obj.category_detail).slice(0, 5);
              for (var cd = 0; cd < cdKeys.length; cd++) {
                var cdKey = cdKeys[cd];
                var cdVal = obj.category_detail[cdKey];
                debug.categoryDetailSample[cdKey] = typeof cdVal === 'string' ? cdVal.substring(0, 100) : (Array.isArray(cdVal) ? 'Array(' + cdVal.length + ')' : (typeof cdVal === 'object' ? 'Object{' + Object.keys(cdVal).length + '}' : String(cdVal)));
              }
            }
          }

          var product = {
            productId: String(pid),
            name: title,
            sku: obj.sku_id || obj.skuId || obj.sku_code || obj.skuCode || obj.outer_id || obj.outer_product_id || '',
            price: parseFloat(obj.price || obj.min_price || obj.minPrice || obj.market_price || obj.price_low || obj.price_lower || 0) || 0,
            // 抖店 API 价格字段（price_lower/price_higher/discount_price/market_price）单位为分，需 /100 转换为元
            priceLow: (parseFloat(obj.price_lower || obj.price_low || obj.min_price || obj.minPrice || 0) || 0) / 100,
            priceHigh: (parseFloat(obj.price_higher || obj.price_high || obj.max_price || obj.maxPrice || 0) || 0) / 100,
            stock: parseInt(obj.stock || obj.quantity || obj.inventory || obj.stock_num || obj.stockNum || obj.total_stock || 0, 10) || 0,
            imageUrl: '',
            images: [],
            description: obj.description || obj.desc || '',
            category: '',
            specs: [],
            attrs: [],
            active: false,
            status: '未知',
            createdAt: obj.create_time || obj.created_at || obj.createdAt || '',
            updatedAt: obj.update_time || obj.updated_at || obj.updatedAt || '',
            sales: parseInt(obj.sold || obj.sales || obj.sold_num || obj.sell_num || 0, 10) || 0,
            url: obj.product_url || obj.product_url_for_copy || obj.url || ''
          };

          // 主图：支持多种字段名（img 是抖店列表 API 的字段名）
          if (obj.main_image || obj.mainImage || obj.pic_url || obj.image || obj.img) {
            var mainImg = obj.main_image || obj.mainImage || obj.pic_url || obj.image || obj.img || '';
            if (mainImg && typeof mainImg === 'string' && !mainImg.endsWith('.svg') && !/ecombdstatic/.test(mainImg)) {
              product.imageUrl = mainImg;
            }
          }
          // 图片列表：支持 images/pic_urls/pics（pics 是抖店列表 API 的字段名）
          if (Array.isArray(obj.images)) {
            product.images = obj.images.map(function(im) {
              return typeof im === 'string' ? im : (im.url || im.src || '');
            }).filter(function(u) { return u && !u.endsWith('.svg') && !/ecombdstatic/.test(u); });
          } else if (Array.isArray(obj.pic_urls)) {
            product.images = obj.pic_urls.filter(function(u) { return u && !u.endsWith('.svg') && !/ecombdstatic/.test(u); });
          } else if (Array.isArray(obj.pics)) {
            product.images = obj.pics.map(function(im) {
              return typeof im === 'string' ? im : (im.url || im.src || '');
            }).filter(function(u) { return u && !u.endsWith('.svg') && !/ecombdstatic/.test(u); });
          }
          if (!product.imageUrl && product.images.length > 0) {
            product.imageUrl = product.images[0];
          }

          // 分类
          if (obj.category_name || obj.categoryName) {
            product.category = obj.category_name || obj.categoryName || '';
          } else if (Array.isArray(obj.category_path)) {
            product.category = obj.category_path.join('/');
          }

          // 商品属性与规格：从 product_format_new 提取
          // product_format_new 格式: { "785": [{name, value, diy_type, PropertyName}], "1467": [...] }
          // diy_type=0: 商品属性（材质、产地等）→ attrs
          // diy_type=1: 销售规格（颜色、尺码等）→ specs（用于 SKU 组合）
          // 注意：抖店列表 API 的 product_format_new 使用数字属性 ID 作为键，
          // PropertyName 字段为空，需要通过 DOUYIN_PROP_NAME_MAP 映射为可读名称。
          var DOUYIN_PROP_NAME_MAP = {
            '121': '颜色', '122': '尺码', '136': '颜色', '137': '尺码',
            '140': '风格', '241': '厚度', '714': '袖长',
            '784': '材质成分', '785': '材质', '810': '功能',
            '1161': '防水指数', '1343': '季节', '1358': '风格',
            '1467': '成分含量', '1551': '裙长', '1577': '适用性别',
            '1766': '工艺', '1825': '工艺', '1869': '图案',
            '1880': '产地', '1896': '款式', '1996': '材质',
            '2549': '成分含量', '2592': '风格', '2595': '适用年龄',
            '2625': '领型', '2653': '腰型', '2707': '安全类别',
            '2903': '裤长', '3171': '型号', '4495': '套装件数'
          };
          if (obj.product_format_new && typeof obj.product_format_new === 'object' && !Array.isArray(obj.product_format_new)) {
            var fmtKeys = Object.keys(obj.product_format_new);
            for (var fi = 0; fi < fmtKeys.length; fi++) {
              var rawFmtKey = fmtKeys[fi];
              var fmtName = DOUYIN_PROP_NAME_MAP[rawFmtKey] || rawFmtKey;
              var fmtValues = obj.product_format_new[rawFmtKey];
              if (Array.isArray(fmtValues)) {
                var valueList = [];
                var firstDiyType = 0;
                for (var fv = 0; fv < fmtValues.length; fv++) {
                  var fvItem = fmtValues[fv];
                  if (typeof fvItem === 'string') {
                    valueList.push(fvItem);
                  } else if (fvItem && (fvItem.name || fvItem.value || fvItem.spec_value)) {
                    valueList.push(fvItem.name || fvItem.value || fvItem.spec_value || '');
                    if (fv === 0 && typeof fvItem.diy_type === 'number') firstDiyType = fvItem.diy_type;
                  }
                }
                if (valueList.length > 0) {
                  // diy_type=1 为销售规格（颜色/尺码），放入 specs；否则为商品属性，放入 attrs
                  if (firstDiyType === 1) {
                    product.specs.push({ name: fmtName, values: valueList });
                  } else {
                    product.attrs.push({ name: fmtName, value: valueList.join('、') });
                  }
                }
              }
            }
            // 去重和过滤 attrs：相同名称的属性合并值，过滤无效值
            if (product.attrs.length > 0) {
              var attrMap = {};
              for (var ai = 0; ai < product.attrs.length; ai++) {
                var aName = product.attrs[ai].name;
                var aValue = product.attrs[ai].value;
                // 过滤无效值：空、无、空格、横杠、斜杠
                if (!aValue || /^(无|空|\\s*|-|\\/|null|undefined)$/i.test(aValue)) continue;
                // 合并相同名称的属性值（去重）
                if (attrMap.hasOwnProperty(aName)) {
                  var existing = attrMap[aName].split('、');
                  if (existing.indexOf(aValue) === -1) {
                    attrMap[aName] += '、' + aValue;
                  }
                } else {
                  attrMap[aName] = aValue;
                }
              }
              product.attrs = [];
              for (var aKey in attrMap) {
                if (attrMap.hasOwnProperty(aKey)) {
                  product.attrs.push({ name: aKey, value: attrMap[aKey] });
                }
              }
            }
            // 去重 specs：合并相同名称的规格，去重规格值
            if (product.specs.length > 0) {
              var specMap = {};
              for (var si = 0; si < product.specs.length; si++) {
                var specName = product.specs[si].name;
                var specVals = product.specs[si].values;
                if (!specMap.hasOwnProperty(specName)) {
                  specMap[specName] = [];
                }
                for (var sv = 0; sv < specVals.length; sv++) {
                  if (specVals[sv] && specMap[specName].indexOf(specVals[sv]) === -1) {
                    specMap[specName].push(specVals[sv]);
                  }
                }
              }
              product.specs = [];
              for (var spKey in specMap) {
                if (specMap.hasOwnProperty(spKey) && specMap[spKey].length > 0) {
                  product.specs.push({ name: spKey, values: specMap[spKey] });
                }
              }
            }
          }
          // 规格：也支持标准 specs/specifications 字段
          if (product.specs.length === 0 && (Array.isArray(obj.specs) || Array.isArray(obj.specifications))) {
            var specList = obj.specs || obj.specifications || [];
            for (var s = 0; s < specList.length; s++) {
              var spec = specList[s];
              if (spec && (spec.name || spec.spec_name || spec.prop_name)) {
                product.specs.push({
                  name: spec.name || spec.spec_name || spec.prop_name || '',
                  values: Array.isArray(spec.values) ? spec.values : (spec.value ? [spec.value] : [])
                });
              }
            }
          }
          // 规格：从 skus 数组中提取（每个 SKU 的 spec_detail 包含规格信息）
          if (product.specs.length === 0 && Array.isArray(obj.skus)) {
            var specMap = {};
            for (var si = 0; si < obj.skus.length; si++) {
              var skuItem = obj.skus[si];
              if (!skuItem || typeof skuItem !== 'object') continue;
              // spec_detail 格式: [{spec_name: "颜色", spec_value: "红色"}, ...]
              var specDetail = skuItem.spec_detail || skuItem.spec_list || skuItem.specs;
              if (Array.isArray(specDetail)) {
                for (var sd = 0; sd < specDetail.length; sd++) {
                  var sdItem = specDetail[sd];
                  if (sdItem && (sdItem.spec_name || sdItem.name)) {
                    var sName = sdItem.spec_name || sdItem.name || '';
                    var sValue = sdItem.spec_value || sdItem.value || '';
                    if (sName && sValue) {
                      if (!specMap[sName]) specMap[sName] = [];
                      if (specMap[sName].indexOf(sValue) === -1) specMap[sName].push(sValue);
                    }
                  }
                }
              }
            }
            var specNames = Object.keys(specMap);
            for (var sn = 0; sn < specNames.length; sn++) {
              product.specs.push({ name: specNames[sn], values: specMap[specNames[sn]] });
            }
          }

          // 属性
          if (Array.isArray(obj.attrs) || Array.isArray(obj.attributes) || Array.isArray(obj.props)) {
            var attrList = obj.attrs || obj.attributes || obj.props || [];
            for (var at = 0; at < attrList.length; at++) {
              var attr = attrList[at];
              if (attr && (attr.name || attr.attr_name || attr.prop_name)) {
                product.attrs.push({
                  name: attr.name || attr.attr_name || attr.prop_name || '',
                  value: attr.value || attr.attr_value || attr.prop_value || ''
                });
              }
            }
          }

          // 状态
          var status = obj.status || obj.product_status || '';
          if (status) {
            product.status = status;
            product.active = /^(?:上架|出售中|在售|1|2|true|on)/i.test(String(status));
          }

          result.push(product);
          if (result.length >= 500) return;
        }

        // 递归搜索子对象（跳过原型属性）
        for (var key in obj) {
          if (obj.hasOwnProperty(key) && key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
            extractFrom(obj[key], depth + 1);
          }
        }
      }

      extractFrom(data, 0);
    }

    return result;
  }

  function parseItem(el) {
    var rawText = textOf(el);
    var productId = extractProductId(el, rawText);
    if (!productId) return null;
    var name = extractName(el, rawText);
    if (!name) return null;
    var skuMatch = rawText.match(/(?:SKU|sku|货号|商品编码)\\s*[:：]?\\s*([A-Za-z0-9_-]{2,64})/);
    var link = el.querySelector && el.querySelector('a[href*="product"], a[href*="goods"], a[href*="item"]');
    var status = extractStatus(rawText);
    var images = extractImages(el);
    return {
      productId: productId,
      name: name,
      sku: skuMatch ? skuMatch[1] : productId,
      price: extractPrice(rawText),
      stock: extractStock(el, rawText),
      url: link ? (link.href || link.getAttribute('href') || '') : '',
      imageUrl: images.length > 0 ? images[0] : '',
      images: images,
      description: '',
      category: '',
      specs: [],
      attrs: [],
      active: isActiveStatus(rawText),
      status: status,
      createdAt: '',
      updatedAt: '',
      sales: extractSales(rawText)
    };
  }

  function findProductItems(mode) {
    var selectors = getProductSelectors(mode);
    var docs = roots();
    var valid = [];
    var seenIds = {};

    for (var d = 0; d < docs.length; d++) {
      for (var s = 0; s < selectors.length; s++) {
        var nodes = docs[d].querySelectorAll(selectors[s]);
        for (var n = 0; n < nodes.length; n++) {
          var parsed = parseItem(nodes[n]);
          if (parsed && !seenIds[parsed.productId]) {
            seenIds[parsed.productId] = true;
            valid.push({ element: nodes[n], product: parsed });
          }
        }
      }
    }
    return {
      items: valid,
      selector: '',
      root: valid.length > 0 ? 0 : -1
    };
  }

  function pageSignature(items) {
    return items.map(function(item) { return item.product.productId; }).join('|');
  }

  function isDisabled(el) {
    var cls = (el.className || '').toString().toLowerCase();
    return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || cls.indexOf('disabled') >= 0;
  }

  function clickNextPage() {
    var selectors = [
      '.auxo-pagination-next', '[class*="pagination-next"]', '[class*="paginationNext"]',
      '[class*="pagination"] [class*="next"]', '[class*="Pagination"] [class*="next"]',
      '.ant-pagination-next', '.el-pagination .btn-next', '.semi-page-item-next',
      'button[aria-label="下一页"]', 'button[aria-label="next"]',
      'button[title="下一页"]', 'a[title="下一页"]',
      'li[title="下一页"]', 'button[class*="next"]', 'li[class*="next"]', 'a[class*="next"]'
    ];
    var docs = roots();
    for (var d = 0; d < docs.length; d++) {
      for (var s = 0; s < selectors.length; s++) {
        var button = docs[d].querySelector(selectors[s]);
        if (button && !isDisabled(button)) {
          button.click();
          return true;
        }
      }
      // CSS 类名经常由微前端动态生成，最后按可访问名称、标题、文本和图标兜底查找。
      var controls = docs[d].querySelectorAll('button, a, li, [role="button"]');
      for (var c = 0; c < controls.length; c++) {
        var control = controls[c];
        if (isDisabled(control) || control.offsetParent === null) continue;
        var label = cleanText([
          control.getAttribute('aria-label') || '',
          control.getAttribute('title') || '',
          textOf(control),
          (control.className || '').toString()
        ].join(' ')).toLowerCase();
        var hasRightIcon = !!(control.querySelector && control.querySelector(
          '[data-icon="right"], [class*="right"], [class*="Right"], svg[class*="next"], svg[class*="Next"]'
        ));
        if (/下一页|next\s*page|pagination.{0,20}next|next.{0,20}pagination/.test(label)
            || (/^(?:>|›|»|→)$/.test(textOf(control)) && hasRightIcon)) {
          control.click();
          return true;
        }
      }
      var activePage = docs[d].querySelector(
        '.auxo-pagination-item-active, .ant-pagination-item-active, .el-pager .active, [class*="pagination"] [aria-current="page"]'
      );
      if (activePage && activePage.nextElementSibling && !isDisabled(activePage.nextElementSibling)) {
        var nextPageText = cleanText(textOf(activePage.nextElementSibling));
        if (/^\d+$/.test(nextPageText)) {
          activePage.nextElementSibling.click();
          return true;
        }
      }
    }
    return false;
  }

  function findStatusTab(label) {
    var docs = roots();
    for (var d = 0; d < docs.length; d++) {
      var candidates = docs[d].querySelectorAll('[role="tab"], button, li, [class*="tab"], [class*="Tab"]');
      for (var i = 0; i < candidates.length; i++) {
        var candidate = candidates[i];
        if (candidate.offsetParent === null) continue;
        var raw = cleanText(textOf(candidate));
        if (!raw || raw.length > 30) continue;
        var normalized = raw.replace(/[（(]?\s*\d+\s*[）)]?\s*$/, '').trim();
        if (normalized === label) return candidate;
      }
    }
    return null;
  }

  async function switchStatusTab(label, mode) {
    var tab = findStatusTab(label);
    if (!tab || isDisabled(tab)) return null;
    var before = pageSignature(findProductItems(mode).items);
    tab.click();
    for (var wait = 0; wait < 30; wait++) {
      await sleep(400);
      var next = findProductItems(mode);
      if (next.items.length > 0 && pageSignature(next.items) !== before) return next;
    }
    // 不同状态也可能恰好展示同一批商品；超时后仍返回当前 DOM，由最终 ID 去重。
    return findProductItems(mode);
  }

  async function waitForItems(mode, maxWaitMs) {
    var waited = 0;
    while (waited < maxWaitMs) {
      var result = findProductItems(mode);
      if (result.items.length > 0) return result;
      await sleep(500);
      waited += 500;
    }
    return findProductItems(mode);
  }

  async function scanCurrentPage(mode, initial) {
    var collected = {};
    var selectorNames = {};
    function collect(result) {
      if (result.selector) selectorNames[result.selector] = true;
      for (var i = 0; i < result.items.length; i++) {
        collected[result.items[i].product.productId] = result.items[i];
      }
    }

    collect(initial || findProductItems(mode));
    var docs = roots();
    for (var step = 0; step <= 4; step++) {
      for (var d = 0; d < docs.length; d++) {
        var scrolling = docs[d].scrollingElement || docs[d].documentElement;
        if (scrolling) {
          var maxTop = Math.max(0, scrolling.scrollHeight - scrolling.clientHeight);
          scrolling.scrollTop = Math.round(maxTop * step / 4);
        }
      }
      await sleep(350);
      collect(findProductItems(mode));
    }

    for (var r = 0; r < docs.length; r++) {
      var rootScrolling = docs[r].scrollingElement || docs[r].documentElement;
      if (rootScrolling) rootScrolling.scrollTop = 0;
    }
    await sleep(350);

    return {
      items: Object.keys(collected).map(function(id) { return collected[id]; }),
      selector: Object.keys(selectorNames).join(', '),
      root: Object.keys(collected).length > 0 ? 0 : -1
    };
  }

  async function scanPages(mode, initial, category, statusTab) {
    var currentSet = initial;
    for (var page = 1; page <= MAX_PAGES && currentSet.items.length > 0; page++) {
      currentSet = await scanCurrentPage(mode, currentSet);
      var signature = pageSignature(findProductItems(mode).items);

      var activeCount = 0;
      for (var i = 0; i < currentSet.items.length; i++) {
        var item = currentSet.items[i];
        if (!item.product.category && category) item.product.category = category;
        var elRawText = textOf(item.element);
        if (debug.debugStatusTexts.length < 60) {
          debug.debugStatusTexts.push({
            id: item.product.productId,
            name: (item.product.name || '').substring(0, 40),
            status: item.product.status,
            active: item.product.active,
            statusTab: statusTab,
            rawTextSnippet: elRawText.substring(0, 300)
          });
        }
        // 商品管理需要完整目录；下架、草稿、审核中的商品也必须同步，并保留 active 状态。
        products.push(item.product);
        if (item.product.active) activeCount++;
      }
      steps.push({ statusTab: statusTab, page: page, total: currentSet.items.length, active: activeCount, selector: currentSet.selector });

      if (Date.now() - startTime > MAX_TOTAL_MS) {
        errors.push('同步超时，已完成「' + statusTab + '」前 ' + page + ' 页');
        break;
      }
      if (!clickNextPage()) break;

      var changed = false;
      for (var wait = 0; wait < 20; wait++) {
        await sleep(500);
        var next = findProductItems(mode);
        if (next.items.length > 0 && pageSignature(next.items) !== signature) {
          currentSet = await scanCurrentPage(mode, next);
          changed = true;
          break;
        }
      }
      if (!changed) {
        errors.push('点击下一页后商品列表未更新，「' + statusTab + '」在第 ' + page + ' 页停止');
        break;
      }
    }
  }

  // ===== 主流程 =====
  var bodyText = textOf(document.body);
  var isLoginPage = /login|passport|sso/i.test(location.href) || /扫码登录|登录抖店|账号登录/.test(bodyText.substring(0, 1000));
  var emptyShop = /暂无商品|暂无数据|还没有商品|未创建商品/.test(bodyText);

  // 自适应检测页面结构
  var detectedMode = detectPageStructure();
  debug.detectedMode = detectedMode;
  steps.push({ step: 'detect', mode: detectedMode, tableCount: debug.tableCount, auxoRowCount: debug.auxoRowCount, cardCount: debug.cardCount });

  // 提取分类信息
  var category = extractCategory();
  if (category) debug.category = category;

  var current = await waitForItems(detectedMode, 30000);

  if (isLoginPage) {
    errors.push('飞鸽商品管理登录状态已失效，请重新登录后再同步');
  } else if (current.items.length === 0 && !emptyShop) {
    errors.push('商品管理页已打开，但未识别到带商品ID的商品列表');
  }

  // 优先进入“全部商品”一次性抓取完整目录；若平台没有该入口，则逐个状态标签抓取。
  var statusLabels = ['全部商品', '售卖中', '仓库中', '已下架', '审核中', '草稿', '封禁'];
  var availableStatusLabels = statusLabels.filter(function(label) { return !!findStatusTab(label); });
  debug.availableStatusTabs = availableStatusLabels;
  if (availableStatusLabels.indexOf('全部商品') >= 0) {
    var allProducts = await switchStatusTab('全部商品', detectedMode);
    await scanPages(detectedMode, allProducts && allProducts.items.length > 0 ? allProducts : current, category, '全部商品');
  } else if (availableStatusLabels.length > 0) {
    for (var st = 0; st < availableStatusLabels.length; st++) {
      var label = availableStatusLabels[st];
      var tabProducts = await switchStatusTab(label, detectedMode);
      if (tabProducts && tabProducts.items.length > 0) {
        await scanPages(detectedMode, tabProducts, category, label);
      }
      if (Date.now() - startTime > MAX_TOTAL_MS) break;
    }
  } else {
    await scanPages(detectedMode, current, category, '当前列表');
  }

  // 尝试从 API 拦截数据中获取更完整的商品信息
  var apiProducts = await parseApiProducts();
  debug.apiProductCount = apiProducts.length;
  // dump 第一个 API 商品的完整结构（所有字段名），用于诊断 description/specs/attrs 缺失问题
  if (apiProducts.length > 0) {
    var ap0 = apiProducts[0];
    debug.firstApiProductKeys = Object.keys(ap0);
    debug.firstApiProduct = {
      productId: ap0.productId,
      name: (ap0.name || '').substring(0, 50),
      hasDesc: !!(ap0.description && ap0.description.length > 0),
      descLen: (ap0.description || '').length,
      hasSpecs: !!(ap0.specs && ap0.specs.length > 0),
      specCount: (ap0.specs || []).length,
      hasAttrs: !!(ap0.attrs && ap0.attrs.length > 0),
      attrCount: (ap0.attrs || []).length,
      hasImages: !!(ap0.images && ap0.images.length > 0),
      imgCount: (ap0.images || []).length,
      hasCategory: !!ap0.category,
      category: ap0.category || '',
      hasCreatedAt: !!ap0.createdAt,
      hasUpdatedAt: !!ap0.updatedAt
    };
  }
  if (apiProducts.length > 0) {
    steps.push({ step: 'api_merge', apiProducts: apiProducts.length, domProducts: products.length });
    // 用 API 数据补充/覆盖 DOM 数据
    var apiMap = {};
    for (var ap = 0; ap < apiProducts.length; ap++) {
      apiMap[apiProducts[ap].productId] = apiProducts[ap];
    }
    for (var dp = 0; dp < products.length; dp++) {
      var apiProduct = apiMap[products[dp].productId];
      if (apiProduct) {
        // 补充 API 中的额外字段
        if (apiProduct.description && !products[dp].description) products[dp].description = apiProduct.description;
        if (apiProduct.category && !products[dp].category) products[dp].category = apiProduct.category;
        if (apiProduct.images && apiProduct.images.length > 0) products[dp].images = apiProduct.images;
        // 商品属性与规格：API 的 product_format_new 已按 diy_type 区分 attrs/specs
        // 当 API 提供了 attrs 时，说明 product_format_new 已被解析，DOM 抓取的 specs 实为商品属性
        // 此时用 API 的 attrs 覆盖，并根据 API 是否有 specs（diy_type=1）决定保留或清空 DOM specs
        if (apiProduct.attrs && apiProduct.attrs.length > 0) {
          products[dp].attrs = apiProduct.attrs;
          // API 有销售规格（颜色/尺码）则覆盖，否则清空 DOM 误放入 specs 的商品属性
          products[dp].specs = (apiProduct.specs && apiProduct.specs.length > 0) ? apiProduct.specs : [];
        } else if (apiProduct.specs && apiProduct.specs.length > 0) {
          products[dp].specs = apiProduct.specs;
        }
        if (apiProduct.createdAt && !products[dp].createdAt) products[dp].createdAt = apiProduct.createdAt;
        if (apiProduct.updatedAt && !products[dp].updatedAt) products[dp].updatedAt = apiProduct.updatedAt;
        if (apiProduct.sales && !products[dp].sales) products[dp].sales = apiProduct.sales;
        if (apiProduct.sku && products[dp].sku === products[dp].productId) products[dp].sku = apiProduct.sku;
        // 价格范围（从 API 获取，已转换为元）
        if (apiProduct.priceLow && !products[dp].priceLow) products[dp].priceLow = apiProduct.priceLow;
        if (apiProduct.priceHigh && !products[dp].priceHigh) products[dp].priceHigh = apiProduct.priceHigh;
        // SKU 列表（从详情 API 获取）
        if (apiProduct.skus && apiProduct.skus.length > 0 && !products[dp].skus) products[dp].skus = apiProduct.skus;
        // 消费者端商品详情页 URL（用于详情抓取补充描述）
        if (apiProduct.url && !products[dp].url) products[dp].url = apiProduct.url;
      }
    }
    // 添加 API 中独有的商品（包含下架、草稿和审核中的商品）
    for (var ak = 0; ak < apiProducts.length; ak++) {
      var exists = false;
      for (var ek = 0; ek < products.length; ek++) {
        if (products[ek].productId === apiProducts[ak].productId) { exists = true; break; }
      }
      if (!exists) {
        products.push(apiProducts[ak]);
      }
    }
    steps.push({ step: 'api_merged', finalProducts: products.length });
  }

  var seen = {};
  var deduped = [];
  for (var p = 0; p < products.length; p++) {
    if (!seen[products[p].productId]) {
      seen[products[p].productId] = true;
      deduped.push(products[p]);
    }
  }

  // ===== 阶段：通过店铺商品详情 API 获取描述（列表 API 不返回描述）=====
  // 列表 API (/product/tproduct/list) 的 description/desc_detail/combo_desc 等字段均为空。
  // 需要调用详情 API 获取完整商品描述。
  debug.detailApiFetch = { attempted: 0, succeeded: 0, failed: 0, errors: [], endpoints: [] };
  var productsNeedingDesc = deduped.filter(function(p) { return !p.description || p.description.length === 0; });
  if (productsNeedingDesc.length > 0 && productsNeedingDesc.length <= 30) {
    // 从已捕获的 API URL 中提取 __token 和 verifyFp
    var authToken = '';
    var verifyFp = '';
    try {
      for (var tu = 0; tu < allApiData.length; tu++) {
        var aUrl = allApiData[tu].url || '';
        if (!authToken) { var tokenMatch = aUrl.match(/__token=([a-f0-9]+)/); if (tokenMatch) authToken = tokenMatch[1]; }
        if (!verifyFp) { var fpMatch = aUrl.match(/verifyFp=([^&]+)/); if (fpMatch) verifyFp = fpMatch[1]; }
        if (authToken && verifyFp) break;
      }
    } catch(e) {}

    // 递归查找 description 字段
    function findDesc(obj, depth) {
      if (!obj || depth > 8) return '';
      if (typeof obj === 'string') return '';
      if (Array.isArray(obj)) {
        for (var ii = 0; ii < obj.length; ii++) { var d = findDesc(obj[ii], depth+1); if (d) return d; }
        return '';
      }
      if (typeof obj === 'object') {
        var descFields = ['description', 'desc', 'desc_detail', 'desc_info', 'desc_v2', 'combo_desc', 'buy_desc', 'order_desc', 'detail_desc', 'product_desc', 'rich_desc', 'mobile_desc'];
        for (var df = 0; df < descFields.length; df++) {
          var val = obj[descFields[df]];
          if (typeof val === 'string' && val.length > 20 && !/^window\\.|^var\\s|^function\\s|^\\(\\s*function|<script|^\\{/.test(val)) {
            return val;
          }
          // 也支持 HTML 描述（rich text）
          if (typeof val === 'string' && val.length > 50 && /<p|<div|<span|<img|<br/i.test(val)) {
            return val;
          }
        }
        for (var key in obj) {
          if (obj.hasOwnProperty(key)) {
            var d2 = findDesc(obj[key], depth+1);
            if (d2) return d2;
          }
        }
      }
      return '';
    }

    // 尝试多个 API 端点获取商品详情和 SKU 数据
    var detailEndpoints = [
      { method: 'GET', url: '/product/tproduct/detail?product_id=' },
      { method: 'GET', url: '/product/tproduct/getProductDetail?product_id=' },
      { method: 'GET', url: '/product/tproduct/getProductEditInfo?product_id=' },
      { method: 'GET', url: '/product/tproduct/edit?product_id=' },
      { method: 'POST', url: '/product/tproduct/detail' },
      // SKU 列表 API
      { method: 'GET', url: '/product/tproduct/getProductSkuList?product_id=' },
      { method: 'GET', url: '/product/tproduct/getSkuList?product_id=' },
      { method: 'GET', url: '/product/tproduct/sku/list?product_id=' },
      // AI 生成的商品描述 API（从消费者端页面捕获）
      { method: 'GET', url: '/ai/getGptGeneratedProductDesc?product_id=' },
      // 移动端商品详情 API
      { method: 'GET', url: 'https://haohuo.jinritemai.com/ecom/product/detail/h5/sc/?product_id=' },
    ];

    // 递归查找 SKU 数据（skus 字段）
    function findSkus(obj, depth) {
      if (!obj || depth > 5) return null;
      if (Array.isArray(obj)) {
        for (var ii = 0; ii < obj.length; ii++) {
          var s = findSkus(obj[ii], depth+1);
          if (s) return s;
        }
        return null;
      }
      if (typeof obj === 'object') {
        // 查找 skus 数组（每个 SKU 应该有 price 和 stock 字段）
        if (Array.isArray(obj.skus) && obj.skus.length > 0) {
          var firstSku = obj.skus[0];
          if (firstSku && typeof firstSku === 'object' && (firstSku.price || firstSku.stock_num || firstSku.sku_id)) {
            return obj.skus;
          }
        }
        if (Array.isArray(obj.sku_list) && obj.sku_list.length > 0) {
          return obj.sku_list;
        }
        for (var key in obj) {
          if (obj.hasOwnProperty(key) && key !== 'product_format_new') {
            var s2 = findSkus(obj[key], depth+1);
            if (s2) return s2;
          }
        }
      }
      return null;
    }

    for (var di = 0; di < productsNeedingDesc.length; di++) {
      var descProduct = productsNeedingDesc[di];
      if (!descProduct.productId) continue;
      debug.detailApiFetch.attempted++;
      var descFound = false;
      var skuFound = !!descProduct.skus;

      for (var ei = 0; ei < detailEndpoints.length && (!descFound || !skuFound); ei++) {
        var endpoint = detailEndpoints[ei];
        try {
          var fetchUrl = endpoint.url.indexOf('http') === 0 ? endpoint.url : 'https://fxg.jinritemai.com' + endpoint.url;
          var fetchOpts = { method: endpoint.method, credentials: 'include', headers: { 'Accept': 'application/json' } };
          if (endpoint.method === 'GET') {
            fetchUrl += descProduct.productId + '&appid=1&_bid=ffa_goods';
            if (authToken) fetchUrl += '&__token=' + authToken;
            if (verifyFp) fetchUrl += '&verifyFp=' + verifyFp;
          } else {
            fetchOpts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
            var body = 'product_id=' + descProduct.productId + '&appid=1&_bid=ffa_goods';
            if (authToken) body += '&__token=' + authToken;
            if (verifyFp) body += '&verifyFp=' + verifyFp;
            fetchOpts.body = body;
          }
          var detailResp = await fetch(fetchUrl, fetchOpts);
          if (detailResp.ok) {
            var detailJson = await detailResp.json();
            // 提取描述
            if (!descFound) {
              var foundDesc = findDesc(detailJson, 0);
              if (foundDesc && foundDesc.length > 20) {
                var cleanDesc = foundDesc.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\\s+/g, ' ').trim();
                if (cleanDesc.length > 20) {
                  descProduct.description = cleanDesc.substring(0, 10000);
                  debug.detailApiFetch.succeeded++;
                  descFound = true;
                  if (debug.detailApiFetch.succeeded === 1) {
                    debug.detailApiFirstSuccess = {
                      productId: descProduct.productId,
                      endpoint: endpoint.method + ' ' + endpoint.url,
                      descLen: cleanDesc.length,
                      descPreview: cleanDesc.substring(0, 200),
                      topKeys: detailJson && typeof detailJson === 'object' ? Object.keys(detailJson).slice(0, 15) : [],
                      dataKeys: detailJson && detailJson.data && typeof detailJson.data === 'object' ? Object.keys(detailJson.data).slice(0, 20) : []
                    };
                  }
                  if (debug.detailApiFetch.endpoints.indexOf(endpoint.method + ' ' + endpoint.url) === -1) {
                    debug.detailApiFetch.endpoints.push(endpoint.method + ' ' + endpoint.url);
                  }
                }
              }
            }
            // 提取 SKU 数据
            if (!skuFound) {
              var foundSkus = findSkus(detailJson, 0);
              if (foundSkus && foundSkus.length > 0) {
                descProduct.skus = foundSkus;
                skuFound = true;
                if (debug.detailApiFetch.skuSuccess === undefined) debug.detailApiFetch.skuSuccess = 0;
                debug.detailApiFetch.skuSuccess++;
                if (debug.detailApiFetch.skuSuccess === 1) {
                  debug.skuFirstSuccess = {
                    productId: descProduct.productId,
                    endpoint: endpoint.method + ' ' + endpoint.url,
                    skuCount: foundSkus.length,
                    firstSkuKeys: foundSkus[0] && typeof foundSkus[0] === 'object' ? Object.keys(foundSkus[0]).slice(0, 15) : []
                  };
                }
              }
            }
            // dump 第一个 API 响应的顶层结构（用于诊断）
            if (di === 0 && ei === 0) {
              debug.detailApiFirstResponse = {
                endpoint: endpoint.method + ' ' + endpoint.url,
                status: detailResp.status,
                topKeys: detailJson && typeof detailJson === 'object' ? Object.keys(detailJson).slice(0, 15) : [],
                msg: detailJson && detailJson.msg ? String(detailJson.msg).substring(0, 200) : '',
                code: detailJson && detailJson.code !== undefined ? detailJson.code : null,
                dataKeys: detailJson && detailJson.data && typeof detailJson.data === 'object' ? Object.keys(detailJson.data).slice(0, 20) : []
              };
            }
          } else {
            if (di === 0 && ei === 0) {
              debug.detailApiFirstResponse = {
                endpoint: endpoint.method + ' ' + endpoint.url,
                status: detailResp.status,
                statusText: detailResp.statusText
              };
            }
          }
        } catch(detailErr) {
          if (di === 0 && ei === 0) {
            debug.detailApiFirstResponse = {
              endpoint: endpoint.method + ' ' + endpoint.url,
              err: String(detailErr).substring(0, 150)
            };
          }
        }
      }

      if (!descFound) {
        debug.detailApiFetch.failed++;
        if (debug.detailApiFetch.errors.length < 5) {
          debug.detailApiFetch.errors.push({ productId: descProduct.productId });
        }
      }
      // 间隔 300ms 避免请求过快
      await new Promise(function(r) { setTimeout(r, 300); });
    }
  }

  } catch(scriptErr) {
    // 捕获脚本执行中的任何异常，返回错误信息而非直接抛出
    errors.push('SCRIPT_ERROR: ' + (scriptErr && scriptErr.message || String(scriptErr)));
    debug.scriptError = String(scriptErr && scriptErr.message || scriptErr);
    debug.scriptStack = String(scriptErr && scriptErr.stack || '').substring(0, 1500);
  }

  return JSON.stringify({
    products: deduped,
    errors: errors,
    steps: steps,
    debug: debug,
    emptyShop: emptyShop,
    isLoginPage: isLoginPage,
    currentUrl: location.href,
    elapsedMs: Date.now() - startTime
  });
})()`;

/**
 * 诊断脚本（简化版）：收集页面 DOM 结构信息。
 * 网络请求拦截在主进程中完成（diagnoseWithNetworkCapture），脚本只需收集 DOM 信息。
 */
export const DIAGNOSE_LIST_PAGE_SCRIPT_SIMPLE = `(function() {
  var info = {
    url: window.location.href,
    title: document.title,
    timestamp: Date.now(),
    bodyTextLen: (document.body.innerText || '').length,
    bodyTextSnippet: '',
    isLoginPage: /login|passport|sso|account/i.test(window.location.href) || /登录|扫码|二维码/.test((document.body.innerText || '').substring(0, 500)),
    iframes: [],
    tables: [],
    productItems: [],
    classStats: {},
    potentialSelectors: []
  };

  // 检查 iframe
  var iframes = document.querySelectorAll('iframe');
  for (var fi = 0; fi < iframes.length; fi++) {
    var iframe = iframes[fi];
    var iframeInfo = {
      index: fi,
      src: (iframe.src || '').substring(0, 200),
      rect: (function(r) { return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(iframe.getBoundingClientRect())
    };
    try {
      var iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
      if (iframeDoc) {
        iframeInfo.bodyTextLen = (iframeDoc.body && iframeDoc.body.innerText || '').length;
        iframeInfo.bodyTextSnippet = (iframeDoc.body && iframeDoc.body.innerText || '').substring(0, 500);
        iframeInfo.tableCount = iframeDoc.querySelectorAll('table').length;
        iframeInfo.selectors = [];
        var iframeSelectors = ['table tbody tr', '[class*="product-item"]', '[class*="goods-item"]', '[class*="item-card"]', '[class*="list-item"]', '[class*="prod"]'];
        for (var is = 0; is < iframeSelectors.length; is++) {
          var matched = iframeDoc.querySelectorAll(iframeSelectors[is]);
          if (matched.length > 0) {
            iframeInfo.selectors.push({
              selector: iframeSelectors[is],
              count: matched.length,
              firstText: (matched[0].innerText || '').trim().substring(0, 200)
            });
          }
        }
      }
    } catch (e) {
      iframeInfo.crossOrigin = true;
      iframeInfo.error = String(e).substring(0, 100);
    }
    info.iframes.push(iframeInfo);
  }

  // 更新最终页面信息
  info.bodyTextLen = (document.body.innerText || '').length;
  info.bodyTextSnippet = (document.body.innerText || '').substring(0, 2000);

  // 收集 table 信息
  var tables = document.querySelectorAll('table');
  info.tables.push({ count: tables.length });
  for (var t = 0; t < Math.min(tables.length, 3); t++) {
    var rows = tables[t].querySelectorAll('tr');
    var headerCells = tables[t].querySelectorAll('th');
    info.tables.push({
      index: t,
      rowCount: rows.length,
      headerCount: headerCells.length,
      headers: Array.from(headerCells).slice(0, 10).map(function(c) { return (c.innerText || '').trim().substring(0, 30); }),
      firstRowText: rows.length > 1 ? (rows[1].innerText || '').trim().substring(0, 300) : ''
    });
  }

  // 收集 class 关键词统计
  var classKeywords = ['product', 'goods', 'item', 'card', 'row', 'spu', 'sku'];
  for (var k = 0; k < classKeywords.length; k++) {
    var kw = classKeywords[k];
    var els = document.querySelectorAll('[class*="' + kw + '"]');
    if (els.length > 0) {
      info.classStats[kw] = els.length;
      for (var e = 0; e < Math.min(els.length, 3); e++) {
        var el = els[e];
        info.productItems.push({
          keyword: kw,
          tag: el.tagName,
          className: (el.className || '').toString().substring(0, 200),
          textLen: (el.innerText || '').length,
          textSnippet: (el.innerText || '').trim().substring(0, 200)
        });
      }
    }
  }

  // 尝试各种选择器
  var testSelectors = [
    'table tbody tr', 'table tr',
    '[class*="product-item"]', '[class*="goods-item"]',
    '[class*="product-card"]', '[class*="goods-card"]',
    '[class*="prod-item"]', '[class*="prod-card"]',
    '[class*="item-card"]', '[class*="item-row"]',
    '[class*="goods-list"] > *', '[class*="product-list"] > *',
    '[class*="table-row"]', '[class*="list-item"]',
    '[class*="spu"]', '[class*="sku"]'
  ];
  for (var s = 0; s < testSelectors.length; s++) {
    var matched = document.querySelectorAll(testSelectors[s]);
    if (matched.length > 0) {
      info.potentialSelectors.push({
        selector: testSelectors[s],
        count: matched.length,
        firstText: (matched[0].innerText || '').trim().substring(0, 150)
      });
    }
  }

  return JSON.stringify(info);
})()`;

/**
 * 各平台客服会话页面商品抓取配置。
 *
 * 每个平台的客服会话页面 DOM 结构、标签页文本、商品图片域名均不同，
 * 通过此配置生成平台专属的抓取脚本。
 */
export interface PlatformScrapeConfig {
  /** 平台标识 */
  platformId: PlatformId;
  /** 商品标签页文本（如飞鸽"商品"、拼多多"商品推荐"） */
  productTabText: string;
  /** 订单标签页文本（如飞鸽"订单"、拼多多"最新订单"） */
  orderTabText: string;
  /** 标签页元素 CSS 选择器（如 '[class*="tabItem"]'、'.bar-item'） */
  tabItemSelector: string;
  /** 激活标签页 CSS 选择器（用于记录当前标签） */
  activeTabSelector: string;
  /** 右侧面板容器 CSS 选择器（用于限定搜索范围） */
  rightPanelSelector: string;
  /** 商品图片域名关键字数组 */
  productImageDomains: string[];
  /** 需排除的图片 URL 关键字（头像、图标等） */
  excludeImageKeywords: string[];
  /** 需排除的图片 class 关键字 */
  excludeImageClasses: string[];
  /** 右侧面板 X 位置比例（元素 left > innerWidth * ratio 才视为在右侧面板） */
  rightPanelXRatio: number;
  /** "无商品"提示文本 */
  noProductText: string;
  /** 订单子标签页文本数组（拼多多有"个人订单"/"店铺待支付订单"） */
  orderSubTabs?: string[];
  /** 额外排除的文本（平台特有 UI 文案） */
  extraExcludeTexts?: string[];
}

export const PLATFORM_SCRAPE_CONFIGS: Record<PlatformId, PlatformScrapeConfig> = {
  feige: {
    platformId: 'feige',
    productTabText: '商品',
    orderTabText: '订单',
    tabItemSelector: '[class*="tabItem"]',
    activeTabSelector: '.tabItemActive-PqcaaS, [class*="tabItemActive"]',
    // 飞鸽右侧面板容器：id="workStation"，类名 workStation-kYTkku newWorkStation-grQ49a newWorkStationV2-ZeBiWx
    rightPanelSelector: '#workStation, [class*="workStation"]',
    productImageDomains: ['ecom-shop-material', 'douyinpic', 'ecombdimg'],
    excludeImageKeywords: ['aweme-avatar', 'avatar', 'pigeon-sign'],
    excludeImageClasses: ['avatar', 'menuicon', 'menu-icon'],
    // 飞鸽 workStation 右侧面板起始 x ≈ 880px（在 1920px 宽度下约 0.46），
    // 标签页 x 范围 884-1060，必须低于 0.46 才能匹配整个右侧面板区域
    rightPanelXRatio: 0.4,
    noProductText: '暂无咨询商品',
    extraExcludeTexts: [
      '飞鸽平均响应时长', '今日接待人数', '抖音-其他', '店1',
      'AI智能客服 - 挽单策略配置', '《售后挽单策略》',
      '已收起足迹和推荐', '已加载近6个月订单', '查询近3年订单',
      '从历史会话发起会话', '唯衣美服装工作室',
    ],
  },
  pinduoduo: {
    platformId: 'pinduoduo',
    productTabText: '商品推荐',
    orderTabText: '最新订单',
    tabItemSelector: '.bar-item, [class*="bar-item"]',
    activeTabSelector: '.bar-item.active, [class*="bar-item"][class*="active"]',
    rightPanelSelector: '.right-panel-container, .right-panel, #right-panel',
    productImageDomains: ['yangkeduo', 'pddpic', 'pinduoduo'],
    excludeImageKeywords: ['avatar', 'chat-portrait', 'mobile_user_avatar', 'icons', 'question-icon'],
    excludeImageClasses: ['avatar', 'chat-portrait', 'icons', 'question-icon'],
    rightPanelXRatio: 0.55,
    noProductText: '没有相关订单',
    orderSubTabs: ['个人订单', '店铺待支付订单'],
    extraExcludeTexts: [
      '机器人套餐已用完', '已停止自动回复', '点此20元续费',
      '邀请关注', '邀请下单', '小额打款', '文字聊天、语音/隐私号沟通中',
      '诱导第三方违规', '消费者服务体验分', '查看店铺数据',
      '3分钟人工回复率', '今日咨询人数', '今日客服成团金额',
      '询单人数', '成团人数', '询单转化率', '客服销售额',
      '30s应答率', '平均人工响应时长', '开启Win工作台',
      '智能快捷回复助手', '您有1个商品问题待补全答案', '立即补全',
      '为了保障消费者体验', '店铺待支付订单不再提供聊天催付',
    ],
  },
  kuaishou: {
    platformId: 'kuaishou',
    productTabText: '商品',
    orderTabText: '订单',
    tabItemSelector: '[class*="tab"], [class*="Tab"]',
    activeTabSelector: '[class*="tab"][class*="active"], [class*="Tab"][class*="active"]',
    rightPanelSelector: '[class*="right-panel"], [class*="aside"], [class*="info-panel"]',
    productImageDomains: ['kwaixiaodian', 'kuaishou', 'yxkwaixiaodian'],
    excludeImageKeywords: ['avatar', 'portrait', 'head-img'],
    excludeImageClasses: ['avatar', 'portrait', 'head', 'icon'],
    rightPanelXRatio: 0.55,
    noProductText: '暂无商品',
    extraExcludeTexts: [
      '快语客服', '工作台', '小店管理',
    ],
  },
  weixin: {
    platformId: 'weixin',
    productTabText: '商品',
    orderTabText: '订单',
    tabItemSelector: '.weui-desktop-tabs__nav__item, [class*="tab"]',
    activeTabSelector: '.weui-desktop-tabs__nav__item_weui-desktop-tabs__nav__item_on, [class*="tab"][class*="active"]',
    rightPanelSelector: '[class*="right-panel"], .weui-desktop-layout__main__hd, [class*="aside"]',
    productImageDomains: ['weixin', 'wechat', 'mmbiz'],
    excludeImageKeywords: ['avatar', 'portrait', 'head'],
    excludeImageClasses: ['avatar', 'portrait', 'head', 'icon'],
    rightPanelXRatio: 0.55,
    noProductText: '暂无商品',
    extraExcludeTexts: [
      '微信小店', '扫码登录', '小程序',
    ],
  },
};

/**
 * 通用排除文本（所有平台共享）
 */
export const COMMON_EXCLUDE_TEXTS = [
  '拉黑周期', '举报原因', '发送', '取消', '确定', '关闭', '更多',
  '转人工', '快捷回复', '常见问题', '商品', '订单', '买家',
  '全部', '待付款', '待发货', '已发货', '已完成', '退款', '售后',
  '查看详情', '查看更多', '展开', '收起', '上一页', '下一页',
  '复制', '粘贴', '截图', '文件', '表情', '图片', '视频',
  '加入黑名单', '取消拉黑', '结束会话', '标记已处理', '备注',
  '买家画像', '购物车', '优惠券', '会员', '标签',
  '未完结', '售后中', '已完结', '已关闭', '已读', '未读',
  '添加备注', '店铺消费', '退货率',
  '从历史会话发起会话', '以上为历史消息', '组件渲染中，请稍后...',
  '授权平台人员查看与消费者的聊天信息，核实拉黑', '提交',
  '在线', '会话', '智能客服', '留言', '服务工单',
  '数据', '客服管理', '商家后台',
  '当前会话', '最近联系', '列表设置', '等待时长', '已分组',
  '会话搜索', '快捷短语', '人工已回复', '0秒',
  '加载更多会话', '待办任务', '主账号',
];

/**
 * 根据平台配置生成客服会话页面商品抓取脚本（异步）。
 *
 * 工作流程：
 * 1. 记录当前激活的标签页（用于恢复）
 * 2. 点击"商品"标签页，等待加载，抓取商品面板中的商品
 * 3. 点击"订单"标签页，等待加载，从订单面板中提取商品
 * 4. 恢复到原来的标签页状态
 * 5. 同时扫描聊天消息中的商品图片卡片
 *
 * 各平台的 DOM 结构、标签页文本、商品图片域名通过 config 参数定制。
 */
export function buildScrapeScript(config: PlatformScrapeConfig): string {
  const productDomains = JSON.stringify(config.productImageDomains);
  const excludeImgKeywords = JSON.stringify(config.excludeImageKeywords);
  const excludeImgClasses = JSON.stringify(config.excludeImageClasses);
  const tabItemSelector = config.tabItemSelector;
  const activeTabSelector = config.activeTabSelector;
  const productTabText = config.productTabText;
  const orderTabText = config.orderTabText;
  const noProductText = config.noProductText;
  const rightPanelXRatio = config.rightPanelXRatio;
  const excludeTexts = JSON.stringify([...COMMON_EXCLUDE_TEXTS, ...(config.extraExcludeTexts || [])]);
  const orderSubTabs = JSON.stringify(config.orderSubTabs || []);

  return `(async function() {
  var products = [];
  var errors = [];
  var debug = { steps: [] };
  var seenIds = {};
  var seenNames = {};

  // ===== 平台配置（由生成器注入） =====
  var PRODUCT_DOMAINS = ${productDomains};
  var EXCLUDE_IMG_KEYWORDS = ${excludeImgKeywords};
  var EXCLUDE_IMG_CLASSES = ${excludeImgClasses};
  var TAB_ITEM_SELECTOR = ${JSON.stringify(tabItemSelector)};
  var ACTIVE_TAB_SELECTOR = ${JSON.stringify(activeTabSelector)};
  var PRODUCT_TAB_TEXT = ${JSON.stringify(productTabText)};
  var ORDER_TAB_TEXT = ${JSON.stringify(orderTabText)};
  var NO_PRODUCT_TEXT = ${JSON.stringify(noProductText)};
  var RIGHT_PANEL_X_RATIO = ${rightPanelXRatio};
  var EXCLUDE_TEXTS = ${excludeTexts};
  var ORDER_SUB_TABS = ${orderSubTabs};

  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function isExcluded(text) {
    if (!text) return true;
    var t = text.trim();
    if (t.length < 2) return true;
    if (t.length > 100) return true;
    for (var i = 0; i < EXCLUDE_TEXTS.length; i++) {
      if (t === EXCLUDE_TEXTS[i]) return true;
    }
    if (/^\\d+$/.test(t)) return true;
    if (/^\\d{1,2}:\\d{2}(:\\d{2})?$/.test(t)) return true;
    if (/^[¥￥]\\s*[\\d,.]+$/.test(t)) return true;
    if (/^\\d+\\/\\d+$/.test(t)) return true;
    if (/^亲[，,!！]/.test(t)) return true;
    if (/^(建议您|若您|如果|抱歉|不好意思|看起来)/.test(t)) return true;
    if (/(留言|联系方式|回拨|订单号|具体需求|第一时间|咨询问题|系统关闭|会话超时)/.test(t)) return true;
    if (/^\\d+%$/.test(t)) return true;
    if (/[。！？!?,，]/.test(t) && t.length > 20) return true;
    return false;
  }

  function isProductImage(imgEl, src) {
    if (!src || src.length < 20) return false;
    if (src.startsWith('data:')) return false;
    var cls = (imgEl.className || '').toString().toLowerCase();
    var alt = (imgEl.alt || '').toLowerCase();
    // 排除头像/图标 class
    for (var c = 0; c < EXCLUDE_IMG_CLASSES.length; c++) {
      if (cls.indexOf(EXCLUDE_IMG_CLASSES[c]) >= 0) return false;
    }
    if (alt.indexOf('头像') >= 0) return false;
    // 排除头像/图标 URL 关键字
    for (var k = 0; k < EXCLUDE_IMG_KEYWORDS.length; k++) {
      if (src.indexOf(EXCLUDE_IMG_KEYWORDS[k]) >= 0) return false;
    }
    var rect = imgEl.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return false;
    // 必须是商品图片域名
    var isProduct = false;
    for (var d = 0; d < PRODUCT_DOMAINS.length; d++) {
      if (src.indexOf(PRODUCT_DOMAINS[d]) >= 0) { isProduct = true; break; }
    }
    return isProduct;
  }

  function isInRightPanel(el) {
    var r = el.getBoundingClientRect();
    return r.left > window.innerWidth * RIGHT_PANEL_X_RATIO;
  }

  function extractProductId(text, el) {
    if (!text) text = '';
    if (el) {
      var pid = el.getAttribute('data-product-id') || el.getAttribute('data-goods-id') ||
                el.getAttribute('data-spu-id') || el.getAttribute('data-item-id') || '';
      if (pid) return pid;
    }
    var patterns = [
      /(?:商品ID|商品编号|SPU|spu|SKU|sku)[:：\\s]*([A-Za-z0-9_-]{4,40})/i,
      /"productId"\\s*[:：]\\s*"([A-Za-z0-9_-]{4,40})"/i
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = text.match(patterns[i]);
      if (m) return m[1];
    }
    return '';
  }

  function extractPrice(text) {
    if (!text) return 0;
    var m = text.match(/[¥￥]\\s*([\\d,.]+)/);
    if (m) return parseFloat(m[1].replace(/,/g, '')) || 0;
    m = text.match(/([\\d,.]+)\\s*元/);
    if (m) return parseFloat(m[1].replace(/,/g, '')) || 0;
    return 0;
  }

  function addProduct(pid, name, price, imgUrl, specs, attrs) {
    if (!name || isExcluded(name)) return false;
    if (seenNames[name]) return false;
    if (pid && seenIds[pid]) return false;
    seenNames[name] = true;
    if (pid) seenIds[pid] = true;
    products.push({
      productId: pid || ('gen_' + products.length),
      name: name,
      price: price || 0,
      imageUrl: imgUrl ? imgUrl.substring(0, 250) : '',
      specs: specs || [],
      attrs: attrs || []
    });
    return true;
  }

  // 点击指定文本的标签页（使用平台专属选择器）
  function clickTab(tabText) {
    var tabItemEls = document.querySelectorAll(TAB_ITEM_SELECTOR);
    for (var i = 0; i < tabItemEls.length; i++) {
      var t = tabItemEls[i];
      if (t.offsetParent === null && t.tagName !== 'BODY') continue;
      var text = (t.innerText || t.textContent || '').trim();
      if (text === tabText) {
        t.click();
        return true;
      }
    }
    // 回退：查找所有可能包含标签文本的元素
    var allEls = document.querySelectorAll('span, div, a, button, li');
    for (var j = 0; j < allEls.length; j++) {
      var el = allEls[j];
      if (el.offsetParent === null && el.tagName !== 'BODY') continue;
      if (el.children.length > 5) continue;
      var elText = (el.innerText || el.textContent || '').trim();
      if (elText === tabText) {
        el.click();
        return true;
      }
    }
    return false;
  }

  function parseProductFromContainer(containerText, containerEl) {
    var lines = containerText.split('\\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
    var name = '';
    var price = 0;
    var specs = [];
    var attrs = [];

    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (!name && !isExcluded(line) && !/^[¥￥]/.test(line)) {
        name = line;
        continue;
      }
      if (!price) {
        var p = extractPrice(line);
        if (p > 0) price = p;
      }
      var specMatch = line.match(/^(颜色|尺码|版型|型号|规格|款式|分类|套餐|容量|重量|尺寸)[:：]\\s*(.+)$/);
      if (specMatch) {
        var specName = specMatch[1].trim();
        var specValues = specMatch[2].trim().split(/[\\s,，、/|]+/).filter(function(v) { return v; });
        if (specValues.length > 0) specs.push({ name: specName, values: specValues });
        continue;
      }
      var attrMatch = line.match(/^(材质|品牌|产地|风格|季节|人群|领型|袖长|图案|厚度|弹性|面料|季节)[:：]\\s*(.+)$/);
      if (attrMatch) {
        attrs.push({ name: attrMatch[1].trim(), value: attrMatch[2].trim() });
        continue;
      }
    }

    var pid = extractProductId(containerText, containerEl);
    return { name: name, price: price, pid: pid, specs: specs, attrs: attrs };
  }

  // 从右侧面板区域抓取商品图片并解析
  function scrapeImagesFromRightPanel() {
    var allImgs = document.querySelectorAll('img');
    var panelImgs = [];
    for (var ai = 0; ai < allImgs.length; ai++) {
      var imgEl = allImgs[ai];
      var src = imgEl.src || imgEl.getAttribute('data-src') || '';
      if (!isProductImage(imgEl, src)) continue;
      if (!isInRightPanel(imgEl)) continue;
      panelImgs.push({ el: imgEl, src: src });
    }
    for (var ci = 0; ci < panelImgs.length; ci++) {
      var cImg = panelImgs[ci];
      var container = cImg.el.parentElement;
      for (var p = 0; p < 6 && container; p++) {
        if (!isInRightPanel(container)) break;
        var cText = (container.innerText || '').trim();
        if (cText.length > 5 && cText.length < 500) {
          var parsed = parseProductFromContainer(cText, container);
          if (parsed.name) {
            addProduct(parsed.pid, parsed.name, parsed.price, cImg.src, parsed.specs, parsed.attrs);
            break;
          }
        }
        container = container.parentElement;
      }
    }
    return panelImgs.length;
  }

  // ===== 步骤前置：确保右侧面板有标签页（即选中了有效会话）=====
  // 飞鸽在选中已关闭/无效会话时不显示商品/订单标签页，需要切换到有效会话
  function hasProductOrOrderTab() {
    var tabEls = document.querySelectorAll(TAB_ITEM_SELECTOR);
    for (var te = 0; te < tabEls.length; te++) {
      var teText = (tabEls[te].innerText || '').trim();
      if (teText === PRODUCT_TAB_TEXT || teText === ORDER_TAB_TEXT) return true;
    }
    return false;
  }

  function clickFirstValidSession() {
    // 飞鸽会话列表项选择器：左侧会话列表中的可点击会话项
    var sessionSelectors = [
      '[class*="sessionItem"]', '[class*="session-item"]',
      '[class*="conversationItem"]', '[class*="conversation-item"]',
      '[class*="chatItem"]', '[class*="chat-item"]',
      '[class*="listItem"] [class*="name"]', '[class*="recentItem"]'
    ];
    for (var ss = 0; ss < sessionSelectors.length; ss++) {
      var sEls = document.querySelectorAll(sessionSelectors[ss]);
      for (var se = 0; se < sEls.length && se < 10; se++) {
        var sEl = sEls[se];
        if (sEl.offsetParent === null && sEl.tagName !== 'BODY') continue;
        var sRect = sEl.getBoundingClientRect();
        // 会话列表项通常在左侧（x < 窗口宽度的 40%）
        if (sRect.x < window.innerWidth * 0.4 && sRect.width > 50 && sRect.height > 20) {
          sEl.click();
          return sEl.className.substring(0, 80);
        }
      }
    }
    // 回退：点击左侧会话列表区域的任何可点击元素
    var allClickable = document.querySelectorAll('[class*="recent"] [class*="item"], [class*="session"] [class*="item"]');
    for (var ac = 0; ac < allClickable.length && ac < 10; ac++) {
      var acEl = allClickable[ac];
      if (acEl.offsetParent === null && acEl.tagName !== 'BODY') continue;
      var acRect = acEl.getBoundingClientRect();
      if (acRect.x < window.innerWidth * 0.4 && acRect.width > 50 && acRect.height > 20) {
        acEl.click();
        return acEl.className.substring(0, 80);
      }
    }
    return '';
  }

  if (!hasProductOrOrderTab()) {
    debug.steps.push({ step: 'pre_check', hasTab: false, action: 'try_click_session' });
    var clickedSession = clickFirstValidSession();
    debug.steps.push({ step: 'click_session', clicked: !!clickedSession, className: clickedSession });
    if (clickedSession) {
      await sleep(2500);
    }
    // 再次检查
    var hasTabAfter = hasProductOrOrderTab();
    debug.steps.push({ step: 'pre_check_after', hasTab: hasTabAfter });
  } else {
    debug.steps.push({ step: 'pre_check', hasTab: true });
  }

  // ===== 步骤0：扫描右侧面板的商品图片 =====
  var initImgCount = scrapeImagesFromRightPanel();
  debug.steps.push({ step: 'scan_right_panel_images', count: initImgCount });

  // ===== 步骤1：记录当前激活的标签页 =====
  var activeTabText = '';
  var activeTabs = document.querySelectorAll(ACTIVE_TAB_SELECTOR);
  for (var at = 0; at < activeTabs.length; at++) {
    var aText = (activeTabs[at].innerText || '').trim();
    if (aText && aText.length < 20) {
      activeTabText = aText;
      break;
    }
  }
  debug.steps.push({ step: 'record_active_tab', activeTab: activeTabText });

  // 外层 try 包裹所有抓取步骤（步骤2/3/4），任何未捕获的异常都会被 L2169 的 catch(scriptErr) 捕获
  // 缺少这个 try 会导致 L2169 的 catch 没有对应的 try，引发 SyntaxError: Unexpected token 'catch'
  try {

  // ===== 步骤2：点击"商品"标签页，抓取商品面板 =====
  try {
    var clicked = clickTab(PRODUCT_TAB_TEXT);
    debug.steps.push({ step: 'click_product_tab', clicked: clicked, tabText: PRODUCT_TAB_TEXT });
    if (clicked) {
      await sleep(2000);
      var bodyText = (document.body.innerText || '');
      var hasNoProduct = NO_PRODUCT_TEXT && bodyText.indexOf(NO_PRODUCT_TEXT) >= 0;
      debug.steps.push({ step: 'product_tab_check', hasNoProduct: hasNoProduct });
      if (!hasNoProduct) {
        var productImgCount = scrapeImagesFromRightPanel();
        debug.steps.push({ step: 'product_tab_images', imgCount: productImgCount, productsAfter: products.length });

        // 备选方案：从 workStation 文本中解析商品信息（飞鸽商品可能使用 background-image 而非 <img>）
        // addProduct 有名称去重逻辑，已通过图片抓取的商品不会重复添加
        {
          var wsEl = document.getElementById('workStation') || document.querySelector('[class*="workStation"]');
          if (wsEl) {
            var wsText = (wsEl.innerText || '').trim();
            var wsLines = wsText.split('\\n').map(function(s) { return s.trim(); }).filter(Boolean);
            // 标签页文本和功能按钮文本（不作为商品名）
            var excludeTexts = ['订单', '会话搜索', '商品', '快捷短语', '全部商品', '浏览足迹', '爆品推荐',
              '保障', '优惠', '券', '物流', '发送商品', '邀请下单', '规格属性', '计算价格', '商品视频', '商品评价',
              '7天无理由退货', '运费险', '未发货极速退款', '极速退款', '48小时内发货'];
            // EXCLUDE_TEXTS 已包含 COMMON_EXCLUDE_TEXTS + extraExcludeTexts（由生成器注入）
            EXCLUDE_TEXTS.forEach(function(t) { excludeTexts.push(t); });
            var pendingProduct = null;
            for (var wl = 0; wl < wsLines.length; wl++) {
              var line = wsLines[wl];
              // 价格行
              if (/^[￥¥]\\s*\\d/.test(line)) {
                if (pendingProduct) {
                  var priceMatch = line.match(/[￥¥]\\s*(\\d+(?:\\.\\d{1,2})?)/);
                  if (priceMatch) pendingProduct.price = parseFloat(priceMatch[1]);
                }
                continue;
              }
              // 已售行
              if (/^已售\\s*\\d+/.test(line)) {
                continue;
              }
              // 库存行
              if (/^库存\\s*\\d+/.test(line)) {
                continue;
              }
              // 满减/优惠/立减行
              if (/^满\\d+减\\d+/.test(line) || /^立减\\d+/.test(line) || /^\\d+元(?:起|包邮)?$/.test(line)) {
                continue;
              }
              // 排除标签页文本和功能按钮
              if (excludeTexts.indexOf(line) >= 0) {
                // 如果之前有 pendingProduct，先保存
                if (pendingProduct && pendingProduct.name) {
                  addProduct(pendingProduct.pid || '', pendingProduct.name, pendingProduct.price || 0, pendingProduct.imageUrl || '', [], []);
                }
                pendingProduct = null;
                continue;
              }
              // 商品名行：长度 5-100，不包含数字开头、不包含价格符号
              if (line.length >= 5 && line.length <= 100
                && !/^\\d/.test(line)
                && line.indexOf('￥') < 0 && line.indexOf('¥') < 0
                && line.indexOf('订单') < 0 && line.indexOf('发货') < 0
                && line.indexOf('退货') < 0 && line.indexOf('退款') < 0) {
                // 可能是商品名
                if (pendingProduct && pendingProduct.name) {
                  // 保存上一个商品
                  addProduct(pendingProduct.pid || '', pendingProduct.name, pendingProduct.price || 0, pendingProduct.imageUrl || '', [], []);
                }
                pendingProduct = { name: line, price: 0, imageUrl: '', pid: '' };
              }
            }
            // 保存最后一个商品
            if (pendingProduct && pendingProduct.name) {
              addProduct(pendingProduct.pid || '', pendingProduct.name, pendingProduct.price || 0, pendingProduct.imageUrl || '', [], []);
            }
            debug.steps.push({ step: 'product_tab_text_parse', productsAfter: products.length });
          }
        }
      }
    }
  } catch (e) {
    errors.push('商品标签页抓取失败: ' + (e && e.message || String(e)));
  }

  // ===== 步骤3：点击"订单"标签页，从订单中提取商品 =====
  try {
    var clickedOrder = clickTab(ORDER_TAB_TEXT);
    debug.steps.push({ step: 'click_order_tab', clicked: clickedOrder, tabText: ORDER_TAB_TEXT });
    if (clickedOrder) {
      await sleep(2000);

      // 拼多多等平台有订单子标签页，依次点击以扫描更多订单
      if (ORDER_SUB_TABS && ORDER_SUB_TABS.length > 0) {
        for (var ost = 0; ost < ORDER_SUB_TABS.length; ost++) {
          try {
            var subClicked = clickTab(ORDER_SUB_TABS[ost]);
            if (subClicked) {
              await sleep(1500);
              var subImgCount = scrapeImagesFromRightPanel();
              debug.steps.push({ step: 'order_sub_tab', subTab: ORDER_SUB_TABS[ost], imgCount: subImgCount, productsAfter: products.length });
            }
          } catch (subE) {
            // 子标签页点击失败，继续下一个
          }
        }
      } else {
        var orderImgCount = scrapeImagesFromRightPanel();
        debug.steps.push({ step: 'order_tab_images', imgCount: orderImgCount, productsAfter: products.length });
      }

      // 策略C：查找订单号附近的商品文本（仅在右侧面板区域）
      var orderNoEls = document.querySelectorAll('span, div, p, label, td, li');
      for (var on = 0; on < orderNoEls.length && products.length < 100; on++) {
        var onEl = orderNoEls[on];
        if (onEl.children.length > 0) continue;
        if (!isInRightPanel(onEl)) continue;
        var onText = (onEl.innerText || '').trim();
        if (onText.indexOf('订单号') >= 0 || onText.indexOf('订单编号') >= 0) {
          var onContainer = onEl.parentElement;
          for (var onc = 0; onc < 5 && onContainer; onc++) {
            if (!isInRightPanel(onContainer)) break;
            var onCText = (onContainer.innerText || '').trim();
            if (onCText.length > 30 && onCText.length < 800) {
              var onParsed = parseProductFromContainer(onCText, onContainer);
              if (onParsed.name) {
                addProduct(onParsed.pid, onParsed.name, onParsed.price, '', onParsed.specs, onParsed.attrs);
                break;
              }
            }
            onContainer = onContainer.parentElement;
          }
        }
      }
      debug.steps.push({ step: 'order_tab_text_scan', productsAfter: products.length });
    }
  } catch (e) {
    errors.push('订单标签页抓取失败: ' + (e && e.message || String(e)));
  }

  // ===== 步骤4：恢复到原来的标签页 =====
  try {
    if (activeTabText) {
      clickTab(activeTabText);
    }
  } catch (e) {
    // ignore
  }

  } catch(scriptErr) {
    // 捕获脚本执行中的任何异常，返回错误信息而非直接抛出
    errors.push('SCRIPT_ERROR: ' + (scriptErr && scriptErr.message || String(scriptErr)));
    debug.scriptError = String(scriptErr && scriptErr.message || scriptErr);
    debug.scriptStack = String(scriptErr && scriptErr.stack || '').substring(0, 1500);
  }

  return JSON.stringify({ products: products, errors: errors, debug: debug, platform: ${JSON.stringify(config.platformId)} });
})()`;
}

/** 预生成的各平台抓取脚本 */
export const SCRAPE_SCRIPTS: Record<PlatformId, string> = {
  feige: buildScrapeScript(PLATFORM_SCRAPE_CONFIGS.feige),
  pinduoduo: buildScrapeScript(PLATFORM_SCRAPE_CONFIGS.pinduoduo),
  kuaishou: buildScrapeScript(PLATFORM_SCRAPE_CONFIGS.kuaishou),
  weixin: buildScrapeScript(PLATFORM_SCRAPE_CONFIGS.weixin),
};

/**
 * 根据平台 ID 获取对应的客服会话页面商品抓取脚本。
 * 每个平台的 DOM 结构、标签页文本、商品图片域名不同，使用独立脚本。
 */
export function getScrapeScriptForPlatform(platformId: string): string {
  const id = (['feige', 'pinduoduo', 'kuaishou', 'weixin'].includes(platformId) ? platformId : 'feige') as PlatformId;
  return SCRAPE_SCRIPTS[id];
}

/**
 * 详细诊断脚本：收集客服会话页面完整的 DOM 结构信息，用于自动分析商品元素。
 * 输出到文件，不做字符数限制。
 */
export const DETAILED_DIAG_SCRIPT = `(function() {
  var info = {
    url: window.location.href,
    timestamp: Date.now(),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    bodyTextLength: (document.body.innerText || '').length,
    bodyText: (document.body.innerText || '').substring(0, 5000),
    foundTexts: {},
    priceElements: [],
    productImages: [],
    dataIdElements: [],
    sidebarCandidates: [],
    productLikeElements: [],
    iframes: []
  };

  var targetTexts = ['商品', '全部商品', '规格属性', '商品规格', '商品属性', '商品列表', '商品信息', '商品详情', '订单', '买家信息', '快捷回复'];

  function getDomPath(el, maxDepth) {
    var path = [];
    var cur = el;
    for (var d = 0; d < (maxDepth || 6) && cur; d++) {
      path.push({
        tag: cur.tagName,
        className: (cur.className || '').toString().substring(0, 200),
        id: cur.id || ''
      });
      cur = cur.parentElement;
    }
    return path;
  }

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }

  // 1. 关键文本元素
  var allEls = document.querySelectorAll('span, div, a, li, button, p, td, th, h1, h2, h3, h4, h5, h6, label');
  for (var i = 0; i < allEls.length; i++) {
    var el = allEls[i];
    if (el.children.length === 0 || el.tagName === 'A' || el.tagName === 'BUTTON' || el.tagName === 'LI') {
      var t = (el.innerText || '').trim();
      if (t && targetTexts.indexOf(t) >= 0) {
        if (!info.foundTexts[t]) info.foundTexts[t] = [];
        if (info.foundTexts[t].length < 5) {
          info.foundTexts[t].push({
            tag: el.tagName,
            className: (el.className || '').toString().substring(0, 200),
            path: getDomPath(el, 6),
            rect: rectOf(el),
            text: t
          });
        }
      }
    }
  }

  // 2. 价格元素（包含 ¥ 的元素）
  var priceEls = document.querySelectorAll('span, div, p, td, li, strong, em, b');
  for (var j = 0; j < priceEls.length && info.priceElements.length < 30; j++) {
    var elText = (priceEls[j].innerText || '').trim();
    if (elText.length > 0 && elText.length < 50 && /^\\s*[¥￥]\\s*[\\d,.]+\\s*$/.test(elText)) {
      info.priceElements.push({
        tag: priceEls[j].tagName,
        className: (priceEls[j].className || '').toString().substring(0, 200),
        text: elText,
        path: getDomPath(priceEls[j], 6),
        rect: rectOf(priceEls[j]),
        parentText: ((priceEls[j].parentElement && priceEls[j].parentElement.innerText) || '').trim().substring(0, 300)
      });
    }
  }

  // 3. 商品图片
  var imgEls = document.querySelectorAll('img');
  for (var k = 0; k < imgEls.length && info.productImages.length < 30; k++) {
    var img = imgEls[k];
    var src = img.src || img.getAttribute('data-src') || '';
    if (src && src.length > 20 && !src.startsWith('data:')) {
      info.productImages.push({
        src: src.substring(0, 300),
        alt: (img.alt || '').substring(0, 100),
        className: (img.className || '').toString().substring(0, 150),
        path: getDomPath(img, 6),
        rect: rectOf(img),
        parentText: ((img.parentElement && img.parentElement.innerText) || '').trim().substring(0, 300)
      });
    }
  }

  // 4. 带 data-product-id 等属性的元素
  var dataEls = document.querySelectorAll('[data-product-id], [data-goods-id], [data-spu-id], [data-item-id], [data-pid], [data-sku]');
  for (var m = 0; m < dataEls.length; m++) {
    var dEl = dataEls[m];
    info.dataIdElements.push({
      tag: dEl.tagName,
      className: (dEl.className || '').toString().substring(0, 200),
      attrs: {
        'data-product-id': dEl.getAttribute('data-product-id') || '',
        'data-goods-id': dEl.getAttribute('data-goods-id') || '',
        'data-spu-id': dEl.getAttribute('data-spu-id') || '',
        'data-item-id': dEl.getAttribute('data-item-id') || '',
        'data-pid': dEl.getAttribute('data-pid') || '',
        'data-sku': dEl.getAttribute('data-sku') || ''
      },
      text: (dEl.innerText || '').trim().substring(0, 300),
      path: getDomPath(dEl, 6),
      rect: rectOf(dEl)
    });
  }

  // 5. 右侧边栏候选容器（详细结构）
  var sidebarSelectors = [
    '[class*="sidebar"]', '[class*="right-panel"]', '[class*="right-side"]',
    '[class*="aside"]', '[class*="panel-right"]', '[class*="workspace-right"]',
    '[class*="right-wrap"]', '[class*="info-panel"]', '[class*="detail-panel"]',
    '[class*="product-panel"]', '[class*="goods-panel"]', '[class*="order-panel"]'
  ];
  for (var s = 0; s < sidebarSelectors.length; s++) {
    var els = document.querySelectorAll(sidebarSelectors[s]);
    for (var si = 0; si < els.length && si < 3; si++) {
      var sbEl = els[si];
      var sbText = (sbEl.innerText || '').trim();
      if (sbText.length > 5) {
        // 收集子元素的标签和类名（前2层）
        var children = [];
        for (var c = 0; c < sbEl.children.length && c < 10; c++) {
          var ch = sbEl.children[c];
          var chChildren = [];
          for (var cc = 0; cc < ch.children.length && cc < 5; cc++) {
            chChildren.push({
              tag: ch.children[cc].tagName,
              className: (ch.children[cc].className || '').toString().substring(0, 100),
              text: ((ch.children[cc].innerText) || '').trim().substring(0, 80)
            });
          }
          children.push({
            tag: ch.tagName,
            className: (ch.className || '').toString().substring(0, 150),
            text: ((ch.innerText) || '').trim().substring(0, 200),
            children: chChildren
          });
        }
        info.sidebarCandidates.push({
          selector: sidebarSelectors[s],
          index: si,
          className: (sbEl.className || '').toString().substring(0, 200),
          textSnippet: sbText.substring(0, 800),
          childCount: sbEl.children.length,
          rect: rectOf(sbEl),
          children: children
        });
      }
    }
  }

  // 6. class 包含 product/goods/item 的元素
  var productLikeSelectors = [
    '[class*="product"]', '[class*="goods"]', '[class*="item-card"]', '[class*="item-row"]',
    '[class*="prod-item"]', '[class*="goods-item"]', '[class*="product-item"]',
    '[class*="product-card"]', '[class*="goods-card"]'
  ];
  for (var p = 0; p < productLikeSelectors.length; p++) {
    var pEls = document.querySelectorAll(productLikeSelectors[p]);
    for (var pi = 0; pi < pEls.length && info.productLikeElements.length < 30; pi++) {
      var pEl = pEls[pi];
      var pText = (pEl.innerText || '').trim();
      if (pText.length > 2 && pText.length < 1000) {
        info.productLikeElements.push({
          selector: productLikeSelectors[p],
          tag: pEl.tagName,
          className: (pEl.className || '').toString().substring(0, 200),
          text: pText.substring(0, 500),
          path: getDomPath(pEl, 4),
          rect: rectOf(pEl)
        });
      }
    }
  }

  // 7. iframes
  var iframes = document.querySelectorAll('iframe');
  for (var f = 0; f < iframes.length; f++) {
    info.iframes.push({
      src: (iframes[f].src || '').substring(0, 200),
      className: (iframes[f].className || '').toString().substring(0, 100),
      rect: rectOf(iframes[f])
    });
  }

  return JSON.stringify(info);
})()`;

/**
 * 商品详情页抓取脚本：在飞鸽商品编辑页面执行。
 * 策略：
 * 1. 优先从 CDP/preload 捕获的 API 响应中提取商品数据
 * 2. 直接解析渲染后的 DOM 文本（抖店详情页不通过独立 API 加载详情，数据嵌入在 SPA 渲染内容中）
 * 3. 多策略 DOM 选择器提取描述、分类、规格、属性、图片
 */
/**
 * 商品详情页 Preload 脚本：在页面 JS 执行前拦截 fetch/XHR，捕获 API 响应。
 * 通过 scrapeUrlInHiddenWindow 的 preloadScript 参数注入，确保在 SPA 发起 API 调用前完成拦截。
 */
export const DETAIL_PAGE_PRELOAD_SCRIPT = `(function() {
  window.__apiCaptures = [];
  var origFetch = window.fetch;
  window.fetch = function() {
    var url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url || '');
    return origFetch.apply(this, arguments).then(function(resp) {
      if (resp && resp.clone && resp.headers) {
        var ct = resp.headers.get('content-type') || '';
        // 捕获所有 JSON 响应（不看 URL 模式，因为抖店 API 路径多变）
        if (ct.indexOf('application/json') >= 0 || /product|detail|spu|goods|item|sku|property|spec|category/i.test(url)) {
          try {
            var cloned = resp.clone();
            cloned.json().then(function(data) {
              window.__apiCaptures.push({ url: url, data: data, timestamp: Date.now() });
            }).catch(function() {});
          } catch(e) {}
        }
      }
      return resp;
    });
  };
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__apiUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    var self = this;
    var url = self.__apiUrl || '';
    self.addEventListener('load', function() {
      try {
        var ct = self.getResponseHeader('content-type') || '';
        if (ct.indexOf('application/json') >= 0 || /product|detail|spu|goods|item|sku|property|spec|category/i.test(url)) {
          var data = JSON.parse(self.responseText);
          window.__apiCaptures.push({ url: url, data: data, timestamp: Date.now() });
        }
      } catch(e) {}
    });
    return origSend.apply(this, arguments);
  };
})();`;

export const SCRAPE_PRODUCT_DETAIL_SCRIPT = `(async function() {
  var result = { description: '', category: '', specs: [], attrs: [], images: [], sales: 0, debug: {} };

  function textOf(el) { return ((el && (el.innerText || el.textContent)) || '').trim(); }
  function cleanText(value) { return (value || '').replace(/\\s+/g, ' ').trim(); }

  // ===== 诊断信息 =====
  result.debug.bodyTextLength = (document.body && document.body.innerText) ? document.body.innerText.length : 0;
  result.debug.bodyTextSnippet = (document.body && document.body.innerText) ? document.body.innerText.substring(0, 3000) : '';
  result.debug.currentUrl = location.href;
  result.debug.pageTitle = document.title || '';

  // ===== 辅助函数：判断元素是否在侧边栏 =====
  function isInSidebar(el) {
    try {
      var r = el.getBoundingClientRect();
      // 飞鸽左侧导航栏宽度约200px
      if (r.x < 50) return true;
      if (r.x < 200 && r.width < 260) return true;
      return false;
    } catch(e) { return false; }
  }

  // ===== 辅助函数：侧边栏导航文本检测 =====
  var NAV_KEYWORDS = ['返回首页', '巨量千川', '推广管理', '广告数据', '资金管理',
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

  function isSidebarNavText(text) {
    if (!text || text.length < 10) return false;
    var matchCount = 0;
    for (var i = 0; i < NAV_KEYWORDS.length; i++) {
      if (text.indexOf(NAV_KEYWORDS[i]) >= 0) matchCount++;
      if (matchCount >= 5) return true;
    }
    return false;
  }

  // ===== 策略1：从 CDP/preload 捕获的 API 响应中提取（如果有的话）=====
  var cdpResponses = window.__cdpApiResponses || [];
  var preloadResponses = window.__apiCaptures || [];
  var apiResponses = [];

  // 解析 CDP 捕获的响应体
  for (var cr = 0; cr < cdpResponses.length; cr++) {
    try {
      var parsed = JSON.parse(cdpResponses[cr].body);
      apiResponses.push({ url: cdpResponses[cr].url, data: parsed });
    } catch(e) {}
  }
  // 合并 preload 捕获
  for (var pr = 0; pr < preloadResponses.length; pr++) {
    apiResponses.push(preloadResponses[pr]);
  }

  result.debug.cdpResponseCount = cdpResponses.length;
  result.debug.preloadResponseCount = preloadResponses.length;
  result.debug.apiResponseCount = apiResponses.length;
  // dump 所有 API 响应的 URL 和顶层键，用于诊断 description 缺失问题
  result.debug.apiResponseUrls = apiResponses.map(function(r) {
    var url = (r && r.url) ? r.url.substring(0, 200) : '';
    var topKeys = [];
    try {
      var d = r && r.data;
      if (d && typeof d === 'object') topKeys = Object.keys(d).slice(0, 15);
    } catch(e) {}
    return { url: url, topKeys: topKeys };
  });
  // dump 第一个包含 product_id 的 API 响应的完整键名
  result.debug.firstApiWithProductKeys = null;
  result.debug.firstApiWithProductUrl = '';
  for (var ari = 0; ari < apiResponses.length; ari++) {
    var arData = apiResponses[ari] && apiResponses[ari].data;
    if (!arData || typeof arData !== 'object') continue;
    // 递归查找第一个含 product_id 的对象
    function findProductObj(o, d) {
      if (!o || d > 6) return null;
      if (typeof o !== 'object') return null;
      if (o.product_id || o.productId || o.spu_id) return o;
      if (Array.isArray(o)) { for (var ii = 0; ii < o.length; ii++) { var f = findProductObj(o[ii], d+1); if (f) return f; } return null; }
      for (var k in o) { if (o.hasOwnProperty(k)) { var f2 = findProductObj(o[k], d+1); if (f2) return f2; } }
      return null;
    }
    var pObj = findProductObj(arData, 0);
    if (pObj) {
      result.debug.firstApiWithProductKeys = Object.keys(pObj).slice(0, 30);
      result.debug.firstApiWithProductUrl = (apiResponses[ari].url || '').substring(0, 250);
      // dump 含 desc 的字段
      var allKeys = Object.keys(pObj);
      result.debug.apiDescFields = allKeys.filter(function(k) { return /desc|content|detail|text|info/i.test(k); });
      result.debug.apiSpecFields = allKeys.filter(function(k) { return /spec|sku|variant|norm|format/i.test(k); });
      result.debug.apiAttrFields = allKeys.filter(function(k) { return /attr|prop|field|param|extend/i.test(k); });
      // dump 这些字段的值长度
      result.debug.apiDescValues = {};
      for (var dk = 0; dk < allKeys.length; dk++) {
        var dKey = allKeys[dk];
        var dVal = pObj[dKey];
        if (dVal === null || dVal === undefined) { result.debug.apiDescValues[dKey] = 'null'; continue; }
        if (typeof dVal === 'string') { result.debug.apiDescValues[dKey] = dVal.substring(0, 80); continue; }
        if (typeof dVal === 'number' || typeof dVal === 'boolean') { result.debug.apiDescValues[dKey] = dVal; continue; }
        if (Array.isArray(dVal)) { result.debug.apiDescValues[dKey] = 'Array(' + dVal.length + ')'; continue; }
        if (typeof dVal === 'object') { result.debug.apiDescValues[dKey] = 'Object{' + Object.keys(dVal).length + '}'; continue; }
      }
      break;
    }
  }

  // 从 API 数据中提取商品信息
  function extractFromApi(obj, depth) {
    if (!obj || depth > 10) return;
    if (Array.isArray(obj)) { for (var i = 0; i < obj.length; i++) extractFromApi(obj[i], depth + 1); return; }
    if (typeof obj !== 'object') return;

    if (obj.product_id || obj.productId || obj.spu_id || obj.goods_id) {
      if (!result.description) {
        var desc = obj.description || obj.desc || obj.detail || obj.detail_info || obj.product_desc || '';
        if (typeof desc === 'string' && desc.length > 10 && !isSidebarNavText(desc)) {
          result.description = cleanText(desc).substring(0, 10000);
        }
      }
      if (!result.category) {
        if (obj.category_name || obj.categoryName) result.category = obj.category_name || obj.categoryName || '';
        else if (Array.isArray(obj.category_path)) result.category = obj.category_path.join('/');
        else if (Array.isArray(obj.categories)) result.category = obj.categories.map(function(c) { return typeof c === 'string' ? c : (c.name || ''); }).filter(Boolean).join('/');
      }
      if (result.specs.length === 0) {
        var specSources = [obj.specs, obj.specifications, obj.spec_info, obj.spec_values, obj.sku_specs, obj.spec_list];
        for (var si = 0; si < specSources.length; si++) {
          var specList = specSources[si];
          if (Array.isArray(specList) && specList.length > 0) {
            for (var s = 0; s < specList.length; s++) {
              var spec = specList[s]; if (!spec) continue;
              var sName = spec.name || spec.spec_name || spec.prop_name || spec.label || '';
              if (sName && typeof sName === 'string') {
                var sValues = [];
                if (Array.isArray(spec.values)) sValues = spec.values.map(function(v) { return typeof v === 'string' ? v : (v.name || v.value || v.label || ''); }).filter(Boolean);
                else if (spec.value) sValues = [String(spec.value)];
                else if (Array.isArray(spec.options)) sValues = spec.options.map(function(v) { return typeof v === 'string' ? v : (v.name || v.value || ''); }).filter(Boolean);
                if (sValues.length > 0) result.specs.push({ name: sName, values: sValues });
              }
            }
            if (result.specs.length > 0) break;
          }
        }
      }
      if (result.attrs.length === 0) {
        var attrSources = [obj.attrs, obj.attributes, obj.props, obj.properties, obj.product_attrs, obj.extra_attrs];
        for (var ai = 0; ai < attrSources.length; ai++) {
          var attrList = attrSources[ai];
          if (Array.isArray(attrList) && attrList.length > 0) {
            for (var a = 0; a < attrList.length; a++) {
              var attr = attrList[a]; if (!attr) continue;
              var aName = attr.name || attr.attr_name || attr.prop_name || attr.label || attr.key || '';
              var aValue = attr.value || attr.attr_value || attr.prop_value || attr.val || '';
              if (aName && typeof aName === 'string') result.attrs.push({ name: aName, value: String(aValue) });
            }
            if (result.attrs.length > 0) break;
          }
        }
      }
      if (result.images.length === 0) {
        var imgSources = [obj.images, obj.pic_urls, obj.image_list, obj.img_urls, obj.pics, obj.product_images];
        for (var imi = 0; imi < imgSources.length; imi++) {
          var imgList = imgSources[imi];
          if (Array.isArray(imgList) && imgList.length > 0) {
            for (var im = 0; im < imgList.length; im++) {
              var imgUrl = '';
              if (typeof imgList[im] === 'string') imgUrl = imgList[im];
              else if (imgList[im]) imgUrl = imgList[im].url || imgList[im].src || imgList[im].image_url || imgList[im].pic_url || '';
              if (imgUrl && imgUrl.indexOf('http') === 0 && !imgUrl.endsWith('.svg') && !/ecombdstatic/.test(imgUrl) && result.images.indexOf(imgUrl) === -1) {
                result.images.push(imgUrl);
              }
            }
            if (result.images.length > 0) break;
          }
        }
        if (result.images.length === 0) {
          var mainImg = obj.main_image || obj.mainImage || obj.pic_url || obj.image || obj.cover || '';
          if (mainImg && mainImg.indexOf('http') === 0 && !mainImg.endsWith('.svg') && !/ecombdstatic/.test(mainImg)) result.images.push(mainImg);
        }
      }
      if (!result.sales) result.sales = parseInt(obj.sold || obj.sales || obj.sold_num || obj.sales_volume || 0, 10) || 0;
      return;
    }
    for (var key in obj) { if (obj.hasOwnProperty(key)) extractFromApi(obj[key], depth + 1); }
  }

  for (var ar = 0; ar < apiResponses.length; ar++) {
    extractFromApi(apiResponses[ar].data, 0);
    var root = apiResponses[ar].data;
    if (root && root.data) extractFromApi(root.data, 0);
    if (root && root.result) extractFromApi(root.result, 0);
  }

  // ===== 策略2：直接解析渲染后的 DOM（主要策略，抖店详情页不通过 API 加载详情）=====

  // 2a. 提取商品描述
  if (!result.description) {
    // 方法1：查找主内容区域的 textarea（排除侧边栏）
    var textareas = document.querySelectorAll('textarea');
    var bestDesc = '';
    for (var ta = 0; ta < textareas.length; ta++) {
      if (isInSidebar(textareas[ta])) continue;
      var val = (textareas[ta].value || '').trim();
      if (val.length > bestDesc.length && !isSidebarNavText(val)) bestDesc = val;
    }
    if (bestDesc.length > 10) result.description = cleanText(bestDesc).substring(0, 10000);

    // 方法2：查找 contenteditable 元素
    if (!result.description) {
      var editables = document.querySelectorAll('[contenteditable="true"]');
      for (var ed = 0; ed < editables.length; ed++) {
        if (isInSidebar(editables[ed])) continue;
        var txt = textOf(editables[ed]);
        if (txt.length > 50 && !isSidebarNavText(txt)) { result.description = cleanText(txt).substring(0, 10000); break; }
      }
    }

    // 方法3：查找描述相关的容器（更广泛的选择器）
    if (!result.description) {
      var descSelectors = '[class*="desc"], [class*="Desc"], [class*="description"], [class*="Description"], [class*="rich-text"], [class*="richText"], [class*="editor"], [class*="Editor"], [class*="detail-content"], [class*="detailContent"], [class*="product-desc"], [class*="productDesc"], [class*="goods-desc"], [class*="goodsDesc"]';
      var descContainers = document.querySelectorAll(descSelectors);
      for (var dc = 0; dc < descContainers.length; dc++) {
        if (isInSidebar(descContainers[dc])) continue;
        var dcText = textOf(descContainers[dc]);
        if (dcText.length > 50 && !isSidebarNavText(dcText)) { result.description = cleanText(dcText).substring(0, 10000); break; }
      }
    }

    // 方法4：查找最长的非侧边栏文本块作为描述
    if (!result.description) {
      var allDivs = document.querySelectorAll('div, section, article');
      var longestText = '';
      for (var di = 0; di < allDivs.length; di++) {
        var div = allDivs[di];
        if (isInSidebar(div)) continue;
        if (div.children.length > 3) continue; // 只找叶子级别的文本块
        var divText = textOf(div);
        // 排除包含太多换行的导航类文本
        if (divText.length > longestText.length && divText.length > 100 && !isSidebarNavText(divText)) {
          // 排除包含按钮文字的文本
          if (!/^(编辑|删除|复制|保存|取消|发布|上架|下架|返回)$/.test(divText.substring(0, 10))) {
            longestText = divText;
          }
        }
      }
      if (longestText.length > 50) result.description = cleanText(longestText).substring(0, 10000);
    }
  }

  // 2b. 提取分类（面包屑导航）
  if (!result.category) {
    var breadSelectors = ['[class*="breadcrumb"]', '[class*="Breadcrumb"]', 'nav[aria-label*="breadcrumb"]', '[class*="crumb"]', '[class*="Crumb"]'];
    for (var bs = 0; bs < breadSelectors.length && !result.category; bs++) {
      var breadcrumbs = document.querySelectorAll(breadSelectors[bs]);
      for (var b = 0; b < breadcrumbs.length; b++) {
        if (isInSidebar(breadcrumbs[b])) continue;
        var items = breadcrumbs[b].querySelectorAll('span, a, li');
        var parts = [];
        for (var i = 0; i < items.length; i++) {
          var t = textOf(items[i]);
          if (t && t.length > 1 && t !== '/' && t !== '>' && t !== '商品管理' && !/^(?:首页|返回|抖店)$/.test(t)) {
            parts.push(t);
          }
        }
        if (parts.length > 0) { result.category = parts.join('/'); break; }
      }
    }
  }

  // 2c. 提取规格参数（查找表格和规格容器）
  if (result.specs.length === 0) {
    var specContainers = document.querySelectorAll('[class*="spec"], [class*="Spec"], [class*="sku"], [class*="Sku"], [class*="param"], [class*="Param"], table');
    for (var sc = 0; sc < specContainers.length && result.specs.length < 20; sc++) {
      if (isInSidebar(specContainers[sc])) continue;
      var rows = specContainers[sc].querySelectorAll('tr, [class*="row"], [class*="Row"], [class*="item"], [class*="Item"]');
      for (var rr = 0; rr < rows.length; rr++) {
        var cells = rows[rr].querySelectorAll('td, th, [class*="cell"], [class*="Cell"], [class*="label"], [class*="value"]');
        if (cells.length >= 2) {
          var name = textOf(cells[0]);
          var value = textOf(cells[1]);
          if (name && value && name.length < 50 && value.length < 500 && !/操作|编辑|删除|复制|查看|上传|添加/i.test(name)) {
            result.specs.push({ name: name, values: value.split(/[,，、\\s]+/).filter(Boolean) });
          }
        }
      }
    }
  }

  // 2d. 提取商品属性（表单 + 表格）
  if (result.attrs.length === 0) {
    var navRegex = /^(?:返回首页|抖店|巨量千川|推广管理|广告数据|资金管理|精选联盟|电商罗盘|服务市场|学习中心|规则中心|功能中心|课程中心|案例中心|最新直播|唯衣美|AI助手|常用|管理|商品管理|订单管理|售后工作台|账户中心|流量|流量运营|搜索运营|短视频运营|AI智能成片|直播管理|图文运营|商城运营|推荐卡运营|营销活动|活动广场|优价推手|营销工具|优惠券|单品直降|营销管理|付费推广|千川推广|联盟推广|订单发货|订单管理|卡券管理|发货中心|订单报备|包裹中心|物流工具|电子面单|物流服务|物流诊断|售后|售后工作台|服务工单|消费者权益|小额打款|快递拦截管理|售后小助手|售后挽单助手|商品|商品创建|评价管理|库存管理|渠道品管理|商品诊断|商品托管|商机中心|商品成长|商品工具|商品素材|源头好货|竞拍管理|店铺|店铺管理|账号管理|商家体验分|违规管理|店铺保障|申诉中心|店铺装修|商家权益|保险服务|申请关店|用户|用户运营|用户触达|会员运营|会员权益|资金|账户中心|保证金账户|抖店贷款|账单管理|返佣管理|发票管理|历史报表|应用)$/;

    // 在表单区域查找
    var formEls = document.querySelectorAll('form, [class*="form"], [class*="Form"]');
    for (var fe = 0; fe < formEls.length && result.attrs.length < 30; fe++) {
      if (isInSidebar(formEls[fe])) continue;
      var formItems = formEls[fe].querySelectorAll('[class*="item"], [class*="Item"], [class*="row"], [class*="Row"], .el-form-item, [class*="form-item"]');
      for (var fi = 0; fi < formItems.length && result.attrs.length < 30; fi++) {
        var labels = formItems[fi].querySelectorAll('label, [class*="label"], [class*="Label"], .el-form-item__label');
        var values = formItems[fi].querySelectorAll('input:not([type="hidden"]), [class*="value"], [class*="Value"], .el-form-item__content, select');
        for (var li = 0; li < labels.length; li++) {
          var lText = textOf(labels[li]).replace(/[：:*\\s]/g, '').trim();
          if (lText && lText.length > 1 && lText.length < 30 && !navRegex.test(lText)) {
            var vText = values.length > li ? textOf(values[li]) : textOf(formItems[fi]).replace(textOf(labels[li]), '').trim();
            if (vText && vText.length > 0 && vText.length < 500) {
              result.attrs.push({ name: lText, value: vText });
            }
          }
        }
      }
    }

    // 在表格中查找
    if (result.attrs.length === 0) {
      var tables = document.querySelectorAll('table');
      for (var tb = 0; tb < tables.length && result.attrs.length < 30; tb++) {
        if (isInSidebar(tables[tb])) continue;
        var trows = tables[tb].querySelectorAll('tr');
        for (var tr = 0; tr < trows.length; tr++) {
          var tcells = trows[tr].querySelectorAll('td, th');
          if (tcells.length >= 2) {
            var tName = textOf(tcells[0]).replace(/[：:*\\s]/g, '').trim();
            var tValue = textOf(tcells[1]);
            if (tName && tValue && tName.length < 30 && tValue.length < 500 && !navRegex.test(tName)) {
              result.attrs.push({ name: tName, value: tValue });
            }
          }
        }
      }
    }

    // 在标签-值对容器中查找（通用模式：查找所有包含 label/value 类名的元素对）
    if (result.attrs.length === 0) {
      var labelEls = document.querySelectorAll('[class*="label"]:not([class*="tab"]), [class*="Label"]:not([class*="Tab"]), [class*="key"]:not([class*="keyword"]), [class*="Key"]');
      for (var le = 0; le < labelEls.length && result.attrs.length < 30; le++) {
        var labelEl = labelEls[le];
        if (isInSidebar(labelEl)) continue;
        var labelText = textOf(labelEl).replace(/[：:*\\s]/g, '').trim();
        if (!labelText || labelText.length < 2 || labelText.length > 30 || navRegex.test(labelText)) continue;
        // 查找相邻的值元素
        var parent = labelEl.parentElement;
        if (!parent) continue;
        var valueEl = parent.querySelector('[class*="value"], [class*="Value"], [class*="content"], [class*="Content"]');
        if (!valueEl) valueEl = parent.nextElementSibling;
        if (valueEl) {
          var valueText = textOf(valueEl).trim();
          if (valueText && valueText.length > 0 && valueText.length < 500) {
            // 避免重复
            var exists = false;
            for (var ck = 0; ck < result.attrs.length; ck++) {
              if (result.attrs[ck].name === labelText) { exists = true; break; }
            }
            if (!exists) result.attrs.push({ name: labelText, value: valueText });
          }
        }
      }
    }
  }

  // 2e. 提取商品图片（增强版：查找所有商品图片，排除图标和装饰图）
  if (result.images.length === 0) {
    var seenUrls = {};
    var excludePattern = /ecombdstatic|avatar|icon|logo|banner|placeholder|pigeon-sign|sidebar|menu|nav|icon-|btn-|arrow|close|search|checkbox|radio|star|heart|share|qrcode|loading|spinner|chevron|caret|sort|filter|toggle|expand|collapse|plus|minus|delete|edit|add|remove|download|upload|print|copy|cut|paste|undo|redo|refresh|sync|settings|config|help|info|warning|error|success|question|flag|tag|bookmark|link|external|internal|lock|unlock|eye|eye-off|visibility|visibility-off|more|ellipsis|hamburger|menu|grid|list|table|chart|graph|calendar|clock|time|date|map|location|pin|navigation|direction|volume|mute|play|pause|stop|record|skip|fast-forward|rewind|shuffle|repeat|loop|fullscreen|exit-fullscreen|minimize|maximize|restore|close-window|open-window|new-window|tab|window|browser|refresh-page|home|back|forward|up|down|left|right|top|bottom|center|middle|align|justify|distribute|group|ungroup|lock|unlock|pin|unpin|star|unstar|heart|unheart|bookmark|unbookmark|flag|unflag|tag|untag|label|unlabel|category|uncategory|folder|unfolder|file|unfile|document|undocument|image|unimage|picture|unpicture|video|unvideo|audio|unaudio|text|untext|code|uncode|script|unscript|style|unstyle|font|unfont|color|uncolor|background|unbackground|border|unborder|shadow|unshadow|opacity|unopacity|filter|unfilter|transform|untransform|animation|unanimation|transition|untransition|keyframe|unkeyframe|timeline|untimeline|layer|unlayer|artboard|unartboard|page|unpage|screen|unscreen|device|undevice|preview|unpreview|export|unexport|import|unimport|share|unshare|publish|unpublish|draft|undraft|version|unversion|history|unhistory|backup|unbackup|restore|unrestore|archive|unarchive|trash|untrash|delete|undelete|remove|unremove|add|unadd|create|uncreate|edit|unedit|update|unupdate|save|unsave|load|unload|open|unopen|close|unclose|start|unstart|stop|unstop|pause|unpause|resume|unresume|restart|unrestart|reset|unreset|revert|unrevert|commit|uncommit|rollback|unrollback|branch|unbranch|merge|unmerge|split|unsplit|clone|unclone|copy|uncopy|cut|uncut|paste|unpaste|duplicate|unduplicate|select|unselect|deselect|undeselect|select-all|unselect-all|invert-selection|uninvert-selection|clear-selection|unclear-selection|select-none|unselect-none|select-inverse|unselect-inverse|find|unfind|replace|unreplace|search|unsearch|filter|unfilter|sort|unsort|group|ungroup|lock|unlock|hide|unhide|show|unshow|isolate|unisolate|focus|unfocus|blur|unblur|zoom-in|zoom-out|zoom-reset|fit-to-screen|actual-size|fit-width|fit-height|fill-screen|center-view|align-left|align-center|align-right|align-top|align-middle|align-bottom|distribute-horizontally|distribute-vertically|arrange-front|arrange-back|arrange-forward|arrange-backward|send-to-front|send-to-back|send-forward|send-backward|flip-horizontal|flip-vertical|rotate-cw|rotate-ccw|transform|free-transform|edit-transform|crop|uncrop|trim|untrim|split|unsplit|slice|unslice|divide|undivide|combine|uncombine|merge|unmerge|flatten|unflatten|rasterize|unrasterize|vectorize|unvectorize|trace|untrace|outline|unoutline|simplify|unsimplify|smooth|unsmooth|optimize|unoptimize|clean|unclean|fix|unfix|repair|unrepair|correct|uncorrect|adjust|unadjust|balance|unbalance|level|unlevel|curve|uncurve|brightness|unbrightness|contrast|uncontrast|saturation|unsaturation|hue|unhue|temperature|untemperature|tint|untint|grain|ungrain|noise|unnoise|blur|unblur|sharpen|unsharpen|emboss|unemboss|edge|unedge|sketch|unsketch|paint|unpaint|fill|unfill|stroke|unstroke|erase|unerase|draw|undraw|select-tool|unselect-tool|move-tool|unmove-tool|pen-tool|unpen-tool|shape-tool|unshape-tool|text-tool|untext-tool|image-tool|unimage-tool|gradient-tool|ungradient-tool|eyedropper|uneyedropper|hand-tool|unhand-tool|zoom-tool|unzoom-tool|slice-tool|unslice-tool|crop-tool|uncrop-tool|note-tool|unnote-tool|comment-tool|uncomment-tool|measure-tool|unmeasure-tool|count-tool|uncount-tool|ruler-tool|unruler-tool|perspective-tool|unperspective-tool|warp-tool|unwarp-tool|puppet-tool|unpuppet-tool|liquid-tool|unliquid-tool|magnetic-tool|unmagnetic-tool|magic-tool|unmagic-tool|quick-selection|unquick-selection|lasso-tool|unlasso-tool|polygon-tool|unpolygon-tool|brush-tool|unbrush-tool|pencil-tool|unpencil-tool|eraser-tool|uneraser-tool|bucket-tool|unbucket-tool|gradient-tool|ungradient-tool|history-brush|unhistory-brush|art-brush|unart-brush|clone-stamp|unclone-stamp|pattern-stamp|unpattern-stamp|healing-brush|unhealing-brush|spot-healing|unspot-healing|patch-tool|unpatch-tool|red-eye|unred-eye|dodge-tool|undodge-tool|burn-tool|unburn-tool|sponge-tool|unsponge-tool|sharpen-tool|unsharpen-tool|blur-tool|unblur-tool|smudge-tool|unsmudge-tool|path-tool|unpath-tool|text-tool|untext-tool|shape-tool|unshape-tool|line-tool|unline-tool|rectangle-tool|unrectangle-tool|ellipse-tool|unellipse-tool|polygon-tool|unpolygon-tool|custom-shape|uncustom-shape|frame-tool|unframe-tool|slice-tool|unslice-tool|note-tool|unnote-tool|audio-tool|unaudio-tool|video-tool|unvideo-tool|animation-tool|unanimation-tool|3d-tool|un3d-tool|navigation-tool|unnavigation-tool|measure-tool|unmeasure-tool|annotation|unannotation/i;

    // 方法1：查找商品图片区域容器中的图片
    var imgAreaSelectors = '[class*="image"], [class*="Image"], [class*="picture"], [class*="Picture"], [class*="gallery"], [class*="Gallery"], [class*="upload"], [class*="Upload"], [class*="preview"], [class*="Preview"], [class*="carousel"], [class*="Carousel"], [class*="thumbnail"], [class*="Thumbnail"], [class*="swiper"], [class*="Swiper"], [class*="slider"], [class*="Slider"]';
    var imgAreas = document.querySelectorAll(imgAreaSelectors);
    for (var ia = 0; ia < imgAreas.length && result.images.length < 10; ia++) {
      if (isInSidebar(imgAreas[ia])) continue;
      var imgs = imgAreas[ia].querySelectorAll('img');
      for (var ig = 0; ig < imgs.length && result.images.length < 10; ig++) {
        var src = imgs[ig].src || imgs[ig].getAttribute('data-src') || imgs[ig].getAttribute('data-original') || '';
        if (src && src.indexOf('http') === 0 && !src.endsWith('.svg') && !seenUrls[src] && !excludePattern.test(src)) {
          var rect = imgs[ig].getBoundingClientRect();
          if (rect.width >= 40 && rect.height >= 40) {
            seenUrls[src] = true;
            result.images.push(src);
          }
        }
      }
    }

    // 方法2：查找所有大图（排除侧边栏和图标）
    if (result.images.length === 0) {
      var allImgs = document.querySelectorAll('img');
      for (var ai2 = 0; ai2 < allImgs.length && result.images.length < 10; ai2++) {
        if (isInSidebar(allImgs[ai2])) continue;
        var src2 = allImgs[ai2].src || allImgs[ai2].getAttribute('data-src') || '';
        if (src2 && src2.indexOf('http') === 0 && !src2.endsWith('.svg') && !seenUrls[src2] && !excludePattern.test(src2)) {
          var rect2 = allImgs[ai2].getBoundingClientRect();
          // 商品图片通常较大（>=60px），图标较小
          if (rect2.width >= 60 && rect2.height >= 60) {
            seenUrls[src2] = true;
            result.images.push(src2);
          }
        }
      }
    }

    // 方法3：查找 background-image 样式中的图片
    if (result.images.length === 0) {
      var bgEls = document.querySelectorAll('[style*="background-image"], [style*="background:"]');
      for (var bg = 0; bg < bgEls.length && result.images.length < 10; bg++) {
        if (isInSidebar(bgEls[bg])) continue;
        var style = bgEls[bg].getAttribute('style') || '';
        var bgMatch = style.match(/url\\(["']?(https?:\\/\\/[^"')]+)["']?\\)/i);
        if (bgMatch && !seenUrls[bgMatch[1]] && !excludePattern.test(bgMatch[1])) {
          var bgRect = bgEls[bg].getBoundingClientRect();
          if (bgRect.width >= 60 && bgRect.height >= 60) {
            seenUrls[bgMatch[1]] = true;
            result.images.push(bgMatch[1]);
          }
        }
      }
    }
  }

  // 2f. 从页面文本中提取销量数据
  if (!result.sales) {
    var bodyText = textOf(document.body);
    // 查找 "销量: 123" 或 "已售 123" 或 "月销 123" 等模式
    var salesMatch = bodyText.match(/(?:销量|已售|月销|售出|sold)\\s*[:：]?\\s*(\\d+)/i);
    if (salesMatch) result.sales = parseInt(salesMatch[1], 10) || 0;
  }

  result.debug.finalDescLen = result.description.length;
  result.debug.finalSpecCount = result.specs.length;
  result.debug.finalAttrCount = result.attrs.length;
  result.debug.finalImageCount = result.images.length;

  return JSON.stringify(result);
})()`;

