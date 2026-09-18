# Validation Gates

## Table Of Contents

- Evidence Levels
- Gate Design
- Discriminative Validation
- Test Selection
- Layered Regression
- Live And Integration Gates
- Gap Closure
- Outcome Compliance Gate
- Project Tooling Gate
- Secret Access Gate
- Artifact Gate
- Harness Evolution Gate
- Resource Safety
- Packaging And Privacy
- Failure Handling

## Evidence Levels

Use explicit evidence grades:

- `verified`: a rerunnable command or documented manual check passed.
- `implemented_unverified`: code or content exists but its acceptance gate has
  not been run.
- `blocked`: a named external condition prevents the gate after recorded
  workarounds.
- `not_applicable`: the gate is outside the agreed scope.

Rules:

- Unit tests prove local behavior only.
- Smoke tests prove wiring only.
- Static review proves risk reduction only.
- Live tests prove integration only for the exact environment and version run.
- Benchmarks prove comparative claims only when both sides run the same prompt
  set under recorded conditions.

## Gate Design

Every gate in `gates.json` should include:

```json
{
  "id": "gate-example",
  "required": true,
  "state": "open",
  "claim": "What this gate proves",
  "acceptance": "A concrete command or manual check",
  "last_evidence": "",
  "blockers": []
}
```

Keep required gates small and non-overlapping:

- Build or typecheck gate.
- Startup recovery gate.
- Focused unit/regression gate.
- Evaluation matrix coverage gate.
- Required gap closure gate.
- Project-specific tooling gate.
- Secret access gate.
- Artifact management gate.
- Harness evolution gate.
- Integration or live gate.
- Product packaging gate.
- Privacy/de-identification gate.
- Documentation accuracy gate.

## Discriminative Validation

Do not let a generated report validate itself. A completion claim becomes
credible only after a discriminator checks observable evidence.

Strong discriminators include:

- executable tests,
- schema validation,
- AST or parser-backed checks,
- state-machine transition checks,
- CLI exit codes and structured JSON,
- tool-event assertions,
- side-effect snapshots,
- golden outputs,
- package listings,
- live smoke runs for live claims.

Weak evidence includes:

- model prose saying the behavior is correct,
- code inspection without a pass/fail oracle,
- stale historical reports after relevant changes,
- baseline numbers not produced by actual measurement,
- self-referential tests that only prove the test text exists.

When no deterministic oracle exists, define a rubric and require a raw evidence
bundle. The rubric result must be recorded as a manual check and may not be used
for safety-critical claims unless the user explicitly accepts that risk.

## Test Selection

After each change:

1. Run the narrowest test that covers the touched behavior.
2. Run broader tests when shared contracts, public APIs, package outputs, or
   harness behavior changed.
3. Run live tests when behavior depends on external providers, subprocesses,
   GUI state, network, permissions, or long-running sessions.
4. Record skipped tests with a reason and preserve the gate as unverified or
   blocked.
5. Add or update matrix cases before broad implementation when the task changes
   product behavior, safety boundaries, packaging, live integrations, or agent
   workflow behavior.

## Layered Regression

Classify every verification command by layer:

- `L0 static`: syntax, typecheck, schema, lint, package list, privacy scan.
- `L1 unit`: local functions, parsers, state machines, validators.
- `L2 integration`: scripts, CLI commands, plugin dispatch, file side effects.
- `L3 workflow`: plan/task/gap/evidence loops, sub-agent orchestration,
  recovery.
- `L4 live/effect`: model-dependent, provider, GUI, package install, or real
  external integration behavior.
- `L5 negative`: rejection of unsafe, invalid, stale, or out-of-scope behavior.

Every required gap fix needs:

1. targeted reproducer rerun,
2. affected regression layer rerun,
3. broader gate rerun when shared behavior, package output, live behavior, or
   compliance could have changed.

Avoid false closure:

- Do not use a self-referential assertion to prove parity with another product.
- Do not let a report substitute for the product behavior it describes.
- Do not mark a benchmark claim verified without measured data.
- Do not treat historical evidence as current after relevant code or config
  changed.

## Live And Integration Gates

For claims about agent behavior, long sessions, model behavior, tool choice, or
superiority over a baseline:

