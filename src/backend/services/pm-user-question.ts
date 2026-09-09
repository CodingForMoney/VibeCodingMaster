import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const markdown = unified().use(remarkParse).use(remarkGfm).freeze();

// Match direct requests, not punctuation or requests mentioned inside a report.
const DIRECT_REQUESTS = [
  /^(?:can|could|do|did|are|have|should|will|would)\s+you\b/i,
  /^(?:should|shall|may|can|could)\s+(?:i|we)\b/i,
  /^(?:which|what|how|where|when|who)\b[^.!?]*\b(?:you|your|(?:should|shall|can|may)\s+(?:i|we))\b/i,
  /^(?:which|what)\s+(?:option|approach|behavior|behaviour|choice)\b[^.!?]*\bshould\s+be\b/i,
  /^(?:please\s+)?(?:answer|reply|respond|choose|confirm|decide|provide|select|tell\s+me|let\s+me\s+know|give\s+(?:me|your))\b/i,
  /^i\s+need\s+your\s+(?:decision|choice|confirmation|answer|approval)\b/i,
  /^your\s+(?:decision|choice|confirmation|answer|approval)\s+is\s+required\b/i,
  /^(?:(?:i\s+am|i'm|we\s+are|we're)\s+)?waiting\s+for\s+your\s+(?:decision|choice|confirmation|answer|reply|approval)\b/i,
  /^(?:请(?:您|你)?(?:回答|回复|选择|确认|决定|提供|告知|给出|说明)|[你您](?:是否|能否|要不要|可否|希望|想要)|是否需要[你您]|需要[你您](?:选择|确认|决定|提供|告知)|(?:需要|等待)[你您]的(?:选择|确认|决定|回复)|告诉我|告知我)/
];

export function findPmUserQuestion(message: string): string | undefined {
  return findQuestion(markdown.parse(message));
}

function findQuestion(node: Nodes): string | undefined {
  // Quoted evidence and code are not PM addressing the user. Headings and table
  // cells remain eligible: a real request does not stop being one when formatted.
  if (["blockquote", "code", "html", "definition", "footnoteDefinition", "delete"].includes(node.type)) {
    return undefined;
  }
  if (node.type === "paragraph" || node.type === "heading" || node.type === "tableCell") {
    const prose = removeQuotedText(proseText(node)).replace(/\s+/g, " ");
    for (const sentence of prose.split(/(?<=[.!?。！？；])\s*/)) {
      const request = sentence.trim().replace(
        /^(?:(?:question(?:\s+for\s+you)?|your\s+decision|问题|请问)\s*[:：]\s*|before\s+(?:i|we)\s+(?:continue|proceed),?\s+)/i,
        ""
      );
      if (DIRECT_REQUESTS.some((pattern) => pattern.test(request))) {
        return sentence.trim();
      }
    }
    return undefined;
  }
  if ("children" in node) {
    for (const child of node.children) {
      const question = findQuestion(child);
      if (question) return question;
    }
  }
  return undefined;
}

function proseText(node: Nodes): string {
  if (node.type === "text") return node.value;
  if (node.type === "break") return "\n";
  if (["inlineCode", "html", "image", "imageReference", "delete", "footnoteReference"].includes(node.type)) return " ";
  if (node.type === "link") {
    const label = node.children.map(proseText).join("");
    return label === node.url || /^(?:https?:\/\/|www\.)/i.test(label) ? " " : label;
  }
  if ("children" in node) return node.children.map(proseText).join("");
  return " ";
}

function removeQuotedText(text: string): string {
  return text.replace(/"[^"]*"|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|(?<!\w)'[^']+'(?!\w)/g, " ");
}
