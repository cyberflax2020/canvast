# Contract Protocol

## Table Of Contents

- Purpose
- Directory Contract
- State Model
- Start Ceremony
- Work Loop
- Evaluation And Gap Loop
- End Ceremony
- Autonomy And Blockers
- Project-Specific Tooling
- Secret Access
- Harness Evolution
- Concurrent Development
- Decision Policy
- Context Budget

## Purpose

The contract harness makes long-running agent work restartable, auditable, and
bounded. It treats chat history as volatile and the local contract directory as
the source of truth.

Use the contract directory:

```text
.project-contract-harness/
  CONTRACT.md
  PLAN.md
  TASKS.md
  STATUS.md
  STARTUP.md
  DECISIONS.md
  RISKS.md
  AUTONOMY.md
  TOOLING.md
  SECRET_ACCESS.md
  ARTIFACTS.md
  RESOURCE_GUARD.md
  EVAL_MATRIX.md
  GAPS.md
  EVIDENCE.md
  HANDOFF.md
  gates.json
  tasks.json
  resource-state.json
  secret-state.json
  artifact-index.json
  eval-matrix.json
  gaps.json
  events.jsonl
```

## Directory Contract

- `CONTRACT.md`: immutable mission, constraints, scope, non-goals, owner rules.
- `PLAN.md`: phase plan, current slice, file ownership, acceptance commands.
- `TASKS.md`: durable todo list and task closure state.
- `STATUS.md`: high-level dashboard for a fresh agent.
- `STARTUP.md`: mandatory session-start recovery checklist and latest startup
  evidence.
- `DECISIONS.md`: append-only architecture and process decisions.
- `RISKS.md`: live blockers, hazards, degraded assumptions, mitigation.
- `AUTONOMY.md`: boundary between agent-owned work and true external blockers.
- `TOOLING.md`: project-specific command inventory and runner contracts.
- `SECRET_ACCESS.md`: credential access rules without persisted secret values.
- `ARTIFACTS.md`: centralized runtime artifact policy and index rules.
- `RESOURCE_GUARD.md`: resource assessment, watchdog status, cleanup protocol.
- `EVAL_MATRIX.md`: human-readable evaluation dimensions, cases, oracles, and
  latest status.
- `GAPS.md`: human-readable required gap ledger and closure evidence.
- `EVIDENCE.md`: rerunnable commands, results, logs, screenshots, manual checks.
- `HANDOFF.md`: exact resume instructions and next actions.
- `gates.json`: machine-readable delivery gates.
- `tasks.json`: machine-readable task list.
- `resource-state.json`: machine-readable resource and watchdog state.
- `secret-state.json`: machine-readable credential availability state without
  secret values.
- `artifact-index.json`: machine-readable artifact inventory.
- `eval-matrix.json`: machine-readable discriminative evaluation cases.
- `gaps.json`: machine-readable failed or missing-evidence case closure state.
- `events.jsonl`: append-only event stream for milestones and handoffs.

## State Model

Use these statuses exactly:

- `open`: not started or not yet understood.
- `in_progress`: currently owned and actively being worked.
- `implemented_unverified`: implementation exists but acceptance has not passed.
- `verified`: acceptance evidence exists and is current.
- `blocked`: progress requires a named external condition after recorded
  workarounds.
- `not_applicable`: outside agreed scope with recorded rationale.
- `dropped`: removed from scope by a recorded decision.

Do not mark an item `verified` because code exists, tests look likely, a report
was written, or the agent believes the result is correct. Verification requires
evidence.

## Start Ceremony

At the beginning of a long-running or resumed task:

1. Probe for an existing `.project-contract-harness/`. If it exists, recover
   from it before new planning: read current status, tasks, gaps, gates,
   evidence, tooling, secret access, artifact index, and handoff.
2. If no harness exists, initialize it. If a harness exists but lacks current
   required files, run the initializer without `--force` or manually add only
   missing files so existing state is preserved.
3. Read `STARTUP.md`, then record whether an existing harness was found, which
   files were added, and which durable state files were read.
