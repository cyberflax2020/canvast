# Autonomy And Blocker Boundaries

## Table Of Contents

- Purpose
- Default Rule
- Not Blockers
- True Blockers
- Required Autonomy Loop
- Asking The User
- Recording Blockers

## Purpose

Long-running delivery agents should not stop because the work became hard. A
blocker is a named external condition that the agent cannot remove through
reasonable local work. Everything else becomes a task, risk, experiment, or gap
and stays inside the delivery loop.

## Default Rule

Default to continuing. The agent owns environment setup, dependency inspection,
test repair, focused reproduction, alternative implementation attempts, local
documentation, and verification reruns unless those actions would violate user
constraints, require external authorization, or risk destructive impact.

Use `blocked` sparingly. A blocked item must name the external condition, the
workarounds already attempted, the exact user or external action required, and
the first command to rerun after it is resolved.

## Not Blockers

Do not stop or ask the user merely because of:

- missing local virtual environments, package managers, build tools, SDKs, or
  dependency caches that can be installed or configured in the workspace;
- failing tests, flaky tests, or missing regression coverage;
- uncertainty about architecture that can be reduced by reading code, docs, or
  mature open-source references;
- missing examples when the agent can create fixtures, golden cases, or
  discriminative probes;
- large logs, long histories, or context pressure when durable files can be
  summarized and resumed;
- integration complexity, subprocess management, or resource risk that can be
  bounded by safe runners, timeouts, watchdogs, and smaller slices;
- code review findings, TODOs, known issues, or generated reports that identify
  implementation work;
- weak evidence when the agent can design a stronger oracle or mark the item
  `implemented_unverified` while continuing other independent work.

These conditions become tasks, risks, matrix cases, or gaps. They do not justify
interrupting unattended progress.

## True Blockers

The agent may ask the user or mark `blocked` only when progress requires one of
these external conditions:

- credentials, API keys, licenses, accounts, permissions, or paid resources not
  available through the established local mechanism;
- product, legal, privacy, destructive, or irreversible decisions that only the
  user can authorize;
- required external services or registries are unavailable after retries and
  there is no offline or mocked path that can advance independent work;
- conflicting concurrent writes make the target files unsafe to edit and no
  disjoint write scope exists;
- sandbox or approval policy blocks a necessary command and no safer equivalent
  exists;
- missing proprietary data or private artifacts that cannot be reconstructed,
  mocked, or excluded by a recorded scope decision;
- mutually exclusive requirements that require user prioritization.

Even then, continue any independent safe work before stopping.

## Required Autonomy Loop

Before marking a required task, gate, or gap as `blocked`:

1. Re-read the contract, task, gap, and evidence files.
2. Try the narrowest reproduction.
3. Search local docs and code for established patterns.
4. Try at least one lower-risk workaround, mock, fixture, or narrowed slice when
   it can produce useful evidence.
5. Record attempts in `EVIDENCE.md`.
6. Record remaining risk in `RISKS.md`.
7. State the exact external condition and rerun command.

If another slice can proceed, leave the item `blocked` but continue with that
slice. Do not stop the whole project because one gate is blocked.

## Asking The User

Ask the user only when the answer changes an external decision or unlocks a
required external resource. Good questions are short and action-specific:

- "Please provide or approve access to this credential mechanism."
- "Choose whether to rewrite public history or create a fresh public package."
- "Approve this destructive migration command."

Avoid asking the user to solve implementation work that the agent can perform:
debugging tests, reading docs, creating fixtures, trying alternate libraries,
or running bounded setup commands.

## Recording Blockers

Every blocker record should include:

```json
{
  "condition": "External condition that prevents progress",
  "attempts": ["Local workaround or evidence command already tried"],
  "required_action": "User or external action needed",
  "independent_work": ["Safe work that can continue meanwhile"],
  "rerun_after_unblocked": "Command or check to run next"
}
```

If the blocker later resolves, update the item to `open` or
`implemented_unverified`, rerun the targeted check, then run the affected
regression layer before marking it `verified`.
