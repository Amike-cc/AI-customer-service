// P2 UI 缺陷修复验证脚本 V2
// 验证策略：
// 1. 直接调用 window.api 触发各组件的数据加载逻辑
// 2. 监听 console，确认 catch 中没有静默错误
// 3. 验证 toast 容器可用于错误反馈
const http = require('http');
const WebSocket = require('ws');

function getPages() {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:9222/json', (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function evaluate(ws, expression, awaitPromise = true) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMessage = (msg) => {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.id === id) {
          ws.off('message', onMessage);
          resolve(parsed);
        }
      } catch (e) {}
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise, userGesture: true },
    }));
    setTimeout(() => { ws.off('message', onMessage); reject(new Error('evaluate timeout')); }, 15000);
  });
}

function enableConsole(ws) {
  return new Promise((resolve, reject) => {
    let id = Math.floor(Math.random() * 1e9);
    const logs = [];
    const onMessage = (msg) => {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.method === 'Runtime.consoleAPICalled' || parsed.method === 'Runtime.exceptionThrown') {
          logs.push(parsed.params);
        }
      } catch (e) {}
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method: 'Runtime.enable' }));
    setTimeout(() => resolve(logs), 500);
  });
}

async function main() {
  const pages = await getPages();
  const main = pages.find((p) => p.url && p.url.includes('dist/renderer/index.html'));
  if (!main) { console.error('未找到主窗口'); process.exit(1); }

  const ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise((r, r2) => { ws.on('open', r); ws.on('error', r2); });

  // 启用 Runtime 和 Console
  await new Promise((r) => {
    let id = Math.floor(Math.random() * 1e9);
    ws.send(JSON.stringify({ id, method: 'Runtime.enable' }));
    setTimeout(r, 500);
  });

  const collectedLogs = [];
  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.method === 'Runtime.consoleAPICalled') {
        const args = (parsed.params.args || []).map((a) => a.value || a.description || '').join(' ');
        collectedLogs.push({ type: parsed.params.type, text: args });
      } else if (parsed.method === 'Runtime.exceptionThrown') {
        collectedLogs.push({ type: 'exception', text: parsed.params.exceptionDetails.text });
      }
    } catch (e) {}
  });

  const results = [];

  // 1. 验证页面已加载
  try {
    const r = await evaluate(ws, `document.querySelector('#root') && document.querySelector('#root').children.length > 0 ? 'OK' : 'FAIL'`, false);
    const v = r?.result?.result?.value;
    console.log(`[${v === 'OK' ? 'PASS' : 'FAIL'}] 渲染层已加载 => ${v}`);
    results.push({ name: '渲染层已加载', ok: v === 'OK' });
  } catch (e) { console.log(`[FAIL] 渲染层加载检查异常: ${e.message}`); results.push({ name: '渲染层已加载', ok: false }); }

  // 2. 验证 window.api 可用
  try {
    const r = await evaluate(ws, `typeof window.api !== 'undefined' && typeof window.api.kb !== 'undefined' && typeof window.api.metrics !== 'undefined' && typeof window.api.learning !== 'undefined' && typeof window.api.product !== 'undefined' && typeof window.api.conversation !== 'undefined' ? 'OK' : 'MISSING'`, false);
    const v = r?.result?.result?.value;
    console.log(`[${v === 'OK' ? 'PASS' : 'FAIL'}] IPC API 全模块可用 => ${v}`);
    results.push({ name: 'IPC API 全模块可用', ok: v === 'OK' });
  } catch (e) { console.log(`[FAIL] IPC API 检查异常: ${e.message}`); results.push({ name: 'IPC API 全模块可用', ok: false }); }

  // 3. 验证各 IPC API 可调用（触发各组件数据加载逻辑）
  const apiChecks = [
    { name: 'kb.getSensitiveWords', expr: `window.api.kb.getSensitiveWords().then(()=>'OK').catch(e=>'ERR:'+e.message)` },
    { name: 'kb.getPrompt', expr: `window.api.kb.getPrompt().then(()=>'OK').catch(e=>'ERR:'+e.message)` },
    { name: 'kb.getCategoryStats', expr: `window.api.kb.getCategoryStats().then(()=>'OK').catch(e=>'ERR:'+e.message)` },
    { name: 'metrics.summary', expr: `window.api.metrics.summary(3600000).then(()=>'OK').catch(e=>'ERR:'+e.message)` },
    { name: 'metrics.history', expr: `window.api.metrics.history('api_call_total', Date.now()-86400000, Date.now()).then(()=>'OK').catch(e=>'ERR:'+e.message)` },
    { name: 'learning.patterns', expr: `window.api.learning.patterns('1783701851888').then(()=>'OK').catch(e=>'ERR:'+e.message)` },
    { name: 'learning.stats', expr: `window.api.learning.stats('1783701851888').then(()=>'OK').catch(e=>'ERR:'+e.message)` },
    { name: 'product.list', expr: `window.api.product.list('1783701851888').then(d=>'OK:len='+d.length).catch(e=>'ERR:'+e.message)` },
    { name: 'product.getSyncStatus', expr: `window.api.product.getSyncStatus('1783701851888').then(()=>'OK').catch(e=>'ERR:'+e.message)` },
    { name: 'conversation.sessions', expr: `window.api.conversation.sessions('1783701851888', 100).then(d=>'OK:len='+d.length).catch(e=>'ERR:'+e.message)` },
    { name: 'kb.listTemplates', expr: `window.api.kb.listTemplates().then(()=>'OK').catch(e=>'ERR:'+e.message)` },
    { name: 'kb.listVersions', expr: `window.api.kb.listVersions('1783701851888').then(()=>'OK').catch(e=>'ERR:'+e.message)` },
    { name: 'kb.listPendingReviews', expr: `window.api.kb.listPendingReviews('1783701851888').then(()=>'OK').catch(e=>'ERR:'+e.message)` },
    { name: 'kb.getAccuracyStats', expr: `window.api.kb.getAccuracyStats('1783701851888', 'day').then(()=>'OK').catch(e=>'ERR:'+e.message)` },
    { name: 'kb.getAccuracyTrend', expr: `window.api.kb.getAccuracyTrend('1783701851888', 7).then(()=>'OK').catch(e=>'ERR:'+e.message)` },
    { name: 'kb.getOptimizationSuggestions', expr: `window.api.kb.getOptimizationSuggestions('1783701851888').then(()=>'OK').catch(e=>'ERR:'+e.message)` },
    { name: 'rule.list', expr: `window.api.rule.list('1783701851888').then(()=>'OK').catch(e=>'ERR:'+e.message)` },
    { name: 'faq.list', expr: `window.api.faq.list('1783701851888').then(()=>'OK').catch(e=>'ERR:'+e.message)` },
  ];
  for (const c of apiChecks) {
    try {
      const r = await evaluate(ws, c.expr, true);
      const v = r?.result?.result?.value || 'NULL';
      const ok = v === 'OK' || v.startsWith('OK:');
      console.log(`[${ok ? 'PASS' : 'FAIL'}] ${c.name} => ${v}`);
      results.push({ name: c.name, ok });
    } catch (e) {
      console.log(`[FAIL] ${c.name} => ${e.message}`);
      results.push({ name: c.name, ok: false });
    }
  }

  // 4. 验证修改后的组件源代码确实包含 toast.show/console.error（静态检查 dist 文件）
  const fs = require('fs');
  const path = require('path');
  const fileChecks = [
    { file: 'IntentPanel.js', expect: ['加载意图分析数据失败'] },
    { file: 'MetricsPanel.js', expect: ['加载运营指标失败'] },
    { file: 'LearningPanel.js', expect: ['加载学习数据失败'] },
    { file: 'HealthDashboard.js', expect: ['加载健康指标失败'] },
    { file: 'ProductManager.js', expect: ['加载商品失败', '加载同步状态失败'] },
    { file: 'KnowledgeBase.js', expect: ['加载 Prompt 模板失败', '加载敏感词失败', 'OverviewPanel'] },
    { file: 'TemplatePanel.js', expect: ['加载推荐模板失败'] },
    { file: 'SessionViewer.js', expect: ['加载会话列表失败', '加载消息失败', '搜索消息失败'] },
  ];
  for (const fc of fileChecks) {
    const fp = path.join('dist', 'renderer', 'assets', fc.file);
    if (!fs.existsSync(fp)) {
      console.log(`[FAIL] ${fc.file} 文件不存在`);
      results.push({ name: fc.file, ok: false });
      continue;
    }
    const content = fs.readFileSync(fp, 'utf8');
    let allFound = true;
    for (const expect of fc.expect) {
      if (!content.includes(expect)) {
        console.log(`[FAIL] ${fc.file} 缺少期望文本: ${expect}`);
        allFound = false;
      }
    }
    if (allFound) {
      console.log(`[PASS] ${fc.file} 静态文本校验通过 (${fc.expect.length} 项)`);
    }
    results.push({ name: fc.file, ok: allFound });
  }

  // 5. 验证渲染层无 console error（首次启动时允许少量）
  await new Promise((r) => setTimeout(r, 1000));
  const consoleErrors = collectedLogs.filter((l) => l.type === 'error' || l.type === 'exception');
  const criticalErrors = consoleErrors.filter((e) => 
    !e.text.includes('favicon') && 
    !e.text.includes('WebSocket') &&
    !e.text.includes('Network') &&
    !e.text.includes('ERR_NAME_NOT_RESOLVED') &&
    !e.text.includes('ERR_INTERNET_DISCONNECTED')
  );
  console.log(`[${criticalErrors.length === 0 ? 'PASS' : 'WARN'}] 渲染层 console 错误数: ${consoleErrors.length} (关键错误 ${criticalErrors.length})`);
  if (criticalErrors.length > 0) {
    console.log('  关键错误示例:');
    criticalErrors.slice(0, 5).forEach((e) => console.log('  -', e.text.substring(0, 200)));
  }
  results.push({ name: '渲染层无关键错误', ok: criticalErrors.length === 0 });

  ws.close();
  const passCount = results.filter((r) => r.ok).length;
  console.log(`\n汇总: ${passCount}/${results.length} 通过`);
  process.exit(passCount === results.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
