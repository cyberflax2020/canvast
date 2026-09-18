# Platform Adapters

## Table Of Contents

- Shared Method
- Claude
- Codex
- DSH Plugin
- Minimal Invocation Prompt

## Shared Method

All adapters must preserve the same behavior:

- Analyze the project and initialize or update `.project-contract-harness/`
  before implementation, even for takeover, module, feature, or bug-fix work.
- If a harness already exists, recover from it first. If it is incomplete, add
  missing current-version files without overwriting existing state.
- Load `STARTUP.md` and contract state before planning or editing.
- Persist plan, tasks, decisions, status, evidence, risks, autonomy boundary,
  project tooling, secret access, artifact management, resource guard,
  evaluation matrix, gaps, and handoff.
- Treat bundled scripts as bootstrap/reference helpers; real verification uses
  project-specific runners and checks recorded in `TOOLING.md`.
- Use small closed implementation slices.
- Verify claims with discriminative, rerunnable evidence.
- Iterate test -> gap -> fix -> targeted rerun -> broader rerun until required
  constraints close.
- Evolve suites, gates, tasks, tools, and resource rules inside the harness when
  new cases appear; record rationale and regression impact.
- Persist credential access rules without secret values.
- Centralize runtime artifacts under the harness artifact root or a documented
  project-approved output root.
- Treat ordinary engineering difficulty as agent-owned work; ask only for true
  external blockers.
- Use a safe runner, watchdog, timeout, and cleanup plan for heavy work.
- Keep package and handoff artifacts private-data-free.

## Claude

Use a `CLAUDE.md` or equivalent project instruction file that points Claude to
this protocol. Keep it short so it is reliably obeyed:

```markdown
# Project Contract Harness

Before project work, analyze the repo and initialize or read
`.project-contract-harness/`. Treat `STARTUP.md`, `CONTRACT.md`, `STATUS.md`,
`PLAN.md`, `TASKS.md`, `DECISIONS.md`, `RISKS.md`, `AUTONOMY.md`,
`TOOLING.md`, `SECRET_ACCESS.md`, `ARTIFACTS.md`, `RESOURCE_GUARD.md`,
`EVAL_MATRIX.md`, `GAPS.md`, `EVIDENCE.md`, and `HANDOFF.md` as durable truth.
Bundled scripts are bootstrap/reference helpers; create or select
project-specific runners for real tests, eval suites, safe execution,
watchdogs, package checks, and privacy checks. Convert claims into
discriminative cases, close gaps with targeted and layered regression evidence,
and evolve the harness only through durable file updates. Persist credential
access rules, never secret values. Keep artifacts centralized. Ask the user
only for true external blockers.
```

## Codex

Use either this skill directly or place a concise `AGENTS.md` instruction in the
target repo:

```markdown
# Project Contract Harness

Use `$project-contract-harness` before any project development work. First
analyze the repo and establish or update `.project-contract-harness/`; then read
`STARTUP.md`, `CONTRACT.md`, `STATUS.md`, `PLAN.md`, `TASKS.md`,
`DECISIONS.md`, `RISKS.md`, `AUTONOMY.md`, `TOOLING.md`, `SECRET_ACCESS.md`,
`ARTIFACTS.md`, `RESOURCE_GUARD.md`, `EVAL_MATRIX.md`, `GAPS.md`,
`EVIDENCE.md`, and `HANDOFF.md`. Keep the chat plan aligned with durable tasks.
Use project-specific runners for real verification; bundled scripts are
bootstrap/reference helpers. Persist credential access rules without secret
values. Centralize artifacts. Convert failed required cases into gaps and
iterate targeted rerun plus layered regression until they close. Preserve
unrelated changes and ask only for true external blockers.
```

## DSH Plugin

The DSH plugin package in `deploy/dsh-plugin/project-contract-harness/` is intentionally
self-contained:

```text
project-contract-harness/
  .codex-plugin/plugin.json
  skills/project-contract-harness/SKILL.md
  skills/project-contract-harness/references/*.md
  skills/project-contract-harness/scripts/*.py
  scripts/dsh-entry.py
```

`scripts/dsh-entry.py` provides a simple command dispatcher:

```bash
python3 scripts/dsh-entry.py init --project-root /path/to/repo
python3 scripts/dsh-entry.py check --project-root /path/to/repo
python3 scripts/dsh-entry.py scan --project-root /path/to/repo --forbidden-word ExampleName
python3 scripts/dsh-entry.py watchdog check --project-root /path/to/repo
```

If the actual DSH runtime expects a different manifest name, keep the plugin
contents unchanged and add a thin adapter file that points to the same skill and
scripts.

## Minimal Invocation Prompt

Use this starter prompt in any harness:

```text
Use the project-contract-harness method. Initialize or read the local contract
directory before implementation, recover existing startup state, build a
durable plan and task list, define project-specific tooling and discriminative
evaluation cases, persist secret access rules without secret values, centralize
artifacts, constrain edits to the current slice, record decisions and evidence,
convert failures into gaps, iterate fix and rerun until required gaps close,
evolve the harness only through durable updates, guard heavy commands with a
watchdog or safe runner, scan for private data before packaging, and leave a
clean handoff state.
```
