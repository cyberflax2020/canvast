#!/usr/bin/env python3
"""Smoke check for bundled Canvast skill packages."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ALLOWED_SPDX_LICENSES = {
    "0BSD",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BlueOak-1.0.0",
    "ISC",
    "MIT",
}
LICENSE_BODY_MARKERS = {
    "0BSD": (
        "Permission to use, copy, modify, and/or distribute this software for any",
        "purpose with or without fee",
    ),
    "Apache-2.0": (
        "Apache License",
        "Version 2.0",
    ),
    "BSD-2-Clause": (
        "Redistribution and use in source and binary forms, with or without",
        "THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS",
    ),
    "BSD-3-Clause": (
        "Redistribution and use in source and binary forms, with or without",
        "Neither the name",
    ),
    "BlueOak-1.0.0": (
        "Blue Oak Model License",
        "Version 1.0.0",
    ),
    "ISC": (
        "Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee",
        "THE SOFTWARE IS PROVIDED \"AS IS\"",
    ),
    "MIT": (
        "Permission is hereby granted, free of charge, to any person obtaining a copy",
        "THE SOFTWARE IS PROVIDED \"AS IS\"",
    ),
}
PROJECT_CONTRACT_HARNESS_LICENSE_SHA256 = "d0b35a4f8af554b5963e73362fcb111299281984095372ca669048f8f9b33e6a"


def read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def read_yaml_scalar_blocks(path: Path) -> dict:
    """Parse the tiny YAML subset used by agents/openai.yaml."""
    result: dict[str, object] = {}
    current_block: dict[str, object] | None = None
    current_block_name = ""
    if not path.exists():
        return result
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        if not raw_line.startswith(" ") and raw_line.endswith(":"):
            current_block_name = raw_line[:-1].strip()
            current_block = {}
            result[current_block_name] = current_block
            continue
        if current_block is None or ":" not in raw_line:
            continue
        key, raw_value = raw_line.strip().split(":", 1)
        value = raw_value.strip()
        if value.startswith('"') and value.endswith('"') and len(value) >= 2:
            parsed: object = value[1:-1]
        elif value == "true":
            parsed = True
        elif value == "false":
            parsed = False
        else:
            parsed = value
        current_block[key.strip()] = parsed
    return result


def read_skill_name(skill_md: Path) -> str:
    if not skill_md.exists():
        return ""
    lines = skill_md.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "---":
        return ""
    for line in lines[1:40]:
        if line.strip() == "---":
            break
        if line.startswith("name:"):
            return line.split(":", 1)[1].strip().strip('"')
    return ""


def ignored_skill_auxiliary_name(name: str) -> bool:
    return name in {"manifest.json", ".DS_Store", "__pycache__"}


def path_inside(root: Path, candidate: Path) -> bool:
    try:
        root_resolved = root.resolve()
        candidate_resolved = candidate.resolve()
    except FileNotFoundError:
        root_resolved = root.resolve()
        candidate_resolved = candidate.resolve(strict=False)
    try:
        candidate_resolved.relative_to(root_resolved)
    except ValueError:
        return False
    return True


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def license_body_matches(spdx_id: str, license_text: str) -> bool:
    markers = LICENSE_BODY_MARKERS.get(spdx_id, ())
    return all(marker in license_text for marker in markers)


def run_command(command: list[str], cwd: Path) -> dict:
    completed = subprocess.run(
        command,
        cwd=str(cwd),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=60,
        check=False,
    )
    return {
        "command": command,
        "returncode": completed.returncode,
        "stdout_tail": completed.stdout[-1000:],
        "stderr_tail": completed.stderr[-1000:],
    }


def validate_skill(repo: Path, entry: dict) -> tuple[dict, list[str]]:
    errors: list[str] = []
    name = str(entry.get("name", ""))
    rel_path = str(entry.get("path", ""))
    skill = repo / rel_path
    skill_md = skill / "SKILL.md"
    openai_yaml = skill / "agents" / "openai.yaml"
    repo_license = repo / "LICENSE"
    declared_license = str(entry.get("license", ""))
    declared_license_file = str(entry.get("licenseFile", ""))
    license_candidate = repo / declared_license_file
    license_file = license_candidate.resolve(strict=False)
    yaml_data = read_yaml_scalar_blocks(openai_yaml)
    policy = yaml_data.get("policy") if isinstance(yaml_data.get("policy"), dict) else {}
    interface = yaml_data.get("interface") if isinstance(yaml_data.get("interface"), dict) else {}
    script_files = sorted(str(path.relative_to(skill)) for path in (skill / "scripts").glob("*.py")) if (skill / "scripts").is_dir() else []
    reference_files = sorted(str(path.relative_to(skill)) for path in (skill / "references").glob("*.md")) if (skill / "references").is_dir() else []
    cache_files = sorted(
        str(path.relative_to(skill))
        for path in skill.rglob("*")
        if "__pycache__" in path.parts or path.suffix == ".pyc"
    ) if skill.exists() else []
    license_exists = license_candidate.exists()
    license_is_symlink = license_candidate.is_symlink()
    license_contained_in_repo = path_inside(repo, license_file)
    license_contained_in_skill = path_inside(skill, license_file) if skill.exists() else False
    license_is_repo_root = license_exists and license_file == repo_license.resolve()
    project_local_skill = name == "canvast-project-operator" or "project-local" in str(entry.get("provenance", "")).lower()
    license_text = read_text(license_candidate) if license_exists else ""
    license_body_match = license_exists and license_body_matches(declared_license, license_text)
    license_sha256 = sha256_file(license_candidate) if license_exists else ""

    if not skill_md.exists():
        errors.append(f"{name}: missing SKILL.md")
    if not openai_yaml.exists():
        errors.append(f"{name}: missing agents/openai.yaml")
    if read_skill_name(skill_md) != name:
        errors.append(f"{name}: SKILL.md frontmatter name mismatch")
    if not interface.get("default_prompt"):
        errors.append(f"{name}: missing interface.default_prompt")
    if entry.get("defaultEnabled") is not False:
        errors.append(f"{name}: manifest defaultEnabled must be false")
    if entry.get("allowImplicitInvocation") is not False:
        errors.append(f"{name}: manifest allowImplicitInvocation must be false")
    if entry.get("activation") != "explicit":
        errors.append(f"{name}: manifest activation must be explicit")
    if policy.get("allow_implicit_invocation") is not False:
        errors.append(f"{name}: agents/openai.yaml must set policy.allow_implicit_invocation=false")
    if declared_license not in ALLOWED_SPDX_LICENSES:
        errors.append(f"{name}: unsupported SPDX license: {declared_license}")
    if not license_contained_in_repo:
        errors.append(f"{name}: licenseFile escapes the repository: {declared_license_file}")
    elif not license_exists:
        errors.append(f"{name}: license file missing: {declared_license_file}")
    elif license_is_symlink:
        errors.append(f"{name}: license file must not be a symlink: {declared_license_file}")
    else:
        if not (license_contained_in_skill or (project_local_skill and license_is_repo_root)):
            errors.append(
                f"{name}: licenseFile must resolve to the repo LICENSE for a project-local skill or stay within the skill directory"
            )
        if not license_body_match:
            errors.append(f"{name}: manifest license {declared_license} does not match license file body")
        if name == "project-contract-harness" and license_sha256 != PROJECT_CONTRACT_HARNESS_LICENSE_SHA256:
            errors.append(f"{name}: LICENSE hash drifted from the audited source package")
    if cache_files:
        errors.append(f"{name}: Python cache files must not be packaged: {cache_files[:5]}")

    return {
        "name": name,
        "path": rel_path,
        "skill_md": skill_md.exists(),
        "openai_yaml": openai_yaml.exists(),
        "license": declared_license,
        "license_file": declared_license_file,
        "license_spdx_allowed": declared_license in ALLOWED_SPDX_LICENSES,
        "license_file_exists": license_exists,
        "license_file_contained_in_repo": license_contained_in_repo,
        "license_file_contained_in_skill": license_contained_in_skill,
        "license_file_is_repo_root": license_is_repo_root,
        "license_body_matches_declaration": license_body_match,
        "license_sha256": license_sha256,
        "license_hash_verified": (
            name != "project-contract-harness"
            or (license_exists and license_sha256 == PROJECT_CONTRACT_HARNESS_LICENSE_SHA256)
        ),
        "activation": entry.get("activation"),
        "default_enabled": entry.get("defaultEnabled"),
        "allow_implicit_invocation": entry.get("allowImplicitInvocation"),
        "openai_policy_allow_implicit_invocation": policy.get("allow_implicit_invocation"),
        "scripts": script_files,
        "references": reference_files,
        "python_cache_files": cache_files,
    }, errors


def smoke_project_contract_harness(repo: Path, skill: Path) -> dict:
    with tempfile.TemporaryDirectory(prefix="canvast-skill-smoke-") as tmp:
        target = Path(tmp) / "target-project"
        target.mkdir(parents=True)
        (target / "package.json").write_text('{"name":"skill-smoke","version":"0.0.0"}\n', encoding="utf-8")
        init = run_command([sys.executable, str(skill / "scripts" / "init_contract.py"), "--project-root", str(target)], repo)
        check = run_command([sys.executable, str(skill / "scripts" / "check_contract.py"), "--project-root", str(target), "--allow-unverified"], repo)
        return {
            "init_contract": init,
            "check_contract": check,
            "contract_dir_created": (target / ".project-contract-harness").is_dir(),
        }


def detect_unmanaged_skill_directories(repo: Path, manifest_names: set[str]) -> list[str]:
    skills_root = repo / "skills"
    if not skills_root.exists() or not skills_root.is_dir():
        return []
    unexpected: list[str] = []
    for entry in sorted(skills_root.iterdir(), key=lambda path: path.name):
        if ignored_skill_auxiliary_name(entry.name) or entry.is_symlink() or not entry.is_dir():
            continue
        if entry.name in manifest_names:
            continue
        marker_files = [
            entry / "SKILL.md",
            entry / "agents" / "openai.yaml",
        ]
        if any(path.exists() for path in marker_files):
            unexpected.append(f"skills/{entry.name}")
    return unexpected


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=".", help="Canvast repository root")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    manifest_path = repo / "skills" / "manifest.json"
    manifest = read_json(manifest_path)
    entries = manifest.get("skills", [])
    errors: list[str] = []
    if manifest.get("version") != 1 or not isinstance(entries, list):
        errors.append("skills/manifest.json must have version=1 and a skills array")
        entries = []

    skill_results: list[dict] = []
    names: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            errors.append("skills/manifest.json contains a non-object entry")
            continue
        name = str(entry.get("name", ""))
        if name in names:
            errors.append(f"duplicate skill manifest name: {name}")
        names.add(name)
        result, skill_errors = validate_skill(repo, entry)
        skill_results.append(result)
        errors.extend(skill_errors)

    required_names = {"canvast-project-operator", "project-contract-harness"}
    missing_names = sorted(required_names.difference(names))
    for name in missing_names:
        errors.append(f"missing required bundled skill: {name}")
    for relative in detect_unmanaged_skill_directories(repo, names):
        errors.append(f"unmanaged skill directory is present outside skills/manifest.json: {relative}")

    resolver_check = run_command(
        ["node", "scripts/resolve-canvast-skill.mjs", str(repo), "project-contract-harness"],
        repo,
    )
    if resolver_check["returncode"] != 0 or "skills/project-contract-harness" not in resolver_check["stdout_tail"]:
        errors.append("project-contract-harness cannot be resolved through explicit Canvast skill resolver")

    project_contract_smoke: dict | None = None
    contract_skill = repo / "skills" / "project-contract-harness"
    if contract_skill.exists():
        project_contract_smoke = smoke_project_contract_harness(repo, contract_skill)
        if project_contract_smoke["init_contract"]["returncode"] != 0:
            errors.append("project-contract-harness init_contract.py smoke failed")
        if project_contract_smoke["check_contract"]["returncode"] != 0:
            errors.append("project-contract-harness check_contract.py smoke failed")
        if not project_contract_smoke["contract_dir_created"]:
            errors.append("project-contract-harness smoke did not create contract directory")

    runtime = read_json(repo / "runtime-status.json")
    recall = read_json(repo / "context-recall" / "index.json")
    archive = read_json(repo / "context-recall" / "archive-index.json")
    graph = read_json(repo / "canvas-graph.json")

    result = {
        "ok": not errors,
        "manifest": str(manifest_path),
        "skills": skill_results,
        "resolver": resolver_check,
        "project_contract_harness_smoke": project_contract_smoke,
        "errors": errors,
        "project_state": {
            "runtime_status_present": bool(runtime),
            "canvas_nodes": len(graph.get("nodes", [])) if isinstance(graph.get("nodes", []), list) else 0,
            "canvas_edges": len(graph.get("edges", [])) if isinstance(graph.get("edges", []), list) else 0,
            "recall_hot_records": len(recall.get("records", [])) if isinstance(recall.get("records", []), list) else 0,
            "recall_archive_records": len(archive.get("records", [])) if isinstance(archive.get("records", []), list) else 0,
        },
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
