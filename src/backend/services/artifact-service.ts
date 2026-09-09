import path from "node:path";
import { DISPATCHABLE_ROLES } from "../../shared/constants.js";
import type {
  ArtifactKind,
  ManagedArtifactKind,
  ArtifactSubmissionMode,
  ArtifactSubmissionResult,
  ArtifactSummary,
  HandoffPaths
} from "../../shared/types/artifact.js";
import type { DispatchableRole, RoleName, VcmRoleName } from "../../shared/types/role.js";
import type { DurableDocAssignmentState } from "../../shared/types/memory.js";
import { checkMarkdownArtifact, readArtifactSectionValue } from "../../shared/validation/artifact-check.js";
import {
  getManagedArtifactDefinition,
  isArtifactKind,
  isManagedArtifactKind
} from "../../shared/validation/artifact-registry.js";
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
  renderDocsUpdateReportTemplate,
  renderDocsSyncReportTemplate,
  renderFinalAcceptanceTemplate,
  renderKnownIssuesTemplate,
  renderPlanningProgressTemplate,
  renderMessageRouteTemplate,
  renderTestReportTemplate,
  renderWorkflowProgressTemplate
} from "../templates/handoff.js";
import { renderRoleCommandTemplate } from "../templates/role-command.js";
import { isMemoryProposalSubmissionPath } from "./memory-review-paths.js";
import { validateManagedArtifactContent } from "./managed-artifact-validation.js";
import type { WorkflowControlService } from "./workflow-control-service.js";

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
  stateRoot?: string;
  handoffDir: string;
  taskSlug: string;
  kind: string;
  mode: ArtifactSubmissionMode;
  role: RoleName;
  content: string;
  artifactPath?: string;
}

