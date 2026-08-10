import type {
  ArtifactCheckResult,
  ArtifactSubmissionMode,
  ManagedArtifactKind
} from "../../shared/types/artifact.js";
import {
  CODE_DIFF_FINDING_SCOPES,
  GATE_REVIEW_GATES,
  type CodeDiffFindingScope,
  type GateReviewDecision,
  type GateReviewFinding,
  type GateReviewGate
} from "../../shared/types/gate-review.js";
import type { VcmMessageType } from "../../shared/types/message.js";
import { checkMarkdownArtifact } from "../../shared/validation/artifact-check.js";
import {
  getManagedArtifactDefinition,
  isArtifactKind
} from "../../shared/validation/artifact-registry.js";
import {
  parseMemoryProposal,
  type ParsedMemoryProposal
} from "./memory-proposal-validation.js";

export const ROUTE_MESSAGE_TYPES = [
  "task",
  "question",
  "revise",
  "cancel",
  "result",
  "blocked",
  "finding"
] as const satisfies readonly VcmMessageType[];

export const GATE_ANALYSIS_HEADINGS: Record<GateReviewGate, string> = {
  "architecture-plan": "Architecture Analysis",
  "validation-adequacy": "Validation Analysis",
  "code-diff": "Code Diff Analysis"
};

export const GATE_ANALYSIS_FIELDS: Record<GateReviewGate, readonly string[]> = {
  "architecture-plan": [
    "Evidence Read",
    "Architecture Brief Fit",
    "End-To-End Flow",
    "Scope Fit",
    "Code Reality",
    "Invalidated Assumptions",
    "Existing-Class Completeness",
    "Ownership",
    "Data Flow",
    "Lifecycle",
    "Invariants",
    "Boundaries And Public Surface",
    "Failure Model",
    "Coder Readiness"
  ],
  "validation-adequacy": [
    "Evidence Read",
    "Changed Behavior And Risk",
    "Coverage Mapping",
    "Baseline Coverage",
    "L2 Integration Coverage",
    "L3 Trigger Assessment",
    "L3 End-To-End Coverage",
    "Boundary And Failure Coverage",
    "Public Contract Coverage",
    "Test Integrity",
    "Test Infrastructure",
    "Skips And Gaps",
    "User Approval And Gap Disposition",
    "Validation Readiness"
  ],
  "code-diff": [
    "Commit Range And Sources",
    "Evidence Read",
    "Changed Files And Symbols",
    "Changed Behavior",
    "Source Evidence Fit",
    "Callers And Public Surface",
    "State Lifecycle And Failure Paths",
    "Coding Standards",
    "Baseline Test Integrity",
    "Generated Context And Durable Docs",
    "Code Readiness"
  ]
};

export interface ParsedRouteMessageArtifact {
  type: (typeof ROUTE_MESSAGE_TYPES)[number];
  body: string;
  artifactRefs: string[];
}

export interface ParsedCoderWorkerReportArtifact {
  workerId: string;
  workerState: "completed";
  implementationResult: "success" | "has_failed_items";
}

export interface ParsedGateReviewReportArtifact {
  gate: GateReviewGate;
  requestId: string;
  decision: GateReviewDecision;
  summary: string;
  findings: GateReviewFinding[];
  analysis: Record<string, string>;
}

export interface ParsedHarnessFeedbackArtifact {
  title: string;
  reporterRole: string;
  taskSlug: string;
  summary: string;
  observedProblem: string;
  expectedBehavior: string;
  evidence: string;
  suspectedHarnessArea: string;
  impact: string;
  urgency: "low" | "medium" | "high";
}

export type ParsedManagedArtifact =
  | ParsedRouteMessageArtifact
  | ParsedCoderWorkerReportArtifact
  | ParsedGateReviewReportArtifact
  | ParsedMemoryProposal
  | ParsedHarnessFeedbackArtifact;

export interface ManagedArtifactValidationContext {
  path: string;
  mode: ArtifactSubmissionMode;
  expectedGate?: GateReviewGate;
  expectedRequestId?: string;
}

export interface ManagedArtifactValidationResult {
  errors: string[];
  status: ArtifactCheckResult["status"] | "accepted";
  check?: ArtifactCheckResult;
  parsed?: ParsedManagedArtifact;
}

interface ParseResult<T> {
  errors: string[];
  parsed?: T;
}

const PLACEHOLDER_VALUE = /^(?:TBD|Not run yet\.?|<[^>]+>)$/i;

