import { describe, expect, it } from "vitest";
import type { FileSystemAdapter } from "../../../src/backend/adapters/filesystem.js";
import type { CreateTerminalSessionInput, TerminalRuntime, TerminalSession } from "../../../src/backend/runtime/terminal-runtime.js";
import {
  classifyRepositoryDiffPath,
  createHarnessService,
  parseGitStatusPorcelainV1
} from "../../../src/backend/services/harness-service.js";
import { renderLegacyProjectCodingStandardsTemplate } from "../../../src/backend/templates/harness/project-coding-standards.js";
import type { RoleSessionRecord, StartRoleSessionRequest } from "../../../src/shared/types/session.js";

describe("createHarnessService", () => {
  it("plans and applies recommended harness files when they are missing", async () => {
    const fs = createMemoryFs();
    const service = createHarnessService({ fs });
    const expectedHarnessFileCount = 24;

    const status = await service.getHarnessStatus("/repo");
    expect(status.needsApply).toBe(true);
    // B1: a fresh repo with every harness file missing is not yet initialized.
    expect(status.initialized).toBe(false);
    expect(status.plannedChanges).toHaveLength(expectedHarnessFileCount);
    expect(status.plannedChanges.map((change) => change.action)).toEqual(Array(expectedHarnessFileCount).fill("create"));

    const result = await service.applyHarness("/repo");
    expect(result.changedFiles).toHaveLength(expectedHarnessFileCount);

    const nextStatus = await service.getHarnessStatus("/repo");
    expect(nextStatus.needsApply).toBe(false);
    // B2: once the harness is applied, VCM markers exist -> initialized.
    expect(nextStatus.initialized).toBe(true);
    expect(nextStatus.files.map((file) => file.action)).toEqual(Array(expectedHarnessFileCount).fill("ok"));
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("## VCM Start Here");
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("## VCM Harness Scope");
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("## VCM Task Flow");
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("All standard workflow routes among project-manager, architect, coder, and tester are PM-hub routes");
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("Gate Review and tool-role work use their dedicated VCM skills and controllers");
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("No approval can raise this ceiling");
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("Architect Debug Mode runs inside either Architect Debug Flow or Architect Debug Branch");
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("They do not run their own final acceptance");
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("Final acceptance closes only a complete code-delivery flow");
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("targeted diagnostic L3 may run in Architect Debug Mode or Architecture Diagnosis Mode");
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("A message without a VCM marker is user communication.");
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("When the user asks a question, answer only.");
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("## VCM Worktree Policy");
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("## VCM Glossary Policy");
    expect(await fs.readText("/repo/CLAUDE.md")).toContain("docs/GLOSSARY.md");
    expect(await fs.readText("/repo/docs/GLOSSARY.md")).toContain("# Glossary");
    expect(await fs.readText("/repo/docs/GLOSSARY.md")).toContain("| Abbreviation | Full Term | Meaning / Allowed Use |");
    expect(await fs.readText("/repo/docs/CODING_STANDARDS.md")).toContain("# Coding Standards");
    expect(await fs.readText("/repo/docs/CODING_STANDARDS.md")).toContain("Do not fake completion");
    expect(await fs.readText("/repo/docs/CODING_STANDARDS.md")).toContain("<!-- VCM:BEGIN version=1 -->");
    expect(await fs.readText("/repo/docs/known-issues.md")).toContain("## VCM Known Issues Policy");
    expect(await fs.readText("/repo/docs/known-issues.md")).toContain("affected modules/surfaces");
    expect(await fs.readText("/repo/.gitignore")).toContain("# VCM:BEGIN version=1");
    expect(await fs.readText("/repo/.gitignore")).toContain(".ai/vcm/");
    expect(await fs.readText("/repo/.gitignore")).toContain(".claude/worktrees/");
    expect(await fs.readText("/repo/.gitignore")).not.toContain(".vcm/");
    expect(await fs.readText("/repo/.github/pull_request_template.md")).toContain("## Validation");
    expect(await fs.readText("/repo/.github/pull_request_template.md")).toContain("Final acceptance completed for code-change flow");
    expect(await fs.readText("/repo/.claude/skills/vcm-route-message/SKILL.md")).toContain("name: vcm-route-message");
    expect(await fs.readText("/repo/.claude/skills/vcm-route-message/SKILL.md")).toContain("## Purpose");
    expect(await fs.readText("/repo/.claude/skills/vcm-route-message/SKILL.md")).toContain("This skill writes a route file");
    expect(await fs.readText("/repo/.claude/skills/vcm-route-message/SKILL.md")).toContain("VCM uses project-manager as the routing hub.");
    expect(await fs.readText("/repo/.claude/skills/vcm-route-message/SKILL.md")).toContain("Non-PM roles must not route directly to each other.");
    expect(await fs.readText("/repo/.claude/skills/vcm-route-message/SKILL.md")).toContain("After writing or updating the route file, end the current Claude Code turn immediately.");
    expect(await fs.readText("/repo/.claude/skills/vcm-final-acceptance/SKILL.md")).toContain("name: vcm-final-acceptance");
    expect(await fs.readText("/repo/.claude/skills/vcm-final-acceptance/SKILL.md")).toContain("only when project-manager is ready to close a complete VCM code-delivery flow");
    expect(await fs.readText("/repo/.claude/skills/vcm-final-acceptance/SKILL.md")).toContain("Do not use it for Docs-Only Flow, Validation-Only Flow, Communication-Only Flow, PR-Preparation Flow, analysis-only Diagnosis");
    expect(await fs.readText("/repo/.claude/skills/vcm-final-acceptance/SKILL.md")).toContain("## Scope Traceability Audit");
    expect(await fs.readText("/repo/.claude/skills/vcm-final-acceptance/SKILL.md")).toContain("Do not claim to prove that every diff hunk exactly matches the task.");
    expect(await fs.readText("/repo/.claude/skills/vcm-final-acceptance/SKILL.md")).toContain(".ai/vcm/handoffs/architecture-diagnosis.md");
    expect(await fs.readText("/repo/.claude/skills/vcm-final-acceptance/SKILL.md")).toContain(".ai/vcm/handoffs/final-acceptance.md");
    expect(await fs.readText("/repo/.claude/skills/vcm-harness-bootstrap/SKILL.md")).toContain("name: vcm-harness-bootstrap");
    expect(await fs.readText("/repo/.claude/skills/vcm-harness-bootstrap/SKILL.md")).toContain("AI-assisted project understanding");
    expect(await fs.readText("/repo/.claude/skills/vcm-long-running-validation/SKILL.md")).toContain("name: vcm-long-running-validation");
    expect(await fs.readText("/repo/.claude/skills/vcm-long-running-validation/SKILL.md")).toContain("## Protocol");
    expect(await fs.readText("/repo/.claude/skills/vcm-long-running-validation/SKILL.md")).toContain(".ai/tools/watch-job");
    expect(await fs.readText("/repo/.claude/skills/vcm-gate-review/SKILL.md")).toContain("name: vcm-gate-review");
    expect(await fs.readText("/repo/.claude/skills/vcm-gate-review/SKILL.md")).toContain(".ai/tools/request-gate-review");
    expect(await fs.readText("/repo/.claude/skills/vcm-gate-review/SKILL.md")).toContain("--source <coder|architect-debug|architect-diagnosis>");
    expect(await fs.readText("/repo/.claude/skills/vcm-gate-review/SKILL.md")).toContain("before Validation-Only Flow completion");
    expect(await fs.readText("/repo/.claude/skills/vcm-architecture-interview/SKILL.md")).toContain("name: vcm-architecture-interview");
    expect(await fs.readText("/repo/.claude/skills/vcm-architecture-interview/SKILL.md")).toContain("During an active Architect Interview");
    expect(await fs.readText("/repo/.claude/skills/vcm-report-harness-issue/SKILL.md")).toContain("name: vcm-report-harness-issue");
    expect(await fs.readText("/repo/.claude/skills/vcm-report-harness-issue/SKILL.md")).toContain(".ai/vcm/harness-feedback/pending/");
    expect(await fs.readText("/repo/.claude/skills/vcm-propose-memory/SKILL.md")).toContain("name: vcm-propose-memory");
    expect(await fs.readText("/repo/.claude/skills/vcm-propose-memory/SKILL.md")).toContain("Treat `.ai/vcm/memory/**` as read-only");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("name: project-manager");
    expect(await fs.readText("/repo/.claude/agents/project-manager.md")).toContain("<!-- VCM:BEGIN version=1 -->");
    const projectManagerAgent = await fs.readText("/repo/.claude/agents/project-manager.md");
    expect(projectManagerAgent).toContain("Use the PM-hub routes allowed by the `vcm-route-message` skill");
    expect(projectManagerAgent).toContain("Use Docs-Only Flow when the accepted task changes Architect-owned project documentation");
    expect(projectManagerAgent).toContain("Use the `vcm-final-acceptance` skill only to close a complete code-delivery flow");
    expect(projectManagerAgent).toContain("PM confirms the worktree is clean, prepares or updates the PR");
    expect(projectManagerAgent).toContain("Do not perform technical analysis");
    expect(projectManagerAgent).toContain("Use the `vcm-route-message` skill for every role dispatch");
    expect(projectManagerAgent).not.toContain("### Direct User Message Handling");
    expect(projectManagerAgent).toContain("### Complex Problem Reporting");
    expect(projectManagerAgent).toContain("Plain language means translating technical detail, not deleting it.");
    expect(projectManagerAgent).toContain("Read the complete source report or handoff artifact before replying.");
    expect(projectManagerAgent).toContain("### PR-Preparation Flow");
    expect(projectManagerAgent).toContain("### Background Jobs");
    expect(projectManagerAgent).toContain("VCM_TASK_REPO_ROOT");
    expect(projectManagerAgent).toContain("Include the confirmed task repo root and branch in each role message");
    expect(projectManagerAgent).toContain("### Gate Review Gates");
    expect(projectManagerAgent).toContain("code-diff --source coder");
    expect(projectManagerAgent).toContain("code-diff --source architect-debug");
    expect(projectManagerAgent).toContain("code-diff --source architect-diagnosis");
    expect(projectManagerAgent).toContain("recorded main-flow resume point");
    expect(projectManagerAgent).toContain("Do not require a branch-level final acceptance report");
    expect(projectManagerAgent).toContain("Tester returns `Test Result: fail` for a completed Architect Debug Mode implementation");
    expect(projectManagerAgent).toContain("Architecture Diagnosis Mode must run before another Debug Mode fix or Coder dispatch");
    expect(projectManagerAgent).not.toContain("Tester reports `Test Result: fail` for the implementation for the second time");
    expect(projectManagerAgent).toContain("Architect reports that the architecture plan must be updated or replaced for the second time");
    expect(await fs.readText("/repo/.ai/tools/request-gate-review")).toContain('["git", "rev-parse", "--abbrev-ref"');
    expect(await fs.readText("/repo/.ai/tools/request-gate-review")).toContain('["git", "merge-base", "HEAD", upstream]');
    const architectAgent = await fs.readText("/repo/.claude/agents/architect.md");
    expect(architectAgent).toContain("verifiable behavior, implementation boundaries within the accepted scope, behavior/contract proof points");
    expect(architectAgent).toContain("Own `.ai/vcm/handoffs/known-issues.md` as its only writer");
    expect(architectAgent).toContain("Architect owns the technical decision");
    expect(architectAgent).toContain("running required L0/L1 plus applicable L2/L3 checks are part of the implementation duty");
    expect(architectAgent).toContain("Architecture Diagnosis Mode is an upgraded Debug Mode");
    expect(architectAgent).toContain("Do not diagnose from session memory");
    expect(architectAgent).toContain("Do not assume existing code or comments are correct");
    expect(architectAgent).toContain("Recursively follow every project-owned call until no unresolved project-owned callee remains");
    expect(architectAgent).toContain("Maintain a `Code Reading Closure`");
    expect(architectAgent).toContain("`Previous Debug Failure`");
    expect(architectAgent).toContain("commit all Diagnosis implementation changes before reporting");
    expect(architectAgent).toContain("In Docs-Only Flow, the Architect role result must record the decision");
    expect(architectAgent).toContain("`Decision` must be `synced`, `unchanged`, or `blocked`");
    const testerAgent = await fs.readText("/repo/.claude/agents/tester.md");
    expect(testerAgent).toContain("Own L2/L3/L4 final-validation design, execution, and acceptance evidence");
    expect(testerAgent).toContain("do not replace Tester final validation");
    expect(testerAgent).toContain("Apply `docs/CODING_STANDARDS.md` to changed tests");
    expect(testerAgent).not.toContain("shared implementation-quality and baseline-test standard");
    const diagnosisGateReviewerAgent = await fs.readText("/repo/.claude/agents/gate-reviewer.md");
    expect(diagnosisGateReviewerAgent).toContain("verify that the commits implement the diagnosed");
    expect(diagnosisGateReviewerAgent).toContain("local workaround for the surface failure");
    const coderAgent = await fs.readText("/repo/.claude/agents/coder.md");
    expect(coderAgent).toContain("tools: Read, Grep, Glob, Bash, Edit, Write, Agent");
    expect(coderAgent).toContain("Implement assigned file/function-level scaffold items");
    expect(coderAgent).toContain("read and follow `docs/CODING_STANDARDS.md`");
    expect(await fs.readText("/repo/docs/CODING_STANDARDS.md")).toContain("Unit test coverage is required for every changed callable unit");
    expect(coderAgent).toContain("Compile, typecheck, or L0/L1 failure is the signal to report");
    expect(coderAgent).toContain("### Failure Reporting And Continuation");
    expect(coderAgent).not.toContain("Stop before editing when the architecture plan");
    expect(coderAgent).not.toContain("Request Replan");
    expect(coderAgent).not.toContain("whether Replan is needed");
    expect(coderAgent).toContain("### Parallel Worker Implementation");
    expect(coderAgent).toContain("vcm-coder-worker");
    expect(frontmatterOf(await fs.readText("/repo/.claude/agents/project-manager.md"))).not.toContain("Agent");
    expect(frontmatterOf(await fs.readText("/repo/.claude/agents/architect.md"))).not.toContain("Agent");
    expect(frontmatterOf(await fs.readText("/repo/.claude/agents/tester.md"))).not.toContain("Agent");
    const coderWorkerAgent = await fs.readText("/repo/.claude/agents/vcm-coder-worker.md");
    expect(coderWorkerAgent).toContain("name: vcm-coder-worker");
    expect(coderWorkerAgent).toContain("model: inherit");
    expect(coderWorkerAgent).toContain("Do not set `handled: true`");
    expect(coderWorkerAgent).toContain("Implement assigned file/function-level scaffold items only");
    expect(coderWorkerAgent).toContain("Run assigned L0/L1 checks in the foreground.");
    expect(coderWorkerAgent).toContain("the switch-to-skill rule for long commands does not apply inside worker runs");
    expect(coderWorkerAgent).toContain("git commit --only -m \"<message>\" -- <assigned-paths>");
    expect(coderWorkerAgent).toContain("write the assigned report with the commit hash");
    expect(coderWorkerAgent).toContain("with the same `commitHash` as the final step");
    expect(coderWorkerAgent).not.toContain("Stop before editing if the assigned module");
    const gateReviewerAgent = await fs.readText("/repo/.claude/agents/gate-reviewer.md");
    expect(gateReviewerAgent).toContain("name: gate-reviewer");
    expect(gateReviewerAgent).toContain("tools: Read, Grep, Glob, Bash, Write");
    expect(gateReviewerAgent).toContain("You are VCM `gate-reviewer`");
    expect(gateReviewerAgent).toContain("Use the task and worktree paths named there");
    const translatorAgents = await fs.readText("/repo/.claude/agents/translator.md");
    expect(translatorAgents).toContain("name: translator");
    expect(translatorAgents).toContain("You are VCM `translator`");
    expect(translatorAgents).toContain("follow the VCM chunk manifest");
    expect(translatorAgents).toContain("Do not delegate translation to another CLI, package, API, service, browser, or");
    expect(translatorAgents).toContain("write diagnostics to the assigned report path");
    const harnessEngineerAgent = await fs.readText("/repo/.claude/agents/harness-engineer.md");
    expect(harnessEngineerAgent).toContain("name: harness-engineer");
    expect(harnessEngineerAgent).toContain("You are VCM `harness-engineer`");
    expect(harnessEngineerAgent).toContain("Proposal Mode");
    expect(harnessEngineerAgent).toContain("Bootstrap Apply Mode");
    expect(harnessEngineerAgent).toContain("active task worktree named by VCM");
    expect(harnessEngineerAgent).toContain("Commit every applied harness change yourself");
    expect(harnessEngineerAgent).toContain("CodingForMoney/VibeCodingMaster");
    expect(harnessEngineerAgent).toContain("unless the harness owner gives explicit");
    expect(harnessEngineerAgent).not.toContain("Do not act as PM, Architect, Coder");
    expect(await fs.readText("/repo/.ai/tools/request-gate-review")).toContain("Request a VCM-managed Gate Review Gate");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("UserPromptSubmit");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("Stop");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("StopFailure");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("PostCompact");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("PermissionRequest");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("PreToolUse");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("vcm-bash-guard");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("/api/hooks/claude-code");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("/api/hooks/claude-code/stop");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("--retry-all-errors");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("/api/hooks/claude-code/permission-request");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain("BASH_DEFAULT_TIMEOUT_MS");
    expect(await fs.readText("/repo/.claude/settings.json")).toContain('"autoMemoryEnabled": false');
  });

  it("inserts VCM rules into an existing file without overwriting user content", async () => {
    const fs = createMemoryFs();
    await fs.writeText("/repo/CLAUDE.md", "# Existing Rules\n\nKeep this project-specific note.\n");
    const service = createHarnessService({ fs });

    const status = await service.getHarnessStatus("/repo");
    expect(status.files.find((file) => file.path === "CLAUDE.md")).toMatchObject({
      exists: true,
      hasManagedBlock: false,
      action: "insert"
    });
    // B3: a pre-existing non-VCM CLAUDE.md (insert, no managed block) is not initialized.
    expect(status.initialized).toBe(false);

    await service.applyHarness("/repo");

    const content = await fs.readText("/repo/CLAUDE.md");
    expect(content).toContain("# Existing Rules");
    expect(content).toContain("Keep this project-specific note.");
    expect(content).toContain("<!-- VCM:BEGIN version=1 -->");
    expect(content).toContain("## VCM Start Here");
  });

  it("inserts VCM ignore rules into an existing .gitignore without overwriting user patterns", async () => {
    const fs = createMemoryFs();
    await fs.writeText("/repo/.gitignore", "node_modules/\ndist/\n");
    const service = createHarnessService({ fs });

    const status = await service.getHarnessStatus("/repo");
    expect(status.files.find((file) => file.path === ".gitignore")).toMatchObject({
      exists: true,
      hasManagedBlock: false,
      action: "insert"
    });

    await service.applyHarness("/repo");

    const content = await fs.readText("/repo/.gitignore");
    expect(content).toContain("node_modules/");
    expect(content).toContain("dist/");
    expect(content).toContain("# VCM:BEGIN version=1");
    expect(content).toContain(".ai/vcm/");
    expect(content).toContain(".claude/worktrees/");
    expect(content).not.toContain("<!-- VCM:BEGIN");
  });

  it("creates the project glossary only when missing", async () => {
    const fs = createMemoryFs();
    await fs.writeText("/repo/docs/GLOSSARY.md", "# Glossary\n\n| Abbreviation | Full Term |\n| --- | --- |\n| ACME | Example Term |\n");
    const service = createHarnessService({ fs });

    await expect(service.getHarnessFileContent("/repo", "docs/GLOSSARY.md")).resolves.toMatchObject({
      path: "docs/GLOSSARY.md",
      kind: "project-glossary",
      editable: true
    });
    expect((await service.getHarnessStatus("/repo")).files.find((file) => file.path === "docs/GLOSSARY.md")).toMatchObject({
      exists: true,
      hasManagedBlock: false,
      action: "ok"
    });

    await service.applyHarness("/repo");

    await expect(fs.readText("/repo/docs/GLOSSARY.md")).resolves.toContain("ACME");
  });

  it("migrates legacy coding standards and preserves project additions", async () => {
    const fs = createMemoryFs();
    await fs.writeText(
      "/repo/docs/CODING_STANDARDS.md",
      `${renderLegacyProjectCodingStandardsTemplate()}\nProject-specific tail.\n`
    );
    const service = createHarnessService({ fs });

    await service.applyHarness("/repo");

    const content = await fs.readText("/repo/docs/CODING_STANDARDS.md");
    expect(content).toContain("<!-- VCM:BEGIN version=1 -->");
    expect(content).toContain("Project-specific tail.");
  });

  it("preserves existing known issues while installing the managed policy", async () => {
    const fs = createMemoryFs();
    await fs.writeText("/repo/docs/known-issues.md", "# Known Issues\n\n## Existing Issue\n\nKeep this issue.\n");
    const service = createHarnessService({ fs });

    await service.applyHarness("/repo");

    const content = await fs.readText("/repo/docs/known-issues.md");
    expect(content).toContain("<!-- VCM:BEGIN version=1 -->");
    expect(content).toContain("## VCM Known Issues Policy");
    expect(content).toContain("## Existing Issue");
    expect(content).toContain("Keep this issue.");
  });

  it("plans and removes obsolete Codex harness paths", async () => {
    const fs = createMemoryFs();
    await fs.writeText("/repo/.ai/codex/AGENTS.md", "# old codex tester\n");
    await fs.writeText("/repo/.ai/codex-translator/AGENTS.md", "# old codex translator\n");
    await fs.writeText("/repo/.claude/skills/vcm-codex-review-gate/SKILL.md", "# old skill\n");
    await fs.writeText("/repo/.ai/tools/request-codex-review", "#!/usr/bin/env python3\n");
    const service = createHarnessService({ fs });

    const status = await service.getHarnessStatus("/repo");
    expect(status.plannedChanges.filter((change) => change.action === "delete").map((change) => change.path)).toEqual([
      ".ai/codex",
      ".ai/codex-translator",
      ".claude/skills/vcm-codex-review-gate",
      ".ai/tools/request-codex-review"
    ]);

    const result = await service.applyHarness("/repo");
    expect(result.changedFiles.filter((change) => change.action === "delete").map((change) => change.path)).toEqual([
      ".ai/codex",
      ".ai/codex-translator",
      ".claude/skills/vcm-codex-review-gate",
      ".ai/tools/request-codex-review"
    ]);
    await expect(fs.pathExists("/repo/.ai/codex/AGENTS.md")).resolves.toBe(false);
    await expect(fs.pathExists("/repo/.ai/codex-translator/AGENTS.md")).resolves.toBe(false);
    await expect(fs.pathExists("/repo/.claude/skills/vcm-codex-review-gate/SKILL.md")).resolves.toBe(false);
    await expect(fs.pathExists("/repo/.ai/tools/request-codex-review")).resolves.toBe(false);
  });

  it("replaces old VCM hook commands with direct HTTP hooks", async () => {
    const fs = createMemoryFs();
    await fs.writeText("/repo/.claude/settings.json", JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{
              type: "command",
              command: "vcmctl hook-event",
              timeout: 5
            }]
          }
        ],
        Stop: [
          {
            hooks: [{
              type: "command",
              command: "vcmctl hook-event",
              timeout: 5
            }]
          }
        ],
        PreToolUse: [
          {
            hooks: [{
              type: "command",
              command: "echo keep-user-hook"
            }]
          }
        ]
      }
    }, null, 2));
    const service = createHarnessService({ fs });

    // B4: a pre-existing .claude/settings.json without VCM markers is not initialized.
    const status = await service.getHarnessStatus("/repo");
    expect(status.initialized).toBe(false);

    await service.applyHarness("/repo");

    const settings = JSON.parse(await fs.readText("/repo/.claude/settings.json"));
    expect(JSON.stringify(settings.hooks.UserPromptSubmit)).toContain("/api/hooks/claude-code");
    expect(JSON.stringify(settings.hooks.Stop)).toContain("/api/hooks/claude-code");
    expect(JSON.stringify(settings.hooks.StopFailure)).toContain("/api/hooks/claude-code");
    expect(JSON.stringify(settings.hooks.PostCompact)).toContain("/api/hooks/claude-code");
    expect(JSON.stringify(settings.hooks.PermissionRequest)).toContain("/api/hooks/claude-code/permission-request");
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain("git rev-parse --show-toplevel");
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain("[ -n \\\"$guard\\\" ] || exit 0");
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain("python3 \\\"$guard\\\" || exit 0");
    expect(JSON.stringify(settings.hooks.PreToolUse)).not.toContain("${CLAUDE_PROJECT_DIR:-.}/.ai/tools/vcm-bash-guard");
    expect(JSON.stringify(settings.hooks.UserPromptSubmit)).not.toContain("vcmctl");
    expect(JSON.stringify(settings.hooks.Stop)).not.toContain("vcmctl");
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain("echo keep-user-hook");
    expect(settings.autoMemoryEnabled).toBe(false);
  });

  it("updates only the managed block when VCM rules drift", async () => {
    const fs = createMemoryFs();
    await fs.writeText("/repo/CLAUDE.md", [
      "# Existing Rules",
      "",
      "Before block.",
      "",
      "<!-- VCM:BEGIN version=0 -->",
      "old managed rules",
      "<!-- VCM:END -->",
      "",
      "After block.",
      ""
    ].join("\n"));
    const service = createHarnessService({ fs });

    const status = await service.getHarnessStatus("/repo");
    expect(status.files.find((file) => file.path === "CLAUDE.md")).toMatchObject({
      exists: true,
      hasManagedBlock: true,
      managedVersion: 0,
      action: "update"
    });
    // B5: a drifted managed block is still a VCM marker -> initialized with pending updates.
    expect(status.initialized).toBe(true);
    expect(status.needsApply).toBe(true);

    await service.applyHarness("/repo");

    const content = await fs.readText("/repo/CLAUDE.md");
    expect(content).toContain("Before block.");
    expect(content).toContain("After block.");
    expect(content).not.toContain("old managed rules");
    expect(content).toContain("<!-- VCM:BEGIN version=1 -->");
    expect(content).toContain("## VCM Start Here");
  });

  it("ignores fixed harness manifest version-only drift", async () => {
    const fs = createMemoryFs();
    await createHarnessService({ fs }).applyHarness("/repo");
    await fs.writeJson("/repo/.ai/vcm-harness-manifest.json", {
      schemaVersion: 1,
      manager: "vcm",
      harnessVersion: "0.3.0-fixed"
    });
    const service = createHarnessService({
      fs,
      vcmVersion: "0.4.21",
      runFixedInstaller: async () => ({
        version: 1,
        changedFiles: [],
        message: "ok"
      })
    });

    const status = await service.getHarnessStatus("/repo");

    expect(status.needsApply).toBe(false);
    expect(status.plannedChanges).not.toContainEqual(expect.objectContaining({
      path: ".ai/vcm-harness-manifest.json"
    }));
  });

  it("keeps bootstrap available when only the fixed harness manifest version is stale", async () => {
    const fs = createMemoryFs();
    await createHarnessService({ fs }).applyHarness("/repo");
    await fs.writeJson("/repo/.ai/vcm-harness-manifest.json", {
      schemaVersion: 1,
      manager: "vcm",
      harnessVersion: "0.3.0-fixed"
    });
    await fs.writeText("/repo/.ai/tools/generate-module-index", "#!/usr/bin/env python3\n");
    await fs.writeText("/repo/.ai/tools/generate-public-surface", "#!/usr/bin/env python3\n");
    const service = createHarnessService({
      fs,
      vcmVersion: "0.4.21",
      runFixedInstaller: async () => ({
        version: 1,
        changedFiles: [],
        message: "ok"
      })
    });

    const status = await service.getBootstrapStatus("/repo");

    expect(status.status).not.toBe("not_ready");
    expect(status.canStart).toBe(true);
    expect(status.checks[0]).toMatchObject({
      key: "fixed-harness",
      status: "ok"
    });
  });

  it("lets Harness Studio edit project-owned content outside managed blocks", async () => {
    const fs = createMemoryFs();
    const service = createHarnessService({ fs });
    await service.applyHarness("/repo");
    expect((await service.getHarnessStatus("/repo")).harnessRevision).toBe(1);

    const file = await service.getHarnessFileContent("/repo", "CLAUDE.md");
    expect(file.editable).toBe(true);

    const result = await service.updateHarnessFileContent(
      "/repo",
      "CLAUDE.md",
      `# Project Harness Notes\n\nKeep generated code small.\n\n${file.content}`
    );

    expect(result.file.content).toContain("Keep generated code small.");
    expect(result.status.harnessRevision).toBe(2);
    expect(result.status.needsApply).toBe(false);
    await expect(fs.readText("/repo/CLAUDE.md")).resolves.toContain("Keep generated code small.");
  });

  it("protects VCM-owned harness content from Harness Studio edits", async () => {
    const fs = createMemoryFs();
    const service = createHarnessService({ fs });
    await service.applyHarness("/repo");

    const claudeFile = await service.getHarnessFileContent("/repo", "CLAUDE.md");
    await expect(service.updateHarnessFileContent(
      "/repo",
      "CLAUDE.md",
      claudeFile.content.replace("## VCM Start Here", "## Changed")
    )).rejects.toMatchObject({
      code: "HARNESS_MANAGED_BLOCK_PROTECTED"
    });

    for (const [filePath, managedText] of [
      ["docs/CODING_STANDARDS.md", "## Implementation Discipline"],
      ["docs/known-issues.md", "## VCM Known Issues Policy"]
    ] as const) {
      const file = await service.getHarnessFileContent("/repo", filePath);
      await expect(service.updateHarnessFileContent(
        "/repo",
        filePath,
        file.content.replace(managedText, "## Changed")
      )).rejects.toMatchObject({
        code: "HARNESS_MANAGED_BLOCK_PROTECTED"
      });
    }

    const skillFile = await service.getHarnessFileContent("/repo", ".claude/skills/vcm-route-message/SKILL.md");
    expect(skillFile.editable).toBe(false);
    await expect(service.updateHarnessFileContent(
      "/repo",
      ".claude/skills/vcm-route-message/SKILL.md",
      `${skillFile.content}\nExtra line.\n`
    )).rejects.toMatchObject({
      code: "HARNESS_FILE_READONLY"
    });
  });

  it("commits visible harness changes after Harness Studio edits", async () => {
    const fs = createMemoryFs();
    const calls: string[] = [];
    await createHarnessService({ fs }).applyHarness("/repo");
    const service = createHarnessService({
      fs,
      git: {
        async getStatusPorcelainV1(repoRoot) {
          calls.push(`status:${repoRoot}`);
          return calls.filter((call) => call === "status:/repo").length > 1
            ? " M CLAUDE.md\0?? .ai/vcm/harness/revision.json\0"
            : "";
        },
        async addPaths(repoRoot, paths) {
          calls.push(`add:${repoRoot}:${paths.join(",")}`);
        },
        async commit(repoRoot, message) {
          calls.push(`commit:${repoRoot}:${message}`);
          return "abc123456789";
        }
      }
    });
    const file = await service.getHarnessFileContent("/repo", "CLAUDE.md");

    const result = await service.updateHarnessFileContent("/repo", "CLAUDE.md", `# Project\n\n${file.content}`);

    expect(result.harnessCommit).toBe("abc123456789");
    expect(calls).toEqual([
      "status:/repo",
      "status:/repo",
      "add:/repo:CLAUDE.md",
      "commit:/repo:chore(vcm-harness): update harness file"
    ]);
  });

  it("refuses harness edits when the task worktree has visible changes", async () => {
    const fs = createMemoryFs();
    await createHarnessService({ fs }).applyHarness("/repo");
    const service = createHarnessService({
      fs,
      git: {
        async getStatusPorcelainV1() {
          return " M docs/TESTING.md\0?? .ai/vcm/handoffs/request.md\0";
        },
        async addPaths() {},
        async commit() {
          return "abc1234";
        }
      }
    });
    const file = await service.getHarnessFileContent("/repo", "CLAUDE.md");

    await expect(service.updateHarnessFileContent("/repo", "CLAUDE.md", `# Project\n\n${file.content}`)).rejects.toMatchObject({
      code: "HARNESS_WORKTREE_DIRTY"
    });
  });

  it("uses the project harness-engineer session for bootstrap", async () => {
    const fs = createMemoryFs();
    const runtimeInputs: CreateTerminalSessionInput[] = [];
    const writes: string[] = [];
    const runtime = createFakeRuntime(runtimeInputs, writes);
    const ensureRequests: StartRoleSessionRequest[] = [];
    const service = createHarnessService({
      fs,
      runtime,
      harnessEngineerSessions: createFakeHarnessEngineerSessions(runtime, ensureRequests)
    });
    await service.applyHarness("/repo");
    await fs.writeText("/repo/.ai/vcm-harness-manifest.json", "{}\n");
    await fs.writeText("/repo/.ai/tools/generate-module-index", "#!/usr/bin/env python3\n");
    await fs.writeText("/repo/.ai/tools/generate-public-surface", "#!/usr/bin/env python3\n");

    const started = await service.startHarnessBootstrap("/repo", "/repo", {
      permissionMode: "bypassPermissions",
      model: "opus",
      effort: "high"
    });

    expect(started.session.status).toBe("running");
    expect(started.session.permissionMode).toBe("bypassPermissions");
    expect(started.session.model).toBe("opus");
    expect(started.session.effort).toBe("high");
    expect(ensureRequests[0]).toMatchObject({
      permissionMode: "bypassPermissions",
      model: "opus",
      effort: "high"
    });
    expect(runtimeInputs[0]).toMatchObject({
      taskSlug: "__project_harness_engineer__",
      role: "harness-engineer",
      cwd: "/repo"
    });
    expect(writes).toEqual([]);

    const run = await service.runHarnessBootstrap("/repo");
    expect(run.prompt).toContain("[VCM HARNESS BOOTSTRAP]");
    expect(run.prompt).toContain("Use the vcm-harness-bootstrap skill");
    expect(run.prompt).toContain("[/VCM HARNESS BOOTSTRAP]");
    expect(writes[0]).toContain("[VCM HARNESS BOOTSTRAP]");
    expect(writes[0]).toContain("Use the vcm-harness-bootstrap skill");
    expect(writes[1]).toBe("\r");

    const runningStatus = await service.getBootstrapStatus("/repo");
    expect(runningStatus.status).toBe("running");

    await service.recordHarnessBootstrapHook("/repo", {
      eventName: "Stop",
      sessionId: started.session.id,
      claudeSessionId: started.session.claudeSessionId
    });
    const completedStatus = await service.getBootstrapStatus("/repo");
    expect(completedStatus.status).toBe("complete");
  });

  it("ignores stale legacy bootstrap terminal session records", async () => {
    const fs = createMemoryFs();
    const service = createHarnessService({ fs });
    await service.applyHarness("/repo");
    await fs.writeText("/repo/.ai/vcm-harness-manifest.json", "{}\n");
    await fs.writeText("/repo/.ai/tools/generate-module-index", "#!/usr/bin/env python3\n");
    await fs.writeText("/repo/.ai/tools/generate-public-surface", "#!/usr/bin/env python3\n");
    await fs.writeJson("/repo/.ai/vcm/bootstrap/session.json", {
      id: "legacy-bootstrap",
      claudeSessionId: "legacy-claude-session",
      status: "running",
      command: "claude --session-id legacy-claude-session",
      cwd: "/repo",
      logPath: ".ai/vcm/bootstrap/bootstrap.log",
      updatedAt: "2026-06-22T00:00:00.000Z"
    });

    const status = await service.getBootstrapStatus("/repo");

    expect(status.status).not.toBe("running");
    expect(status.session).toBeUndefined();
  });
});

