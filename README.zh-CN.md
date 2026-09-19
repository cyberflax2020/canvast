# Canvast 中文指南

<p align="center">
  <img src="assets/brand/canvast-hero.svg" alt="Canvast — 自研开源 loop 架构 AI 编程 agent harness" width="100%">
</p>

Canvast 是一个自研、开源（Apache-2.0）的 loop 架构 AI 编程 agent harness：它钩住 agent 的执行循环本身，让每一轮都重新锚定到持久化的全项目状态上。它以 Graph Canvas 治理画布为标志性能力，为大型项目的持续工作而生。

英文入口见 [README.md](README.md)。

## 为什么做 Canvast

传统 agent harness 的结构性弱点：每一轮几乎都是半盲启动（agent 看到对话，看不到项目）；上下文不断被压缩，项目关系被静默删除；随之出现遗忘、目标漂移、没有证据链的"假完成"。项目复杂度是网状的，而对话是线性的——只管对话的 harness 注定丢失项目。

Canvast 的解法是在每一轮 loop 上做治理：每个模型轮次之前，用持久化项目状态（Canvas 图谱、实时计划树、作用域任务上下文、运行时回执）重新锚定 agent。

## 核心特色

- **Graph Canvas 治理画布。** File、Plan、Decision、AgentRun 四类节点与 typed link 组成项目的活地图，跨 session、跨压缩持久存在；可查询、可溯源、可导出（JSON、Markdown、Mermaid、SVG、HTML）。
- **全量高级 harness 能力。** 自动 DAG workflow 拆分、有界子 agent 配发、sidecar 接续、plan mode、沙箱执行、后台任务、worktree、联网工具、LSP fallback 等，全部被同一条 loop 治理。
- **运行时透明。** request receipt、input queue、request lifecycle、tool runs、runtime events、approval history 都是一等可检查状态。
- **安全与资源纪律。** 三档沙箱 profile、带理由记录的 typed grant/revoke、凭据脱敏、资源 watchdog 与进程围栏 safe-run、密封运行时环境净化。

## 界面实录

终端运行时与 macOS App 工作空间读取同一份持久化项目状态：

<p align="center">
  <img src="docs/assets/user-guide/tui-run-runtime-zh-Hans.png" alt="Canvast 终端 runtime 与实时项目状态" width="49%">
  <img src="docs/assets/user-guide/macos-canvas-zh-Hans.png" alt="macOS App 项目 Canvas" width="49%">
</p>

## 实测有效性

我们以 Claude Code 为参考工具链进行配对实测：同任务、同协议、两侧相同的 DeepSeek 模型后端。常规 harness 能力与参考持平，Canvast 特色能力单独探针测量。实测数据与方法论见 [README.md 证据区块](README.md)（由机器重新生成并校验）与 [有效性证据](docs/EFFECTIVENESS_EVIDENCE.md)；记录不足以支持的项目会如实标注，而不是被省略。

## 快速开始

环境要求：

- Node.js `22.19.0` 或更高版本
- npm
- Python 3（用于 `npm run verify:skills`）
- 默认 provider 使用 `DEEPSEEK_API_KEY`

仓库 checkout：

```bash
npm ci
cp .env.example .env
./canvast.sh
```

解压后的 npm package：

```bash
npm install
cp .env.example .env
./canvast.sh
```

把 `DEEPSEEK_API_KEY` 写入本地忽略的 `.env` 文件；如果使用其他受支持 provider，请同时设置 `CANVAST_PROVIDER`、`CANVAST_MODEL` 和匹配的 key。然后可以先运行一个有界请求，例如：

```bash
./canvast.sh -p "Summarize the current project state."
```

## macOS App

从 [Releases](https://github.com/cyberflax2020/canvast/releases) 下载 `Canvast-macos-0.1.0.zip`（需要 macOS 13 或更高版本），解压后将 `Canvast.app` 移入"应用程序"。App 内嵌密封运行时，无需单独安装 Node.js。构建为 ad-hoc 签名，首次启动请右键 → 打开；在 Settings 中配置 provider key 后选择项目即可开始工作。

## 当前公开功能边界

- Session 与连续性：项目级 session、历史记录、resume 检查与领取流程、显式项目重绑定。
- 运行控制：Prepare、run、stop、类型化 request-control 策略、timeout 处理，以及显式 receipts。
- 运行期观测：input queue、request lifecycle、tool runs、runtime events、task 与 plan 投影，以及 approval history。
- Canvas 与溯源：持久化 File、Plan、Decision、AgentRun 节点与 typed link，显式 task/plan 选中，以及导出控件。
- 安全与权限：`read-only`、`workspace-write`、`full-access` profile，以及带记录理由的 typed sandbox inspect、profile、grant、revoke action。
- 导出：CLI 可将持久化 Canvas 导出为 JSON、Markdown、Mermaid、SVG 和 HTML；原生 App 也提供同格式导出入口。

可复算的导出命令：

```bash
npm run export:canvas -- --out ./canvas-export --title "Project Canvas"
```

如需导出指定图谱，请增加 `--input ./path/to/canvas-graph.json`。

## 进一步阅读

- [用户手册](docs/guides/user-manual.md)
- [配置指南](docs/guides/configuration.md)
- [开源采用记录](docs/architecture/open-source-adoption-record.md)
- [架构总览](docs/architecture/overview.md)
- [验证与证据](docs/guides/testing.md)
- [有效性证据](docs/EFFECTIVENESS_EVIDENCE.md)
- [外部服务边界](docs/reference/external-services.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)
- [安全策略](SECURITY.md)
- [Apache-2.0 许可证](LICENSE)
