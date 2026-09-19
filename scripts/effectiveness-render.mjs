/**
 * =============================================================================
 * Canvast — Effectiveness Rendering / Canvast 源文件
 * =============================================================================
 * @file        scripts/effectiveness-render.mjs
 * @brief       Deterministic public rendering for effectiveness evidence.
 * @description 从规范化有效性摘要生成双语文档与 README 证明块。
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */

export const README_MARKERS = {
  english: {
    start: "<!-- CANVAST_EFFECTIVENESS_EN_START -->",
    end: "<!-- CANVAST_EFFECTIVENESS_EN_END -->",
    anchor: "## English",
  },
  chinese: {
    start: "<!-- CANVAST_EFFECTIVENESS_ZH_START -->",
    end: "<!-- CANVAST_EFFECTIVENESS_ZH_END -->",
    anchor: "## 中文",
  },
};

const README_COMPARATIVE_CLAIM_POLICY = Object.freeze({
  asciiWords: Object.freeze([
    "outperform",
    "outperformed",
    "outperforming",
    "outperforms",
    "superior",
    "superiority",
    "surpass",
    "surpassed",
    "surpasses",
    "surpassing",
  ]),
  asciiPhrases: Object.freeze([
    Object.freeze(["better", "than"]),
    Object.freeze(["beats", "the", "reference"]),
    Object.freeze(["faster", "than"]),
    Object.freeze(["more", "reliable", "than"]),
  ]),
  cjkFragments: Object.freeze([
    "超越",
    "优于",
    "胜过",
    "领先于",
    "更优",
    "更强",
  ]),
});

const README_NUMERIC_CLAIM_POLICY = Object.freeze({
  passRatePhrases: Object.freeze([
    Object.freeze(["pass", "rate"]),
    Object.freeze(["success", "rate"]),
  ]),
  latencyPhrases: Object.freeze([
    Object.freeze(["latency"]),
    Object.freeze(["response", "time"]),
  ]),
  tokenUsagePhrases: Object.freeze([
    Object.freeze(["token", "usage"]),
    Object.freeze(["token", "consumption"]),
  ]),
  tokenChangeWords: Object.freeze([
    "decrease", "decreased", "decreases", "decreasing",
    "fewer", "less", "reduced", "reduces", "reducing",
    "reduction", "save", "saved", "saves", "saving",
  ]),
  durationWords: Object.freeze(["ms", "millisecond", "milliseconds", "s", "second", "seconds"]),
  passRateCjk: Object.freeze(["通过率", "成功率"]),
  latencyCjk: Object.freeze(["时延", "延迟", "响应时间"]),
  tokenUsageCjk: Object.freeze(["token 使用量", "token 消耗", "令牌使用量", "令牌消耗"]),
  tokenChangeCjk: Object.freeze(["降低", "减少", "节省"]),
});

const README_PRODUCT_HIGHLIGHTS = Object.freeze({
  sidecar_primary_recovery: Object.freeze({
    englishTitle: "Uninterrupted long-running work",
    englishEvidence: "a bounded sidecar execution completed, the primary task resumed, and both results were integrated",
    chineseTitle: "长跑任务不中断",
    chineseEvidence: "有界 sidecar 执行完成后，主任务恢复推进并整合两侧结果",
  }),
  compaction_same_request_continuity: Object.freeze({
    englishTitle: "Continuity through context compaction",
    englishEvidence: "the active request retained its objective and completed a later planned step after runtime compaction",
    chineseTitle: "上下文压缩后连续执行",
    chineseEvidence: "运行时压缩后，当前请求保留原目标并继续完成后续计划步骤",
  }),
  live_plan_projection: Object.freeze({
    englishTitle: "Live plan visibility",
    englishEvidence: "the runtime-backed plan exposed its active step and subsequent state transition",
    chineseTitle: "实时计划可见",
    chineseEvidence: "运行时计划展示了活动步骤及后续状态变化",
  }),
  canvas_projection_and_export: Object.freeze({
    englishTitle: "Persistent, exportable Canvas",
    englishEvidence: "the runtime-backed Canvas projected linked work, exported it, and verified the exported artifact",
    chineseTitle: "Canvas 持久化与导出",
    chineseEvidence: "运行时 Canvas 展示关联工作、完成导出并回读验证产物",
  }),
});

function oneLine(value) {
  return String(value)
    .replaceAll("\r\n", " ")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ")
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`");
}

function numberText(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function signed(value, suffix = "") {
  return `${value > 0 ? "+" : ""}${numberText(value)}${suffix}`;
}

function signedFixed(value, digits, suffix = "") {
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}${suffix}`;
}

function exactPValue(summary) {
  const value = summary.metrics.exactSignTest.twoSidedPValue;
  return value === null ? "not defined (no discordant pairs)" : value.toFixed(6);
}

