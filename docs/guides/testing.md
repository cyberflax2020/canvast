# Verification and Evidence

## English

Canvast separates product checks by the question they answer. Structural checks show that a distribution is complete and self-consistent. Live checks show provider-backed behavior for a specific run. Published evidence is useful only when its own verifier accepts it against the current files.

### Verify a repository checkout

Use Node.js 22.19 or newer and npm. Python 3 is required for bundled-skill verification. A repository checkout includes `package-lock.json`, so install and verify it with:

```bash
npm ci
npm run typecheck
npm run verify:brand
npm run verify:skills
npm run verify:public
```

The repository `package.json` also contains maintenance, packaging, and release scripts. This guide relies on the following stable runtime and verification commands:

| Command | Purpose |
|---|---|
| `npm start` | Start the Canvast terminal runtime |
| `npm run typecheck` | Check the shipped TypeScript surfaces |
| `npm run export:canvas` | Export a Canvas as JSON, Markdown, Mermaid, SVG, and HTML |
| `npm run verify:brand` | Check the shipped logo assets and their cross-surface bindings |
| `npm run verify:skills` | Check bundled skill manifests, licenses, and isolated smoke behavior |
| `npm run verify:public` | Verify the repository tree, manifest, payload, licenses, and evidence bindings |

`verify:public` is deterministic and does not call a model provider. A pass means the checkout matches its public manifest and distribution contract; it does not claim that a new live model run occurred. Additional repository-maintenance and release scripts may exist in the same `package.json`, but they are outside this guide's basic verification path.

### Verify an extracted npm package

The npm package intentionally omits `package-lock.json`, so install it with:

```bash
npm install
npm run typecheck
npm run verify:brand
npm run verify:skills
```

An extracted npm package keeps the runtime entry point and basic verification scripts referenced above. Repository-anchored checks such as `npm run verify:public` depend on checkout metadata and are expected to stop in an extracted package.

### Reproduce a Canvas export

Export the current persisted graph, or the bounded repository scan fallback, with:

```bash
npm run export:canvas -- --out ./canvas-export --title "Project Canvas"
```

For a specific graph, make the input explicit:

```bash
npm run export:canvas -- \
  --input ./path/to/canvas-graph.json \
  --out ./canvas-export \
  --title "Project Canvas"
```

A successful export contains JSON, Markdown, Mermaid, standalone SVG, and interactive HTML. The SVG is the offline view; the HTML discloses its optional pinned D3 CDN dependency and links to the SVG fallback. Review any shared export for project-sensitive content even though the exporter redacts credential-shaped values and personal-home paths.

### Read evidence honestly

Use the narrowest claim supported by the artifact:

- `typecheck` establishes type consistency for the shipped TypeScript surfaces.
- `verify:brand` establishes the logo-integrity and cross-surface binding checks reported by that command.
- `verify:skills` establishes the bundled skill package checks reported by that command.
- `verify:public` establishes repository and npm-payload structure, exact manifests, licensing, local-link completeness, and bound checked-in evidence.
- A screenshot establishes only the rendered view and state shown in that capture. It does not prove a provider call, network access, permission grant, workflow launch, or newly completed action.
- The checked-in user-guide screenshots are sanitized illustrative captures. They can lag current controls until the source-repository maintainer commands `npm run user-guide:screenshots:generate` and `npm run user-guide:screenshots:verify` are rerun, so do not treat them as fresh release evidence by default. These two commands exist only in the source repository and are not part of the published package.
- A persisted status view or historical report is not a fresh live run.
- Provider-backed effectiveness evidence applies only to its recorded tasks, models, configuration, timestamps, and limitations. Do not generalize beyond those boundaries.

The effectiveness document, when present in the distribution, is `docs/EFFECTIVENESS_EVIDENCE.md`. Treat a result as published evidence only when its verifier accepts it against the current files; otherwise make no numeric effectiveness claim.

### Resource safety

Canvast provides a bounded wrapper for long or resource-intensive commands:

```bash
./scripts/safe-run.sh --timeout 900 -- <command>
```

