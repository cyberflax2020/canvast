# Templates

## Contract Directory

The initializer script writes these templates automatically. Use this file when
manual setup is needed. These are bootstrap templates; real projects should add
project-specific commands, suites, and resource controls after repository
analysis.

## CONTRACT.md

```markdown
# Project Contract

## Mission

Describe the product outcome in one paragraph.

## Scope

- In scope:
- Out of scope:

## Non-Negotiable Constraints

- Do not expose secrets, personal paths, hostnames, or private project details.
- Preserve user changes and avoid concurrent writes to shared files.
- Treat verified evidence as the only basis for completion claims.
- Establish and maintain the project harness before broad implementation.

## Delivery Gates

The authoritative machine-readable gates live in `gates.json`.
```

## PLAN.md

```markdown
# Plan

## Current Phase

Status: open

## Active Slice

- Objective:
- Owned files:
- Non-goals:
- Acceptance command:
- Stop conditions:

## Phase Plan

| ID | Phase | Status | Acceptance |
|---|---|---|---|
| P0 | Discovery and contract setup | open | Contract files initialized and checked |
| P1 | Project-specific tooling and eval design | open | TOOLING and EVAL_MATRIX name real project checks |
| P2 | Implementation | open | Focused tests pass |
| P3 | Verification | open | Layered regression, gaps, and outcome gates pass |
| P4 | Package and handoff | open | Privacy scan and package checks pass |
```

## TASKS.md

```markdown
# Tasks

This is the durable todo list. Update it after each meaningful milestone and
before every handoff.

| ID | Required | State | Task | Depends On | Acceptance | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| task-001 | true | verified | Initialize project contract harness |  | Contract directory exists and checker can run | generated during initialization |  |
```

## STATUS.md

```markdown
# Status

- Current phase: open
- Active slice:
- Last verified command:
- Current blocker:
- Next action:

## Gate Summary

| Gate | State | Evidence |
|---|---|---|
```

## STARTUP.md

```markdown
# Startup And Recovery

Use this file at the beginning of every session, resumed run, takeover,
module task, feature request, or bug fix.

## Required Startup Sequence

1. Probe for `.project-contract-harness/` before new planning.
2. If it exists, recover from existing state before implementation.
3. If it is missing, initialize it.
4. If it is incomplete, add only missing current-version files without
   overwriting existing state.
5. Read the durable files listed in `HANDOFF.md`.
6. Inspect repo status and concurrent-writer signals before editing.
7. Rebuild the current working slice from tasks, gaps, gates, evidence,
   tooling, secret access, artifact index, and risks.
8. Run the structural checker with unverified gates allowed.

## Last Startup Check

- Time:
- Existing harness found:
- Missing files added:
- State files read:
- Concurrent writer status:
- Checker command:
- Checker result:
- Next action:
```

## DECISIONS.md

```markdown
# Decisions

Append only. Add a new entry to supersede an old one.
```

## RISKS.md

```markdown
# Risks

| ID | Severity | State | Risk | Mitigation |
|---|---|---|---|---|
```

## AUTONOMY.md

```markdown
# Autonomy And Blockers

## Default Rule

Keep working unless progress requires a named external condition. Ordinary
engineering difficulty becomes a task, risk, evaluation case, or gap.

## Agent-Owned Work

- Environment setup that can be done locally.
- Dependency discovery and project-specific script creation.
- Failing tests, flaky tests, missing fixtures, and missing regression coverage.
- Architecture uncertainty that can be reduced by reading code or references.
- Weak evidence that can be replaced by a discriminator or marked unverified.
- Resource risk that can be bounded with safe runners, timeouts, and watchdogs.

## True Blockers

- Missing credentials, accounts, licenses, paid resources, or permissions not
  available through the established local mechanism.
- Destructive, legal, privacy, public-release, or product-priority decisions
  only the user can authorize.
- External service outage after retries when no mock, fixture, or independent
  slice can advance useful work.
- Unsafe concurrent writes with no disjoint file scope.
- Sandbox or approval policy refusal with no safer local equivalent.
- Mutually exclusive requirements requiring user prioritization.

## Required Blocker Record

Before marking an item blocked, record attempted workarounds, evidence,
remaining risk, required external action, independent work that can continue,
and the rerun command after unblock.
```

