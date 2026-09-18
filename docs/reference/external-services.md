# External Service Boundaries

## English

Canvast runs locally. It can call external services that the user configures or explicitly requests, but it does not operate a Canvast-hosted model backend. The default rule is conservative: local code analysis, prompt-local reasoning, and self-contained work should stay local unless the task requires live provider calls or current external evidence.

### Runtime boundaries

| Boundary | Purpose | Data sent | When it connects |
|---|---|---|---|
| Configured model provider | Agent inference, planning, and live workflows | Prompt context, selected project content, and tool results required for the task | Only when a model turn, workflow, or live verification is actually run |
| Search endpoints | User-requested web research | Search query and related grounding parameters | Only when web search or web research is explicitly justified |
| Fetch targets | Exact-source retrieval for cited evidence | The requested URL and normal HTTP request metadata | Only when Canvast is asked to inspect a concrete source |
| Optional component downloads | Upstream runtime component retrieval | Standard package or release download requests | Disabled by default; enabled only when the user allows component auto-downloads |
| User-invoked shell/network tools | Commands approved through the shell tool boundary | Whatever the approved command sends | Only when the user or workflow runs such a command; this is not a substitute for source-grounded research tools |
| Optional D3 CDN in Canvas HTML export | Interactive graph rendering inside exported HTML | Standard browser request metadata; the graph content remains in the local export | Only when the export is opened in a browser and the chosen export path references the CDN |

### Search and fetch boundary

Canvast's search and fetch behavior is an adapter layer, not an embedded search backend. Search calls depend on external search infrastructure, and fetch calls connect directly to the target source chosen by the user or the grounding policy.

That matters operationally:

- search is a bounded external dependency used for current or source-backed research;
- fetch is a direct request to the cited source itself; and
- shell commands that happen to use `curl`, `wget`, or similar tools are separate user-approved execution paths and must not be treated as a bypass around grounding rules.

### Credentials and artifact handling

Credentials are read from the environment or local ignored secret storage. They must not be written into command lines, logs, reports, exported graphs, repository files, or shared artifacts. Canvast applies credential redaction to tool output, but exported or shared artifacts still require user review before distribution.

### Offline and replacement options

Canvast can support alternative search backends, but a local replacement only matches the interface, not the full coverage of an internet-scale search service, unless the operator also maintains the crawler, index, freshness pipeline, ranking, and abuse controls behind it.

Practical replacement patterns are:

- a default external search adapter for general web research;
- an approved organization-managed search backend; or
- an offline or local search stack backed by an explicitly maintained local corpus.

### Verification boundary

Live verification can invoke configured model providers. Deterministic type, brand-asset, bundled-skill, and repository structural checks do not require provider credentials or general web access.

## 中文

Canvast 在本地运行。它可以调用用户配置或明确请求的外部服务，但不运营由 Canvast 托管的模型后端。默认策略是保守的：本地代码分析、仅依赖 prompt 的推理和自包含工作应保持本地运行，除非任务需要真实 provider 调用或当前外部证据。

### 运行时边界

| 边界 | 用途 | 发送的数据 | 连接时机 |
|---|---|---|---|
| 已配置的模型服务 | Agent 推理、规划与 live workflow | 任务需要的 prompt 上下文、选定项目内容和工具结果 | 仅在真实运行 model turn、workflow 或 live 验证时 |
| 搜索 endpoint | 用户要求的联网研究 | 搜索 query 与相关 grounding 参数 | 仅在 web search 或 web research 有明确理由时 |
| Fetch 目标 | 获取用于引用的确切来源 | 请求的 URL 和正常 HTTP request metadata | 仅在 Canvast 被要求检查具体来源时 |
| 可选组件下载 | 获取上游运行时组件 | 标准 package 或 release 下载请求 | 默认关闭；仅在用户允许组件自动下载时启用 |
| 用户调用的 shell/联网工具 | 通过 shell 工具边界批准的命令 | 获批命令所发送的内容 | 仅在用户或 workflow 运行该命令时；不能用它绕过基于来源的研究规则 |
| Canvas HTML 导出中的可选 D3 CDN | 在导出的 HTML 中渲染交互图 | 标准浏览器请求 metadata；图内容仍保留在本地导出中 | 仅在浏览器打开引用该 CDN 的导出文件时 |

### 搜索与 fetch 边界

Canvast 的 search 与 fetch 是 adapter 层，并非内置搜索后端。search 调用依赖外部搜索基础设施；fetch 会直接连接用户或 grounding policy 选定的目标来源。

这意味着：

- search 是用于获取当前信息或来源支撑材料的有边界外部依赖；
- fetch 是对引用来源本身的直接请求；
- 使用 `curl`、`wget` 等工具的 shell 命令属于单独的用户批准执行路径，不能视为绕过 grounding 规则的方式。

### 凭据与 artifact 处理

凭据从环境变量或本地忽略的 secret storage 读取。不得将凭据写入命令行、日志、报告、导出图、仓库文件或共享 artifacts。Canvast 会对工具输出应用凭据脱敏，但导出或共享 artifacts 在分发前仍需用户审阅。

### 离线与替代方案

Canvast 可以支持其他搜索后端，但本地替代方案通常只匹配接口；除非运营方同时维护 crawler、index、freshness pipeline、ranking 与 abuse control，否则不能等同于互联网规模搜索服务的覆盖能力。

实际可采用：

- 面向通用联网研究的默认外部搜索 adapter；
- 获批的组织自管搜索后端；
- 以明确维护的本地语料为基础的离线或本地搜索栈。

### 验证边界

Live 验证可能调用已配置的模型服务。确定性的类型检查、品牌资源检查、内置 skill 检查和仓库结构检查不需要 provider 凭据或通用联网权限。