The wrapper checks process and memory conditions, owns or reuses a healthy watchdog, applies a timeout, and cleans up only the process tree it owns. Unknown safety samples fail closed. Do not bypass a refusal until the reported condition is understood.
Process identity and enumeration prefer the operating-system `ps` interface. When macOS sandbox policy denies that interface, the wrapper and watchdog share a system-Python `libproc` fallback with exact PID, parent, process-group, and start-time fields. If both backends fail, launch fails closed before retaining a lock or daemon.
Sustained CPU use by one managed compiler, packager, or test worker is reported as a warning but does not by itself terminate the process. Aggregate target RSS above 6144MB is likewise a rate-limited warning while the host remains healthy. Progressive RSS relief requires consecutive samples with available memory below 4096MB and terminates only the largest target before re-sampling; recovery resets the streak. An optional absolute RSS hard cap is disabled by default and requires consecutive samples when enabled. Emergency sustained low-memory or high-load pressure, lifecycle violations, process-count limits, cancellation, and the wrapper timeout remain hard-stop conditions.

Run one resource-intensive operation at a time. External provider calls should be bounded, focused validations rather than parallel scanning fanout. A structural verification command never substitutes for a provider-backed run, and a provider-backed run never substitutes for package integrity checks.

The following two paragraphs describe the source-repository maintainer environment. `npm run verify:frontend`, `npm run verify:live`, and `scripts/verify-live.sh` exist only in the source repository; they are not shipped in the published repository tree or npm package, whose available commands are exactly the ones listed in its own `package.json`.

Some top-level commands, including `npm run verify:frontend`, already apply `safe-run.sh` separately to their heavy Swift stages. Invoke those commands directly. Do not wrap a command that already owns a safe-run lifecycle in another `safe-run.sh`; the single-flight lock deliberately rejects nested ownership.
`npm run verify:live` is the canonical outer gate. It captures the OS baseline first, runs exactly one root `safe-run.sh --timeout 7200 -- scripts/verify-live.sh ...` workload, waits for that root fence to finish teardown, and only then asserts the baseline plus owned-handle shutdown evidence. The workload script `scripts/verify-live.sh` is not the canonical entry and must not be used as a substitute for the gate when resource-safety proof is required.

## 中文

Canvast 按“这项检查能回答什么问题”划分产品验证。结构检查说明发行物完整且自洽；live 检查说明某次具体运行中的真实 provider 行为；已发布证据只有在其专用 verifier 针对当前文件校验通过时才有效。

### 验证仓库 checkout

请使用 Node.js 22.19 或更高版本与 npm；内置 skill 校验需要 Python 3。仓库 checkout 包含 `package-lock.json`，因此使用以下命令安装并验证：

```bash
npm ci
npm run typecheck
npm run verify:brand
npm run verify:skills
npm run verify:public
```

仓库 `package.json` 还包含维护、打包和发布脚本；本指南只依赖以下稳定的运行与验证命令：

| 命令 | 用途 |
|---|---|
| `npm start` | 启动 Canvast 终端 runtime |
| `npm run typecheck` | 检查随包发布的 TypeScript surface |
| `npm run export:canvas` | 将 Canvas 导出为 JSON、Markdown、Mermaid、SVG 和 HTML |
| `npm run verify:brand` | 检查随包发布的 Logo 资源及其跨界面绑定 |
| `npm run verify:skills` | 检查内置 skill manifest、许可证和隔离 smoke 行为 |
| `npm run verify:public` | 校验仓库树、manifest、payload、许可证和证据绑定 |

`verify:public` 是确定性检查，不会调用模型 provider。通过表示当前 checkout 符合其公开 manifest 和发行契约，并不表示刚刚发生过一次 live 模型运行。`package.json` 中可能还存在其他仓库维护或发布脚本，但它们不属于本指南的基础验证路径。

### 验证解压后的 npm package

npm package 刻意不包含 `package-lock.json`，因此使用：

```bash
npm install
npm run typecheck
npm run verify:brand
npm run verify:skills
```

解压后的 npm package 保留本指南引用的运行入口和基础验证脚本。像 `npm run verify:public` 这类依赖仓库 metadata 的检查只适用于 checkout，在解压后的 npm package 中预期会停止。

### 复算 Canvas 导出

使用以下命令导出当前持久化图谱；若图谱不存在，则使用有边界的仓库扫描 fallback：

```bash
npm run export:canvas -- --out ./canvas-export --title "Project Canvas"
```

若需导出指定图谱，请显式提供输入：

