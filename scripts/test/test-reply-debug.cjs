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
      reject(new Error('Timeout'));
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
  const targets = await httpGet('http://127.0.0.1:9222/json/list');
  const renderer = targets.find(t => t.title === '飞鸽AI客服' && t.type === 'page');
  const wsUrl = renderer.webSocketDebuggerUrl;

  console.log('=== 1. test.reply 参数格式测试 ===');
  // 测试不同的参数格式
  const formats = [
    { name: '对象形式', params: `{ message: '你好', shopId: '1783701851888', sessionId: 'test1' }` },
    { name: '字符串形式', params: `'你好'` },
    { name: '完整对象', params: `{ message: '你好', shopId: '1783701851888', sessionId: 'test2', platform: 'feige' }` },
    { name: 'storeReply风格', params: `{ message: '你好', shop_id: '1783701851888', session_id: 'test3' }` }
  ];

  for (const fmt of formats) {
    const result = await evaluate(wsUrl, `
      try {
        const r = await window.api.test.reply(${fmt.params});
        return JSON.stringify({ format: '${fmt.name}', ok: r?.ok, error: r?.error, reply: r?.reply ? r.reply.substring(0, 80) : null, keys: r ? Object.keys(r).slice(0, 8) : null });
      } catch (e) {
        return JSON.stringify({ format: '${fmt.name}', error: e.message });
      }
    `);
    console.log(`[${fmt.name}]`);
    console.log(result);
    console.log('');
  }

  console.log('=== 2. 检查 test.reply 方法定义 ===');
  const methodDef = await evaluate(wsUrl, `
    return JSON.stringify({
      type: typeof window.api.test.reply,
      length: window.api.test.reply.length,
      source: window.api.test.reply.toString().substring(0, 300)
    });
  `);
  console.log(methodDef);

  console.log('\n=== 3. 检查 diagnostic.testReply 方法 ===');
  const diagTest = await evaluate(wsUrl, `
    try {
      const r = await window.api.diagnostic.testReply({
        message: '你好',
        shopId: '1783701851888',
        sessionId: 'diag-test-1'
      });
      return JSON.stringify({ ok: r?.ok, error: r?.error, reply: r?.reply ? r.reply.substring(0, 100) : null, keys: r ? Object.keys(r).slice(0, 10) : null });
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  `);
  console.log(diagTest);

  console.log('\n=== 4. 检查 diagnostic.checkAutoReply 方法 ===');
  const autoReplyCheck = await evaluate(wsUrl, `
    try {
      const r = await window.api.diagnostic.checkAutoReply('1783701851888');
      return JSON.stringify(r, null, 2);
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  `);
  console.log(autoReplyCheck);

  console.log('\n=== 5. avgApiLatency=0 调查 ===');
  const latencyCheck = await evaluate(wsUrl, `
    const shops = await window.api.shop.list();
    // 查询不同时间范围
    const dayStats = await window.api.metrics.summary(shops[0].shopId);
    const weekStats = await window.api.metrics.history
      ? await window.api.metrics.history(shops[0].shopId, '7d')
      : null;
    return JSON.stringify({
      dayAvgLatency: dayStats.avgApiLatency,
      dayApiCalls: dayStats.apiCalls,
      hasHistoryMethod: typeof window.api.metrics.history === 'function',
      weekStats: weekStats
    }, null, 2);
  `).catch((e) => JSON.stringify({ error: e.message }));
  console.log(latencyCheck);

  console.log('\n=== 6. 检查 IPC handler test:reply 源代码 ===');
  // 直接通过 CDP 检查预加载的 IPC handler
  const ipcCheck = await evaluate(wsUrl, `
    return JSON.stringify({
      testReplyExists: typeof window.api.test.reply === 'function',
      ipcTestKeys: window.api.test ? Object.keys(window.api.test) : null,
      ipcDiagnosticKeys: window.api.diagnostic ? Object.keys(window.api.diagnostic) : null
    });
  `);
  console.log(ipcCheck);

  console.log('\n=== 7. 验证 AI 客服实际工作中（已登录店铺） ===');
  const workingShop = await evaluate(wsUrl, `
    const shops = await window.api.shop.list();
    const loggedIn = shops.find(s => s.loginStatus === 'logged_in');
    if (!loggedIn) return JSON.stringify({ error: 'no logged in shop' });

    // 查询该店铺最近的审计日志
    const logs = await window.api.audit.list(loggedIn.shopId, 5, 0);
    const arr = logs.logs || (Array.isArray(logs) ? logs : []);

    return JSON.stringify({
      shop: loggedIn.shopName,
      platform: loggedIn.platform,
      shopId: loggedIn.shopId,
      loginStatus: loggedIn.loginStatus,
      recentLogCount: arr.length,
      lastActivity: arr.length > 0 ? {
        userMessage: arr[0].userMessage,
        aiReply: (arr[0].aiReply || '').substring(0, 100),
        model: arr[0].modelVersion,
        latency: arr[0].latencyMs,
        confidence: arr[0].confidence,
        time: new Date(arr[0].createdAt).toLocaleString()
      } : null
    }, null, 2);
  `);
  console.log(workingShop);

  console.log('\n=== 8. 检查店铺业务配置 ===');
  const shopConfig = await evaluate(wsUrl, `
    const shops = await window.api.shop.list();
    // 尝试获取店铺业务配置
    try {
      const cfg = await window.api.shop.getBusinessConfig(shops[0].shopId);
      return JSON.stringify({ ok: true, keys: cfg ? Object.keys(cfg).slice(0, 15) : null, cfg: cfg }, null, 2);
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  `).catch((e) => JSON.stringify({ error: e.message }));
  console.log(shopConfig);

  console.log('\n=== 9. 检查 AI 自动回复切换 ===');
  const autoReplyStatus = await evaluate(wsUrl, `
    const shops = await window.api.shop.list();
    return JSON.stringify(shops.map(s => ({
      shopName: s.shopName,
      platform: s.platform,
      loginStatus: s.loginStatus,
      autoReply: s.autoReply,
      state: s.state
    })), null, 2);
  `);
  console.log(autoReplyStatus);

  console.log('\n=== 10. 检查店铺会话和未读消息 ===');
  const sessionCheck = await evaluate(wsUrl, `
    const shops = await window.api.shop.list();
    const loggedIn = shops.find(s => s.loginStatus === 'logged_in');
    if (!loggedIn) return JSON.stringify({ error: 'no logged in shop' });

    const sessions = await window.api.conversation.sessions(loggedIn.shopId, 20);
    const arr = sessions.sessions || (Array.isArray(sessions) ? sessions : []);
    return JSON.stringify({
      shop: loggedIn.shopName,
      sessionCount: arr.length,
      sessions: arr.slice(0, 5).map(s => ({
        sessionId: s.sessionId || s.id || s.buyerName,
        buyerName: s.buyerName,
        unread: s.unread || s.unreadCount,
        lastMessage: (s.lastMessage || '').substring(0, 50),
        updatedAt: s.updatedAt
      }))
    }, null, 2);
  `);
  console.log(sessionCheck);

  process.exit(0);
}

main().catch((e) => {
  console.log('Failed:', e.message);
  process.exit(1);
});