4. Read `CONTRACT.md`, `STATUS.md`, `PLAN.md`, and `HANDOFF.md`.
5. Read the latest entries in `TASKS.md`, `EVAL_MATRIX.md`, `GAPS.md`,
   `EVIDENCE.md`, `RISKS.md`, `AUTONOMY.md`, `TOOLING.md`,
   `SECRET_ACCESS.md`, `ARTIFACTS.md`, and `DECISIONS.md`.
6. Analyze the project before editing, whether the assignment is a new product,
   takeover, module, or small feature: repo shape, existing docs, test
   framework, build/package commands, runtime dependencies, credential needs,
   resource risks, active concurrent work, and user-visible success criteria.
7. Convert the project analysis into harness updates before broad
   implementation: tasks, gates, matrix cases, tooling commands, resource
   rules, credential access rules, and acceptance criteria.
8. Inspect repo status before writing. If another writer is active or unknown,
   stay read-only until file ownership is clear.
9. Rebuild the current slice: objective, owned files, non-goals, gates, matrix
   cases, required gaps, and risks.
10. Run `check_contract.py --allow-unverified` to catch stale or missing control
   files.

## Work Loop

Each execution slice follows this cycle:

1. Define the slice in `PLAN.md`: scope, owned files, acceptance command,
   expected outputs, and stop conditions.
2. Ensure the slice has at least one discriminative evaluation case or a
   recorded reason why existing cases already cover it.
3. Ensure project-specific tooling exists for the slice or add it in a tooling
   slice first.
4. Ensure any needed credentials have a `SECRET_ACCESS.md` record and a
   redacted validation command.
5. Implement only that slice.
6. Run the narrowest meaningful verification.
7. Record command, result, and evidence path in `EVIDENCE.md`.
8. Update `TASKS.md`, `EVAL_MATRIX.md`, `GAPS.md`, `STATUS.md`, and append one JSONL event
   to `events.jsonl`.
9. If new architecture, harness rule, test suite, project tool, or policy is introduced, append an ADR-style entry to
   `DECISIONS.md`.
10. If a required gate or gap remains unverified, keep it visible. Do not convert
   it into a known issue and call delivery complete.

## Evaluation And Gap Loop

The delivery loop is:

```text
claim -> case -> run -> gap -> fix -> targeted rerun -> broader rerun -> close
```

Use this loop until every required constraint is either `verified` or explicitly
`not_applicable` by recorded scope decision:

1. Convert every important claim into an evaluation case with an oracle.
2. Run the relevant case or matrix command.
3. Treat failed, timed-out, skipped, flaky, stale, or missing-evidence cases as
   gaps.
4. Fix one required gap at a time in a bounded implementation slice.
5. Rerun the targeted case that exposed the gap.
6. Rerun the affected dimension, product gate, or package gate that could have
   regressed.
7. Close the gap only after both targeted and broader evidence are current.
8. Continue until `check_contract.py` has no required-gap warnings and the full
   delivery gate passes.

Stop only when the effect and constraints are satisfied. Do not stop because a
large amount of code was written, a report exists, or the current slice feels
complete. The final standard is the user-visible outcome plus all required
constraints: tests, live behavior when relevant, package contents, privacy,
resource safety, documentation accuracy, and handoff replay.

## Autonomy And Blockers

The harness assumes unattended progress. Environment setup, dependency
discovery, test failures, missing fixtures, flaky runs, implementation
uncertainty, and weak evidence are agent-owned work. Convert them into tasks,
risks, matrix cases, and gaps, then keep iterating.

Mark `blocked` or ask the user only for named external conditions:

- missing credentials, accounts, licenses, approvals, permissions, or paid
  resources not available through the established local mechanism;
- destructive, legal, privacy, public-release, or product-priority decisions
  that only the user can authorize;
- unavailable external services after retries when no mock, fixture, or
  independent slice can advance useful work;
- unsafe concurrent writes where no disjoint file scope exists;
- sandbox or approval policy refusal with no safer local alternative;
- irreconcilable requirements that need user prioritization.

Before marking `blocked`, record attempted workarounds, evidence, remaining
risk, exact required external action, independent work that can continue, and
the rerun command after unblock. A single blocked gate does not stop other
safe slices.

## Project-Specific Tooling

The bundled scripts are bootstrap and reference helpers. They are suitable for
initial contract creation, generic schema checks, privacy scanning, and a
fallback heartbeat. They are not a substitute for project-specific runners.

