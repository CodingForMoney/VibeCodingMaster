import path from "node:path";
import { DISPATCHABLE_ROLES, VCM_ROLE_NAMES } from "../../shared/constants.js";
import type {
  ArtifactCheckResult,
  ArtifactKind,
  ArtifactSubmissionMode,
  ArtifactSubmissionResult,
  ArtifactSummary,
  HandoffPaths
} from "../../shared/types/artifact.js";
import type { DispatchableRole, RoleName } from "../../shared/types/role.js";
import { checkMarkdownArtifact } from "../../shared/validation/artifact-check.js";
import { getArtifactDefinition, isArtifactKind } from "../../shared/validation/artifact-registry.js";
import { VcmError } from "../errors.js";
import {
  resolveRepoPath,
  type FileSystemAdapter
} from "../adapters/filesystem.js";
import {
  renderArchitectureBriefTemplate,
  renderArchitectureDiagnosisTemplate,
  renderArchitectureEvidenceTemplate,
  renderArchitecturePlanTemplate,
  renderArchitectDebugTemplate,
  renderCoderCompletionTemplate,
  renderDocsSyncReportTemplate,
  renderFinalAcceptanceTemplate,
  renderKnownIssuesTemplate,
  renderPlanningProgressTemplate,
  renderMessageRouteTemplate,
  renderTestReportTemplate
} from "../templates/handoff.js";
import { renderRoleCommandTemplate } from "../templates/role-command.js";
import { validateMemoryProposal } from "./memory-proposal-validation.js";

export interface ArtifactService {
  getHandoffPaths(repoRoot: string, handoffDir: string): HandoffPaths;
  getMessageRoutePath(handoffDir: string, fromRole: RoleName, toRole: RoleName): string;
  ensureHandoffStructure(input: EnsureHandoffStructureInput): Promise<HandoffPaths>;
  createArtifactTemplates(input: CreateArtifactTemplatesInput): Promise<string[]>;
  listArtifacts(input: ListArtifactsInput): Promise<ArtifactSummary>;
  readArtifact(input: ReadArtifactInput): Promise<string>;
  resolveRoleCommandPath(input: ReadRoleCommandInput): Promise<string>;
  readRoleCommand(input: ReadRoleCommandInput): Promise<string>;
  saveRoleCommand(input: SaveRoleCommandInput): Promise<void>;
  submitArtifact(input: SubmitArtifactInput): Promise<ArtifactSubmissionResult>;
}

export interface EnsureHandoffStructureInput {
  repoRoot: string;
  taskSlug: string;
  handoffDir: string;
}

export interface CreateArtifactTemplatesInput extends EnsureHandoffStructureInput {
  overwrite?: boolean;
  branch?: string;
}

export interface ListArtifactsInput {
  repoRoot: string;
  handoffDir: string;
}

export interface ReadArtifactInput {
  repoRoot: string;
  artifactPath: string;
}

export interface ReadRoleCommandInput {
  repoRoot: string;
  handoffDir: string;
  role: DispatchableRole;
}

export interface SaveRoleCommandInput extends ReadRoleCommandInput {
  content: string;
}

export interface SubmitArtifactInput {
  repoRoot: string;
  baseRepoRoot: string;
  handoffDir: string;
  taskSlug: string;
  kind: string;
  mode: ArtifactSubmissionMode;
  role: RoleName;
  content: string;
  artifactPath?: string;
}

const ARTIFACT_PATH_KEYS: Array<[ArtifactKind, keyof HandoffPaths]> = [
  ["architecture-brief", "architectureBriefPath"],
  ["architecture-evidence", "architectureEvidencePath"],
  ["planning-progress", "planningProgressPath"],
  ["architecture-plan", "architecturePlanPath"],
  ["known-issues", "knownIssuesPath"],
  ["coder-completion", "coderCompletionPath"],
  ["architect-debug", "architectDebugPath"],
  ["architecture-diagnosis", "architectureDiagnosisPath"],
  ["test-report", "testReportPath"],
  ["docs-sync-report", "docsSyncReportPath"],
  ["final-acceptance", "finalAcceptancePath"]
];
const ROLE_COMMAND_PLACEHOLDER_PATTERN = /(^|\n)\s*(TBD|status:\s*draft)\s*(\n|$)/i;
const DEFAULT_MESSAGE_ROUTES: Array<[RoleName, RoleName]> = [
  ["project-manager", "architect"],
  ["project-manager", "coder"],
  ["project-manager", "tester"],
  ["architect", "project-manager"],
  ["coder", "project-manager"],
  ["tester", "project-manager"]
];