## TOOLING.md

```markdown
# Project Tooling

The bundled skill scripts are bootstrap/reference helpers. They initialize and
check the contract shape, but they are not a complete verification harness for
this project.

## Required Project-Specific Tools

Define or point to project-owned commands for:

- layered static/unit/integration/workflow/live/negative tests,
- evaluation matrix execution and report parsing,
- targeted gap reruns,
- broader regression reruns,
- safe command execution with timeout and cleanup,
- resource watchdog or preflight checks,
- package listing and privacy checks.

## Tool Inventory

| Purpose | Project Command | Layer | Owner | Evidence |
|---|---|---|---|---|

## Rules

- Prefer existing project scripts and framework-native runners.
- Add small adapters instead of forcing the generic bootstrap scripts to carry
  project logic.
- Record every adopted command in gates, matrix cases, or evidence before
  relying on it.
- If a command is only a placeholder, keep the related gate
  `implemented_unverified`.
```

## SECRET_ACCESS.md

```markdown
# Secret Access

Persist credential access rules, not credential values.

## Required Credentials

| Name | Purpose | Safe Source | Validation Command | Gates Unblocked | Last Status |
|---|---|---|---|---|---|

## Rules

- Never store secret values in repo files, contract files, prompts, logs, or
  packages.
- Do not rely on an ad hoc `.env` directory or transient shell state as the only
  access record for long sessions or sub-agents.
- Record the approved retrieval or injection mechanism, validation command,
  renewal path, redaction rule, and affected gates.
- Pass sub-agents only credential names and retrieval instructions, never secret
  values.
- Missing credentials block only the affected live gates; continue independent
  local work.
```

## ARTIFACTS.md

```markdown
# Artifacts

Harness runtime artifacts are centralized here to avoid polluting the project
tree.

## Artifact Root

Default: `.project-contract-harness/artifacts/`

## Directories

- `logs/`: command logs and redacted stderr/stdout captures.
- `eval-runs/`: evaluation matrix raw results and parsed reports.
- `regressions/`: targeted and broader regression outputs.
- `screenshots/`: GUI or visual verification screenshots.
- `traces/`: sanitized tool traces and side-effect snapshots.
- `packages/`: package listings and package verification outputs.
- `tmp/`: scratch output that is safe to delete when unreferenced.

## Rules

- Do not scatter temporary files in source directories.
- Use stable run ids and record them in `artifact-index.json`.
- Public packages must exclude raw logs, credential state, caches, traces, and
  temporary files unless explicitly sanitized and approved.
- Reusable project scripts belong in the project source or scripts directory,
  not in the artifact root.
```

## RESOURCE_GUARD.md

```markdown
# Resource Guard

Use this file to record resource safety for long-running commands, live tests,
agent loops, and subprocess-heavy verification.

## Policy

- Assess process count, memory scale, duration, concurrency conflicts, timeout,
  output size, and cleanup before heavy work.
- Prefer project-specific safe runners and watchdogs when they exist.
- If no project runner exists, use bounded commands and this skill's watchdog
  helper as a lightweight heartbeat.
- Kill whole process groups on timeout when the local runner supports it.
- Do not start a second heavy task while one is already active.
```

## EVAL_MATRIX.md

```markdown
# Evaluation Matrix

Use this file to turn success claims into discriminative checks. A generated
summary is not evidence until a check can pass or fail it.

| ID | Layer | Dimension | Claim | Oracle | Command Or Manual Check | Status | Evidence | Artifact |
|---|---|---|---|---|---|---|---|---|
| eval-001 | L0 | contract | Contract files are initialized and structurally valid | checker exits 0 with unverified gates allowed | python3 <skill>/scripts/check_contract.py --project-root <repo> --allow-unverified | verified | generated during initialization |  |

## Matrix Design Notes

- Prefer objective oracles: schemas, tests, snapshots, CLI exit codes, tool
  events, side-effect diffs, and package listings.
- Include negative cases for safety-critical behavior.
- Treat missing evidence as a failed or blocked case, not as success.
```

## GAPS.md