export function validateManagedArtifactContent(
  kind: ManagedArtifactKind,
  content: string,
  context: ManagedArtifactValidationContext
): ManagedArtifactValidationResult {
  const definition = getManagedArtifactDefinition(kind);
  if (!definition.allowedModes.includes(context.mode)) {
    return {
      errors: [`${kind} supports only ${definition.allowedModes.join("|")} mode.`],
      status: "incomplete"
    };
  }

  if (isArtifactKind(kind)) {
    const check = checkMarkdownArtifact(kind, context.path, content, { mode: context.mode });
    return {
      errors: artifactCheckErrors(check, context.mode),
      status: check.status,
      check
    };
  }

  const result = kind === "route-message"
    ? parseRouteMessageArtifact(content)
    : kind === "coder-worker-report"
      ? parseCoderWorkerReportArtifact(content)
      : kind === "gate-review-report"
        ? parseGateReviewReportArtifact(content, {
            expectedGate: context.expectedGate,
            expectedRequestId: context.expectedRequestId
          })
        : kind === "memory-proposal"
          ? parseMemoryProposalArtifact(content)
          : parseHarnessFeedbackArtifact(content);
  return {
    errors: result.errors,
    status: result.errors.length === 0 ? "accepted" : "incomplete",
    parsed: result.parsed
  };
}

export function parseRouteMessageArtifact(content: string): ParseResult<ParsedRouteMessageArtifact> {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!frontmatter) {
    return { errors: ["Route message requires YAML-style frontmatter bounded by ---." ] };
  }
  const fields = parseColonFields(frontmatter[1]);
  const errors: string[] = [];
  const type = fields.type;
  if (!type || !ROUTE_MESSAGE_TYPES.includes(type as (typeof ROUTE_MESSAGE_TYPES)[number])) {
    errors.push(`Frontmatter type must be exactly one of ${ROUTE_MESSAGE_TYPES.join("|")}.`);
  }
  const body = content.slice(frontmatter[0].length).trim();
  if (!body) {
    errors.push("Route message body must not be empty.");
  }
  if (errors.length > 0) {
    return { errors };
  }
  const refs = fields.artifact_refs ?? fields.artifactRefs ?? fields.related_artifact;
  return {
    errors: [],
    parsed: {
      type: type as ParsedRouteMessageArtifact["type"],
      body,
      artifactRefs: refs ? refs.split(",").map((entry) => entry.trim()).filter(Boolean) : []
    }
  };
}