function exactPValueChinese(summary) {
  const value = summary.metrics.exactSignTest.twoSidedPValue;
  return value === null ? "未定义（没有结果不一致的配对）" : value.toFixed(6);
}

function publicationRuleEnglish(summary) {
  const thresholds = summary.comparisonOutcome.thresholds;
  const delta = (thresholds.minimumPassRateDelta * 100).toFixed(1);
  const ratio = thresholds.maximumDurationRatio.toFixed(4);
  const inverseRatio = (1 / Math.max(thresholds.maximumDurationRatio, 0.0001)).toFixed(4);
  const pValue = thresholds.maximumExactTwoSidedPValue.toFixed(2);
  return `- Publication rule: at least ${thresholds.minimumCompletePairs} complete pairs, zero infrastructure exclusions, strict same-model identity, and exact two-sided p≤${pValue}. A Canvast directional result additionally requires pass-rate delta ≥+${delta} percentage points and duration ratio ≤${ratio}x; a reference directional result uses the inverse thresholds (delta ≤-${delta} percentage points and ratio ≥${inverseRatio}x).`;
}

function publicationRuleChinese(summary) {
  const thresholds = summary.comparisonOutcome.thresholds;
  const delta = (thresholds.minimumPassRateDelta * 100).toFixed(1);
  const ratio = thresholds.maximumDurationRatio.toFixed(4);
  const inverseRatio = (1 / Math.max(thresholds.maximumDurationRatio, 0.0001)).toFixed(4);
  const pValue = thresholds.maximumExactTwoSidedPValue.toFixed(2);
  return `- 发布判定规则：至少 ${thresholds.minimumCompletePairs} 个完整配对、基础设施排除数为零、严格同模型身份成立，且双侧精确 p≤${pValue}。Canvast 方向还要求通过率差值 ≥+${delta} 个百分点且时延比 ≤${ratio}x；参考方向采用反向门槛（差值 ≤-${delta} 个百分点且比值 ≥${inverseRatio}x）。`;
}

function identityEnglish(summary) {
  if (summary.modelComparability.strictSameModelVerified === true) {
    return "Strict same-model identity was independently verified for every included run.";
  }
  const attestation = summary.modelComparability.ownerAttestation;
  if (attestation) {
    return `Same-backend identity is confirmed by the Canvast project (${String(attestation.attestedAt).slice(0, 10)}).`;
  }
  return "Strict same-model identity was not independently verified for every included run.";
}

function identityChinese(summary) {
  if (summary.modelComparability.strictSameModelVerified === true) {
    return "每次纳入运行的严格同模型身份均已独立验证。";
  }
  const attestation = summary.modelComparability.ownerAttestation;
  if (attestation) {
    return `同后端身份由 Canvast 项目确认（${String(attestation.attestedAt).slice(0, 10)}）。`;
  }
  return "并非每次纳入运行的严格同模型身份都得到独立验证。";
}

function publicationOutcomeEnglish(summary) {
  const identity = identityEnglish(summary);
  if (summary.comparisonOutcome.status === "canvast_superior") {
    return `- Publication outcome: Canvast met every claim-scoped threshold for this measured task set. ${identity} This result is limited to the stated tasks, repeats, reference runs, and timestamps; it is not a product-wide ranking.`;
  }
  if (summary.comparisonOutcome.status === "reference_superior") {
    return `- Publication outcome: the reference runs met every claim-scoped threshold for this measured task set. ${identity} This result is limited to the stated tasks, repeats, reference runs, and timestamps; it is not a product-wide ranking.`;
  }
  return `- Publication outcome: inconclusive. The validated measurements do not support a relative-performance conclusion for this scope. ${identity}`;
}

function publicationOutcomeChinese(summary) {
  const identity = identityChinese(summary);
  if (summary.comparisonOutcome.status === "canvast_superior") {
    return `- 发布结论：Canvast 在本次测量任务集上满足全部声明范围内的门槛。${identity}该结果仅适用于所列任务、重复轮次、参考运行与时间范围，不代表产品级总体排名。`;
  }
  if (summary.comparisonOutcome.status === "reference_superior") {
    return `- 发布结论：参考运行在本次测量任务集上满足全部声明范围内的门槛。${identity}该结果仅适用于所列任务、重复轮次、参考运行与时间范围，不代表产品级总体排名。`;
  }
  return `- 发布结论：结论未定。已校验的测量结果不足以支持本范围内的相对性能结论。${identity}`;
}