```markdown
# Gaps

Every required failed, skipped, timed-out, or missing-evidence evaluation case
must become a gap here until it is closed by rerun evidence.

| ID | Source Case | Required | State | Failure | Fix Slice | Targeted Rerun | Broader Gate | Evidence |
|---|---|---|---|---|---|---|---|---|
```

## EVIDENCE.md

```markdown
# Evidence

| Time | Gate | Command Or Check | Result | Notes |
|---|---|---|---|---|
```

## HANDOFF.md

```markdown
# Handoff

## Resume Order

1. Read STARTUP.md.
2. Probe for an existing harness and add only missing files if needed.
3. Read CONTRACT.md.
4. Read STATUS.md.
5. Read PLAN.md.
6. Read TASKS.md, DECISIONS.md, RISKS.md, AUTONOMY.md, TOOLING.md,
   SECRET_ACCESS.md, ARTIFACTS.md, RESOURCE_GUARD.md, EVAL_MATRIX.md, GAPS.md,
   and EVIDENCE.md.
7. Run the contract checker.

## Next Actions

- 

## Do Not Do

- Do not mark required gates verified without evidence.
- Do not write secrets or local identifiers into public artifacts.
```

## gates.json

```json
{
  "version": 1,
  "gates": [
    {
      "id": "contract-initialized",
      "required": true,
      "state": "verified",
      "claim": "The project contract exists and can be checked",
      "acceptance": "python3 <skill>/scripts/check_contract.py --project-root <repo>",
      "last_evidence": "",
      "blockers": []
    },
    {
      "id": "state-recovery-ready",
      "required": true,
      "state": "open",
      "claim": "Every session starts by probing and recovering any existing harness state before new planning or edits",
      "acceptance": "Review .project-contract-harness/STARTUP.md, HANDOFF.md, tasks/gaps/gates/evidence reads, and checker output from session start",
      "last_evidence": "",
      "blockers": []
    },
    {
      "id": "focused-tests",
      "required": true,
      "state": "open",
      "claim": "Touched behavior passes focused tests",
      "acceptance": "",
      "last_evidence": "",
      "blockers": []
    },
    {
      "id": "tasks-current",
      "required": true,
      "state": "open",
      "claim": "Durable task list reflects current required work and closure state",
      "acceptance": "Review .project-contract-harness/TASKS.md and tasks.json; all required completed tasks have evidence",
      "last_evidence": "",
      "blockers": []
    },
    {
      "id": "resource-guard-ready",
      "required": true,
      "state": "open",
      "claim": "Heavy commands have resource assessment, watchdog or timeout, and cleanup plan",
      "acceptance": "Review .project-contract-harness/RESOURCE_GUARD.md and resource-state.json before heavy commands",
      "last_evidence": "",
      "blockers": []
    },
    {
      "id": "autonomy-boundary",
      "required": true,
      "state": "open",
      "claim": "Ordinary engineering difficulty is handled as agent-owned work; only external conditions become blockers",
      "acceptance": "Review .project-contract-harness/AUTONOMY.md plus blocked gates/tasks/gaps for attempted workarounds and rerun commands",
      "last_evidence": "",
      "blockers": []
    },
    {
      "id": "project-tooling-designed",
      "required": true,
      "state": "open",
      "claim": "Project-specific runners and checks replace generic bootstrap scripts for real verification",
      "acceptance": "Review .project-contract-harness/TOOLING.md and ensure gates/matrix cases point to project-owned commands where needed",
      "last_evidence": "",
      "blockers": []
    },
    {
      "id": "secret-access-defined",
      "required": true,
      "state": "open",
      "claim": "Required credentials have persisted access rules without stored secret values",
      "acceptance": "Review .project-contract-harness/SECRET_ACCESS.md and secret-state.json; validation commands do not print secret values",
      "last_evidence": "",
      "blockers": []
    },
    {
      "id": "artifact-management-clean",
      "required": true,
      "state": "open",
      "claim": "Harness runtime artifacts are centralized, indexed, and excluded from public packages unless sanitized",
      "acceptance": "Review .project-contract-harness/ARTIFACTS.md, artifact-index.json, package listings, and privacy scan results",
      "last_evidence": "",
      "blockers": []
    },
    {
      "id": "harness-evolution-controlled",
      "required": true,
      "state": "open",
      "claim": "Harness updates happen through recorded tasks, gates, cases, tooling, and regression impact notes",
      "acceptance": "Review DECISIONS.md, events.jsonl, EVAL_MATRIX.md, gates.json, TOOLING.md, and EVIDENCE.md after adding or changing suites, gates, tools, or delivery criteria",
      "last_evidence": "",
      "blockers": []
    },
    {
      "id": "eval-matrix-designed",
      "required": true,
      "state": "open",
      "claim": "Important success claims are represented by discriminative evaluation cases",
      "acceptance": "Review .project-contract-harness/EVAL_MATRIX.md and eval-matrix.json for claim/oracle coverage",
      "last_evidence": "",
      "blockers": []
    },
    {
      "id": "required-gaps-closed",
      "required": true,
      "state": "open",
      "claim": "Required evaluation gaps are closed by targeted and broader rerun evidence",
      "acceptance": "Review .project-contract-harness/GAPS.md and gaps.json; no required gap remains open or unverified",
      "last_evidence": "",
      "blockers": []
    },
    {
      "id": "layered-regression",
      "required": true,
      "state": "open",
      "claim": "Gap fixes are covered by targeted tests plus the affected regression layer",
      "acceptance": "Record targeted rerun and affected L0-L5 regression evidence for each required gap fix",
      "last_evidence": "",
      "blockers": []
    },
    {
      "id": "outcome-compliance",
      "required": true,
      "state": "open",
      "claim": "The final artifact satisfies the user-visible outcome and all non-negotiable constraints",
      "acceptance": "Map final outcome and constraints to verified gates, matrix cases, privacy checks, package checks, and resource checks",
      "last_evidence": "",
      "blockers": []
    },
    {
      "id": "documentation-current",
      "required": true,
      "state": "open",
      "claim": "Durable docs, handoff, and necessary code comments match verified current behavior",
      "acceptance": "Review STARTUP/CONTRACT/PLAN/TASKS/DECISIONS/RISKS/AUTONOMY/TOOLING/SECRET_ACCESS/ARTIFACTS/RESOURCE_GUARD/EVAL_MATRIX/GAPS/EVIDENCE/HANDOFF and public docs for current verified claims",
      "last_evidence": "",
      "blockers": []
    },
    {
      "id": "full-verification",
      "required": true,
      "state": "open",
      "claim": "The integrated product or workflow passes its full gate",
      "acceptance": "",
      "last_evidence": "",
      "blockers": []
    },
    {
      "id": "privacy-clean",
      "required": true,
      "state": "open",
      "claim": "Deliverables contain no secrets, private paths, or forbidden terms",
      "acceptance": "python3 <skill>/scripts/privacy_scan.py <repo>",
      "last_evidence": "",
      "blockers": []
    }
  ]
}
```

