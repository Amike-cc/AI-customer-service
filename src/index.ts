/**
 * 飞鸽AI客服视觉识别模块 - 命令行入口
 *
 * 启动流程：
 * 1. 通过 createBackend() 初始化所有组件
 * 2. 从数据库读取已注册店铺
 * 3. 为每个已启用店铺启动监控
 * 4. 等待退出信号优雅关闭
 */

import { createBackend } from './backend';

async function main(): Promise<void> {
  const backend = await createBackend();
  const { logger, db, supervisor } = backend;

  // 全局异常兜底：任何未处理的拒绝/异常都记录日志，避免进程无痕崩溃
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason instanceof Error ? reason : new Error(String(reason)) }, '未处理的 Promise 拒绝');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, '未捕获的异常');
  });

  const shops = db.shops.list();
  for (const shopConfig of shops) {
    try {
      await supervisor.startShop(shopConfig);
      logger.info({ shopId: shopConfig.shopId, shopName: shopConfig.shopName }, '店铺已启动监控');
    } catch (err) {
      logger.error({ shopId: shopConfig.shopId, err }, '店铺启动监控失败');
    }
  }

  logger.info({ shopCount: supervisor.shopCount }, '系统启动完成');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, '收到退出信号，开始优雅关闭');
    try {
      await backend.shutdown();
    } catch (err) {
      logger.error({ err }, '优雅关闭过程中发生错误');
    } finally {
      // 无论关闭是否成功都保证退出；若 10 秒内未能退出则强制退出
      const forceExit = setTimeout(() => {
        logger.warn('优雅关闭超时，强制退出');
        process.exit(1);
      }, 10_000);
      forceExit.unref();
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
