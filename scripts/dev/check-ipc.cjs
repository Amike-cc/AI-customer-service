/** 临时诊断脚本：验证关键 IPC 功能（用正确 API 名称） */
const CDP = require('chrome-remote-interface');

(async () => {
  const targets = await CDP.List({ port: 9222 });
  const main = targets.find((t) => t.title === '飞鸽AI客服' && t.type === 'page');
  if (!main) { console.log('主窗口未找到'); return; }
  const client = await CDP({ target: main, port: 9222 });
  const { Runtime } = client;
  await Runtime.enable();

  const evalJs = async (label, expression) => {
    try {
      const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        console.log(`[${label}] 异常:`, JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      } else {
        console.log(`[${label}]`, JSON.stringify(r.result.value).substring(0, 800));
      }
    } catch (e) {
      console.log(`[${label}] ERR`, e.message);
    }
  };

  // 1. 诊断健康检查（systemHealth 属于 diagnostic 命名空间）
  await evalJs('systemHealth', `window.api.diagnostic.systemHealth().then(h => JSON.stringify({ok: h.ok, err: h.error, health: h.health && {uptime: h.health.uptime, dbTables: h.health.database && h.health.database.tableCounts, circuit: h.health.deepseek && h.health.deepseek.circuitState, apiConfigured: h.health.deepseek && h.health.deepseek.apiKeyConfigured}}))`);
  // 2. 全局配置
  await evalJs('configGet', `window.api.config.get().then(c => JSON.stringify({gatewayEnabled: c.gateway && c.gateway.enabled, globalBudget: c.scheduler && c.scheduler.budget && c.scheduler.budget.global_daily_yuan, intentEnabled: c.intent && c.intent.enabled}))`);
  // 3. 诊断运行
  await evalJs('diagnoseRun', `window.api.diagnose.run().then(r => JSON.stringify({healthScore: r.healthScore, pass: r.pass, warn: r.warn, fail: r.fail, results: r.results.slice(0, 8).map(x => x.status + ':' + x.name)}))`);

  client.close();
})().catch((e) => console.error('ERR', e.message));
