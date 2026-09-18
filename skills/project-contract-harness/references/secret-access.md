# Secret Access Contract

## Table Of Contents

- Purpose
- Persist Access, Not Values
- Required Records
- Sub-Agent Propagation
- Validation And Renewal
- Logging And Packaging
- Blocker Handling

## Purpose

Long sessions and sub-agents often fail when credential handling lives only in a
chat message, a transient shell, or an untracked local `.env` directory. The
project should persist how to access and validate secrets without persisting the
secret values themselves.

## Persist Access, Not Values

Never store secret values in the repository, contract files, logs, prompts,
package manifests, generated reports, or handoff text.

Persist these safe facts instead:

- credential logical name,
- what capability it unlocks,
- approved storage mechanism,
- local command or runtime mechanism that injects it,
- validation command that proves availability without printing the value,
- renewal or re-authentication path,
- redaction rules,
- which gates become blocked if it is unavailable.

Examples of approved storage mechanisms are project-specific. They may include
an existing secret manager, OS keychain, harness-managed credential injection,
CI secret binding, or another user-approved mechanism. Do not invent a plaintext
`.env` workflow for sensitive values.

## Required Records

Maintain:

```text
.project-contract-harness/
  SECRET_ACCESS.md
  secret-state.json
```

Each `secret-state.json` entry should use this shape:

```json
{
  "name": "PROVIDER_API_KEY",
  "purpose": "Live provider smoke tests",
  "storage": "approved secret mechanism or env injection name",
  "value_stored": false,
  "validation_command": "project-owned command that checks availability without printing it",
  "last_status": "unknown",
  "last_evidence": "",
  "gates_unblocked": ["live-provider-smoke"],
  "subagent_policy": "available through the same approved runtime injection; never paste value into prompts"
}
```

`value_stored` must stay `false` for real secrets.

## Sub-Agent Propagation

When a sub-agent needs credentials:

1. Pass only the credential name, purpose, and approved retrieval mechanism.
2. Do not paste secret values into the sub-agent prompt.
3. Require the sub-agent to run the validation command and record redacted
   evidence.
4. Give the sub-agent a disjoint write scope and forbid it from writing secrets
   to logs or generated files.

If the harness cannot propagate the approved secret mechanism safely, keep the
live subtask in the parent agent or mark only that gate `blocked`.

## Validation And Renewal

Credential validation should:

- avoid printing the secret,
- fail closed when missing or expired,
- distinguish auth failure from provider or network failure,
- write redacted evidence to `EVIDENCE.md`,
- update `secret-state.json` with status such as `unknown`, `available`,
  `expired`, `missing`, `invalid`, or `not_applicable`.

Renewal steps must be explicit enough for a fresh agent to know what external
action is needed, but must not include private tokens, account identifiers, or
local personal paths in public artifacts.

## Logging And Packaging

Before packaging or sharing:

- run the project privacy scanner and the bundled privacy scanner,
- scan generated reports and raw artifacts,
- exclude `.env`, credential caches, session logs, shell histories, auth state,
  and raw provider traces unless explicitly sanitized,
- ensure docs describe the access mechanism without exposing values.

## Blocker Handling

Missing credentials block only the gates that truly require them. Continue local
unit, integration, mock, package, documentation, and negative safety work.

Mark a secret-related blocker only after recording:

- missing credential name,
- validation command and redacted failure,
- independent work already completed or still possible,
- exact external action needed,
- rerun command after access is restored.
