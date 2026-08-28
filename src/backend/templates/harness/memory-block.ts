export const VCM_MEMORY_BLOCK_START = "<VCM-memory>";
export const VCM_MEMORY_BLOCK_END = "</VCM-memory>";
export const DEFAULT_VCM_MEMORY = "No accumulated project memory yet.";

export interface VcmMemoryHostFrame {
  beforeBlock: string;
  afterBlock: string;
}

const MANAGED_BLOCK_START_PATTERN = /<!-- VCM:BEGIN(?:\s+version=\d+)? -->/m;

export function renderVcmMemoryBlock(content = DEFAULT_VCM_MEMORY): string {
  return `${VCM_MEMORY_BLOCK_START}\n${normalizeMemoryContent(content)}${VCM_MEMORY_BLOCK_END}`;
}

export function readVcmMemoryBlock(fileContent: string): string | undefined {
  const range = findMemoryBlockRange(fileContent);
  if (!range) {
    return undefined;
  }
  const content = fileContent.slice(range.contentStart, range.contentEnd);
  return ensureTrailingNewline(content.replace(/^\r?\n/, "").replace(/\r?\n$/, ""));
}

export function replaceVcmMemoryBlock(fileContent: string, content: string): string {
  const range = findMemoryBlockRange(fileContent);
  if (!range) {
    throw new Error("VCM memory block is missing.");
  }
  return `${fileContent.slice(0, range.start)}${renderVcmMemoryBlock(content)}${fileContent.slice(range.end)}`;
}

export function readVcmMemoryHostFrame(fileContent: string): VcmMemoryHostFrame | undefined {
  const range = findMemoryBlockRange(fileContent);
  if (!range) {
    return undefined;
  }
  return {
    beforeBlock: fileContent.slice(0, range.start),
    afterBlock: fileContent.slice(range.end)
  };
}

export function ensureVcmMemoryBlock(fileContent: string): string {
  if (findMemoryBlockRange(fileContent)) {
    return fileContent;
  }

  const block = renderVcmMemoryBlock();
  const managedBlockIndex = fileContent.search(MANAGED_BLOCK_START_PATTERN);
  if (managedBlockIndex < 0) {
    return `${fileContent.trimEnd()}\n\n${block}\n`;
  }

  const before = fileContent.slice(0, managedBlockIndex).trimEnd();
  const after = fileContent.slice(managedBlockIndex).trimStart();
  return `${before}\n\n${block}\n\n${after}`;
}

function findMemoryBlockRange(fileContent: string): {
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
} | undefined {
  const starts = findMarkerLines(fileContent, VCM_MEMORY_BLOCK_START);
  const ends = findMarkerLines(fileContent, VCM_MEMORY_BLOCK_END);
  if (starts.length === 0 && ends.length === 0) {
    return undefined;
  }
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    throw new Error("VCM memory block must contain exactly one valid <VCM-memory> section.");
  }
  return {
    start: starts[0],
    end: ends[0] + VCM_MEMORY_BLOCK_END.length,
    contentStart: starts[0] + VCM_MEMORY_BLOCK_START.length,
    contentEnd: ends[0]
  };
}

function findMarkerLines(content: string, value: string): number[] {
  const indexes: number[] = [];
  const pattern = new RegExp(`^${escapeRegExp(value)}\\r?$`, "gm");
  for (const match of content.matchAll(pattern)) {
    indexes.push(match.index);
  }
  return indexes;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeMemoryContent(content: string): string {
  const normalized = content.trim();
  return `${normalized || DEFAULT_VCM_MEMORY}\n`;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}
