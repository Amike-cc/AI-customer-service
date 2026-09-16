/* eslint-disable no-console */
/**
 * 独立数据库迁移入口
 * 详见 docs/开发文档-综合版.md 第 6 章数据库设计
 *
 * 幂等执行所有 CREATE TABLE IF NOT EXISTS 语句，
 * 可在部署后手动运行以确保数据库 schema 就绪。
 *
 * 运行方式：npm run db:migrate
 */
import path from 'path';
import fs from 'fs-extra';
import { ConfigLoader } from '../config/ConfigLoader';
import { Database } from './Database';

async function main(): Promise<void> {
  console.log('========================================');
  console.log('  飞鸽AI客服 - 数据库迁移');
  console.log('========================================\n');

  const configDir = path.resolve(process.cwd(), 'config');
  const config = await ConfigLoader.load(configDir);

  await fs.ensureDir(config.app.data_dir);
  await fs.ensureDir(path.join(config.app.data_dir, 'shops'));

  const db = new Database(config);
  await db.migrate();

  console.log(`[✓] 数据库迁移完成：${path.join(config.app.data_dir, 'app.db')}`);

  await db.close();
}

main().catch((err) => {
  console.error('数据库迁移失败:', err);
  process.exit(1);
});
