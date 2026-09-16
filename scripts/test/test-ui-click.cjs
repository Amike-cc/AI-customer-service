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

  console.log('=== 1. 查找并点击第二个店铺项 ===');
  const clickResult = await evaluate(wsUrl, `
    // 找到侧边栏店铺列表容器
    const shopListContainer = document.querySelector('[class*="shopList"]');
    if (!shopListContainer) return 'shopList container not found';

    // 获取所有店铺项（列表容器的直接子元素）
    const shopItems = Array.from(shopListContainer.children);
    if (shopItems.length < 2) return 'less than 2 shops: ' + shopItems.length;

    // 点击第二个店铺项（拼多多柚子货架）
    const targetShop = shopItems[1];
    const targetText = targetShop.textContent.trim().substring(0, 50);

    // 模拟点击
    targetShop.click();

    // 等待 UI 响应
    await new Promise(r => setTimeout(r, 2000));

    return JSON.stringify({
      clicked: true,
      targetText: targetText,
      targetClass: targetShop.className.substring(0, 80),
      afterClick: {
        bodyText: document.body.innerText.substring(0, 500),
        buttons: document.querySelectorAll('button').length,
        tabs: Array.from(document.querySelectorAll('[class*="subTab"], [class*="tab"]')).slice(0, 10).map(e => e.textContent.trim().substring(0, 20)),
        mainContent: document.querySelector('main') ? document.querySelector('main').textContent.trim().substring(0, 200) : 'no main'
      }
    });
  `);
  console.log(clickResult);

  console.log('\n=== 2. 点击后检查主面板内容 ===');
  const mainResult = await evaluate(wsUrl, `
    const main = document.querySelector('main');
    if (!main) return 'no main element';

    // 获取主面板下所有可见的文本元素
    const allText = [];
    function walkDOM(el, depth = 0) {
      if (depth > 5) return;
      const text = (el.textContent || '').trim();
      if (text && text.length < 100 && el.children.length < 5) {
        const tag = el.tagName;
        const cls = (el.className || '').toString().substring(0, 40);
        allText.push({ tag, class: cls, text: text.substring(0, 60), depth });
      }
      for (const child of el.children) {
        walkDOM(child, depth + 1);
      }
    }
    walkDOM(main, 0);

    return JSON.stringify({
      textCount: allText.length,
      elements: allText.slice(0, 40)
    }, null, 2);
  `);
  console.log(mainResult);

  console.log('\n=== 3. 检查标签页（子菜单） ===');
  const tabsResult = await evaluate(wsUrl, `
    const allButtons = Array.from(document.querySelectorAll('button'));
    const potentialTabs = allButtons.filter(b => {
      const text = (b.textContent || '').trim();
      return text && text.length < 20 && !text.includes('AI') && !text.includes('添加') && !text.includes('全局');
    });
    return JSON.stringify({
      count: potentialTabs.length,
      tabs: potentialTabs.map(b => ({
        text: b.textContent.trim().substring(0, 30),
        class: b.className.substring(0, 60),
        disabled: b.disabled
      }))
    }, null, 2);
  `);
  console.log(tabsResult);

  console.log('\n=== 4. 检查全局设置按钮（已点击前） ===');
  await evaluate(wsUrl, `return 'ready';`);

  console.log('\n=== 5. 点击全局设置按钮 ===');
  const settingsResult = await evaluate(wsUrl, `
    const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('全局设置'));
    if (!settingsBtn) return 'not found';
    settingsBtn.click();
    await new Promise(r => setTimeout(r, 1500));

    return JSON.stringify({
      bodyText: document.body.innerText.substring(0, 800),
      modalExists: !!document.querySelector('[class*="modal"], [role="dialog"]'),
      modalText: document.querySelector('[class*="modal"], [role="dialog"]') ?
        document.querySelector('[class*="modal"], [role="dialog"]').textContent.trim().substring(0, 500) : null,
      buttons: document.querySelectorAll('button').length,
      inputs: document.querySelectorAll('input, textarea, select').length
    });
  `);
  console.log(settingsResult);

  console.log('\n=== 6. 全局设置弹窗中的配置段 ===');
  const configSections = await evaluate(wsUrl, `
    const modal = document.querySelector('[class*="modal"], [role="dialog"]');
    if (!modal) return 'no modal';

    // 查找配置段标签
    const allElements = Array.from(modal.querySelectorAll('*'));
    const sectionElements = allElements.filter(e => {
      const text = (e.textContent || '').trim();
      return text && text.length < 30 && text.length > 1 && e.childElementCount === 0;
    });

    // 查找输入框
    const inputs = Array.from(modal.querySelectorAll('input, textarea, select'));
    // 查找按钮
    const buttons = Array.from(modal.querySelectorAll('button'));

    return JSON.stringify({
      sectionTexts: sectionElements.slice(0, 30).map(e => e.textContent.trim()).filter((v, i, a) => a.indexOf(v) === i),
      inputs: inputs.map(i => ({ type: i.type, name: i.name, value: i.value ? i.value.substring(0, 30) : '', placeholder: i.placeholder, label: i.labels && i.labels[0] ? i.labels[0].textContent : '' })),
      buttons: buttons.map(b => b.textContent.trim().substring(0, 30))
    }, null, 2);
  `);
  console.log(configSections);

  console.log('\n=== 7. 关闭弹窗（按 Escape） ===');
  await evaluate(wsUrl, `
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27 }));
    await new Promise(r => setTimeout(r, 500));
    return JSON.stringify({ modalStillExists: !!document.querySelector('[class*="modal"], [role="dialog"]') });
  `);

  console.log('\n=== 8. 验证弹窗已关闭 ===');
  const afterClose = await evaluate(wsUrl, `
    return JSON.stringify({
      modalExists: !!document.querySelector('[class*="modal"], [role="dialog"]'),
      bodyText: document.body.innerText.substring(0, 200)
    });
  `);
  console.log(afterClose);

  process.exit(0);
}

main().catch((e) => {
  console.log('Failed:', e.message);
  process.exit(1);
});
