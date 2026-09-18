# Artifact Management

## Table Of Contents

- Purpose
- Default Layout
- Write Policy
- Artifact Index
- Retention And Cleanup
- Packaging

## Purpose

Long-running harnesses produce logs, raw eval outputs, screenshots, traces,
coverage files, package listings, temporary state, and runner reports. These
artifacts must be discoverable without polluting the project tree.

## Default Layout

Keep harness-owned runtime artifacts under:

```text
.project-contract-harness/
  artifacts/
    logs/
    eval-runs/
    regressions/
    screenshots/
    traces/
    packages/
    tmp/
  ARTIFACTS.md
  artifact-index.json
```

Use a project-specific directory only when the project already has an accepted
artifact convention. Record that override in `ARTIFACTS.md`.

## Write Policy

- Do not scatter temporary files in source directories.
- Do not write raw provider traces, local state, caches, or logs into public
  package paths.
- Put generated reports under `artifacts/` unless they are intentional project
  documentation.
- Put project-owned reusable scripts in the normal source or scripts directory,
  not under `artifacts/`.
- Use stable run ids for long commands so evidence, logs, gaps, and reports can
  be linked.
- Keep artifact paths relative in contract files unless an absolute path is
  required for a local command; never publish local absolute paths.

## Artifact Index

Maintain `artifact-index.json` with entries like:

```json
{
  "id": "run-001",
  "kind": "eval-run",
  "created_at": "YYYY-MM-DDTHH:MM:SSZ",
  "path": ".project-contract-harness/artifacts/eval-runs/run-001.json",
  "producer": "project-specific command",
  "linked_gate": "full-verification",
  "linked_cases": ["case-001"],
  "privacy": "internal-only"
}
```

The index is not proof by itself. `EVIDENCE.md`, gates, matrix cases, and gaps
must point to the relevant artifact and command result.

## Retention And Cleanup

- Keep raw artifacts needed to reproduce open required gaps.
- Keep final evidence artifacts for verified delivery gates.
- Move obsolete scratch output to `artifacts/tmp/` or delete it when no longer
  referenced.
- Before final packaging, confirm no unindexed harness artifacts remain outside
  the artifact root or project-approved output directories.

## Packaging

Public packages should include only intentional docs, scripts, tests, and
sanitized reports. Exclude raw logs, credential state, local caches, unredacted
traces, temporary files, and internal-only artifacts unless the user explicitly
requires and approves them.
