# Project-Specific Tooling

## Table Of Contents

- Purpose
- Bootstrap Versus Real Harness
- Required Project Tools
- Eval Runner Contract
- Safe Runner Contract
- Regression Command Contract
- Tooling Evidence

## Purpose

The bundled scripts are reference templates and bootstrap helpers. They create
the durable contract skeleton, validate generic state files, scan common privacy
risks, and provide a minimal heartbeat. They are not intended to be the complete
verification harness for every large project.

For real delivery, the agent must analyze the target project and write or adapt
project-specific tooling that matches its language, test framework, runtime,
resource profile, package format, and user-visible success criteria.

## Bootstrap Versus Real Harness

Use bundled scripts for:

- initial `.project-contract-harness/` creation,
- generic schema and state validation,
- reference examples for JSON shapes,
- lightweight fallback watchdog heartbeat,
- broad privacy scan before packaging.

Use project-specific scripts for:

- real build, lint, typecheck, unit, integration, workflow, and live tests,
- evaluation matrix execution and report parsing,
- targeted gap reproduction and closure,
- subprocess cleanup, timeout, process-group handling, and concurrency limits,
- package creation and exact package-content inspection,
- domain-specific privacy, compliance, and user-visible effect checks.

Do not stretch a generic helper until it becomes a fragile project runner. Add a
small project-owned script, document it in `TOOLING.md`, and point gates or
matrix cases to that command.

## Required Project Tools

After analyzing the repository, record the project tool inventory in
`.project-contract-harness/TOOLING.md`:

| Purpose | Project Command | Layer | Owner | Evidence |
|---|---|---|---|---|
| Static/schema checks |  | L0 |  |  |
| Unit regression |  | L1 |  |  |
| Integration/CLI side effects |  | L2 |  |  |
| Workflow recovery or orchestration |  | L3 |  |  |
| Live/effect or packaging install |  | L4 |  |  |
| Negative safety/compliance |  | L5 |  |  |
| Safe runner/resource watchdog |  | resource |  |  |
| Evaluation matrix runner |  | eval |  |  |

The command can be an existing package script, a checked-in shell/Python/Node
runner, a make target, or a documented manual check with recorded raw evidence.

## Eval Runner Contract

A mature project eval runner should:

- load machine-readable cases,
- run one case, one dimension, or the full matrix,
- enforce timeouts and output caps,
- emit structured results with case id, status, layer, evidence path, and gap id,
- fail non-zero on required gaps,
- separate measured facts from generated interpretation,
- preserve raw artifacts outside public packages unless sanitized.

## Safe Runner Contract

A mature project safe runner should:

- print the command and resource assumptions before starting,
- apply timeout and process-group cleanup,
- bound concurrency and output volume,
- record start/end time and exit code,
- expose a leak check or cleanup report,
- integrate with the project watchdog or resource preflight.

## Regression Command Contract

For every gap fix, identify:

- targeted reproducer command,
- affected regression layer command,
- broader gate command when shared behavior, package output, live behavior, or
  compliance could regress.

Record all three in `GAPS.md`, `gaps.json`, and `EVIDENCE.md`. If one cannot run
because of a true external blocker, keep the gap unverified and continue any
independent safe work.

## Tooling Evidence

Mark `project-tooling-designed` verified only when `TOOLING.md` names the
project-specific commands or records why an existing framework command already
covers the need. Placeholder commands keep the related gates
`implemented_unverified`.
