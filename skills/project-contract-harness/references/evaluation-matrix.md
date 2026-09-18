# Evaluation Matrix And Gap Closure

## Table Of Contents

- Purpose
- Matrix Contract
- Discriminative Oracles
- Layered Tests
- Gap Closure Loop
- Outcome And Compliance
- Report Discipline
- Missing Control Planes

## Purpose

Use an evaluation matrix whenever success depends on behavior, not only file
existence. The matrix turns product claims into observable cases. A generated
summary is not evidence; it is only a hypothesis to test.

The harness should be able to create its own matrix for a new project by
reading the mission, risks, user constraints, and architecture, then deriving
the smallest set of cases that can falsify the important claims.

## Matrix Contract

Persist matrix state in:

```text
.project-contract-harness/
  EVAL_MATRIX.md
  GAPS.md
  eval-matrix.json
  gaps.json
```

Each matrix case should include:

```json
{
  "id": "case-001",
  "dimension": "capability-area",
  "level": "L2",
  "claim": "The behavior this case can prove or falsify",
  "setup": "Fixture, command, prompt, environment, or manual setup",
  "oracle": "Objective pass condition",
  "command": "Rerunnable command or manual-check protocol",
  "resource_limits": {
    "timeout_seconds": 120,
    "max_processes": 1,
    "max_external_calls": 0
  },
  "status": "open",
  "last_evidence": "",
  "artifact_id": "",
  "gap_id": ""
}
```

Choose dimensions from the project, not from a fixed template. Common dimensions
include:

- functional correctness,
- persistence and recovery,
- permissions and destructive-operation safety,
- context retention and compaction,
- tool selection and side effects,
- sub-agent orchestration,
- external factual grounding,
- package integrity,
- user-visible workflow behavior,
- performance and resource limits.

Suites and runners are project-specific. Record the command that actually runs
the case in `TOOLING.md`; do not rely on the bundled bootstrap scripts to prove
project behavior.

## Discriminative Oracles

Prefer checks that can say yes or no without trusting prose:

- schema validation,
- unit, regression, integration, and end-to-end tests,
- AST or parser-backed checks,
- property tests or invariant checks,
- golden-file or snapshot comparisons,
- CLI exit codes and structured JSON output,
- tool-event counts and state-transition assertions,
- side-effect snapshots before and after a command,
- package file listing and denylist checks,
- live smoke tests against real dependencies when the claim depends on them.

For model or agent behavior, require structured evidence blocks or tool events
that a parser can check. Natural-language explanations may accompany evidence,
but they must not be the only oracle for required gates.

Negative cases matter. Include at least one case that should fail or be rejected
for each safety-critical capability, such as dangerous commands, invalid config,
missing credentials, stale state, or out-of-scope file edits.

## Layered Tests

Organize tests by level so each iteration knows what must rerun:

| Level | Purpose | Examples | When To Run |
|---|---|---|---|
| L0 static | Catch syntax, type, schema, package, and policy drift | typecheck, lint, schema, package list, secret scan | every code or package change |
| L1 unit | Prove local functions and state machines | parser, gate checker, task model, resource guard | every touched module |
| L2 integration | Prove module contracts and side effects | CLI command, plugin dispatch, file state, dependency audit | shared APIs, scripts, plugins |
| L3 workflow | Prove user-visible or agent workflow behavior | plan->task->run->evidence, sub-agent orchestration, recovery | behavior changes |
| L4 live/effect | Prove real external or model-dependent behavior | real provider smoke, GUI state, same-prompt comparison, packaging install | delivery, claims, external dependencies |
| L5 negative | Prove unsafe or invalid behavior is rejected | destructive command, missing key, stale state, forbidden package file | safety and compliance changes |

Each matrix case should declare its level. Closing a gap requires the targeted
case plus the smallest regression layer that could have been affected. Major or
shared changes require climbing the stack to workflow/live gates.

## Gap Closure Loop

After running the matrix:

1. Parse every failed, timed-out, skipped, or missing-evidence case.
2. Create or update a row in `GAPS.md` and an item in `gaps.json`.
3. Classify each gap as required, optional, blocked, or dropped.
4. For every required gap, assign one implementation slice with owned files and
   a targeted rerun command.
5. Fix only that slice.
6. Rerun the targeted case.
7. If it passes, rerun the affected regression layer and any broader gate that
   can catch integration drift.
8. Record evidence in `EVIDENCE.md`, `eval-matrix.json`, and `gaps.json`.
9. Close the gap only after targeted, regression, and broader evidence are
   current.

Do not deliver while required gaps are `open`, `in_progress`,
`implemented_unverified`, or `blocked`, unless the user explicitly changes the
scope and the decision is recorded.

## Matrix Evolution

The matrix should grow as the project reveals new failure modes:

1. Add a suite or dimension when a new behavior family, risk, or user constraint
   appears.
2. Add at least one positive case and relevant negative cases for safety or
   compliance behavior.
3. Assign a layer from L0-L5 and a project-specific runner command.
4. Store raw run outputs under the centralized artifact root and index them.
5. Update gates when the suite becomes required for delivery.
6. Record rationale and regression impact in `DECISIONS.md` or `events.jsonl`.

Never bypass the matrix with an ad hoc one-off check for required behavior. Add
the check to the harness, run it, and close any resulting gaps through evidence.

## Outcome And Compliance

The final goal is not to maximize implementation volume. It is to satisfy the
requested effect and constraints.

Before declaring delivery:

1. Restate the user-visible outcome.
2. Map each non-negotiable constraint to a gate or matrix case.
3. Confirm documentation, package, privacy, resource, and safety requirements.
4. Confirm all required gaps are verified or explicitly out of scope.
5. Confirm public or handoff claims only mention verified behavior.

Effect compliance beats local optimism. If code exists but the user-visible
workflow, live behavior, package, or compliance requirement fails, the task is
not done.

## Report Discipline

Reports must separate:

- measured facts,
- generated interpretation,
- stale or historical evidence,
- missing evidence,
- blocked live dependencies,
- required gaps,
- optional improvement backlog.

A report that lists gaps is not progress by itself. Its value is that each
required gap now has an owner, command, evidence target, and closure status.

Do not compare against a baseline unless the baseline was actually run under
recorded conditions. If the counterpart cannot run, mark the comparison gate
blocked or downgrade the claim to non-comparative.

## Missing Control Planes

When designing a new harness, check for these often-missed controls:

- **Oracle first**: define the discriminator before implementing the feature.
- **Evidence freshness**: invalidate evidence when relevant code, config,
  prompt, dependency, or environment changes.
- **Side-effect isolation**: snapshot files, env, credentials, caches, and
  external state touched by tests; restore or report drift.
- **Resource guard**: bound process count, runtime, output bytes, concurrency,
  and cleanup; kill process groups, not only parent shells.
- **Stale-state detection**: re-read files and contract state before editing
  after interruptions or concurrent work.
- **Dependency and license proof**: adopted external modules require license
  recording and effect tests, not only import success.
- **Security negatives**: prove blocked behavior is actually blocked.
- **Package gate**: verify the exact package contents, not only source files.
- **User-facing truth gate**: remove unverified, benchmark, or internal framing
  from public copy.
- **Handoff replay**: a fresh agent should be able to resume from the contract
  and rerun the latest gates without hidden chat context.
