# 飞鸽AI客服系统

> 面向多店铺的 AI 客服桌面系统开发基线
> CDP 直连为主 + AI 视觉兜底 + DeepSeek 智能问答 + 四平台适配

## 项目状态

| 项目         | 状态                                                                             |
| ------------ | -------------------------------------------------------------------------------- |
| 综合开发文档 | ✅ 完成（架构、UI、交互、未实现清单和发布门禁）                                  |
| 工程骨架     | ✅ 完成                                                                          |
| 核心模块实现 | ✅ 主链路、人工接管发送闸门、统一工作台、视觉运行时已实现                        |
| 单元测试     | ✅ 52 套件 / 550 测试通过                                                        |
| 自动化测试   | ✅ 102 套件 / 756 测试全部通过（含真实 OCR 识别与 DPI 换算）                     |
| 多平台支持   | ⚠️ 拼多多/抖店/快手小店/微信小店已有适配代码，真实账号验收待完成                 |
| 生产构建     | ✅ 已生成 NSIS 安装包（未签名）；干净机器安装/卸载 smoke 待验证                  |
| **训练数据** | **⚠️ 部分实现**（TrainingDataExporter + 可运行导出 CLI；模型训练生命周期未实现） |
| 合规审批     | 🔶 待业务方签字                                                                  |
| 真实平台验收 | ⚠️ 四平台真实账号验收（REAL-ACCEPT-001）未完成，发布前必须完成                   |

## 快速开始

### 环境要求

- **操作系统**：Windows 10/11（依赖 Win32 API + DPAPI）
- **Node.js**：≥ 18.0.0
- **Python**：≥ 3.10（视觉服务）

### 1. 安装 Node 依赖

```powershell
npm install
```

### 2. 启动并配置 API Key

```powershell
npm run electron:start
```

首次启动允许暂不配置 Key。进入“全局设置 → 系统配置 → 大模型配置”，使用 Windows DPAPI 加密保存 Key；未配置时规则、数据库和设置功能仍可用，AI Provider 不会发起请求。

也可通过系统环境变量提供 Key。`config/.env` 仅为向后兼容，不建议保存生产密钥。

### 3. 命令行初始化 API Key（可选）

```powershell
npm run setup
# 按提示输入 DeepSeek API Key
```

### 4. 安装 Python 视觉服务依赖

```powershell
cd vision
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
cd ..
```

### 5. 启动开发模式

```powershell
npm run electron:dev
```

## 目录结构

```
AIkefu/
├── docs/                       # 开发文档
│   ├── 开发文档-综合版.md       # 综合开发文档（架构、UI、交互、缺口、测试与发布）
│   └── superpowers/            # 设计规格与实施计划
│       ├── specs/              # 设计规格文档
│       └── plans/              # 实施计划文档
├── src/                        # Node.js 主进程源码（电商 AI 客服核心模块）
│   ├── agents/                 # 4 Agent + PromptBuilder + Orchestrator
│   ├── training/               # 模型训练数据导出器（新增）
│   ├── cache/                  # LRU 缓存 + ContextManager + 相似度
│   ├── cdp/                    # WebContentsView 页面自动化客户端
│   ├── config/                 # 配置加载 + Zod schema
│   ├── conversion/             # 购买意图检测 + 客服商品推荐
│   ├── db/                     # SQLite + 15 repos
│   ├── deepseek/               # DeepSeek API 客户端
│   ├── diagnostics/            # 诊断功能
│   ├── gateway/                # 多模型网关（7 providers）
│   ├── human/                  # 人工行为模拟
│   ├── intent/                 # 意图识别 + 情绪检测 + LLM 识别
│   ├── kb/                     # 知识库
│   ├── learning/               # 闭环学习（5 阶段管线）
│   ├── logging/                # winston 日志
│   ├── paths.ts                # 资源路径/用户数据路径解析（打包后不依赖 cwd）
│   ├── monitor/                # 监控与告警
│   ├── platform/               # 多平台定义注册表
│   ├── policy/                 # 工作时间策略
│   ├── product/                # 商品匹配 + 同步（已拆分）
│   ├── rules/                  # 本地规则引擎
│   ├── scheduler/              # 资源调度
│   ├── secrets/                # DPAPI 密钥存储 + 敏感词检测
│   ├── shop/                   # ShopSupervisor + ShopInstance（已拆分）
│   ├── state/                  # 状态机
│   ├── tools/                  # Function Calling 工具
│   ├── vision/                 # 视觉服务客户端
│   ├── backend.ts              # 后端工厂
│   ├── index.ts                # 命令行入口
│   └── setup.ts                # 初始化脚本
├── electron/                   # Electron 层
│   ├── main.ts                 # 主入口
│   ├── preload.ts              # 预加载脚本
│   ├── webview-manager.ts      # WebContentsView 管理
│   └── ipc-handlers.ts         # IPC 处理器
├── renderer/                   # React 渲染层（Vite）
├── vision/                     # Python 视觉服务
│   ├── vision_service.py       # 主服务
│   └── requirements.txt
├── scripts/                    # 开发工具脚本
│   ├── training/               # 模型训练导出 CLI（新增）
│   ├── test/                   # 运行时测试脚本
│   ├── verify/                 # 验证脚本
│   └── dev/                    # 开发调试脚本
├── config/                     # 配置文件
│   ├── default.yaml            # 默认配置
│   ├── production.yaml         # 可选的本机生产覆盖配置（不提交）
│   ├── production.yaml.example # 脱敏的生产覆盖示例
│   ├── .env.example            # 环境变量示例
│   ├── prompt/                 # Prompt 模板
│   ├── dict/                   # 词库（敏感词/地址关键词）
│   ├── rules/                  # 自定义规则
│   └── templates/              # 标准话术模板
└── tests/                      # 测试（unit/chaos/e2e/integration/renderer）
```

