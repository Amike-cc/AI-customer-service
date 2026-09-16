// scripts/diagnose-scrape-script.cjs
//
// 通过 CDP 9222 在拼多多 webview 上直接执行简化版抓取脚本
// 捕获 console errors 和异常，定位 buildScrapeScript(pinduoduo) 失败的根因
//
// 使用：node scripts/diagnose-scrape-script.cjs

const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9222;

function getPages() {
  return new Promise((r, j) => {
    http.get(`http://localhost:${CDP_PORT}/json`, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => { try { r(JSON.parse(d)); } catch (e) { j(e); } });
      res.on('error', j);
    }).on('error', j);
  });
}

function makeWs(url) {
  return new WebSocket(url);
}

async function sendCommand(ws, method, params = {}, timeoutMs = 30000) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout ${timeoutMs}ms for ${method}`)), timeoutMs);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.off('message', handler);
          if (msg.error) {
            reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
          } else {
            resolve(msg.result);
          }
        }
      } catch (e) {}
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expr, awaitPromise = true, timeoutMs = 60000) {
  const res = await sendCommand(ws, 'Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  }, timeoutMs);
  return res;
}

(async () => {
  console.log('=== 拼多多 webview 抓取脚本诊断 ===\n');

  const pages = await getPages();
  // 找到拼多多 webview 页面
  const pddPage = pages.find(p => p.url && p.url.includes('mms.pinduoduo.com'));
  if (!pddPage) {
    console.error('未找到拼多多 webview 页面');
    console.log('已发现页面:');
    pages.forEach((p, i) => console.log(`  [${i}] ${p.type}: ${(p.url || '').slice(0, 80)}`));
    process.exit(1);
  }
  console.log(`已找到拼多多 webview: ${(pddPage.url || '').slice(0, 100)}\n`);

  const ws = makeWs(pddPage.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  console.log('已连接到拼多多 webview\n');

  // 启用 Runtime 和 Log domain
  await sendCommand(ws, 'Runtime.enable');
  await sendCommand(ws, 'Log.enable');

  // 收集 console errors
  const consoleErrors = [];
  const exceptions = [];
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
        const args = (msg.params.args || []).map(a => a.value || a.description || '').join(' ');
        consoleErrors.push(`[${msg.params.type}] ${args}`);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const det = msg.params.exceptionDetails;
        exceptions.push(`Exception: ${det.text || det.exception?.description || ''} (line ${det.lineNumber}:${det.columnNumber})`);
      }
      if (msg.method === 'Log.entryAdded') {
        const entry = msg.params.entry;
        consoleErrors.push(`[Log.${entry.level}] ${entry.text}`);
      }
    } catch (e) {}
  });

  // ============ 测试 1：基本访问 ============
  console.log('--- T1: 基本页面访问 ---');
  try {
    const res = await evaluate(ws, `({
      url: location.href,
      title: document.title,
      bodyLen: (document.body.innerText || '').length,
      hasBarItems: document.querySelectorAll('.bar-item, [class*="bar-item"]').length,
      hasRightPanel: document.querySelectorAll('.right-panel-container, .right-panel, #right-panel').length,
      barItemTexts: Array.from(document.querySelectorAll('.bar-item, [class*="bar-item"]')).map(e => (e.innerText || '').trim()).filter(t => t.length > 0).slice(0, 10),
    })`, false);
    console.log(`  PASS: ${JSON.stringify(res.result.value, null, 2).slice(0, 600)}`);
  } catch (e) {
    console.log(`  FAIL: ${e.message}`);
  }

  // ============ 测试 2：尝试执行 buildScrapeScript 的核心片段（变量声明+函数） ============
  console.log('\n--- T2: 执行简化版拼多多抓取脚本（变量声明+函数） ---');
  const simplifiedScript = `(async function() {
    var products = [];
    var errors = [];
    var debug = { steps: [] };

    var PRODUCT_DOMAINS = ["yangkeduo", "pddpic", "pinduoduo"];
    var EXCLUDE_IMG_KEYWORDS = ["avatar", "chat-portrait", "mobile_user_avatar", "icons", "question-icon"];
    var EXCLUDE_IMG_CLASSES = ["avatar", "chat-portrait", "icons", "question-icon"];
    var TAB_ITEM_SELECTOR = ".bar-item, [class*=\\"bar-item\\"]";
    var ACTIVE_TAB_SELECTOR = ".bar-item.active, [class*=\\"bar-item\\"][class*=\\"active\\"]";
    var PRODUCT_TAB_TEXT = "商品推荐";
    var ORDER_TAB_TEXT = "最新订单";
    var NO_PRODUCT_TEXT = "没有相关订单";
    var RIGHT_PANEL_X_RATIO = 0.55;
    var EXCLUDE_TEXTS = ["拉黑周期", "举报原因", "发送", "取消", "确定"];
    var ORDER_SUB_TABS = ["个人订单", "店铺待支付订单"];

    function isExcluded(text) {
      if (!text) return true;
      return text.trim().length < 2;
    }
    function isInRightPanel(el) {
      var r = el.getBoundingClientRect();
      return r.left > window.innerWidth * RIGHT_PANEL_X_RATIO;
    }
    function clickTab(text) {
      var tabs = document.querySelectorAll(TAB_ITEM_SELECTOR);
      for (var i = 0; i < tabs.length; i++) {
        var t = (tabs[i].innerText || '').trim();
        if (t.indexOf(text) >= 0) {
          tabs[i].click();
          return true;
        }
      }
      return false;
    }

    // 简化版抓取：找所有 bar-item 文本
    try {
      var bars = document.querySelectorAll(TAB_ITEM_SELECTOR);
      debug.barCount = bars.length;
      debug.barTexts = Array.from(bars).map(e => (e.innerText || '').trim()).filter(t => t.length > 0).slice(0, 10);
      debug.bodyTextSample = (document.body.innerText || '').substring(0, 300);
      debug.rightPanelCount = document.querySelectorAll('.right-panel-container, .right-panel, #right-panel').length;

      // 尝试点击"商品推荐"标签
      var clicked = clickTab(PRODUCT_TAB_TEXT);
      debug.clickedProductTab = clicked;
      if (clicked) {
        await new Promise(r => setTimeout(r, 1000));
        debug.afterClickBodyLen = (document.body.innerText || '').length;
      }
    } catch (e) {
      errors.push('SCRIPT_ERROR: ' + (e && e.message || String(e)) + ' stack: ' + (e && e.stack || '').substring(0, 500));
    }

    return JSON.stringify({ products, errors, debug, ok: true });
  })()`;
  try {
    const res = await evaluate(ws, simplifiedScript, true, 30000);
    const value = res.result.value;
    if (value) {
      try {
        const parsed = JSON.parse(value);
        console.log(`  PASS: 简化版脚本执行成功`);
        console.log(`  errors: ${parsed.errors?.length || 0}`);
        if (parsed.errors && parsed.errors.length > 0) {
          parsed.errors.forEach(e => console.log(`    - ${e.slice(0, 200)}`));
        }
        console.log(`  debug: ${JSON.stringify(parsed.debug, null, 2).slice(0, 600)}`);
      } catch (e) {
        console.log(`  JSON 解析失败: ${e.message}`);
        console.log(`  raw value: ${value.slice(0, 500)}`);
      }
    } else {
      console.log(`  FAIL: 返回空`);
      console.log(`  raw: ${JSON.stringify(res).slice(0, 500)}`);
    }
  } catch (e) {
    console.log(`  FAIL: ${e.message}`);
  }

  // ============ 测试 3：等待异步事件 ============
  console.log('\n--- T3: 等待异步事件（捕获 console errors） ---');
  await new Promise(r => setTimeout(r, 2000));
  console.log(`  consoleErrors: ${consoleErrors.length}`);
  consoleErrors.slice(0, 10).forEach(e => console.log(`    ${e.slice(0, 200)}`));
  console.log(`  exceptions: ${exceptions.length}`);
  exceptions.slice(0, 5).forEach(e => console.log(`    ${e.slice(0, 300)}`));

  ws.close();
  console.log('\n=== 诊断完成 ===');
})().catch(err => {
  console.error('未捕获异常:', err);
  process.exit(1);
});
