/* eslint-disable no-console */
/**
 * 初始化设置脚本
 * 详见 docs/17-数据持久化与配置管理.md §17.8
 *
 * 交互式引导用户完成首次配置：
 *   1. 输入 DeepSeek API Key（DPAPI 加密存储）
 *   2. 配置飞书告警 Webhook（可选）
 *   3. 添加店铺（飞鸽客户端路径 + 窗口标题）
 *   4. 验证 API Key 可用性
 *
 * 运行方式：npm run setup
 */
import * as readline from 'readline';
import path from 'path';
import { ConfigLoader } from './config/ConfigLoader';
import { Database } from './db/Database';
import { DpapiSecretStore } from './secrets/DpapiSecretStore';
import axios from 'axios';
import fs from 'fs-extra';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

function questionMasked(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setEncoding('utf8');
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      // 回车结束
      if (text.includes('\n') || text.includes('\r')) {
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(text.replace(/[\r\n]/g, '').trim());
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  console.log('========================================');
  console.log('  飞鸽AI客服 - 初始化设置向导');
  console.log('========================================\n');

  // 1. 加载配置
  const configDir = path.resolve(process.cwd(), 'config');
  const config = await ConfigLoader.load(configDir);
  // 2. 确保数据目录存在
  await fs.ensureDir(config.app.data_dir);
  await fs.ensureDir(path.join(config.app.data_dir, 'data', 'shops'));
  await fs.ensureDir(path.join(config.app.data_dir, 'logs'));

  // 3. 初始化数据库
  const db = new Database(config);
  await db.migrate();
  console.log(`[✓] 数据库已就绪：${path.join(config.app.data_dir, 'app.db')}\n`);

  // 4. 配置 DeepSeek API Key
  const secretStore = new DpapiSecretStore(config);
  let apiKey = await secretStore.get('deepseek_api_key');

  if (apiKey) {
    console.log('[✓] 已存在 DeepSeek API Key（DPAPI 加密存储）');
    const reconfigure = await question('是否重新配置？(y/N): ');
    if (reconfigure.toLowerCase() === 'y') {
      apiKey = null;
    }
  }

  if (!apiKey) {
    console.log('\n--- 配置 DeepSeek API Key ---');
    console.log('获取地址: https://platform.deepseek.com/api_keys\n');
    let inputKey = '';
    let confirmed = false;
    while (!confirmed) {
      inputKey = await questionMasked('请输入 API Key (sk-...): ');
      if (!inputKey.startsWith('sk-')) {
        console.log('  [✗] 格式错误，应以 sk- 开头');
        continue;
      }
      const confirm = await question(`确认使用此 Key？(y/N): `);
      if (confirm.toLowerCase() === 'y') {
        confirmed = true;
      }
    }

    // 验证 API Key 可用性
    console.log('\n正在验证 API Key...');
    const valid = await verifyApiKey(config.deepseek.api_url, inputKey);
    if (!valid) {
      console.log('  [✗] API Key 验证失败，请检查 Key 是否正确');
      const force = await question('仍然保存？(y/N): ');
      if (force.toLowerCase() !== 'y') {
        console.log('已取消。');
        rl.close();
        await db.close();
        process.exit(1);
      }
    } else {
      console.log('  [✓] API Key 验证通过');
    }

    await secretStore.set('deepseek_api_key', inputKey);
    apiKey = inputKey;
    console.log('  [✓] API Key 已通过 DPAPI 加密存储');
  }

  // 5. 配置飞书告警（可选）
  console.log('\n--- 配置飞书告警 Webhook（可选，留空跳过）---');
  const existingWebhook = config.monitor.alert.feishu_webhook;
  const webhook = await question(`飞书 Webhook URL${existingWebhook ? '（回车保留现有）' : ''}: `);
  let webhookSecret = '';
  if (webhook) {
    webhookSecret = await question('飞书签名校验 Secret（可选）: ');
    await updateFeishuConfig(configDir, webhook, webhookSecret);
    console.log('  [✓] 飞书告警已配置');
  } else if (!existingWebhook) {
    console.log('  [-] 跳过飞书告警配置');
  }

  // 6. 添加店铺
  console.log('\n--- 店铺配置 ---');
  const existingShops = db.shops.list();
  console.log(`当前已配置 ${existingShops.length} 个店铺`);
  for (const s of existingShops) {
    console.log(`  - ${s.shopId} | ${s.shopName} | ${s.enabled ? '启用' : '禁用'}`);
  }

  const addMore = await question('\n是否添加新店铺？(y/N): ');
  if (addMore.toLowerCase() === 'y') {
    await addShopFlow(db);
  }

  // 7. 总结
  console.log('\n========================================');
  console.log('  初始化完成');
  console.log('========================================');
  console.log(`数据目录: ${config.app.data_dir}`);
  console.log(`API Key: 已配置`);
  console.log(`飞书告警: ${webhook || existingWebhook ? '已配置' : '未配置'}`);
  console.log(`店铺数量: ${db.shops.list().length}`);
  console.log('\n下一步：');
  console.log('  1. 确认飞鸽客户端已安装并登录');
  console.log('  2. 执行 npm run dev 启动服务');
  console.log('');

  rl.close();
  await db.close();
  secretStore.clearAll();
}

async function verifyApiKey(apiUrl: string, apiKey: string): Promise<boolean> {
  try {
    const resp = await axios.post(
      apiUrl,
      {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5,
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      },
    );
    return resp.status === 200 && !!resp.data?.choices;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 402) {
      // 余额不足也认为 Key 有效
      return true;
    }
    return false;
  }
}

