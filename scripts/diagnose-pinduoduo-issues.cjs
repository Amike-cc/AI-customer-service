// scripts/diagnose-pinduoduo-issues.cjs
//
// 拼多多 AI 客服问题诊断脚本
// 检查：webview URL、API Key 状态、商品同步状态、规则未命中时 LLM 调用
//
// 使用：node scripts/diagnose-pinduoduo-issues.cjs

const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9222;
const PINDUODUO_SHOP_ID = '1783794688704';
const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const WARN = '\x1b[33mWARN\x1b[0m';
const INFO = '\x1b[36mINFO\x1b[0m';

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

async function evaluate(ws, expr, timeoutMs = 60000) {
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

async function callApi(ws, code, timeoutMs = 60000) {
  const expr = `(async () => {
    try {
      const data = await (${code});
      return JSON.stringify({ ok: true, data });
    } catch (e) {
      return JSON.stringify({ ok: false, error: e.message, stack: e.stack });
    }
  })()`;
  const res = await evaluate(ws, expr, timeoutMs);
  const value = res?.result?.result?.value;
  if (!value) return { ok: false, error: 'CDP 返回空', raw: res };
  try { return JSON.parse(value); } catch { return { ok: false, error: 'JSON 解析失败', raw: value }; }
}

function fmt(obj) {
  if (obj === null || obj === undefined) return String(obj);
  if (typeof obj !== 'object') return String(obj);
  try { return JSON.stringify(obj).slice(0, 240); } catch { return String(obj); }
}

(async () => {
  console.log('=== 拼多多 AI 客服问题诊断 ===\n');

  const pages = await getPages();
  console.log(`${INFO} CDP 9222 发现 ${pages.length} 个页面:`);
  pages.forEach((p, i) => {
    console.log(`  [${i}] type=${p.type}, url=${(p.url || '').slice(0, 100)}`);
  });
  console.log('');

  // 找到主渲染页面
  const main = pages.find(p => p.url && p.url.includes('dist/renderer/index.html'));
  if (!main) { console.error('未找到主渲染页面'); process.exit(1); }
  const ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  console.log(`${INFO} 已连接到渲染进程\n`);

  // ============ 诊断 1：所有 webview 的 URL ============
  console.log('--- D1: 拼多多 webview 当前 URL ---');
  // 通过 main process 询问 webContents
  // 但渲染进程没有直接访问 webview URL 的 API，尝试通过 shop:getActiveShop 推断
  const d1 = await callApi(ws, `window.api.shop.getActiveShop()`);
  if (d1.ok) {
    console.log(`  ${INFO} 当前激活店铺: shopId=${d1.data?.shopId}`);
  }

  // ============ 诊断 2：DeepSeek API Key 状态 ============
  console.log('\n--- D2: DeepSeek API Key 状态 ---');
  const d2 = await callApi(ws, `window.api.config.getLlmApiKey('deepseek')`);
  if (d2.ok && d2.data?.ok) {
    const masked = d2.data.masked || '(空)';
    const configured = d2.data.configured;
    console.log(`  ${INFO} masked: ${masked}`);
    console.log(`  ${INFO} configured: ${configured}`);
    if (masked.includes('phase5-test') || masked.includes('sk-pha')) {
      console.log(`  ${WARN} ⚠️ API Key 仍是 Phase 5 测试值，需用户在 UI 设置中重新输入真实 Key`);
    } else if (configured) {
      console.log(`  ${PASS} API Key 已配置（看起来是真实值）`);
    } else {
      console.log(`  ${FAIL} API Key 未配置`);
    }
    if (d2.data.note) console.log(`  ${INFO} note: ${d2.data.note}`);
  } else {
    console.log(`  ${FAIL} ${d2.error || d2.data?.error}`);
  }

  // ============ 诊断 3：商品同步状态 ============
  console.log('\n--- D3: 拼多多商品同步状态 ---');
  const d3 = await callApi(ws, `window.api.product.getSyncStatus('${PINDUODUO_SHOP_ID}')`);
  if (d3.ok && d3.data) {
    console.log(`  ${INFO} syncStatus: ${fmt(d3.data)}`);
    if (d3.data.lastSyncAt) {
      const ago = Math.floor((Date.now() - d3.data.lastSyncAt) / 1000 / 60);
      console.log(`  ${INFO} 上次同步: ${ago} 分钟前`);
    } else {
      console.log(`  ${WARN} 从未同步过`);
    }
    if (d3.data.lastResult) {
      console.log(`  ${INFO} lastResult: imported=${d3.data.lastResult.imported}, errors=${d3.data.lastResult.errors?.length || 0}`);
      if (d3.data.lastResult.errors?.length > 0) {
        console.log(`  ${FAIL} 同步错误:`);
        d3.data.lastResult.errors.slice(0, 5).forEach(e => console.log(`      - ${e}`));
      }
    }
  } else {
    console.log(`  ${WARN} syncStatus: ${d3.error || '无数据'}`);
  }

  // ============ 诊断 4：当前商品数 ============
  console.log('\n--- D4: 拼多多当前商品数 ---');
  const d4 = await callApi(ws, `window.api.product.list('${PINDUODUO_SHOP_ID}')`);
  if (d4.ok) {
    const products = d4.data || [];
    console.log(`  ${INFO} 商品数: ${products.length}`);
    if (products.length === 0) {
      console.log(`  ${WARN} ⚠️ 商品库为空，将影响"识别买家询问的商品"功能`);
    } else {
      console.log(`  ${PASS} 商品库已有数据`);
      products.slice(0, 3).forEach((p, i) => {
        console.log(`      [${i}] ${p.name?.slice(0, 40) || '(无名称)'} (id=${p.product_id})`);
      });
    }
  }

  // ============ 诊断 5：DeepSeek 真实可用性（用未命中规则的消息） ============
  console.log('\n--- D5: DeepSeek LLM 真实可用性测试（未命中规则的消息）---');
  // 用一条明显不会命中 greeting 等通用规则的消息
  const testMsg = '请问这款手机支持 5G 网络吗，电池容量是多少毫安时？';
  console.log(`  ${INFO} 测试消息: "${testMsg}"`);
  const d5 = await callApi(ws, `window.api.diagnostic.testReply('${PINDUODUO_SHOP_ID}', '${testMsg.replace(/'/g, "\\'")}')`, 90000);
  if (d5.ok && d5.data?.ok && d5.data?.result) {
    const tr = d5.data.result;
    console.log(`  ${PASS} reply: ${(tr.reply || '').slice(0, 120)}`);
    console.log(`  ${INFO} latencyMs: ${tr.latencyMs}, tokenInput: ${tr.tokenInput}, tokenOutput: ${tr.tokenOutput}`);
    if (tr.matchedRule) {
      console.log(`  ${WARN} 仍命中规则: ${tr.matchedRule}（DeepSeek 不会被调用）`);
    } else {
      console.log(`  ${PASS} 未命中规则，DeepSeek 应被调用`);
    }
    if (tr.pipeline) {
      console.log(`  ${INFO} pipeline:`);
      tr.pipeline.forEach(p => {
        const icon = p.status === 'ok' ? PASS : (p.status === 'skip' ? '⏭️ ' : FAIL);
        console.log(`      ${icon} ${p.step}: ${p.status}${p.detail ? ' (' + p.detail + ')' : ''}`);
      });
      const dsStep = tr.pipeline.find(p => p.step.toLowerCase().includes('deepseek') || p.step.toLowerCase().includes('llm'));
      if (dsStep) {
        if (dsStep.status === 'ok') {
          console.log(`  ${PASS} ✅ DeepSeek LLM 真实可用！`);
        } else if (dsStep.status === 'skip') {
          console.log(`  ${WARN} DeepSeek 被 skip（可能因规则命中）`);
        } else {
          console.log(`  ${FAIL} DeepSeek 调用失败: ${dsStep.detail || ''}`);
        }
      }
    }
    if (tr.sensitiveHits && tr.sensitiveHits.length > 0) {
      console.log(`  ${WARN} 敏感词命中: ${tr.sensitiveHits.join(', ')}`);
    }
  } else {
    console.log(`  ${FAIL} 测试失败: ${d5.error || d5.data?.error || '未知错误'}`);
    if (d5.data?.stack) console.log(`      stack: ${d5.data.stack.slice(0, 200)}`);
  }

  // ============ 诊断 6：商品侧边栏诊断 ============
  console.log('\n--- D6: 拼多多商品侧边栏诊断（确认 webview DOM 可访问）---');
  const d6 = await callApi(ws, `window.api.product.diagnoseSidebar('${PINDUODUO_SHOP_ID}')`, 30000);
  if (d6.ok && d6.data?.ok) {
    console.log(`  ${PASS} 侧边栏诊断成功`);
    console.log(`  ${INFO} data: ${(d6.data.data || '').slice(0, 200)}`);
  } else {
    console.log(`  ${WARN} 侧边栏诊断: ${d6.error || d6.data?.error || '失败'}`);
  }

  // ============ 诊断 7：商品列表页诊断 ============
  console.log('\n--- D7: 拼多多商品列表页诊断 ---');
  const d7 = await callApi(ws, `window.api.product.diagnoseListPage('${PINDUODUO_SHOP_ID}')`, 30000);
  if (d7.ok && d7.data?.ok) {
    console.log(`  ${PASS} 列表页诊断成功`);
    console.log(`  ${INFO} data: ${(d7.data.data || '').slice(0, 200)}`);
  } else {
    console.log(`  ${WARN} 列表页诊断: ${d7.error || d7.data?.error || '失败'}`);
  }

  ws.close();
  console.log('\n=== 诊断完成 ===');
})().catch(err => {
  console.error('未捕获异常:', err);
  process.exit(1);
});
