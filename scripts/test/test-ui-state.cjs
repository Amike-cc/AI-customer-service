const WebSocket = require('ws');
const http = require('http');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function evaluate(wsUrl, expression, id = 1) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      try { ws.close(); } catch (e) {}
      reject(new Error('Timeout'));
    }, 30000);
    ws.on('open', () => {
      const wrapped = `(async () => { ${expression} })()`;
      ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression: wrapped, awaitPromise: true, returnByValue: true }
      }));
    });
    ws.on('message', (data) => {
      try {
        const r = JSON.parse(data.toString());
        if (r.id === id) {
          clearTimeout(timeout);
          try { ws.close(); } catch (e) {}
          if (r.result && r.result.result) {
            if (r.result.exceptionDetails) {
              reject(new Error(r.result.exceptionDetails?.exception?.description || 'JS error'));
            } else {
              resolve(r.result.result.value);
            }
          } else {
            resolve(undefined);
          }
        }
      } catch (e) {
        reject(e);
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });
}

async function main() {
  const targets = await httpGet('http://127.0.0.1:9222/json/list');
  const renderer = targets.find(t => t.title === '飞鸽AI客服' && t.type === 'page');
  const wsUrl = renderer.webSocketDebuggerUrl;

  console.log('=== 1. buyer.list 返回类型检查 ===');
  const bResult = await evaluate(wsUrl, `
    const shops = await window.api.shop.list();
    const result = await window.api.buyer.list(shops[0].shopId, 'feige');
    const list = result.profiles || [];
    return JSON.stringify({
      type: typeof list,
      isArray: Array.isArray(list),
      keys: list ? Object.keys(list) : null,
      str: JSON.stringify(list).substring(0, 500)
    });
  `).catch((e) => 'ERROR: ' + e.message);
  console.log(bResult);

  console.log('\n=== 2. 渲染层 React 状态检查 ===');
  const reactResult = await evaluate(wsUrl, `
    const root = document.getElementById('root');
    const reactRoot = root && root._reactRootContainer;
    const fiber = root && (root._reactRootContainer || root.__reactFiber$);
    return JSON.stringify({
      rootExists: !!root,
      rootInnerHTML: root ? root.innerHTML.substring(0, 200) : null,
      childCount: root ? root.childElementCount : 0,
      hasReact: typeof window.__REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined',
      documentTitle: document.title,
      bodyClass: document.body.className,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    });
  `).catch((e) => 'ERROR: ' + e.message);
  console.log(reactResult);

  console.log('\n=== 3. 主要 UI 元素检查 ===');
  const uiResult = await evaluate(wsUrl, `
    const elements = {
      // 顶部导航
      navButtons: Array.from(document.querySelectorAll('button, [role="button"], [class*="nav"]')).slice(0, 20).map(e => ({ tag: e.tagName, text: (e.textContent || '').trim().substring(0, 30), class: (e.className || '').substring(0, 40) })),
      // 侧边栏
      sidebar: document.querySelector('[class*="sidebar"], [class*="Sidebar"], aside') ? true : false,
      // 主面板
      mainPanel: document.querySelector('main, [class*="main"], [class*="Main"]') ? true : false,
      // 卡片
      cards: document.querySelectorAll('[class*="card"], [class*="Card"]').length,
      // 按钮
      buttons: document.querySelectorAll('button').length,
      // 表单
      forms: document.querySelectorAll('form').length,
      // 输入框
      inputs: document.querySelectorAll('input, textarea, select').length,
      // 标签页
      tabs: document.querySelectorAll('[class*="tab"], [role="tab"]').length,
      // 标题
      h1: document.querySelectorAll('h1').length,
      h2: document.querySelectorAll('h2').length,
      // Toast 通知
      toasts: document.querySelectorAll('[class*="toast"], [class*="Toast"], [class*="notification"]').length,
      // 模态框
      modals: document.querySelectorAll('[class*="modal"], [role="dialog"]').length
    };
    return JSON.stringify(elements, null, 2);
  `).catch((e) => 'ERROR: ' + e.message);
  console.log(uiResult);

  console.log('\n=== 4. 当前激活的视图/标签 ===');
  const viewResult = await evaluate(wsUrl, `
    const activeTabs = Array.from(document.querySelectorAll('[class*="active"], [class*="selected"], [aria-selected="true"]')).slice(0, 10).map(e => ({ tag: e.tagName, text: (e.textContent || '').trim().substring(0, 40), class: (e.className || '').substring(0, 60) }));
    return JSON.stringify(activeTabs, null, 2);
  `).catch((e) => 'ERROR: ' + e.message);
  console.log(viewResult);

  console.log('\n=== 5. 渲染层报错检查 ===');
  const errorResult = await evaluate(wsUrl, `
    return JSON.stringify({
      // 检查是否有错误边界
      hasErrorBoundary: !!document.querySelector('[class*="error"], [class*="Error"]'),
      // 检查是否有加载状态
      hasLoading: !!document.querySelector('[class*="loading"], [class*="Loading"], [class*="spinner"], [class*="Spinner"]'),
      // 检查是否有空状态
      hasEmptyState: !!document.querySelector('[class*="empty"], [class*="Empty"]'),
      // 检查页面是否有内容
      bodyTextLength: document.body.innerText.length,
      bodyTextPreview: document.body.innerText.substring(0, 500)
    });
  `).catch((e) => 'ERROR: ' + e.message);
  console.log(errorResult);

  process.exit(0);
}

main().catch((e) => {
  console.log('Failed:', e.message);
  process.exit(1);
});
