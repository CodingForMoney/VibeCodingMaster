import { NODE_TOOL_ARGUMENT_PARSER, renderNodeToolHeader } from "./node-tool-runtime.js";

export function renderCheckScaffoldLedgerTool(): string {
  return String.raw`${renderNodeToolHeader("Lifecycle-aware Scaffold Manifest and VCM:CODE reconciliation.")}${NODE_TOOL_ARGUMENT_PARSER}
// Lifecycle-aware Scaffold Manifest and VCM:CODE reconciliation.
//
// The architecture plan's Scaffold Manifest is an item ledger: one entry per implementation
// item, one unique ID per entry, and exactly one "VCM:CODE <ID>" marker in the tree per
// create/change/delete entry during scaffolding. Coder then removes successful
// markers and preserves failed markers. The required --mode selects that lifecycle:
//
//   - scaffold: require the ledger and tree markers to form an exact bijection;
//   - completion: reconcile the ledger, Coder's Scaffold Completion table, and the
//     final tree marker state.
//
// The tool checks:
//
//   1. the ledger header follows the mandated column order (ID | Action | File | ...),
//      every data-row ID matches the documented grammar as a complete cell and is unique,
//      classified by its whole-cell action column
//      (create/change/delete), and bound to a declared file path in the file column;
//   2. the ledger ID set equals the tree marker ID set, each ID exactly once on each side;
//   3. every marker sits in its entry's declared file;
//   4. the manifest contains no open-ended coverage language ("as work proceeds",
//      "replicate", "etc.", "and others").
//
// Markers are scanned in git-tracked source files only (.md files and .ai/ are excluded:
// prose may quote markers legitimately). Pure read; findings go to stderr; exit 0 clean,
// 1 on findings. --plan <path> and --completion <path> override the default artifact
// locations. No plan file at all means there is nothing to check (exit 0) - a docs-only or
// planning-free task.

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const B = "\x60";
const PLAN = ".ai/vcm/handoffs/architecture-plan.md";
const COMPLETION = ".ai/vcm/handoffs/coder-completion.md";
const MANIFEST_HEADING = /^##\s+Scaffold Manifest\s*$/;
const COMPLETION_HEADING = /^##\s+Scaffold Completion\s*$/;
const SECTION_HEADING = /^##\s+\S/;
const ID_PATTERN = /^[A-Z]{2,6}-\d{1,4}$/;
const EMPTY_MANIFEST = "No scaffold items.";
const TABLE_SEPARATOR_CELL = /^:?-{3,}:?$/;
// Mandated column order: ID | action | file | symbol/site | work | freedom | proof.
// The action is read from its own cell as a whole-cell verb - never sniffed from the
// row text, so paths or prose containing action words cannot flip an item's class.
const ACTIONS = new Set(["create", "change", "delete"]);
const RESULTS = new Set(["done", "failed"]);
const MARKER_STATES = new Set(["removed", "present"]);
const PATH_TOKEN = /\x60([^\x60\s]+\/[^\x60\s]+|[^\x60\s]+\.[A-Za-z0-9]{1,8})\x60/;
const MARKER_ANY = /VCM:CODE(?![A-Za-z0-9_])/g;
const FORBIDDEN = [
  [/as work proceeds/i, "as work proceeds"],
  [/\breplicate\b/i, "\\breplicate\\b"],
  [/\betc\./i, "\\betc\\."],
  [/\band others\b/i, "\\band others\\b"]
];
const ID_GRAMMAR = B + "[A-Z]{2,6}-[0-9]{1,4}" + B;

function splitLines(text) {
  return text.split(/\r\n|\n|\r/).filter((line, index, all) => index < all.length - 1 || line !== "");
}

function section(text, heading) {
  const lines = splitLines(text);
  let start = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (start === null) {
      if (heading.test(lines[index])) {
        start = index + 1;
      }
    } else if (SECTION_HEADING.test(lines[index])) {
      return { start, lines: lines.slice(start, index) };
    }
  }
  return start === null ? null : { start, lines: lines.slice(start) };
}

function tableCells(stripped) {
  return stripped.replace(/^\|+|\|+$/g, "").split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL.test(cell.replaceAll(" ", "")));
}

function parseLedger(sectionStart, lines, plan) {
  const entries = new Map();
  const findings = [];
  let headerLine = null;
  let separatorSeen = false;
  let explicitEmptyLine = null;
  lines.forEach((line, offset) => {
    const lineNo = sectionStart + offset + 1;
    const stripped = line.trim();
    if (stripped === EMPTY_MANIFEST) {
      if (explicitEmptyLine !== null) {
        findings.push(plan + ":" + lineNo + "  [ledger] duplicate " + B + EMPTY_MANIFEST + B + " declaration "
          + "(first at line " + explicitEmptyLine + ")");
      } else {
        explicitEmptyLine = lineNo;
      }
      return;
    }
    if (!stripped.startsWith("|")) {
      return;
    }
    const cells = tableCells(stripped);

    if (headerLine === null) {
      headerLine = lineNo;
      const head = cells.slice(0, 3).map((cell) => cell.toLowerCase());
      if (head.join("|") !== "id|action|file" || head.length !== 3) {
        findings.push(plan + ":" + lineNo + "  [ledger] header columns must begin exactly "
          + B + "ID | Action | File | ..." + B + " -> fix the ledger column order");
      }
      return;
    }

    if (!separatorSeen) {
      if (isSeparatorRow(cells)) {
        separatorSeen = true;
        return;
      }
      findings.push(plan + ":" + lineNo + "  [ledger] missing Markdown separator row after "
        + "the Scaffold Manifest header");
      separatorSeen = true;
    } else if (isSeparatorRow(cells)) {
      findings.push(plan + ":" + lineNo + "  [ledger] unexpected separator row inside Scaffold Manifest data");
      return;
    }

    const idCell = cells.length > 0 ? cells[0] : "";
    if (!ID_PATTERN.test(idCell)) {
      findings.push(plan + ":" + lineNo + "  [ledger] ID cell " + B + idCell + B + " must match " + ID_GRAMMAR + " exactly");
      return;
    }
    if (entries.has(idCell)) {
      findings.push(plan + ":" + lineNo + "  [ledger] duplicate ledger ID " + idCell + " "
        + "(first at line " + entries.get(idCell).line + ") -> one entry per item");
      return;
    }
    const actionCell = cells.length > 1 ? cells[1].toLowerCase() : "";
    const action = ACTIONS.has(actionCell) ? actionCell : null;
    let declared = null;
    if (cells.length > 2) {
      const pathMatch = PATH_TOKEN.exec(cells[2]);
      declared = pathMatch ? pathMatch[1] : null;
    }
    if (action === null) {
      findings.push(plan + ":" + lineNo + "  [ledger] " + idCell + " action column is not exactly "
        + "one of create/change/delete -> classify the item in column 2");
    }
    if (declared === null) {
      findings.push(plan + ":" + lineNo + "  [ledger] " + idCell + " has no declared file path in "
        + "column 3 -> bind the item to its exact file");
    }
    entries.set(idCell, { path: declared, action, line: lineNo });
  });
  if (explicitEmptyLine !== null) {
    if (headerLine !== null) {
      findings.push(plan + ":" + explicitEmptyLine + "  [ledger] " + B + EMPTY_MANIFEST + B + " cannot be "
        + "combined with a Scaffold Manifest table");
    }
    return { entries, findings, explicitEmpty: true };
  }
  if (headerLine === null) {
    findings.push(plan + ":" + (sectionStart + 1) + "  [ledger] Scaffold Manifest must contain the "
      + "required table or the exact line " + B + EMPTY_MANIFEST + B);
    return { entries, findings, explicitEmpty: false };
  }
  if (!separatorSeen) {
    findings.push(plan + ":" + headerLine + "  [ledger] Scaffold Manifest table is missing its separator row");
  }
  if (entries.size === 0) {
    findings.push(plan + ":" + headerLine + "  [ledger] Scaffold Manifest contains no valid entries; "
      + "use the exact line " + B + EMPTY_MANIFEST + B + " only when no scaffold item exists");
  }
  return { entries, findings, explicitEmpty: false };
}

function parseCompletion(sectionStart, lines, completion) {
  const entries = new Map();
  const findings = [];
  let headerLine = null;
  let separatorSeen = false;
  lines.forEach((line, offset) => {
    const lineNo = sectionStart + offset + 1;
    const stripped = line.trim();
    if (!stripped.startsWith("|")) {
      return;
    }
    const cells = tableCells(stripped);

    if (headerLine === null) {
      headerLine = lineNo;
      if (cells.map((cell) => cell.toLowerCase()).join("|") !== "id|action|result|marker state|proof evidence") {
        findings.push(completion + ":" + lineNo + "  [completion] header columns must be exactly "
          + B + "ID | Action | Result | Marker State | Proof Evidence" + B);
      }
      return;
    }

    if (!separatorSeen) {
      if (isSeparatorRow(cells)) {
        separatorSeen = true;
        return;
      }
      findings.push(completion + ":" + lineNo + "  [completion] missing Markdown separator row after "
        + "the Scaffold Completion header");
      separatorSeen = true;
    } else if (isSeparatorRow(cells)) {
      findings.push(completion + ":" + lineNo + "  [completion] unexpected separator row inside "
        + "Scaffold Completion data");
      return;
    }

    const entryId = cells.length > 0 ? cells[0] : "";
    if (!ID_PATTERN.test(entryId)) {
      findings.push(completion + ":" + lineNo + "  [completion] ID cell " + B + entryId + B + " must match " + ID_GRAMMAR + " exactly");
      return;
    }
    if (entries.has(entryId)) {
      findings.push(completion + ":" + lineNo + "  [completion] duplicate ID " + entryId + " "
        + "(first at line " + entries.get(entryId).line + ")");
      return;
    }

    const action = cells.length > 1 ? cells[1].toLowerCase() : "";
    const result = cells.length > 2 ? cells[2].toLowerCase() : "";
    const markerState = cells.length > 3 ? cells[3].toLowerCase() : "";
    if (!ACTIONS.has(action)) {
      findings.push(completion + ":" + lineNo + "  [completion] " + entryId + " action must be exactly create/change/delete");
    }
    if (!RESULTS.has(result)) {
      findings.push(completion + ":" + lineNo + "  [completion] " + entryId + " result must be exactly done/failed");
    }
    if (!MARKER_STATES.has(markerState)) {
      findings.push(completion + ":" + lineNo + "  [completion] " + entryId + " Marker State must be exactly removed/present");
    }
    entries.set(entryId, { action, result, markerState, line: lineNo });
  });

  if (headerLine === null) {
    findings.push(completion + ":" + (sectionStart + 1) + "  [completion] Scaffold Completion must "
      + "contain the required table");
  } else if (!separatorSeen) {
    findings.push(completion + ":" + headerLine + "  [completion] Scaffold Completion table is "
      + "missing its separator row");
  }
  if (entries.size === 0) {
    findings.push(completion + ":" + (headerLine || sectionStart + 1) + "  [completion] Scaffold "
      + "Completion contains no valid entries");
  }
  return { entries, findings };
}

function completionDecision(text) {
  const match = /^Decision:\s*(\S+)\s*$/m.exec(text);
  return match ? match[1] : null;
}

function forbiddenLanguage(sectionStart, lines, plan) {
  const findings = [];
  lines.forEach((line, offset) => {
    for (const [pattern, source] of FORBIDDEN) {
      if (pattern.test(line)) {
        findings.push(plan + ":" + (sectionStart + offset + 1) + "  [ledger] open-ended coverage "
          + "language (" + source + ") -> enumerate every item explicitly");
      }
    }
  });
  return findings;
}

function treeMarkers(root) {
  const result = childProcess.spawnSync("git", ["grep", "-In", "VCM:CODE", "--", ".", ":!*.md", ":!.ai"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  const markers = new Map();
  const findings = [];
  for (const raw of splitLines(result.stdout || "")) {
    const first = raw.indexOf(":");
    const second = first >= 0 ? raw.indexOf(":", first + 1) : -1;
    if (first < 0 || second < 0) {
      continue;
    }
    const file = raw.slice(0, first);
    const lineNo = Number.parseInt(raw.slice(first + 1, second), 10);
    const content = raw.slice(second + 1);
    for (const occurrence of content.matchAll(MARKER_ANY)) {
      const tokenMatch = /^\s+(\S+)/.exec(content.slice(occurrence.index + occurrence[0].length));
      if (tokenMatch === null) {
        findings.push(file + ":" + lineNo + "  [ledger] marker without an ID -> use " + B + "VCM:CODE <ID>" + B);
        continue;
      }
      const markerId = tokenMatch[1];
      if (!ID_PATTERN.test(markerId)) {
        findings.push(file + ":" + lineNo + "  [ledger] marker ID " + B + markerId + B + " must match " + ID_GRAMMAR + " exactly");
        continue;
      }
      if (!markers.has(markerId)) {
        markers.set(markerId, []);
      }
      markers.get(markerId).push([file, lineNo]);
    }
  }
  return { markers, findings };
}

function sortedIds(ids) {
  return [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

// Mirrors str(pathlib.Path(value)): drops "." segments and repeated slashes.
function displayPath(value) {
  const absolute = value.startsWith("/");
  const parts = value.split("/").filter((part) => part !== "" && part !== ".");
  return (absolute ? "/" : "") + parts.join("/") || ".";
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function main() {
  const args = parseToolArguments(process.argv.slice(2), {
    description: "Lifecycle-aware Scaffold Manifest and VCM:CODE reconciliation.",
    options: {
      "--mode": { dest: "mode", required: true, choices: ["scaffold", "completion"] },
      "--plan": { dest: "plan" },
      "--completion": { dest: "completion" }
    }
  });

  const root = path.resolve(path.dirname(fs.realpathSync(__filename)), "..", "..");
  const planPath = args.plan ? displayPath(args.plan) : path.join(root, PLAN);
  const plan = planPath;
  if (!isFile(planPath)) {
    process.stdout.write("no architecture plan at " + planPath + "; nothing to check\n");
    return 0;
  }

  let findings = [];
  const manifest = section(fs.readFileSync(planPath, "utf8"), MANIFEST_HEADING);
  if (manifest === null) {
    process.stderr.write(planPath + ":1  [ledger] no " + B + "## Scaffold Manifest" + B + " section\n");
    return 1;
  }
  const ledger = parseLedger(manifest.start, manifest.lines, plan);
  const entries = ledger.entries;
  findings = findings.concat(ledger.findings, forbiddenLanguage(manifest.start, manifest.lines, plan));

  const tree = treeMarkers(root);
  const markers = tree.markers;
  findings = findings.concat(tree.findings);

  for (const entryId of sortedIds(markers.keys())) {
    const sites = markers.get(entryId);
    if (sites.length > 1) {
      const where = sites.map(([file, lineNo]) => file + ":" + lineNo).join(", ");
      findings.push("[ledger] " + entryId + " has " + sites.length + " markers (" + where + ") -> exactly one per item");
    }
  }

  const ledgerIds = new Set(entries.keys());
  const treeIds = new Set(markers.keys());
  for (const entryId of sortedIds([...treeIds].filter((id) => !ledgerIds.has(id)))) {
    const [file, lineNo] = markers.get(entryId)[0];
    findings.push(file + ":" + lineNo + "  [ledger] marker " + entryId + " has no ledger entry "
      + "-> every item must be manifested");
  }
  for (const entryId of sortedIds([...ledgerIds].filter((id) => treeIds.has(id)))) {
    const declared = entries.get(entryId).path;
    if (declared) {
      for (const [file, lineNo] of markers.get(entryId)) {
        if (!(file === declared || file.endsWith("/" + declared) || declared.endsWith("/" + file))) {
          findings.push(file + ":" + lineNo + "  [ledger] marker " + entryId + " is outside its "
            + "declared file " + B + declared + B);
        }
      }
    }
  }

  let completed = 0;
  let failed = 0;
  if (args.mode === "scaffold") {
    for (const entryId of sortedIds([...ledgerIds].filter((id) => !treeIds.has(id)))) {
      findings.push(plan + ":" + entries.get(entryId).line + "  [ledger] " + entryId + " has no marker "
        + "in the tree -> pre-place " + B + "VCM:CODE " + entryId + B + " in its declared file");
    }
  } else if (!ledger.explicitEmpty) {
    const completionPath = args.completion ? displayPath(args.completion) : path.join(root, COMPLETION);
    if (!isFile(completionPath)) {
      findings.push(completionPath + ":1  [completion] completion mode requires coder-completion.md");
    } else {
      const completionText = fs.readFileSync(completionPath, "utf8");
      const completion = completionPath;
      const completedSection = section(completionText, COMPLETION_HEADING);
      let completionEntries = new Map();
      if (completedSection === null) {
        findings.push(completionPath + ":1  [completion] no " + B + "## Scaffold Completion" + B + " section");
      } else {
        const parsed = parseCompletion(completedSection.start, completedSection.lines, completion);
        completionEntries = parsed.entries;
        findings = findings.concat(parsed.findings);
      }

      const completionIds = new Set(completionEntries.keys());
      for (const entryId of sortedIds([...ledgerIds].filter((id) => !completionIds.has(id)))) {
        findings.push(plan + ":" + entries.get(entryId).line + "  [completion] " + entryId + " is missing "
          + "from Scaffold Completion");
      }
      for (const entryId of sortedIds([...completionIds].filter((id) => !ledgerIds.has(id)))) {
        findings.push(completion + ":" + completionEntries.get(entryId).line + "  [completion] "
          + entryId + " has no Scaffold Manifest entry");
      }

      for (const entryId of sortedIds([...ledgerIds].filter((id) => completionIds.has(id)))) {
        const ledgerEntry = entries.get(entryId);
        const completionEntry = completionEntries.get(entryId);
        const markerCount = (markers.get(entryId) || []).length;
        const where = completion + ":" + completionEntry.line + "  [completion] " + entryId;
        if (completionEntry.action !== ledgerEntry.action) {
          findings.push(where + " action " + B + completionEntry.action + B + " does not match Scaffold "
            + "Manifest action " + B + (ledgerEntry.action === null ? "None" : ledgerEntry.action) + B);
        }
        if (completionEntry.result === "done") {
          completed += 1;
          if (completionEntry.markerState !== "removed") {
            findings.push(where + " done requires Marker State " + B + "removed" + B);
          }
          if (markerCount !== 0) {
            findings.push(where + " is done but " + markerCount + " marker(s) remain -> remove the completed marker");
          }
        } else if (completionEntry.result === "failed") {
          failed += 1;
          if (completionEntry.markerState !== "present") {
            findings.push(where + " failed requires Marker State " + B + "present" + B);
          }
          if (markerCount !== 1) {
            findings.push(where + " failed requires exactly one preserved marker; found " + markerCount);
          }
        }
      }

      const decision = completionDecision(completionText);
      const expectedDecision = failed ? "failed" : "ready_for_review";
      if (decision !== expectedDecision) {
        findings.push(completionPath + ":1  [completion] Decision must be "
          + B + expectedDecision + B + " for the recorded item results; found "
          + B + (decision || "missing") + B);
      }
    }
  }

  for (const item of findings) {
    process.stderr.write(item + "\n");
  }
  if (findings.length > 0) {
    process.stderr.write("ledger reconciliation failed with " + findings.length + " finding(s)\n");
    return 1;
  }
  if (ledger.explicitEmpty) {
    process.stdout.write("ledger explicitly empty: 0 ledger item(s), 0 marker(s)\n");
  } else if (args.mode === "completion") {
    process.stdout.write("ledger completion clean: " + ledgerIds.size + " ledger item(s), "
      + completed + " done, " + failed + " failed, " + treeIds.size + " marker(s) remain\n");
  } else {
    process.stdout.write("ledger reconciliation clean: " + ledgerIds.size + " ledger item(s), "
      + treeIds.size + " marker(s)\n");
  }
  return 0;
}

process.exitCode = main();
`;
}