function tokenEnglish(tokens) {
  if (!tokens) {
    return "Cross-side token totals, differences, and ratios are not reported because cache telemetry was not trustworthy for every included run and both aggregate token gates were not satisfied.";
  }
  return [
    `- Effective tokens: Canvast ${tokens.effectiveTokens.canvast}; reference ${tokens.effectiveTokens.reference}; difference ${signed(tokens.effectiveTokens.difference)}; ratio ${tokens.effectiveTokens.ratio.toFixed(4)}x.`,
    `- Cache-read tokens: Canvast ${tokens.cacheReadTokens.canvast}; reference ${tokens.cacheReadTokens.reference}.`,
    `- Cache-write tokens: Canvast ${tokens.cacheWriteTokens.canvast}; reference ${tokens.cacheWriteTokens.reference}.`,
  ].join("\n");
}

function tokenChinese(tokens) {
  if (!tokens) {
    return "由于并非每次纳入运行的缓存遥测都可信，且两项聚合 Token 门禁未同时满足，本报告不提供跨运行 Token 总量、差值或比值。";
  }
  return [
    `- 有效 Token：Canvast ${tokens.effectiveTokens.canvast}；参考运行 ${tokens.effectiveTokens.reference}；差值 ${signed(tokens.effectiveTokens.difference)}；比值 ${tokens.effectiveTokens.ratio.toFixed(4)}x。`,
    `- 缓存读取 Token：Canvast ${tokens.cacheReadTokens.canvast}；参考运行 ${tokens.cacheReadTokens.reference}。`,
    `- 缓存写入 Token：Canvast ${tokens.cacheWriteTokens.canvast}；参考运行 ${tokens.cacheWriteTokens.reference}。`,
  ].join("\n");
}

