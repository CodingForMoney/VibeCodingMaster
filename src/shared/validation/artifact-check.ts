import type { ArtifactCheckResult, ArtifactKind } from "../types/artifact.js";
import {
  ARCHITECT_DEBUG_DISPOSITIONS,
  ARCHITECT_DEBUG_STATUSES,
  ARCHITECTURE_BRIEF_STATUSES,
  ARCHITECTURE_DIAGNOSIS_DISPOSITIONS,
  ARCHITECTURE_EVIDENCE_STATUSES,
  ARCHITECTURE_PLAN_RESULTS,
  CODER_COMPLETION_DECISIONS,
  DOCS_REPORT_DECISIONS,
  DOCS_UPDATE_COMMIT_PATTERN,
  DOCS_UPDATE_COMMIT_RULE,
  DOCS_SYNC_CORRECTION_OWNERS,
  FINAL_ACCEPTANCE_DECISIONS,
  L3_ACTIONS,
  L3_REQUIRED_VALUES,
  PLANNING_PROGRESS_STATUSES,
  STRICT_NONE_VALUE,
  TEST_INFRASTRUCTURE_STATUSES,
  TEST_RESULTS
} from "./artifact-contract.js";
import { getArtifactDefinition } from "./artifact-registry.js";

const PLACEHOLDER_PATTERN = /(^|\n)\s*(TBD|Not run yet\.?|status:\s*draft)\s*(\n|$)/i;

export interface ArtifactCheckOptions {
  mode?: "draft" | "final";
}

export function checkMarkdownArtifact(
  kind: ArtifactKind,
  artifactPath: string,
  content: string | null,
  options: ArtifactCheckOptions = {}
): ArtifactCheckResult {
  const requiredHeadings = getArtifactDefinition(kind).requiredHeadings;
  if (content === null) {
    return {
      kind,
      path: artifactPath,
      exists: false,
      isEmpty: true,
      hasPlaceholder: false,
      missingHeadings: [...requiredHeadings],
      invalidFields: [],
      status: "missing"
    };
  }

  const trimmed = content.trim();
  if (!trimmed) {
    return {
      kind,
      path: artifactPath,
      exists: true,
      isEmpty: true,
      hasPlaceholder: false,
      missingHeadings: [...requiredHeadings],
      invalidFields: [],
      status: "empty"
    };
  }

  const headingErrors = validateHeadingContract(trimmed, requiredHeadings);
  const missingHeadings = headingErrors.missing;
  const hasPlaceholder = options.mode === "draft" ? false : PLACEHOLDER_PATTERN.test(trimmed);
  const invalidFields = [
    ...headingErrors.invalid,
    ...validateArtifactFields(kind, trimmed, options.mode ?? "final")
  ];
  const isWorkInProgress = kind === "test-report"
    && /^\s*Test Result\s*:\s*incomplete\s*$/im.test(trimmed);

  return {
    kind,
    path: artifactPath,
    exists: true,
    isEmpty: false,
    hasPlaceholder,
    missingHeadings,
    invalidFields,
    status: missingHeadings.length === 0
      && !hasPlaceholder
      && invalidFields.length === 0
      && !isWorkInProgress
      ? "ok"
      : "incomplete"
  };
}

