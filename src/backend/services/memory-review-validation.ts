import type { DurableDocDisposition, MemoryProposalOperation } from "./memory-proposal-validation.js";

export type MemoryReviewTarget =
  | "shared"
  | "project-manager"
  | "architect"
  | "coder"
  | "tester"
  | "reviewer"
  | "harness-engineer";

export interface MemoryReviewCandidate {
  id: string;
  source: string;
  operation: MemoryProposalOperation;
  target: MemoryReviewTarget;
  content?: string;
  existing?: string;
}

export type MemoryProposalReviewDecision =
  | "keep-in-memory"
  | "keep-memory-reference"
  | "move-to-durable-doc"
  | "reject"
  | "remove"
  | "retain";

export interface ParsedMemoryProposalReview {
  candidateId: string;
  source: string;
  operation: MemoryProposalOperation;
  target: MemoryReviewTarget;
  candidate?: string;
  existing?: string;
  decision: MemoryProposalReviewDecision;
  finalTarget?: MemoryReviewTarget | "none";
  whyMemoryIsNecessary?: string;
  impactIfAbsent?: string;
  durableDocDisposition?: DurableDocDisposition;
  durableDocAnalysis?: string;
  durableDocPath?: string;
  evidenceChecked: string;
  finalContent?: string;
  reason?: string;
}

export interface MemoryReviewReportParseResult {
  decisions?: ParsedMemoryProposalReview[];
  error?: string;
}

export interface MemoryReviewOutputValidationInput {
  before: Record<MemoryReviewTarget, string>;
  after: Record<MemoryReviewTarget, string>;
  decisions: ParsedMemoryProposalReview[];
  durableDocExists: (path: string) => Promise<boolean>;
}

export function validateMemoryReviewReport(
  content: string,
  candidates: MemoryReviewCandidate[],
  hasExistingMemory = false
): string | undefined {
  return parseMemoryReviewReport(content, candidates, hasExistingMemory).error;
}

export function parseMemoryReviewReport(
  content: string,
  candidates: MemoryReviewCandidate[],
  hasExistingMemory = false
): MemoryReviewReportParseResult {
  const memoryReview = /^## Memory Review\s*$/m.exec(content);
  if (!memoryReview || memoryReview.index === undefined) {
    return { error: "is missing the ## Memory Review section" };
  }
  const sectionStart = memoryReview.index + memoryReview[0].length;
  const nextSection = /^## (?!#)/m.exec(content.slice(sectionStart));
  const section = content.slice(
    sectionStart,
    nextSection?.index === undefined ? content.length : sectionStart + nextSection.index
  );
  if (!/^Existing memory reviewed:[ \t]*complete[ \t]*$/m.test(section)) {
    return { error: "must declare Existing memory reviewed: complete" };
  }
  if (!/^Reviewed memory set:[ \t]*complete[ \t]*$/m.test(section)) {
    return { error: "must declare Reviewed memory set: complete" };
  }

  const dispositions = extractReportSubsection(
    section,
    "Proposal Decisions",
    "Existing Memory Decisions"
  );
  if (dispositions === undefined) {
    return { error: "is missing the Proposal Decisions subsection" };
  }
  const decisionsResult = parseProposalDecisions(dispositions, candidates);
  if (decisionsResult.error) {
    return decisionsResult;
  }

  const existingDecisions = extractReportSubsection(
    section,
    "Existing Memory Decisions",
    "Existing Memory Changes"
  );
  if (existingDecisions === undefined) {
    return { error: "is missing the Existing Memory Decisions subsection" };
  }
  const existingDecisionError = validateExistingMemoryDecisions(
    existingDecisions,
    hasExistingMemory
  );
  if (existingDecisionError) {
    return { error: existingDecisionError };
  }

  const existingChanges = extractReportSubsection(section, "Existing Memory Changes");
  if (existingChanges === undefined) {
    return { error: "is missing the Existing Memory Changes subsection" };
  }
  for (const field of ["retained", "updated", "removed"]) {
    const matches = existingChanges.match(new RegExp(`^- ${field}:[ \\t]*\\S.*$`, "gm"));
    if (matches?.length !== 1) {
      return { error: `must record exactly one non-empty ${field} summary` };
    }
  }
  return { decisions: decisionsResult.decisions };
}

