#!/usr/bin/env python3
"""Validate a project-contract-harness directory."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


CONTRACT_DIR = ".project-contract-harness"
REQUIRED_FILES = [
    "CONTRACT.md",
    "PLAN.md",
    "TASKS.md",
    "STATUS.md",
    "STARTUP.md",
    "DECISIONS.md",
    "RISKS.md",
    "AUTONOMY.md",
    "TOOLING.md",
    "SECRET_ACCESS.md",
    "ARTIFACTS.md",
    "RESOURCE_GUARD.md",
    "EVAL_MATRIX.md",
    "GAPS.md",
    "EVIDENCE.md",
    "HANDOFF.md",
    "gates.json",
    "tasks.json",
    "resource-state.json",
    "secret-state.json",
    "artifact-index.json",
    "eval-matrix.json",
    "gaps.json",
    "events.jsonl",
]
REQUIRED_ARTIFACT_DIRS = [
    "logs",
    "eval-runs",
    "regressions",
    "screenshots",
    "traces",
    "packages",
    "tmp",
]
VALID_STATES = {
    "open",
    "in_progress",
    "implemented_unverified",
    "verified",
    "blocked",
    "dropped",
    "not_applicable",
}
VALID_LEVELS = {"L0", "L1", "L2", "L3", "L4", "L5"}
FORBIDDEN_SECRET_FIELDS = {"value", "token", "api_key", "apikey", "password", "secret"}
REQUIRED_GATE_IDS = {
    "contract-initialized",
    "state-recovery-ready",
    "focused-tests",
    "tasks-current",
    "resource-guard-ready",
    "autonomy-boundary",
    "project-tooling-designed",
    "secret-access-defined",
    "artifact-management-clean",
    "harness-evolution-controlled",
    "eval-matrix-designed",
    "required-gaps-closed",
    "layered-regression",
    "outcome-compliance",
    "documentation-current",
    "full-verification",
    "privacy-clean",
}


def validate_blockers(where: str, blockers) -> list[str]:
    errors: list[str] = []
    if not isinstance(blockers, list) or not blockers:
        return [f"{where}: blocked required item needs structured blockers"]
    for index, blocker in enumerate(blockers):
        blocker_where = f"{where}: blockers[{index}]"
        if not isinstance(blocker, dict):
            errors.append(f"{blocker_where}: must be an object")
            continue
        for field in ["condition", "required_action", "rerun_after_unblocked"]:
            if not str(blocker.get(field, "")).strip():
                errors.append(f"{blocker_where}: {field} is required")
        attempts = blocker.get("attempts")
        if not isinstance(attempts, list) or not attempts:
            errors.append(f"{blocker_where}: attempts must list local workarounds tried")
        independent_work = blocker.get("independent_work")
        if not isinstance(independent_work, list):
            errors.append(f"{blocker_where}: independent_work must be an array")
    return errors


def load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - CLI should report any parse error.
        raise ValueError(f"{path}: invalid JSON: {exc}") from exc


def validate_gates(path: Path) -> list[str]:
    errors: list[str] = []
    data = load_json(path)
    if data.get("version") != 1:
        errors.append("gates.json: version must be 1")
    gates = data.get("gates")
    if not isinstance(gates, list):
        return errors + ["gates.json: gates must be an array"]

    seen: set[str] = set()
    for index, gate in enumerate(gates):
        where = f"gates.json: gates[{index}]"
        if not isinstance(gate, dict):
            errors.append(f"{where}: must be an object")
            continue
        gate_id = gate.get("id")
        if not isinstance(gate_id, str) or not gate_id.strip():
            errors.append(f"{where}: id is required")
        elif gate_id in seen:
            errors.append(f"{where}: duplicate id {gate_id}")
        else:
            seen.add(gate_id)
        state = gate.get("state")
        if state not in VALID_STATES:
            errors.append(f"{where}: invalid state {state!r}")
        if gate.get("required") is True and state == "verified":
            if not str(gate.get("acceptance", "")).strip():
                errors.append(f"{where}: verified required gate needs acceptance")
            if not str(gate.get("last_evidence", "")).strip():
                errors.append(f"{where}: verified required gate needs last_evidence")
        if gate.get("required") is True and state == "not_applicable":
            if not str(gate.get("last_evidence", "")).strip():
                errors.append(f"{where}: not_applicable required gate needs last_evidence")
        if gate.get("required") is True and state not in {"verified", "not_applicable"}:
            if state == "blocked":
                errors.extend(validate_blockers(where, gate.get("blockers", [])))
    missing_ids = sorted(REQUIRED_GATE_IDS.difference(seen))
    if missing_ids:
        errors.append("gates.json: missing required gate id(s): " + ", ".join(missing_ids))
    return errors


def validate_eval_matrix(path: Path) -> list[str]:
    errors: list[str] = []
    data = load_json(path)
    if data.get("version") != 1:
        errors.append("eval-matrix.json: version must be 1")
    cases = data.get("cases")
    if not isinstance(cases, list):
        return errors + ["eval-matrix.json: cases must be an array"]

    seen: set[str] = set()
    for index, case in enumerate(cases):
        where = f"eval-matrix.json: cases[{index}]"
        if not isinstance(case, dict):
            errors.append(f"{where}: must be an object")
            continue
        case_id = case.get("id")
        if not isinstance(case_id, str) or not case_id.strip():
            errors.append(f"{where}: id is required")
        elif case_id in seen:
            errors.append(f"{where}: duplicate id {case_id}")
        else:
            seen.add(case_id)
        for field in ["dimension", "claim", "oracle", "command", "status", "level"]:
            if not str(case.get(field, "")).strip():
                errors.append(f"{where}: {field} is required")
        state = case.get("status")
        if state not in VALID_STATES:
            errors.append(f"{where}: invalid status {state!r}")
        level = case.get("level")
        if level is not None and level not in VALID_LEVELS:
            errors.append(f"{where}: invalid level {level!r}")
        if state == "verified" and not str(case.get("last_evidence", "")).strip():
            errors.append(f"{where}: verified case needs last_evidence")
        limits = case.get("resource_limits", {})
        if limits and not isinstance(limits, dict):
            errors.append(f"{where}: resource_limits must be an object")
    return errors


def validate_tasks(path: Path) -> list[str]:
    errors: list[str] = []
    data = load_json(path)
    if data.get("version") != 1:
        errors.append("tasks.json: version must be 1")
    tasks = data.get("tasks")
    if not isinstance(tasks, list):
        return errors + ["tasks.json: tasks must be an array"]

    seen: set[str] = set()
    for index, task in enumerate(tasks):
        where = f"tasks.json: tasks[{index}]"
        if not isinstance(task, dict):
            errors.append(f"{where}: must be an object")
            continue
        task_id = task.get("id")
        if not isinstance(task_id, str) or not task_id.strip():
            errors.append(f"{where}: id is required")
        elif task_id in seen:
            errors.append(f"{where}: duplicate id {task_id}")
        else:
            seen.add(task_id)
        state = task.get("state")
        if state not in VALID_STATES:
            errors.append(f"{where}: invalid state {state!r}")
        if not str(task.get("task", "")).strip():
            errors.append(f"{where}: task is required")
        if task.get("required") is True and state == "verified":
            if not str(task.get("acceptance", "")).strip():
                errors.append(f"{where}: verified required task needs acceptance")
            if not str(task.get("evidence", "")).strip():
                errors.append(f"{where}: verified required task needs evidence")
        if task.get("required") is True and state == "blocked":
            errors.extend(validate_blockers(where, task.get("blockers", [])))
    return errors


def validate_resource_state(path: Path) -> list[str]:
    errors: list[str] = []
    data = load_json(path)
    if data.get("version") != 1:
        errors.append("resource-state.json: version must be 1")
    watchdog = data.get("watchdog", {})
    if not isinstance(watchdog, dict):
        errors.append("resource-state.json: watchdog must be an object")
    else:
        status = watchdog.get("status", "not_started")
        if status not in {"not_started", "running", "stale", "stopped", "not_applicable"}:
            errors.append(f"resource-state.json: invalid watchdog status {status!r}")
        if status == "running" and not str(watchdog.get("state_file", "")).strip():
            errors.append("resource-state.json: running watchdog needs state_file")
    assessments = data.get("assessments", [])
    if not isinstance(assessments, list):
        errors.append("resource-state.json: assessments must be an array")
    return errors


def validate_secret_state(path: Path) -> list[str]:
    errors: list[str] = []
    data = load_json(path)
    if data.get("version") != 1:
        errors.append("secret-state.json: version must be 1")
    secrets = data.get("secrets")
    if not isinstance(secrets, list):
        return errors + ["secret-state.json: secrets must be an array"]

    seen: set[str] = set()
    for index, secret in enumerate(secrets):
        where = f"secret-state.json: secrets[{index}]"
        if not isinstance(secret, dict):
            errors.append(f"{where}: must be an object")
            continue
        forbidden_present = FORBIDDEN_SECRET_FIELDS.intersection(secret)
        if forbidden_present:
            fields = ", ".join(sorted(forbidden_present))
            errors.append(f"{where}: forbidden value-like field(s): {fields}")
        name = secret.get("name")
        if not isinstance(name, str) or not name.strip():
            errors.append(f"{where}: name is required")
        elif name in seen:
            errors.append(f"{where}: duplicate name {name}")
        else:
            seen.add(name)
        for field in ["purpose", "storage", "validation_command", "last_status", "subagent_policy"]:
            if not str(secret.get(field, "")).strip():
                errors.append(f"{where}: {field} is required")
        if secret.get("value_stored") is not False:
            errors.append(f"{where}: value_stored must be false")
        gates = secret.get("gates_unblocked", [])
        if gates and not isinstance(gates, list):
            errors.append(f"{where}: gates_unblocked must be an array")
    return errors


def validate_artifact_index(path: Path) -> list[str]:
    errors: list[str] = []
    data = load_json(path)
    if data.get("version") != 1:
        errors.append("artifact-index.json: version must be 1")
    artifacts = data.get("artifacts")
    if not isinstance(artifacts, list):
        return errors + ["artifact-index.json: artifacts must be an array"]

    seen: set[str] = set()
    for index, artifact in enumerate(artifacts):
        where = f"artifact-index.json: artifacts[{index}]"
        if not isinstance(artifact, dict):
            errors.append(f"{where}: must be an object")
            continue
        artifact_id = artifact.get("id")
        if not isinstance(artifact_id, str) or not artifact_id.strip():
            errors.append(f"{where}: id is required")
        elif artifact_id in seen:
            errors.append(f"{where}: duplicate id {artifact_id}")
        else:
            seen.add(artifact_id)
        for field in ["kind", "path", "producer", "privacy"]:
            if not str(artifact.get(field, "")).strip():
                errors.append(f"{where}: {field} is required")
        path_value = str(artifact.get("path", ""))
        if path_value.startswith("/"):
            errors.append(f"{where}: artifact path should be relative")
    return errors


def validate_gaps(path: Path) -> list[str]:
    errors: list[str] = []
    data = load_json(path)
    if data.get("version") != 1:
        errors.append("gaps.json: version must be 1")
    gaps = data.get("gaps")
    if not isinstance(gaps, list):
        return errors + ["gaps.json: gaps must be an array"]

    seen: set[str] = set()
    for index, gap in enumerate(gaps):
        where = f"gaps.json: gaps[{index}]"
        if not isinstance(gap, dict):
            errors.append(f"{where}: must be an object")
            continue
        gap_id = gap.get("id")
        if not isinstance(gap_id, str) or not gap_id.strip():
            errors.append(f"{where}: id is required")
        elif gap_id in seen:
            errors.append(f"{where}: duplicate id {gap_id}")
        else:
            seen.add(gap_id)
        state = gap.get("state")
        if state not in VALID_STATES:
            errors.append(f"{where}: invalid state {state!r}")
        if not str(gap.get("source_case", "")).strip():
            errors.append(f"{where}: source_case is required")
        if gap.get("required") is True and state == "verified":
            if not str(gap.get("targeted_evidence", "")).strip():
                errors.append(f"{where}: verified required gap needs targeted_evidence")
            if not str(gap.get("broader_evidence", "")).strip():
                errors.append(f"{where}: verified required gap needs broader_evidence")
        if gap.get("required") is True and state == "not_applicable":
            if not str(gap.get("decision", "")).strip():
                errors.append(f"{where}: not_applicable required gap needs decision")
        if gap.get("required") is True and state == "blocked":
            errors.extend(validate_blockers(where, gap.get("blockers", [])))
    return errors


def validate_events(path: Path) -> list[str]:
    errors: list[str] = []
    if not path.exists():
        return ["events.jsonl: missing"]
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"events.jsonl:{number}: invalid JSON: {exc}")
            continue
        if not isinstance(event, dict):
            errors.append(f"events.jsonl:{number}: event must be an object")
            continue
        if not event.get("time") or not event.get("type"):
            errors.append(f"events.jsonl:{number}: event needs time and type")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", default=".", help="Target project root")
    parser.add_argument(
        "--allow-unverified",
        action="store_true",
        help="Return success even when required gates are not verified",
    )
    args = parser.parse_args()

    root = Path(args.project_root).resolve()
    contract = root / CONTRACT_DIR
    errors: list[str] = []
    warnings: list[str] = []

    if not contract.is_dir():
        errors.append(f"missing contract directory: {contract}")
    else:
        for name in REQUIRED_FILES:
            path = contract / name
            if not path.exists():
                errors.append(f"missing {name}")
            elif path.is_file() and name.endswith(".md") and path.stat().st_size == 0:
                errors.append(f"{name} is empty")
        artifact_root = contract / "artifacts"
        if not artifact_root.is_dir():
            errors.append("missing artifacts directory")
        else:
            for name in REQUIRED_ARTIFACT_DIRS:
                if not (artifact_root / name).is_dir():
                    errors.append(f"missing artifacts/{name} directory")

    gates_path = contract / "gates.json"
    if gates_path.exists():
        try:
            gate_errors = validate_gates(gates_path)
            errors.extend(gate_errors)
            data = load_json(gates_path)
            for gate in data.get("gates", []):
                if not isinstance(gate, dict):
                    continue
                if gate.get("required") is True and gate.get("state") not in {"verified", "not_applicable"}:
                    warnings.append(f"{gate.get('id', '<unknown>')}: required gate is {gate.get('state')}")
        except ValueError as exc:
            errors.append(str(exc))

    events_path = contract / "events.jsonl"
    if events_path.exists():
        errors.extend(validate_events(events_path))

    tasks_path = contract / "tasks.json"
    if tasks_path.exists():
        try:
            errors.extend(validate_tasks(tasks_path))
            data = load_json(tasks_path)
            for task in data.get("tasks", []):
                if not isinstance(task, dict):
                    continue
                if task.get("required") is True and task.get("state") not in {"verified", "not_applicable"}:
                    warnings.append(f"{task.get('id', '<unknown>')}: required task is {task.get('state')}")
        except ValueError as exc:
            errors.append(str(exc))

    resource_path = contract / "resource-state.json"
    if resource_path.exists():
        try:
            errors.extend(validate_resource_state(resource_path))
        except ValueError as exc:
            errors.append(str(exc))

    secret_path = contract / "secret-state.json"
    if secret_path.exists():
        try:
            errors.extend(validate_secret_state(secret_path))
        except ValueError as exc:
            errors.append(str(exc))

    artifact_index_path = contract / "artifact-index.json"
    if artifact_index_path.exists():
        try:
            errors.extend(validate_artifact_index(artifact_index_path))
        except ValueError as exc:
            errors.append(str(exc))

    matrix_path = contract / "eval-matrix.json"
    if matrix_path.exists():
        try:
            errors.extend(validate_eval_matrix(matrix_path))
        except ValueError as exc:
            errors.append(str(exc))

    gaps_path = contract / "gaps.json"
    if gaps_path.exists():
        try:
            errors.extend(validate_gaps(gaps_path))
            data = load_json(gaps_path)
            for gap in data.get("gaps", []):
                if not isinstance(gap, dict):
                    continue
                if gap.get("required") is True and gap.get("state") not in {"verified", "not_applicable"}:
                    warnings.append(f"{gap.get('id', '<unknown>')}: required gap is {gap.get('state')}")
        except ValueError as exc:
            errors.append(str(exc))

    if warnings:
        print("Contract warnings:")
        for warning in warnings:
            print(f"- {warning}")
    if errors:
        print("Contract check failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    if warnings and not args.allow_unverified:
        print("Contract check passed structurally, but required gates are not all verified.")
        return 2

    print("Contract check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