- Use identical input sets for both systems.
- Record runner version, command, start time, result file, and exit code.
- Keep raw run artifacts outside publishable packages unless they are sanitized.
- Use fail-on-gap logic: any required mismatch becomes implementation work.
- Separate provider availability smoke tests from full product behavior tests.

## Gap Closure

Every failed, skipped, timed-out, flaky, or missing-evidence required case must
become a gap record.

A required gap closes only when:

1. the implementation or documented scope decision exists,
2. the targeted reproducer now passes,
3. the affected broader gate now passes,
4. evidence is recorded in `EVIDENCE.md`,
5. `gaps.json` records `state: "verified"` with both targeted and broader
   evidence, or `state: "not_applicable"` with a decision reference.

Do not batch-close gaps from a narrative summary. Close them one by one from
rerun evidence, then run the broader gate.

## Outcome Compliance Gate

Before final delivery, verify the outcome rather than implementation volume:

- the requested user-visible workflow works,
- non-negotiable constraints are mapped to gates,
- required tasks, gaps, matrix cases, and package checks are current,
- resource guard state is clean,
- public docs contain only verified claims,
- handoff replay is possible from local files only.

If any one of these fails, the result is not deliverable.

## Project Tooling Gate

Bundled skill scripts are bootstrap/reference helpers. Mark project tooling
verified only after the target repo has real commands or documented framework
commands for the relevant layers: static, unit, integration, workflow,
live/effect, negative safety, eval runner, targeted gap rerun, safe runner,
watchdog/preflight, package listing, and privacy scan.

If a project-specific command does not exist yet, create it as an implementation
task. Do not use the generic bootstrap scripts as proof that project behavior is
fully verified.

## Secret Access Gate

Credential handling is valid only when access rules are persisted without
secret values:

- `SECRET_ACCESS.md` names the credential, safe source, validation command,
  renewal path, sub-agent policy, redaction rule, and affected gates.
- `secret-state.json` records availability state without fields such as `value`,
  `token`, `api_key`, `password`, or `secret`.
- Validation commands prove availability without printing the credential.

Missing credentials block only affected live or integration gates. Continue
offline, mocked, documentation, package, and safety work.

## Artifact Gate

Runtime artifacts must be centralized under `.project-contract-harness/artifacts/`
or a documented project-approved artifact root. Logs, eval outputs, screenshots,
traces, package listings, and temporary files should be indexed in
`artifact-index.json` and referenced from `EVIDENCE.md` when they support a
claim.

Before packaging, verify that unindexed harness artifacts are not scattered in
source directories and that public packages exclude raw logs, credential state,
caches, traces, and temporary files unless explicitly sanitized and approved.

## Harness Evolution Gate

The harness may evolve when new cases appear. Add or change suites, gates,
tools, tasks, risks, and resource rules only through durable harness updates.
Record the rationale, update both human and machine-readable state, identify
affected regression layers, run the checker, and record evidence.

Do not remove or relax a required case because it is hard. Mark it
`not_applicable` or `dropped` only with a recorded scope decision.

## Resource Safety

Before heavy work, write the impact assessment in the plan or event log:

- process count,
- expected memory and disk scale,
- expected duration,
- concurrency conflicts,
- timeout and cleanup mechanism.
- artifact location and output cap.

Use the project's existing safe runner, watchdog, queue, or process-group
wrapper when available. If no safe runner exists, use bounded commands and
avoid background tasks that outlive the agent session.

## Packaging And Privacy

Before a deliverable leaves the worktree:

1. Run `privacy_scan.py` with project-specific forbidden words.
2. Exclude runtime caches, dependency folders, local state, logs, credentials,
   session histories, personal paths, machine paths, and benchmark raw data.
3. Confirm public copy does not mention private reference projects, internal
   services, hostnames, user accounts, or unreleased claims.
4. Verify the package listing, not only the source tree.

## Failure Handling

When a gate fails:

- Record the exact command and failure summary in `EVIDENCE.md`.
- Add or update a risk in `RISKS.md`.
- Fix the root cause, then rerun the same gate.
- If the gate cannot run because of external state, mark it `blocked` and name
  the missing condition.
- Do not hide a failing required gate in documentation or release notes.
