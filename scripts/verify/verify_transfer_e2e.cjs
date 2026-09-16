/**
 * 智能路由转接客服 - 端到端事件链路验证
 *
 * 验证流程：
 *   1. 注册 onTransferEvent 回调（接收事件）
 *   2. 调用 testEmitTransfer('success', mockData) 触发 main 进程 ShopSupervisor.emit
 *   3. 等待事件链路：ShopSupervisor.emit → ipc-handlers broadcast → preload ipcRenderer → TransferNotifier
 *   4. 检查 DOM 是否出现 Toast UI 元素
 *   5. 重复测试 transfer:failed 事件
 */
const http = require('http');
const WebSocket = require('ws');

const CDP_HTTP = 'http://127.0.0.1:9222';

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`${CDP_HTTP}${path}`, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function evalOnTarget(target, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const id = Math.floor(Math.random() * 1e6);
    let settled = false;
    ws.on('open', () => {
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        settled = true;
        ws.close();
        resolve({ value: msg.result?.result?.value, error: msg.result?.exceptionDetails });
      }
    });
    ws.on('error', (err) => { if (!settled) reject(err); });
    setTimeout(() => { if (!settled) { try { ws.close(); } catch {} reject(new Error('CDP eval timeout')); } }, 20000);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  console.log('========== 智能路由转接客服 - 端到端事件链路验证 ==========\n');

  const targets = await httpGet('/json');
  const pages = targets.filter((t) => t.type === 'page');
  // 优先选主渲染层窗口（url 含 dist/renderer/index.html）
  const renderTarget = pages.find((p) => p.url.includes('dist/renderer/index.html')) || pages.find((p) => p.url.startsWith('file://')) || pages[0];
  console.log(`目标：${renderTarget.title} - ${renderTarget.url}\n`);

  const results = { pass: 0, fail: 0 };
  function record(name, ok, detail = '') {
    const status = ok ? 'PASS' : 'FAIL';
    if (ok) results.pass++; else results.fail++;
    console.log(`  [${status}] ${name}${detail ? ' - ' + detail : ''}`);
  }

  // ============ 1. 检查 testEmitTransfer API 存在 ============
  console.log('[1/6] 检查 testEmitTransfer API...');
  const apiCheck = await evalOnTarget(renderTarget, `(function(){
    return {
      hasTestEmitTransfer: typeof window.api?.shop?.testEmitTransfer === 'function',
      hasOnTransferEvent: typeof window.api?.shop?.onTransferEvent === 'function',
    };
  })()`);
  record('testEmitTransfer 方法存在', apiCheck.value?.hasTestEmitTransfer);
  record('onTransferEvent 方法存在', apiCheck.value?.hasOnTransferEvent);
  console.log('');

  // ============ 2. 注册 onTransferEvent 监听器 + 触发 success 事件 ============
  console.log('[2/6] 触发 transfer:success 事件并监听...');
  const successResult = await evalOnTarget(renderTarget, `(async function(){
    return new Promise((resolve) => {
      let received = null;
      const startTime = Date.now();
      // 注册监听器
      const unsub = window.api.shop.onTransferEvent((data) => {
        received = data;
        const elapsed = Date.now() - startTime;
        resolve({ ok: true, received, elapsedMs: elapsed });
      });
      // 触发事件
      window.api.shop.testEmitTransfer('success', {
        shopId: 'test-shop-success',
        sessionId: 'test-session-success',
        agentName: '测试客服晓晓',
        role: 'after_sales',
        reason: '验证事件链路',
      }).catch((e) => {
        resolve({ ok: false, error: e.message });
      });
      // 超时保护
      setTimeout(() => {
        if (!received) {
          try { unsub(); } catch {}
          resolve({ ok: false, reason: '事件监听超时（5秒）' });
        }
      }, 5000);
    });
  })()`);
  record('事件成功传递到渲染层', successResult.value?.ok, `耗时 ${successResult.value?.elapsedMs || 0}ms`);
  if (successResult.value?.received) {
    const r = successResult.value.received;
    record('  事件 type 字段正确', r.type === 'success', `type=${r.type}`);
    record('  事件 shopId 字段正确', r.shopId === 'test-shop-success', `shopId=${r.shopId}`);
    record('  事件 agentName 字段正确', r.agentName === '测试客服晓晓', `agentName=${r.agentName}`);
    record('  事件 role 字段正确', r.role === 'after_sales', `role=${r.role}`);
  } else {
    record('事件接收失败', false, successResult.value?.reason || successResult.value?.error || '未知');
  }
  console.log('');

  // ============ 3. 检查 Toast UI 是否渲染（DOM 检查） ============
  console.log('[3/6] 检查 Toast UI 元素是否渲染到 DOM...');
  await sleep(500); // 等待 React 渲染
  const toastCheck = await evalOnTarget(renderTarget, `(function(){
    // 找出所有可能是 toast 的元素
    const root = document.getElementById('root');
    if (!root) return { ok: false, reason: 'no root' };
    // Toast 容器和卡片可能没有明显的 class 标识（CSS Modules hash）
    // 但 Toast message 是 span 元素，包含特定文本
    const spans = root.querySelectorAll('span');
    const toastSpans = [];
    for (const span of spans) {
      const text = span.innerText || span.textContent || '';
      if (text.includes('已自动转接') || text.includes('转接失败') || text.includes('测试客服晓晓')) {
        toastSpans.push({
          text: text.substring(0, 100),
          parentClass: span.parentElement?.className?.substring?.(0, 100) || '',
        });
      }
    }
    return {
      ok: toastSpans.length > 0,
      toastCount: toastSpans.length,
      toasts: toastSpans.slice(0, 5),
    };
  })()`);
  record('Toast UI 已渲染到 DOM', toastCheck.value?.ok, `找到 ${toastCheck.value?.toastCount || 0} 个 toast 文本`);
  if (toastCheck.value?.toasts?.length) {
    toastCheck.value.toasts.forEach((t, i) => {
      console.log(`        Toast #${i + 1}: "${t.text}"`);
      console.log(`                   parentClass: "${t.parentClass}"`);
    });
  }
  console.log('');

  // ============ 4. 触发 transfer:failed 事件 ============
  console.log('[4/6] 触发 transfer:failed 事件...');
  const failedResult = await evalOnTarget(renderTarget, `(async function(){
    return new Promise((resolve) => {
      let received = null;
      const startTime = Date.now();
      const unsub = window.api.shop.onTransferEvent((data) => {
        if (data.type === 'failed') {
          received = data;
          const elapsed = Date.now() - startTime;
          resolve({ ok: true, received, elapsedMs: elapsed });
        }
      });
      window.api.shop.testEmitTransfer('failed', {
        shopId: 'test-shop-failed',
        sessionId: 'test-session-failed',
        reason: '飞鸽页面未找到转接图标',
        role: 'logistics',
        agentName: '物流小芳',
      }).catch((e) => resolve({ ok: false, error: e.message }));
      setTimeout(() => {
        if (!received) {
          try { unsub(); } catch {}
          resolve({ ok: false, reason: '事件监听超时（5秒）' });
        }
      }, 5000);
    });
  })()`);
  record('失败事件成功传递到渲染层', failedResult.value?.ok, `耗时 ${failedResult.value?.elapsedMs || 0}ms`);
  if (failedResult.value?.received) {
    const r = failedResult.value.received;
    record('  事件 type 字段正确', r.type === 'failed', `type=${r.type}`);
    record('  事件 reason 字段正确', r.reason === '飞鸽页面未找到转接图标', `reason=${r.reason}`);
  }
  console.log('');

  // ============ 5. 再次检查 Toast（应有 success + failed 两个） ============
  console.log('[5/6] 检查所有 Toast 渲染情况...');
  await sleep(500);
  const allToasts = await evalOnTarget(renderTarget, `(function(){
    const root = document.getElementById('root');
    if (!root) return { ok: false };
    const spans = root.querySelectorAll('span');
    const found = [];
    for (const span of spans) {
      const text = span.innerText || span.textContent || '';
      if (text.includes('已自动转接') || text.includes('转接失败') || text.includes('测试客服晓晓') || text.includes('物流小芳')) {
        found.push(text.substring(0, 150));
      }
    }
    return { ok: found.length >= 2, count: found.length, texts: found };
  })()`);
  record('Toast 至少显示 2 条', allToasts.value?.ok, `共 ${allToasts.value?.count || 0} 条`);
  if (allToasts.value?.texts) {
    allToasts.value.texts.forEach((t, i) => console.log(`        Toast #${i + 1}: "${t}"`));
  }
  console.log('');

  // ============ 6. 验证 main 进程日志（通过 evaluate 无法访问 main 日志，间接验证） ============
  console.log('[6/6] 事件链路完整性验证...');
  record('ShopSupervisor.emit 触发', successResult.value?.ok);
  record('ipc-handlers broadcast 转发', successResult.value?.ok, '事件传到渲染层即证明 broadcast 已执行');
  record('preload ipcRenderer 接收', successResult.value?.ok, 'onTransferEvent 回调被调用即证明');
  record('TransferNotifier 处理事件', toastCheck.value?.ok, 'Toast 文本中出现 "已自动转接" 即证明');
  record('useToast().show 调用', toastCheck.value?.ok, 'Toast UI 渲染即证明 show 方法被调用');
  record('Toast UI 渲染', toastCheck.value?.ok);
  console.log('');

  console.log('==========================================');
  console.log(`  端到端事件链路验证结果：通过 ${results.pass} 项，失败 ${results.fail} 项`);
  console.log('==========================================');
  if (results.fail === 0) {
    console.log('\n  ✅ 智能路由转接客服 - 端到端事件链路验证全部通过');
    console.log('  ✅ 完整链路：ShopSupervisor.emit → ipc-handlers broadcast → preload ipcRenderer → TransferNotifier → useToast → Toast UI');
  } else {
    console.log('\n  ❌ 存在失败项');
    process.exit(1);
  }
}

main().catch((err) => { console.error('脚本失败:', err); process.exit(1); });