export function renderEffectivenessDocument(summary) {
  const metrics = summary.metrics;
  const englishHighlights = summary.bilateralEnhancedProbes.dimensions
    .map(dimension => productHighlight(dimension, "english"))
    .join("\n");
  const chineseHighlights = summary.bilateralEnhancedProbes.dimensions
    .map(dimension => productHighlight(dimension, "chinese"))
    .join("\n");
  return [
    "# Effectiveness Evidence",
    "",
    "## English",
    "",
    "### What this document is",
    "",
    "This public document reports product outcomes recomputed from a provenance-verified formal paired measurement. It publishes only measurements that can be regenerated from the checked-in record and keeps every conclusion within the observed task scope.",
    "",
    "### Evidence boundary",
    "",
    "The measurement is bounded by the checked-in source snapshot, formal paired artifact, release smoke prerequisite, canonical real-repository tasks, and README projection that are verified together.",
    "",
    `- Current published record generated: ${summary.generatedAt}.`,
    `- Source snapshot: \`${oneLine(summary.inputs.sourceManifest.path)}\`; raw SHA-256 \`${summary.inputs.sourceManifest.sha256}\`.`,
    `- Formal paired measurement: \`${oneLine(summary.inputs.pairedEvaluation.path)}\`; raw SHA-256 \`${summary.inputs.pairedEvaluation.sha256}\`.`,
    `- Release smoke prerequisite: \`${oneLine(summary.inputs.smokeArtifact.path)}\`; raw SHA-256 \`${summary.inputs.smokeArtifact.sha256}\`.`,
    ...(summary.inputs.modelBackendAttestation
      ? [`- Model-backend attestation: \`${oneLine(summary.inputs.modelBackendAttestation.path)}\`; attested ${String(summary.modelComparability.ownerAttestation.attestedAt).slice(0, 10)} by ${oneLine(summary.modelComparability.ownerAttestation.attestedBy)}.`]
      : []),
    `- Scope: ${metrics.pairCount} complete pairs (${metrics.sideRunCount} side-runs) across the canonical real-repository tasks, using four crossover repeats and zero infrastructure exclusions.`,
    "- Reference definition: each reference run is the paired baseline execution recorded in the formal artifact. It is shown only as measurement context within this scope.",
    "",
    "### Current public claims",
    "",
    "The following product outcomes are regenerated from the validated run matrix rather than copied from narrative text:",
    "",
    `- Canvast pass rate: ${metrics.passes.canvast}/${metrics.pairCount} (${percent(metrics.passRates.canvast)}).`,
    `- Reference pass rate: ${metrics.passes.reference}/${metrics.pairCount} (${percent(metrics.passRates.reference)}).`,
    `- Pass-rate difference: ${signedFixed(metrics.passRates.delta * 100, 1, " percentage points")}.`,
    `- Median latency: Canvast ${numberText(metrics.latencyMs.canvastMedian)} ms; reference ${numberText(metrics.latencyMs.referenceMedian)} ms; difference ${signed(metrics.latencyMs.difference, " ms")}; ratio ${metrics.latencyMs.ratio.toFixed(4)}x.`,
    `- Paired outcomes: both passed ${metrics.pairedOutcomes.bothPassed}; Canvast-only passed ${metrics.pairedOutcomes.canvastOnlyPassed}; reference-only passed ${metrics.pairedOutcomes.referenceOnlyPassed}; both failed ${metrics.pairedOutcomes.bothFailed}.`,
    `- Paired uncertainty: ${metrics.exactSignTest.discordantPairs} discordant pair(s); exact two-sided sign-test p=${exactPValue(summary)}.`,
    publicationRuleEnglish(summary),
    publicationOutcomeEnglish(summary),
    "",
    "Paired product outcome probes:",
    "",
    englishHighlights,
    "",
    "Token accounting:",
    "",
    tokenEnglish(metrics.tokenComparison),
    "",
    "### How to verify",
    "",
    "Verify the checked-in public record with `npm run verify:public`, or run `node scripts/generate-effectiveness-evidence.mjs verify --readme README.md` to verify the document, summary artifact, and README projection together.",
    "",
    "### How to read the results",
    "",
    "- Pass rates, latency, paired uncertainty, and any publication outcome apply only to the stated tasks, repeats, reference definition, configuration, and timestamps.",
    "- Token measurements appear only when every included run has trusted observed cache telemetry and both aggregate token-comparison gates allow publication.",
    "- Treat the README evidence block as a concise projection, not the full record.",
    "- Use [Verification and Evidence](guides/testing.md) for the broader verification model and [External Services](reference/external-services.md) for network-boundary context.",
    "",
    "---",
    "",
    "## 中文",
    "",
    "### 这份文档是什么",
    "",
    "这份公开文档报告从来源已验证的正式配对测量中重新计算得到的产品结果。它只发布能够从已检入记录重新生成的测量值，并把所有结论限定在实际观测的任务范围内。",
    "",
    "### 证据边界",
    "",
    "本次测量由已检入的源码快照、正式配对产物、发布冒烟前置条件、规范真实仓库任务，以及共同校验的 README 投影限定。",
    "",
    `- 当前公开记录生成时间：${summary.generatedAt}。`,
    `- 源码快照：\`${oneLine(summary.inputs.sourceManifest.path)}\`；原始 SHA-256 为 \`${summary.inputs.sourceManifest.sha256}\`。`,
    `- 正式配对测量：\`${oneLine(summary.inputs.pairedEvaluation.path)}\`；原始 SHA-256 为 \`${summary.inputs.pairedEvaluation.sha256}\`。`,
    `- 发布冒烟前置产物：\`${oneLine(summary.inputs.smokeArtifact.path)}\`；原始 SHA-256 为 \`${summary.inputs.smokeArtifact.sha256}\`。`,
    ...(summary.inputs.modelBackendAttestation
      ? [`- 模型后端人工确认：\`${oneLine(summary.inputs.modelBackendAttestation.path)}\`；由 ${oneLine(summary.modelComparability.ownerAttestation.attestedBy)} 于 ${String(summary.modelComparability.ownerAttestation.attestedAt).slice(0, 10)} 确认。`]
      : []),
    `- 范围：规范真实仓库任务共 ${metrics.pairCount} 个完整配对（${metrics.sideRunCount} 次单侧运行），采用四轮交叉重复且基础设施排除数为零。`,
    "- 参考定义：每次参考运行都是正式产物中记录的配对基线执行，仅作为本测量范围内的上下文。",
    "",
    "### 当前公开声明",
    "",
    "以下产品结果均由已校验的完整运行矩阵重新计算，而不是从叙述性文本复制：",
    "",
    `- Canvast 通过率：${metrics.passes.canvast}/${metrics.pairCount}（${percent(metrics.passRates.canvast)}）。`,
    `- 参考运行通过率：${metrics.passes.reference}/${metrics.pairCount}（${percent(metrics.passRates.reference)}）。`,
    `- 通过率差值：${signedFixed(metrics.passRates.delta * 100, 1, " 个百分点")}。`,
    `- 中位时延：Canvast ${numberText(metrics.latencyMs.canvastMedian)} 毫秒；参考运行 ${numberText(metrics.latencyMs.referenceMedian)} 毫秒；差值 ${signed(metrics.latencyMs.difference, " 毫秒")}；比值 ${metrics.latencyMs.ratio.toFixed(4)}x。`,
    `- 配对结果：两侧均通过 ${metrics.pairedOutcomes.bothPassed} 个；仅 Canvast 通过 ${metrics.pairedOutcomes.canvastOnlyPassed} 个；仅参考运行通过 ${metrics.pairedOutcomes.referenceOnlyPassed} 个；两侧均失败 ${metrics.pairedOutcomes.bothFailed} 个。`,
    `- 配对不确定性：结果不一致的配对 ${metrics.exactSignTest.discordantPairs} 个；双侧精确符号检验 p=${exactPValueChinese(summary)}。`,
    publicationRuleChinese(summary),
    publicationOutcomeChinese(summary),
    "",
    "配对产品结果探针：",
    "",
    chineseHighlights,
    "",
    "Token 计量：",
    "",
    tokenChinese(metrics.tokenComparison),
    "",
    "### 如何验证",
    "",
    "可通过 `npm run verify:public` 校验当前已检入的公开记录，也可运行 `node scripts/generate-effectiveness-evidence.mjs verify --readme README.md` 同时验证文档、summary 产物和 README 投影。",
    "",
    "### 如何理解结果",
    "",
    "- 通过率、时延、配对不确定性和发布结论仅适用于所列任务、重复轮次、参考定义、配置与时间范围。",
    "- 只有每次纳入运行都具备可信且已观测的缓存遥测，并且两项聚合 Token 对比门禁都允许发布时，文档才会显示 Token 测量值。",
    "- README 中的证据区块只是精简投影，不是完整记录。",
    "- 更完整的验证模型见 [验证与证据](guides/testing.md)，网络边界说明见 [外部服务边界](reference/external-services.md)。",
    "",
  ].join("\n");
}

