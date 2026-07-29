const OPERATIONS = ["Add", "Update", "Remove"] as const;

type MemoryProposalSection = (typeof OPERATIONS)[number];

export type MemoryProposalOperation = Lowercase<MemoryProposalSection>;
export type MemoryProposalTarget = "shared" | "current-role";
export type DurableDocDisposition = "memory" | "durable-doc" | "memory-reference";

export interface MemoryProposalItem {
  operation: MemoryProposalOperation;
  ordinal: number;
  target: MemoryProposalTarget;
  content?: string;
  existing?: string;
  reason?: string;
  impactIfAbsent?: string;
  durableDocDisposition?: DurableDocDisposition;
  durableDocPath?: string;
  evidence: string;
}

export interface ParsedMemoryProposal {
  decision: "update" | "no-change";
  items: MemoryProposalItem[];
}

export interface MemoryProposalParseResult {
  proposal?: ParsedMemoryProposal;
  error?: string;
}

export function validateMemoryProposal(content: string): string | undefined {
  return parseMemoryProposal(content).error;
}

export function parseMemoryProposal(content: string): MemoryProposalParseResult {
  if (!/^# Memory Proposal\s*$/m.test(content)) {
    return { error: "is missing the # Memory Proposal heading" };
  }
  const decisionMatches = [...content.matchAll(/^Decision:[ \t]*(update|no-change)[ \t]*$/gm)];
  if (decisionMatches.length !== 1) {
    return { error: "must contain exactly one Decision: update or Decision: no-change field" };
  }

  const levelTwoHeadings = [...content.matchAll(/^## ([^\r\n]+?)[ \t]*$/gm)];
  const sections = [...content.matchAll(/^## (Add|Update|Remove)[ \t]*$/gm)];
  if (
    levelTwoHeadings.length !== OPERATIONS.length
    || sections.length !== OPERATIONS.length
    || sections.some((section, index) => section[1] !== OPERATIONS[index])
  ) {
    return { error: "must contain only the Add, Update, and Remove sections, exactly once and in that order" };
  }

  const items: MemoryProposalItem[] = [];
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const operation = section[1] as MemoryProposalSection;
    const bodyStart = (section.index ?? 0) + section[0].length;
    const bodyEnd = index + 1 < sections.length
      ? sections[index + 1].index ?? content.length
      : content.length;
    const result = parseOperationBody(operation, content.slice(bodyStart, bodyEnd));
    if (result.error) {
      return { error: result.error };
    }
    items.push(...result.items);
  }

  const decision = decisionMatches[0][1] as ParsedMemoryProposal["decision"];
  if (decision === "no-change" && items.length !== 0) {
    return { error: "uses Decision: no-change but contains a memory item" };
  }
  if (decision === "update" && items.length === 0) {
    return { error: "uses Decision: update without a structured memory item" };
  }
  return { proposal: { decision, items } };
}

function parseOperationBody(
  section: MemoryProposalSection,
  rawBody: string
): { items: MemoryProposalItem[]; error?: string } {
  const body = rawBody.trim();
  if (body === "none") {
    return { items: [] };
  }

  const itemHeadings = [...body.matchAll(/^### Item \d+\s*$/gm)];
  if (itemHeadings.length === 0 || body.slice(0, itemHeadings[0].index).trim()) {
    return { items: [], error: `${section} must contain none or one or more ### Item N blocks` };
  }

  const items: MemoryProposalItem[] = [];
  for (let index = 0; index < itemHeadings.length; index += 1) {
    const heading = itemHeadings[index];
    const itemStart = (heading.index ?? 0) + heading[0].length;
    const itemEnd = index + 1 < itemHeadings.length
      ? itemHeadings[index + 1].index ?? body.length
      : body.length;
    const item = body.slice(itemStart, itemEnd).trim();
    const expectedPattern = section === "Add"
      ? /^Target:[ \t]*(shared|current-role)[ \t]*\nContent:[ \t]*(\S.*)[ \t]*\nReason:[ \t]*(\S.*)[ \t]*\nImpact if absent:[ \t]*(\S.*)[ \t]*\nDurable doc disposition:[ \t]*(memory|durable-doc|memory-reference)[ \t]*\nDurable doc path:[ \t]*(\S.*)[ \t]*\nEvidence:[ \t]*(\S.*)[ \t]*$/
      : section === "Update"
        ? /^Target:[ \t]*(shared|current-role)[ \t]*\nExisting:[ \t]*(\S.*)[ \t]*\nContent:[ \t]*(\S.*)[ \t]*\nReason:[ \t]*(\S.*)[ \t]*\nImpact if absent:[ \t]*(\S.*)[ \t]*\nDurable doc disposition:[ \t]*(memory|durable-doc|memory-reference)[ \t]*\nDurable doc path:[ \t]*(\S.*)[ \t]*\nEvidence:[ \t]*(\S.*)[ \t]*$/
        : /^Target:[ \t]*(shared|current-role)[ \t]*\nExisting:[ \t]*(\S.*)[ \t]*\nEvidence:[ \t]*(\S.*)[ \t]*$/;
    const match = expectedPattern.exec(item);
    if (!match) {
      const fields = section === "Add"
        ? "Target, Content, Reason, Impact if absent, Durable doc disposition, Durable doc path, and Evidence"
        : section === "Update"
          ? "Target, Existing, Content, Reason, Impact if absent, Durable doc disposition, Durable doc path, and Evidence"
          : "Target, Existing, and Evidence";
      return {
        items: [],
        error: `${section} ${heading[0].trim()} must contain one-line ${fields} fields in that order`
      };
    }

    const parsed = parseProposalItem(section, index + 1, match);
    if (
      parsed.durableDocDisposition
      && (
        (parsed.durableDocDisposition === "memory" && parsed.durableDocPath !== "none")
        || (parsed.durableDocDisposition !== "memory" && parsed.durableDocPath === "none")
      )
    ) {
      return {
        items: [],
        error: `${section} ${heading[0].trim()} must use Durable doc path: none only with Durable doc disposition: memory`
      };
    }
    items.push(parsed);
  }
  return { items };
}

function parseProposalItem(
  section: MemoryProposalSection,
  ordinal: number,
  match: RegExpExecArray
): MemoryProposalItem {
  if (section === "Add") {
    return {
      operation: "add",
      ordinal,
      target: match[1] as MemoryProposalTarget,
      content: match[2],
      reason: match[3],
      impactIfAbsent: match[4],
      durableDocDisposition: match[5] as DurableDocDisposition,
      durableDocPath: match[6],
      evidence: match[7]
    };
  }
  if (section === "Update") {
    return {
      operation: "update",
      ordinal,
      target: match[1] as MemoryProposalTarget,
      existing: match[2],
      content: match[3],
      reason: match[4],
      impactIfAbsent: match[5],
      durableDocDisposition: match[6] as DurableDocDisposition,
      durableDocPath: match[7],
      evidence: match[8]
    };
  }
  return {
    operation: "remove",
    ordinal,
    target: match[1] as MemoryProposalTarget,
    existing: match[2],
    evidence: match[3]
  };
}
