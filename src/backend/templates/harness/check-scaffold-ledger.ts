export function renderCheckScaffoldLedgerTool(): string {
  return `#!/usr/bin/env python3
"""Scaffold-ledger reconciliation — machine enforcement of the Scaffold Manifest bijection.

The architecture plan's Scaffold Manifest is an item ledger: one entry per implementation
item, one unique ID per entry, and exactly one \`VCM:CODE <ID>\` marker in the tree per
\`create\`/\`change\`/\`delete\` entry. This tool checks:

  1. the ledger header follows the mandated column order (\`ID | Action | File | ...\`),
     every data-row ID matches the documented grammar as a complete cell and is unique,
     classified by its whole-cell action column
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
ID_PATTERN = re.compile(r"[A-Z]{2,6}-\\d{1,4}")
EMPTY_MANIFEST = "No scaffold items."
TABLE_SEPARATOR_CELL = re.compile(r":?-{3,}:?")
# Mandated column order: ID | action | file | symbol/site | work | freedom | proof.
# The action is read from its own cell as a whole-cell verb — never sniffed from the
# row text, so paths or prose containing action words cannot flip an item's class.
ACTIONS = frozenset({"create", "change", "delete"})
PATH_TOKEN = re.compile(r"\`([^\`\\s]+/[^\`\\s]+|[^\`\\s]+\\.[A-Za-z0-9]{1,8})\`")
MARKER_ANY = re.compile(r"VCM:CODE(?![A-Za-z0-9_])")
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


def is_separator_row(cells: list[str]) -> bool:
    return bool(cells) and all(TABLE_SEPARATOR_CELL.fullmatch(cell.replace(" ", "")) for cell in cells)


def parse_ledger(section_start: int, section: list[str], plan: str) -> tuple[dict, list[str], bool]:
    """{id: {"path", "action", "line"}}, parse findings, and explicit-empty state."""
    entries: dict[str, dict] = {}
    findings: list[str] = []
    header_line = None
    separator_seen = False
    explicit_empty_line = None
    for offset, line in enumerate(section):
        line_no = section_start + offset + 1
        stripped = line.strip()
        if stripped == EMPTY_MANIFEST:
            if explicit_empty_line is not None:
                findings.append(
                    f"{plan}:{line_no}  [ledger] duplicate \`{EMPTY_MANIFEST}\` declaration "
                    f"(first at line {explicit_empty_line})"
                )
            else:
                explicit_empty_line = line_no
            continue
        if not stripped.startswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]

        if header_line is None:
            header_line = line_no
            head = [cell.lower() for cell in cells[:3]]
            if head != ["id", "action", "file"]:
                findings.append(
                    f"{plan}:{line_no}  [ledger] header columns must begin exactly "
                    f"\`ID | Action | File | ...\` -> fix the ledger column order"
                )
            continue

        if not separator_seen:
            if is_separator_row(cells):
                separator_seen = True
                continue
            findings.append(
                f"{plan}:{line_no}  [ledger] missing Markdown separator row after "
                f"the Scaffold Manifest header"
            )
            separator_seen = True
        elif is_separator_row(cells):
            findings.append(
                f"{plan}:{line_no}  [ledger] unexpected separator row inside Scaffold Manifest data"
            )
            continue

        id_cell = cells[0] if cells else ""
        if not ID_PATTERN.fullmatch(id_cell):
            findings.append(
                f"{plan}:{line_no}  [ledger] ID cell \`{id_cell}\` must match "
                f"\`[A-Z]{{2,6}}-[0-9]{{1,4}}\` exactly"
            )
            continue
        entry_id = id_cell
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
    if explicit_empty_line is not None:
        if header_line is not None:
            findings.append(
                f"{plan}:{explicit_empty_line}  [ledger] \`{EMPTY_MANIFEST}\` cannot be "
                f"combined with a Scaffold Manifest table"
            )
        return entries, findings, True

    if header_line is None:
        findings.append(
            f"{plan}:{section_start + 1}  [ledger] Scaffold Manifest must contain the "
            f"required table or the exact line \`{EMPTY_MANIFEST}\`"
        )
        return entries, findings, False
    if not separator_seen:
        findings.append(
            f"{plan}:{header_line}  [ledger] Scaffold Manifest table is missing its separator row"
        )
    if not entries:
        findings.append(
            f"{plan}:{header_line}  [ledger] Scaffold Manifest contains no valid entries; "
            f"use the exact line \`{EMPTY_MANIFEST}\` only when no scaffold item exists"
        )
    return entries, findings, False


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
        for occurrence in MARKER_ANY.finditer(content):
            token_match = re.match(r"\\s+(\\S+)", content[occurrence.end():])
            if token_match is None:
                findings.append(
                    f"{path}:{line_no}  [ledger] marker without an ID -> "
                    f"use \`VCM:CODE <ID>\`"
                )
                continue
            marker_id = token_match.group(1)
            if not ID_PATTERN.fullmatch(marker_id):
                findings.append(
                    f"{path}:{line_no}  [ledger] marker ID \`{marker_id}\` must match "
                    f"\`[A-Z]{{2,6}}-[0-9]{{1,4}}\` exactly"
                )
                continue
            markers.setdefault(marker_id, []).append((path, line_no))
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
    entries, parse_findings, explicit_empty = parse_ledger(*section, str(plan_path))
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
    if explicit_empty:
        print("ledger explicitly empty: 0 ledger item(s), 0 marker(s)")
    else:
        print(
            f"ledger reconciliation clean: {len(ledger_ids)} ledger item(s), "
            f"{len(tree_ids)} marker(s)"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;
}