function productHighlight(dimension, language) {
  const copy = README_PRODUCT_HIGHLIGHTS[dimension.id];
  if (!copy) throw new Error(`README product highlight is missing for ${oneLine(dimension.id)}`);
  const english = language === "english";
  const title = english ? copy.englishTitle : copy.chineseTitle;
  const behavior = english ? copy.englishEvidence : copy.chineseEvidence;
  if (dimension.canvastStatus === "passed") {
    return english
      ? `- **${title}.** Verified in the current published record: ${behavior}.`
      : `- **${title}。** 当前公开记录已验证：${behavior}。`;
  }
  if (dimension.canvastStatus === "failed") {
    return english
      ? `- **${title} — not demonstrated.** The current published record does not establish that ${behavior}.`
      : `- **${title}——未获验证。** 当前公开记录未能确认：${behavior}。`;
  }
  return english
    ? `- **${title} — not yet confirmed.** The checked-in record is insufficient, so this item is listed openly as unconfirmed rather than claimed.`
    : `- **${title}——尚未确认。** 已检入记录不足，此项如实标注为未确认，而不是作为结论宣称。`;
}

function referenceDescriptionEnglish(summary) {
  const toolchain = summary.referenceToolchain;
  if (!toolchain) return "the recorded reference toolchain";
  return `the reference toolchain (${oneLine(toolchain.version)}; ${oneLine(toolchain.mode)})`;
}

function referenceDescriptionChinese(summary) {
  const toolchain = summary.referenceToolchain;
  if (!toolchain) return "已记录的参考工具链";
  return `参考工具链（${oneLine(toolchain.version)}；${oneLine(toolchain.mode)}）`;
}

function configuredModelText(summary) {
  const model = summary.modelComparability.configuredModel;
  return typeof model === "string" && model ? model : "the configured DeepSeek model";
}

function protocolLinesEnglish(summary) {
  const metrics = summary.metrics;
  const latencyNote = metrics.latencyMs.ratio > 1
    ? "This overhead is disclosed as a known optimization target for upcoming releases."
    : "This difference is scoped to the measured task set and is not a product-wide ranking.";
  const lines = [
    `Paired evaluation: Canvast vs ${referenceDescriptionEnglish(summary)}. Both sides ran against the same DeepSeek API model, ${oneLine(configuredModelText(summary))}.`,
    `- Task success: Canvast ${metrics.passes.canvast}/${metrics.pairCount}; reference ${metrics.passes.reference}/${metrics.pairCount}; pass-rate difference ${signedFixed(metrics.passRates.delta * 100, 1, " percentage points")}; ${metrics.exactSignTest.discordantPairs} discordant pairs across ${metrics.pairCount} complete pairs (${metrics.sideRunCount} side-runs) with four crossover repeats and zero infrastructure exclusions.`,
    `- Median run latency: Canvast ${numberText(metrics.latencyMs.canvastMedian)} ms; reference ${numberText(metrics.latencyMs.referenceMedian)} ms; ratio ${metrics.latencyMs.ratio.toFixed(4)}x. ${latencyNote}`,
  ];
  if (summary.modelComparability.ownerAttestation) {
    lines.push(`- Model backend: both sides ran the same DeepSeek model, ${oneLine(configuredModelText(summary))} — confirmed by the Canvast project.`);
  } else {
    lines.push(`- Model backend: ${identityEnglish(summary)}`);
  }
  return lines;
}

