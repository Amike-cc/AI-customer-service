/**
 * 渲染层交互冒烟检查（只读/可逆操作）
 * 前提：npm run electron:start -- --remote-debugging-port=9222
 * 不发送消息、不修改店铺设置、不删除数据。
 */
const CDP = require('chrome-remote-interface');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const targets = await CDP.List({ port: 9222 });
  const main = targets.find((t) => t.type === 'page' && t.title === '飞鸽AI客服');
  if (!main) throw new Error('主窗口未找到');

  const client = await CDP({ target: main, port: 9222 });
  const { Runtime, Console, Log } = client;
  await Promise.all([Runtime.enable(), Console.enable(), Log.enable()]);
  const consoleErrors = [];
  Console.messageAdded((event) => {
    if (event.message?.level === 'error') consoleErrors.push(event.message.text);
  });
  Log.entryAdded((event) => {
    if (event.entry?.level === 'error') consoleErrors.push(event.entry.text);
  });

  const evaluate = async (expression) => {
    const result = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  };

  const snapshot = async () => evaluate(`JSON.stringify({
    bodyText: document.body.innerText,
    activeNav: [...document.querySelectorAll('button,[role="button"]')]
      .map((el) => ({ text: (el.innerText || el.getAttribute('aria-label') || '').trim(), cls: el.className }))
      .find((el) => /active|selected/i.test(String(el.cls))) || null,
    focused: document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName || null,
    api: Object.keys(window.api || {}).sort(),
  })`).then(JSON.parse);

  const clickText = async (label) => {
    const clicked = await evaluate(`(() => {
      const wanted = ${JSON.stringify(label)};
      const nodes = [...document.querySelectorAll('button,[role="button"],a,nav *')];
      const node = nodes.find((el) => (el.innerText || el.getAttribute('aria-label') || '').trim() === wanted);
      if (!node) return false;
      node.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`未找到交互元素：${label}`);
    await wait(250);
    return snapshot();
  };

  const results = [];
  const initial = await snapshot();
  results.push({ step: 'initial', ok: /未选择店铺/.test(initial.bodyText) });

  for (const label of ['店铺', '会话', '商品', '知识库', '质量', '诊断', '设置', '工作台']) {
    const state = await clickText(label);
    results.push({ step: `nav:${label}`, ok: state.bodyText.includes(label) });
  }

  const shopState = await clickText('123');
  results.push({
    step: 'shop:123',
    ok: shopState.bodyText.includes('123') && shopState.bodyText.includes('抖店'),
  });

  const search = await evaluate(`(() => {
    const input = document.querySelector('input[aria-label="全局搜索"]');
    if (!input) return { found: false };
    input.focus();
    input.value = '商品';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { found: true, value: input.value };
  })()`);
  await wait(250);
  const afterSearch = await snapshot();
  results.push({ step: 'global-search', ok: search.found && search.value === '商品' && afterSearch.focused === '全局搜索' });

  const apiShape = await evaluate(`JSON.stringify(Object.fromEntries(Object.entries(window.api || {}).map(([key, value]) => [key, typeof value === 'object' ? Object.keys(value || {}).sort() : typeof value])))`).then(JSON.parse);
  console.log(JSON.stringify({ results, apiShape, consoleErrors }, null, 2));
  if (results.some((item) => !item.ok)) process.exitCode = 1;
  await client.close();
})().catch((error) => {
  console.error('interaction smoke failed:', error.message);
  process.exitCode = 1;
});
