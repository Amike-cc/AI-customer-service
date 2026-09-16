/**
 * 训练数据导出 CLI（Electron 运行）
 *
 * 为什么用 Electron 而不是 node：better-sqlite3 是为 Electron ABI 编译的原生模块
 * （electron-rebuild / electron-builder 会重建它），普通 node 进程加载会报
 * NODE_MODULE_VERSION 不匹配。应用本身也是通过 Electron 运行，因此导出走同一运行时。
 *
 * 用法:
 *   npx electron scripts/training/export-runner.cjs -- --lookback-days 30
 *   （或 npm run training:export -- --lookback-days 30）
 *
 * 选项:
 *   --output-dir <path>     输出目录（默认: data/training/）
 *   --lookback-days <n>     回溯天数（默认: 90）
 *   --quality-threshold <f> 最低质量分（默认: 0.75）
 *   --max-per-shop <n>      每店铺最大条数（默认: 5000）
 *   --no-patterns           不导出学习模式
 *   --help                  显示帮助信息
 */
const { app } = require('electron');
const path = require('path');

// Electron 以 "electron <script>" 方式运行时，用户参数在 -- 之后或直接跟在后面
function parseArgs(argv) {
  const args = {};
  const start = argv.indexOf('--');
  const list = start >= 0 ? argv.slice(start + 1) : argv.filter((a) => a.startsWith('--'));
  for (let i = 0; i < list.length; i++) {
    switch (list[i]) {
      case '--output-dir': args['output-dir'] = list[++i]; break;
      case '--lookback-days': args['lookback-days'] = parseInt(list[++i], 10); break;
      case '--quality-threshold': args['quality-threshold'] = parseFloat(list[++i]); break;
      case '--max-per-shop': args['max-per-shop'] = parseInt(list[++i], 10); break;
      case '--no-patterns': args.patterns = false; break;
      case '--help': args.help = true; break;
      default: break;
    }
  }
  return args;
}

function printHelp() {
  console.log(`
用法: npm run training:export -- [选项]

选项:
  --output-dir <path>     输出目录（默认: data/training/）
  --lookback-days <n>     回溯天数（默认: 90）
  --quality-threshold <f> 最低质量分（默认: 0.75）
  --max-per-shop <n>      每店铺最大条数（默认: 5000）
  --no-patterns           不导出学习模式
  --help                  显示帮助信息

示例:
  npm run training:export -- --lookback-days 30 --quality-threshold 0.8
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  const repoRoot = path.resolve(__dirname, '..', '..');
  const distBackend = path.join(repoRoot, 'dist', 'src', 'backend.js');
  const distExporter = path.join(repoRoot, 'dist', 'src', 'training', 'TrainingDataExporter.js');

  const fs = require('fs');
  if (!fs.existsSync(distBackend)) {
    throw new Error(`未找到编译产物 ${distBackend}\n请先运行 npm run build 生成 dist/。`);
  }

  console.log('=== 训练数据导出工具 ===\n');
  const { createBackend } = require(distBackend);
  const { TrainingDataExporter } = require(distExporter);

  console.log('正在初始化后端...');
  const backend = await createBackend();
  const { config, logger, db } = backend;

  try {
    const exporter = new TrainingDataExporter(db, logger, config);

    console.log('\n导出对话训练数据...');
    const result = await exporter.export({
      outputDir: args['output-dir'],
      lookbackDays: args['lookback-days'],
      qualityThreshold: args['quality-threshold'],
      maxPerShop: args['max-per-shop'],
    });
    console.log('\n对话数据导出完成:');
    console.log(`   训练集:   ${result.stats.trainCount} 条`);
    console.log(`   验证集:   ${result.stats.validationCount} 条`);
    console.log(`   总条数:   ${result.stats.totalExported} 条`);
    console.log(`   输出目录: ${result.files.train}`);
    console.log(`   店铺分布: ${JSON.stringify(result.stats.byShop)}`);

    if (args.patterns !== false) {
      console.log('\n导出学习模式...');
      const patternResult = await exporter.exportPatterns({
        outputDir: args['output-dir'],
        qualityThreshold: args['quality-threshold'],
      });
      console.log('\n学习模式导出完成:');
      console.log(`   训练集:   ${patternResult.stats.trainCount} 条`);
      console.log(`   验证集:   ${patternResult.stats.validationCount} 条`);
      console.log(`   总条数:   ${patternResult.stats.totalExported} 条`);
    }
  } finally {
    await backend.shutdown();
  }

  console.log('\n全部完成！');
  return 0;
}

// 单实例锁会阻止第二个 Electron 实例；导出是一次性进程，直接放行
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  let code = 0;
  try {
    code = await main();
  } catch (err) {
    console.error('导出失败:', err instanceof Error ? err.message : err);
    code = 1;
  }
  app.exit(code);
});