export interface ArtifactServiceDeps {
  workflowControlService?: Pick<WorkflowControlService, "submitProgress" | "assertRouteAuthorized" | "assertDocsArtifactAllowed">;
  getDurableDocAssignment?: (taskRepoRoot: string, role: RoleName) => Promise<DurableDocAssignmentState | undefined>;
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
  ["docs-update-report", "docsUpdateReportPath"],
  ["docs-sync-report", "docsSyncReportPath"],
  ["workflow-progress", "workflowProgressPath"],
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

export function createArtifactService(fs: FileSystemAdapter, deps: ArtifactServiceDeps = {}): ArtifactService {
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
        docsUpdateReportPath: path.posix.join(handoffDir, "docs-update-report.md"),
        docsSyncReportPath: path.posix.join(handoffDir, "docs-sync-report.md"),
        workflowProgressPath: path.posix.join(handoffDir, "workflow-progress.md"),
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
        [paths.docsUpdateReportPath, renderDocsUpdateReportTemplate(input.taskSlug)],
        [paths.docsSyncReportPath, renderDocsSyncReportTemplate(input.taskSlug)],
        [paths.workflowProgressPath, renderWorkflowProgressTemplate(input.taskSlug)],
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

      if (!isManagedArtifactKind(input.kind)) {
        throw new VcmError({
          code: "ARTIFACT_KIND_INVALID",
          message: `Unknown managed artifact kind: ${input.kind}`,
          statusCode: 400
        });
      }

      const definition = getManagedArtifactDefinition(input.kind);
      const owners = Array.isArray(definition.owner) ? definition.owner : [definition.owner];
      if (!owners.includes(input.role)) {
        throw new VcmError({
          code: "ARTIFACT_OWNER_MISMATCH",
          message: `${input.kind} is owned by ${owners.join("|")}, not ${input.role}.`,
          statusCode: 403
        });
      }

      if (isArtifactKind(input.kind)) {
        const assignment = input.kind === "docs-update-report"
          ? await deps.getDurableDocAssignment?.(input.repoRoot, input.role)
          : undefined;
        if (assignment) {
          if (input.artifactPath !== assignment.reportPath) {
            throw artifactRejected(input.kind, [`Use the assigned --path ${assignment.reportPath}.`]);
          }
          if (readArtifactSectionValue(normalized, "Assignment ID")?.trim() !== assignment.id) {
            throw artifactRejected(input.kind, [`Assignment ID must be exactly ${assignment.id}.`]);
          }
        } else if (input.artifactPath?.trim()) {
          throw artifactRejected(input.kind, ["--path is not allowed for fixed artifact kinds."]);
        }
        const artifactPath = assignment?.reportPath ?? path.posix.join(input.handoffDir, definition.fileName ?? "");
        const validation = validateManagedArtifactContent(input.kind, normalized, {
          path: artifactPath,
          mode: input.mode
        });
        if (validation.errors.length > 0) {
          throw artifactRejected(input.kind, validation.errors);
        }
        if ((input.kind === "docs-update-report" || input.kind === "docs-sync-report")
          && deps.workflowControlService) {
          // Memory-owned documentation work is independent of PM's active dispatch.
          if (!assignment) {
            await deps.workflowControlService.assertDocsArtifactAllowed({
              taskRepoRoot: input.repoRoot,
              stateRoot: input.stateRoot ?? ".ai/vcm",
              handoffDir: input.handoffDir,
              taskSlug: input.taskSlug
            }, input.kind, input.role);
          }
        }
        if (input.kind === "workflow-progress") {
          if (input.mode !== "final") {
            throw artifactRejected(input.kind, ["Workflow Progress must be submitted in final mode."]);
          }
          if (!deps.workflowControlService) {
            throw new VcmError({
              code: "WORKFLOW_CONTROL_UNAVAILABLE",
              message: "Workflow Control is unavailable.",
              statusCode: 503
            });
          }
          const submitted = await deps.workflowControlService.submitProgress({
            taskRepoRoot: input.repoRoot,
            stateRoot: input.stateRoot ?? ".ai/vcm",
            handoffDir: input.handoffDir,
            taskSlug: input.taskSlug
          }, normalized);
          return {
            ok: true,
            kind: input.kind,
            mode: input.mode,
            path: submitted.path,
            status: "accepted"
          };
        }
        await writeAtomic(fs, resolveRepoPath(input.repoRoot, artifactPath), normalized);
        return {
          ok: true,
          kind: input.kind,
          mode: input.mode,
          path: artifactPath,
          status: validation.status
        };
      }

      const dynamic = await validateDynamicArtifact(fs, input, normalized, deps.workflowControlService);
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
  content: string,
  workflowControlService?: Pick<WorkflowControlService, "assertRouteAuthorized">
): Promise<{ kind: "route-message" | "coder-worker-report" | "gate-review-report" | "memory-proposal" | "harness-feedback"; root: string; path: string }> {
  const artifactPath = normalizeRelativeArtifactPath(input.artifactPath);
  if (input.kind === "route-message") {
    const route = DEFAULT_MESSAGE_ROUTES.find(([fromRole, toRole]) =>
      artifactPath === path.posix.join(input.handoffDir, "messages", `${fromRole}-${toRole}.md`)
    );
    if (!route || route[0] !== input.role) {
      throw artifactRejected(input.kind, ["Route-message path must name the submitting role as the sender."]);
    }
    assertManagedArtifactContent(input.kind, content, artifactPath, input.mode);
    if (input.role === "project-manager") {
      if (!workflowControlService) {
        throw new VcmError({
          code: "WORKFLOW_CONTROL_UNAVAILABLE",
          message: "Workflow Control is unavailable.",
          statusCode: 503
        });
      }
      await workflowControlService.assertRouteAuthorized({
        taskRepoRoot: input.repoRoot,
        stateRoot: input.stateRoot ?? ".ai/vcm",
        handoffDir: input.handoffDir,
        taskSlug: input.taskSlug,
        routePath: artifactPath,
        targetRole: route[1] as DispatchableRole
      });
    }
    return { kind: input.kind, root: input.repoRoot, path: artifactPath };
  }
  if (input.kind === "coder-worker-report") {
    if (!/^\.ai\/vcm\/coder-workers\/reports\/[A-Za-z0-9._-]+\.md$/.test(artifactPath)) {
      throw artifactRejected(input.kind, ["Coder Worker reports must use the assigned .ai/vcm/coder-workers/reports/<worker-id>.md path."]);
    }
    assertManagedArtifactContent(input.kind, content, artifactPath, input.mode);
    return { kind: input.kind, root: input.repoRoot, path: artifactPath };
  }
  if (input.kind === "gate-review-report") {
    if (!/^\.ai\/vcm\/gate-reviews\/requests\/[A-Za-z0-9._-]+\.report\.md$/.test(artifactPath)) {
      throw artifactRejected(input.kind, ["Reviewer must submit the assigned request report path."]);
    }
    const requestId = path.posix.basename(artifactPath, ".report.md");
    const requestPath = path.posix.join(".ai/vcm/gate-reviews/requests", `${requestId}.json`);
    const absoluteRequestPath = resolveRepoPath(input.repoRoot, requestPath);
    if (!(await fs.pathExists(absoluteRequestPath))) {
      throw artifactRejected(input.kind, [`Gate request does not exist: ${requestPath}.`]);
    }
    const request = await fs.readJson<{ requestId?: string; gate?: string; reportPath?: string }>(absoluteRequestPath);
    if (request.reportPath !== artifactPath) {
      throw artifactRejected(input.kind, [
        `Report path must match the assigned request path ${request.reportPath ?? "<missing>"}.`
      ]);
    }
    assertManagedArtifactContent(input.kind, content, artifactPath, input.mode, {
      expectedGate: request.gate,
      expectedRequestId: request.requestId ?? requestId
    });
    return { kind: input.kind, root: input.repoRoot, path: artifactPath };
  }
  if (input.kind === "memory-proposal") {
    if (!isMemoryProposalSubmissionPath(artifactPath, input.role as VcmRoleName)) {
      throw artifactRejected(input.kind, ["Memory proposal path is not assigned to the submitting role."]);
    }
    assertManagedArtifactContent(input.kind, content, artifactPath, input.mode);
    return { kind: input.kind, root: input.repoRoot, path: artifactPath };
  }
  if (input.kind === "harness-feedback") {
    if (!/^\.ai\/vcm\/harness-feedback\/pending\/[A-Za-z0-9._-]+\.md$/.test(artifactPath)) {
      throw artifactRejected(input.kind, ["Harness Feedback path must be under .ai/vcm/harness-feedback/pending/. "]);
    }
    assertManagedArtifactContent(input.kind, content, artifactPath, input.mode);
    return { kind: input.kind, root: input.baseRepoRoot, path: artifactPath };
  }
  throw new VcmError({
    code: "ARTIFACT_KIND_INVALID",
    message: `Unknown managed artifact kind: ${input.kind}`,
    statusCode: 400
  });
}

function assertManagedArtifactContent(
  kind: ManagedArtifactKind,
  content: string,
  artifactPath: string,
  mode: ArtifactSubmissionMode,
  expected: { expectedGate?: string; expectedRequestId?: string } = {}
): void {
  const validation = validateManagedArtifactContent(kind, content, {
    path: artifactPath,
    mode,
    expectedGate: expected.expectedGate as Parameters<typeof validateManagedArtifactContent>[2]["expectedGate"],
    expectedRequestId: expected.expectedRequestId
  });
  if (validation.errors.length > 0) {
    throw artifactRejected(kind, validation.errors);
  }
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
