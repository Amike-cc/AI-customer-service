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

  console.log('=== 1. 点击第二个店铺（柚子货架-拼多多，已登录）===');
  await evaluate(wsUrl, `
    const shops = document.querySelectorAll('[class*="shopItem"], [class*="ShopItem"]');
    if (shops.length >= 2) {
      shops[1].click();
      await new Promise(r => setTimeout(r, 1500));
      return 'clicked';
    }
    // 退而求其次，找含"柚子"的元素
    const all = Array.from(document.querySelectorAll('*'));
    const target = all.find(e => e.textContent && e.textContent.includes('柚子货架') && e.textContent.includes('拼多多') && e.children.length < 10);
    if (target) { target.click(); await new Promise(r => setTimeout(r, 1500)); return 'clicked-by-text'; }
    return 'not-found';
  `);

  console.log('\n=== 2. 点击后 UI 状态 ===');
  const afterClick = await evaluate(wsUrl, `
    return JSON.stringify({
      title: document.title,
      h2: Array.from(document.querySelectorAll('h2')).map(e => e.textContent.trim()),
      tabs: Array.from(document.querySelectorAll('[class*="subTab"], [class*="tab"]')).slice(0, 20).map(e => ({ tag: e.tagName, text: (e.textContent || '').trim().substring(0, 30), class: (e.className || '').substring(0, 60) })),
      buttons: document.querySelectorAll('button').length,
      forms: document.querySelectorAll('form').length,
      inputs: document.querySelectorAll('input, textarea, select').length,
      cards: document.querySelectorAll('[class*="card"], [class*="Card"]').length,
      bodyTextPreview: document.body.innerText.substring(0, 800)
    }, null, 2);
  `);
  console.log(afterClick);

  console.log('\n=== 3. 顶部导航栏菜单项 ===');
  const navResult = await evaluate(wsUrl, `
    const navItems = Array.from(document.querySelectorAll('nav button, nav a, [class*="nav"] button, [class*="nav"] a, header button')).slice(0, 30).map(e => ({
      tag: e.tagName,
      text: (e.textContent || '').trim().substring(0, 40),
      class: (e.className || '').substring(0, 50),
      disabled: e.disabled,
      type: e.type
    }));
    return JSON.stringify(navItems, null, 2);
  `);
  console.log(navResult);

  console.log('\n=== 4. 检查 React 组件树（通过 DOM 结构推断） ===');
  const treeResult = await evaluate(wsUrl, `
    function describeTree(el, depth = 0, maxDepth = 4) {
      if (depth > maxDepth || !el) return null;
      const children = [];
      for (const child of el.children) {
        if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE') continue;
        const childDesc = {
          tag: child.tagName,
          class: (child.className || '').toString().substring(0, 40),
          text: (child.textContent || '').trim().substring(0, 50),
          childCount: child.childElementCount
        };
        if (depth < maxDepth - 1) {
          const subTree = describeTree(child, depth + 1, maxDepth);
          if (subTree && subTree.length > 0) childDesc.children = subTree.slice(0, 5);
        }
        children.push(childDesc);
      }
      return children;
    }
    const root = document.getElementById('root');
    return JSON.stringify(describeTree(root, 0, 3), null, 2);
  `);
  console.log(treeResult);

  console.log('\n=== 5. 检查全局设置按钮可点击 ===');
  const settingsResult = await evaluate(wsUrl, `
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('全局设置'));
    if (btn) {
      return JSON.stringify({ found: true, disabled: btn.disabled, class: btn.className, visible: btn.offsetParent !== null });
    }
    return JSON.stringify({ found: false });
  `);
  console.log(settingsResult);

  console.log('\n=== 6. 检查添加店铺按钮 ===');
  const addShopResult = await evaluate(wsUrl, `
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('添加店铺'));
    if (btn) {
      return JSON.stringify({ found: true, disabled: btn.disabled, class: btn.className, visible: btn.offsetParent !== null });
    }
    return JSON.stringify({ found: false });
  `);
  console.log(addShopResult);

  console.log('\n=== 7. 检查 AI 自动回复切换按钮（4 个店铺） ===');
  const aiResult = await evaluate(wsUrl, `
    const aiButtons = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.trim() === 'AI');
    return JSON.stringify({
      count: aiButtons.length,
      buttons: aiButtons.map(b => ({
        class: b.className.substring(0, 80),
        isOn: b.className.includes('On') && !b.className.includes('Off'),
        visible: b.offsetParent !== null
      }))
    }, null, 2);
  `);
  console.log(aiResult);

  console.log('\n=== 8. 状态栏检查 ===');
  const statusResult = await evaluate(wsUrl, `
    const status = document.querySelector('[class*="status"], [class*="Status"], footer');
    return JSON.stringify({
      found: !!status,
      text: status ? status.textContent.trim().substring(0, 200) : null,
      class: status ? status.className.substring(0, 60) : null
    });
  `);
  console.log(statusResult);

  console.log('\n=== 9. 检查店铺列表项详情 ===');
  const shopListResult = await evaluate(wsUrl, `
    const shopItems = Array.from(document.querySelectorAll('[class*="shopItem"], [class*="ShopItem"]'));
    return JSON.stringify({
      count: shopItems.length,
      items: shopItems.map(item => ({
        text: (item.textContent || '').trim().substring(0, 100),
        class: (item.className || '').substring(0, 60)
      }))
    }, null, 2);
  `);
  console.log(shopListResult);

  process.exit(0);
}

main().catch((e) => {
  console.log('Failed:', e.message);
  process.exit(1);
});
