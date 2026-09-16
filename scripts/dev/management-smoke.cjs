/** 管理中心 13 个模块的只读交互冒烟检查。 */
const CDP = require('chrome-remote-interface');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const targets = await CDP.List({ port: 9222 });
  const main = targets.find((t) => t.type === 'page' && t.title === '飞鸽AI客服');
  if (!main) throw new Error('主窗口未找到');
  const client = await CDP({ target: main, port: 9222 });
  const { Runtime } = client;
  await Runtime.enable();
  const labels = ['系统配置', '商品管理', '规则引擎', '知识库', '会话查看', '意图分析', '人工坐席', '学习系统', '日志告警', '审计日志', '运营指标', '软件更新', '健康监控'];
  const results = [];
  for (const label of labels) {
    const expression = `(() => {
      const wanted = ${JSON.stringify(label)};
      const nodes = [...document.querySelectorAll('span,h2,button')].filter((el) =>
        (el.innerText || '').trim() === wanted && el.getBoundingClientRect().left > 380
      );
      const node = nodes[0];
      if (!node) return false;
      node.click();
      return true;
    })()`;
    const clicked = await Runtime.evaluate({ expression, returnByValue: true });
    await wait(250);
    const state = await Runtime.evaluate({
      expression: `JSON.stringify({text: document.body.innerText, title: document.querySelector('main h1, main h2, h1, h2')?.innerText || ''})`,
      returnByValue: true,
    });
    const snapshot = JSON.parse(state.result.value);
    results.push({ step: label, clicked: clicked.result.value === true, visible: snapshot.text.includes(label), title: snapshot.title });
  }
  console.log(JSON.stringify({ results }, null, 2));
  if (results.some((item) => !item.clicked || !item.visible)) process.exitCode = 1;
  await client.close();
})().catch((error) => {
  console.error('management smoke failed:', error.message);
  process.exitCode = 1;
});
