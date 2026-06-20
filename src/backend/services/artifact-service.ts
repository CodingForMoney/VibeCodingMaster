import path from "node:path";
import { DISPATCHABLE_ROLES, ROLE_NAMES } from "../../shared/constants.js";
import type {
  ArtifactKind,
  ArtifactSummary,
  HandoffPaths
} from "../../shared/types/artifact.js";
import type { DispatchableRole, RoleName } from "../../shared/types/role.js";
import { checkMarkdownArtifact } from "../../shared/validation/artifact-check.js";
import { VcmError } from "../errors.js";
import {
  resolveRepoPath,
  type FileSystemAdapter
} from "../adapters/filesystem.js";
import {
  renderArchitecturePlanTemplate,
  renderDocsSyncReportTemplate,
  renderFinalAcceptanceTemplate,
  renderKnownIssuesTemplate,
  renderMessageRouteTemplate,
  renderReviewReportTemplate
} from "../templates/handoff.js";
import { renderRoleCommandTemplate } from "../templates/role-command.js";

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
  appendRoleLog(input: AppendRoleLogInput): Promise<void>;
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

export interface AppendRoleLogInput {
  repoRoot: string;
  handoffDir: string;
  role: RoleName;
  content: string;
}

const ARTIFACT_PATH_KEYS: Array<[ArtifactKind, keyof HandoffPaths]> = [
  ["architecture-plan", "architecturePlanPath"],
  ["known-issues", "knownIssuesPath"],
  ["review-report", "reviewReportPath"],
  ["docs-sync-report", "docsSyncReportPath"],
  ["final-acceptance", "finalAcceptancePath"]
];
const ROLE_COMMAND_PLACEHOLDER_PATTERN = /(^|\n)\s*(TBD|status:\s*draft)\s*(\n|$)/i;
const DEFAULT_MESSAGE_ROUTES: Array<[RoleName, RoleName]> = [
  ["project-manager", "architect"],
  ["project-manager", "coder"],
  ["project-manager", "reviewer"],
  ["architect", "project-manager"],
  ["coder", "project-manager"],
  ["reviewer", "project-manager"]
];

export function createArtifactService(fs: FileSystemAdapter): ArtifactService {
  return {
    getHandoffPaths(_repoRoot, handoffDir) {
      const roleCommandsDir = path.posix.join(handoffDir, "role-commands");
      const logsDir = path.posix.join(handoffDir, "logs");
      const messagesDir = path.posix.join(handoffDir, "messages");

      return {
        handoffDir,
        roleCommandsDir,
        logsDir,
        messagesDir,
        roleCommandPaths: {
          architect: path.posix.join(roleCommandsDir, "architect.md"),
          coder: path.posix.join(roleCommandsDir, "coder.md"),
          reviewer: path.posix.join(roleCommandsDir, "reviewer.md")
        },
        roleLogPaths: {
          "project-manager": path.posix.join(logsDir, "project-manager.log"),
          architect: path.posix.join(logsDir, "architect.log"),
          coder: path.posix.join(logsDir, "coder.log"),
          reviewer: path.posix.join(logsDir, "reviewer.log"),
          "codex-reviewer": path.posix.join(logsDir, "codex-reviewer.log")
        },
        messageRoutePaths: getDefaultMessageRoutePaths(messagesDir),
        architecturePlanPath: path.posix.join(handoffDir, "architecture-plan.md"),
        knownIssuesPath: path.posix.join(handoffDir, "known-issues.md"),
        reviewReportPath: path.posix.join(handoffDir, "review-report.md"),
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
      await fs.ensureDir(resolveRepoPath(input.repoRoot, paths.logsDir));
      await fs.ensureDir(resolveRepoPath(input.repoRoot, paths.messagesDir));
      return paths;
    },
    async createArtifactTemplates(input) {
      const paths = await this.ensureHandoffStructure(input);
      const files: Array<[string, string]> = [
        [paths.roleCommandPaths.architect, renderRoleCommandTemplate(input.taskSlug, "architect", input.repoRoot, input.branch)],
        [paths.roleCommandPaths.coder, renderRoleCommandTemplate(input.taskSlug, "coder", input.repoRoot, input.branch)],
        [paths.roleCommandPaths.reviewer, renderRoleCommandTemplate(input.taskSlug, "reviewer", input.repoRoot, input.branch)],
        [paths.architecturePlanPath, renderArchitecturePlanTemplate(input.taskSlug)],
        [paths.knownIssuesPath, renderKnownIssuesTemplate(input.taskSlug)],
        [paths.reviewReportPath, renderReviewReportTemplate(input.taskSlug)],
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
    async appendRoleLog(input) {
      if (!ROLE_NAMES.includes(input.role)) {
        throw new VcmError({
          code: "UNKNOWN_ROLE",
          message: `Unknown role: ${input.role}`,
          statusCode: 400
        });
      }

      const paths = this.getHandoffPaths(input.repoRoot, input.handoffDir);
      const roleLogPath = paths.roleLogPaths[input.role];
      if (!roleLogPath) {
        throw new VcmError({
          code: "ROLE_LOG_UNAVAILABLE",
          message: `${input.role} does not write a handoff log.`,
          statusCode: 409
        });
      }
      await fs.appendText(resolveRepoPath(input.repoRoot, roleLogPath), input.content);
    }
  };
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
