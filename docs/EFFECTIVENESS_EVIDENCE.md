# Effectiveness Evidence

## English

### What this document is

This public document reports product outcomes recomputed from a provenance-verified formal paired measurement. It publishes only measurements that can be regenerated from the checked-in record and keeps every conclusion within the observed task scope.

### Evidence boundary

The measurement is bounded by the checked-in source snapshot, formal paired artifact, release smoke prerequisite, canonical real-repository tasks, and README projection that are verified together.

- Current published record generated: 2026-09-19T05:54:02.583Z.
- Source snapshot: `release/source-manifest.json`; raw SHA-256 `15433573f0131f1ee9cc1f2230ced8b84ff7cedc205f9c4bab9bef0076ca344c`.
- Formal paired measurement: `eval-matrix/artifacts/paired-evaluation-latest.json`; raw SHA-256 `ab0e7e06d75dc5c6e2ef606f346e36b647df12d38f0da58809373345e33cfa5b`.
- Release smoke prerequisite: `eval-matrix/artifacts/paired-smoke-latest.json`; raw SHA-256 `6cb0d1b9cb8a63cd2bd59e985b1242a5c7365b2293b6981e1225ea6034a12e69`.
- Model-backend attestation: `release/artifacts/model-backend-attestation.json`; attested 2026-09-19 by project owner (github.com/cyberflax2020).
- Scope: 12 complete pairs (24 side-runs) across the canonical real-repository tasks, using four crossover repeats and zero infrastructure exclusions.
- Reference definition: each reference run is the paired baseline execution recorded in the formal artifact. It is shown only as measurement context within this scope.

### Current public claims

The following product outcomes are regenerated from the validated run matrix rather than copied from narrative text:

- Canvast pass rate: 12/12 (100.0%).
- Reference pass rate: 12/12 (100.0%).
- Pass-rate difference: 0.0 percentage points.
- Median latency: Canvast 27294 ms; reference 12780 ms; difference +14514 ms; ratio 2.1357x.
- Paired outcomes: both passed 12; Canvast-only passed 0; reference-only passed 0; both failed 0.
- Paired uncertainty: 0 discordant pair(s); exact two-sided sign-test p=not defined (no discordant pairs).
- Publication rule: at least 4 complete pairs, zero infrastructure exclusions, strict same-model identity, and exact two-sided p≤0.05. A Canvast directional result additionally requires pass-rate delta ≥+10.0 percentage points and duration ratio ≤1.0000x; a reference directional result uses the inverse thresholds (delta ≤-10.0 percentage points and ratio ≥1.0000x).
- Publication outcome: inconclusive. The validated measurements do not support a relative-performance conclusion for this scope. Same-backend identity is confirmed by the Canvast project (2026-09-19).

Paired product outcome probes:

- **Uninterrupted long-running work.** Verified in the current published record: a bounded sidecar execution completed, the primary task resumed, and both results were integrated.
- **Continuity through context compaction — not demonstrated.** The current published record does not establish that the active request retained its objective and completed a later planned step after runtime compaction.
- **Live plan visibility — not yet confirmed.** The checked-in record is insufficient, so this item is listed openly as unconfirmed rather than claimed.
- **Persistent, exportable Canvas — not yet confirmed.** The checked-in record is insufficient, so this item is listed openly as unconfirmed rather than claimed.

Token accounting:

Cross-side token totals, differences, and ratios are not reported because cache telemetry was not trustworthy for every included run and both aggregate token gates were not satisfied.

### How to verify

Verify the checked-in public record with `npm run verify:public`, or run `node scripts/generate-effectiveness-evidence.mjs verify --readme README.md` to verify the document, summary artifact, and README projection together.

### How to read the results

- Pass rates, latency, paired uncertainty, and any publication outcome apply only to the stated tasks, repeats, reference definition, configuration, and timestamps.
- Token measurements appear only when every included run has trusted observed cache telemetry and both aggregate token-comparison gates allow publication.
- Treat the README evidence block as a concise projection, not the full record.
- Use [Verification and Evidence](guides/testing.md) for the broader verification model and [External Services](reference/external-services.md) for network-boundary context.

---

## 中文

### 这份文档是什么