export async function validateMemoryReviewOutput(
  input: MemoryReviewOutputValidationInput
): Promise<string | undefined> {
  const retainedProposalContent = new Set(
    input.decisions
      .filter((decision) => (
        decision.decision === "keep-in-memory"
        || decision.decision === "keep-memory-reference"
      ))
      .map((decision) => decision.finalContent)
      .filter((content): content is string => Boolean(content && content !== "none"))
  );
  for (const decision of input.decisions) {
    const originalBefore = memoryLines(input.before[decision.target]);
    const originalAfter = memoryLines(input.after[decision.target]);
    if (decision.operation === "remove") {
      if (decision.decision === "remove" && originalAfter.has(decision.existing ?? "")) {
        return `still contains ${decision.candidateId}, which the report decided to remove`;
      }
      if (decision.decision === "retain" && !originalAfter.has(decision.existing ?? "")) {
        return `does not retain ${decision.candidateId} as required by the report`;
      }
      continue;
    }

    const keepsMemory = decision.decision === "keep-in-memory"
      || decision.decision === "keep-memory-reference";
    if (keepsMemory) {
      const finalTarget = decision.finalTarget as MemoryReviewTarget;
      if (!memoryLines(input.after[finalTarget]).has(decision.finalContent ?? "")) {
        return `does not contain the exact Final content for ${decision.candidateId} in ${finalTarget}`;
      }
      if (
        decision.operation === "update"
        && decision.existing
        && decision.existing !== decision.finalContent
        && originalAfter.has(decision.existing)
      ) {
        return `still contains the superseded Existing value for ${decision.candidateId}`;
      }
    } else if (
      decision.candidate
      && !memorySetContains(input.before, decision.candidate)
      && memorySetContains(input.after, decision.candidate)
      && !retainedProposalContent.has(decision.candidate)
    ) {
      return `contains the rejected or durable-doc-only candidate ${decision.candidateId}`;
    }

    if (
      decision.durableDocDisposition === "memory-reference"
      && decision.durableDocPath
      && !(await input.durableDocExists(decision.durableDocPath))
    ) {
      return `references a missing durable document for ${decision.candidateId}: ${decision.durableDocPath}`;
    }
  }
  return undefined;
}

