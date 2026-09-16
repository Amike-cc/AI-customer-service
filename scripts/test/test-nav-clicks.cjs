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

async function clickTab(wsUrl, tabName) {
  // 使用字符串拼接避免模板字面量嵌套问题
  const expr = [
    'const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("' + tabName + '"));',
    'if (!btn) return JSON.stringify({ tab: "' + tabName + '", error: "not found" });',
    'btn.click();',
    'await new Promise(r => setTimeout(r, 1200));',
    'const main = document.querySelector("main");',
    'return JSON.stringify({',
    '  tab: "' + tabName + '",',
    '  mainTextPreview: main ? main.textContent.trim().substring(0, 300) : "no main",',
    '  inputCount: main ? main.querySelectorAll("input, textarea, select").length : 0,',
    '  buttonCount: main ? main.querySelectorAll("button").length : 0,',
    '  cardCount: main ? main.querySelectorAll("[class*=\\"card\\"], [class*=\\"Card\\"]").length : 0,',
    '  tableRows: main ? main.querySelectorAll("tr").length : 0',
    '});'
  ].join('\n');
  return evaluate(wsUrl, expr);
}

async function main() {
  const targets = await httpGet('http://127.0.0.1:9222/json/list');
  const renderer = targets.find(t => t.title === '飞鸽AI客服' && t.type === 'page');
  if (!renderer) throw new Error('未找到飞鸽AI客服渲染页面');
  const wsUrl = renderer.webSocketDebuggerUrl;

  // 支持从应用默认店铺工作区直接运行：先进入管理中心。
  await evaluate(wsUrl, `
    const hasTabs = Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('系统配置'));
    if (!hasTabs) {
      const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('全局设置'));
      if (!settingsBtn) throw new Error('未找到全局设置入口');
      settingsBtn.click();
      await new Promise(r => setTimeout(r, 1200));
    }
    return true;
  `);

  console.log('=== 1. 依次点击各导航标签，验证内容切换 ===\n');
  const tabsToTest = ['系统配置', '商品管理', '规则引擎', '日志告警', '会话查看', '审计日志', '意图分析', '人工坐席', '学习系统', '运营指标', '健康监控', '知识库'];
  for (const tabName of tabsToTest) {
    try {
      const result = await clickTab(wsUrl, tabName);
      console.log(`[${tabName}]`);
      console.log(result);
      console.log('');
    } catch (e) {
      console.log(`[${tabName}] ERROR: ${e.message}\n`);
    }
  }

  console.log('\n=== 2. 检查知识库子标签（在知识库视图下） ===');
  // 先点击知识库
  await clickTab(wsUrl, '知识库');
  const subTabs = await evaluate(wsUrl, `
    const main = document.querySelector('main');
    const subTabButtons = main ? Array.from(main.querySelectorAll('button')).filter(b => {
      const text = b.textContent.trim();
      return text && text.length < 20 && !text.includes('保存') && !text.includes('删除') && !text.includes('新增');
    }) : [];
    return JSON.stringify({
      count: subTabButtons.length,
      tabs: subTabButtons.map(b => ({
        text: b.textContent.trim().substring(0, 30),
        class: b.className.substring(0, 50),
        active: b.className.includes('active') || b.className.includes('Active')
      }))
    }, null, 2);
  `);
  console.log(subTabs);

  console.log('\n=== 3. 点击各知识库子标签 ===');
  const subTabsToTest = ['概览', 'Prompt 模板', '敏感词管理', '店铺 FAQ', '话术模板', '版本管理', '准确率监控', '内容审核'];
  for (const subTabName of subTabsToTest) {
    try {
      const result = await clickTab(wsUrl, subTabName);
      console.log(`[${subTabName}]`);
      console.log(result);
      console.log('');
    } catch (e) {
      console.log(`[${subTabName}] ERROR: ${e.message}\n`);
    }
  }

  console.log('\n=== 4. 最终状态检查 ===');
  const finalState = await evaluate(wsUrl, `
    return JSON.stringify({
      activeTab: Array.from(document.querySelectorAll('[class*="active"], [class*="Active"]')).slice(0, 5).map(e => e.textContent.trim().substring(0, 30)),
      bodyTextLength: document.body.innerText.length,
      bodyTextPreview: document.body.innerText.substring(0, 400),
      errors: window.__reactErrors || 'no error tracking'
    }, null, 2);
  `);
  console.log(finalState);

  process.exit(0);
}

main().catch((e) => {
  console.log('Failed:', e.message);
  process.exit(1);
});
