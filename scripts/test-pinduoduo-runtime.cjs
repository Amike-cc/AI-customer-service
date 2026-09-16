// scripts/test-pinduoduo-runtime.cjs
//
// 拼多多 AI 客服运行时验证（CDP 9222）
// 验证店铺在线、AI 启用、IPC 可用、商品库、规则引擎、ModelGateway 等运行时状态
//
// 使用：node scripts/test-pinduoduo-runtime.cjs

const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9222;
const PINDUODUO_SHOP_ID = '1783794688704';  // 柚子货架（拼多多）
const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const WARN = '\x1b[33mWARN\x1b[0m';

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

async function evaluate(ws, expr, timeoutMs = 30000) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch (e) {}
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true }
    }));
  });
}

async function callApi(ws, code) {
  const expr = `(async () => {
    try {
      const data = await (${code});
      return JSON.stringify({ ok: true, data });
    } catch (e) {
      return JSON.stringify({ ok: false, error: e.message });
    }
  })()`;
  const res = await evaluate(ws, expr);
  const value = res?.result?.result?.value;
  if (!value) return { ok: false, error: 'CDP 返回空' };
  try { return JSON.parse(value); } catch { return { ok: false, error: 'JSON 解析失败', raw: value }; }
}

function fmt(obj) {
  if (obj === null || obj === undefined) return String(obj);
  if (typeof obj !== 'object') return String(obj);
  try { return JSON.stringify(obj).slice(0, 180); } catch { return String(obj); }
}