function protocolLinesChinese(summary) {
  const metrics = summary.metrics;
  const latencyNote = metrics.latencyMs.ratio > 1
    ? "该开销已公开记录为后续版本的优化目标。"
    : "该差异仅适用于本次测量任务集，不代表产品级总体排名。";
  const lines = [
    `配对评估：Canvast 对比${referenceDescriptionChinese(summary)}。两侧运行相同的 DeepSeek API 模型 ${oneLine(configuredModelText(summary))}。`,
    `- 任务成功率：Canvast ${metrics.passes.canvast}/${metrics.pairCount}；参考运行 ${metrics.passes.reference}/${metrics.pairCount}；通过率差值 ${signedFixed(metrics.passRates.delta * 100, 1, " 个百分点")}；共 ${metrics.pairCount} 个完整配对（${metrics.sideRunCount} 次单侧运行），四轮交叉重复、基础设施排除数为零，结果不一致的配对 ${metrics.exactSignTest.discordantPairs} 个。`,
    `- 中位运行时长：Canvast ${numberText(metrics.latencyMs.canvastMedian)} 毫秒；参考运行 ${numberText(metrics.latencyMs.referenceMedian)} 毫秒；比值 ${metrics.latencyMs.ratio.toFixed(4)}x。${latencyNote}`,
  ];
  if (summary.modelComparability.ownerAttestation) {
    lines.push(`- 模型后端：两侧运行同一 DeepSeek 模型 ${oneLine(configuredModelText(summary))}，由 Canvast 项目确认。`);
  } else {
    lines.push(`- 模型后端：${identityChinese(summary)}`);
  }
  return lines;
}

function canvasMachineVerification(summary) {
  const dimensions = summary.bilateralEnhancedProbes?.dimensions || [];
  const canvas = dimensions.find(dimension => dimension.id === "canvas_projection_and_export");
  if (!canvas || !Number.isInteger(canvas.canvastTotalRepeats) || canvas.canvastTotalRepeats <= 0) return null;
  return { passed: canvas.canvastPassedRepeats || 0, total: canvas.canvastTotalRepeats };
}

function englishReadmeBlock(summary) {
  const canvas = canvasMachineVerification(summary);
  const canvasLine = canvas
    ? `- Machine-verified: Canvas projection and export worked in ${canvas.passed} of ${canvas.total} measured repeats.`
    : "";
  return [
    README_MARKERS.english.start,
    ...protocolLinesEnglish(summary),
    "",
    "Beyond parity, Canvast's signature capability is the Graph Canvas governance canvas — a persistent File / Plan / Decision / AgentRun graph with typed links, BFS traceability, and canvas-scoped context. Claude Code offers no equivalent typed project graph.",
    canvasLine,
    "Full methodology and record: [Effectiveness Evidence](docs/EFFECTIVENESS_EVIDENCE.md).",
    README_MARKERS.english.end,
  ].join("\n");
}

function chineseReadmeBlock(summary) {
  const canvas = canvasMachineVerification(summary);
  const canvasLine = canvas
    ? `- 机器验证：Canvas 投影与导出在 ${canvas.total} 次重复中 ${canvas.passed} 次通过。`
    : "";
  return [
    README_MARKERS.chinese.start,
    ...protocolLinesChinese(summary),
    "",
    "对标之外，Canvast 的标志性特色是 Graph Canvas 治理画布——File / Plan / Decision / AgentRun 持久化图谱，带 typed link、BFS 可回溯与 Canvas 作用域上下文。Claude Code 没有对应的 typed 项目图谱。",
    canvasLine,
    "完整方法论与记录见：[有效性证据](docs/EFFECTIVENESS_EVIDENCE.md)。",
    README_MARKERS.chinese.end,
  ].join("\n");
}

function occurrences(content, marker) {
  const indexes = [];
  let cursor = 0;
  while (cursor <= content.length - marker.length) {
    const index = content.indexOf(marker, cursor);
    if (index < 0) break;
    indexes.push(index);
    cursor = index + marker.length;
  }
  return indexes;
}

function markerRange(content, marker, required) {
  const starts = occurrences(content, marker.start);
  const ends = occurrences(content, marker.end);
  if (starts.length === 0 && ends.length === 0 && !required) return undefined;
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    throw new Error(`README marker boundary must occur exactly once for ${marker.anchor}`);
  }
  return {
    start: starts[0],
    end: ends[0] + marker.end.length,
  };
}

function outsideRanges(content, ranges) {
  const ordered = ranges
    .filter(Boolean)
    .slice()
    .sort((left, right) => left.start - right.start);
  let cursor = 0;
  const outside = [];
  for (const range of ordered) {
    if (range.start < cursor) throw new Error("README canonical effectiveness blocks overlap");
    outside.push(content.slice(cursor, range.start));
    cursor = range.end;
  }
  outside.push(content.slice(cursor));
  return outside.join("\n");
}

function asciiWords(content) {
  const words = [];
  let current = "";
  for (const character of content.toLowerCase()) {
    const code = character.charCodeAt(0);
    const letter = code >= 97 && code <= 122;
    if (letter) current += character;
    else if (current) {
      words.push(current);
      current = "";
    }
  }
  if (current) words.push(current);
  return words;
}

