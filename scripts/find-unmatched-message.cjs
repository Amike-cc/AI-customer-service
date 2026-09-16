// scripts/find-unmatched-message.cjs
//
// 找出一条不会命中任何规则的消息，用于测试 DeepSeek LLM 真实可用性
//
// 使用：node scripts/find-unmatched-message.cjs

const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9222;
const PINDUODUO_SHOP_ID = '1783794688704';

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

async function callApi(ws, code, timeoutMs = 30000) {
  const expr = `(async () => {
    try {
      const data = await (${code});
      return JSON.stringify({ ok: true, data });
    } catch (e) {
      return JSON.stringify({ ok: false, error: e.message });
    }
  })()`;
  const res = await evaluate(ws, expr, timeoutMs);
  const value = res?.result?.result?.value;
  if (!value) return { ok: false, error: 'CDP 返回空' };
  try { return JSON.parse(value); } catch { return { ok: false, error: 'JSON 解析失败', raw: value }; }
}

(async () => {
  console.log('=== 寻找未命中规则的消息 ===\n');

  const pages = await getPages();
  const main = pages.find(p => p.url && p.url.includes('dist/renderer/index.html'));
  if (!main) { console.error('未找到主渲染页面'); process.exit(1); }
  const ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));

  // 1. 列出所有规则 patterns
  console.log('--- 步骤 1：列出所有规则 ---');
  const r1 = await callApi(ws, `window.api.rule.list('${PINDUODUO_SHOP_ID}')`);
  if (!r1.ok) { console.error('获取规则失败:', r1.error); process.exit(1); }
  const rules = r1.data || [];
  console.log(`规则总数: ${rules.length}\n`);
  console.log('规则 patterns:');
  rules.forEach((r, i) => {
    console.log(`  [${i}] ${r.name}: /${r.pattern?.slice(0, 80) || ''}/${r.enabled ? '' : ' (disabled)'}`);
  });

  // 2. 候选测试消息（设计为不命中任何规则）
  const candidates = [
    '请问你们公司全名叫什么？统一社会信用代码是多少？',
    '请问你们法定代表人的姓名是什么？',
    '请告诉我你们公司的开户行和银行账号',
    'asdfghjkl qwertyuiop zxcvbnm',
    '今天天气真好啊，外面下雨了吗',
    '1+1等于几',
    '请背诵一下圆周率前 100 位',
  ];

  console.log(`\n--- 步骤 2：测试 ${candidates.length} 条候选消息 ---`);
  const unmatched = [];
  for (const msg of candidates) {
    const r = await callApi(ws, `window.api.rule.test('${PINDUODUO_SHOP_ID}', '${msg.replace(/'/g, "\\'")}')`);
    if (r.ok && r.data) {
      const matched = r.data.matched;
      const icon = matched ? '❌ 命中' : '✅ 未命中';
      console.log(`  ${icon} | "${msg.slice(0, 50)}" → ${matched ? `规则=${r.data.ruleName}` : '无'}`);
      if (!matched) unmatched.push(msg);
    } else {
      console.log(`  ⚠️ 测试失败: ${r.error}`);
    }
  }

  // 3. 选出第一条未命中的消息
  if (unmatched.length === 0) {
    console.log('\n❌ 所有候选消息都命中了规则，规则覆盖范围太广');
    console.log('建议：检查规则配置，确认是否所有规则都合理');
  } else {
    console.log(`\n✅ 找到 ${unmatched.length} 条未命中消息`);
    console.log(`推荐使用第一条测试 DeepSeek:`);
    console.log(`  "${unmatched[0]}"`);
  }

  ws.close();
  console.log('\n=== 完成 ===');
})().catch(err => {
  console.error('未捕获异常:', err);
  process.exit(1);
});
