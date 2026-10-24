import type { ArchitectWorkerSetting, ArchitectWorkerType } from "../../../shared/types/app-settings.js";

// Agent names of the Architect workers whose model and effort follow the
// architect worker settings. Shared by the fixed installer and harness status.
export const ARCHITECT_WORKER_AGENT_TYPES: Record<string, ArchitectWorkerType> = {
  "vcm-architect-evidence-worker": "evidence",
  "vcm-architect-scaffold-worker": "scaffold",
  "vcm-architect-validation-worker": "validation"
};

export function applyArchitectWorkerSetting(content: string, setting: ArchitectWorkerSetting): string {
  const withModel = setAgentFrontmatterField(content, "model", setting.model, /^(?:tools|disallowedTools):.*$/m);
  return setAgentFrontmatterField(
    withModel,
    "effort",
    setting.effort === "default" ? undefined : setting.effort,
    /^model:.*$/m
  );
}

function setAgentFrontmatterField(
  content: string,
  field: string,
  value: string | undefined,
  insertAfter: RegExp
): string {
  const frontmatterMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (!frontmatterMatch) {
    return content;
  }
  const frontmatter = frontmatterMatch[0];
  const fieldLine = new RegExp(`^${field}:.*$`, "m");
  let next: string;
  if (value === undefined) {
    next = frontmatter.replace(new RegExp(`^${field}:.*(?:\\r?\\n)?`, "m"), "");
  } else if (fieldLine.test(frontmatter)) {
    next = frontmatter.replace(fieldLine, `${field}: ${value}`);
  } else {
    const anchor = frontmatter.match(insertAfter);
    next = anchor
      ? frontmatter.replace(anchor[0], `${anchor[0]}\n${field}: ${value}`)
      : frontmatter.replace(/\r?\n---$/, `\n${field}: ${value}\n---`);
  }
  return content.replace(frontmatter, next);
}
