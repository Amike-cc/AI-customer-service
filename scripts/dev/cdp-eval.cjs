/**
 * CDP 求值（开发工具）：在渲染进程执行任意表达式并打印结果。
 * 用法: node scripts/dev/cdp-eval.cjs "<expression>" [端口]
 */
const http = require('http');
const CDP = require('chrome-remote-interface');

const expr = process.argv[2];
const port = Number(process.argv[3] || 9222);

function fetchTargets(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: p, path: '/json/list' }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const targets = await fetchTargets(port);
  const page = targets.find((t) => t.type === 'page' && /dist\/renderer\/index\.html/.test(t.url))
    || targets.find((t) => t.type === 'page' && t.title === '飞鸽AI客服');
  const client = await CDP({ target: page.webSocketDebuggerUrl });
  const { Runtime } = client;
  await Runtime.enable();
  const res = await Runtime.evaluate({
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    console.log('EXCEPTION:', JSON.stringify(res.exceptionDetails, null, 2));
  } else {
    console.log(JSON.stringify(res.result.value, null, 2));
  }
  await client.close();
})().catch((e) => { console.error('eval failed:', e.message); process.exit(1); });