## 核心文档

| 文档                                                                             | 用途                                                                              |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [docs/开发文档-综合版.md](docs/开发文档-综合版.md)                               | 当前架构、四平台 UI、设计图、交互规范、未实现清单、测试、数据维护、安全与发布规范 |
| [design/ui-mockup-main-v3-workspace.png](design/ui-mockup-main-v3-workspace.png) | 最新主工作台 UI 设计图（展示用样例数据）                                          |
| [design/ui-mockup-main-v3-workspace.md](design/ui-mockup-main-v3-workspace.md)   | V3 设计说明和完整生成提示词                                                       |

## 开发命令

```powershell
npm run electron:start          # 启动应用
npm run typecheck               # 类型检查
npm run lint                    # 代码规范
npm run test:all                # 单元/界面/混沌/E2E/集成测试
npm run electron:start          # 另开终端后执行下面三项运行时冒烟检查
node scripts/dev/workspace-smoke.cjs data/dev/workspace-smoke.png 9222
node scripts/dev/interaction-smoke.cjs
node scripts/dev/management-smoke.cjs
node scripts/dev/readonly-ipc-smoke.cjs
npm run electron:build          # 主进程 + 渲染层构建
npm run electron:pack           # 生成 Windows 安装包
```

## 训练数据导出

TrainingDataExporter 已实现 JSONL 导出、质量过滤、PII 脱敏和训练/验证集拆分；这不等同于模型训练、评估、部署或回滚。CLI 通过 **Electron** 运行（better-sqlite3 为 Electron ABI 编译，普通 node 进程无法加载），且加载 `dist/` 编译产物，因此运行前需先 `npm run build`。

```powershell
npm run build   # 训练导出 CLI 依赖编译产物

# 导出 30 天内的对话数据用于模型微调
npm run training:export -- --lookback-days 30

# 指定质量阈值和输出目录
npm run training:export -- --quality-threshold 0.8 --output-dir ./data/training-v2
```

## 关键决策

1. **技术栈**：Node.js/TypeScript（主）+ Python 子进程（视觉推理）+ React（渲染层）
2. **OCR 引擎**：PaddleOCR（通过 Python 子进程承载，解决 Node 绑定问题）
3. **YOLO 模型**：YOLOv8n（CPU 友好，精度足够）
4. **AI 模型**：DeepSeek + 多模型网关（Qwen/OpenAI/Claude/Kimi/GLM/百川级联降级）
5. **配置管理**：YAML + Zod 校验，所有参数可配置
6. **状态机**：7 状态（Healthy/Degrading/VisualMode/Recovering/SilentWait/Error/ManualMode）
7. **多平台**：拼多多/抖店/快手小店/微信小店统一架构（内部 `feige` ID 兼容飞鸽）
8. **端口上限**：39 店铺，9222-9260

## 合规警告

本系统涉及的操作存在合规风险，详见 [docs/开发文档-综合版.md](docs/开发文档-综合版.md) 的“数据、备份和安全”与“真实平台验收矩阵”章节。**业务方负责人必须签字确认后方可投入商用**。

## License

UNLICENSED（私有项目）
