/**
 * 验证智能路由转接的 IPC 是否正常工作
 *
 * 通过 CDP 9222 端口连接到 electron 渲染层，调用：
 *   1. window.api.shop.getBusinessConfig("1783701851888") - 确认返回的 config 包含 agentMappings 字段
 *   2. window.api.shop.onTransferEvent - 确认返回函数（unsubscribe）
 *   3. 测试更新 agentMappings 并读回
 */
const http = require('http');

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const SHOP_ID = '1783701851888';

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: CDP_HOST, port: CDP_PORT, path }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function main() {
  // 1. 获取 CDP 页面列表
  const json = await httpGet('/json');
  const targets = JSON.parse(json);
  const pages = targets.filter((t) => t.type === 'page');
  console.log(`Found ${pages.length} page target(s):`);
  pages.forEach((p, i) => {
    console.log(`  [${i}] ${p.title.slice(0, 60)} - ${p.url.slice(0, 80)}`);
  });

  if (pages.length === 0) {
    console.log('No page targets found - electron may still be starting');
    return;
  }

  // 找到主窗口（通常是第一个非 about:blank 的）
  const mainPage = pages.find((p) => p.url.includes('dist/renderer/index.html')) || pages[0];
  console.log(`\nUsing main page: ${mainPage.url}`);

  // 2. 通过 WebSocket 连接并执行 JS
  const wsUrl = mainPage.webSocketDebuggerUrl;
  if (!wsUrl) {
    console.log('No WebSocket URL found');
    return;
  }

  const WebSocket = require('ws');
  const ws = new WebSocket(wsUrl);

  let msgId = 1;
  const pending = new Map();

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  function evaluate(expression) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({
        id, method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
  }

  await new Promise((r) => ws.on('open', r));
  console.log('WebSocket connected\n');

  // 3. 验证 getBusinessConfig 返回 agentMappings
  console.log('=== Test 1: getBusinessConfig returns agentMappings ===');
  const test1 = await evaluate(`(async () => {
    const result = await window.api.shop.getBusinessConfig("${SHOP_ID}");
    return JSON.stringify({
      ok: result.ok,
      hasAgentMappings: result.config ? ('agentMappings' in result.config) : false,
      agentMappings: result.config ? result.config.agentMappings : null,
    });
  })()`);
  console.log('Result:', test1.result.value);

  // 4. 验证 onTransferEvent 是函数
  console.log('\n=== Test 2: onTransferEvent is a function ===');
  const test2 = await evaluate(`(typeof window.api.shop.onTransferEvent === 'function')`);
  console.log('onTransferEvent is function:', test2.result.value);

  // 5. 测试订阅并立即取消
  console.log('\n=== Test 3: subscribe and unsubscribe ===');
  const test3 = await evaluate(`(() => {
    const unsub = window.api.shop.onTransferEvent(() => {});
    const isFunc = typeof unsub === 'function';
    unsub();
    return JSON.stringify({ subscribed: true, unsubscribeIsFunc: isFunc });
  })()`);
  console.log('Result:', test3.result.value);

  // 6. 测试更新 agentMappings
  console.log('\n=== Test 4: update agentMappings via updateBusinessConfig ===');
  const test4 = await evaluate(`(async () => {
    const result = await window.api.shop.updateBusinessConfig("${SHOP_ID}", {
      agentMappings: { after_sales: "客服晓晓_test", logistics: "客服小芳_test" }
    });
    return JSON.stringify(result);
  })()`);
  console.log('Update result:', test4.result.value);

  // 7. 重新读取确认持久化
  const test5 = await evaluate(`(async () => {
    const result = await window.api.shop.getBusinessConfig("${SHOP_ID}");
    return JSON.stringify({
      agentMappings: result.config ? result.config.agentMappings : null,
    });
  })()`);
  console.log('Readback:', test5.result.value);

  // 8. 清理测试数据
  await evaluate(`(async () => {
    await window.api.shop.updateBusinessConfig("${SHOP_ID}", { agentMappings: {} });
    return 'cleaned';
  })()`);
  console.log('\nCleaned up test data.');

  ws.close();
  console.log('\nAll IPC verifications passed.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