export function createArtifactService(fs: FileSystemAdapter): ArtifactService {
  return {
    getHandoffPaths(_repoRoot, handoffDir) {
      const roleCommandsDir = path.posix.join(handoffDir, "role-commands");
      const messagesDir = path.posix.join(handoffDir, "messages");

      return {
        handoffDir,
        roleCommandsDir,
        messagesDir,
        roleCommandPaths: {
          architect: path.posix.join(roleCommandsDir, "architect.md"),
          coder: path.posix.join(roleCommandsDir, "coder.md"),
          tester: path.posix.join(roleCommandsDir, "tester.md")
        },
        messageRoutePaths: getDefaultMessageRoutePaths(messagesDir),
        architectureBriefPath: path.posix.join(handoffDir, "architecture-brief.md"),
        architectureEvidencePath: path.posix.join(handoffDir, "architecture-evidence.md"),
        planningProgressPath: path.posix.join(handoffDir, "planning-progress.md"),
        architecturePlanPath: path.posix.join(handoffDir, "architecture-plan.md"),
        knownIssuesPath: path.posix.join(handoffDir, "known-issues.md"),
        coderCompletionPath: path.posix.join(handoffDir, "coder-completion.md"),
        architectDebugPath: path.posix.join(handoffDir, "architect-debug.md"),
        architectureDiagnosisPath: path.posix.join(handoffDir, "architecture-diagnosis.md"),
        testReportPath: path.posix.join(handoffDir, "test-report.md"),
        docsSyncReportPath: path.posix.join(handoffDir, "docs-sync-report.md"),
        finalAcceptancePath: path.posix.join(handoffDir, "final-acceptance.md")
      };
    },
    getMessageRoutePath(handoffDir, fromRole, toRole) {
      return path.posix.join(handoffDir, "messages", `${fromRole}-${toRole}.md`);
    },
    async ensureHandoffStructure(input) {
      const paths = this.getHandoffPaths(input.repoRoot, input.handoffDir);
      await fs.ensureDir(resolveRepoPath(input.repoRoot, paths.handoffDir));
      await fs.ensureDir(resolveRepoPath(input.repoRoot, paths.roleCommandsDir));
      await fs.ensureDir(resolveRepoPath(input.repoRoot, paths.messagesDir));
      return paths;
    },
    async createArtifactTemplates(input) {
      const paths = await this.ensureHandoffStructure(input);
      const files: Array<[string, string]> = [
        [paths.roleCommandPaths.architect, renderRoleCommandTemplate(input.taskSlug, "architect", input.repoRoot, input.branch)],
        [paths.roleCommandPaths.coder, renderRoleCommandTemplate(input.taskSlug, "coder", input.repoRoot, input.branch)],
        [paths.roleCommandPaths.tester, renderRoleCommandTemplate(input.taskSlug, "tester", input.repoRoot, input.branch)],
        [paths.architectureBriefPath, renderArchitectureBriefTemplate(input.taskSlug)],
        [paths.architectureEvidencePath, renderArchitectureEvidenceTemplate(input.taskSlug)],
        [paths.planningProgressPath, renderPlanningProgressTemplate(input.taskSlug)],
        [paths.architecturePlanPath, renderArchitecturePlanTemplate(input.taskSlug)],
        [paths.knownIssuesPath, renderKnownIssuesTemplate(input.taskSlug)],
        [paths.coderCompletionPath, renderCoderCompletionTemplate(input.taskSlug)],
        [paths.architectDebugPath, renderArchitectDebugTemplate(input.taskSlug)],
        [paths.architectureDiagnosisPath, renderArchitectureDiagnosisTemplate(input.taskSlug)],
        [paths.testReportPath, renderTestReportTemplate(input.taskSlug)],
        [paths.docsSyncReportPath, renderDocsSyncReportTemplate(input.taskSlug)],
        [paths.finalAcceptancePath, renderFinalAcceptanceTemplate(input.taskSlug)],
        ...Object.values(paths.messageRoutePaths).map((messagePath): [string, string] => [
          messagePath,
          renderMessageRouteTemplate()
        ])
      ];
      const created: string[] = [];

      for (const [artifactPath, content] of files) {
        const didCreate = await fs.ensureFile(resolveRepoPath(input.repoRoot, artifactPath), content, {
          overwrite: input.overwrite
        });
        if (didCreate) {
          created.push(artifactPath);
        }
      }

      return created;
    },
    async listArtifacts(input) {
      const paths = this.getHandoffPaths(input.repoRoot, input.handoffDir);
      const checks = [];

      for (const [kind, pathKey] of ARTIFACT_PATH_KEYS) {
        const artifactPath = paths[pathKey];
        if (typeof artifactPath !== "string") {
          continue;
        }
        const content = await readTextOrNull(fs, resolveRepoPath(input.repoRoot, artifactPath));
        checks.push(checkMarkdownArtifact(kind, artifactPath, content));
      }

      return { paths, checks };
    },
    async readArtifact(input) {
      const absolutePath = resolveRepoPath(input.repoRoot, input.artifactPath);
      if (!(await fs.pathExists(absolutePath))) {
        throw new VcmError({
          code: "ARTIFACT_MISSING",
          message: `Artifact does not exist: ${input.artifactPath}`,
          statusCode: 404
        });
      }

      return fs.readText(absolutePath);
    },
    async resolveRoleCommandPath(input) {
      const paths = this.getHandoffPaths(input.repoRoot, input.handoffDir);

      if (!DISPATCHABLE_ROLES.includes(input.role)) {
        throw new VcmError({
          code: "ROLE_NOT_DISPATCHABLE",
          message: `${input.role} cannot receive role commands.`,
          statusCode: 400
        });
      }

      const commandPath = paths.roleCommandPaths[input.role];
      if (await fs.pathExists(resolveRepoPath(input.repoRoot, commandPath))) {
        return commandPath;
      }

      const legacyCommandPath = getLegacyRoleCommandPath(paths.roleCommandsDir, input.role);
      if (await fs.pathExists(resolveRepoPath(input.repoRoot, legacyCommandPath))) {
        return legacyCommandPath;
      }

      return commandPath;
    },
    async readRoleCommand(input) {
      const paths = this.getHandoffPaths(input.repoRoot, input.handoffDir);
      const primaryCommandPath = paths.roleCommandPaths[input.role];
      const commandPath = await this.resolveRoleCommandPath(input);
      const absolutePath = resolveRepoPath(input.repoRoot, commandPath);

      if (!(await fs.pathExists(absolutePath))) {
        throw new VcmError({
          code: "ROLE_COMMAND_MISSING",
          message: `Missing role command: ${commandPath}`,
          statusCode: 404,
          hint: "Ask project-manager to produce the role command first."
        });
      }

      const content = await fs.readText(absolutePath);
      if (!content.trim()) {
        throw new VcmError({
          code: "ROLE_COMMAND_EMPTY",
          message: `Role command is empty: ${commandPath}`,
          statusCode: 400,
          hint: `Ask project-manager to write the real instruction in ${primaryCommandPath}. Keep all files under ${input.handoffDir}.`
        });
      }
      if (ROLE_COMMAND_PLACEHOLDER_PATTERN.test(content)) {
        throw new VcmError({
          code: "ROLE_COMMAND_NOT_READY",
          message: `Role command is not ready: ${commandPath}`,
          statusCode: 409,
          hint: `Ask project-manager to write the real instruction in ${primaryCommandPath}. Keep all files under ${input.handoffDir}.`
        });
      }
      return content;
    },
    async saveRoleCommand(input) {
      const paths = this.getHandoffPaths(input.repoRoot, input.handoffDir);
      await fs.writeText(resolveRepoPath(input.repoRoot, paths.roleCommandPaths[input.role]), input.content);
    },
    async submitArtifact(input) {
      const normalized = normalizeSubmissionContent(input.content);
      if (!normalized.trim()) {
        throw artifactRejected(input.kind, ["Artifact content is empty."]);
      }

      if (isArtifactKind(input.kind)) {
        const definition = getArtifactDefinition(input.kind);
        if (definition.owner !== input.role) {
          throw new VcmError({
            code: "ARTIFACT_OWNER_MISMATCH",
            message: `${input.kind} is owned by ${definition.owner}, not ${input.role}.`,
            statusCode: 403
          });
        }
        const artifactPath = path.posix.join(input.handoffDir, definition.fileName);
        const check = checkMarkdownArtifact(input.kind, artifactPath, normalized, { mode: input.mode });
        const errors = artifactCheckErrors(check, input.mode);
        if (errors.length > 0) {
          throw artifactRejected(input.kind, errors);
        }
        await writeAtomic(fs, resolveRepoPath(input.repoRoot, artifactPath), normalized);
        return {
          ok: true,
          kind: input.kind,
          mode: input.mode,
          path: artifactPath,
          status: check.status
        };
      }

      const dynamic = await validateDynamicArtifact(fs, input, normalized);
      await writeAtomic(fs, resolveRepoPath(dynamic.root, dynamic.path), normalized);
      return {
        ok: true,
        kind: dynamic.kind,
        mode: input.mode,
        path: dynamic.path,
        status: "accepted"
      };
    }
  };
}

