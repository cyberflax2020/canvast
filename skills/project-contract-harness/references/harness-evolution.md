# Harness Evolution

## Table Of Contents

- Purpose
- What May Change
- Evolution Rules
- Adding A Test Suite
- Changing A Gate
- Retiring A Case
- Drift Control

## Purpose

The project harness is durable, not frozen. As the agent learns the project,
finds new failure modes, or receives new requirements, it should evolve the
contract. Evolution must happen inside the harness files so future agents can
see what changed and why.

## What May Change

The agent may add or revise:

- phases and active slices in `PLAN.md`,
- tasks in `TASKS.md` and `tasks.json`,
- gates in `gates.json`,
- matrix dimensions, suites, and cases in `EVAL_MATRIX.md` and
  `eval-matrix.json`,
- gaps in `GAPS.md` and `gaps.json`,
- risks and mitigations in `RISKS.md`,
- project-specific commands in `TOOLING.md`,
- resource rules in `RESOURCE_GUARD.md`,
- documentation and comments that explain verified current behavior.

## Evolution Rules

Every harness change needs:

1. a reason tied to a requirement, failure, risk, or new evidence;
2. a recorded decision or event when it changes scope, gates, dependencies, or
   delivery criteria;
3. an impact note naming which regression layers must rerun;
4. matching updates to both human-readable and machine-readable files when both
   exist;
5. checker validation after the update.

Do not remove or relax a required gate, suite, case, or gap just because it is
hard to satisfy. Use `not_applicable` or `dropped` only with a recorded scope
decision and evidence.

## Adding A Test Suite

When a new case family appears:

1. Add the dimension or suite to `EVAL_MATRIX.md`.
2. Add machine-readable cases to `eval-matrix.json`.
3. Add or reference the project-specific runner in `TOOLING.md`.
4. Decide the layer: L0, L1, L2, L3, L4, or L5.
5. Run at least one representative case.
6. Convert failures or missing evidence into gaps.
7. Update gates if the suite becomes required for delivery.

## Changing A Gate

Gate changes are delivery-contract changes. Record:

- old claim,
- new claim,
- why the old gate was insufficient,
- effect on required tasks and gaps,
- command that verifies the new gate.

If the new gate broadens scope, keep it `open` until evidence exists. If the
gate narrows scope, record the user-approved reason.

## Retiring A Case

Retire a case only when:

- it is superseded by a stronger discriminator,
- the product requirement changed,
- the case is invalid and the invalidity is proven,
- or the user removed that scope.

Mark it `not_applicable` or `dropped`; do not delete history needed to explain
why it disappeared.

## Drift Control

After harness evolution:

1. Run the contract checker.
2. Rerun the smallest affected regression layer.
3. Update `EVIDENCE.md`.
4. Update `HANDOFF.md` so a fresh agent sees the new rule.
5. Ensure public docs do not claim old behavior.
