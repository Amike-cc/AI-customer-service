/**
 * 视觉服务依赖安装脚本
 * 创建 Python venv 并安装 requirements.txt 中的依赖
 * 使用国内镜像源加速下载
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const venvDir = path.join(__dirname, '..', 'vision', 'venv');
const pythonExe = process.platform === 'win32'
  ? path.join(venvDir, 'Scripts', 'python.exe')
  : path.join(venvDir, 'bin', 'python');
const requirementsPath = path.join(__dirname, '..', 'vision', 'requirements.txt');
const MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple';

function run(cmd, args, label) {
  console.log(`\n[${label}] ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
}

try {
  if (fs.existsSync(pythonExe)) {
    console.log('venv 已存在，跳过创建');
  } else {
    console.log('创建 Python venv...');
    run('python', ['-m', 'venv', venvDir], 'venv');
  }

  console.log('升级 pip...');
  run(pythonExe, ['-m', 'pip', 'install', '--upgrade', 'pip', '-i', MIRROR], 'pip-upgrade');

  console.log('安装依赖（使用清华镜像源）...');
  run(pythonExe, ['-m', 'pip', 'install', '-r', requirementsPath, '-i', MIRROR], 'pip-install');

  console.log('\n视觉服务依赖安装完成');
  console.log(`Python: ${pythonExe}`);
} catch (err) {
  console.error('\n安装失败:', err.message);
  process.exit(1);
}