After repository analysis, the agent must create or select project-owned
commands for static checks, unit tests, integration tests, workflow tests,
live/effect tests, negative safety cases, eval matrix execution, safe command
execution, resource watchdog/preflight, package listing, and privacy checks.
Record these commands in `TOOLING.md`, gates, matrix cases, and evidence. If a
real command is missing, keep the affected gate `implemented_unverified` and add
a task to build it.

## Secret Access

Persist credential access rules, not credential values. Keep required
credential names, approved storage or injection mechanism, redacted validation
commands, renewal steps, sub-agent propagation policy, and affected gates in
`SECRET_ACCESS.md` and `secret-state.json`.

Do not rely on a plaintext `.env` directory or transient shell state as the only
record for long sessions or sub-agents. Do not paste secret values into prompts,
logs, docs, or handoff files. Missing credentials block only the affected live
gates; continue independent local, mocked, packaging, documentation, and safety
work.

## Harness Evolution

The harness is durable but not frozen. Add or revise tasks, suites, matrix
cases, gates, risks, project tools, resource rules, and docs when new cases or
requirements appear. Every evolution needs a rationale, matching updates to
human and machine-readable files, regression impact notes, and a checker run.

Do not bypass the harness with ad hoc tests or temporary scripts. Bring new
checks into `TOOLING.md`, `EVAL_MATRIX.md`, `gates.json`, and `EVIDENCE.md`.
Retire a case only by marking it `not_applicable` or `dropped` with a recorded
decision.

## Layered Regression

Use the smallest meaningful layer after each change, then climb when the change
touches shared behavior:

- `L0 static`: syntax, typecheck, schema, lint, package list, privacy scan.
- `L1 unit`: local functions, parsers, state machines, validators.
- `L2 integration`: scripts, CLI commands, plugin dispatch, file side effects.
- `L3 workflow`: plan/task/gap/evidence loops, sub-agent orchestration,
  recovery.
- `L4 live/effect`: model-dependent, provider, GUI, packaging install, or
  real external integration behavior.
- `L5 negative`: rejection of unsafe, invalid, stale, or out-of-scope behavior.

For any required gap fix, record targeted rerun evidence plus the affected
regression layer. If a broader gate fails, reopen or create a gap.

## End Ceremony

Before stopping or handing off:

1. Update `STATUS.md` with current phase, active slice, verified gates, blocked
   gates, and next command.
2. Append a handoff event to `events.jsonl`.
3. Update `EVAL_MATRIX.md` and `GAPS.md` so the next agent can see remaining
   cases and gaps without chat history.
4. Update `HANDOFF.md` with the first five actions for the next agent.
5. Ensure no long-running processes needed for the task are still active.
6. Ensure durable docs and necessary comments explain non-obvious decisions,
   invariants, safety boundaries, and remaining work.
7. If the work is in a git repo and the user expects commits, leave a clean or
   explicitly documented working tree.

## Concurrent Development

Default rule: one writer per repo. If another agent or human is actively
developing:

- Do not modify shared files without explicit ownership.
- Prefer read-only analysis, docs in a separate workspace, or disjoint write
  scopes.
- Record any observed external change as risk or stale state.
- Re-read files immediately before editing if they may have changed.
- Never revert unknown changes.

## Decision Policy

For non-trivial decisions, append a short entry to `DECISIONS.md`:

```text
## ADR-NNN: Title

- Status: proposed | accepted | superseded
- Date: YYYY-MM-DD
- Context: what forced the decision
- Decision: what is chosen
- Consequences: tradeoffs and follow-up gates
- Evidence: command, issue, benchmark, or user instruction
```

Before adding new process, architecture, dependency, or gate complexity, answer:

1. What concrete failure mode does this prevent?
2. What happens if it is not added?
3. Is there a simpler mechanism that covers the same risk?

## Context Budget

Build context in this order:

1. System and harness instructions.
2. Current contract status and active plan slice.
3. Recent user instructions.
4. Relevant decisions and risks.
5. Only the task files needed for the current slice.

When context gets large, compact into contract state: update plan, decisions,
risks, evaluation cases, gaps, evidence, and handoff. Do not rely on a
narrative summary alone.