async function updateFeishuConfig(configDir: string, webhook: string, secret: string): Promise<void> {
  const prodConfigPath = path.join(configDir, 'production.yaml');
  const yaml = await import('js-yaml');
  let existing: Record<string, unknown> = {};
  if (await fs.pathExists(prodConfigPath)) {
    try {
      existing = (yaml.load(await fs.readFile(prodConfigPath, 'utf8')) as Record<string, unknown>) ?? {};
    } catch {
      existing = {};
    }
  }
  const monitor = (existing.monitor as Record<string, unknown>) ?? {};
  const alert = (monitor.alert as Record<string, unknown>) ?? {};
  alert.feishu_webhook = webhook;
  // 签名密钥不写入 production.yaml（明文配置会随版本分发/日志泄露），
  // 改为写入 config/.env 并让 ConfigLoader 以 ${FEISHU_SECRET} 插值加载
  if (secret) {
    alert.feishu_secret = '${FEISHU_SECRET}';
    const envPath = path.join(configDir, '.env');
    let envContent = '';
    if (await fs.pathExists(envPath)) {
      envContent = await fs.readFile(envPath, 'utf8');
      // 替换已有 FEISHU_SECRET 行，避免重复
      envContent = envContent.replace(/^FEISHU_SECRET=.*$/gm, `FEISHU_SECRET=${secret}`);
      if (!/^FEISHU_SECRET=/m.test(envContent)) {
        envContent += (envContent.endsWith('\n') ? '' : '\n') + `FEISHU_SECRET=${secret}\n`;
      }
    } else {
      envContent = `FEISHU_SECRET=${secret}\n`;
    }
    await fs.writeFile(envPath, envContent, 'utf8');
  } else {
    alert.feishu_secret = '';
  }
  monitor.alert = alert;
  existing.monitor = monitor;
  await fs.writeFile(prodConfigPath, yaml.dump(existing), 'utf8');
}

async function addShopFlow(db: Database): Promise<void> {
  let addAnother = true;
  while (addAnother) {
    console.log('\n--- 添加新店铺 ---');
    const shopId = await question('店铺 ID（如 shop001）: ');
    if (!shopId) {
      console.log('  [✗] 店铺 ID 不能为空');
      continue;
    }
    if (db.shops.get(shopId)) {
      console.log('  [✗] 该店铺 ID 已存在');
      continue;
    }
    const shopName = await question('店铺名称: ');
    if (!shopName) {
      console.log('  [✗] 店铺名称不能为空');
      continue;
    }

    db.shops.add({
      shopId,
      shopName,
      platform: 'feige',
      enabled: true,
      autoReply: true,
      loginStatus: 'logged_out',
      lastLoginAt: null,
    });
    console.log(`  [✓] 店铺 ${shopName} 已保存（将在启动时加载飞鸽网页版）`);

    const more = await question('\n继续添加？(y/N): ');
    addAnother = more.toLowerCase() === 'y';
  }
}

main().catch((err) => {
  console.error('初始化失败:', err);
  rl.close();
  process.exit(1);
});
