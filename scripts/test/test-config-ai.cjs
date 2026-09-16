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

  console.log('=== 1. 全局配置完整性详细检查（27 个配置段） ===');
  const configDetail = await evaluate(wsUrl, `
    const cfg = await window.api.config.get();
    const sections = Object.keys(cfg || {});
    const detail = {};
    for (const sec of sections) {
      const v = cfg[sec];
      if (v && typeof v === 'object') {
        detail[sec] = {
          keys: Object.keys(v).slice(0, 8),
          keyCount: Object.keys(v).length,
          enabled: v.enabled !== undefined ? v.enabled : '(no enabled field)'
        };
      } else {
        detail[sec] = { value: String(v).substring(0, 50) };
      }
    }
    return JSON.stringify({ sectionCount: sections.length, sections: detail }, null, 2);
  `);
  console.log(configDetail);

  console.log('\n=== 2. 关键配置段值检查 ===');
  const keyConfig = await evaluate(wsUrl, `
    const cfg = await window.api.config.get();
    return JSON.stringify({
      deepseek: {
        model: cfg.deepseek?.model,
        apiKeyConfigured: !!cfg.deepseek?.apiKey,
        maxTokens: cfg.deepseek?.maxTokens,
        temperature: cfg.deepseek?.temperature,
        timeout: cfg.deepseek?.timeout
      },
      ratelimit: cfg.ratelimit,
      cache: cfg.cache,
      learning: { enabled: cfg.learning?.enabled },
      intent: { enabled: cfg.intent?.enabled },
      human_collab: { enabled: cfg.human_collab?.enabled },
      buyer: { enabled: cfg.buyer?.enabled },
      vision: { enabled: cfg.vision?.enabled },
      monitor: cfg.monitor,
      logging: { level: cfg.logging?.level }
    }, null, 2);
  `);
  console.log(keyConfig);

  console.log('\n=== 3. 测试配置 API Key 读取/写入接口（不实际修改） ===');
  const apiKeyTest = await evaluate(wsUrl, `
    const key = await window.api.config.getApiKey('deepseek');
    return JSON.stringify({
      hasMethod: typeof window.api.config.updateApiKey === 'function',
      currentKey: key ? key.substring(0, 8) + '***' + key.substring(key.length - 4) : null,
      keyLength: key ? key.length : 0,
      isTest: key ? key.includes('test') : false,
      // 不实际写入，只验证方法存在
      canUpdate: typeof window.api.config.updateApiKey === 'function'
    });
  `);
  console.log(apiKeyTest);

  console.log('\n=== 4. AI 大模型测试 - test.reply IPC ===');
  const aiTest = await evaluate(wsUrl, `
    try {
      const result = await window.api.test.reply({
        message: '你好，请问你们家的商品包邮吗？',
        shopId: '1783701851888',
        sessionId: 'test-session-' + Date.now()
      });
      return JSON.stringify({
        success: !!result,
        reply: result?.reply || result?.text || result?.message || JSON.stringify(result).substring(0, 200),
        source: result?.source || result?.modelVersion || 'unknown',
        latency: result?.latencyMs || result?.latency || 'unknown',
        tokensUsed: result?.tokensUsed || result?.tokenOutput || 'unknown',
        confidence: result?.confidence || 'unknown'
      });
    } catch (e) {
      return JSON.stringify({ error: e.message, stack: e.stack?.substring(0, 200) });
    }
  `);
  console.log(aiTest);

  console.log('\n=== 5. AI 测试 - 检查测试回复详细结果 ===');
  const aiTestDetail = await evaluate(wsUrl, `
    try {
      const result = await window.api.test.reply({
        message: '这个商品有现货吗？',
        shopId: '1783701851888',
        sessionId: 'test-detail-' + Date.now()
      });
      return JSON.stringify(result, null, 2);
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  `);
  console.log(aiTestDetail);

  console.log('\n=== 6. AI 客服审计日志（最近真实活动） ===');
  const auditDetail = await evaluate(wsUrl, `
    const shops = await window.api.shop.list();
    // 查询已登录的店铺的审计日志
    const loggedInShop = shops.find(s => s.loginStatus === 'logged_in') || shops[0];
    const logs = await window.api.audit.list(loggedInShop.shopId, 20, 0);
    const arr = logs.logs || (Array.isArray(logs) ? logs : []);
    return JSON.stringify({
      shop: loggedInShop.shopName,
      shopId: loggedInShop.shopId,
      totalLogs: arr.length,
      recentLogs: arr.slice(0, 10).map(l => ({
        userMessage: l.userMessage,
        aiReply: (l.aiReply || '').substring(0, 80),
        model: l.modelVersion,
        latency: l.latencyMs,
        confidence: l.confidence,
        time: new Date(l.createdAt).toLocaleString()
      }))
    }, null, 2);
  `);
  console.log(auditDetail);

  console.log('\n=== 7. AI 客服消息处理统计 ===');
  const msgStats = await evaluate(wsUrl, `
    const shops = await window.api.shop.list();
    const stats = await window.api.metrics.summary(shops[0].shopId);
    return JSON.stringify({
      apiCalls: stats.apiCalls,
      tokensInput: stats.tokensInput,
      tokensOutput: stats.tokensOutput,
      messagesReceived: stats.messagesReceived,
      repliesSent: stats.repliesSent,
      replyFailed: stats.replyFailed,
      rateLimitRejected: stats.rateLimitRejected,
      sensitiveBlocked: stats.sensitiveBlocked,
      stateTransitions: stats.stateTransitions,
      avgApiLatency: stats.avgApiLatency,
      failureRate: stats.repliesSent > 0 ? (stats.replyFailed / stats.repliesSent * 100).toFixed(2) + '%' : 'N/A'
    }, null, 2);
  `);
  console.log(msgStats);

  console.log('\n=== 8. 意图分类统计 ===');
  const intentStats = await evaluate(wsUrl, `
    const stats = await window.api.intent.stats('1783701851888', 'day');
    return JSON.stringify(stats, null, 2);
  `).catch((e) => JSON.stringify({ error: e.message }));
  console.log(intentStats);

  console.log('\n=== 9. 意图分类最近记录 ===');
  const intentRecent = await evaluate(wsUrl, `
    const recent = await window.api.intent.recent('1783701851888', 10);
    const arr = recent.records || recent.items || (Array.isArray(recent) ? recent : []);
    return JSON.stringify({
      count: arr.length,
      records: arr.slice(0, 5).map(r => ({
        message: r.userMessage || r.message || r.text,
        intent: r.intent || r.category,
        confidence: r.confidence,
        complexity: r.complexity,
        escalated: r.escalated
      }))
    }, null, 2);
  `).catch((e) => JSON.stringify({ error: e.message }));
  console.log(intentRecent);

  console.log('\n=== 10. 学习系统统计 ===');
  const learningStats = await evaluate(wsUrl, `
    const stats = await window.api.learning.stats();
    return JSON.stringify(stats, null, 2);
  `).catch((e) => JSON.stringify({ error: e.message }));
  console.log(learningStats);

  console.log('\n=== 11. 人工坐席队列 ===');
  const agentQueue = await evaluate(wsUrl, `
    const queue = await window.api.agent.queue();
    return JSON.stringify(queue, null, 2);
  `).catch((e) => JSON.stringify({ error: e.message }));
  console.log(agentQueue);

  console.log('\n=== 12. 数据库备份功能 ===');
  const backupTest = await evaluate(wsUrl, `
    return JSON.stringify({
      hasMethod: typeof window.api.db.backup === 'function',
      // 不实际执行备份，只验证方法存在
      methodExists: typeof window.api.db.backup === 'function'
    });
  `);
  console.log(backupTest);

  console.log('\n=== 13. 反馈统计 ===');
  const feedbackStats = await evaluate(wsUrl, `
    const shops = await window.api.shop.list();
    const stats = await window.api.feedback.stats(shops[0].shopId);
    return JSON.stringify(stats, null, 2);
  `).catch((e) => JSON.stringify({ error: e.message }));
  console.log(feedbackStats);

  console.log('\n=== 15. 会话列表 ===');
  const sessions = await evaluate(wsUrl, `
    const shops = await window.api.shop.list();
    const s = await window.api.conversation.sessions(shops[0].shopId, 10);
    const arr = s.sessions || (Array.isArray(s) ? s : []);
    return JSON.stringify({
      count: arr.length,
      sessions: arr.slice(0, 5).map(s => ({
        sessionId: s.sessionId || s.id,
        buyerName: s.buyerName,
        lastMessage: (s.lastMessage || '').substring(0, 50),
        unread: s.unread,
        updatedAt: s.updatedAt ? new Date(s.updatedAt).toLocaleString() : null
      }))
    }, null, 2);
  `).catch((e) => JSON.stringify({ error: e.message }));
  console.log(sessions);

  process.exit(0);
}

main().catch((e) => {
  console.log('Failed:', e.message);
  process.exit(1);
});