function validateArtifactFields(
  kind: ArtifactKind,
  content: string,
  mode: "draft" | "final"
): string[] {
  if (kind === "architecture-plan") {
    const result = readInlineField(content, "Planning Result");
    return isAllowedValue(result, ARCHITECTURE_PLAN_RESULTS)
      && (mode === "draft" || result === ARCHITECTURE_PLAN_RESULTS[0])
      ? []
      : [renderExactFieldError(
          "Planning Result",
          mode === "draft" ? ARCHITECTURE_PLAN_RESULTS : [ARCHITECTURE_PLAN_RESULTS[0]],
          result
        )];
  }

  if (kind === "architecture-brief") {
    const status = readInlineField(content, "Architecture Brief Status");
    const invalidFields = isAllowedValue(status, ARCHITECTURE_BRIEF_STATUSES)
      ? []
      : [renderExactFieldError("Architecture Brief Status", ARCHITECTURE_BRIEF_STATUSES, status)];
    if (mode === "final" && status !== "confirmed") {
      invalidFields.push(renderExactFieldError("Architecture Brief Status", ["confirmed"], status));
    }
    if (status === "confirmed") {
      const unresolved = readArtifactSectionContent(content, "Unresolved User Decisions");
      if (!isExactNone(unresolved)) {
        invalidFields.push(renderExactSectionError(
          "Unresolved User Decisions",
          STRICT_NONE_VALUE,
          unresolved,
          "when Architecture Brief Status is confirmed"
        ));
      }
    }
    return invalidFields;
  }

  if (kind === "architecture-evidence") {
    return validateLifecycleField(
      content,
      "Architecture Evidence Status",
      ARCHITECTURE_EVIDENCE_STATUSES,
      "complete",
      mode
    );
  }

  if (kind === "planning-progress") {
    return validateLifecycleField(
      content,
      "Planning Progress Status",
      PLANNING_PROGRESS_STATUSES,
      "complete",
      mode
    );
  }

  if (kind === "coder-completion") {
    const decision = readInlineField(content, "Decision");
    if (!isAllowedValue(decision, CODER_COMPLETION_DECISIONS)) {
      return [renderExactFieldError("Decision", CODER_COMPLETION_DECISIONS, decision)];
    }
    if (mode === "final" && decision === "incomplete") {
      return [renderExactFieldError(
        "Decision",
        ["ready_for_review", "failed"],
        decision
      )];
    }
    return [];
  }

  if (kind === "architect-debug") {
    const invalidFields = validateLifecycleField(
      content,
      "Status",
      ARCHITECT_DEBUG_STATUSES,
      "completed",
      mode
    );
    if (mode === "final") {
      const disposition = readArtifactSectionContent(content, "Final Disposition")?.trim().toLowerCase();
      if (!isAllowedValue(disposition, ARCHITECT_DEBUG_DISPOSITIONS)) {
        invalidFields.push(renderExactSectionError(
          "Final Disposition",
          ARCHITECT_DEBUG_DISPOSITIONS.join("|"),
          disposition
        ));
      }
    }
    return invalidFields;
  }

  if (kind === "architecture-diagnosis") {
    const disposition = readArtifactSectionContent(content, "Final Disposition")?.trim().toLowerCase();
    return isAllowedValue(disposition, ARCHITECTURE_DIAGNOSIS_DISPOSITIONS)
      ? []
      : [renderExactSectionError(
          "Final Disposition",
          ARCHITECTURE_DIAGNOSIS_DISPOSITIONS.join("|"),
          disposition
        )];
  }

  if (kind === "test-report") {
    const result = readInlineField(content, "Test Result");
    const invalidFields = isAllowedValue(result, TEST_RESULTS)
      ? []
      : [renderExactFieldError("Test Result", TEST_RESULTS, result)];
    const infrastructureStatus = readInlineField(
      readArtifactSectionContent(content, "Test Infrastructure") ?? "",
      "Status"
    );
    if (!isAllowedValue(infrastructureStatus, TEST_INFRASTRUCTURE_STATUSES)) {
      invalidFields.push(renderExactFieldError(
        "Test Infrastructure Status",
        TEST_INFRASTRUCTURE_STATUSES,
        infrastructureStatus
      ));
    }
    const infrastructureFiles = readArtifactSectionContent(content, "Affected Files");
    const infrastructureBoundary = readArtifactSectionContent(content, "Boundary Evidence");
    const infrastructureSweep = readArtifactSectionContent(content, "Defect-Class Sweep");
    const infrastructureCommit = readArtifactSectionContent(content, "Repair Commit");
    if (infrastructureStatus === "none") {
      for (const [heading, value] of [
        ["Affected Files", infrastructureFiles],
        ["Boundary Evidence", infrastructureBoundary],
        ["Defect-Class Sweep", infrastructureSweep],
        ["Repair Commit", infrastructureCommit]
      ] as const) {
        if (!isExactNone(value)) {
          invalidFields.push(renderExactSectionError(
            heading,
            STRICT_NONE_VALUE,
            value,
            "when Test Infrastructure Status is none"
          ));
        }
      }
    }
    if (infrastructureStatus === "repair-required" || infrastructureStatus === "production-change-required") {
      for (const [heading, value] of [
        ["Affected Files", infrastructureFiles],
        ["Boundary Evidence", infrastructureBoundary],
        ["Defect-Class Sweep", infrastructureSweep]
      ] as const) {
        if (!hasSubstantiveSectionValue(value)) {
          invalidFields.push(`${heading} is required when Test Infrastructure Status is ${infrastructureStatus}.`);
        }
      }
      if (!isExactNone(infrastructureCommit)) {
        invalidFields.push(renderExactSectionError(
          "Repair Commit",
          STRICT_NONE_VALUE,
          infrastructureCommit,
          `when Test Infrastructure Status is ${infrastructureStatus}`
        ));
      }
      if (result !== "fail") {
        invalidFields.push(
          `Test Result must be fail when Test Infrastructure Status is ${infrastructureStatus}.`
        );
      }
    }
    if (infrastructureStatus === "repaired") {
      for (const [heading, value] of [
        ["Affected Files", infrastructureFiles],
        ["Boundary Evidence", infrastructureBoundary],
        ["Defect-Class Sweep", infrastructureSweep],
        ["Repair Commit", infrastructureCommit]
      ] as const) {
        if (!hasSubstantiveSectionValue(value)) {
          invalidFields.push(`${heading} is required when Test Infrastructure Status is repaired.`);
        }
      }
    }
    const l3Required = readInlineField(content, "L3 Required");
    if (!isAllowedValue(l3Required, L3_REQUIRED_VALUES)) {
      invalidFields.push(renderExactFieldError("L3 Required", L3_REQUIRED_VALUES, l3Required));
    }
    const l3TriggerAssessment = readArtifactSectionContent(content, "Trigger Assessment");
    const l3AffectedFlows = readArtifactSectionContent(content, "Affected End-To-End Flows");
    const l3Commands = readArtifactSectionContent(content, "L3 Commands And Evidence");
    const l3NotRequiredEvidence = readArtifactSectionContent(content, "Not-Required Evidence");
    if (l3Required === "yes") {
      if (!hasSubstantiveSectionValue(l3TriggerAssessment)) {
        invalidFields.push("Trigger Assessment is required when L3 Required is yes.");
      }
      if (!hasCompleteL3FlowMapping(l3AffectedFlows)) {
        invalidFields.push("Affected End-To-End Flows are required when L3 Required is yes.");
      }
      if (!hasSubstantiveSectionValue(l3Commands)) {
        invalidFields.push("L3 Commands And Evidence are required when L3 Required is yes.");
      }
    }
    if (l3Required === "no" && !hasSubstantiveSectionValue(l3NotRequiredEvidence)) {
      invalidFields.push("Not-Required Evidence is required when L3 Required is no.");
    }
    const coverageGaps = readArtifactSectionContent(content, "Coverage Gaps");
    const blockingIssues = readArtifactSectionContent(content, "Blocking Validation Issues");
    const userApproval = readArtifactSectionContent(content, "User Approval Evidence");
    const failedExpectations = readArtifactSectionContent(content, "Failed Expectations");
    const completedValidation = readArtifactSectionContent(content, "Completed Validation");
    const remainingValidation = readArtifactSectionContent(content, "Remaining Validation");
    const hasCoverageGaps = hasSubstantiveSectionValue(coverageGaps);
    const hasBlockingIssues = hasSubstantiveSectionValue(blockingIssues);
    const hasUserApproval = hasSubstantiveSectionValue(userApproval);
    const hasFailedExpectations = hasSubstantiveSectionValue(failedExpectations);

    if (result === "pass") {
      if (!isExactNone(coverageGaps)) {
        invalidFields.push(renderExactSectionError(
          "Coverage Gaps",
          STRICT_NONE_VALUE,
          coverageGaps,
          "when Test Result is pass"
        ));
      }
      if (!isExactNone(blockingIssues)) {
        invalidFields.push(renderExactSectionError(
          "Blocking Validation Issues",
          STRICT_NONE_VALUE,
          blockingIssues,
          "when Test Result is pass"
        ));
      }
      if (!isExactNone(userApproval)) {
        invalidFields.push(renderExactSectionError(
          "User Approval Evidence",
          STRICT_NONE_VALUE,
          userApproval,
          "when Test Result is pass"
        ));
      }
      if (!isExactNone(failedExpectations)) {
        invalidFields.push(renderExactSectionError(
          "Failed Expectations",
          STRICT_NONE_VALUE,
          failedExpectations,
          "when Test Result is pass"
        ));
      }
      if (!isExactNone(remainingValidation)) {
        invalidFields.push(renderExactSectionError(
          "Remaining Validation",
          STRICT_NONE_VALUE,
          remainingValidation,
          "when Test Result is pass"
        ));
      }
    }
    if (result === "incomplete") {
      if (mode === "final") {
        invalidFields.push("Test Result must be pass or fail for final submission.");
      }
      if (!hasSubstantiveSectionValue(completedValidation)) {
        invalidFields.push("Completed Validation must record progress when Test Result is incomplete.");
      }
      if (!hasSubstantiveSectionValue(remainingValidation)) {
        invalidFields.push("Remaining Validation must list continuation work when Test Result is incomplete.");
      }
      if (!isExactNone(coverageGaps)) {
        invalidFields.push(renderExactSectionError(
          "Coverage Gaps",
          STRICT_NONE_VALUE,
          coverageGaps,
          "when Test Result is incomplete"
        ));
      }
      if (!isExactNone(blockingIssues)) {
        invalidFields.push(renderExactSectionError(
          "Blocking Validation Issues",
          STRICT_NONE_VALUE,
          blockingIssues,
          "when Test Result is incomplete"
        ));
      }
      if (!isExactNone(userApproval)) {
        invalidFields.push(renderExactSectionError(
          "User Approval Evidence",
          STRICT_NONE_VALUE,
          userApproval,
          "when Test Result is incomplete"
        ));
      }
      if (!isExactNone(failedExpectations)) {
        invalidFields.push(renderExactSectionError(
          "Failed Expectations",
          STRICT_NONE_VALUE,
          failedExpectations,
          "when Test Result is incomplete"
        ));
      }
    }
    if (result === "fail" && !hasBlockingIssues) {
      invalidFields.push("Blocking Validation Issues must contain concrete evidence when Test Result is fail.");
    }
    if (hasCoverageGaps) {
      if (result !== "fail") {
        invalidFields.push("Test Result must be fail when Coverage Gaps are recorded.");
      }
      if (!hasUserApproval) {
        invalidFields.push("User Approval Evidence is required when Coverage Gaps are recorded.");
      }
    } else if (hasUserApproval) {
      invalidFields.push(renderExactSectionError(
        "User Approval Evidence",
        STRICT_NONE_VALUE,
        userApproval,
        "when no Coverage Gaps are recorded"
      ));
    }
    return invalidFields;
  }

  if (kind === "docs-update-report") {
    const invalidFields = validateDecision(content, DOCS_REPORT_DECISIONS);
    const decision = readArtifactSectionContent(content, "Decision")?.trim().toLowerCase();
    const commit = readArtifactSectionContent(content, "Commit");
    if (mode === "final" && decision === "synced" && !DOCS_UPDATE_COMMIT_PATTERN.test(commit ?? "")) {
      invalidFields.push(`${DOCS_UPDATE_COMMIT_RULE} Received Commit: ${JSON.stringify(commit ?? "")}.`);
    }
    return invalidFields;
  }

  if (kind === "docs-sync-report") {
    const invalidFields = validateDecision(content, DOCS_REPORT_DECISIONS);
    const decision = readArtifactSectionContent(content, "Decision")?.trim().toLowerCase();
    const owner = readArtifactSectionContent(content, "Correction Owner")?.trim().toLowerCase();
    const evidence = readArtifactSectionContent(content, "Correction Evidence");
    if (!isAllowedValue(owner, DOCS_SYNC_CORRECTION_OWNERS)) {
      invalidFields.push(renderExactSectionError(
        "Correction Owner",
        DOCS_SYNC_CORRECTION_OWNERS.join("|"),
        owner
      ));
    }
    if (decision === "synced" || decision === "unchanged") {
      if (owner !== "none") {
        invalidFields.push(renderExactSectionError(
          "Correction Owner",
          "none",
          owner,
          `when Decision is ${decision}`
        ));
      }
      if (!isExactNone(evidence)) {
        invalidFields.push(renderExactSectionError(
          "Correction Evidence",
          STRICT_NONE_VALUE,
          evidence,
          `when Decision is ${decision}`
        ));
      }
    }
    if (decision === "blocked") {
      if (!owner || owner === "none") {
        invalidFields.push("Correction Owner must be architect, coder, or tester when Decision is blocked.");
      }
      if (!hasSubstantiveSectionValue(evidence)) {
        invalidFields.push("Correction Evidence must identify the unresolved documentation correction when Decision is blocked.");
      }
    }
    return invalidFields;
  }

  if (kind === "final-acceptance") {
    return validateDecision(content, FINAL_ACCEPTANCE_DECISIONS);
  }

  return [];
}

