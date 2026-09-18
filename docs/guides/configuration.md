# Configuration

## English

Copy `.env.example` to `.env` for a local checkout or extracted package. Never commit `.env` or any file under `.canvast-secrets/`. Environment variables supplied by the invoking process take precedence over local secret files.

The default provider uses `DEEPSEEK_API_KEY`. Provider and model selection can be changed with `CANVAST_PROVIDER`, `CANVAST_MODEL`, `CANVAST_THINKING`, and `CANVAST_SUBAGENT_MODEL`. Other supported providers use their matching key variables when applicable, for example `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Task deadlines use `CANVAST_TASK_DEADLINE_MS`.

Model capability registries may be supplied through `CANVAST_MODEL_REGISTRY_PATH`, `CANVAST_MODEL_REGISTRY_PATHS`, project-local `.canvast/model-registry.json`, or the Canvast home directory. See `config-templates/model-registry-template.json` for the normalized format. Only redistribute registry data when its license permits it.

Bundled custom skills are disabled by default. Enable an audited skill explicitly with `--canvast-skill NAME`; unknown names and paths outside the skill registry are rejected.

### Launcher defaults

Unless overridden explicitly:

- `canvast.sh` resolves `CANVAST_PROJECT_ROOT` from the nearest project marker;
- the default provider is `deepseek`;
- the default model is `deepseek-v4-pro`;
- the default thinking level is `high`;
- project-scoped session persistence is enabled; and
- `PI_OFFLINE=1` remains enabled unless component auto-download is explicitly allowed.

### Runtime and safety controls

Common runtime controls include:

- `CANVAST_TASK_DEADLINE_MS` for bounded task deadlines;
- `CANVAST_SUBAGENT_MODEL` for sub-agent model selection;
- `--canvast-sandbox read-only|workspace-write|full-access` for launch-time sandbox policy; and
- `--no-session` for one-off ephemeral state.

Heavy or unattended runs should go through the bundled `scripts/safe-run.sh` wrapper rather than relying on raw environment configuration alone.

### Current desktop/App boundary

On the current disk state, the CLI/TUI path remains environment-first: credentials are still configured through environment variables or local ignored secret files. The macOS App also mounts a separate Settings scene backed by local settings logic. That source-backed surface exposes workspace directory, optional development-runtime fallback, provider/model/base URL fields, API-key entry, language preference, runtime/authentication status rows, and local Save/Test Connection/Apply Provider actions. It validates workspace and HTTPS base URL inputs and explicitly says provider credentials are stored in the system Keychain rather than written to project settings. This documentation pass did not validate the Settings path end-to-end in a running packaged App, so the environment-based path remains the canonical verified configuration workflow.

### Secret handling boundary

Configuration guidance stops at path and variable names. Secret-bearing files such as `.env` and `.canvast-secrets/` are local-only inputs. They must not be:

- committed;
- copied into shared archives or backups by automation; or
- written into command lines, reports, exported graphs, or published repository files.

These paths are local-only inputs and are excluded from distributable configuration.

## 中文

对于本地 checkout 或解压后的 package，请把 `.env.example` 复制为 `.env`。绝不要提交 `.env` 或 `.canvast-secrets/` 下的任何文件。调用进程提供的环境变量优先于本地 secret 文件。

默认 provider 使用 `DEEPSEEK_API_KEY`。可通过 `CANVAST_PROVIDER`、`CANVAST_MODEL`、`CANVAST_THINKING` 和 `CANVAST_SUBAGENT_MODEL` 调整 provider 与模型选择；其他受支持 provider 在适用时使用各自匹配的密钥变量，例如 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`；任务截止时间使用 `CANVAST_TASK_DEADLINE_MS`。

模型能力 registry 可由 `CANVAST_MODEL_REGISTRY_PATH`、`CANVAST_MODEL_REGISTRY_PATHS`、项目内 `.canvast/model-registry.json` 或 Canvast home 目录提供。规范格式见 `config-templates/model-registry-template.json`。只有在许可证允许时才能再分发 registry 数据。

内置 custom skill 默认关闭。请使用 `--canvast-skill NAME` 显式启用已审计的 skill；未知名称和 skill registry 之外的路径会被拒绝。

### 启动器默认值

未显式覆盖时：

- `canvast.sh` 从最近的项目标记解析 `CANVAST_PROJECT_ROOT`；
- 默认 provider 为 `deepseek`；
- 默认 model 为 `deepseek-v4-pro`；
- 默认 thinking level 为 `high`；
- 默认启用项目级 session 持久化；
- 除非显式允许组件自动下载，否则保持 `PI_OFFLINE=1`。

### 运行时与安全控制

常用运行时控制包括：

- `CANVAST_TASK_DEADLINE_MS`：有边界的任务截止时间；
- `CANVAST_SUBAGENT_MODEL`：子 agent 模型选择；
- `--canvast-sandbox read-only|workspace-write|full-access`：启动时沙箱策略；
- `--no-session`：一次性临时状态。

重型或无人值守运行应通过内置的 `scripts/safe-run.sh` wrapper 执行，不能只依赖原始环境变量配置。

### 当前桌面端/App 边界

以当前磁盘上的实现为准，CLI/TUI 仍以环境变量路径为主：凭据依然通过环境变量或本地忽略的 secret 文件配置。macOS App 同时挂载了一个由本地设置逻辑驱动的独立 Settings 场景，包含 workspace directory、可选 development runtime fallback、provider/model/base URL 字段、API key 输入框、language preference、runtime/authentication 状态行，以及本地 Save/Test Connection/Apply Provider 动作；该路径会校验 workspace 与 HTTPS base URL，并明确写明 provider 凭据保存在系统 Keychain 中，而不会写入项目设置。本次文档刷新没有在运行中的打包 App 里端到端验证该 Settings 路径，因此环境变量路径仍是规范且已验证的配置工作流。

### Secret 处理边界

配置文档只说明路径和变量名称。`.env`、`.canvast-secrets/` 等含 secret 的文件只能作为本地输入，不得：

- 提交到仓库；
- 由自动化复制到共享归档或备份；
- 写入命令行、报告、导出图或对外发布的仓库文件。

这些路径只用于本地输入，不属于可分发配置。
