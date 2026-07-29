import type { RoleName } from "../../shared/types/role.js";

export function validateMemoryReviewReport(
  content: string,
  proposalRoles: RoleName[],
  hasExistingMemory = false
): string | undefined {
  const memoryReview = /^## Memory Review\s*$/m.exec(content);
  if (!memoryReview || memoryReview.index === undefined) {
    return "is missing the ## Memory Review section";
  }
  const sectionStart = memoryReview.index + memoryReview[0].length;
  const nextSection = /^## (?!#)/m.exec(content.slice(sectionStart));
  const section = content.slice(
    sectionStart,
    nextSection?.index === undefined ? content.length : sectionStart + nextSection.index
  );
  if (!/^Existing memory reviewed:[ \t]*complete[ \t]*$/m.test(section)) {
    return "must declare Existing memory reviewed: complete";
  }
  if (!/^Reviewed memory set:[ \t]*complete[ \t]*$/m.test(section)) {
    return "must declare Reviewed memory set: complete";
  }

  const dispositions = extractReportSubsection(
    section,
    "Proposal Dispositions",
    "Existing Memory Decisions"
  );
  if (dispositions === undefined) {
    return "is missing the Proposal Dispositions subsection";
  }
  for (const role of proposalRoles) {
    const matches = dispositions.match(
      new RegExp(`^- ${escapeRegExp(role)}:[ \\t]*(accepted|rejected|no-change)[ \\t]*$`, "gm")
    );
    if (matches?.length !== 1) {
      return `must record exactly one accepted, rejected, or no-change disposition for ${role}`;
    }
  }

  const existingDecisions = extractReportSubsection(
    section,
    "Existing Memory Decisions",
    "Existing Memory Changes"
  );
  if (existingDecisions === undefined) {
    return "is missing the Existing Memory Decisions subsection";
  }
  const existingDecisionError = validateExistingMemoryDecisions(
    existingDecisions,
    hasExistingMemory
  );
  if (existingDecisionError) {
    return existingDecisionError;
  }

  const existingChanges = extractReportSubsection(section, "Existing Memory Changes");
  if (existingChanges === undefined) {
    return "is missing the Existing Memory Changes subsection";
  }
  for (const field of ["retained", "updated", "removed"]) {
    const matches = existingChanges.match(new RegExp(`^- ${field}:[ \\t]*\\S.*$`, "gm"));
    if (matches?.length !== 1) {
      return `must record exactly one non-empty ${field} summary`;
    }
  }
  return undefined;
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
