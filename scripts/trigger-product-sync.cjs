// scripts/trigger-product-sync.cjs
//
// 触发拼多多商品同步（异步长时操作，可能需要数分钟）
//
// 使用：node scripts/trigger-product-sync.cjs

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

async function evaluate(ws, expr, timeoutMs = 600000) {
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

(async () => {
  console.log('=== 触发拼多多商品同步 ===');
  console.log(`店铺 ID: ${PINDUODUO_SHOP_ID}\n`);

  const pages = await getPages();
  const main = pages.find(p => p.url && p.url.includes('dist/renderer/index.html'));
  if (!main) { console.error('未找到主渲染页面'); process.exit(1); }
  const ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));

  const expr = `(async () => {
    try {
      const r = await window.api.product.sync('${PINDUODUO_SHOP_ID}');
      return JSON.stringify({ ok: true, data: r });
    } catch (e) {
      return JSON.stringify({ ok: false, error: e.message, stack: e.stack });
    }
  })()`;

  console.log('开始同步...（可能需要数分钟）');
  const startTime = Date.now();
  try {
    const res = await evaluate(ws, expr, 600000); // 10 分钟超时
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const value = res?.result?.result?.value;
    if (!value) {
      console.log(`\n同步异常（${elapsed}s）: CDP 返回空`);
      console.log('raw:', JSON.stringify(res?.result).slice(0, 500));
    } else {
      try {
        const parsed = JSON.parse(value);
        if (parsed.ok) {
          const r = parsed.data;
          console.log(`\n✅ 同步成功（${elapsed}s）`);
          console.log(`  shopId: ${r.shopId}`);
          console.log(`  total: ${r.total}, imported: ${r.imported}, updated: ${r.updated}, removed: ${r.removed}, skipped: ${r.skipped}`);
          console.log(`  errors: ${r.errors?.length || 0}`);
          if (r.errors && r.errors.length > 0) {
            r.errors.slice(0, 5).forEach(e => console.log(`    - ${e}`));
          }
          if (r.failedProducts && r.failedProducts.length > 0) {
            console.log(`  failedProducts: ${r.failedProducts.length}`);
            r.failedProducts.slice(0, 3).forEach(fp => console.log(`    - ${fp.productId} ${fp.name}: ${fp.reason}`));
          }
        } else {
          console.log(`\n❌ 同步失败（${elapsed}s）: ${parsed.error}`);
          if (parsed.stack) console.log(`  stack: ${parsed.stack.slice(0, 500)}`);
        }
      } catch (e) {
        console.log(`\nJSON 解析失败（${elapsed}s）: ${e.message}`);
        console.log('raw:', value.slice(0, 500));
      }
    }
  } catch (err) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    console.log(`\n❌ 同步超时或异常（${elapsed}s）: ${err.message}`);
  }

  ws.close();
  console.log('\n=== 完成 ===');
})().catch(err => {
  console.error('未捕获异常:', err);
  process.exit(1);
});