export function parseCoderWorkerReportArtifact(
  content: string
): ParseResult<ParsedCoderWorkerReportArtifact> {
  const definition = getManagedArtifactDefinition("coder-worker-report");
  const errors = validateRequiredHeadings(content, definition.requiredHeadings);
  const titleMatches = [...content.matchAll(/^# Coder Worker Report:\s*(\S.+?)\s*$/gm)];
  if (titleMatches.length !== 1) {
    errors.push("Coder Worker report requires exactly one '# Coder Worker Report: <worker-id>' title.");
  }
  const workerState = readUniqueField(content, "Worker State", errors);
  if (workerState !== "completed") {
    errors.push(`Worker State must be exactly completed; found ${renderFoundValue(workerState)}.`);
  }
  const implementationResult = readUniqueField(content, "Implementation Result", errors);
  if (implementationResult !== "success" && implementationResult !== "has_failed_items") {
    errors.push(
      `Implementation Result must be exactly success|has_failed_items; found ${renderFoundValue(implementationResult)}.`
    );
  }
  if (errors.length > 0) {
    return { errors };
  }
  return {
    errors: [],
    parsed: {
      workerId: titleMatches[0][1].trim(),
      workerState: "completed",
      implementationResult: implementationResult as ParsedCoderWorkerReportArtifact["implementationResult"]
    }
  };
}

export function parseGateReviewReportArtifact(
  content: string,
  context: { expectedGate?: GateReviewGate; expectedRequestId?: string } = {}
): ParseResult<ParsedGateReviewReportArtifact> {
  const errors: string[] = [];
  const gateValue = readUniqueField(content, "Gate", errors);
  const requestId = readUniqueField(content, "Request", errors);
  const decisionValue = readUniqueField(content, "Decision", errors);
  const summary = readUniqueField(content, "Summary", errors);
  const gate = GATE_REVIEW_GATES.includes(gateValue as GateReviewGate)
    ? gateValue as GateReviewGate
    : undefined;
  if (!gate) {
    errors.push(`Gate must be exactly one of ${GATE_REVIEW_GATES.join("|")}; found ${renderFoundValue(gateValue)}.`);
  }
  if (context.expectedGate && gateValue !== context.expectedGate) {
    errors.push(`Gate must be ${context.expectedGate}; found ${renderFoundValue(gateValue)}.`);
  }
  if (context.expectedRequestId && requestId !== context.expectedRequestId) {
    errors.push(`Request must be ${context.expectedRequestId}; found ${renderFoundValue(requestId)}.`);
  }
  if (decisionValue !== "approve" && decisionValue !== "request_changes") {
    errors.push(`Decision must be exactly approve|request_changes; found ${renderFoundValue(decisionValue)}.`);
  }
  if (!isSubstantiveValue(summary)) {
    errors.push("Summary must contain a substantive one-line value.");
  }

  let analysis: Record<string, string> = {};
  if (gate) {
    const expectedHeading = GATE_ANALYSIS_HEADINGS[gate];
    for (const candidate of Object.values(GATE_ANALYSIS_HEADINGS)) {
      const count = countMarkdownHeading(content, candidate);
      if (candidate === expectedHeading && count !== 1) {
        errors.push(`${expectedHeading} must appear exactly once; found ${count}.`);
      }
      if (candidate !== expectedHeading && count !== 0) {
        errors.push(`${candidate} is not allowed for the ${gate} gate.`);
      }
    }
    const section = readMarkdownSection(content, expectedHeading);
    if (section) {
      analysis = parseRequiredBulletFields(section, GATE_ANALYSIS_FIELDS[gate], errors, expectedHeading);
    }
  }

  const findingsCount = countMarkdownHeading(content, "Findings");
  if (findingsCount !== 1) {
    errors.push(`Findings must appear exactly once; found ${findingsCount}.`);
  }
  const findingsBody = readMarkdownSection(content, "Findings");
  let findings: GateReviewFinding[] = [];
  if (decisionValue === "approve") {
    if (findingsBody?.trim() !== "None.") {
      errors.push('Findings must contain exactly "None." when Decision is approve.');
    }
  } else if (decisionValue === "request_changes") {
    const parsedFindings = parseGateFindings(findingsBody ?? "", gate, errors);
    findings = parsedFindings;
    if (findings.length === 0) {
      errors.push("Decision request_changes requires at least one structured finding.");
    }
  }

  if (errors.length > 0 || !gate || !requestId || !summary) {
    return { errors };
  }
  return {
    errors: [],
    parsed: {
      gate,
      requestId,
      decision: decisionValue as GateReviewDecision,
      summary,
      findings,
      analysis
    }
  };
}

export function parseMemoryProposalArtifact(content: string): ParseResult<ParsedMemoryProposal> {
  const result = parseMemoryProposal(content);
  return result.error
    ? { errors: [`Memory proposal ${result.error}.`] }
    : { errors: [], parsed: result.proposal };
}

export function parseHarnessFeedbackArtifact(
  content: string
): ParseResult<ParsedHarnessFeedbackArtifact> {
  const errors: string[] = [];
  const titleMatches = [...content.matchAll(/^#\s+(\S.+?)\s*$/gm)];
  if (titleMatches.length !== 1) {
    errors.push(`Harness Feedback requires exactly one '# <short problem title>' heading.`);
  }
  const fieldNames = [
    "Reporter role",
    "Task slug",
    "Summary",
    "Observed problem",
    "Expected behavior",
    "Evidence",
    "Suspected harness area",
    "Impact",
    "Urgency"
  ] as const;
  const values: Record<string, string> = {};
  for (const field of fieldNames) {
    const matches = [...content.matchAll(new RegExp(`^- ${escapeRegExp(field)}:\\s*(.*?)\\s*$`, "gmi"))];
    if (matches.length !== 1 || !isSubstantiveValue(matches[0]?.[1])) {
      errors.push(`Harness Feedback field ${field} must appear exactly once with a substantive value.`);
      continue;
    }
    values[field] = matches[0][1].trim();
  }
  if (values.Urgency !== "low" && values.Urgency !== "medium" && values.Urgency !== "high") {
    errors.push(`Urgency must be exactly low|medium|high; found ${renderFoundValue(values.Urgency)}.`);
  }
  if (errors.length > 0) {
    return { errors };
  }
  return {
    errors: [],
    parsed: {
      title: titleMatches[0][1].trim(),
      reporterRole: values["Reporter role"],
      taskSlug: values["Task slug"],
      summary: values.Summary,
      observedProblem: values["Observed problem"],
      expectedBehavior: values["Expected behavior"],
      evidence: values.Evidence,
      suspectedHarnessArea: values["Suspected harness area"],
      impact: values.Impact,
      urgency: values.Urgency as ParsedHarnessFeedbackArtifact["urgency"]
    }
  };
}

export function artifactCheckErrors(
  check: ArtifactCheckResult,
  mode: ArtifactSubmissionMode
): string[] {
  const errors = [
    ...check.missingHeadings.map((heading) => `Missing required heading: ${heading}.`),
    ...check.invalidFields
  ];
  if (mode === "final" && check.hasPlaceholder) {
    errors.push("Final artifacts must not contain TBD, draft, or not-run placeholders.");
  }
  return errors;
}

function parseGateFindings(
  content: string,
  gate: GateReviewGate | undefined,
  errors: string[]
): GateReviewFinding[] {
  const headings = [...content.matchAll(/^### (critical|high|medium|low):\s*(\S.+?)\s*$/gmi)];
  if (headings.length === 0) {
    return [];
  }
  if (content.slice(0, headings[0].index).trim()) {
    errors.push("Findings must contain only structured ### <severity>: <title> blocks.");
  }
  const findings: GateReviewFinding[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const start = (heading.index ?? 0) + heading[0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index ?? content.length : content.length;
    const block = content.slice(start, end).trim();
    const fields = parseRequiredBulletFields(block, ["Evidence", "Expected", "Gap", "Risk"], errors, heading[2]);
    const finding: GateReviewFinding = {
      severity: heading[1].toLowerCase() as GateReviewFinding["severity"],
      title: heading[2].trim(),
      evidence: fields.Evidence ?? "",
      expected: fields.Expected ?? "",
      gap: fields.Gap ?? "",
      risk: fields.Risk ?? ""
    };
    if (gate === "code-diff") {
      const codeFields = parseRequiredBulletFields(
        block,
        ["File", "Line Or Symbol", "Finding Scope"],
        errors,
        heading[2]
      );
      if (!CODE_DIFF_FINDING_SCOPES.includes(codeFields["Finding Scope"] as CodeDiffFindingScope)) {
        errors.push(
          `${heading[2]} Finding Scope must be exactly ${CODE_DIFF_FINDING_SCOPES.join("|")}; found ${renderFoundValue(codeFields["Finding Scope"])}.`
        );
      }
      finding.file = codeFields.File;
      finding.location = codeFields["Line Or Symbol"];
      finding.scope = codeFields["Finding Scope"] as CodeDiffFindingScope;
    }
    findings.push(finding);
  }
  return findings;
}

function parseRequiredBulletFields(
  content: string,
  requiredFields: readonly string[],
  errors: string[],
  sectionName: string
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of requiredFields) {
    const matches = [...content.matchAll(new RegExp(`^- ${escapeRegExp(field)}:\\s*(.*?)\\s*$`, "gmi"))];
    if (matches.length !== 1) {
      errors.push(`${sectionName} field ${field} must appear exactly once; found ${matches.length}.`);
      continue;
    }
    const value = matches[0][1].trim();
    if (!isSubstantiveValue(value)) {
      errors.push(`${sectionName} field ${field} must contain a substantive value.`);
      continue;
    }
    values[field] = value;
  }
  return values;
}

function validateRequiredHeadings(content: string, headings: readonly string[]): string[] {
  const errors: string[] = [];
  let previous = -1;
  for (const heading of headings) {
    const matches = [...content.matchAll(new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "gmi"))];
    if (matches.length !== 1) {
      errors.push(`Heading ${heading} must appear exactly once; found ${matches.length}.`);
      continue;
    }
    const index = matches[0].index ?? -1;
    if (index < previous) {
      errors.push(`Heading ${heading} is out of the required order.`);
    }
    previous = index;
  }
  return errors;
}

function readUniqueField(content: string, field: string, errors: string[]): string | undefined {
  const matches = [...content.matchAll(new RegExp(`^${escapeRegExp(field)}:\\s*(.*?)\\s*$`, "gmi"))];
  if (matches.length !== 1) {
    errors.push(`${field} must appear exactly once; found ${matches.length}.`);
    return undefined;
  }
  return matches[0][1].trim();
}

function readMarkdownSection(content: string, heading: string): string | undefined {
  const match = new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "mi").exec(content);
  if (!match || match.index === undefined) {
    return undefined;
  }
  const remainder = content.slice(match.index + match[0].length);
  const nextHeading = remainder.search(/^##\s+/m);
  return (nextHeading >= 0 ? remainder.slice(0, nextHeading) : remainder).trim();
}

function countMarkdownHeading(content: string, heading: string): number {
  return [...content.matchAll(new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "gmi"))].length;
}

function parseColonFields(content: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const delimiter = line.indexOf(":");
    if (delimiter <= 0) {
      continue;
    }
    fields[line.slice(0, delimiter).trim()] = line.slice(delimiter + 1).trim();
  }
  return fields;
}

function isSubstantiveValue(value: string | undefined): value is string {
  return Boolean(value?.trim() && !PLACEHOLDER_VALUE.test(value.trim()));
}

function renderFoundValue(value: string | undefined): string {
  return value?.trim() ? JSON.stringify(value.trim()) : "<missing>";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