function validateLifecycleField(
  content: string,
  field: string,
  allowed: readonly string[],
  finalValue: string | undefined,
  mode: "draft" | "final"
): string[] {
  const value = readInlineField(content, field);
  if (!isAllowedValue(value, allowed)) {
    return [renderExactFieldError(field, allowed, value)];
  }
  if (mode === "final" && finalValue && value !== finalValue) {
    return [renderExactFieldError(field, [finalValue], value)];
  }
  return [];
}

function validateHeadingContract(
  content: string,
  required: readonly string[]
): { missing: string[]; invalid: string[] } {
  const headings = readMarkdownHeadings(content);
  const missing = required.filter((heading) => !headings.some((candidate) => candidate.text === heading));
  const invalid: string[] = [];
  for (const heading of required) {
    const matches = headings.filter((candidate) => candidate.text === heading);
    if (matches.length > 1) {
      invalid.push(`Heading ${heading} must appear exactly once; found ${matches.length}.`);
    }
  }
  let previousIndex = -1;
  for (const heading of required) {
    const index = headings.findIndex((candidate) => candidate.text === heading);
    if (index < 0) {
      continue;
    }
    if (index < previousIndex) {
      invalid.push(`Heading ${heading} is out of the required order.`);
    }
    previousIndex = Math.max(previousIndex, index);
  }
  return { missing, invalid };
}

