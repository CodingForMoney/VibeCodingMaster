const OPERATIONS = ["Add", "Update", "Remove"] as const;

type MemoryProposalOperation = (typeof OPERATIONS)[number];

export function validateMemoryProposal(content: string): string | undefined {
  if (!/^# Memory Proposal\s*$/m.test(content)) {
    return "is missing the # Memory Proposal heading";
  }
  const decisionMatches = [...content.matchAll(/^Decision:[ \t]*(update|no-change)[ \t]*$/gm)];
  if (decisionMatches.length !== 1) {
    return "must contain exactly one Decision: update or Decision: no-change field";
  }

  const levelTwoHeadings = [...content.matchAll(/^## ([^\r\n]+?)[ \t]*$/gm)];
  const sections = [...content.matchAll(/^## (Add|Update|Remove)[ \t]*$/gm)];
  if (
    levelTwoHeadings.length !== OPERATIONS.length
    || sections.length !== OPERATIONS.length
    || sections.some((section, index) => section[1] !== OPERATIONS[index])
  ) {
    return "must contain only the Add, Update, and Remove sections, exactly once and in that order";
  }

  let itemCount = 0;
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const operation = section[1] as MemoryProposalOperation;
    const bodyStart = (section.index ?? 0) + section[0].length;
    const bodyEnd = index + 1 < sections.length
      ? sections[index + 1].index ?? content.length
      : content.length;
    const result = validateOperationBody(operation, content.slice(bodyStart, bodyEnd));
    if (typeof result === "string") {
      return result;
    }
    itemCount += result;
  }

  const decision = decisionMatches[0][1];
  if (decision === "no-change" && itemCount !== 0) {
    return "uses Decision: no-change but contains a memory item";
  }
  if (decision === "update" && itemCount === 0) {
    return "uses Decision: update without a structured memory item";
  }
  return undefined;
}

function validateOperationBody(
  operation: MemoryProposalOperation,
  rawBody: string
): number | string {
  const body = rawBody.trim();
  if (body === "none") {
    return 0;
  }

  const itemHeadings = [...body.matchAll(/^### Item \d+\s*$/gm)];
  if (itemHeadings.length === 0 || body.slice(0, itemHeadings[0].index).trim()) {
    return `${operation} must contain none or one or more ### Item N blocks`;
  }

  for (let index = 0; index < itemHeadings.length; index += 1) {
    const heading = itemHeadings[index];
    const itemStart = (heading.index ?? 0) + heading[0].length;
    const itemEnd = index + 1 < itemHeadings.length
      ? itemHeadings[index + 1].index ?? body.length
      : body.length;
    const item = body.slice(itemStart, itemEnd).trim();
    const expectedPattern = operation === "Add"
      ? /^Target:[ \t]*(shared|current-role)[ \t]*\nContent:[ \t]*(\S.*)[ \t]*\nEvidence:[ \t]*(\S.*)[ \t]*$/
      : operation === "Update"
        ? /^Target:[ \t]*(shared|current-role)[ \t]*\nExisting:[ \t]*(\S.*)[ \t]*\nContent:[ \t]*(\S.*)[ \t]*\nEvidence:[ \t]*(\S.*)[ \t]*$/
        : /^Target:[ \t]*(shared|current-role)[ \t]*\nExisting:[ \t]*(\S.*)[ \t]*\nEvidence:[ \t]*(\S.*)[ \t]*$/;
    if (!expectedPattern.test(item)) {
      const fields = operation === "Add"
        ? "Target, Content, and Evidence"
        : operation === "Update"
          ? "Target, Existing, Content, and Evidence"
          : "Target, Existing, and Evidence";
      return `${operation} ${heading[0].trim()} must contain one-line ${fields} fields in that order`;
    }
  }
  return itemHeadings.length;
}