describe("repository diff helpers", () => {
  it("parses porcelain v1 z status entries", () => {
    const entries = parseGitStatusPorcelainV1([
      " M CLAUDE.md",
      "?? .claude/agents/harness-engineer.md",
      "R  docs/new.md",
      "docs/old.md",
      ""
    ].join("\0"));

    expect(entries).toEqual([
      {
        path: "CLAUDE.md",
        indexStatus: " ",
        workingTreeStatus: "M"
      },
      {
        path: ".claude/agents/harness-engineer.md",
        indexStatus: "?",
        workingTreeStatus: "?"
      },
      {
        path: "docs/new.md",
        oldPath: "docs/old.md",
        indexStatus: "R",
        workingTreeStatus: " "
      }
    ]);
  });

  it("classifies harness paths separately from product code", () => {
    expect(classifyRepositoryDiffPath("CLAUDE.md")).toBe("fixed_harness");
    expect(classifyRepositoryDiffPath(".claude/skills/vcm-route-message/SKILL.md")).toBe("fixed_harness");
    expect(classifyRepositoryDiffPath(".ai/tools/generate-module-index")).toBe("tools_hooks");
    expect(classifyRepositoryDiffPath(".ai/generated/public-surface.json")).toBe("generated_context");
    expect(classifyRepositoryDiffPath("docs/TESTING.md")).toBe("project_docs");
    expect(classifyRepositoryDiffPath("src/server.ts")).toBe("product_code");
  });
});

