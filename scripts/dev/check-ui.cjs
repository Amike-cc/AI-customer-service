/** 临时诊断脚本：连接 Electron 主窗口 CDP 检查 UI 状态 */
const CDP = require('chrome-remote-interface');

(async () => {
  const targets = await CDP.List({ port: 9222 });
  const main = targets.find((t) => t.title === '飞鸽AI客服' && t.type === 'page');
  if (!main) {
    console.log('主窗口未找到');
    return;
  }
  const client = await CDP({ target: main, port: 9222 });
  const { Runtime } = client;
  await Runtime.enable();
  const r = await Runtime.evaluate({
    expression: `JSON.stringify({
      title: document.title,
      bodyLen: document.body.innerText.length,
      bodyText: document.body.innerText.substring(0, 600)
    })`,
    returnByValue: true,
  });
  console.log(r.result.value);
  client.close();
})().catch((e) => console.error('ERR', e.message));