这份公开文档报告从来源已验证的正式配对测量中重新计算得到的产品结果。它只发布能够从已检入记录重新生成的测量值，并把所有结论限定在实际观测的任务范围内。

### 证据边界

本次测量由已检入的源码快照、正式配对产物、发布冒烟前置条件、规范真实仓库任务，以及共同校验的 README 投影限定。

- 当前公开记录生成时间：2026-09-19T05:54:02.583Z。
- 源码快照：`release/source-manifest.json`；原始 SHA-256 为 `15433573f0131f1ee9cc1f2230ced8b84ff7cedc205f9c4bab9bef0076ca344c`。
- 正式配对测量：`eval-matrix/artifacts/paired-evaluation-latest.json`；原始 SHA-256 为 `ab0e7e06d75dc5c6e2ef606f346e36b647df12d38f0da58809373345e33cfa5b`。
- 发布冒烟前置产物：`eval-matrix/artifacts/paired-smoke-latest.json`；原始 SHA-256 为 `6cb0d1b9cb8a63cd2bd59e985b1242a5c7365b2293b6981e1225ea6034a12e69`。
- 模型后端人工确认：`release/artifacts/model-backend-attestation.json`；由 project owner (github.com/cyberflax2020) 于 2026-09-19 确认。
- 范围：规范真实仓库任务共 12 个完整配对（24 次单侧运行），采用四轮交叉重复且基础设施排除数为零。
- 参考定义：每次参考运行都是正式产物中记录的配对基线执行，仅作为本测量范围内的上下文。

### 当前公开声明

以下产品结果均由已校验的完整运行矩阵重新计算，而不是从叙述性文本复制：

- Canvast 通过率：12/12（100.0%）。
- 参考运行通过率：12/12（100.0%）。
- 通过率差值：0.0 个百分点。
- 中位时延：Canvast 27294 毫秒；参考运行 12780 毫秒；差值 +14514 毫秒；比值 2.1357x。
- 配对结果：两侧均通过 12 个；仅 Canvast 通过 0 个；仅参考运行通过 0 个；两侧均失败 0 个。
- 配对不确定性：结果不一致的配对 0 个；双侧精确符号检验 p=未定义（没有结果不一致的配对）。
- 发布判定规则：至少 4 个完整配对、基础设施排除数为零、严格同模型身份成立，且双侧精确 p≤0.05。Canvast 方向还要求通过率差值 ≥+10.0 个百分点且时延比 ≤1.0000x；参考方向采用反向门槛（差值 ≤-10.0 个百分点且比值 ≥1.0000x）。
- 发布结论：结论未定。已校验的测量结果不足以支持本范围内的相对性能结论。同后端身份由 Canvast 项目确认（2026-09-19）。

配对产品结果探针：

- **长跑任务不中断。** 当前公开记录已验证：有界 sidecar 执行完成后，主任务恢复推进并整合两侧结果。
- **上下文压缩后连续执行——未获验证。** 当前公开记录未能确认：运行时压缩后，当前请求保留原目标并继续完成后续计划步骤。
- **实时计划可见——尚未确认。** 已检入记录不足，此项如实标注为未确认，而不是作为结论宣称。
- **Canvas 持久化与导出——尚未确认。** 已检入记录不足，此项如实标注为未确认，而不是作为结论宣称。

Token 计量：

由于并非每次纳入运行的缓存遥测都可信，且两项聚合 Token 门禁未同时满足，本报告不提供跨运行 Token 总量、差值或比值。

### 如何验证

可通过 `npm run verify:public` 校验当前已检入的公开记录，也可运行 `node scripts/generate-effectiveness-evidence.mjs verify --readme README.md` 同时验证文档、summary 产物和 README 投影。

### 如何理解结果

- 通过率、时延、配对不确定性和发布结论仅适用于所列任务、重复轮次、参考定义、配置与时间范围。
- 只有每次纳入运行都具备可信且已观测的缓存遥测，并且两项聚合 Token 对比门禁都允许发布时，文档才会显示 Token 测量值。
- README 中的证据区块只是精简投影，不是完整记录。
- 更完整的验证模型见 [验证与证据](guides/testing.md)，网络边界说明见 [外部服务边界](reference/external-services.md)。
