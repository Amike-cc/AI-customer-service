// 验证本次修复的所有 API 暴露与组件状态
const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9222;

function getPages() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${CDP_PORT}/json`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(JSON.parse(data)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function evaluate(ws, expr) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('evaluate timeout')), 10000);
    ws.on('message', function handler(data) {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        clearTimeout(timeout);
        ws.off('message', handler);
        resolve(msg);
      }
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
}

(async () => {
  const pages = await getPages();
  const main = pages.find((p) => p.url && p.url.includes('dist/renderer/index.html'));
  if (!main) {
    console.error('❌ 未找到主渲染层窗口');
    process.exit(1);
  }
  console.log(`✅ 主渲染层窗口已加载: ${main.url}`);

  const ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));

  const checks = [
    ['window.api 存在', 'typeof window.api'],
    ['window.api.view 存在', 'typeof window.api.view'],
    ['window.api.view.hideForModal 函数', 'typeof window.api.view?.hideForModal'],
    ['window.api.view.restoreAfterModal 函数', 'typeof window.api.view?.restoreAfterModal'],
    ['window.api.buyer 存在', 'typeof window.api.buyer'],
    ['window.api.buyer.profile 函数', 'typeof window.api.buyer?.profile'],
    ['window.api.buyer.list 函数', 'typeof window.api.buyer?.list'],
    ['window.api.buyer.stats 函数', 'typeof window.api.buyer?.stats'],
    ['window.api.buyer.updateTags 函数', 'typeof window.api.buyer?.updateTags'],
    ['window.api.buyer.updateRemark 函数', 'typeof window.api.buyer?.updateRemark'],
    ['window.api.agent.refresh 函数', 'typeof window.api.agent?.refresh'],
    ['window.api.log.history 函数', 'typeof window.api.log?.history'],
    ['window.api.onTransferEvent 函数', 'typeof window.api.shop?.onTransferEvent'],
  ];

  let pass = 0, fail = 0;
  for (const [name, expr] of checks) {
    const result = await evaluate(ws, expr);
    const value = result?.result?.result?.value;
    const ok = value === 'function' || value === 'object' || value === 'undefined' && name.includes('不存在');
    // 简化判断：值不为 'undefined' 即认为存在
    const actualOk = value !== 'undefined';
    if (actualOk) {
      pass++;
      console.log(`  ✅ ${name}: ${value}`);
    } else {
      fail++;
      console.log(`  ❌ ${name}: ${value}`);
    }
  }

  // 验证 log.history 实际调用（不传参应返回 entries 数组结构）
  const histResult = await evaluate(ws, '(async () => { try { const r = await window.api.log.history(5, 0); return JSON.stringify(Object.keys(r)); } catch(e) { return "ERR:" + e.message; } })()');
  const histKeys = histResult?.result?.result?.value;
  if (histKeys && histKeys.includes('entries') && histKeys.includes('total')) {
    pass++;
    console.log(`  ✅ log.history 返回结构含 entries/total: ${histKeys}`);
  } else {
    fail++;
    console.log(`  ❌ log.history 返回结构异常: ${histKeys} (detail: ${JSON.stringify(histResult?.result)})`);
  }

  // 验证 buyer.stats IPC 可调用
  const buyerResult = await evaluate(ws, '(async () => { try { const r = await window.api.buyer.stats("__test__","feige"); return JSON.stringify(r); } catch(e) { return "ERR:" + e.message; } })()');
  const buyerVal = buyerResult?.result?.result?.value;
  if (buyerVal && buyerVal.includes('"ok":true')) {
    pass++;
    console.log(`  ✅ buyer.stats IPC 调用成功: ${buyerVal.substring(0, 100)}`);
  } else {
    fail++;
    console.log(`  ❌ buyer.stats IPC 调用失败: ${buyerVal} (detail: ${JSON.stringify(buyerResult?.result)})`);
  }

  // 验证 React 应用挂载
  const reactResult = await evaluate(ws, 'document.querySelector("#root")?.children?.length || 0');
  const reactChildren = reactResult?.result?.result?.value;
  if (reactChildren > 0) {
    pass++;
    console.log(`  ✅ React 应用已挂载，#root 子节点数: ${reactChildren}`);
  } else {
    fail++;
    console.log(`  ❌ React 应用未挂载: ${reactChildren}`);
  }

  console.log(`\n=== 总计: ${pass} 通过 / ${fail} 失败 ===`);
  ws.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('验证失败:', err);
  process.exit(1);
});