```bash
npm run export:canvas -- \
  --input ./path/to/canvas-graph.json \
  --out ./canvas-export \
  --title "Project Canvas"
```

成功导出后会得到 JSON、Markdown、Mermaid、独立 SVG 和交互式 HTML。SVG 是离线视图；HTML 会披露其可选且固定版本的 D3 CDN 依赖，并链接到 SVG fallback。虽然导出器会脱敏凭据形态的值和个人 home 路径，共享前仍应检查是否含有项目敏感内容。

### 准确理解证据

只采用 artifact 能支持的最窄结论：

- `typecheck` 证明随包发布的 TypeScript surface 类型一致。
- `verify:brand` 证明该命令所报告的 Logo 完整性和跨界面绑定检查。
- `verify:skills` 证明该命令所报告的内置 skill package 检查。
- `verify:public` 证明仓库和 npm payload 的结构、精确 manifest、许可证、本地链接完整性与已绑定的仓内证据。
- 截图只证明该 capture 中显示的视图与状态，不证明 provider 调用、联网、权限授予、workflow 启动或刚刚完成的动作。
- 仓内 user-guide 截图是脱敏后的说明性 capture。在重新运行源码仓维护者命令 `npm run user-guide:screenshots:generate` 和 `npm run user-guide:screenshots:verify` 之前，它们可能落后于当前控件，不应默认视为最新发布证据。这两条命令只存在于源码仓，不属于已发布 package。
- 持久化状态视图或历史报告不等于一次新的 live 运行。
- 真实 provider 的有效性证据只适用于其中记录的任务、模型、配置、时间戳与限制，不得越过这些边界泛化。

发行物中存在有效性文档时，其路径为 `docs/EFFECTIVENESS_EVIDENCE.md`。只有专用 verifier 针对当前文件接受结果时，才能将其作为已发布证据；否则不应给出数字化效果声明。

### 资源安全

Canvast 为长时间或高资源命令提供有边界的 wrapper：

```bash
./scripts/safe-run.sh --timeout 900 -- <command>
```

wrapper 会检查进程与内存条件，拥有或复用健康 watchdog，应用 timeout，并且只清理自己拥有的进程树。安全采样未知时会 fail closed。在理解报告的条件前，不要绕过拒绝。进程身份与枚举优先使用操作系统 `ps`；macOS sandbox 拒绝该接口时，wrapper 与 watchdog 共享系统 Python `libproc` fallback，并核验精确 PID、父 PID、进程组和秒/微秒启动时间。两个后端都失败时，会在保留锁或 daemon 前安全拒绝启动。单个受管编译器、打包器或测试 worker 持续高 CPU 只告警，不会单独触发终止；目标总 RSS 超过 6144MB 在主机健康时同样只做限频告警。只有 RSS 越过告警线且可用内存连续低于 4096MB 时，才渐进处置一个最大目标并重新采样，压力恢复会重置连续计数。可选绝对 RSS 硬上限默认禁用，启用后也必须连续命中。持续低内存或高 load 的紧急熔断、生命周期违规、进程数量超限、取消和 wrapper timeout 仍是硬终止条件。

同一时刻只运行一个高资源操作。外部 provider 调用应是有边界、聚焦的验证，而不是并行扫描 fanout。结构验证不能替代真实 provider 运行，真实 provider 运行也不能替代 package 完整性检查。

以下两段描述源码仓维护者环境。`npm run verify:frontend`、`npm run verify:live` 与 `scripts/verify-live.sh` 只存在于源码仓，不随已发布仓库树或 npm package 分发；发布物可用的命令以其自身 `package.json` 中列出的为准。

部分顶层命令（包括 `npm run verify:frontend`）已经分别为内部 Swift 重步骤套用了 `safe-run.sh`。这类命令应直接调用，不能再从外层嵌套 `safe-run.sh`；single-flight 锁会按设计拒绝嵌套 owner。
`npm run verify:live` 现在是 canonical 外层 gate：先捕获 OS baseline，再用唯一一层根仓库 `safe-run.sh --timeout 7200 -- scripts/verify-live.sh ...` 执行 workload，等这层 root fence 完成全部 teardown 后，才断言 baseline 与 owned-handle shutdown evidence。`scripts/verify-live.sh` 只是 workload，不应在需要资源安全证明时替代 gate 直接使用。
