---
name: project-contract-harness
description: Durable contract harness for long-running large-project delivery by coding agents. Use when an agent must drive a new project, takeover, module, feature, or complex repo through project analysis, persistent local state, project-specific runners, secret-access rules without storing secrets, centralized artifact management, sub-agent/workflow orchestration, self-authored evaluation matrices, discriminative validation, layered regression, evidence-backed testing, real-run verification, gap closure, privacy-safe packaging, interruption recovery, or unattended loop-agent execution across Claude, Codex, DSH plugins, or other harnesses.
---

# Project Contract Harness

## Overview

Use this skill to turn a broad engineering objective into a local, enforceable delivery contract. The contract persists the plan, tasks, decisions, risks, secret-access contract, resource guard, evaluation matrix, gaps, evidence, autonomy boundary, and handoff state on disk so a fresh agent can resume without relying on chat history.

This skill is intentionally product-agnostic. Do not copy customer names, private paths, internal service names, credentials, host details, or reference-project specifics into generated artifacts.

## First Actions

1. Identify `SKILL_ROOT` as the directory containing this `SKILL.md`.
2. Identify `REPO_ROOT` as the target project root. If the user did not specify it, use the current working directory.
3. Probe for an existing `REPO_ROOT/.project-contract-harness/`. If it exists,
   recover from it first: read status, tasks, gaps, gates, evidence, tooling,
   secret access, artifact index, and handoff before proposing or editing.
4. Analyze the project before editing, even for a single module or small request:
   repo shape, existing docs, test framework, package/build commands, runtime
   constraints, active concurrent work, and user-visible success criteria.
5. If `REPO_ROOT/.project-contract-harness/` does not exist, run:

```bash
python3 "$SKILL_ROOT/scripts/init_contract.py" --project-root "$REPO_ROOT"
```

6. If the directory exists but lacks current required files, run the initializer
   without `--force` to add missing files while preserving existing state.
7. Convert that analysis into the project harness: update `STARTUP.md`,
   `CONTRACT.md`,
   `PLAN.md`, `TASKS.md`, `TOOLING.md`, `SECRET_ACCESS.md`,
   `ARTIFACTS.md`, `RESOURCE_GUARD.md`, `EVAL_MATRIX.md`, and
   `gates.json` before broad code changes.
8. Read the existing contract files in this order:
   `STARTUP.md`, `CONTRACT.md`, `PLAN.md`, `TASKS.md`, `STATUS.md`, `DECISIONS.md`, `RISKS.md`, `AUTONOMY.md`, `TOOLING.md`, `SECRET_ACCESS.md`, `ARTIFACTS.md`, `RESOURCE_GUARD.md`, `EVAL_MATRIX.md`, `GAPS.md`, `EVIDENCE.md`, `HANDOFF.md`.
9. Check whether another active writer is working in the same repo. If there is a reasonable signal of active concurrent development, stay read-only or restrict edits to explicitly owned files.
10. Run the contract checker before major edits:

```bash
python3 "$SKILL_ROOT/scripts/check_contract.py" --project-root "$REPO_ROOT" --allow-unverified
```

## Operating Contract

Follow this loop until delivery is complete:

1. **Recover state**: load the contract files and current repo status before planning.
2. **Plan persistently**: write or update the durable plan before broad implementation. Keep the current in-chat plan as the working slice, not the source of truth.
3. **Maintain durable tasks**: update `TASKS.md` and `tasks.json` after each milestone and before handoff.
4. **Build discriminators**: convert success claims into `EVAL_MATRIX.md` and `eval-matrix.json` before relying on generated conclusions.
5. **Constrain scope**: each implementation slice must state owned files, non-goals, verification commands, and rollback or mitigation path.
6. **Create project tooling**: treat bundled scripts as bootstrap/reference helpers; create or select project-specific runners, eval commands, safe runners, and watchdogs in the target repo.
7. **Stabilize secret access**: document credential names, safe sources, validation commands, redaction rules, and sub-agent propagation in `SECRET_ACCESS.md`; never persist secret values.
8. **Guard resources**: before heavy commands, update `RESOURCE_GUARD.md`, use a project safe runner or fallback `watchdog.py`, and define cleanup.
9. **Execute in small closed steps**: complete one logical unit at a time; update durable status after each milestone.
10. **Close gaps one by one**: every required failed case becomes a tracked gap in `GAPS.md` and `gaps.json`.
11. **Run layered regression**: after a gap fix, run the targeted case and the affected L0-L5 regression layer.
12. **Evolve the harness in place**: add or revise suites, gates, tasks, risks, and project tools when new cases appear, with recorded rationale and regression impact.
13. **Stay autonomous**: convert ordinary engineering difficulty into tasks, gaps, risks, and experiments; reserve `blocked` for named external conditions.
14. **Verify with evidence**: no completion claim is valid without a rerunnable command or explicit reason why the command cannot run.
15. **Document continuously**: keep durable docs and necessary code comments aligned with verified behavior.
16. **Review and package**: run privacy and package checks before any outward-facing artifact.
17. **Handoff cleanly**: before stopping, update `STATUS.md`, append an event, and leave the next action obvious.

Use status words consistently:

- `open`: not started or not yet understood.
- `in_progress`: currently owned and actively being worked.
- `implemented_unverified`: code or document exists but has not passed its gate.
- `verified`: passed the listed acceptance command.
- `blocked`: cannot progress without a named external condition after recorded workarounds.
- `not_applicable`: outside agreed scope with recorded rationale.
- `dropped`: intentionally removed with a recorded decision.

