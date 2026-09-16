// scripts/test-deepseek-real.cjs
//
// 验证 DeepSeek LLM 真实可用性
// 用一条未命中规则的消息触发 testReply，确认 pipeline 中 DeepSeek 步骤状态为 ok
//
// 使用：node scripts/test-deepseek-real.cjs

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

async function evaluate(ws, expr, timeoutMs = 120000) {
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

async function callApi(ws, code, timeoutMs = 120000) {
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

(async () => {
  console.log('=== DeepSeek LLM 真实可用性测试 ===\n');

  const pages = await getPages();
  const main = pages.find(p => p.url && p.url.includes('dist/renderer/index.html'));
  if (!main) { console.error('未找到主渲染页面'); process.exit(1); }
  const ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));

  // 测试 1：用未命中规则的"公司信息"消息（业务咨询但不命中具体商品规则）
  const testMsg1 = '请问你们公司全名叫什么？统一社会信用代码是多少？';
  console.log(`--- 测试 1: "${testMsg1}" ---`);
  const t1 = await callApi(ws, `window.api.diagnostic.testReply('${PINDUODUO_SHOP_ID}', '${testMsg1.replace(/'/g, "\\'")}')`, 120000);
  if (t1.ok && t1.data?.ok && t1.data?.result) {
    const tr = t1.data.result;
    console.log(`  ${INFO} reply: ${(tr.reply || '').slice(0, 200)}`);
    console.log(`  ${INFO} latencyMs: ${tr.latencyMs}, tokenInput: ${tr.tokenInput}, tokenOutput: ${tr.tokenOutput}`);
    console.log(`  ${INFO} matchedRule: ${tr.matchedRule || '(无)'}`);
    if (tr.pipeline) {
      console.log(`  ${INFO} pipeline:`);
      tr.pipeline.forEach(p => {
        const icon = p.status === 'ok' ? '✅' : (p.status === 'skip' ? '⏭️' : '❌');
        console.log(`      ${icon} ${p.step}: ${p.status}${p.detail ? ' (' + p.detail + ')' : ''}`);
      });
    }
    const dsStep = tr.pipeline?.find(p => p.step.toLowerCase().includes('deepseek') || p.step.toLowerCase().includes('llm'));
    if (dsStep?.status === 'ok') {
      console.log(`  ${PASS} ✅ DeepSeek LLM 真实可用！tokenInput=${tr.tokenInput}, tokenOutput=${tr.tokenOutput}`);
    } else if (dsStep?.status === 'skip') {
      console.log(`  ${WARN} DeepSeek 被 skip: ${dsStep.detail || '原因未知'}`);
    } else if (dsStep?.status === 'fail') {
      console.log(`  ${FAIL} DeepSeek 调用失败: ${dsStep.detail || ''}`);
    } else {
      console.log(`  ${WARN} 未找到 DeepSeek 步骤`);
    }
  } else {
    console.log(`  ${FAIL} ${t1.error || t1.data?.error || '未知错误'}`);
    if (t1.data?.stack) console.log(`  ${INFO} stack: ${t1.data.stack.slice(0, 300)}`);
  }

  // 测试 2：用闲聊消息
  console.log(`\n--- 测试 2: 一条闲聊消息 ---`);
  const testMsg2 = '今天天气真好啊，外面下雨了吗';
  console.log(`  ${INFO} 测试消息: "${testMsg2}"`);
  const t2 = await callApi(ws, `window.api.diagnostic.testReply('${PINDUODUO_SHOP_ID}', '${testMsg2}')`, 120000);
  if (t2.ok && t2.data?.ok && t2.data?.result) {
    const tr = t2.data.result;
    console.log(`  ${INFO} reply: ${(tr.reply || '').slice(0, 200)}`);
    console.log(`  ${INFO} latencyMs: ${tr.latencyMs}, tokenInput: ${tr.tokenInput}, tokenOutput: ${tr.tokenOutput}`);
    if (tr.pipeline) {
      const dsStep = tr.pipeline.find(p => p.step.toLowerCase().includes('deepseek') || p.step.toLowerCase().includes('llm'));
      if (dsStep?.status === 'ok') {
        console.log(`  ${PASS} ✅ DeepSeek LLM 真实可用！`);
      } else {
        console.log(`  ${WARN} DeepSeek 状态: ${dsStep?.status || '未找到'}`);
      }
    }
  } else {
    console.log(`  ${FAIL} ${t2.error || t2.data?.error}`);
  }

  // 测试 3：先看 DeepSeek 熔断器状态
  console.log(`\n--- 测试 3: DeepSeek 熔断器当前状态 ---`);
  const t3 = await callApi(ws, `window.api.diagnostic.systemHealth()`);
  if (t3.ok && t3.data?.ok && t3.data?.health?.deepseek) {
    const ds = t3.data.health.deepseek;
    console.log(`  ${INFO} circuitState: ${ds.circuitState}`);
    console.log(`  ${INFO} apiKeyConfigured: ${ds.apiKeyConfigured}`);
    console.log(`  ${INFO} consecutiveFailures: ${ds.consecutiveFailures}`);
    console.log(`  ${INFO} circuitOpenedAt: ${ds.circuitOpenedAt}`);
  }

  ws.close();
  console.log('\n=== 测试完成 ===');
})().catch(err => {
  console.error('未捕获异常:', err);
  process.exit(1);
});