describe("repository diff reports", () => {
  it("returns full commit diff with branch commit choices", async () => {
    const fs = createMemoryFs();
    const git = createDiffGitStub();
    const service = createHarnessService({
      fs,
      git,
      now: () => "2026-06-23T00:00:00.000Z"
    } as never);

    const report = await service.getRepositoryDiff("/repo", { baseRepoRoot: "/base" });

    expect(report.commits.map((commit) => commit.sha)).toEqual(["abc1234567890"]);
    expect(report.sourceBranch).toBe("feature/demo-task");
    expect(report.targetBranch).toBe("release/v0.4");
    expect(report.commit?.shortSha).toBe("abc123456789");
    expect(report.files.map((file) => file.path)).toEqual(["CLAUDE.md", "src/server.ts"]);
    expect(report.summary.productCodeFiles).toBe(1);
    expect(report.warnings).toEqual([]);
  });

  it("returns a single file task diff against the connected repository", async () => {
    const fs = createMemoryFs();
    const git = createDiffGitStub();
    const service = createHarnessService({
      fs,
      git,
      now: () => "2026-06-23T00:00:00.000Z"
    } as never);

    const report = await service.getRepositoryFileDiff("/repo", {
      baseRepoRoot: "/base",
      path: "CLAUDE.md"
    });

    expect(report.baseSha).toBe("base1234567890");
    expect(report.headSha).toBe("abc1234567890");
    expect(report.file?.path).toBe("CLAUDE.md");
    expect(report.file?.diff).toContain("+task new");
  });

  it("fast-forwards the connected repository current branch with the task branch", async () => {
    const fs = createMemoryFs();
    const calls: string[] = [];
    let head = "base1234567890";
    const service = createHarnessService({
      fs,
      git: {
        async getStatusPorcelainV1() {
          return "";
        },
        async branchExists(_repoRoot: string, branch: string) {
          return branch === "feature/demo-task";
        },
        async getCurrentBranch() {
          return "release/v0.4";
        },
        async mergeBranchFastForward(_repoRoot: string, branch: string) {
          calls.push(`merge:${branch}`);
          head = "abc1234567890";
          return { stdout: "Fast-forward", stderr: "" };
        },
        async getHeadCommit() {
          return head;
        },
        async addPaths() {},
        async commit() {
          throw new Error("not used");
        }
      },
      now: () => "2026-06-23T00:00:00.000Z"
    } as never);

    const result = await service.mergeRepositoryDiffToCurrentBranch("/base", {
      taskRepoRoot: "/repo",
      taskBranch: "feature/demo-task"
    });

    expect(result).toMatchObject({
      sourceBranch: "feature/demo-task",
      targetBranch: "release/v0.4",
      beforeSha: "base1234567890",
      afterSha: "abc1234567890",
      changed: true
    });
    expect(calls).toEqual(["merge:feature/demo-task"]);
  });
});

