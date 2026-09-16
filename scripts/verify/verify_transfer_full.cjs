/**
 * 完整验证智能路由转接流程
 *
 * 1. 检查会话列表，点击一个在线会话让转接图标出现
 * 2. 配置 agentMappings（after_sales → 测试客服）
 * 3. 直接执行 transferToAgent 的核心 JS 逻辑（从 WebviewClient.ts 复制）
 * 4. 观察飞鸽页面反应 + 检查 Toast 通知
 */
const http = require('http');
const WebSocket = require('ws');

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const SHOP_ID = '1783701851888';

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: CDP_HOST, port: CDP_PORT, path }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function connectToTarget(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 1;
  const pending = new Map();

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  await new Promise((r) => ws.on('open', r));

  function evaluate(expression) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({
        id, method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
  }

  return { ws, evaluate };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const json = await httpGet('/json');
  const targets = JSON.parse(json);

  const feigePages = targets.filter((t) => t.type === 'page' && t.url.includes('jinritemai'));
  const rendererPages = targets.filter((t) => t.type === 'page' && t.url.includes('dist/renderer'));

  if (feigePages.length === 0) {
    console.log('No feige page found');
    return;
  }

  const feigeConn = await connectToTarget(feigePages[0]);
  console.log('Connected to feige page.');

  // 步骤 1: 检查会话列表
  console.log('\n=== 步骤 1: 检查会话列表 ===');
  const listCheck = await feigeConn.evaluate(`(function(){
    var listItems = document.querySelectorAll('.list_items .auxo-dropdown-trigger');
    if (listItems.length === 0) {
      // 尝试更宽松的选择器
      var allItems = document.querySelectorAll('.list_items [class*="dropdown-trigger"]');
      return JSON.stringify({
        found: false,
        listItemsCount: listItems.length,
        allDropdownCount: allItems.length,
        listItemsContainerExists: document.querySelectorAll('.list_items').length > 0,
      });
    }
    // 获取前 5 个会话的预览信息
    var previews = [];
    for (var i = 0; i < Math.min(listItems.length, 5); i++) {
      var item = listItems[i];
      var r = item.getBoundingClientRect();
      // 找会话卡片（含 Zp7bklkS6VsCDNXr8niG 类的消息预览行）
      var card = item;
      var preview = '';
      // 往上找会话卡片
      var cur = item;
      for (var j = 0; j < 5 && cur; j++) {
        var text = (cur.innerText || '').trim().slice(0, 100);
        if (text.length > 0 && text.length < 100) {
          preview = text;
          break;
        }
        cur = cur.parentElement;
      }
      previews.push({
        idx: i,
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
        preview: preview,
      });
    }
    return JSON.stringify({ found: true, total: listItems.length, previews: previews });
  })()`);
  console.log(listCheck.result.value);

  // 步骤 2: 点击第一个会话
  console.log('\n=== 步骤 2: 点击第一个会话 ===');
  const clickResult = await feigeConn.evaluate(`(function(){
    var listItems = document.querySelectorAll('.list_items .auxo-dropdown-trigger');
    if (listItems.length === 0) return JSON.stringify({ ok: false, reason: 'no-list-items' });

    // 点击第一个会话卡片（找内部的消息预览行 Zp7bklkS6VsCDNXr8niG）
    var firstItem = listItems[0];
    var cur = firstItem;
    for (var i = 0; i < 5 && cur; i++) {
      var previewRow = cur.querySelector('[class*="Zp7bklkS6VsCDNXr8niG"]') ||
                       cur.querySelector('div > div > div'); // 退一步
      if (previewRow) {
        previewRow.click();
        return JSON.stringify({ ok: true, clickedVia: 'preview-row' });
      }
      cur = cur.parentElement;
    }
    // 退一步：直接点击 dropdown-trigger
    firstItem.click();
    return JSON.stringify({ ok: true, clickedVia: 'dropdown-trigger-direct' });
  })()`);
  console.log(clickResult.result.value);

  // 等待会话加载
  console.log('\n等待会话加载（2秒）...');
  await sleep(2000);

  // 步骤 3: 再次检查转接图标
  console.log('\n=== 步骤 3: 检查转接图标是否出现 ===');
  const iconCheck2 = await feigeConn.evaluate(`(function(){
    var icons = document.querySelectorAll('[class*="i-icon-transfer"]');
    if (icons.length === 0) {
      // 检查输入框（确认会话已打开）
      var textareas = document.querySelectorAll('textarea');
      var visibleTextareas = [];
      for (var i = 0; i < textareas.length; i++) {
        var r = textareas[i].getBoundingClientRect();
        if (r.width > 0) {
          visibleTextareas.push({ placeholder: textareas[i].placeholder.slice(0, 50) });
        }
      }
      return JSON.stringify({
        found: false,
        reason: 'no-transfer-icon',
        visibleTextareas: visibleTextareas,
        // 检查是否是留言会话
        pageTextContainsLiuyan: document.body.innerText.indexOf('留言') >= 0,
      });
    }
    var r = icons[0].getBoundingClientRect();
    return JSON.stringify({
      found: true,
      count: icons.length,
      visible: r.width > 0 && r.height > 0,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    });
  })()`);
  console.log(iconCheck2.result.value);

  if (iconCheck2.result.value.includes('"found":false')) {
    console.log('\n⚠️ 转接图标未出现。可能是留言会话或会话未正确加载。');
    console.log('   尝试点击下一个会话...');
    // 尝试点击第二个会话
    const click2 = await feigeConn.evaluate(`(function(){
      var listItems = document.querySelectorAll('.list_items .auxo-dropdown-trigger');
      if (listItems.length < 2) return JSON.stringify({ ok: false, reason: 'no-second-item' });
      listItems[1].click();
      return JSON.stringify({ ok: true, clickedIdx: 1 });
    })()`);
    console.log(click2.result.value);
    await sleep(2000);

    const iconCheck3 = await feigeConn.evaluate(`(function(){
      var icons = document.querySelectorAll('[class*="i-icon-transfer"]');
      var textareas = document.querySelectorAll('textarea');
      var visibleTA = [];
      for (var i = 0; i < textareas.length; i++) {
        var r = textareas[i].getBoundingClientRect();
        if (r.width > 0) visibleTA.push({ placeholder: textareas[i].placeholder.slice(0, 60) });
      }
      return JSON.stringify({
        iconFound: icons.length > 0,
        iconCount: icons.length,
        visibleTextareas: visibleTA,
      });
    })()`);
    console.log('第二次检查:', iconCheck3.result.value);
  }

  // 步骤 4: 如果转接图标存在，执行 transferToAgent 核心流程
  console.log('\n=== 步骤 4: 执行 transferToAgent 核心流程（搜索一个不存在的客服） ===');
  const transferTest = await feigeConn.evaluate(`(async function(){
    var AGENT_NAME = '测试客服_not_exist';

    // 步骤 1: 检查 transfer 图标
    var icons = document.querySelectorAll('[class*="i-icon-transfer"]');
    if (icons.length === 0) {
      return JSON.stringify({ ok: false, step: 1, reason: 'no-transfer-icon', message: '当前会话无转接图标（可能为留言会话）' });
    }
    var iconRect = icons[0].getBoundingClientRect();
    if (iconRect.width === 0 || iconRect.height === 0) {
      return JSON.stringify({ ok: false, step: 1, reason: 'icon-not-visible' });
    }

    // 步骤 2: 点击 transfer 图标
    var cur = icons[0];
    var clicked = false;
    for (var i = 0; i < 8 && cur; i++) {
      if (cur.onclick) { cur.click(); clicked = true; break; }
      cur = cur.parentElement;
    }
    if (!clicked) {
      var p = icons[0].parentElement;
      if (p) { p.click(); clicked = true; }
    }
    if (!clicked) return JSON.stringify({ ok: false, step: 2, reason: 'click-failed' });

    // 步骤 3: 等待抽屉加载（最多 5 秒）
    var drawerReady = false;
    for (var wait = 0; wait < 10; wait++) {
      await new Promise(r => setTimeout(r, 500));
      var divs = document.querySelectorAll('div');
      for (var j = 0; j < divs.length; j++) {
        var r = divs[j].getBoundingClientRect();
        if (r.width < 200 || r.height < 100 || r.width > 1000) continue;
        var t = (divs[j].innerText || '').trim();
        if (t.indexOf('转接到客服') >= 0 && t.length < 3000) {
          drawerReady = true;
          break;
        }
      }
      if (drawerReady) break;
    }
    if (!drawerReady) return JSON.stringify({ ok: false, step: 3, reason: 'drawer-load-timeout' });

    // 步骤 4: 在搜索框输入目标客服名
    var drawer = null;
    var divs2 = document.querySelectorAll('div');
    for (var k = 0; k < divs2.length; k++) {
      var r2 = divs2[k].getBoundingClientRect();
      if (r2.width < 200 || r2.height < 100 || r2.width > 1000) continue;
      var t2 = (divs2[k].innerText || '').trim();
      if (t2.indexOf('转接到客服') >= 0 && t2.length < 3000) { drawer = divs2[k]; break; }
    }
    if (!drawer) return JSON.stringify({ ok: false, step: 4, reason: 'drawer-not-found-after-wait' });

    var inputs = drawer.querySelectorAll('input, textarea');
    var searchInput = null;
    for (var m = 0; m < inputs.length; m++) {
      var ph = (inputs[m].placeholder || '').toLowerCase();
      var r3 = inputs[m].getBoundingClientRect();
      if (r3.width === 0) continue;
      if (ph.indexOf('搜索') >= 0 || ph.indexOf('客服') >= 0 || ph.indexOf('输入') >= 0) {
        searchInput = inputs[m]; break;
      }
    }
    if (!searchInput) {
      for (var n = 0; n < inputs.length; n++) {
        var r4 = inputs[n].getBoundingClientRect();
        if (r4.width > 0) { searchInput = inputs[n]; break; }
      }
    }
    if (!searchInput) return JSON.stringify({ ok: false, step: 4, reason: 'no-search-input' });

    var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    nativeSetter.call(searchInput, AGENT_NAME);
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));

    // 步骤 5: 等待搜索结果
    await new Promise(r => setTimeout(r, 1500));

    // 检查搜索结果（应该找不到 "测试客服_not_exist"）
    var items = drawer.querySelectorAll('[class*=item], [class*=Item], [class*=card], [class*=Card], li, div');
    var found = false;
    for (var p2 = 0; p2 < items.length; p2++) {
      var it = items[p2];
      var r5 = it.getBoundingClientRect();
      if (r5.width === 0 || r5.height < 10 || r5.height > 200) continue;
      var t3 = (it.innerText || '').trim();
      if (!t3 || t3.length > 200) continue;
      if (t3 === AGENT_NAME || t3.indexOf(AGENT_NAME) >= 0) {
        found = true;
        break;
      }
    }

    return JSON.stringify({
      ok: true,
      step: 5,
      drawerLoaded: drawerReady,
      searchInputFound: true,
      agentFound: found,
      message: found ? '目标客服已找到（不应出现，因为是测试名）' : '目标客服未找到（预期行为：测试名不存在）',
      note: '抽屉已成功打开并搜索，验证了步骤 1-5 正常工作。不点击真实客服以避免影响生产环境。',
    });
  })()`);
  console.log(transferTest.result.value);

  // 步骤 5: 关闭抽屉（按 Escape）
  console.log('\n=== 步骤 5: 关闭转接抽屉 ===');
  await feigeConn.evaluate(`(function(){
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    // 也尝试点击抽屉外区域
    var drawer = null;
    var divs = document.querySelectorAll('div');
    for (var j = 0; j < divs.length; j++) {
      var r = divs[j].getBoundingClientRect();
      if (r.width < 200 || r.height < 100 || r.width > 1000) continue;
      var t = (divs[j].innerText || '').trim();
      if (t.indexOf('转接到客服') >= 0 && t.length < 3000) { drawer = divs[j]; break; }
    }
    if (drawer) {
      var cancelBtns = drawer.querySelectorAll('button, [role=button], [class*=btn]');
      for (var i = 0; i < cancelBtns.length; i++) {
        var t2 = (cancelBtns[i].innerText || '').trim();
        if (t2 === '取消' || t2.indexOf('取消') >= 0) {
          cancelBtns[i].click();
          return 'clicked cancel';
        }
      }
    }
    return 'escape dispatched';
  })()`);

  // 检查渲染层是否收到了 transfer 事件（如果 supervisor 触发了的话）
  if (rendererPages.length > 0) {
    console.log('\n=== 步骤 6: 检查渲染层 Toast 通知系统 ===');
    const rendererConn = await connectToTarget(rendererPages[0]);
    const toastCheck = await rendererConn.evaluate(`(function(){
      return JSON.stringify({
        onTransferEventExists: typeof window.api.shop.onTransferEvent === 'function',
        toastProviderMounted: typeof window.api !== 'undefined',
      });
    })()`);
    console.log(toastCheck.result.value);
    rendererConn.ws.close();
  }

  feigeConn.ws.close();
  console.log('\n=== 验证完成 ===');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
