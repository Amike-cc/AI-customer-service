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

  console.log('=== 商品完整字段检查 ===');
  const result = await evaluate(wsUrl, `
    const shops = await window.api.shop.list();
    const allShopsData = [];
    for (const shop of shops) {
      const products = await window.api.product.list(shop.shopId);
      if (products.length > 0) {
        allShopsData.push({
          shopId: shop.shopId,
          shopName: shop.shopName,
          platform: shop.platform,
          productCount: products.length,
          firstProductKeys: Object.keys(products[0]),
          firstProduct: products[0]
        });
      }
    }
    return JSON.stringify(allShopsData, null, 2);
  `);
  console.log(result);

  console.log('\n=== 审计日志字段检查 ===');
  const auditResult = await evaluate(wsUrl, `
    const shops = await window.api.shop.list();
    const logs = await window.api.audit.list(shops[0].shopId, 5);
    const arr = logs.logs || (Array.isArray(logs) ? logs : []);
    if (arr.length > 0) {
      return JSON.stringify({ keys: Object.keys(arr[0]), sample: arr[0] }, null, 2);
    }
    return JSON.stringify({ count: arr.length });
  `);
  console.log(auditResult);

  console.log('\n=== diagnostic.systemHealth 调用 ===');
  const healthResult = await evaluate(wsUrl, `
    const h = await window.api.diagnostic.systemHealth();
    return JSON.stringify(h, null, 2);
  `).catch((e) => 'ERROR: ' + e.message);
  console.log(healthResult);

  console.log('\n=== metrics.summary 调用 ===');
  const mResult = await evaluate(wsUrl, `
    const shops = await window.api.shop.list();
    const m = await window.api.metrics.summary(Date.now() - 3600000, shops[0].shopId);
    return JSON.stringify(m, null, 2);
  `).catch((e) => 'ERROR: ' + e.message);
  console.log(mResult);

  console.log('\n=== buyer.list 调用（验证买家档案） ===');
  const bResult = await evaluate(wsUrl, `
    const shops = await window.api.shop.list();
    const result = await window.api.buyer.list(shops[0].shopId, 'feige');
    if (!result.ok) throw new Error(result.error || '买家档案读取失败');
    const profiles = result.profiles || [];
    return JSON.stringify({ count: profiles.length, sample: profiles.slice(0, 2) }, null, 2);
  `).catch((e) => 'ERROR: ' + e.message);
  console.log(bResult);

  process.exit(0);
}

main().catch((e) => {
  console.log('Failed:', e.message);
  process.exit(1);
});