## Discriminative Validation

Do not trust generated self-assessments as completion evidence. Treat model
answers, summaries, and reports as hypotheses until a discriminator checks them.

For each important claim, create or update a test case with:

- an input or setup,
- an oracle or objective pass condition,
- bounded resource limits,
- captured artifacts,
- a failure-to-gap rule.

Use deterministic validators where possible: schema checks, type checks, unit
tests, AST or parser checks, golden snapshots, property tests, CLI exit codes,
structured tool events, package listings, side-effect snapshots, and live smoke
tests. Use reviewer judgment only when the rubric and raw evidence are recorded.

## Planning Rules

- Keep the durable plan small enough to maintain. Prefer phases, current slice, acceptance gates, and open risks over a huge task dump.
- Make architectural decisions append-only in `DECISIONS.md`. Do not silently rewrite old rationale; add a superseding decision.
- Treat a gap report as an intermediate control artifact. Required gaps must be implemented and retested or explicitly removed from scope by user-approved decision.
- Prefer mature open-source or existing project patterns before custom systems. Run a small effect test before adopting any mechanism.
- Do not use regex or keyword lists as the main mechanism for semantic decisions. Regex is acceptable for audited boundaries such as secret scanning, path parsing, and log extraction.

## Sub-Agents And Workflows

Use sub-agents only for independent sidecar work that can proceed without blocking your immediate next step. Give each worker a disjoint write set and a concrete output contract: changed files, evidence commands, unresolved risks, and handoff notes.

Use a workflow when the work has multiple phases with gates, for example discovery, design, implementation, verification, packaging. The workflow must have an exit condition for each phase and must not mark delivery complete while required gates are pending.

## Verification Rules

- Always run the narrowest meaningful checks after a change.
- Organize checks by layer: static/schema, unit, integration, workflow, live/effect, and negative safety cases.
- Run full product or live gates before declaring delivery complete when behavior depends on integration, external services, GUI state, packaging, or model behavior.
- Record the exact command, result, and any skipped gate in `EVIDENCE.md` and `events.jsonl`.
- If a live gate cannot run, keep the item `blocked` or `implemented_unverified`; do not relabel it as `verified`.
- A test matrix report is not final delivery. Required failing or missing cases must become gaps, and required gaps must close through targeted rerun plus the relevant broader gate.
- The final standard is outcome and compliance, not implementation volume. If the user-visible effect, constraints, package, or compliance gate fails, delivery is not complete.
- Before final delivery, run `check_contract.py` without `--allow-unverified` and resolve any remaining required warnings or record a user-approved scope decision.

## Resource And Safety Rules

- Before heavy tests, long-running subprocesses, or model loops, assess expected process count, memory scale, duration, and concurrency conflicts.
- Use the project's existing safe runner, watchdog, timeout, or process-group wrapper when available.
- If no project watchdog exists, use `scripts/watchdog.py` to maintain a heartbeat and detect stale runs.
- Do not run two writing agents against the same repo at the same time. If concurrent work already exists, coordinate by disjoint files or stay read-only.
- Never place secrets in command text, docs, prompts, logs, or package manifests. Load credentials from the user's established secret mechanism only.
- Keep harness runtime artifacts centralized under `.project-contract-harness/artifacts/` or a documented project-approved artifact root. Do not scatter logs, raw eval results, traces, screenshots, or temporary files through source directories.

## Secret Access Rules

- Persist the access contract, not the secret values.
- Record required credential names, safe storage source, validation command, renewal path, sub-agent propagation rule, and redaction rule in `SECRET_ACCESS.md`.
- Do not rely on an ad hoc `.env` directory, transient shell state, or chat-only instructions that long sessions and sub-agents cannot rediscover.
- If a credential is unavailable, continue offline/mockable independent work and mark only the affected live gate as `blocked` with the required external action.

## Privacy Gate

Before publishing, packaging, sharing, or handing off artifacts outside the working repo, run:

```bash
python3 "$SKILL_ROOT/scripts/privacy_scan.py" "$REPO_ROOT"
```

Add `--forbidden-word <term>` for project-specific names, customer names, internal systems, or local identifiers that must not appear in the deliverable.

## References

Read only the files needed for the current task:

- `references/contract-protocol.md`: durable files, event model, start/end ceremonies, and state transitions.
- `references/validation-gates.md`: evidence levels, test selection, live-gate rules, packaging gate, and failure handling.
- `references/evaluation-matrix.md`: self-authored test matrices, discriminative oracles, gap records, and closure loop.
- `references/persistent-tasks-and-watchdog.md`: durable todo recovery, resource guard, watchdog heartbeat, and heavy-command protocol.
- `references/autonomy-and-blockers.md`: when an unattended agent must keep working versus when it may ask the user or mark a true blocker.
- `references/project-specific-tooling.md`: how to replace bootstrap helpers with project-specific runners, eval scripts, safe runners, and watchdogs.
- `references/secret-access.md`: how to persist credential access rules without storing secret values.
- `references/harness-evolution.md`: how to safely add or change suites, gates, tasks, tools, and constraints over time.
- `references/artifact-management.md`: how to centralize logs, eval outputs, traces, package listings, and temporary runtime artifacts.
- `references/documentation-and-comments.md`: durable documentation, handoff docs, and useful code comment rules.
- `references/platform-adapters.md`: how to load this method in Claude, Codex, DSH-style plugins, and other harnesses.
- `references/templates.md`: canonical prompt snippets and template content.