function readMarkdownHeadings(content: string): Array<{ level: number; text: string }> {
  const result: Array<{ level: number; text: string }> = [];
  let fenced = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      continue;
    }
    const match = /^(#{2,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      result.push({ level: match[1].length, text: match[2].trim() });
    }
  }
  return result;
}

function hasSubstantiveSectionValue(value: string | undefined): boolean {
  return Boolean(value && !/^(none|tbd)\.?$/i.test(value.trim()));
}

function hasCompleteL3FlowMapping(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const allowedActions = new Set<string>(L3_ACTIONS);
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .some((line) => {
      const cells = line.slice(1, -1).split("|").map((cell) => cell.trim());
      return cells.length === 8
        && allowedActions.has(cells[6]?.toLowerCase() ?? "")
        && cells.every((cell) => Boolean(cell) && !/^(none|tbd)\.?$/i.test(cell));
    });
}

function validateDecision(content: string, allowed: readonly string[]): string[] {
  const decision = readArtifactSectionContent(content, "Decision")?.trim();
  return decision && allowed.includes(decision.toLowerCase())
    ? []
    : [renderExactSectionError("Decision", allowed.join("|"), decision)];
}

export function readArtifactSectionValue(content: string, heading: string): string | undefined {
  return readArtifactSectionContent(content, heading)
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

export function readArtifactSectionContent(content: string, heading: string): string | undefined {
  const match = new RegExp(`^#{1,6}\\s+${escapeRegExp(heading)}\\s*$`, "im").exec(content);
  if (!match || match.index === undefined) {
    return undefined;
  }
  const afterHeading = content.slice(match.index + match[0].length);
  const nextHeading = /\n#{1,6}\s+\S/.exec(afterHeading);
  const section = nextHeading?.index === undefined
    ? afterHeading
    : afterHeading.slice(0, nextHeading.index);
  return section.trim();
}

function readInlineField(content: string, field: string): string | undefined {
  return new RegExp(`^\\s*${escapeRegExp(field)}\\s*:\\s*(.+?)\\s*$`, "im")
    .exec(content)?.[1]?.trim().toLowerCase();
}

function isAllowedValue<T extends string>(value: string | undefined, allowed: readonly T[]): value is T {
  return value !== undefined && allowed.includes(value as T);
}

function isExactNone(value: string | undefined): boolean {
  return value?.trim() === STRICT_NONE_VALUE;
}

function renderExactFieldError(
  field: string,
  allowed: readonly string[],
  found: string | undefined
): string {
  return `${field} must be exactly one of "${allowed.join("|")}"; found ${renderFoundValue(found)}.`;
}

function renderExactSectionError(
  section: string,
  expected: string,
  found: string | undefined,
  condition?: string
): string {
  const suffix = condition ? ` ${condition}` : "";
  return `${section} must contain exactly "${expected}"${suffix}; found ${renderFoundValue(found)}.`;
}

function renderFoundValue(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    return "<missing>";
  }
  return JSON.stringify(value.trim().replace(/\s+/g, " "));
}

function hasHeading(content: string, heading: string): boolean {
  const pattern = new RegExp(`^#{1,6}\\s+${escapeRegExp(heading)}\\s*$`, "im");
  return pattern.test(content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
