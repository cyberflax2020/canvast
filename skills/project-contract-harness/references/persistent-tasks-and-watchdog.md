# Persistent Tasks And Resource Watchdog

## Table Of Contents

- Durable Todo Contract
- Recovery Patrol
- Task Closure Rules
- Resource Guard Contract
- Watchdog Helper
- Heavy Command Protocol
- Artifact Discipline

## Durable Todo Contract

Use `TASKS.md` and `tasks.json` as the durable todo list. The in-chat task list
is only a working view. After a long run, interruption, compaction, or model
handoff, the agent must return to the durable files and update them.

Every task record should include:

```json
{
  "id": "task-001",
  "required": true,
  "state": "open",
  "task": "What must be done",
  "depends_on": [],
  "acceptance": "How completion is checked",
  "evidence": "",
  "blockers": []
}
```

Do not trust memory for remaining work. On resume, rebuild the working todo list
from `tasks.json`, `gaps.json`, `gates.json`, `TOOLING.md`,
`SECRET_ACCESS.md`, `artifact-index.json`, and `STATUS.md`.

## Recovery Patrol

At the start of each work segment and before final response:

1. Read `STARTUP.md` and record whether an existing harness was recovered.
2. Read `TASKS.md` and `tasks.json`.
3. Read `GAPS.md` and `gaps.json`.
4. Read `gates.json`.
5. Read `TOOLING.md`, `SECRET_ACCESS.md`, `ARTIFACTS.md`,
   `artifact-index.json`, and `resource-state.json`.
6. Compare durable state with any in-chat plan.
7. Update stale task states before editing files.
8. If a task is marked `verified`, confirm it has acceptance and evidence.
9. If a required task lacks evidence, downgrade it to `implemented_unverified`
   or `open`.

For unattended loop agents, repeat this patrol after every major command batch
or context compaction.

## Task Closure Rules

Allowed task states match the contract state model:

- `open`
- `in_progress`
- `implemented_unverified`
- `verified`
- `blocked`
- `not_applicable`
- `dropped`

A required task can be `verified` only when it has:

- a concrete acceptance condition,
- current evidence,
- no unresolved required child gap,
- no stale dependency.

Task completion must update both `TASKS.md` and `tasks.json`.

## Resource Guard Contract

Use `RESOURCE_GUARD.md` and `resource-state.json` to track long-running or heavy
operations. Before heavy work, record:

- process count,
- expected memory and disk scale,
- expected duration,
- external calls and concurrency,
- timeout,
- output cap or spill path,
- cleanup command,
- watchdog or safe-runner status.

Prefer the target project's own safe runner, crash guard, queue, or watchdog. If
none exists, use the bundled watchdog helper as a lightweight heartbeat and keep
the command bounded.

## Watchdog Helper

Start a heartbeat in a separate terminal or supervised background slot:

```bash
python3 <skill-root>/scripts/watchdog.py watch --project-root <repo> --interval 5
```

Check freshness before and during heavy work:

```bash
python3 <skill-root>/scripts/watchdog.py check --project-root <repo> --max-age 20
```

The helper writes:

```text
.project-contract-harness/watchdog-state.json
```

This is a heartbeat and stale-state signal. It is not a substitute for process
group cleanup, sandboxing, memory limits, or the project's real safe runner.

## Heavy Command Protocol

Before a heavy command:

1. Perform the resource assessment in `RESOURCE_GUARD.md`.
2. Check the watchdog or project safe runner.
3. Ensure no conflicting heavy task is active.
4. Use explicit timeouts and output caps.
5. Prefer process-group cleanup.

After the command:

1. Record exit code, timeout state, and artifact path in `EVIDENCE.md`.
2. Check for leaked processes or stale heartbeat.
3. Update `resource-state.json`.
4. Convert failures or leaks into gaps or risks.

Do not run unbounded model loops, integration tests, crawlers, package builds, or
sub-agent fanout without this protocol.

## Artifact Discipline

Before writing logs, reports, traces, screenshots, package listings, or scratch
files, choose a path under `.project-contract-harness/artifacts/` or a
project-approved artifact root recorded in `ARTIFACTS.md`.

Index artifacts that support gates or gap closure in `artifact-index.json`, then
reference them from `EVIDENCE.md`. Source directories should contain source,
tests, docs, and reusable project scripts, not untracked runtime debris.