function artifactCheckErrors(check: ArtifactCheckResult, mode: ArtifactSubmissionMode): string[] {
  const errors = [
    ...check.missingHeadings.map((heading) => `Missing required heading: ${heading}.`),
    ...check.invalidFields
  ];
  if (mode === "final" && check.hasPlaceholder) {
    errors.push("Final artifacts must not contain TBD, draft, or not-run placeholders.");
  }
  return errors;
}

function artifactRejected(kind: string, errors: string[]): VcmError {
  return new VcmError({
    code: "ARTIFACT_VALIDATION_FAILED",
    message: `${kind} was not written because validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    statusCode: 422,
    hint: "Correct the candidate and submit it again with .ai/tools/vcm-artifact."
  });
}

async function validateDynamicArtifact(
  fs: FileSystemAdapter,
  input: SubmitArtifactInput,
  content: string
): Promise<{ kind: "route-message" | "coder-worker-report" | "gate-review-report" | "memory-proposal" | "harness-feedback" | "retrospective-report"; root: string; path: string }> {
  if (input.mode !== "final") {
    throw artifactRejected(input.kind, ["Dynamic artifacts must be submitted in final mode."]);
  }
  const artifactPath = normalizeRelativeArtifactPath(input.artifactPath);
  if (input.kind === "route-message") {
    const route = DEFAULT_MESSAGE_ROUTES.find(([fromRole, toRole]) =>
      artifactPath === path.posix.join(input.handoffDir, "messages", `${fromRole}-${toRole}.md`)
    );
    if (!route || route[0] !== input.role) {
      throw artifactRejected(input.kind, ["Route-message path must name the submitting role as the sender."]);
    }
    validateRouteMessage(content, input.role);
    return { kind: input.kind, root: input.repoRoot, path: artifactPath };
  }
  if (input.kind === "coder-worker-report") {
    if (input.role !== "coder" || !/^\.ai\/vcm\/coder-workers\/reports\/[A-Za-z0-9._-]+\.md$/.test(artifactPath)) {
      throw artifactRejected(input.kind, ["Coder Worker reports must use the assigned .ai/vcm/coder-workers/reports/<worker-id>.md path."]);
    }
    validateCoderWorkerReport(content);
    return { kind: input.kind, root: input.repoRoot, path: artifactPath };
  }
  if (input.kind === "gate-review-report") {
    if (input.role !== "reviewer" || !/^\.ai\/vcm\/gate-reviews\/requests\/[A-Za-z0-9._-]+\.report\.md$/.test(artifactPath)) {
      throw artifactRejected(input.kind, ["Reviewer must submit the assigned request report path."]);
    }
    await validateGateReviewReport(fs, input.repoRoot, artifactPath, content);
    return { kind: input.kind, root: input.repoRoot, path: artifactPath };
  }
  if (input.kind === "memory-proposal") {
    if (!VCM_ROLE_NAMES.includes(input.role as typeof VCM_ROLE_NAMES[number])) {
      throw artifactRejected(input.kind, ["Only a VCM workflow role may submit a Memory Proposal."]);
    }
    if (!/^\.ai\/vcm\/memory-review\/(?:runs\/[A-Za-z0-9._-]+\/drafts|candidates)\/[A-Za-z0-9._-]+\.md$/.test(artifactPath)) {
      throw artifactRejected(input.kind, ["Memory proposal path is outside the VCM memory-review draft locations."]);
    }
    const memoryError = validateMemoryProposal(content);
    if (memoryError) {
      throw artifactRejected(input.kind, [`Memory proposal ${memoryError}.`]);
    }
    return { kind: input.kind, root: input.repoRoot, path: artifactPath };
  }
  if (input.kind === "harness-feedback") {
    if (!VCM_ROLE_NAMES.includes(input.role as typeof VCM_ROLE_NAMES[number])) {
      throw artifactRejected(input.kind, ["Only a VCM workflow role may submit Harness Feedback."]);
    }
    if (!/^\.ai\/vcm\/harness-feedback\/pending\/[A-Za-z0-9._-]+\.md$/.test(artifactPath)) {
      throw artifactRejected(input.kind, ["Harness Feedback path must be under .ai/vcm/harness-feedback/pending/. "]);
    }
    validateHarnessFeedback(content);
    return { kind: input.kind, root: input.baseRepoRoot, path: artifactPath };
  }
  if (input.kind === "retrospective-report") {
    if (input.role !== "harness-engineer") {
      throw artifactRejected(input.kind, ["Only Harness Engineer may submit a retrospective report."]);
    }
    if (!/^\.ai\/vcm\/harness-feedback\/task-retrospectives\/[A-Za-z0-9._-]+\.md$/.test(artifactPath)) {
      throw artifactRejected(input.kind, ["Retrospective report path must be under .ai/vcm/harness-feedback/task-retrospectives/."]);
    }
    validateRetrospectiveReport(content);
    return { kind: input.kind, root: input.baseRepoRoot, path: artifactPath };
  }
  throw new VcmError({
    code: "ARTIFACT_KIND_INVALID",
    message: `Unknown managed artifact kind: ${input.kind}`,
    statusCode: 400
  });
}

function validateRetrospectiveReport(content: string): void {
  const errors = getRetrospectiveReportErrors(content);
  if (errors.length > 0) throw artifactRejected("retrospective-report", errors);
}

export function getRetrospectiveReportErrors(content: string): string[] {
  const errors: string[] = [];
  if (!/^# Task Harness Retrospective(?::\s*.+)?\s*$/m.test(content)) {
    errors.push("Retrospective report requires '# Task Harness Retrospective: <task>'.");
  }
  for (const heading of ["Findings", "Feedback Dispositions", "Recommended Harness Changes", "VCM Issue Drafts"]) {
    if (!new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "m").test(content)) {
      errors.push(`Missing required section: ${heading}.`);
    }
  }
  return errors;
}

function validateCoderWorkerReport(content: string): void {
  const errors: string[] = [];
  if (!/^# Coder Worker Report:\s*\S.+$/m.test(content)) {
    errors.push("Coder Worker report requires '# Coder Worker Report: <worker-id>'.");
  }
  if (!/^Worker State:\s*completed\s*$/m.test(content)) {
    errors.push("Worker State must be completed.");
  }
  if (!/^Implementation Result:\s*(success|has_failed_items)\s*$/m.test(content)) {
    errors.push("Implementation Result must be success|has_failed_items.");
  }
  for (const heading of [
    "Assigned Scope", "Item Dispositions", "Files Changed", "Tests Added Or Updated",
    "L0/L1 Checks", "Commit", "Skipped Assigned Checks", "Objective Failures"
  ]) {
    if (!new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "m").test(content)) {
      errors.push(`Missing required section: ${heading}.`);
    }
  }
  if (errors.length > 0) throw artifactRejected("coder-worker-report", errors);
}

function validateRouteMessage(content: string, role: RoleName): void {
  const type = /^type:\s*(\S+)\s*$/m.exec(content)?.[1];
  const allowed = new Set(["task", "question", "revise", "cancel", "result", "blocked", "finding"]);
  if (!type || !allowed.has(type)) {
    throw artifactRejected("route-message", ["Frontmatter type must be one of task|question|revise|cancel|result|blocked|finding."]);
  }
  if (!content.startsWith("---\n") || !/\n---\n/.test(content) || !content.split(/\n---\n/, 2)[1]?.trim()) {
    throw artifactRejected("route-message", ["Route message requires frontmatter and a non-empty body."]);
  }
  if (role === "project-manager") {
    for (const field of ["workflow_flow", "workflow_step", "workflow_status"]) {
      if (!new RegExp(`^${field}:\\s*\\S+\\s*$`, "m").test(content)) {
        throw artifactRejected("route-message", [`PM route message is missing ${field}.`]);
      }
    }
  }
}

async function validateGateReviewReport(
  fs: FileSystemAdapter,
  repoRoot: string,
  artifactPath: string,
  content: string
): Promise<void> {
  const requestId = path.posix.basename(artifactPath, ".report.md");
  const requestPath = path.posix.join(".ai/vcm/gate-reviews/requests", `${requestId}.json`);
  const absoluteRequestPath = resolveRepoPath(repoRoot, requestPath);
  if (!(await fs.pathExists(absoluteRequestPath))) {
    throw artifactRejected("gate-review-report", [`Gate request does not exist: ${requestPath}.`]);
  }
  const request = await fs.readJson<{ requestId?: string; gate?: string; reportPath?: string }>(absoluteRequestPath);
  const fields = Object.fromEntries(
    ["Gate", "Request", "Decision", "Summary"].map((field) => [
      field,
      new RegExp(`^${field}:\\s*(.+?)\\s*$`, "mi").exec(content)?.[1]?.trim()
    ])
  );
  const errors: string[] = [];
  if (fields.Gate !== request.gate) errors.push(`Gate must be ${request.gate ?? "the requested gate"}.`);
  if (fields.Request !== request.requestId) errors.push(`Request must be ${request.requestId ?? requestId}.`);
  if (fields.Decision !== "approve" && fields.Decision !== "request_changes") errors.push("Decision must be approve|request_changes.");
  if (!fields.Summary) errors.push("Summary is required.");
  const requiredSection = request.gate === "architecture-plan"
    ? "Architecture Analysis"
    : request.gate === "validation-adequacy"
      ? "Validation Analysis"
      : "Code Diff Analysis";
  if (!new RegExp(`^## ${escapeRegExp(requiredSection)}\\s*$`, "m").test(content)) {
    errors.push(`Missing required section: ${requiredSection}.`);
  }
  if (!/^## Findings\s*$/m.test(content)) errors.push("Missing required section: Findings.");
  if (errors.length > 0) throw artifactRejected("gate-review-report", errors);
}

function validateHarnessFeedback(content: string): void {
  const errors: string[] = [];
  if (!/^#\s+\S.+$/m.test(content)) errors.push("Harness Feedback requires a title.");
  for (const field of [
    "Reporter role", "Task slug", "Summary", "Observed problem", "Expected behavior",
    "Evidence", "Suspected harness area", "Impact", "Urgency"
  ]) {
    if (!new RegExp(`^- ${escapeRegExp(field)}:\\s*\\S`, "m").test(content)) {
      errors.push(`Harness Feedback is missing ${field}.`);
    }
  }
  if (!/^- Urgency:\s*(low|medium|high)\s*$/m.test(content)) {
    errors.push("Urgency must be low|medium|high.");
  }
  if (errors.length > 0) throw artifactRejected("harness-feedback", errors);
}

function normalizeRelativeArtifactPath(value: string | undefined): string {
  const normalized = value?.replaceAll("\\", "/").replace(/^\.\//, "").trim();
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw artifactRejected("dynamic artifact", ["A safe repository-relative --path is required."]);
  }
  return normalized;
}

function normalizeSubmissionContent(content: string): string {
  return `${content.replace(/\r\n/g, "\n").trimEnd()}\n`;
}

async function writeAtomic(fs: FileSystemAdapter, absolutePath: string, content: string): Promise<void> {
  if (fs.writeTextAtomic) {
    await fs.writeTextAtomic(absolutePath, content);
    return;
  }
  await fs.writeText(absolutePath, content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getLegacyRoleCommandPath(roleCommandsDir: string, role: DispatchableRole): string {
  return path.posix.join(roleCommandsDir, `${role}-command.md`);
}

function getDefaultMessageRoutePaths(messagesDir: string): Record<string, string> {
  return Object.fromEntries(
    DEFAULT_MESSAGE_ROUTES.map(([fromRole, toRole]) => [
      `${fromRole}-${toRole}`,
      path.posix.join(messagesDir, `${fromRole}-${toRole}.md`)
    ])
  );
}

async function readTextOrNull(fs: FileSystemAdapter, absolutePath: string): Promise<string | null> {
  if (!(await fs.pathExists(absolutePath))) {
    return null;
  }

  return fs.readText(absolutePath);
}
