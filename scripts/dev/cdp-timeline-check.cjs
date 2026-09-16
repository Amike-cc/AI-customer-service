/**
 * 消息时间线端到端检查（开发工具）
 *
 * 前提：应用已用 --remote-debugging-port 启动，且至少有一个店铺。
 * 流程：点击店铺行 → 通过主进程写入一条平台消息 → 点击"查看消息时间线" → 截图并采集 DOM。
 *
 * 用法: node scripts/dev/cdp-timeline-check.cjs [输出png] [端口]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const CDP = require('chrome-remote-interface');

const outFile = process.argv[2] || path.resolve('data', 'dev', 'timeline-shot.png');
const port = Number(process.argv[3] || 9222);

function getJson(p, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: p, path: pathname }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const targets = await getJson(port, '/json/list');
  const page = targets.find((t) => t.type === 'page' && /dist\/renderer\/index\.html/.test(t.url))
    || targets.find((t) => t.type === 'page' && t.title === '飞鸽AI客服');
  const client = await CDP({ target: page.webSocketDebuggerUrl });
  const { Page, Runtime, Input } = client;
  await Promise.all([Page.enable(), Runtime.enable()]);

  const clickBySelector = async (selector) => {
    const pos = await Runtime.evaluate({
      expression: `(function(){
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      })()`,
      returnByValue: true,
    });
    const p = pos.result.value;
    if (!p) return false;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await Input.dispatchMouseEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    }
    return true;
  };

  // 1. 选择第一个店铺
  await clickBySelector('[role="button"][aria-label^="打开店铺"]');
  await new Promise((r) => setTimeout(r, 4000));

  // 2. 找到"查看消息时间线"按钮并点击
  const toggled = await Runtime.evaluate({
    expression: `(function(){
      const btns = Array.from(document.querySelectorAll('aside button'));
      const b = btns.find((x) => x.textContent.includes('消息时间线'));
      if (b) { b.click(); return true; }
      return false;
    })()`,
    returnByValue: true,
  });
  console.log('toggled to timeline:', toggled.result.value);
  await new Promise((r) => setTimeout(r, 1500));

  const probe = await Runtime.evaluate({
    expression: `(function(){
      const tl = document.querySelector('[aria-label="消息时间线"]');
      return {
        hasTimeline: !!tl,
        sessionTabs: document.querySelectorAll('[role="tab"]').length,
        hasInput: !!document.querySelector('textarea[aria-label="回复输入框"]'),
        hasSendButton: !!document.querySelector('button[aria-label="发送回复"]'),
        text: tl ? tl.innerText.replace(/\\n+/g,' | ').slice(0, 300) : '',
      };
    })()`,
    returnByValue: true,
  });

  const shot = await Page.captureScreenshot({ format: 'png' });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
  console.log(JSON.stringify({ probe: probe.result.value, outFile }, null, 2));
  await client.close();
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
