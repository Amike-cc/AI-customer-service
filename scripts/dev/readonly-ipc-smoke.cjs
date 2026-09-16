/**
 * 只读 IPC 冒烟检查：覆盖渲染层暴露的查询/诊断接口，不发送消息、不改配置。
 */
const CDP = require('chrome-remote-interface');

(async () => {
  const targets = await CDP.List({ port: 9222 });
  const main = targets.find((t) => t.type === 'page' && t.title === '飞鸽AI客服');
  if (!main) throw new Error('主窗口未找到');
  const client = await CDP({ target: main, port: 9222 });
  const { Runtime } = client;
  await Runtime.enable();
  const expression = `
    (async () => {
      const out = {};
      const summarize = (value) => {
        if (Array.isArray(value)) return { kind: 'array', length: value.length };
        if (value && typeof value === 'object') return { kind: 'object', keys: Object.keys(value).slice(0, 20) };
        return { kind: typeof value, value: value == null ? value : String(value).slice(0, 120) };
      };
      const call = async (name, fn) => {
        try { out[name] = { ok: true, result: summarize(await fn()) }; }
        catch (error) { out[name] = { ok: false, error: String(error?.message || error) }; }
      };
      const shops = await window.api.shop.list();
      out['shop.list'] = { ok: true, result: summarize(shops) };
      const rows = Array.isArray(shops) ? shops : (shops?.shops || shops?.items || []);
      const shopId = rows[0]?.shopId || rows[0]?.id;
      if (!shopId) throw new Error('shop.list 没有返回店铺 ID');
      await call('shop.getActiveShop', () => window.api.shop.getActiveShop());
      await call('shop.getLoginStatus', () => window.api.shop.getLoginStatus(shopId));
      await call('shop.getBusinessConfig', () => window.api.shop.getBusinessConfig(shopId));
      await call('workspace.getSnapshot', () => window.api.workspace.getSnapshot(shopId));
      const sessions = await window.api.conversation.sessions(shopId, 20);
      out['conversation.sessions'] = { ok: true, result: summarize(sessions) };
      await call('conversation.platformSessions', () => window.api.conversation.platformSessions(shopId, 20));
      await call('conversation.search', () => window.api.conversation.search(shopId, '商品', 20));
      await call('alert.list', () => window.api.alert.list());
      await call('audit.list', () => window.api.audit.list(shopId, 20));
      const sessionRows = Array.isArray(sessions) ? sessions : (sessions?.sessions || sessions?.items || []);
      const sessionId = sessionRows[0]?.sessionId || sessionRows[0]?.id;
      if (sessionId) await call('order.summary', () => window.api.order.summary(shopId, sessionId));
      else out['order.summary'] = { ok: true, skipped: '当前店铺没有会话，接口需要 sessionId' };
      await call('transfer.history', () => window.api.transfer.history(shopId));
      await call('metrics.summary', () => window.api.metrics.summary(shopId));
      await call('product.list', () => window.api.product.list(shopId));
      await call('product.getSyncStatus', () => window.api.product.getSyncStatus(shopId));
      await call('rule.list', () => window.api.rule.list(shopId));
      await call('faq.list', () => window.api.faq.list(shopId));
      await call('kb.listTemplates', () => window.api.kb.listTemplates(shopId));
      await call('kb.getCategories', () => window.api.kb.getCategories(shopId));
      await call('kb.listVersions', () => window.api.kb.listVersions(shopId));
      await call('kb.getPermissions', () => window.api.kb.getPermissions(shopId));
      await call('kb.listPendingReviews', () => window.api.kb.listPendingReviews(shopId));
      await call('feedback.list', () => window.api.feedback.list(shopId, 20));
      await call('feedback.stats', () => window.api.feedback.stats(shopId));
      await call('learning.patterns', () => window.api.learning.patterns(shopId));
      await call('learning.stats', () => window.api.learning.stats(shopId));
      await call('intent.recent', () => window.api.intent.recent(shopId, 20));
      await call('intent.stats', () => window.api.intent.stats(shopId));
      await call('escalation.list', () => window.api.escalation.list(shopId));
      await call('escalation.stats', () => window.api.escalation.stats(shopId));
      await call('agent.queue', () => window.api.agent.queue(shopId));
      await call('agent.list', () => window.api.agent.list(shopId));
      await call('buyer.list', () => window.api.buyer.list(shopId, 'feige', 20));
      await call('buyer.stats', () => window.api.buyer.stats(shopId, 'feige'));
      await call('config.get', () => window.api.config.get());
      await call('config.getLlmProviders', () => window.api.config.getLlmProviders());
      await call('log.history', () => window.api.log.history(20, 0));
      await call('diagnose.health', () => window.api.diagnose.health());
      await call('diagnose.viewState', () => window.api.diagnose.viewState());
      await call('diagnostic.systemHealth', () => window.api.diagnostic.systemHealth());
      return out;
    })()
  `;
  const result = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  const output = result.result.value;
  console.log(JSON.stringify(output, null, 2));
  const failures = Object.entries(output).filter(([, value]) => !value.ok);
  if (failures.length) process.exitCode = 1;
  await client.close();
})().catch((error) => {
  console.error('readonly IPC smoke failed:', error.message);
  process.exitCode = 1;
});