function createFakeHarnessEngineerSessions(
  runtime: TerminalRuntime,
  ensureRequests: StartRoleSessionRequest[]
) {
  let record: RoleSessionRecord | undefined;
  async function createRecord(input: StartRoleSessionRequest = {}): Promise<RoleSessionRecord> {
    ensureRequests.push(input);
    const runtimeSession = await runtime.createSession({
      taskSlug: "__project_harness_engineer__",
      role: "harness-engineer",
      command: "claude",
      args: ["--agent", "harness-engineer"],
      cwd: "/repo",
      cols: input.cols,
      rows: input.rows
    });
    record = {
      id: runtimeSession.id,
      claudeSessionId: "claude-harness-engineer",
      taskSlug: "__project_harness_engineer__",
      role: "harness-engineer",
      status: runtimeSession.status,
      activityStatus: "idle",
      command: "claude --agent harness-engineer",
      permissionMode: input.permissionMode ?? "default",
      model: input.model,
      effort: input.effort,
      cwd: "/repo",
      terminalBackend: "node-pty",
      startedAt: runtimeSession.startedAt,
      updatedAt: "2026-06-22T00:00:00.000Z",
      lastOutputAt: runtimeSession.lastOutputAt,
      exitCode: runtimeSession.exitCode
    };
    return record;
  }

  return {
    ensureProjectHarnessEngineerSession: async (_repoRoot: string, input: StartRoleSessionRequest = {}) => {
      if (record?.status === "running") {
        return record;
      }
      return createRecord(input);
    },
    restartProjectHarnessEngineerSession: async (_repoRoot: string, input: StartRoleSessionRequest = {}) => createRecord(input),
    stopProjectHarnessEngineerSession: async () => {
      if (!record) {
        throw new Error("missing harness engineer session");
      }
      await runtime.stop(record.id);
      record = {
        ...record,
        status: "exited",
        updatedAt: "2026-06-22T00:00:01.000Z",
        exitCode: 0
      };
      return record;
    },
    getProjectHarnessEngineerSession: async () => record
  };
}