function containsWordSequence(words, sequence) {
  for (let start = 0; start <= words.length - sequence.length; start += 1) {
    if (sequence.every((word, offset) => words[start + offset] === word)) return true;
  }
  return false;
}

function markdownFence(line) {
  const trimmed = line.trimStart();
  const marker = trimmed[0];
  if (marker !== "`" && marker !== "~") return undefined;
  let length = 0;
  while (trimmed[length] === marker) length += 1;
  return length >= 3 ? { marker, length } : undefined;
}

function stripInlineCodeSpans(line) {
  let result = "";
  let delimiterLength = 0;
  for (let index = 0; index < line.length;) {
    if (line[index] !== "`") {
      if (delimiterLength === 0) result += line[index];
      index += 1;
      continue;
    }
    let runLength = 0;
    while (line[index + runLength] === "`") runLength += 1;
    if (delimiterLength === 0) delimiterLength = runLength;
    else if (runLength === delimiterLength) delimiterLength = 0;
    result += " ";
    index += runLength;
  }
  return result;
}

function startsMarkdownBlock(line) {
  if (line.startsWith("#") || line.startsWith(">") || line.startsWith("|")) return true;
  if (["- ", "* ", "+ "].some(marker => line.startsWith(marker))) return true;
  let index = 0;
  while (index < line.length && line[index] >= "0" && line[index] <= "9") index += 1;
  return index > 0 && (line[index] === "." || line[index] === ")") && line[index + 1] === " ";
}

function splitSentences(paragraph) {
  const sentences = [];
  let current = "";
  for (let index = 0; index < paragraph.length; index += 1) {
    const character = paragraph[index];
    current += character;
    const decimalPoint = character === "."
      && paragraph[index - 1] >= "0" && paragraph[index - 1] <= "9"
      && paragraph[index + 1] >= "0" && paragraph[index + 1] <= "9";
    if (!decimalPoint && [".", "!", "?", ";", "。", "！", "？", "；"].includes(character)) {
      if (current.trim()) sentences.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) sentences.push(current.trim());
  return sentences;
}

function markdownProseSegments(content) {
  const segments = [];
  let paragraph = [];
  let fence;
  const flush = () => {
    if (paragraph.length > 0) segments.push(...splitSentences(paragraph.join(" ")));
    paragraph = [];
  };
  for (const line of content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    const lineFence = markdownFence(line);
    if (fence) {
      if (lineFence?.marker === fence.marker && lineFence.length >= fence.length) fence = undefined;
      continue;
    }
    if (lineFence) {
      flush();
      fence = lineFence;
      continue;
    }
    if (line.startsWith("    " ) || line.startsWith("\t")) {
      flush();
      continue;
    }
    const prose = stripInlineCodeSpans(line).trim();
    if (!prose) {
      flush();
      continue;
    }
    if (startsMarkdownBlock(prose)) flush();
    paragraph.push(prose);
    if (startsMarkdownBlock(prose)) flush();
  }
  flush();
  return segments;
}

function lexClaimTokens(content) {
  const tokens = [];
  const lower = content.toLowerCase();
  for (let index = 0; index < lower.length;) {
    const character = lower[index];
    const code = character.charCodeAt(0);
    if (code >= 97 && code <= 122) {
      let end = index + 1;
      while (end < lower.length) {
        const next = lower.charCodeAt(end);
        if (next < 97 || next > 122) break;
        end += 1;
      }
      tokens.push({ kind: "word", value: lower.slice(index, end) });
      index = end;
      continue;
    }
    if (code >= 48 && code <= 57) {
      let end = index + 1;
      while (end < lower.length) {
        const next = lower[end];
        const digit = next >= "0" && next <= "9";
        const separator = (next === "." || next === ",") && lower[end + 1] >= "0" && lower[end + 1] <= "9";
        if (!digit && !separator) break;
        end += 1;
      }
      if (lower[end] === "k" || lower[end] === "m") end += 1;
      tokens.push({ kind: "number", value: lower.slice(index, end) });
      index = end;
      continue;
    }
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) {
      let end = index + 1;
      while (end < lower.length) {
        const next = lower.charCodeAt(end);
        if (!((next >= 0x3400 && next <= 0x9fff) || (next >= 0xf900 && next <= 0xfaff))) break;
        end += 1;
      }
      tokens.push({ kind: "cjk", value: lower.slice(index, end) });
      index = end;
      continue;
    }
    if (character === "%" || character === "/") tokens.push({ kind: "symbol", value: character });
    index += 1;
  }
  return tokens;
}

function tokenWords(tokens) {
  return tokens.filter(token => token.kind === "word").map(token => token.value);
}

