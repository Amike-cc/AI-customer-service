// 全面运行时验证 v2：通过 CDP 9222 调用所有 IPC API
const WebSocket = require('ws');
const http = require('http');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function evaluate(wsUrl, expression, id = 1) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      try { ws.close(); } catch (e) {}
      reject(new Error('Timeout after 30s'));
    }, 30000);
    ws.on('open', () => {
      // 将表达式包装为 IIFE 以确保返回值
      const wrapped = `(async () => { ${expression} })()`;
      ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression: wrapped, awaitPromise: true, returnByValue: true }
      }));
    });
    ws.on('message', (data) => {
      try {
        const r = JSON.parse(data.toString());
        if (r.id === id) {
          clearTimeout(timeout);
          try { ws.close(); } catch (e) {}
          if (r.result && r.result.result) {
            const val = r.result.result.value;
            if (r.result.result.subtype === 'error' || r.result.exceptionDetails) {
              reject(new Error(r.result.exceptionDetails?.exception?.description || r.result.result.description || 'JS error'));
            } else {
              resolve(val);
            }
          } else {
            resolve(undefined);
          }
        }
      } catch (e) {
        reject(e);
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });
}

async function main() {
  console.log('=== 1. 获取渲染页面 ===');
  let targets;
  try {
    targets = await httpGet('http://127.0.0.1:9222/json/list');
  } catch (e) {
    console.log('❌ 获取目标列表失败:', e.message);
    process.exit(1);
  }
  const renderer = targets.find(t => t.title === '飞鸽AI客服' && t.type === 'page');
  if (!renderer) {
    console.log('❌ 未找到飞鸽AI客服渲染页面');
    console.log('可用页面:', targets.filter(t => t.type === 'page').map(t => `${t.title}`).join(', '));
    process.exit(1);
  }
  console.log(`✅ 渲染页面: ${renderer.title} (${renderer.url})`);
  const wsUrl = renderer.webSocketDebuggerUrl;
  if (!wsUrl) { console.log('❌ 无 webSocketDebuggerUrl'); process.exit(1); }

  console.log('\n=== 2. IPC API 命名空间可用性 ===');
  const apiCheck = await evaluate(wsUrl, `
    const namespaces = ['app', 'shop', 'config', 'log', 'alert', 'conversation', 'audit',
      'metrics', 'diagnose', 'diagnostic', 'db', 'rule', 'faq', 'product', 'test', 'kb',
      'feedback', 'learning', 'intent', 'escalation', 'conversion', 'analytics', 'agent',
      'view', 'modal', 'outreach', 'buyer'];
    const apis = {};
    for (const ns of namespaces) {
      apis[ns] = !!(window.api && window.api[ns]);
    }
    return JSON.stringify(apis);
  `);
  let apiResult;
  try { apiResult = JSON.parse(apiCheck); } catch (e) { console.log('❌ API check 解析失败:', e.message, 'raw:', apiCheck); apiResult = {}; }
  const apiOk = Object.entries(apiResult).filter(([_, v]) => v).length;
  const apiFail = Object.entries(apiResult).filter(([_, v]) => !v);
  console.log(`✅ 可用命名空间: ${apiOk}/${Object.keys(apiResult).length}`);
  if (apiFail.length > 0) {
    console.log(`❌ 缺失: ${apiFail.map(([k]) => k).join(', ')}`);
  }

  console.log('\n=== 3. 店铺列表 ===');
  const shopsResult = await evaluate(wsUrl, `
    const list = await window.api.shop.list();
    return JSON.stringify(list);
  `);
  let shops;
  try { shops = JSON.parse(shopsResult); } catch (e) { console.log('❌ 店铺列表解析失败:', e.message); shops = []; }
  console.log(`✅ 店铺数量: ${shops.length}`);
  for (const s of shops) {
    console.log(`   - ${s.shopName} (${s.platform}, shopId=${s.shopId}, loginStatus=${s.loginStatus || 'unknown'})`);
  }

  console.log('\n=== 4. 全局配置完整性 ===');
  const configResult = await evaluate(wsUrl, `
    const cfg = await window.api.config.getAll();
    const sections = Object.keys(cfg || {});
    return JSON.stringify({ sections, sectionCount: sections.length });
  `);
  let cfg;
  try { cfg = JSON.parse(configResult); } catch (e) { console.log('❌ 配置解析失败:', e.message); cfg = { sections: [] }; }
  console.log(`✅ 配置段数量: ${cfg.sectionCount}/${27}`);
  console.log(`   配置段: ${cfg.sections.join(', ')}`);

  console.log('\n=== 5. DeepSeek API Key ===');
  const keyResult = await evaluate(wsUrl, `
    const key = await window.api.config.getLlmApiKey('deepseek');
    return JSON.stringify({ key: key.masked || null, configured: key.configured });
  `);
  let keyInfo;
  try { keyInfo = JSON.parse(keyResult); } catch (e) { console.log('❌ API Key 解析失败:', e.message); keyInfo = {}; }
  console.log(`✅ API Key: ${keyInfo.key || '(未配置)'} (configured=${keyInfo.configured})`);

  console.log('\n=== 6. 买家档案统计 ===');
  if (shops.length > 0) {
    const buyerResult = await evaluate(wsUrl, `
      const stats = await window.api.buyer.stats(${JSON.stringify(shops[0].shopId)}, 'feige');
      return JSON.stringify(stats);
    `);
    let buyerStats;
    try { buyerStats = JSON.parse(buyerResult); } catch (e) { console.log('❌ 买家统计解析失败:', e.message); buyerStats = {}; }
    console.log(`✅ 买家总数: ${buyerStats.total || 0}, 咨询次数: ${buyerStats.totalConsultations || 0}`);
    if (buyerStats.byVip) {
      console.log(`   VIP 分布: 钻石=${buyerStats.byVip[3] || 0}, 黄金=${buyerStats.byVip[2] || 0}, 白银=${buyerStats.byVip[1] || 0}, 普通=${buyerStats.byVip[0] || 0}`);
    }
  }

  console.log('\n=== 8. 模板分类统计 ===');
  const tmplResult = await evaluate(wsUrl, `
    const stats = await window.api.kb.getCategoryStats(undefined);
    return JSON.stringify(stats);
  `);
  let tmplStats;
  try { tmplStats = JSON.parse(tmplResult); } catch (e) { console.log('❌ 模板统计解析失败:', e.message); tmplStats = []; }
  if (Array.isArray(tmplStats)) {
    console.log(`✅ 模板分类数: ${tmplStats.length}`);
    for (const c of tmplStats) {
      console.log(`   - ${c.category}: ${c.total} 个`);
    }
  }

  console.log('\n=== 9. 规则引擎 ===');
  const ruleResult = await evaluate(wsUrl, `
    const rules = await window.api.rule.list(undefined);
    return JSON.stringify({ count: rules.length, sources: rules.reduce((acc, r) => { acc[r.source] = (acc[r.source] || 0) + 1; return acc; }, {}) });
  `);
  let ruleInfo;
  try { ruleInfo = JSON.parse(ruleResult); } catch (e) { console.log('❌ 规则解析失败:', e.message); ruleInfo = {}; }
  console.log(`✅ 规则总数: ${ruleInfo.count || 0}, 来源分布: ${JSON.stringify(ruleInfo.sources || {})}`);

  console.log('\n=== 10. 店铺FAQ ===');
  if (shops.length > 0) {
    const faqResult = await evaluate(wsUrl, `
      const faqs = await window.api.faq.list(${JSON.stringify(shops[0].shopId)});
      return JSON.stringify({ count: faqs.length, sample: faqs.slice(0, 2).map(f => ({ q: f.question, a: f.answer.substring(0, 50) })) });
    `);
    let faqInfo;
    try { faqInfo = JSON.parse(faqResult); } catch (e) { console.log('❌ FAQ 解析失败:', e.message); faqInfo = {}; }
    console.log(`✅ FAQ 数量: ${faqInfo.count || 0}`);
    if (faqInfo.sample) {
      for (const f of faqInfo.sample) {
        console.log(`   Q: ${f.q}`);
        console.log(`   A: ${f.a}...`);
      }
    }
  }

  console.log('\n=== 11. 商品数据 ===');
  if (shops.length > 0) {
    const prodResult = await evaluate(wsUrl, `
      const products = await window.api.product.list(${JSON.stringify(shops[0].shopId)});
      return JSON.stringify({ count: products.length, sample: products.slice(0, 3).map(p => ({ id: p.productId, name: p.name, price: p.price, stock: p.stock })) });
    `);
    let prodInfo;
    try { prodInfo = JSON.parse(prodResult); } catch (e) { console.log('❌ 商品解析失败:', e.message); prodInfo = {}; }
    console.log(`✅ 商品数量: ${prodInfo.count || 0}`);
    if (prodInfo.sample) {
      for (const p of prodInfo.sample) {
        console.log(`   - ${p.name} (ID=${p.id}, price=${p.price}, stock=${p.stock})`);
      }
    }
  }

  console.log('\n=== 12. 审计日志（最近10条） ===');
  if (shops.length > 0) {
    const auditResult = await evaluate(wsUrl, `
      try {
        const logs = await window.api.audit.list(${JSON.stringify(shops[0].shopId)}, 10, 0);
        return JSON.stringify({ count: logs.length || (logs.logs ? logs.logs.length : 0), sample: (logs.logs || logs).slice(0, 3).map(l => ({ event: l.eventType || l.event, timestamp: l.timestamp, success: l.success })) });
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    `);
    let auditInfo;
    try { auditInfo = JSON.parse(auditResult); } catch (e) { console.log('❌ 审计日志解析失败:', e.message); auditInfo = {}; }
    console.log(`✅ 审计日志: ${auditInfo.count || 0} 条`);
    if (auditInfo.error) { console.log(`   ⚠️ 错误: ${auditInfo.error}`); }
    if (auditInfo.sample) {
      for (const l of auditInfo.sample) {
        console.log(`   - ${l.event} @ ${new Date(l.timestamp).toLocaleString()} success=${l.success}`);
      }
    }
  }

  console.log('\n=== 13. 系统健康指标 ===');
  const healthResult = await evaluate(wsUrl, `
    const health = await window.api.diagnostic.getHealth();
    return JSON.stringify(health);
  `);
  let health;
  try { health = JSON.parse(healthResult); } catch (e) { console.log('❌ 健康指标解析失败:', e.message); health = {}; }
  console.log(`✅ 健康状态: ${JSON.stringify({ status: health.status, uptime: health.uptime, deepSeekCircuit: health.deepSeekCircuit || health.circuits?.deepseek, shopsHealthy: health.shops ? health.shops.filter(s => s.status === 'healthy').length : 0 })}`);

  console.log('\n=== 14. 转接事件订阅 ===');
  const transferResult = await evaluate(wsUrl, `
    return JSON.stringify({ hasMethod: typeof window.api.onTransferEvent === 'function' || !!(window.api.shop && window.api.shop.onTransferEvent) });
  `);
  let transferInfo;
  try { transferInfo = JSON.parse(transferResult); } catch (e) { transferInfo = {}; }
  console.log(`✅ 转接事件订阅方法: ${transferInfo.hasMethod ? '可用' : '不可用'}`);

  console.log('\n=== 15. 数据库表结构 ===');
  // 通过 Python sqlite3 检查数据库表
  const { execSync } = require('child_process');
  try {
    const tablesOutput = execSync('python -c "import sqlite3; conn=sqlite3.connect(r\'D:\\\\code\\\\AIkefu\\\\data\\\\app.db\'); cur=conn.cursor(); cur.execute(\'SELECT name FROM sqlite_master WHERE type=\\\"table\\\" ORDER BY name\'); print(\'\\n\'.join([r[0] for r in cur.fetchall()])); conn.close()"', { encoding: 'utf8' });
    const tables = tablesOutput.trim().split('\n');
    console.log(`✅ 数据库表数: ${tables.length}`);
    for (const t of tables) {
      console.log(`   - ${t}`);
    }
  } catch (e) {
    console.log('❌ 数据库检查失败:', e.message);
  }

  console.log('\n=== 测试完成 ===');
  process.exit(0);
}

main().catch((e) => {
  console.log('测试失败:', e.message);
  console.log(e.stack);
  process.exit(1);
});
