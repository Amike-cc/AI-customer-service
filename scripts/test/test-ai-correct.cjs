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
    }, 60000);
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

  console.log('=== 1. test.reply 正确调用（两个字符串参数） ===');
  const test1 = await evaluate(wsUrl, `
    try {
      const r = await window.api.test.reply('1783701851888', '你好，请问你们家的商品包邮吗？');
      return JSON.stringify(r, null, 2);
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  `);
  console.log(test1);

  console.log('\n=== 2. diagnostic.testReply 正确调用 ===');
  const test2 = await evaluate(wsUrl, `
    try {
      const r = await window.api.diagnostic.testReply('1783701851888', '这个商品有现货吗？');
      return JSON.stringify(r, null, 2);
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  `);
  console.log(test2);

  console.log('\n=== 3. 测试不同类型消息 ===');
  const messages = [
    '你好',
    '这个多少钱',
    '怎么退货',
    '发什么快递',
    '转人工'
  ];

  for (const msg of messages) {
    const result = await evaluate(wsUrl, `
      try {
        const r = await window.api.test.reply('1783701851888', ${JSON.stringify(msg)});
        return JSON.stringify({
          message: ${JSON.stringify(msg)},
          ok: r?.ok,
          reply: r?.reply ? (typeof r.reply === 'string' ? r.reply.substring(0, 100) : JSON.stringify(r.reply).substring(0, 100)) : null,
          source: r?.source || r?.modelVersion || r?.matchedRule,
          latency: r?.latencyMs,
          confidence: r?.confidence
        });
      } catch (e) {
        return JSON.stringify({ message: ${JSON.stringify(msg)}, error: e.message });
      }
    `);
    console.log(result);
  }

  console.log('\n=== 4. 验证 DeepSeek 实际调用（通过最近审计日志） ===');
  const aiCheck = await evaluate(wsUrl, `
    const shops = await window.api.shop.list();
    const logs = await window.api.audit.list(shops[0].shopId, 30, 0);
    const arr = logs.logs || (Array.isArray(logs) ? logs : []);

    // 找出使用 deepseek 模型的回复
    const aiReplies = arr.filter(l => l.modelVersion && l.modelVersion.includes('deepseek'));
    const ruleReplies = arr.filter(l => l.modelVersion && l.modelVersion.startsWith('rule:'));
    const cacheReplies = arr.filter(l => l.modelVersion === 'cache');

    return JSON.stringify({
      totalLogs: arr.length,
      aiReplies: aiReplies.length,
      ruleReplies: ruleReplies.length,
      cacheReplies: cacheReplies.length,
      aiSamples: aiReplies.slice(0, 3).map(l => ({
        userMessage: l.userMessage,
        aiReply: l.aiReply.substring(0, 100),
        model: l.modelVersion,
        latency: l.latencyMs,
        confidence: l.confidence,
        tokens: { in: l.tokenInput, out: l.tokenOutput }
      })),
      ruleSamples: ruleReplies.slice(0, 3).map(l => ({
        userMessage: l.userMessage,
        rule: l.modelVersion,
        confidence: l.confidence
      }))
    }, null, 2);
  `);
  console.log(aiCheck);

  console.log('\n=== 5. 验证买家档案记录（AI 自动标签） ===');
  const buyerCheck = await evaluate(wsUrl, `
    const shops = await window.api.shop.list();
    const result = await window.api.buyer.list(shops[0].shopId, 'feige');
    const profiles = result.profiles || result;
    return JSON.stringify({
      count: profiles.length,
      profiles: profiles.map(p => ({
        buyerName: p.buyerName,
        consultationCount: p.consultationCount,
        messageCount: p.messageCount,
        vipLevel: p.vipLevel,
        tags: p.tags,
        remarks: p.remarks,
        preferredCategories: p.preferredCategories,
        lastSeen: new Date(p.lastSeenAt).toLocaleString()
      }))
    }, null, 2);
  `);
  console.log(buyerCheck);

  console.log('\n=== 6. 检查 AI 客服完整管线（通过 audit 数据） ===');
  const pipelineCheck = await evaluate(wsUrl, `
    const shops = await window.api.shop.list();
    const logs = await window.api.audit.list(shops[0].shopId, 50, 0);
    const arr = logs.logs || (Array.isArray(logs) ? logs : []);

    // 统计回复来源分布
    const sourceDist = arr.reduce((acc, l) => {
      const src = l.modelVersion || 'unknown';
      acc[src] = (acc[src] || 0) + 1;
      return acc;
    }, {});

    // 统计延迟分布
    const latencies = arr.map(l => l.latencyMs || 0).filter(l => l > 0);
    const avgLatency = latencies.length > 0 ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0) : 0;
    const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;
    const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;

    // 统计 token 使用
    const totalTokenIn = arr.reduce((sum, l) => sum + (l.tokenInput || 0), 0);
    const totalTokenOut = arr.reduce((sum, l) => sum + (l.tokenOutput || 0), 0);

    return JSON.stringify({
      totalRecentLogs: arr.length,
      sourceDistribution: sourceDist,
      latencyStats: {
        count: latencies.length,
        avg: avgLatency + 'ms',
        min: minLatency + 'ms',
        max: maxLatency + 'ms'
      },
      tokenUsage: {
        totalInput: totalTokenIn,
        totalOutput: totalTokenOut,
        avgInputPerCall: arr.length > 0 ? Math.round(totalTokenIn / arr.length) : 0,
        avgOutputPerCall: arr.length > 0 ? Math.round(totalTokenOut / arr.length) : 0
      },
      confidenceStats: {
        avg: (arr.reduce((s, l) => s + (l.confidence || 0), 0) / arr.length).toFixed(4),
        min: Math.min(...arr.map(l => l.confidence || 0)).toFixed(4),
        max: Math.max(...arr.map(l => l.confidence || 0)).toFixed(4)
      }
    }, null, 2);
  `);
  console.log(pipelineCheck);

  process.exit(0);
}

main().catch((e) => {
  console.log('Failed:', e.message);
  process.exit(1);
});
