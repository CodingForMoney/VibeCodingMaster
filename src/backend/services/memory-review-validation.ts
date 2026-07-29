import type { RoleName } from "../../shared/types/role.js";

export function validateMemoryReviewReport(
  content: string,
  proposalRoles: RoleName[]
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
    "Existing Memory Changes"
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