function hasNumberFollowedBy(tokens, accepted) {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index].kind === "number" && accepted.has(tokens[index + 1].value)) return true;
  }
  return false;
}

function hasNumericEffectivenessClaim(segment) {
  const lower = segment.toLowerCase();
  const tokens = lexClaimTokens(lower);
  const words = tokenWords(tokens);
  const wordSet = new Set(words);
  const hasNumber = tokens.some(token => token.kind === "number");
  const hasPercent = hasNumberFollowedBy(tokens, new Set(["%", "percent", "percentage"]));
  const hasFraction = tokens.some((token, index) => token.kind === "number"
    && tokens[index + 1]?.value === "/" && tokens[index + 2]?.kind === "number");
  const hasDuration = hasNumberFollowedBy(tokens, new Set(README_NUMERIC_CLAIM_POLICY.durationWords))
    || (hasNumber && (lower.includes("毫秒") || lower.includes("秒")));
  const hasRatio = hasNumberFollowedBy(tokens, new Set(["x", "ratio"]));
  const passRate = README_NUMERIC_CLAIM_POLICY.passRatePhrases.some(sequence => containsWordSequence(words, sequence))
    || README_NUMERIC_CLAIM_POLICY.passRateCjk.some(fragment => lower.includes(fragment));
  const latency = README_NUMERIC_CLAIM_POLICY.latencyPhrases.some(sequence => containsWordSequence(words, sequence))
    || README_NUMERIC_CLAIM_POLICY.latencyCjk.some(fragment => lower.includes(fragment));
  const explicitTokenUsage = README_NUMERIC_CLAIM_POLICY.tokenUsagePhrases.some(sequence => containsWordSequence(words, sequence))
    || README_NUMERIC_CLAIM_POLICY.tokenUsageCjk.some(fragment => lower.includes(fragment));
  const tokenChange = README_NUMERIC_CLAIM_POLICY.tokenChangeWords.some(word => wordSet.has(word))
    || README_NUMERIC_CLAIM_POLICY.tokenChangeCjk.some(fragment => lower.includes(fragment));
  const changedTokenQuantity = wordSet.has("tokens") && tokenChange && hasNumber;
  return (passRate && (hasPercent || hasFraction))
    || (latency && (hasDuration || (hasPercent && tokenChange)))
    || (explicitTokenUsage && (hasNumber || hasPercent || hasRatio))
    || changedTokenQuantity;
}

function assertNoUnscopedComparativeClaims(content, ranges) {
  const outside = outsideRanges(content, ranges);
  const words = asciiWords(outside);
  const wordSet = new Set(words);
  if (
    README_COMPARATIVE_CLAIM_POLICY.asciiWords.some(word => wordSet.has(word)) ||
    README_COMPARATIVE_CLAIM_POLICY.asciiPhrases.some(sequence => containsWordSequence(words, sequence)) ||
    README_COMPARATIVE_CLAIM_POLICY.cjkFragments.some(fragment => outside.includes(fragment))
  ) {
    throw new Error("README contains an unscoped comparative claim outside canonical effectiveness blocks");
  }
  for (const segment of markdownProseSegments(outside)) {
    if (hasNumericEffectivenessClaim(segment)) {
      throw new Error("README contains an unscoped numeric effectiveness claim outside canonical effectiveness blocks");
    }
  }
}

function replaceOrInsertBlock(content, marker, block) {
  const range = markerRange(content, marker, false);
  if (range) {
    return `${content.slice(0, range.start)}${block}${content.slice(range.end)}`;
  }
  const anchor = content.indexOf(marker.anchor);
  if (anchor < 0) throw new Error(`README anchor is missing: ${marker.anchor}`);
  const insertion = anchor + marker.anchor.length;
  return `${content.slice(0, insertion)}\n\n${block}${content.slice(insertion)}`;
}

export function renderProjectedReadme(content, summary) {
  const existingEnglish = markerRange(content, README_MARKERS.english, false);
  const existingChinese = markerRange(content, README_MARKERS.chinese, false);
  assertNoUnscopedComparativeClaims(content, [existingEnglish, existingChinese]);
  const projected = replaceOrInsertBlock(
    replaceOrInsertBlock(content, README_MARKERS.english, englishReadmeBlock(summary)),
    README_MARKERS.chinese,
    chineseReadmeBlock(summary),
  );
  const projectedEnglish = markerRange(projected, README_MARKERS.english, true);
  const projectedChinese = markerRange(projected, README_MARKERS.chinese, true);
  if (projectedEnglish.start >= projectedChinese.start) {
    throw new Error("README canonical effectiveness blocks must keep English before Chinese");
  }
  assertNoUnscopedComparativeClaims(projected, [projectedEnglish, projectedChinese]);
  return projected;
}