(async () => {
  console.log('=== 拼多多 AI 客服运行时验证（CDP 9222）===');
  console.log(`店铺 ID: ${PINDUODUO_SHOP_ID} (柚子货架)\n`);

  const pages = await getPages();
  const main = pages.find(p => p.url && p.url.includes('dist/renderer/index.html'));
  if (!main) { console.error('未找到主渲染页面'); process.exit(1); }
  const ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  console.log(`已连接到渲染进程\n`);

  const tests = [
    // ['编号', '名称', 期望, 实际值获取函数]
  ];

  // R1: 店铺列表中包含 pinduoduo 平台
  console.log('--- R1: 店铺列表中包含 pinduoduo 平台 ---');
  const r1 = await callApi(ws, `window.api.shop.list()`);
  if (r1.ok) {
    const pddShops = (r1.data || []).filter(s => s.platform === 'pinduoduo');
    const pass = pddShops.length > 0;
    console.log(`  [${pass ? PASS : FAIL}] pinduoduo 店铺数: ${pddShops.length}`);
    if (pddShops.length > 0) {
      const s = pddShops[0];
      console.log(`      shopId=${s.shopId}, shopName=${s.shopName}, autoReply=${s.autoReply}, loginStatus=${s.loginStatus}, state=${s.state}`);
    }
  } else { console.log(`  [${FAIL}] ${r1.error}`); }

  // R2: 拼多多店铺状态切换
  console.log('\n--- R2: 拼多多店铺状态（getShopState） ---');
  const r2 = await callApi(ws, `window.api.shop.getLoginStatus('${PINDUODUO_SHOP_ID}')`);
  if (r2.ok) {
    console.log(`  [${PASS}] loginStatus=${r2.data?.loginStatus}`);
  } else { console.log(`  [${FAIL}] ${r2.error}`); }

  // R3: 系统健康检查 - 拼多多店铺是否在 shops 列表中
  console.log('\n--- R3: systemHealth 包含拼多多店铺 ---');
  const r3 = await callApi(ws, `window.api.diagnostic.systemHealth()`);
  if (r3.ok && r3.data?.ok) {
    const shops = r3.data.health?.shops || [];
    const pdd = shops.find(s => s.platform === 'pinduoduo');
    if (pdd) {
      console.log(`  [${PASS}] shopId=${pdd.shopId}, shopName=${pdd.shopName}, autoReply=${pdd.autoReply}, loginStatus=${pdd.loginStatus}, state=${pdd.state}`);
    } else {
      console.log(`  [${FAIL}] systemHealth 中无 pinduoduo 店铺`);
    }
    // DeepSeek 状态
    const ds = r3.data.health?.deepseek;
    if (ds) {
      console.log(`  [${PASS}] DeepSeek circuitState=${ds.circuitState}, apiKeyConfigured=${ds.apiKeyConfigured}, consecutiveFailures=${ds.consecutiveFailures}`);
    }
    // metrics
    const m = r3.data.health?.metrics;
    if (m) {
      console.log(`  [${PASS}] metrics: apiCalls=${m.apiCalls}, messagesReceived=${m.messagesReceived}, repliesSent=${m.repliesSent}, replyFailed=${m.replyFailed}, sensitiveBlocked=${m.sensitiveBlocked}, avgApiLatency=${m.avgApiLatency}ms`);
    }
  } else { console.log(`  [${FAIL}] ${r3.error || r3.data?.error}`); }

  // R4: 拼多多店铺商品库
  console.log('\n--- R4: 拼多多商品库 ---');
  const r4 = await callApi(ws, `window.api.product.list('${PINDUODUO_SHOP_ID}')`);
  if (r4.ok) {
    const products = r4.data || [];
    console.log(`  [${PASS}] 拼多多商品数: ${products.length}`);
    if (products.length > 0) {
      const p = products[0];
      console.log(`      示例: ${p.name?.slice(0, 30) || ''} (id=${p.product_id}, price=${p.price || 'N/A'})`);
    }
  } else { console.log(`  [${FAIL}] ${r4.error || 'API 不可用'}`); }

  // R5: 规则引擎 - 拼多多专属规则
  console.log('\n--- R5: 规则引擎（店铺专属）---');
  const r5 = await callApi(ws, `window.api.rule.list('${PINDUODUO_SHOP_ID}')`);
  if (r5.ok) {
    const rules = r5.data || [];
    console.log(`  [${PASS}] 规则数: ${rules.length}`);
    if (rules.length > 0) {
      console.log(`      示例规则: ${rules[0].name}="${rules[0].pattern?.slice(0, 40) || ''}"`);
    }
  } else { console.log(`  [${FAIL}] ${r5.error}`); }

  // R6: 买家档案 API
  console.log('\n--- R6: 买家档案 API ---');
  const r6 = await callApi(ws, `window.api.buyer.stats('${PINDUODUO_SHOP_ID}', 'pinduoduo')`);
  if (r6.ok) {
    console.log(`  [${PASS}] stats: ${fmt(r6.data)}`);
  } else { console.log(`  [${FAIL}] ${r6.error}`); }

  // R7: 测试回复（testReply，验证 AI 管线对拼多多可用）
  // preload.ts: window.api.test.reply(shopId, message)
  console.log('\n--- R7: 测试回复（AI 管线可用性）---');
  const r7 = await callApi(ws, `window.api.test.reply('${PINDUODUO_SHOP_ID}', '你好，这个商品还有货吗？')`, 60000);
  if (r7.ok && r7.data?.ok && r7.data?.result) {
    const tr = r7.data.result;
    console.log(`  [${PASS}] reply=${(tr.reply || '').slice(0, 80)}`);
    console.log(`      latencyMs=${tr.latencyMs}, sensitiveHits=${tr.sensitiveHits?.length || 0}`);
    if (tr.productMatch) {
      console.log(`      productMatch: productId=${tr.productMatch.productId}, confidence=${tr.productMatch.confidence}, matchType=${tr.productMatch.matchType}`);
    }
    if (tr.pipeline) {
      console.log(`      pipeline: ${tr.pipeline.map(p => `${p.step}:${p.status}`).join(', ')}`);
    }
  } else { console.log(`  [${FAIL}] ${r7.error || r7.data?.error || '测试回复失败'}`); }

  // R8: 拼多多消息历史
  // preload.ts L673: window.api.conversation.sessions(shopId, limit)
  console.log('\n--- R8: 拼多多消息历史 ---');
  const r8 = await callApi(ws, `window.api.conversation.sessions('${PINDUODUO_SHOP_ID}', 10)`);
  if (r8.ok) {
    const sessions = r8.data || [];
    console.log(`  [${PASS}] 拼多多会话数: ${sessions.length}`);
  } else { console.log(`  [${FAIL}] ${r8.error || 'sessions 不可用'}`); }

  // R9: 拼多多专属诊断
  // preload.ts L708: window.api.diagnostic.checkAutoReply(shopId) → {ok, report?}
  console.log('\n--- R9: 拼多多自动回复诊断报告 ---');
  const r9 = await callApi(ws, `window.api.diagnostic.checkAutoReply('${PINDUODUO_SHOP_ID}')`);
  if (r9.ok && r9.data?.ok && r9.data?.report) {
    const rep = r9.data.report;
    console.log(`  [${PASS}] autoReply=${rep.autoReply}, loginStatus=${rep.loginStatus}, apiKeyConfigured=${rep.apiKeyConfigured}, ruleCount=${rep.ruleCount}`);
    if (rep.issues && rep.issues.length > 0) {
      console.log(`      issues: ${rep.issues.join('; ')}`);
    } else {
      console.log(`      issues: 无`);
    }
  } else { console.log(`  [${FAIL}] ${r9.error || r9.data?.error || '诊断 API 不可用'}`); }

  // R10: 平台配置（包含拼多多）
  console.log('\n--- R10: 平台配置（含 pinduoduo）---');
  const r10 = await callApi(ws, `window.api.config.get()`);
  if (r10.ok && r10.data?.platforms) {
    const platforms = r10.data.platforms;
    if (platforms.pinduoduo) {
      console.log(`  [${PASS}] platforms.pinduoduo 存在`);
      console.log(`      web_url=${platforms.pinduoduo.web_url || ''}`);
      console.log(`      字段: ${Object.keys(platforms.pinduoduo).join(', ')}`);
    } else {
      console.log(`  [${FAIL}] platforms.pinduoduo 不存在`);
    }
    console.log(`      全部平台: ${Object.keys(platforms).join(', ')}`);
  } else { console.log(`  [${FAIL}] ${r10.error || 'config.get 不可用'}`); }

  ws.close();
  console.log('\n=== 验证完成 ===');
})().catch(err => {
  console.error('未捕获异常:', err);
  process.exit(1);
});