function parseProposalDecisions(
  content: string,
  candidates: MemoryReviewCandidate[]
): MemoryReviewReportParseResult {
  const body = content.trim();
  if (candidates.length === 0) {
    return body === "none"
      ? { decisions: [] }
      : { error: "Proposal Decisions must be none when no memory candidate exists" };
  }
  if (body === "none") {
    return { error: "Proposal Decisions cannot be none while memory candidates exist" };
  }

  const headings = [...body.matchAll(/^#### Candidate ([A-Za-z0-9._:-]+)[ \t]*$/gm)];
  if (headings.length === 0 || body.slice(0, headings[0].index).trim()) {
    return { error: "Proposal Decisions must contain one #### Candidate <id> block per memory candidate" };
  }

  const expected = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  const decisions: ParsedMemoryProposalReview[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const candidateId = heading[1];
    if (seen.has(candidateId)) {
      return { error: `contains duplicate proposal decision for ${candidateId}` };
    }
    const candidate = expected.get(candidateId);
    if (!candidate) {
      return { error: `contains an unexpected proposal decision for ${candidateId}` };
    }
    seen.add(candidateId);
    const itemStart = (heading.index ?? 0) + heading[0].length;
    const itemEnd = index + 1 < headings.length
      ? headings[index + 1].index ?? body.length
      : body.length;
    const result = parseProposalDecision(candidate, body.slice(itemStart, itemEnd).trim());
    if (result.error) {
      return { error: result.error };
    }
    decisions.push(result.decision!);
  }

  const missing = candidates.find((candidate) => !seen.has(candidate.id));
  if (missing) {
    return { error: `is missing the proposal decision for ${missing.id}` };
  }
  return { decisions };
}

function parseProposalDecision(
  candidate: MemoryReviewCandidate,
  item: string
): { decision?: ParsedMemoryProposalReview; error?: string } {
  if (candidate.operation === "remove") {
    const match = /^Source:[ \t]*(\S.*)[ \t]*\nOperation:[ \t]*remove[ \t]*\nTarget:[ \t]*(shared|project-manager|architect|coder|tester|reviewer|harness-engineer)[ \t]*\nExisting:[ \t]*(\S.*)[ \t]*\nDecision:[ \t]*(remove|retain)[ \t]*\nReason:[ \t]*(\S.*)[ \t]*\nEvidence checked:[ \t]*(\S.*)[ \t]*$/.exec(item);
    if (!match) {
      return {
        error: `Proposal Decision ${candidate.id} must contain one-line Source, Operation, Target, Existing, Decision, Reason, and Evidence checked fields in that order`
      };
    }
    if (
      match[1] !== candidate.source
      || match[2] !== candidate.target
      || match[3] !== candidate.existing
    ) {
      return { error: `Proposal Decision ${candidate.id} does not match its source proposal` };
    }
    if (isUnresolvedReviewText(match[5]) || isUnresolvedReviewText(match[6])) {
      return { error: `Proposal Decision ${candidate.id} must replace every review placeholder with verified reasoning and evidence` };
    }
    return {
      decision: {
        candidateId: candidate.id,
        source: match[1],
        operation: "remove",
        target: match[2] as MemoryReviewTarget,
        existing: match[3],
        decision: match[4] as MemoryProposalReviewDecision,
        reason: match[5],
        evidenceChecked: match[6]
      }
    };
  }

  const match = /^Source:[ \t]*(\S.*)[ \t]*\nOperation:[ \t]*(add|update)[ \t]*\nTarget:[ \t]*(shared|project-manager|architect|coder|tester|reviewer|harness-engineer)[ \t]*\nCandidate:[ \t]*(\S.*)[ \t]*\nDecision:[ \t]*(keep-in-memory|keep-memory-reference|move-to-durable-doc|reject)[ \t]*\nFinal target:[ \t]*(shared|project-manager|architect|coder|tester|reviewer|harness-engineer|none)[ \t]*\nWhy memory is necessary:[ \t]*(\S.*)[ \t]*\nImpact if absent:[ \t]*(\S.*)[ \t]*\nDurable doc disposition:[ \t]*(memory|durable-doc|memory-reference)[ \t]*\nDurable doc analysis:[ \t]*(\S.*)[ \t]*\nDurable doc path:[ \t]*(\S.*)[ \t]*\nEvidence checked:[ \t]*(\S.*)[ \t]*\nFinal content:[ \t]*(\S.*)[ \t]*$/.exec(item);
  if (!match) {
    return {
      error: `Proposal Decision ${candidate.id} must contain one-line Source, Operation, Target, Candidate, Decision, Final target, Why memory is necessary, Impact if absent, Durable doc disposition, Durable doc analysis, Durable doc path, Evidence checked, and Final content fields in that order`
    };
  }
  if (
    match[1] !== candidate.source
    || match[2] !== candidate.operation
    || match[3] !== candidate.target
    || match[4] !== candidate.content
  ) {
    return { error: `Proposal Decision ${candidate.id} does not match its source proposal` };
  }
  if ([match[7], match[8], match[10], match[12]].some(isUnresolvedReviewText)) {
    return { error: `Proposal Decision ${candidate.id} must replace every review placeholder with independent analysis and verified evidence` };
  }

  const decision = match[5] as MemoryProposalReviewDecision;
  const finalTarget = match[6] as MemoryReviewTarget | "none";
  const durableDocDisposition = match[9] as DurableDocDisposition;
  const durableDocPath = match[11];
  const finalContent = match[13];
  const keepsMemory = decision === "keep-in-memory" || decision === "keep-memory-reference";
  if (keepsMemory && (finalTarget === "none" || finalContent === "none")) {
    return { error: `Proposal Decision ${candidate.id} must provide Final target and Final content when keeping memory` };
  }
  if (!keepsMemory && (finalTarget !== "none" || finalContent !== "none")) {
    return { error: `Proposal Decision ${candidate.id} must use Final target: none and Final content: none when not keeping memory` };
  }
  if (
    (decision === "keep-in-memory" && durableDocDisposition !== "memory")
    || (decision === "keep-memory-reference" && durableDocDisposition !== "memory-reference")
    || (decision === "move-to-durable-doc" && durableDocDisposition !== "durable-doc")
  ) {
    return { error: `Proposal Decision ${candidate.id} has inconsistent Decision and Durable doc disposition values` };
  }
  if (
    (durableDocDisposition === "memory" && durableDocPath !== "none")
    || (durableDocDisposition !== "memory" && durableDocPath === "none")
  ) {
    return { error: `Proposal Decision ${candidate.id} must use Durable doc path: none only with Durable doc disposition: memory` };
  }

  return {
    decision: {
      candidateId: candidate.id,
      source: match[1],
      operation: match[2] as MemoryProposalOperation,
      target: match[3] as MemoryReviewTarget,
      candidate: match[4],
      decision,
      finalTarget,
      whyMemoryIsNecessary: match[7],
      impactIfAbsent: match[8],
      durableDocDisposition,
      durableDocAnalysis: match[10],
      durableDocPath,
      evidenceChecked: match[12],
      finalContent
    }
  };
}

function validateExistingMemoryDecisions(
  content: string,
  hasExistingMemory: boolean
): string | undefined {
  const body = content.trim();
  if (body === "none") {
    return hasExistingMemory
      ? "Existing Memory Decisions cannot be none while substantive existing memory is present"
      : undefined;
  }
  const itemHeadings = [...body.matchAll(/^#### Item \d+[ \t]*$/gm)];
  if (itemHeadings.length === 0 || body.slice(0, itemHeadings[0].index).trim()) {
    return "Existing Memory Decisions must contain none or one or more #### Item N blocks";
  }
  for (let index = 0; index < itemHeadings.length; index += 1) {
    const heading = itemHeadings[index];
    const itemStart = (heading.index ?? 0) + heading[0].length;
    const itemEnd = index + 1 < itemHeadings.length
      ? itemHeadings[index + 1].index ?? body.length
      : body.length;
    const item = body.slice(itemStart, itemEnd).trim();
    const match = /^Target:[ \t]*(shared|project-manager|architect|coder|tester|reviewer|harness-engineer)[ \t]*\nExisting:[ \t]*(\S.*)[ \t]*\nDecision:[ \t]*(retain|update|remove|move-to-durable-doc)[ \t]*\nReason:[ \t]*(\S.*)[ \t]*\nImpact if removed:[ \t]*(\S.*)[ \t]*\nDurable doc disposition:[ \t]*(memory|durable-doc|memory-reference)[ \t]*\nDurable doc path:[ \t]*(\S.*)[ \t]*\nEvidence:[ \t]*(\S.*)[ \t]*$/.exec(item);
    if (!match) {
      return `Existing Memory Decisions ${heading[0].trim()} must contain one-line Target, Existing, Decision, Reason, Impact if removed, Durable doc disposition, Durable doc path, and Evidence fields in that order`;
    }
    const disposition = match[6];
    const durableDocPath = match[7];
    if (
      (disposition === "memory" && durableDocPath !== "none")
      || (disposition !== "memory" && durableDocPath === "none")
    ) {
      return `Existing Memory Decisions ${heading[0].trim()} must use Durable doc path: none only with Durable doc disposition: memory`;
    }
  }
  return undefined;
}

function extractReportSubsection(
  content: string,
  heading: string,
  nextHeading?: string
): string | undefined {
  const start = new RegExp(`^### ${escapeRegExp(heading)}\\s*$`, "m").exec(content);
  if (!start || start.index === undefined) {
    return undefined;
  }
  const bodyStart = start.index + start[0].length;
  if (nextHeading) {
    const end = new RegExp(`^### ${escapeRegExp(nextHeading)}\\s*$`, "m")
      .exec(content.slice(bodyStart));
    return end?.index === undefined
      ? undefined
      : content.slice(bodyStart, bodyStart + end.index);
  }
  const reviewedSet = /^Reviewed memory set:/m.exec(content.slice(bodyStart));
  return content.slice(
    bodyStart,
    reviewedSet?.index === undefined ? content.length : bodyStart + reviewedSet.index
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function memorySetContains(memory: Record<MemoryReviewTarget, string>, value: string): boolean {
  return Object.values(memory).some((content) => memoryLines(content).has(value));
}

function memoryLines(content: string): Set<string> {
  return new Set(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

function isUnresolvedReviewText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    /[<>]/.test(value)
    || normalized === "none"
    || normalized === "tbd"
    || normalized === "unknown"
    || normalized === "n/a"
  );
}
