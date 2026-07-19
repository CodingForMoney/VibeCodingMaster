export function renderCheckScaffoldLedgerTool(): string {
  return `#!/usr/bin/env python3
"""Scaffold-ledger reconciliation — machine enforcement of the Scaffold Manifest bijection.

The architecture plan's Scaffold Manifest is an item ledger: one entry per implementation
item, one unique ID per entry, and exactly one \`VCM:CODE <ID>\` marker in the tree per
\`create\`/\`change\`/\`delete\` entry. This tool checks:

  1. the ledger header follows the mandated column order (\`ID | Action | File | ...\`),
     every ledger ID is unique, classified by its whole-cell action column
     (create/change/delete), and bound to a declared file path in the file column;
  2. the ledger ID set equals the tree marker ID set, each ID exactly once on each side;
  3. every marker sits in its entry's declared file;
  4. the manifest contains no open-ended coverage language ("as work proceeds",
     "replicate", "etc.", "and others").

Markers are scanned in git-tracked source files only (\`.md\` files and \`.ai/\` are excluded:
prose may quote markers legitimately). Pure read; findings go to stderr; exit 0 clean,
1 on findings. \`--plan <path>\` overrides the default plan location. No plan file at all
means there is nothing to check (exit 0) — a docs-only or planning-free task.
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

PLAN = ".ai/vcm/handoffs/architecture-plan.md"
MANIFEST_HEADING = re.compile(r"^##\\s+Scaffold Manifest\\s*$")
SECTION_HEADING = re.compile(r"^##\\s+\\S")
ID_TOKEN = re.compile(r"\\b([A-Z]{2,6}-\\d{1,4})\\b")
# Mandated column order: ID | action | file | symbol/site | work | freedom | proof.
# The action is read from its own cell as a whole-cell verb — never sniffed from the
# row text, so paths or prose containing action words cannot flip an item's class.
ACTIONS = frozenset({"create", "change", "delete"})
PATH_TOKEN = re.compile(r"\`([^\`\\s]+/[^\`\\s]+|[^\`\\s]+\\.[A-Za-z0-9]{1,8})\`")
MARKER_ID = re.compile(r"VCM:CODE[:\\s]\\s*([A-Za-z]{2,6}-\\d{1,4})")
MARKER_ANY = re.compile(r"VCM:CODE")
FORBIDDEN = [
    re.compile(r"as work proceeds", re.IGNORECASE),
    re.compile(r"\\breplicate\\b", re.IGNORECASE),
    re.compile(r"\\betc\\.", re.IGNORECASE),
    re.compile(r"\\band others\\b", re.IGNORECASE),
]


def manifest_section(plan_text: str) -> tuple[int, list[str]] | None:
    """(start line number, section lines) of the Scaffold Manifest section, or None."""
    lines = plan_text.splitlines()
    start = None
    for index, line in enumerate(lines):
        if start is None:
            if MANIFEST_HEADING.match(line):
                start = index + 1
        elif SECTION_HEADING.match(line):
            return (start, lines[start : index])
    return None if start is None else (start, lines[start:])


def parse_ledger(section_start: int, section: list[str], plan: str) -> tuple[dict, list[str]]:
    """{id: {"path", "action", "line"}} plus parse findings. Positional parsing per the
    mandated column order; the first non-entry table row is validated as the header."""
    entries: dict[str, dict] = {}
    findings: list[str] = []
    header_checked = False
    for offset, line in enumerate(section):
        line_no = section_start + offset + 1
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if not cells or set(cells[0]) <= {"-", ":", " "}:
            continue  # separator row
        id_match = ID_TOKEN.search(cells[0])
        if not id_match:
            if not header_checked:
                header_checked = True
                head = [cell.lower() for cell in cells[:3]] + ["", "", ""]
                if not (
                    "id" in head[0]
                    and "action" in head[1]
                    and ("file" in head[2] or "path" in head[2])
                ):
                    findings.append(
                        f"{plan}:{line_no}  [ledger] header columns must be "
                        f"\`ID | Action | File | ...\` -> fix the ledger column order"
                    )
            continue
        entry_id = id_match.group(1)
        if entry_id in entries:
            findings.append(
                f"{plan}:{line_no}  [ledger] duplicate ledger ID {entry_id} "
                f"(first at line {entries[entry_id]['line']}) -> one entry per item"
            )
            continue
        action_cell = cells[1].lower() if len(cells) > 1 else ""
        action = action_cell if action_cell in ACTIONS else None
        declared = None
        if len(cells) > 2:
            path_match = PATH_TOKEN.search(cells[2])
            declared = path_match.group(1) if path_match else None
        if action is None:
            findings.append(
                f"{plan}:{line_no}  [ledger] {entry_id} action column is not exactly "
                f"one of create/change/delete -> classify the item in column 2"
            )
        if declared is None:
            findings.append(
                f"{plan}:{line_no}  [ledger] {entry_id} has no declared file path in "
                f"column 3 -> bind the item to its exact file"
            )
        entries[entry_id] = {"path": declared, "action": action, "line": line_no}
    return entries, findings


def forbidden_language(section_start: int, section: list[str], plan: str) -> list[str]:
    findings = []
    for offset, line in enumerate(section):
        for pattern in FORBIDDEN:
            if pattern.search(line):
                findings.append(
                    f"{plan}:{section_start + offset + 1}  [ledger] open-ended coverage "
                    f"language ({pattern.pattern}) -> enumerate every item explicitly"
                )
    return findings


def tree_markers(root: Path) -> tuple[dict[str, list[tuple[str, int]]], list[str]]:
    """{id: [(path, line)]} for tracked source markers, plus malformed-marker findings."""
    result = subprocess.run(
        ["git", "grep", "-In", "VCM:CODE", "--", ".", ":!*.md", ":!.ai"],
        capture_output=True,
        text=True,
        cwd=root,
    )
    markers: dict[str, list[tuple[str, int]]] = {}
    findings: list[str] = []
    for raw in result.stdout.splitlines():
        parts = raw.split(":", 2)
        if len(parts) < 3:
            continue
        path, line_no, content = parts[0], int(parts[1]), parts[2]
        id_match = MARKER_ID.search(content)
        if id_match:
            markers.setdefault(id_match.group(1), []).append((path, line_no))
        elif MARKER_ANY.search(content):
            findings.append(
                f"{path}:{line_no}  [ledger] marker without a parseable ID -> "
                f"use \`VCM:CODE <ID>\`"
            )
    return markers, findings


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Scaffold Manifest ledger <-> VCM:CODE marker bijection check."
    )
    parser.add_argument("--plan", default=None, help=f"plan path (default {PLAN})")
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[2]
    plan_path = Path(args.plan) if args.plan else root / PLAN
    plan = str(plan_path)
    if not plan_path.is_file():
        print(f"no architecture plan at {plan_path}; nothing to check")
        return 0

    findings: list[str] = []
    section = manifest_section(plan_path.read_text(errors="replace"))
    if section is None:
        sys.stderr.write(f"{plan_path}:1  [ledger] no \`## Scaffold Manifest\` section\\n")
        return 1
    entries, parse_findings = parse_ledger(*section, str(plan_path))
    findings += parse_findings
    findings += forbidden_language(*section, str(plan_path))

    markers, marker_findings = tree_markers(root)
    findings += marker_findings

    for entry_id, sites in sorted(markers.items()):
        if len(sites) > 1:
            where = ", ".join(f"{p}:{n}" for p, n in sites)
            findings.append(
                f"[ledger] {entry_id} has {len(sites)} markers ({where}) -> exactly one per item"
            )

    ledger_ids = set(entries)
    tree_ids = set(markers)
    for entry_id in sorted(ledger_ids - tree_ids):
        findings.append(
            f"{plan}:{entries[entry_id]['line']}  [ledger] {entry_id} has no marker "
            f"in the tree -> pre-place \`VCM:CODE {entry_id}\` in its declared file"
        )
    for entry_id in sorted(tree_ids - ledger_ids):
        path, line_no = markers[entry_id][0]
        findings.append(
            f"{path}:{line_no}  [ledger] marker {entry_id} has no ledger entry "
            f"-> every item must be manifested"
        )
    for entry_id in sorted(ledger_ids & tree_ids):
        entry = entries[entry_id]
        if entry["path"]:
            declared = entry["path"]
            for path, line_no in markers[entry_id]:
                if not (path == declared or path.endswith("/" + declared) or declared.endswith("/" + path)):
                    findings.append(
                        f"{path}:{line_no}  [ledger] marker {entry_id} is outside its "
                        f"declared file \`{declared}\`"
                    )

    for finding in findings:
        sys.stderr.write(finding + "\\n")
    if findings:
        sys.stderr.write(f"ledger reconciliation failed with {len(findings)} finding(s)\\n")
        return 1
    print(
        f"ledger reconciliation clean: {len(ledger_ids)} ledger item(s), "
        f"{len(tree_ids)} marker(s)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;
}
