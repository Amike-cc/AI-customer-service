// 通过 CDP 9222 端口在渲染层执行 window.api.buyer.stats，验证 IPC 是否工作
const CDP = require('d:/code/AIkefu/node_modules/chrome-remote-interface');

(async () => {
  try {
    // 1. 列出所有 target，找到应用渲染层（file:///...renderer/index.html）
    const targets = await CDP.List();
    const rendererTarget = targets.find(
      (t) => t.type === 'page' && /^file:\/.*renderer\/index\.html/i.test(t.url),
    );
    if (!rendererTarget) {
      console.error('[FAIL] 未找到应用渲染层 target');
      console.error('当前 targets:', targets.map((t) => `${t.type} ${t.url}`).join('\n  '));
      process.exit(1);
    }
    console.log('[OK] 找到渲染层 target:', rendererTarget.url);

    // 2. 连接 target
    const client = await CDP({ target: rendererTarget });
    const { Runtime } = client;

    // 3. 执行 window.api.buyer.stats 调用
    const expr = `(async () => {
      try {
        if (!window.api || !window.api.buyer) {
          return { ok: false, error: 'window.api.buyer 未暴露' };
        }
        const stats = await window.api.buyer.stats('1783701851888', 'feige');
        return { ok: true, stats };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    })()`;

    const result = await Runtime.evaluate({
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });

    console.log('[V7 IPC 验证结果]:', JSON.stringify(result.result.value, null, 2));

    await client.close();
    process.exit(0);
  } catch (err) {
    console.error('[ERROR]', err.message || err);
    process.exit(1);
  }
})();
