# Documentation And Comment Discipline

## Table Of Contents

- Purpose
- Durable Documents
- During Implementation
- Comments
- Final Documentation Gate

## Purpose

Long-running project work fails when decisions, constraints, and verification
evidence exist only in chat. Keep enough local documentation for a fresh agent
to understand what changed, why it changed, how it was verified, and what still
must not be touched.

## Durable Documents

Maintain these documents throughout the work:

- `CONTRACT.md`: mission, constraints, non-goals.
- `PLAN.md`: phase plan and current slice.
- `TASKS.md`: durable todo list.
- `STARTUP.md`: session-start recovery checklist and latest startup evidence.
- `DECISIONS.md`: append-only decisions.
- `RISKS.md`: blockers and mitigations.
- `AUTONOMY.md`: boundary between agent-owned work and true blockers.
- `TOOLING.md`: project-specific commands and runner inventory.
- `SECRET_ACCESS.md`: credential access rules without secret values.
- `ARTIFACTS.md`: centralized runtime artifact policy and index rules.
- `RESOURCE_GUARD.md`: heavy-command safety record.
- `EVAL_MATRIX.md`: claim-to-test mapping.
- `GAPS.md`: failed cases and closure state.
- `EVIDENCE.md`: commands and results.
- `HANDOFF.md`: exact resume instructions.

If the target project already has equivalent docs, link or mirror the important
state instead of creating duplicate narratives.

## During Implementation

At each milestone:

1. Update task state.
2. Update gap state if a case failed or closed.
3. Record the command and result.
4. Append any architecture or process decision.
5. Record new risk or downgraded assumption.
6. Update tooling, secret access, resource, and artifact records when commands,
   credentials, process behavior, or output locations change.
7. Keep public or user-facing docs aligned with verified behavior only.

Do not defer all documentation until the end of a long unattended run; that is
how context is lost.

## Comments

Use comments when they preserve intent that is not obvious from code:

- invariants,
- state-machine transitions,
- resource cleanup rules,
- safety boundaries,
- parser or schema assumptions,
- non-obvious compatibility constraints.

Do not comment routine assignments or repeat the code in prose. Prefer small,
targeted comments near the logic they explain.

## Final Documentation Gate

Before delivery:

1. Check that docs describe current behavior, not planned behavior.
2. Mark unverified behavior as unverified or remove it from public-facing docs.
3. Ensure commands in docs still match the implemented scripts.
4. Ensure package/readme/handoff text contains no private names, local paths,
   credentials, or environment-specific details.
5. Ensure runtime artifacts are centralized and indexed, not scattered through
   source directories.
6. Ensure a fresh agent can resume from `STARTUP.md`, `HANDOFF.md`, `TASKS.md`,
   `GAPS.md`, `TOOLING.md`, `SECRET_ACCESS.md`, `ARTIFACTS.md`, and
   `EVIDENCE.md` without chat history.