function createFakeRuntime(inputs: CreateTerminalSessionInput[], writes: string[]): TerminalRuntime {
  const sessions = new Map<string, TerminalSession>();
  return {
    async createSession(input) {
      inputs.push(input);
      const session: TerminalSession = {
        id: `bootstrap_${inputs.length}`,
        taskSlug: input.taskSlug,
        role: input.role,
        status: "running",
        startedAt: "2026-06-22T00:00:00.000Z",
        exitCode: null
      };
      sessions.set(session.id, session);
      return session;
    },
    getSession(sessionId) {
      return sessions.get(sessionId);
    },
    getSessionByRole(taskSlug, role) {
      return [...sessions.values()].find((session) => session.taskSlug === taskSlug && session.role === role);
    },
    listSessions(taskSlug) {
      return [...sessions.values()].filter((session) => !taskSlug || session.taskSlug === taskSlug);
    },
    write(_sessionId, data) {
      writes.push(data);
    },
    resize() {},
    async stop(sessionId) {
      const session = sessions.get(sessionId);
      if (session) {
        sessions.set(sessionId, {
          ...session,
          status: "exited",
          exitCode: 0
        });
      }
    },
    async restart(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error("missing session");
      }
      return session;
    },
    subscribe() {
      return () => {};
    }
  };
}