## tasks.json

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "task-001",
      "required": true,
      "state": "verified",
      "task": "Initialize project contract harness",
      "depends_on": [],
      "acceptance": "Contract directory exists and checker can run",
      "evidence": "Generated by init_contract.py",
      "blockers": []
    }
  ]
}
```

## resource-state.json

```json
{
  "version": 1,
  "watchdog": {
    "state_file": "",
    "status": "not_started",
    "last_heartbeat": "",
    "active_heavy_command": ""
  },
  "assessments": []
}
```

## secret-state.json

```json
{
  "version": 1,
  "secrets": []
}
```

## artifact-index.json

```json
{
  "version": 1,
  "artifacts": []
}
```

## eval-matrix.json

```json
{
  "version": 1,
  "cases": [
    {
      "id": "eval-001",
      "dimension": "contract",
      "level": "L0",
      "required": true,
      "claim": "Contract files are initialized and structurally valid",
      "setup": "Fresh or existing project contract directory",
      "oracle": "check_contract.py exits 0 with --allow-unverified",
      "command": "python3 <skill>/scripts/check_contract.py --project-root <repo> --allow-unverified",
      "resource_limits": {
        "timeout_seconds": 30,
        "max_processes": 1,
        "max_external_calls": 0
      },
      "status": "verified",
      "last_evidence": "",
      "artifact_id": "",
      "gap_id": ""
    }
  ]
}
```

## gaps.json

```json
{
  "version": 1,
  "gaps": []
}
```
