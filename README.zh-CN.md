# Canvast 中文指南

<p align="center">
  <img src="assets/brand/canvast-hero.svg" alt="Canvast — 面向 AI Agent 的项目治理画布" width="100%">
</p>

Canvast 是一个面向持续项目工作的本地优先 AI 编程工作空间。它把项目级 session、持久化 Canvas，以及可见的运行时状态，对齐到 TUI 和 macOS App 两个界面中，让你回到项目时继续沿着同一条工作上下文推进，而不是重新拼装状态。

英文入口见 [README.md](README.md)。

## 核心定位

Canvast 面向不是一条提示词就能结束的工作。它把请求状态、权限、Canvas 上下文、运行时可见性和 session 连续性固定在项目里，让长期工程任务保持可追踪、可恢复，并且能在终端与原生界面之间共享同一份项目状态。

## 界面实录

终端运行时与 macOS App 工作空间读取同一份持久化项目状态：

<p align="center">
  <img src="docs/assets/user-guide/tui-run-runtime-zh-Hans.png" alt="Canvast 终端 runtime 与实时项目状态" width="49%">
  <img src="docs/assets/user-guide/macos-canvas-zh-Hans.png" alt="macOS App 项目 Canvas" width="49%">
</p>

## 有效性证据

我们以 Claude Code 为参考工具链进行配对评估，两侧运行相同的 DeepSeek API 模型。完整的测评方法、判定门槛与实测结果见 [README.md 证据区块](README.md)（由机器重新生成并校验）与 [有效性证据](docs/EFFECTIVENESS_EVIDENCE.md)；无法证实的结论会被明确标记为结论未定，而不是被省略。

## 主要界面

- TUI 适合最快开始工作、引导活动运行、查看 `/canvast-status`、`/canvast-tasks`、`/canvast-canvas` 等状态视图。
- macOS App 打开同一份持久化项目状态，包含 Run Console、Tasks & Plans、Agents & Workflows、Safety & Permissions、Tools、Context、Sessions、Canvas 和 Settings。

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