function createDiffGitStub() {
  return {
    async getCurrentBranch(repoRoot: string) {
      return repoRoot === "/base" ? "release/v0.4" : "feature/demo-task";
    },
    async getHeadCommit(repoRoot: string) {
      return repoRoot === "/base" ? "base1234567890" : "abc1234567890";
    },
    async getMergeBase() {
      return "base1234567890";
    },
    async getCommitList() {
      return [{
        sha: "abc1234567890",
        subject: "chore(vcm-harness): update fixed harness",
        committedAt: "2026-06-23T00:00:00.000Z"
      }];
    },
    async getCommitInfo(_repoRoot: string, ref: string) {
      return {
        sha: ref,
        subject: "chore(vcm-harness): update fixed harness",
        committedAt: "2026-06-23T00:00:00.000Z"
      };
    },
    async getCommitDiff() {
      return [
        "diff --git a/CLAUDE.md b/CLAUDE.md",
        "--- a/CLAUDE.md",
        "+++ b/CLAUDE.md",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "diff --git a/src/server.ts b/src/server.ts",
        "--- a/src/server.ts",
        "+++ b/src/server.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        ""
      ].join("\n");
    },
    async getDiff() {
      return [
        "diff --git a/CLAUDE.md b/CLAUDE.md",
        "--- a/CLAUDE.md",
        "+++ b/CLAUDE.md",
        "@@ -1 +1 @@",
        "-base old",
        "+task new",
        ""
      ].join("\n");
    }
  };
}

