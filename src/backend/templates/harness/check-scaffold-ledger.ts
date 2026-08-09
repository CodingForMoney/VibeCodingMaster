export function renderCheckScaffoldLedgerTool(): string {
  return `#!/usr/bin/env python3
"""Lifecycle-aware Scaffold Manifest and VCM:CODE reconciliation.

The architecture plan's Scaffold Manifest is an item ledger: one entry per implementation
item, one unique ID per entry, and exactly one \`VCM:CODE <ID>\` marker in the tree per
\`create\`/\`change\`/\`delete\` entry during scaffolding. Coder then removes successful
markers and preserves failed markers. The required \`--mode\` selects that lifecycle:

  - \`scaffold\`: require the ledger and tree markers to form an exact bijection;
  - \`completion\`: reconcile the ledger, Coder's Scaffold Completion table, and the
    final tree marker state.

The tool checks:

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
1 on findings. \`--plan <path>\` and \`--completion <path>\` override the default artifact
locations. No plan file at all means there is nothing to check (exit 0) — a docs-only or
planning-free task.
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

PLAN = ".ai/vcm/handoffs/architecture-plan.md"
COMPLETION = ".ai/vcm/handoffs/coder-completion.md"
MANIFEST_HEADING = re.compile(r"^##\\s+Scaffold Manifest\\s*$")
COMPLETION_HEADING = re.compile(r"^##\\s+Scaffold Completion\\s*$")
SECTION_HEADING = re.compile(r"^##\\s+\\S")
ID_PATTERN = re.compile(r"[A-Z]{2,6}-\\d{1,4}")
EMPTY_MANIFEST = "No scaffold items."
TABLE_SEPARATOR_CELL = re.compile(r":?-{3,}:?")
# Mandated column order: ID | action | file | symbol/site | work | freedom | proof.
# The action is read from its own cell as a whole-cell verb — never sniffed from the
# row text, so paths or prose containing action words cannot flip an item's class.
ACTIONS = frozenset({"create", "change", "delete"})
RESULTS = frozenset({"done", "failed"})
MARKER_STATES = frozenset({"removed", "present"})
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


def completion_section(completion_text: str) -> tuple[int, list[str]] | None:
    """(start line number, section lines) of the Scaffold Completion section, or None."""
    lines = completion_text.splitlines()
    start = None
    for index, line in enumerate(lines):
        if start is None:
            if COMPLETION_HEADING.match(line):
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


def parse_completion(
    section_start: int,
    section: list[str],
    completion: str,
) -> tuple[dict, list[str]]:
    """{id: {action, result, marker_state, line}} and completion-table findings."""
    entries: dict[str, dict] = {}
    findings: list[str] = []
    header_line = None
    separator_seen = False
    for offset, line in enumerate(section):
        line_no = section_start + offset + 1
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]

        if header_line is None:
            header_line = line_no
            head = [cell.lower() for cell in cells]
            if head != ["id", "action", "result", "marker state", "proof evidence"]:
                findings.append(
                    f"{completion}:{line_no}  [completion] header columns must be exactly "
                    f"\`ID | Action | Result | Marker State | Proof Evidence\`"
                )
            continue

        if not separator_seen:
            if is_separator_row(cells):
                separator_seen = True
                continue
            findings.append(
                f"{completion}:{line_no}  [completion] missing Markdown separator row after "
                f"the Scaffold Completion header"
            )
            separator_seen = True
        elif is_separator_row(cells):
            findings.append(
                f"{completion}:{line_no}  [completion] unexpected separator row inside "
                f"Scaffold Completion data"
            )
            continue

        entry_id = cells[0] if cells else ""
        if not ID_PATTERN.fullmatch(entry_id):
            findings.append(
                f"{completion}:{line_no}  [completion] ID cell \`{entry_id}\` must match "
                f"\`[A-Z]{{2,6}}-[0-9]{{1,4}}\` exactly"
            )
            continue
        if entry_id in entries:
            findings.append(
                f"{completion}:{line_no}  [completion] duplicate ID {entry_id} "
                f"(first at line {entries[entry_id]['line']})"
            )
            continue

        action = cells[1].lower() if len(cells) > 1 else ""
        result = cells[2].lower() if len(cells) > 2 else ""
        marker_state = cells[3].lower() if len(cells) > 3 else ""
        if action not in ACTIONS:
            findings.append(
                f"{completion}:{line_no}  [completion] {entry_id} action must be exactly "
                f"create/change/delete"
            )
        if result not in RESULTS:
            findings.append(
                f"{completion}:{line_no}  [completion] {entry_id} result must be exactly "
                f"done/failed"
            )
        if marker_state not in MARKER_STATES:
            findings.append(
                f"{completion}:{line_no}  [completion] {entry_id} Marker State must be "
                f"exactly removed/present"
            )
        entries[entry_id] = {
            "action": action,
            "result": result,
            "marker_state": marker_state,
            "line": line_no,
        }

    if header_line is None:
        findings.append(
            f"{completion}:{section_start + 1}  [completion] Scaffold Completion must "
            f"contain the required table"
        )
    elif not separator_seen:
        findings.append(
            f"{completion}:{header_line}  [completion] Scaffold Completion table is "
            f"missing its separator row"
        )
    if not entries:
        findings.append(
            f"{completion}:{header_line or section_start + 1}  [completion] Scaffold "
            f"Completion contains no valid entries"
        )
    return entries, findings


def completion_decision(completion_text: str) -> str | None:
    match = re.search(r"^Decision:\\s*(\\S+)\\s*$", completion_text, re.MULTILINE)
    return match.group(1) if match else None


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
        description="Lifecycle-aware Scaffold Manifest and VCM:CODE reconciliation."
    )
    parser.add_argument("--mode", required=True, choices=("scaffold", "completion"))
    parser.add_argument("--plan", default=None, help=f"plan path (default {PLAN})")
    parser.add_argument(
        "--completion",
        default=None,
        help=f"Coder completion path for completion mode (default {COMPLETION})",
    )
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

    completed = 0
    failed = 0
    if args.mode == "scaffold":
        for entry_id in sorted(ledger_ids - tree_ids):
            findings.append(
                f"{plan}:{entries[entry_id]['line']}  [ledger] {entry_id} has no marker "
                f"in the tree -> pre-place \`VCM:CODE {entry_id}\` in its declared file"
            )
    elif not explicit_empty:
        completion_path = Path(args.completion) if args.completion else root / COMPLETION
        if not completion_path.is_file():
            findings.append(
                f"{completion_path}:1  [completion] completion mode requires coder-completion.md"
            )
        else:
            completion_text = completion_path.read_text(errors="replace")
            completion = str(completion_path)
            completed_section = completion_section(completion_text)
            if completed_section is None:
                findings.append(
                    f"{completion_path}:1  [completion] no \`## Scaffold Completion\` section"
                )
                completion_entries = {}
            else:
                completion_entries, completion_findings = parse_completion(
                    *completed_section,
                    completion,
                )
                findings += completion_findings

            completion_ids = set(completion_entries)
            for entry_id in sorted(ledger_ids - completion_ids):
                findings.append(
                    f"{plan}:{entries[entry_id]['line']}  [completion] {entry_id} is missing "
                    f"from Scaffold Completion"
                )
            for entry_id in sorted(completion_ids - ledger_ids):
                findings.append(
                    f"{completion}:{completion_entries[entry_id]['line']}  [completion] "
                    f"{entry_id} has no Scaffold Manifest entry"
                )

            for entry_id in sorted(ledger_ids & completion_ids):
                ledger_entry = entries[entry_id]
                completion_entry = completion_entries[entry_id]
                result = completion_entry["result"]
                marker_state = completion_entry["marker_state"]
                marker_count = len(markers.get(entry_id, []))
                if completion_entry["action"] != ledger_entry["action"]:
                    findings.append(
                        f"{completion}:{completion_entry['line']}  [completion] {entry_id} "
                        f"action \`{completion_entry['action']}\` does not match Scaffold "
                        f"Manifest action \`{ledger_entry['action']}\`"
                    )
                if result == "done":
                    completed += 1
                    if marker_state != "removed":
                        findings.append(
                            f"{completion}:{completion_entry['line']}  [completion] {entry_id} "
                            f"done requires Marker State \`removed\`"
                        )
                    if marker_count != 0:
                        findings.append(
                            f"{completion}:{completion_entry['line']}  [completion] {entry_id} "
                            f"is done but {marker_count} marker(s) remain -> remove the completed marker"
                        )
                elif result == "failed":
                    failed += 1
                    if marker_state != "present":
                        findings.append(
                            f"{completion}:{completion_entry['line']}  [completion] {entry_id} "
                            f"failed requires Marker State \`present\`"
                        )
                    if marker_count != 1:
                        findings.append(
                            f"{completion}:{completion_entry['line']}  [completion] {entry_id} "
                            f"failed requires exactly one preserved marker; found {marker_count}"
                        )

            decision = completion_decision(completion_text)
            expected_decision = "failed" if failed else "ready_for_review"
            if decision != expected_decision:
                findings.append(
                    f"{completion_path}:1  [completion] Decision must be "
                    f"\`{expected_decision}\` for the recorded item results; found "
                    f"\`{decision or 'missing'}\`"
                )

    for finding in findings:
        sys.stderr.write(finding + "\\n")
    if findings:
        sys.stderr.write(f"ledger reconciliation failed with {len(findings)} finding(s)\\n")
        return 1
    if explicit_empty:
        print("ledger explicitly empty: 0 ledger item(s), 0 marker(s)")
    elif args.mode == "completion":
        print(
            f"ledger completion clean: {len(ledger_ids)} ledger item(s), "
            f"{completed} done, {failed} failed, {len(tree_ids)} marker(s) remain"
        )
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
