// 全面运行时验证 v3：使用实际存在的 IPC 方法
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
            if (r.result.exceptionDetails) {
              reject(new Error(r.result.exceptionDetails?.exception?.description || 'JS error'));
            } else {
              resolve(r.result.result.value);
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
  const targets = await httpGet('http://127.0.0.1:9222/json/list');
  const renderer = targets.find(t => t.title === '飞鸽AI客服' && t.type === 'page');
  if (!renderer) { console.log('❌ 未找到渲染页面'); process.exit(1); }
  console.log(`✅ 渲染页面: ${renderer.title}`);
  const wsUrl = renderer.webSocketDebuggerUrl;

  console.log('\n=== 2. IPC API 命名空间可用性 + 各命名空间方法 ===');
  const methodList = await evaluate(wsUrl, `
    const namespaces = ['app', 'shop', 'config', 'log', 'alert', 'conversation', 'audit',
      'metrics', 'diagnose', 'diagnostic', 'db', 'rule', 'faq', 'product', 'test', 'kb',
      'feedback', 'learning', 'intent', 'escalation', 'agent',
      'view', 'buyer'];
    const result = {};
    for (const ns of namespaces) {
      const obj = window.api && window.api[ns];
      if (obj) {
        const methods = [];
        for (const k in obj) {
          if (typeof obj[k] === 'function') methods.push(k);
        }
        result[ns] = methods;
      } else {
        result[ns] = null;
      }
    }
    return JSON.stringify(result);
  `);
  let methods;
  try { methods = JSON.parse(methodList); } catch (e) { console.log('❌ 解析失败:', e.message); methods = {}; }
  let totalMethods = 0;
  for (const [ns, ms] of Object.entries(methods)) {
    if (ms) {
      totalMethods += ms.length;
      console.log(`   ✅ ${ns}: ${ms.length} 方法 (${ms.slice(0, 8).join(', ')}${ms.length > 8 ? '...' : ''})`);
    } else {
      console.log(`   ❌ ${ns}: 不存在`);
    }
  }
  console.log(`✅ 总命名空间: ${Object.keys(methods).length}, 总方法数: ${totalMethods}`);

  console.log('\n=== 3. 店铺列表 ===');
  const shopsResult = await evaluate(wsUrl, `
    const list = await window.api.shop.list();
    return JSON.stringify(list);
  `);
  let shops;
  try { shops = JSON.parse(shopsResult); } catch (e) { shops = []; }
  console.log(`✅ 店铺数量: ${shops.length}`);
  for (const s of shops) {
    console.log(`   - ${s.shopName} (${s.platform}, shopId=${s.shopId}, loginStatus=${s.loginStatus || 'unknown'})`);
  }

  console.log('\n=== 4. 全局配置完整性（使用 config.get） ===');
  const configResult = await evaluate(wsUrl, `
    const cfg = await window.api.config.get();
    const sections = Object.keys(cfg || {});
    return JSON.stringify({ sections, sectionCount: sections.length });
  `).catch((e) => {
    return JSON.stringify({ error: e.message });
  });
  let cfg;
  try { cfg = JSON.parse(configResult); } catch (e) { cfg = { error: e.message }; }
  if (cfg.error) {
    console.log(`❌ config.get 失败: ${cfg.error}`);
  } else {
    console.log(`✅ 配置段数量: ${cfg.sectionCount}`);
    console.log(`   配置段: ${cfg.sections.join(', ')}`);
  }

  console.log('\n=== 5. DeepSeek API Key ===');
  const keyResult = await evaluate(wsUrl, `
    const key = await window.api.config.getApiKey('deepseek');
    return JSON.stringify({ key: key ? key.substring(0, 8) + '***' + key.substring(key.length - 4) : null, isTest: key ? key.includes('test') : false, length: key ? key.length : 0 });
  `).catch((e) => JSON.stringify({ error: e.message }));
  let keyInfo;
  try { keyInfo = JSON.parse(keyResult); } catch (e) { keyInfo = { error: e.message }; }
  console.log(`✅ API Key: ${keyInfo.key || '(未配置)'} (length=${keyInfo.length}, isTest=${keyInfo.isTest})`);

  console.log('\n=== 6. 买家档案统计 ===');
  if (shops.length > 0) {
    const buyerResult = await evaluate(wsUrl, `
      const result = await window.api.buyer.stats(${JSON.stringify(shops[0].shopId)}, 'feige');
      if (!result.ok) throw new Error(result.error || '买家统计失败');
      return JSON.stringify(result.stats || {});
    `).catch((e) => JSON.stringify({ error: e.message }));
    let buyerStats;
    try { buyerStats = JSON.parse(buyerResult); } catch (e) { buyerStats = { error: e.message }; }
    if (buyerStats.error) {
      console.log(`❌ 买家统计失败: ${buyerStats.error}`);
    } else {
      console.log(`✅ 买家总数: ${buyerStats.total || 0}, 咨询次数: ${buyerStats.totalConsultations || 0}`);
      if (buyerStats.byVip) {
        console.log(`   VIP 分布: 钻石=${buyerStats.byVip[3] || 0}, 黄金=${buyerStats.byVip[2] || 0}, 白银=${buyerStats.byVip[1] || 0}, 普通=${buyerStats.byVip[0] || 0}`);
      }
    }
  }

  console.log('\n=== 8. 模板分类统计 ===');
  const tmplResult = await evaluate(wsUrl, `
    const stats = await window.api.kb.getCategoryStats(undefined);
    return JSON.stringify(stats);
  `).catch((e) => JSON.stringify({ error: e.message }));
  let tmplStats;
  try { tmplStats = JSON.parse(tmplResult); } catch (e) { tmplStats = []; }
  if (Array.isArray(tmplStats)) {
    console.log(`✅ 模板分类数: ${tmplStats.length}`);
    let totalTmpl = 0;
    for (const c of tmplStats) {
      console.log(`   - ${c.category}: ${c.total} 个`);
      totalTmpl += c.total;
    }
    console.log(`   模板总数: ${totalTmpl}`);
  }

  console.log('\n=== 9. 规则引擎 ===');
  const ruleResult = await evaluate(wsUrl, `
    const rules = await window.api.rule.list(undefined);
    return JSON.stringify({ count: rules.length, sources: rules.reduce((acc, r) => { acc[r.source] = (acc[r.source] || 0) + 1; return acc; }, {}) });
  `).catch((e) => JSON.stringify({ error: e.message }));
  let ruleInfo;
  try { ruleInfo = JSON.parse(ruleResult); } catch (e) { ruleInfo = { error: e.message }; }
  console.log(`✅ 规则总数: ${ruleInfo.count || 0}, 来源分布: ${JSON.stringify(ruleInfo.sources || {})}`);

  console.log('\n=== 10. 店铺FAQ ===');
  if (shops.length > 0) {
    const faqResult = await evaluate(wsUrl, `
      const faqs = await window.api.faq.list(${JSON.stringify(shops[0].shopId)});
      return JSON.stringify({ count: faqs.length, sample: faqs.slice(0, 2).map(f => ({ q: f.question, a: f.answer.substring(0, 50) })) });
    `).catch((e) => JSON.stringify({ error: e.message }));
    let faqInfo;
    try { faqInfo = JSON.parse(faqResult); } catch (e) { faqInfo = { error: e.message }; }
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
      return JSON.stringify({ count: products.length, sample: products.slice(0, 3).map(p => ({
        id: p.product_id,
        name: p.name,
        price: p.variants?.[0]?.price ?? null,
        stock: p.variants?.reduce((total, variant) => total + (variant.stock || 0), 0) ?? null
      })) });
    `).catch((e) => JSON.stringify({ error: e.message }));
    let prodInfo;
    try { prodInfo = JSON.parse(prodResult); } catch (e) { prodInfo = { error: e.message }; }
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
        const arr = await window.api.audit.list(${JSON.stringify(shops[0].shopId)}, 10);
        return JSON.stringify({ count: arr.length, sample: arr.slice(0, 3).map(l => ({ model: l.modelVersion, timestamp: l.createdAt, confidence: l.confidence })) });
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    `).catch((e) => JSON.stringify({ error: e.message }));
    let auditInfo;
    try { auditInfo = JSON.parse(auditResult); } catch (e) { auditInfo = { error: e.message }; }
    console.log(`✅ 审计日志: ${auditInfo.count || 0} 条`);
    if (auditInfo.error) { console.log(`   ⚠️ 错误: ${auditInfo.error}`); }
    if (auditInfo.sample) {
      for (const l of auditInfo.sample) {
        console.log(`   - ${l.model} @ ${l.timestamp ? new Date(l.timestamp).toLocaleString() : '?'} confidence=${l.confidence}`);
      }
    }
  }

  console.log('\n=== 13. 系统健康指标 ===');
  const healthResult = await evaluate(wsUrl, `
    const result = await window.api.diagnostic.systemHealth();
    if (!result.ok) throw new Error(result.error || '系统健康检查失败');
    return JSON.stringify(result.health);
  `).catch((e) => JSON.stringify({ error: e.message }));
  let health;
  try { health = JSON.parse(healthResult); } catch (e) { health = { error: e.message }; }
  if (health.error) {
    console.log(`❌ 健康指标失败: ${health.error}`);
  } else {
    console.log(`✅ uptime=${health.uptime.toFixed(1)}s, database=${health.database.walMode}`);
    if (health.deepseek) {
      console.log(`   DeepSeek 熔断器: ${health.deepseek.circuitState}, API Key=${health.deepseek.apiKeyConfigured ? '已配置' : '未配置'}`);
    }
    if (health.shops) {
      console.log(`   店铺已登录: ${health.shops.filter(s => s.loginStatus === 'logged_in').length}/${health.shops.length}`);
      for (const s of health.shops) {
        console.log(`     - ${s.shopName || s.shopId}: state=${s.state}, login=${s.loginStatus}`);
      }
    }
  }

  console.log('\n=== 14. 数据库表结构 ===');
  try {
    const dbPath = require('path').join(process.cwd(), 'data', 'app.db');
    const { spawnSync } = require('child_process');
    const python = [
      'import sqlite3, sys',
      'conn = sqlite3.connect(sys.argv[1])',
      'rows = conn.execute("SELECT name FROM sqlite_master WHERE type = \'table\' ORDER BY name").fetchall()',
      'print("\\n".join(row[0] for row in rows))',
      'conn.close()',
    ].join('; ');
    const result = spawnSync('python', ['-c', python, dbPath], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr.trim() || `Python 退出码 ${result.status}`);
    const tables = result.stdout.trim().split('\n').filter(Boolean);
    console.log(`✅ 数据库表数: ${tables.length}`);
    for (const t of tables) {
      console.log(`   - ${t}`);
    }
  } catch (e) {
    console.log('❌ 数据库检查失败:', e.message);
  }

  console.log('\n=== 15. 转接事件订阅 ===');
  const transferResult = await evaluate(wsUrl, `
    const hasMethod = typeof window.api.onTransferEvent === 'function' || !!(window.api.shop && window.api.shop.onTransferEvent);
    return JSON.stringify({ hasMethod });
  `).catch((e) => JSON.stringify({ error: e.message }));
  let transferInfo;
  try { transferInfo = JSON.parse(transferResult); } catch (e) { transferInfo = { error: e.message }; }
  console.log(`✅ 转接事件订阅: ${transferInfo.hasMethod ? '可用' : '不可用'}`);

  console.log('\n=== 测试完成 ===');
  process.exit(0);
}

main().catch((e) => {
  console.log('测试失败:', e.message);
  console.log(e.stack);
  process.exit(1);
});