function frontmatterOf(content: string): string {
  const sections = content.split("---");
  return sections.length >= 3 ? sections[1] : "";
}

function createMemoryFs(): FileSystemAdapter {
  const files = new Map<string, string>();
  return {
    async pathExists(targetPath) {
      return files.has(targetPath) || Array.from(files.keys()).some((filePath) => filePath.startsWith(`${targetPath}/`));
    },
    async ensureDir() {},
    async readDir() {
      return [];
    },
    async readText(targetPath) {
      const value = files.get(targetPath);
      if (value === undefined) {
        throw new Error(`missing ${targetPath}`);
      }
      return value;
    },
    async writeText(targetPath, content) {
      files.set(targetPath, content);
    },
    async appendText(targetPath, content) {
      files.set(targetPath, `${files.get(targetPath) ?? ""}${content}`);
    },
    async readJson(targetPath) {
      return JSON.parse(await this.readText(targetPath));
    },
    async writeJson(targetPath, value) {
      await this.writeText(targetPath, `${JSON.stringify(value, null, 2)}\n`);
    },
    async writeJsonAtomic(targetPath, value) {
      await this.writeJson(targetPath, value);
    },
    async ensureFile(targetPath, content) {
      if (files.has(targetPath)) {
        return false;
      }
      files.set(targetPath, content);
      return true;
    },
    async removePath(targetPath, options = {}) {
      files.delete(targetPath);
      if (options.recursive) {
        for (const filePath of Array.from(files.keys())) {
          if (filePath.startsWith(`${targetPath}/`)) {
            files.delete(filePath);
          }
        }
      }
    }
  };
}
