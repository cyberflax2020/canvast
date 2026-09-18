#!/usr/bin/env python3
"""Scan a project or package directory for common private-data leaks."""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path


DEFAULT_EXCLUDES = {
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "dist",
    "build",
    ".runtime",
    ".cache",
    ".pytest_cache",
    "__pycache__",
}

BINARY_EXTENSIONS = {
    ".7z",
    ".a",
    ".bin",
    ".class",
    ".dmg",
    ".DS_Store",
    ".gif",
    ".gz",
    ".ico",
    ".jar",
    ".jpeg",
    ".jpg",
    ".mov",
    ".mp4",
    ".o",
    ".pdf",
    ".png",
    ".pyc",
    ".so",
    ".tar",
    ".woff",
    ".woff2",
    ".zip",
}

USER_ROOT_UNIX_PATTERN = re.compile(
    r"/" + r"(?:Users|home)" + r"/[^\s:'\"`]+"
)
USER_ROOT_WINDOWS_PATTERN = re.compile(
    "[A-Za-z]:\\\\Users\\\\[^\\s:'\"`]+"
)

PATTERNS = [
    ("private-key-block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("generic-secret-assignment", re.compile(r"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*['\"]?[A-Za-z0-9_./+=-]{12,}")),
    ("bearer-token", re.compile(r"(?i)bearer\s+[A-Za-z0-9_./+=-]{16,}")),
    ("local-unix-user-path", USER_ROOT_UNIX_PATTERN),
    ("local-windows-user-path", USER_ROOT_WINDOWS_PATTERN),
]


def should_skip(path: Path, root: Path) -> bool:
    relative_parts = path.relative_to(root).parts
    if any(part in DEFAULT_EXCLUDES for part in relative_parts[:-1]):
        return True
    return path.name in BINARY_EXTENSIONS or path.suffix in BINARY_EXTENSIONS


def should_skip_dir(path: Path, root: Path) -> bool:
    if path == root:
        return False
    relative_parts = path.relative_to(root).parts
    return any(part in DEFAULT_EXCLUDES for part in relative_parts)


def iter_files(root: Path):
    for current, dirnames, filenames in os.walk(root):
        base = Path(current)
        dirnames[:] = [
            name for name in dirnames if not should_skip_dir(base / name, root)
        ]
        for name in filenames:
            path = base / name
            if not should_skip(path, root):
                yield path


def scan_file(path: Path, forbidden_words: list[str]) -> list[tuple[str, int, str]]:
    findings: list[tuple[str, int, str]] = []
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return findings
    except OSError as exc:
        return [("read-error", 0, str(exc))]

    rel_text = str(path)
    if re.search(r"(^|/)\.env(\.|$)", rel_text):
        findings.append(("env-file-name", 0, "environment file should not be packaged"))

    for line_no, line in enumerate(text.splitlines(), start=1):
        for label, pattern in PATTERNS:
            if pattern.search(line):
                findings.append((label, line_no, line.strip()[:240]))
        lowered = line.lower()
        for word in forbidden_words:
            if word.lower() in lowered:
                findings.append((f"forbidden-word:{word}", line_no, line.strip()[:240]))
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", help="Project, package, or artifact directory to scan")
    parser.add_argument(
        "--forbidden-word",
        action="append",
        default=[],
        help="Project-specific word that must not appear in deliverables; repeatable",
    )
    parser.add_argument("--max-findings", type=int, default=80, help="Maximum findings to print")
    args = parser.parse_args()

    root = Path(args.path).resolve()
    if not root.exists():
        print(f"Privacy scan failed: path does not exist: {root}")
        return 2

    all_findings: list[tuple[Path, str, int, str]] = []
    for path in iter_files(root):
        for label, line_no, snippet in scan_file(path, args.forbidden_word):
            all_findings.append((path, label, line_no, snippet))

    if all_findings:
        print(f"Privacy scan failed: {len(all_findings)} finding(s).")
        for path, label, line_no, snippet in all_findings[: args.max_findings]:
            rel = path.relative_to(root)
            suffix = f":{line_no}" if line_no else ""
            print(f"- {rel}{suffix} [{label}] {snippet}")
        remaining = len(all_findings) - args.max_findings
        if remaining > 0:
            print(f"... {remaining} more")
        return 1

    print(f"Privacy scan passed: {root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
