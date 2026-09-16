/**
 * 统一工作台冒烟检查（开发工具）
 *
 * 前提：应用已用 --remote-debugging-port=9222 启动
 *   npm run electron:start
 *
 * 功能：
 *   1. 连接渲染进程（file://.../dist/renderer/index.html，不是店铺 WebContentsView）
 *   2. 采集控制台 error/warn
 *   3. 输出侧栏/顶部栏/全局搜索/右侧面板的存在性与宽度
 *   4. 输出 PNG 截图
 *
 * 用法:
 *   node scripts/dev/workspace-smoke.cjs [输出png] [端口]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const CDP = require('chrome-remote-interface');

const outFile = process.argv[2] || path.resolve('data', 'dev', 'workspace-smoke.png');
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
  // 必须选中渲染层页面：店铺 WebContentsView 上不存在 window.api
  const page = targets.find((t) => t.type === 'page' && /dist\/renderer\/index\.html/.test(t.url))
    || targets.find((t) => t.type === 'page' && t.title === '飞鸽AI客服');
  if (!page) throw new Error('未找到渲染层页面，请确认应用已启动且开启了 9222 调试端口');

  const client = await CDP({ target: page.webSocketDebuggerUrl });
  const { Page, Runtime, Console, Log } = client;
  await Promise.all([Page.enable(), Runtime.enable(), Console.enable(), Log.enable()]);

  const issues = [];
  Console.messageAdded((m) => {
    if (m.message && (m.message.level === 'error' || m.message.level === 'warning')) {
      issues.push(`[${m.message.level}] ${m.message.text}`);
    }
  });
  Log.entryAdded((e) => {
    if (e.entry && (e.entry.level === 'error' || e.entry.level === 'warning')) {
      issues.push(`[${e.entry.level}] ${e.entry.text}`);
    }
  });

  await new Promise((r) => setTimeout(r, 600));

  const probe = await Runtime.evaluate({
    expression: `(function(){
      const rect = (el) => el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null;
      return {
        title: document.title,
        topbar: rect(document.querySelector('header')),
        sidebar: rect(document.querySelector('nav')),
        statusbar: document.querySelectorAll('footer').length,
        globalSearch: !!document.querySelector('input[aria-label="全局搜索"]'),
        workspacePanel: rect(document.querySelector('aside[aria-label="工作台操作面板"]')),
        emptyState: document.body.innerText.includes('未选择店铺'),
        viewport: { w: window.innerWidth, h: window.innerHeight },
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    })()`,
    returnByValue: true,
  });

  const shot = await Page.captureScreenshot({ format: 'png' });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));

  console.log(JSON.stringify({ probe: probe.result.value, consoleIssues: issues, outFile }, null, 2));
  await client.close();
})().catch((e) => { console.error('workspace smoke failed:', e.message); process.exit(1); });
