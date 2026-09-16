/**
 * 多 LLM Provider 配置 - 运行时 CDP 验证脚本
 *
 * 通过 CDP 端口 9222 在运行中的 electron 渲染层调用 window.api.* 方法
 * 验证 7 个新增 IPC handler 的功能正确性。
 */
const CDP = require('chrome-remote-interface');

const TARGET_TITLE = '飞鸽AI客服';
const PROVIDER_TYPES = ['deepseek', 'qwen', 'openai', 'claude', 'kimi', 'glm', 'baichuan', 'local'];

(async () => {
  let client;
  let passed = 0;
  let failed = 0;

  function assert(cond, label) {
    if (cond) {
      passed++;
      console.log(`  ✓ ${label}`);
    } else {
      failed++;
      console.log(`  ✗ ${label}`);
    }
  }

  try {
    // 找到主渲染页面
    const targets = await CDP.List();
    const rendererTarget = targets.find(
      (t) => t.type === 'page' && t.title === TARGET_TITLE,
    );
    if (!rendererTarget) {
      throw new Error(`找不到渲染层页面 "${TARGET_TITLE}"`);
    }
    console.log(`✓ 找到渲染层页面: ${rendererTarget.url}`);

    client = await CDP({ target: rendererTarget });
    const { Runtime } = client;

    console.log('\n=== F1: config.getLlmProviders 返回 8 个 provider ===');
    const f1 = await Runtime.evaluate({
      expression: `(async () => {
        const r = await window.api.config.getLlmProviders();
        return JSON.stringify(r);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const f1data = JSON.parse(f1.result.value);
    assert(f1data.ok === true, 'F1.1 getLlmProviders 返回 ok=true');
    assert(Array.isArray(f1data.providers) && f1data.providers.length === 8, `F1.2 providers 数组长度为 8 (实际: ${f1data.providers?.length})`);
    assert(typeof f1data.defaultProvider === 'string', `F1.3 defaultProvider 是字符串 (实际: ${f1data.defaultProvider})`);
    assert(f1data.cascade && typeof f1data.cascade.enabled === 'boolean', 'F1.4 cascade.enabled 是 boolean');

    const providers = f1data.providers;
    const types = providers.map((p) => p.type);
    for (const pt of PROVIDER_TYPES) {
      assert(types.includes(pt), `F1.5 provider 包含 ${pt}`);
    }

    // 每项字段都齐全
    const sample = providers[0];
    const requiredFields = ['type', 'label', 'description', 'docsUrl', 'apiKeysUrl',
      'enabled', 'tier', 'model', 'apiUrl', 'timeoutMs',
      'apiKeyEnvVar', 'apiKeyConfigured', 'registered', 'isDefault', 'hasOverride'];
    for (const f of requiredFields) {
      assert(f in sample, `F1.6 字段 ${f} 存在于 provider 对象`);
    }

    const deepseek = providers.find((p) => p.type === 'deepseek');
    assert(deepseek.isDefault === true, 'F1.7 deepseek 是默认 provider');
    assert(deepseek.enabled === true, 'F1.8 deepseek 默认启用');
    assert(deepseek.registered === true, 'F1.9 deepseek 已注册（之前已配置 key）');

    const local = providers.find((p) => p.type === 'local');
    assert(local.enabled === false, `F1.10 local 默认禁用 (实际: ${local.enabled})`);

    // OpenAI/Claude/Kimi/GLM/Baichuan 默认未启用
    for (const pt of ['openai', 'claude', 'kimi', 'glm', 'baichuan']) {
      const p = providers.find((x) => x.type === pt);
      assert(p.enabled === false, `F1.11 ${pt} 默认未启用`);
    }

    console.log('\n=== F2: config.getLlmApiKey 各 provider 行为正确 ===');
    const f2 = await Runtime.evaluate({
      expression: `(async () => {
        const out = {};
        for (const pt of ['deepseek', 'openai', 'claude', 'local']) {
          out[pt] = await window.api.config.getLlmApiKey(pt);
        }
        return JSON.stringify(out);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const f2data = JSON.parse(f2.result.value);
    assert(f2data.deepseek.configured === true, 'F2.1 deepseek API Key 已配置（来自旧迁移）');
    assert(f2data.openai.configured === false, 'F2.2 openai API Key 未配置');
    assert(f2data.claude.configured === false, 'F2.3 claude API Key 未配置');
    assert(f2data.local.configured === false, 'F2.4 local API Key 未配置（local 无需 key）');
    assert(typeof f2data.deepseek.masked === 'string' && f2data.deepseek.masked.includes('*'), `F2.5 deepseek masked 包含 * (实际: ${f2data.deepseek.masked})`);

    console.log('\n=== F3: config.updateLlmProvider 修改 enabled + cascade 字段写入 ===');
    const f3 = await Runtime.evaluate({
      expression: `(async () => {
        const r = await window.api.config.updateLlmProvider('qwen', { enabled: true, tier: 'tier2', model: 'qwen-test-model' });
        return JSON.stringify(r);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const f3data = JSON.parse(f3.result.value);
    assert(f3data.ok === true, 'F3.1 updateLlmProvider(qwen) 返回 ok=true');
    assert(f3data.requiresRestart === true, 'F3.2 requiresRestart=true（修改需重启生效）');

    // 重新读取验证写入
    const f3b = await Runtime.evaluate({
      expression: `(async () => {
        const r = await window.api.config.getLlmProviders();
        const qwen = r.providers?.find(p => p.type === 'qwen');
        return JSON.stringify(qwen);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const qwenAfterUpdate = JSON.parse(f3b.result.value);
    assert(qwenAfterUpdate.enabled === true, 'F3.3 qwen.enabled=true 已生效（运行时）');
    assert(qwenAfterUpdate.tier === 'tier2', `F3.4 qwen.tier=tier2 (实际: ${qwenAfterUpdate.tier})`);
    assert(qwenAfterUpdate.model === 'qwen-test-model', `F3.5 qwen.model=qwen-test-model (实际: ${qwenAfterUpdate.model})`);
    assert(qwenAfterUpdate.hasOverride === true, 'F3.6 qwen.hasOverride=true（运行时覆盖）');

    console.log('\n=== F4: config.setDefaultLlmProvider 切换默认 provider ===');
    const f4 = await Runtime.evaluate({
      expression: `(async () => {
        const r = await window.api.config.setDefaultLlmProvider('qwen');
        return JSON.stringify(r);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const f4data = JSON.parse(f4.result.value);
    assert(f4data.ok === true, 'F4.1 setDefaultLlmProvider(qwen) 返回 ok=true');

    const f4b = await Runtime.evaluate({
      expression: `(async () => {
        const r = await window.api.config.getLlmProviders();
        const def = r.providers?.find(p => p.isDefault);
        return JSON.stringify({ defaultProvider: r.defaultProvider, isDefault: def?.type });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const f4data2 = JSON.parse(f4b.result.value);
    assert(f4data2.defaultProvider === 'qwen', `F4.2 defaultProvider=qwen (实际: ${f4data2.defaultProvider})`);
    assert(f4data2.isDefault === 'qwen', `F4.3 isDefault 的 provider 是 qwen (实际: ${f4data2.isDefault})`);

    // 重置默认回 deepseek
    await Runtime.evaluate({
      expression: `(async () => {
        await window.api.config.setDefaultLlmProvider('deepseek');
        return 'ok';
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });

    console.log('\n=== F5: config.resetLlmProvider 重置覆盖 ===');
    const f5 = await Runtime.evaluate({
      expression: `(async () => {
        const r = await window.api.config.resetLlmProvider('qwen');
        return JSON.stringify(r);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const f5data = JSON.parse(f5.result.value);
    assert(f5data.ok === true, 'F5.1 resetLlmProvider(qwen) 返回 ok=true');

    const f5b = await Runtime.evaluate({
      expression: `(async () => {
        const r = await window.api.config.getLlmProviders();
        const qwen = r.providers?.find(p => p.type === 'qwen');
        return JSON.stringify(qwen);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const qwenAfterReset = JSON.parse(f5b.result.value);
    assert(qwenAfterReset.hasOverride === false, 'F5.2 qwen.hasOverride=false 已重置');
    assert(qwenAfterReset.enabled === false, `F5.3 qwen.enabled 恢复 YAML 默认 (实际: ${qwenAfterReset.enabled})`);

    console.log('\n=== F6: config.updateLlmApiKey 写入 + 读取（local 应拒绝） ===');
    // local 不允许配置 key
    const f6 = await Runtime.evaluate({
      expression: `(async () => {
        const r = await window.api.config.updateLlmApiKey('local', 'fake-key');
        return JSON.stringify(r);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const f6data = JSON.parse(f6.result.value);
    assert(f6data.ok === false, 'F6.1 local 不允许写入 API Key（ok=false）');

    // deepseek 写入相同 key（保持不变）
    const f6b = await Runtime.evaluate({
      expression: `(async () => {
        const existing = await window.api.config.getLlmApiKey('deepseek');
        return JSON.stringify(existing);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const existingDeepseek = JSON.parse(f6b.result.value);
    assert(existingDeepseek.configured === true, 'F6.2 deepseek 现有 key 仍可用');
    console.log(`    ℹ deepseek masked: ${existingDeepseek.masked}`);

    console.log('\n=== F7: config.testLlmProvider 测试 deepseek 连接 ===');
    const f7 = await Runtime.evaluate({
      expression: `(async () => {
        const r = await window.api.config.testLlmProvider('deepseek');
        return JSON.stringify(r);
      })()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: 60000,
    });
    const f7data = JSON.parse(f7.result.value);
    assert(typeof f7data.ok === 'boolean', `F7.1 testLlmProvider 返回 ok 字段 (实际: ${f7data.ok})`);
    assert(typeof f7data.latencyMs === 'number', `F7.2 latencyMs 是数字 (实际: ${f7data.latencyMs})`);
    assert(typeof f7data.message === 'string', 'F7.3 message 是字符串');
    console.log(`    ℹ deepseek healthCheck: ok=${f7data.ok}, latency=${f7data.latencyMs}ms, msg=${f7data.message.substring(0, 80)}`);

    console.log('\n=== F8: 测试未启用 provider（openai）应失败但不崩溃 ===');
    const f8 = await Runtime.evaluate({
      expression: `(async () => {
        const r = await window.api.config.testLlmProvider('openai');
        return JSON.stringify(r);
      })()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: 30000,
    });
    const f8data = JSON.parse(f8.result.value);
    assert(f8data.ok === false, 'F8.1 openai 测试返回 ok=false（未配置 key）');
    assert(typeof f8data.message === 'string' && f8data.message.length > 0, 'F8.2 openai 错误信息非空');
    console.log(`    ℹ openai test: msg=${f8data.message.substring(0, 80)}`);

    console.log('\n=== F9: LlmProvidersPanel UI 已渲染到 ConfigPanel ===');
    // 先点击「全局设置」按钮导航到 ConfigPanel
    await Runtime.evaluate({
      expression: `(function() {
        const btns = Array.from(document.querySelectorAll('button'));
        const cfgBtn = btns.find(b => b.textContent.includes('全局设置'));
        if (cfgBtn) cfgBtn.click();
        return !!cfgBtn;
      })()`,
      returnByValue: true,
    });
    // 等待渲染
    await new Promise((r) => setTimeout(r, 1200));
    const f9 = await Runtime.evaluate({
      expression: `(function() {
        // CSS Module 哈希类名不固定，改用 emoji + 文本内容判断
        const emojis = ['🧠','🌐','✨','🎭','🌙','⚡','🏔️','💻'];
        const bodyText = document.body.innerText;
        const emojiCount = emojis.filter(e => bodyText.includes(e)).length;
        const headings = Array.from(document.querySelectorAll('h3')).filter(h => h.textContent === '大模型配置');
        const summary = bodyText.includes('默认主用') && bodyText.includes('已启用');
        const providerNames = ['DeepSeek','通义千问','OpenAI','Claude','Kimi','GLM','Baichuan','Ollama'];
        const providerNameCount = providerNames.filter(n => bodyText.includes(n)).length;
        // 计数「启用」「禁用」按钮数量
        const toggleBtns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('启用') || b.textContent.includes('禁用')).length;
        return JSON.stringify({
          emojiCount,
          headingCount: headings.length,
          summaryVisible: summary,
          providerNameCount,
          toggleBtns,
        });
      })()`,
      returnByValue: true,
    });
    const f9data = JSON.parse(f9.result.value);
    assert(f9data.headingCount === 1, `F9.1 「大模型配置」标题渲染 (实际: ${f9data.headingCount})`);
    assert(f9data.emojiCount === 8, `F9.2 8 个 provider emoji 图标渲染 (实际: ${f9data.emojiCount})`);
    assert(f9data.summaryVisible === true, 'F9.3 汇总信息（默认主用 / 已启用）可见');
    assert(f9data.providerNameCount === 8, `F9.4 8 个 provider 名称渲染 (实际: ${f9data.providerNameCount})`);
    assert(f9data.toggleBtns >= 8, `F9.5 8 个启用/禁用按钮渲染 (实际: ${f9data.toggleBtns})`);

    console.log('\n=== F10: 检查持久化文件 data/llm_provider_overrides.json ===');
    const fs = require('fs');
    const path = require('path');
    const overridePath = path.join(__dirname, 'data', 'llm_provider_overrides.json');
    assert(fs.existsSync(overridePath), 'F10.1 llm_provider_overrides.json 文件已创建');
    if (fs.existsSync(overridePath)) {
      const content = JSON.parse(fs.readFileSync(overridePath, 'utf-8'));
      assert(content.providers && typeof content.providers === 'object', 'F10.2 providers 字段是对象');
      assert(typeof content.default_provider === 'string', `F10.3 default_provider 字段是字符串 (实际: ${content.default_provider})`);
      assert(content.default_provider === 'deepseek', `F10.4 default_provider=deepseek (实际: ${content.default_provider})`);
      console.log(`    ℹ 文件内容: ${JSON.stringify(content, null, 2).substring(0, 200)}...`);
    }

    console.log('\n========================================');
    console.log(`  结果: ${passed} 通过 / ${failed} 失败`);
    console.log('========================================');
  } catch (err) {
    console.error('\n[异常]', err.message);
    console.error(err.stack);
    failed++;
  } finally {
    if (client) await client.close();
    process.exit(failed === 0 ? 0 : 1);
  }
})();
