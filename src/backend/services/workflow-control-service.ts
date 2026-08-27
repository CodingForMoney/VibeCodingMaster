import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import { resolveRepoPath } from "../adapters/filesystem.js";
import { VcmError } from "../errors.js";
import type { DispatchableRole } from "../../shared/types/role.js";
import type { GateReviewGateRecord, GateReviewIndex } from "../../shared/types/gate-review.js";
import type {
  WorkflowControlState,
  WorkflowDispatchEvidenceBaseline,
  WorkflowDispatchHistoryEntry,
  WorkflowEvidenceArtifact,
  WorkflowEvidenceGate,
  WorkflowFlow,
  WorkflowFlowRun,
  WorkflowUserAuthorization,
  WorkflowPendingDispatch,
  WorkflowProgressDocument
} from "../../shared/types/workflow.js";
import {
  WORKFLOW_EVIDENCE_ARTIFACTS,
  WORKFLOW_EVIDENCE_GATES,
  WORKFLOW_FLOWS
} from "../../shared/types/workflow.js";
import { checkMarkdownArtifact, readArtifactSectionContent } from "../../shared/validation/artifact-check.js";
import { ARCHITECT_DEBUG_NORMAL_PLAN_DISPOSITION } from "../../shared/validation/artifact-contract.js";
import { renderWorkflowProgressTemplate } from "../templates/handoff.js";

export interface WorkflowControlContext {
  taskRepoRoot: string;
  stateRoot: string;
  handoffDir: string;
  taskSlug: string;
}

export interface WorkflowProgressSubmissionResult {
  path: string;
  content: string;
}

export interface WorkflowRouteAuthorizationInput extends WorkflowControlContext {
  routePath: string;
  targetRole: DispatchableRole;
  routeContentHash?: string;
  messageId?: string;
}

export interface WorkflowControlService {
  getState(input: WorkflowControlContext): Promise<WorkflowControlState>;
  getProgress(input: WorkflowControlContext): Promise<WorkflowProgressDocument>;
  requestUserInput(input: WorkflowControlContext, question: string): Promise<WorkflowControlState>;
  resolveUserInput(input: WorkflowControlContext): Promise<WorkflowControlState>;
  submitProgress(input: WorkflowControlContext, content: string): Promise<WorkflowProgressSubmissionResult>;
  assertRouteAuthorized(input: WorkflowRouteAuthorizationInput): Promise<void>;
  claimDispatch(input: Required<WorkflowRouteAuthorizationInput>): Promise<void>;
  releaseDispatch(input: WorkflowControlContext, messageId: string): Promise<void>;
  confirmDispatch(input: WorkflowControlContext, messageId: string): Promise<void>;
}

export interface WorkflowControlServiceDeps {
  fs: FileSystemAdapter;
  now?: () => string;
  id?: () => string;
}

const HISTORY_HEADER = "| Sequence | Flow | Target Role | Evidence | Override Authorization | Confirmed At |";
const HISTORY_SEPARATOR = "| --- | --- | --- | --- | --- | --- |";
const TARGET_ROLES = new Set<DispatchableRole>(["architect", "coder", "tester"]);
const FINAL_GATE_STATUSES = new Set(["disabled", "not_required", "skipped", "overridden"]);
const MISSING_EVIDENCE_HASH = "<missing>";
const DOCS_ONLY_ROLE_TRANSITIONS = [
  "docs-only/architect",
  "docs-only/coder",
  "docs-only/tester"
] as const;
const DOCS_ONLY_EXIT_TRANSITIONS = [
  "code-change/architect",
  "validation-only/tester"
] as const;

export function createWorkflowControlService(deps: WorkflowControlServiceDeps): WorkflowControlService {
  const now = deps.now ?? (() => new Date().toISOString());
  const id = deps.id ?? (() => `wfauth_${randomUUID()}`);
  const locks = new Map<string, Promise<unknown>>();

  async function getState(input: WorkflowControlContext): Promise<WorkflowControlState> {
    try {
      const progressWarning = await ensureProgressFile(deps.fs, input);
      if (!(await deps.fs.pathExists(statePath(input)))) {
        const state = emptyState(input.taskSlug, now());
        return progressWarning ? { ...state, warnings: [progressWarning] } : state;
      }
      const state = normalizeState(await deps.fs.readJson<unknown>(statePath(input)), input.taskSlug, now());
      return progressWarning ? { ...state, warnings: [...state.warnings, progressWarning] } : state;
    } catch (error) {
      return {
        ...emptyState(input.taskSlug, now()),
        warnings: [`Workflow control state could not be read: ${errorMessage(error)}`]
      };
    }
  }

  async function submitProgress(
    input: WorkflowControlContext,
    content: string
  ): Promise<WorkflowProgressSubmissionResult> {
    return withLock(statePath(input), async () => {
      const state = await getState(input);
      failOnStateWarnings(state);
      failWhileAwaitingUser(state);
      if (state.pendingDispatch) {
        throw workflowError(
          "WORKFLOW_DISPATCH_PENDING",
          `A ${state.pendingDispatch.targetRole} dispatch is already ${state.pendingDispatch.status}.`,
          "Complete or recover the existing dispatch before proposing another workflow transition."
        );
      }

      const current = await readProgress(deps.fs, input);
      const candidate = parseWorkflowProgress(content, input.taskSlug);
      validateCandidateAgainstCurrent(current, candidate);

      if (!candidate.proposal) {
        if (candidate.status !== "completed") {
          throw workflowError(
            "WORKFLOW_PROPOSAL_REQUIRED",
            "Workflow Progress must propose one role dispatch or mark the active flow completed.",
            "Set Proposed Dispatch to a target role, or submit Status: completed after the flow's completion evidence exists."
          );
        }
        await validateCompletion(deps.fs, input, state, candidate);
        const normalized = renderWorkflowProgress(candidate);
        await writeAtomic(deps.fs, progressPath(input), normalized);
        return { path: relativeProgressPath(input), content: normalized };
      }

      if (current.status === "completed" && !candidate.proposal.requestedFlow) {
        throw workflowError(
          "WORKFLOW_FLOW_REQUIRED",
          "Requested Flow is required when starting another flow after completion.",
          "Select the next flow explicitly before dispatching its first role."
        );
      }

      const baseHistoryHash = historyHash(current.history);
      const effectiveFlow = resolveEffectiveFlow(current.flow, candidate.proposal.requestedFlow);
      const verdict = await evaluateTransition(
        deps.fs,
        input,
        state,
        current,
        effectiveFlow,
        candidate.proposal.targetRole
      );
      let overrideAuthorizationId: string | undefined;
      let userAuthorization: WorkflowUserAuthorization | undefined;

      if (!verdict.allowed) {
        const authorizationText = candidate.proposal.authorizationText?.trim();
        const violatedRule = candidate.proposal.violatedRule?.trim();
        if (!authorizationText && !violatedRule) {
          throw workflowError(
            "WORKFLOW_TRANSITION_DENIED",
            verdict.reason,
            verdict.allowedTransitions.length > 0
              ? `Allowed next dispatches: ${verdict.allowedTransitions.join(", ")}. Recheck the flow, or ask the user directly for an exact one-time authorization.`
              : verdict.blockedHint
          );
        }
        if (!authorizationText || violatedRule !== verdict.reason) {
          throw workflowError(
            "WORKFLOW_USER_AUTHORIZATION_INVALID",
            `User authorization must include the exact authorization text and exact violated rule: ${verdict.reason}`,
            "Ask the user directly, then copy the user's authorization verbatim into Authorization Text and the rejection reason verbatim into Violated Rule."
          );
        }
        if (state.userAuthorizations.some((entry) => entry.authorizationText === authorizationText)) {
          throw workflowError(
            "WORKFLOW_USER_AUTHORIZATION_REUSED",
            "This user authorization has already been recorded for another workflow transition.",
            "Ask the user for a new explicit authorization for this exact transition."
          );
        }
        userAuthorization = createUserAuthorization(
          id(), current, candidate, effectiveFlow, baseHistoryHash, verdict.reason, authorizationText, now()
        );
        overrideAuthorizationId = userAuthorization.id;
      } else if (candidate.proposal.authorizationText || candidate.proposal.violatedRule) {
        throw workflowError(
          "WORKFLOW_USER_AUTHORIZATION_NOT_REQUIRED",
          "This workflow transition is legal and must not consume user authorization.",
          "Set every User Authorization field to none."
        );
      }

      const timestamp = now();
      const pendingDispatch: WorkflowPendingDispatch = {
        revision: candidate.revision,
        baseHistoryHash,
        effectiveFlow,
        requestedFlow: candidate.proposal.requestedFlow,
        targetRole: candidate.proposal.targetRole,
        evidence: candidate.proposal.evidence,
        expectedRoutePath: expectedRoutePath(input.handoffDir, candidate.proposal.targetRole),
        overrideAuthorizationId,
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const accepted: WorkflowProgressDocument = {
        ...candidate,
        proposal: candidate.proposal
      };
      const normalized = renderWorkflowProgress(accepted);
      await writeAtomic(deps.fs, progressPath(input), normalized);
      await saveState(input, {
        ...state,
        pendingDispatch,
        userAuthorizations: userAuthorization
          ? [...state.userAuthorizations, userAuthorization]
          : state.userAuthorizations,
        updatedAt: timestamp
      });
      return { path: relativeProgressPath(input), content: normalized };
    });
  }

  async function assertRouteAuthorized(input: WorkflowRouteAuthorizationInput): Promise<void> {
    const state = await getState(input);
    failOnStateWarnings(state);
    failWhileAwaitingUser(state);
    const pending = state.pendingDispatch;
    if (!pending || pending.status !== "pending") {
      throw workflowError(
        "WORKFLOW_ROUTE_NOT_APPROVED",
        "Project Manager has no pending workflow approval for this route.",
        "Submit a valid workflow-progress.md transition before the PM route message."
      );
    }
    if (pending.targetRole !== input.targetRole || pending.expectedRoutePath !== input.routePath) {
      throw workflowError(
        "WORKFLOW_ROUTE_MISMATCH",
        `The approved route is project-manager -> ${pending.targetRole}, not project-manager -> ${input.targetRole}.`,
        `Write only ${pending.expectedRoutePath}, or submit a new legal Workflow Progress transition.`
      );
    }
    const progress = await readProgress(deps.fs, input);
    if (progress.revision !== pending.revision || historyHash(progress.history) !== pending.baseHistoryHash) {
      throw workflowError(
        "WORKFLOW_APPROVAL_STALE",
        "The pending workflow approval no longer matches workflow-progress.md.",
        "Resubmit the Workflow Progress transition."
      );
    }
  }

  async function claimDispatch(input: Required<WorkflowRouteAuthorizationInput>): Promise<void> {
    await withLock(statePath(input), async () => {
      await assertRouteAuthorized(input);
      const state = await getState(input);
      const pending = state.pendingDispatch!;
      await saveState(input, {
        ...state,
        pendingDispatch: {
          ...pending,
          status: "dispatching",
          routeContentHash: input.routeContentHash,
          messageId: input.messageId,
          updatedAt: now()
        },
        updatedAt: now()
      });
    });
  }

  async function releaseDispatch(input: WorkflowControlContext, messageId: string): Promise<void> {
    await withLock(statePath(input), async () => {
      const state = await getState(input);
      const pending = state.pendingDispatch;
      if (!pending || pending.status !== "dispatching" || pending.messageId !== messageId) return;
      await saveState(input, {
        ...state,
        pendingDispatch: {
          ...pending,
          status: "pending",
          routeContentHash: undefined,
          messageId: undefined,
          updatedAt: now()
        },
        updatedAt: now()
      });
    });
  }

  async function confirmDispatch(input: WorkflowControlContext, messageId: string): Promise<void> {
    await withLock(statePath(input), async () => {
      const state = await getState(input);
      failOnStateWarnings(state);
      failWhileAwaitingUser(state);
      const pending = state.pendingDispatch;
      if (!pending || pending.status !== "dispatching" || pending.messageId !== messageId) {
        throw workflowError(
          "WORKFLOW_DISPATCH_CONFIRMATION_MISMATCH",
          `Message ${messageId} does not own the pending workflow dispatch.`,
          "Do not advance Workflow Progress from an unrelated UserPromptSubmit event."
        );
      }
      const current = await readProgress(deps.fs, input);
      if (current.revision !== pending.revision || historyHash(current.history) !== pending.baseHistoryHash) {
        throw workflowError(
          "WORKFLOW_APPROVAL_STALE",
          "Workflow Progress changed before the approved dispatch was confirmed.",
          "Repair workflow-progress.md before continuing."
        );
      }
      const timestamp = now();
      const entry: WorkflowDispatchHistoryEntry = {
        sequence: current.history.length + 1,
        flow: pending.effectiveFlow,
        targetRole: pending.targetRole,
        evidence: pending.evidence,
        overrideAuthorizationId: pending.overrideAuthorizationId,
        confirmedAt: timestamp
      };
      const activeDispatch = await captureEvidenceBaseline(
        deps.fs,
        input,
        entry.sequence,
        entry.flow,
        entry.targetRole,
        timestamp
      );
      const flowRun = await advanceFlowRun(
        deps.fs,
        input,
        state,
        current,
        pending.effectiveFlow,
        entry.sequence
      );
      const completed: WorkflowProgressDocument = {
        ...current,
        flow: pending.effectiveFlow,
        status: "active",
        history: [...current.history, entry],
        proposal: undefined
      };
      const userAuthorizations = state.userAuthorizations.map((entry) =>
        entry.id === pending.overrideAuthorizationId
          ? { ...entry, status: "consumed" as const, consumedAt: timestamp }
          : entry
      );
      await writeAtomic(deps.fs, progressPath(input), renderWorkflowProgress(completed));
      await saveState(input, {
        ...state,
        pendingDispatch: null,
        activeDispatch,
        flowRun,
        userAuthorizations,
        updatedAt: timestamp
      });
    });
  }

  return {
    getState,
    getProgress: (input) => readProgress(deps.fs, input),
    requestUserInput,
    resolveUserInput,
    submitProgress,
    assertRouteAuthorized,
    claimDispatch,
    releaseDispatch,
    confirmDispatch
  };

  async function requestUserInput(
    input: WorkflowControlContext,
    question: string
  ): Promise<WorkflowControlState> {
    return withLock(statePath(input), async () => {
      const state = await getState(input);
      const normalizedQuestion = question.trim();
      if (!normalizedQuestion) {
        throw workflowError(
          "WORKFLOW_USER_QUESTION_REQUIRED",
          "A non-empty user question is required."
        );
      }
      const timestamp = now();
      const next: WorkflowControlState = {
        ...state,
        awaitingUser: {
          question: normalizedQuestion,
          requestedAt: timestamp
        },
        pendingDispatch: null,
        updatedAt: timestamp
      };
      await saveState(input, next);
      return next;
    });
  }

  async function resolveUserInput(input: WorkflowControlContext): Promise<WorkflowControlState> {
    return withLock(statePath(input), async () => {
      const state = await getState(input);
      if (!state.awaitingUser) return state;
      const next: WorkflowControlState = {
        ...state,
        awaitingUser: null,
        updatedAt: now()
      };
      await saveState(input, next);
      return next;
    });
  }

  async function saveState(input: WorkflowControlContext, state: WorkflowControlState): Promise<void> {
    await deps.fs.writeJsonAtomic(statePath(input), state);
  }

  async function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    locks.set(key, next);
    try {
      return await next;
    } finally {
      if (locks.get(key) === next) locks.delete(key);
    }
  }
}

export function parseWorkflowProgress(content: string, expectedTaskSlug?: string): WorkflowProgressDocument {
  const title = /^# Workflow Progress:\s*(\S.+?)\s*$/m.exec(content)?.[1]?.trim();
  const revision = integerField(content, "Revision");
  const flowValue = field(content, "Flow");
  const status = field(content, "Status");
  const errors: string[] = [];
  if (!title) errors.push("Title must be '# Workflow Progress: <task-slug>'.");
  if (expectedTaskSlug && title !== expectedTaskSlug) errors.push(`Workflow Progress task must be ${expectedTaskSlug}.`);
  if (revision === undefined || revision < 0) errors.push("Revision must be a non-negative integer.");
  const flow = flowValue === "none" ? undefined : asFlow(flowValue);
  if (flowValue !== "none" && !flow) errors.push(`Flow must be none|${WORKFLOW_FLOWS.join("|")}.`);
  if (status !== "not-started" && status !== "active" && status !== "completed") {
    errors.push("Status must be not-started|active|completed.");
  }

  const history = parseHistory(readArtifactSectionContent(content, "Dispatch History"), errors);
  const proposalSection = readArtifactSectionContent(content, "Proposed Dispatch") ?? "";
  const requestedFlowValue = field(proposalSection, "Requested Flow");
  const targetRoleValue = field(proposalSection, "Target Role");
  const evidence = rawField(proposalSection, "Evidence");
  let proposal: WorkflowProgressDocument["proposal"];
  if (targetRoleValue !== "none") {
    const targetRole = asTargetRole(targetRoleValue);
    const requestedFlow = requestedFlowValue === "none" ? undefined : asFlow(requestedFlowValue);
    if (!targetRole) errors.push("Target Role must be none|architect|coder|tester.");
    if (requestedFlowValue !== "none" && !requestedFlow) errors.push(`Requested Flow must be none|${WORKFLOW_FLOWS.join("|")}.`);
    if (!evidence || evidence === "none") errors.push("Evidence must identify the real artifact or user request for the proposed dispatch.");
    if (targetRole) proposal = { targetRole, requestedFlow, evidence: evidence ?? "" };
  } else if (requestedFlowValue !== "none" || evidence !== "none") {
    errors.push("A completed/no-dispatch proposal must use Requested Flow, Target Role, and Evidence value none.");
  }

  const authorizationSection = readArtifactSectionContent(content, "User Authorization") ?? "";
  const authorizationText = rawField(authorizationSection, "Authorization Text");
  const violatedRule = rawField(authorizationSection, "Violated Rule");
  if (!authorizationText || !violatedRule) {
    errors.push("User Authorization requires Authorization Text and Violated Rule fields.");
  } else if (proposal) {
    const allNone = authorizationText === "none" && violatedRule === "none";
    const allSet = authorizationText !== "none" && violatedRule !== "none";
    if (!allNone && !allSet) errors.push("User Authorization fields must both be none or both contain exact authorization evidence.");
    if (allSet) {
      proposal.authorizationText = authorizationText;
      proposal.violatedRule = violatedRule;
    }
  } else if (authorizationText !== "none" || violatedRule !== "none") {
    errors.push("User Authorization fields must be none when no role dispatch is proposed.");
  }

  if (errors.length > 0) throw progressValidationError(errors);
  return {
    taskSlug: title!,
    revision: revision!,
    flow,
    status: status as WorkflowProgressDocument["status"],
    history,
    proposal
  };
}

export function renderWorkflowProgress(progress: WorkflowProgressDocument): string {
  const history = progress.history.length === 0
    ? "none"
    : [
        HISTORY_HEADER,
        HISTORY_SEPARATOR,
        ...progress.history.map((entry) =>
          `| ${entry.sequence} | ${entry.flow} | ${entry.targetRole} | ${escapeCell(entry.evidence)} | ${entry.overrideAuthorizationId ?? "none"} | ${entry.confirmedAt ?? "none"} |`
        )
      ].join("\n");
  const proposal = progress.proposal;
  return `# Workflow Progress: ${progress.taskSlug}

Revision: ${progress.revision}
Flow: ${progress.flow ?? "none"}
Status: ${progress.status}

## Dispatch History

${history}

## Proposed Dispatch

Requested Flow: ${proposal?.requestedFlow ?? "none"}
Target Role: ${proposal?.targetRole ?? "none"}
Evidence: ${proposal?.evidence ?? "none"}

## User Authorization

Authorization Text: ${proposal?.authorizationText ?? "none"}
Violated Rule: ${proposal?.violatedRule ?? "none"}
`;
}

async function evaluateTransition(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  state: WorkflowControlState,
  current: WorkflowProgressDocument,
  effectiveFlow: WorkflowFlow,
  targetRole: DispatchableRole
): Promise<{ allowed: boolean; reason: string; allowedTransitions: string[]; blockedHint: string }> {
  const allowedTransitions = await getAllowedTransitions(fs, input, state, current);
  const signature = `${effectiveFlow}/${targetRole}`;
  if (allowedTransitions.includes(signature)) {
    return { allowed: true, reason: "allowed", allowedTransitions, blockedHint: "" };
  }
  return {
    allowed: false,
    reason: `Transition ${signature} is not legal after the confirmed Workflow Progress history.`,
    allowedTransitions,
    blockedHint: await describeBlockedCheckpoint(fs, input, state, current)
  };
}

async function getAllowedTransitions(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  state: WorkflowControlState,
  current: WorkflowProgressDocument
): Promise<string[]> {
  if (current.status === "completed") return initialTransitions();
  if (!current.flow || current.history.length === 0) {
    return initialTransitions();
  }
  const flow = current.flow;
  const flowRun = resolveFlowRun(state.flowRun, current);
  if (flow === "docs-only") {
    const docs = await artifactState(fs, input, "docs-update-report.md", "docs-update-report");
    const active = state.activeDispatch;
    if (!active || active.flow !== "docs-only") {
      return [...DOCS_ONLY_ROLE_TRANSITIONS, ...DOCS_ONLY_EXIT_TRANSITIONS];
    }
    const hasFreshResult = evidenceProducedAfterActiveDispatch(
      state,
      flow,
      active.targetRole,
      "docs-update-report.md",
      docs.hash
    );
    return hasFreshResult && docs.complete
      ? [...DOCS_ONLY_ROLE_TRANSITIONS, ...DOCS_ONLY_EXIT_TRANSITIONS]
      : [`docs-only/${active.targetRole}`, ...DOCS_ONLY_EXIT_TRANSITIONS];
  }
  if (flow === "validation-only") {
    const test = await artifactState(fs, input, "test-report.md", "test-report");
    if (!evidenceIsFresh(state, flow, "tester", "test-report.md", test.hash)) return ["validation-only/tester"];
    if (test.infrastructure === "production-change-required") return ["code-change/architect"];
    if (test.value === "incomplete" || test.infrastructure === "repair-required") return ["validation-only/tester"];
    const validationGate = await gateState(fs, input, "validation-adequacy");
    if (freshGateDecision(state, flow, "tester", "validation-adequacy", validationGate) === "request_changes") {
      return ["validation-only/tester"];
    }
    if (!gatePassedForDispatch(state, flow, "tester", "validation-adequacy", validationGate)) return [];
    return [];
  }
  const segment = activeFlowSegment(current.history, flow, flowRun.startedAtSequence);
  if (flow === "code-change") {
    return allowedCodeChange(fs, input, state, segment, flowRun.resumedFromBranch);
  }
  if (flow === "architect-debug") {
    return allowedArchitectFix(
      fs,
      input,
      state,
      segment,
      "architect-debug",
      flowRun.resumedFromBranch !== undefined,
      flowRun.activeBranch ? flowRun.rootFlow : undefined
    );
  }
  return allowedArchitectFix(
    fs,
    input,
    state,
    segment,
    "architecture-diagnosis",
    false,
    flowRun.activeBranch ? flowRun.rootFlow : undefined
  );
}

function initialTransitions(): string[] {
  return [
    "code-change/architect",
    "architect-debug/architect",
    "architecture-diagnosis/architect",
    ...DOCS_ONLY_ROLE_TRANSITIONS,
    "validation-only/tester"
  ];
}

async function allowedCodeChange(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  state: WorkflowControlState,
  segment: WorkflowDispatchHistoryEntry[],
  resumedFromBranch: WorkflowFlowRun["resumedFromBranch"]
): Promise<string[]> {
  const coderIndex = findLastIndex(segment, (entry) => entry.targetRole === "coder");
  const testerIndex = findLastIndex(segment, (entry) => entry.targetRole === "tester");
  if (resumedFromBranch && coderIndex < 0) {
    if (testerIndex < 0) {
      return allowedPostImplementationArchitect(fs, input, state, "code-change", segment);
    }
    return allowedAfterTester(fs, input, state, "code-change", resumedFromBranch, {
      testerFailureFlow: "architect-debug",
      implementationFailureFlow: "architect-debug",
      successTarget: "code-change/architect"
    });
  }
  if (coderIndex < 0) {
    const plan = await artifactState(fs, input, "architecture-plan.md", "architecture-plan");
    if (!evidenceIsFresh(state, "code-change", "architect", "architecture-plan.md", plan.hash)
      || plan.value !== "complete") return ["code-change/architect"];
    const gate = await gateState(fs, input, "architecture-plan");
    if (freshGateDecision(state, "code-change", "architect", "architecture-plan", gate) === "request_changes") {
      return ["code-change/architect"];
    }
    return gatePassedForDispatch(state, "code-change", "architect", "architecture-plan", gate)
      ? ["code-change/coder"]
      : [];
  }
  if (testerIndex < coderIndex) {
    const coder = await artifactState(fs, input, "coder-completion.md", "coder-completion");
    if (!evidenceIsFresh(state, "code-change", "coder", "coder-completion.md", coder.hash)) {
      return ["code-change/coder"];
    }
    if (coder.value === "failed") return ["architect-debug/architect"];
    return coder.value === "ready_for_review" ? ["code-change/tester"] : ["code-change/coder"];
  }
  const architectsAfterTester = segment.filter((entry, index) => index > testerIndex && entry.targetRole === "architect");
  if (architectsAfterTester.length > 0) {
    return allowedPostImplementationArchitect(fs, input, state, "code-change", architectsAfterTester);
  }
  return allowedAfterTester(fs, input, state, "code-change", "coder", {
    testerFailureFlow: "architect-debug",
    implementationFailureFlow: "architect-debug",
    successTarget: "code-change/architect"
  });
}

async function allowedArchitectureFollowup(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  state: WorkflowControlState,
  followupDispatchedAt: string | undefined
): Promise<string[]> {
  const plan = await artifactState(fs, input, "architecture-plan.md", "architecture-plan");
  if (!evidenceIsFresh(state, "code-change", "architect", "architecture-plan.md", plan.hash)
    || plan.value !== "complete") return ["code-change/architect"];
  const gate = await gateState(fs, input, "architecture-plan");
  if (!gate || !followupDispatchedAt || gate.updatedAt <= followupDispatchedAt) return [];
  if (freshGateDecision(state, "code-change", "architect", "architecture-plan", gate) === "request_changes") {
    return ["code-change/architect"];
  }
  return gatePassedForDispatch(state, "code-change", "architect", "architecture-plan", gate)
    ? ["code-change/coder"]
    : [];
}

async function allowedArchitectFix(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  state: WorkflowControlState,
  segment: WorkflowDispatchHistoryEntry[],
  source: "architect-debug" | "architecture-diagnosis",
  resumedFromBranch: boolean,
  parentFlow: WorkflowFlow | undefined
): Promise<string[]> {
  const architectIndex = findLastIndex(segment, (entry) => entry.targetRole === "architect");
  const testerIndex = findLastIndex(segment, (entry) => entry.targetRole === "tester");
  if (resumedFromBranch && architectIndex >= 0 && testerIndex < 0) {
    return allowedPostImplementationArchitect(fs, input, state, source, segment);
  }
  if (architectIndex < 0) return [`${source}/architect`];
  if (testerIndex < 0) {
    const artifact = source === "architect-debug"
      ? await artifactState(fs, input, "architect-debug.md", "architect-debug")
      : await artifactState(fs, input, "architecture-diagnosis.md", "architecture-diagnosis");
    const artifactName = source === "architect-debug" ? "architect-debug.md" : "architecture-diagnosis.md";
    if (!evidenceIsFresh(state, source, "architect", artifactName, artifact.hash)) {
      return [`${source}/architect`];
    }
    if (source === "architect-debug" && artifact.disposition === ARCHITECT_DEBUG_NORMAL_PLAN_DISPOSITION) {
      return ["code-change/architect"];
    }
    return artifact.complete ? [`${source}/tester`] : [`${source}/architect`];
  }
  if (architectIndex > testerIndex) {
    const artifactName = source === "architect-debug" ? "architect-debug.md" : "architecture-diagnosis.md";
    const artifact = source === "architect-debug"
      ? await artifactState(fs, input, artifactName, "architect-debug")
      : await artifactState(fs, input, artifactName, "architecture-diagnosis");
    if (evidenceIsFresh(state, source, "architect", artifactName, artifact.hash) && artifact.complete) {
      return [`${source}/tester`];
    }
    const docs = await artifactState(fs, input, "docs-sync-report.md", "docs-sync-report");
    return evidenceIsFresh(state, source, "architect", "docs-sync-report.md", docs.hash)
      && (docs.value === "synced" || docs.value === "unchanged")
      ? []
      : [`${source}/architect`];
  }
  return allowedAfterTester(fs, input, state, source, source, {
    testerFailureFlow: source === "architect-debug" ? "architecture-diagnosis" : undefined,
    implementationFailureFlow: source,
    successTarget: parentFlow ? `${parentFlow}/architect` : `${source}/architect`
  });
}

async function allowedPostImplementationArchitect(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  state: WorkflowControlState,
  flow: "code-change" | "architect-debug" | "architecture-diagnosis",
  architectEntries: WorkflowDispatchHistoryEntry[]
): Promise<string[]> {
  const docs = await artifactState(fs, input, "docs-sync-report.md", "docs-sync-report");
  const acceptance = await artifactState(fs, input, "final-acceptance.md", "final-acceptance");
  if (flow === "code-change" && architectEntries.length > 1 && acceptance.value === "needs-architect-follow-up") {
    return allowedArchitectureFollowup(fs, input, state, architectEntries[1]?.confirmedAt);
  }
  if (evidenceIsFresh(state, flow, "architect", "docs-sync-report.md", docs.hash)
    && (docs.value === "synced" || docs.value === "unchanged")) {
    if (acceptance.value === "needs-coder-follow-up" && flow === "code-change") return ["code-change/coder"];
    if (acceptance.value === "needs-docs-sync") return [`${flow}/architect`];
    if (acceptance.value === "needs-architect-follow-up") return [`${flow}/architect`];
    return [];
  }
  return [`${flow}/architect`];
}

async function allowedAfterTester(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  state: WorkflowControlState,
  currentFlow: "code-change" | "architect-debug" | "architecture-diagnosis",
  codeSource: "coder" | "architect-debug" | "architecture-diagnosis",
  options: {
    testerFailureFlow?: "architect-debug" | "architecture-diagnosis";
    implementationFailureFlow?: "architect-debug" | "architecture-diagnosis";
    successTarget: string;
  }
): Promise<string[]> {
  const test = await artifactState(fs, input, "test-report.md", "test-report");
  if (!evidenceIsFresh(state, currentFlow, "tester", "test-report.md", test.hash)) {
    return [`${currentFlow}/tester`];
  }
  if (test.value === "incomplete" || test.infrastructure === "repair-required") return [`${currentFlow}/tester`];
  if (test.value === "fail" && test.infrastructure !== "repair-required") {
    return options.testerFailureFlow ? [`${options.testerFailureFlow}/architect`] : [];
  }
  const validation = await gateState(fs, input, "validation-adequacy");
  if (freshGateDecision(state, currentFlow, "tester", "validation-adequacy", validation) === "request_changes") {
    return [`${currentFlow}/tester`];
  }
  if (!gatePassedForDispatch(state, currentFlow, "tester", "validation-adequacy", validation)) return [];
  const codeDiff = await gateState(fs, input, "code-diff");
  if (freshGateDecision(state, currentFlow, "tester", "code-diff", codeDiff) === "request_changes") {
    const scopes = new Set(codeDiff?.findings?.map((finding) => finding.scope).filter(Boolean));
    return scopes.size === 1 && scopes.has("test-only")
      ? [`${currentFlow}/tester`]
      : options.implementationFailureFlow ? [`${options.implementationFailureFlow}/architect`] : [];
  }
  if (!gatePassedForDispatch(state, currentFlow, "tester", "code-diff", codeDiff)) return [];
  const gateCodeSource = codeSource === "architecture-diagnosis" ? "architect-diagnosis" : codeSource;
  const reviewedSources = codeDiff?.codeDiffSources ?? (codeDiff?.codeDiffSource ? [codeDiff.codeDiffSource] : []);
  if (codeDiff?.status === "completed" && !reviewedSources.includes(gateCodeSource)) return [];
  return [options.successTarget];
}

async function artifactState(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  fileName: string,
  kind: Parameters<typeof checkMarkdownArtifact>[0]
): Promise<{ complete: boolean; hash: string; value?: string; infrastructure?: string; disposition?: string }> {
  const relative = path.posix.join(input.handoffDir, fileName);
  const absolute = resolveRepoPath(input.taskRepoRoot, relative);
  if (!(await fs.pathExists(absolute))) return { complete: false, hash: MISSING_EVIDENCE_HASH };
  const content = await fs.readText(absolute);
  const check = checkMarkdownArtifact(kind, relative, content, { mode: "final" });
  const inline = (name: string) => new RegExp(`^${name}:\\s*(.+?)\\s*$`, "mi").exec(content)?.[1]?.trim().toLowerCase();
  let value: string | undefined;
  if (kind === "architecture-plan") value = inline("Planning Result");
  if (kind === "coder-completion") value = inline("Decision");
  if (kind === "architect-debug") value = inline("Status") ?? readArtifactSectionContent(content, "Final Disposition")?.trim().toLowerCase();
  if (kind === "architecture-diagnosis") value = readArtifactSectionContent(content, "Final Disposition")?.trim().toLowerCase();
  if (kind === "test-report") value = inline("Test Result");
  if (kind === "docs-update-report" || kind === "docs-sync-report" || kind === "final-acceptance") {
    value = readArtifactSectionContent(content, "Decision")?.trim().toLowerCase();
  }
  const infrastructure = kind === "test-report"
    ? /^Status:\s*(.+?)\s*$/mi.exec(readArtifactSectionContent(content, "Test Infrastructure") ?? "")?.[1]?.trim().toLowerCase()
    : undefined;
  const disposition = kind === "architect-debug" || kind === "architecture-diagnosis"
    ? readArtifactSectionContent(content, "Final Disposition")?.trim().toLowerCase()
    : undefined;
  return {
    complete: check.status === "ok",
    hash: contentHash(content),
    value,
    infrastructure,
    disposition
  };
}

async function gateState(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  gate: keyof GateReviewIndex["gates"]
): Promise<GateReviewGateRecord | undefined> {
  const target = resolveRepoPath(input.taskRepoRoot, path.posix.join(".ai/vcm/gate-reviews", "index.json"));
  if (!(await fs.pathExists(target))) return undefined;
  try {
    const index = await fs.readJson<GateReviewIndex>(target);
    return index.gates?.[gate];
  } catch {
    return undefined;
  }
}

async function captureEvidenceBaseline(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  sequence: number,
  flow: WorkflowFlow,
  targetRole: DispatchableRole,
  confirmedAt: string
): Promise<WorkflowDispatchEvidenceBaseline> {
  const artifactEntries = await Promise.all(WORKFLOW_EVIDENCE_ARTIFACTS.map(async (fileName) => {
    const target = resolveRepoPath(input.taskRepoRoot, path.posix.join(input.handoffDir, fileName));
    const hash = await fs.pathExists(target) ? contentHash(await fs.readText(target)) : MISSING_EVIDENCE_HASH;
    return [fileName, hash] as const;
  }));
  const gateEntries = await Promise.all(WORKFLOW_EVIDENCE_GATES.map(async (gate) => [
    gate,
    gateFingerprint(await gateState(fs, input, gate))
  ] as const));
  return {
    sequence,
    flow,
    targetRole,
    artifactHashes: Object.fromEntries(artifactEntries) as Record<WorkflowEvidenceArtifact, string>,
    gateFingerprints: Object.fromEntries(gateEntries) as Record<WorkflowEvidenceGate, string>,
    confirmedAt
  };
}

async function advanceFlowRun(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  state: WorkflowControlState,
  current: WorkflowProgressDocument,
  effectiveFlow: WorkflowFlow,
  nextSequence: number
): Promise<WorkflowFlowRun> {
  if (!current.flow || current.status === "completed") {
    return newFlowRun(effectiveFlow, nextSequence);
  }
  const run = resolveFlowRun(state.flowRun, current);
  if (effectiveFlow === current.flow) return run;

  if (current.flow === "code-change" && effectiveFlow === "architect-debug" && run.rootFlow === "code-change") {
    return { ...run, activeBranch: "architect-debug", resumedFromBranch: undefined };
  }
  if (current.flow === "architect-debug" && effectiveFlow === "architecture-diagnosis") {
    if (run.rootFlow === "code-change" && run.activeBranch === "architect-debug") {
      return { ...run, activeBranch: "architecture-diagnosis", resumedFromBranch: undefined };
    }
    if (run.rootFlow === "architect-debug" && !run.activeBranch) {
      return { ...run, activeBranch: "architecture-diagnosis", resumedFromBranch: undefined };
    }
  }
  if (run.activeBranch === current.flow && effectiveFlow === run.rootFlow) {
    if (current.flow === "architect-debug" && effectiveFlow === "code-change") {
      const debug = await artifactState(fs, input, "architect-debug.md", "architect-debug");
      if (debug.disposition === ARCHITECT_DEBUG_NORMAL_PLAN_DISPOSITION) {
        return newFlowRun("code-change", nextSequence);
      }
    }
    return {
      ...run,
      activeBranch: undefined,
      resumedFromBranch: current.flow
    };
  }
  return newFlowRun(effectiveFlow, nextSequence);
}

function newFlowRun(flow: WorkflowFlow, startedAtSequence: number): WorkflowFlowRun {
  return { rootFlow: flow, startedAtSequence };
}

function resolveFlowRun(
  recorded: WorkflowFlowRun | null,
  current: WorkflowProgressDocument
): WorkflowFlowRun {
  if (recorded && current.flow
    && (recorded.rootFlow === current.flow || recorded.activeBranch === current.flow)) {
    return recorded;
  }
  if (!current.flow || current.history.length === 0) {
    return newFlowRun(current.flow ?? "code-change", 1);
  }
  const segments = flowHistorySegments(current.history);
  const last = segments.at(-1)!;
  const previous = segments.at(-2);
  const grandparent = segments.at(-3);
  if (last.flow === "architect-debug" && previous?.flow === "code-change") {
    return {
      rootFlow: "code-change",
      activeBranch: "architect-debug",
      startedAtSequence: previous.startedAtSequence
    };
  }
  if (last.flow === "architecture-diagnosis" && previous?.flow === "architect-debug") {
    return {
      rootFlow: grandparent?.flow === "code-change" ? "code-change" : "architect-debug",
      activeBranch: "architecture-diagnosis",
      startedAtSequence: grandparent?.flow === "code-change"
        ? grandparent.startedAtSequence
        : previous.startedAtSequence
    };
  }
  if (last.flow === "architecture-diagnosis" && previous?.flow === "code-change") {
    return {
      rootFlow: "code-change",
      activeBranch: "architecture-diagnosis",
      startedAtSequence: previous.startedAtSequence
    };
  }
  if (last.flow === "code-change" && previous
    && (previous.flow === "architect-debug" || previous.flow === "architecture-diagnosis")
    && grandparent?.flow === "code-change") {
    return {
      rootFlow: "code-change",
      resumedFromBranch: previous.flow,
      startedAtSequence: grandparent.startedAtSequence
    };
  }
  return newFlowRun(last.flow, last.startedAtSequence);
}

function flowHistorySegments(history: WorkflowDispatchHistoryEntry[]): Array<{
  flow: WorkflowFlow;
  startedAtSequence: number;
}> {
  const segments: Array<{ flow: WorkflowFlow; startedAtSequence: number }> = [];
  for (const entry of history) {
    if (segments.at(-1)?.flow !== entry.flow) {
      segments.push({ flow: entry.flow, startedAtSequence: entry.sequence });
    }
  }
  return segments;
}

function activeFlowSegment(
  history: WorkflowDispatchHistoryEntry[],
  flow: WorkflowFlow,
  startedAtSequence: number
): WorkflowDispatchHistoryEntry[] {
  const runStart = history.findIndex((entry) => entry.sequence >= startedAtSequence);
  const lastDifferent = findLastIndex(history, (entry) => entry.flow !== flow);
  const start = Math.max(runStart < 0 ? 0 : runStart, lastDifferent + 1);
  return history.slice(start);
}

function evidenceIsFresh(
  state: WorkflowControlState,
  flow: WorkflowFlow,
  targetRole: DispatchableRole,
  artifact: WorkflowEvidenceArtifact,
  currentHash: string
): boolean {
  const baseline = matchingEvidenceBaseline(state, flow, targetRole);
  return !baseline || baseline.artifactHashes[artifact] !== currentHash;
}

function freshGateDecision(
  state: WorkflowControlState,
  flow: WorkflowFlow,
  targetRole: DispatchableRole,
  gate: WorkflowEvidenceGate,
  record: GateReviewGateRecord | undefined
): GateReviewGateRecord["decision"] | undefined {
  const baseline = matchingEvidenceBaseline(state, flow, targetRole);
  if (baseline && baseline.gateFingerprints[gate] === gateFingerprint(record)) return undefined;
  return record?.decision;
}

function gatePassedForDispatch(
  state: WorkflowControlState,
  flow: WorkflowFlow,
  targetRole: DispatchableRole,
  gate: WorkflowEvidenceGate,
  record: GateReviewGateRecord | undefined
): boolean {
  if (!record) return false;
  if (FINAL_GATE_STATUSES.has(record.status)) return true;
  return freshGateDecision(state, flow, targetRole, gate, record) === "approve"
    && record.status === "completed";
}

function matchingEvidenceBaseline(
  state: WorkflowControlState,
  flow: WorkflowFlow,
  targetRole: DispatchableRole
): WorkflowDispatchEvidenceBaseline | undefined {
  const baseline = state.activeDispatch;
  return baseline?.flow === flow && baseline.targetRole === targetRole ? baseline : undefined;
}

function gateFingerprint(record: GateReviewGateRecord | undefined): string {
  if (!record) return MISSING_EVIDENCE_HASH;
  return contentHash(JSON.stringify({
    requestId: record.requestId,
    inputHash: record.inputHash,
    status: record.status,
    decision: record.decision,
    codeDiffSource: record.codeDiffSource,
    codeDiffSources: record.codeDiffSources,
    findings: record.findings,
    completedAt: record.completedAt
  }));
}

async function describeBlockedCheckpoint(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  state: WorkflowControlState,
  current: WorkflowProgressDocument
): Promise<string> {
  const baseline = state.activeDispatch;
  if (!baseline || !current.flow) {
    return "No role dispatch is legal at this checkpoint. Complete the required current Gate or PM-only step first.";
  }
  if (baseline.targetRole === "tester") {
    const test = await artifactState(fs, input, "test-report.md", "test-report");
    if (!evidenceIsFresh(state, baseline.flow, "tester", "test-report.md", test.hash)) {
      return "The latest Tester dispatch has not produced a fresh test-report.md. Wait for Tester to finish or route Tester again if its result is incomplete.";
    }
    if (baseline.flow === "architecture-diagnosis" && test.value === "fail") {
      return "Architecture Diagnosis stopped after the current Tester failure. Record the user's decision and use one exact Workflow Override if the user authorizes another Architect repair.";
    }
    return "The latest Tester result is waiting for its current validation-adequacy or code-diff Gate result.";
  }
  if (baseline.targetRole === "architect") {
    return "The latest Architect dispatch has not produced the fresh workflow artifact required for its next step.";
  }
  if (baseline.targetRole === "coder") {
    return "The latest Coder dispatch has not produced a fresh coder-completion.md.";
  }
  return "No role dispatch is legal at this checkpoint. Complete the required current Gate or PM-only step first.";
}

async function validateCompletion(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  state: WorkflowControlState,
  candidate: WorkflowProgressDocument
): Promise<void> {
  if (!candidate.flow || candidate.history.length === 0) {
    throw workflowError("WORKFLOW_COMPLETION_INVALID", "An unstarted workflow cannot be completed.");
  }
  const flowRun = resolveFlowRun(state.flowRun, candidate);
  if (flowRun.activeBranch === candidate.flow) {
    throw workflowError(
      "WORKFLOW_COMPLETION_INVALID",
      `${candidate.flow} is an active branch and must return to ${flowRun.rootFlow} before completion.`
    );
  }
  if (candidate.flow === "code-change" || candidate.flow === "architect-debug") {
    const acceptance = await artifactState(fs, input, "final-acceptance.md", "final-acceptance");
    if (!evidenceProducedAfterActiveDispatch(state, candidate.flow, "architect", "final-acceptance.md", acceptance.hash)
      || (acceptance.value !== "accepted" && acceptance.value !== "accepted-with-known-risks")) {
      throw workflowError("WORKFLOW_COMPLETION_INVALID", "Final Acceptance is not accepted for this complete delivery flow.");
    }
    return;
  }
  if (candidate.flow === "architecture-diagnosis") {
    const diagnosis = await artifactState(fs, input, "architecture-diagnosis.md", "architecture-diagnosis");
    if (diagnosis.disposition === "analysis completed"
      && evidenceProducedAfterActiveDispatch(
        state,
        candidate.flow,
        "architect",
        "architecture-diagnosis.md",
        diagnosis.hash
      )) return;
    const acceptance = await artifactState(fs, input, "final-acceptance.md", "final-acceptance");
    if (!evidenceProducedAfterActiveDispatch(state, candidate.flow, "architect", "final-acceptance.md", acceptance.hash)
      || (acceptance.value !== "accepted" && acceptance.value !== "accepted-with-known-risks")) {
      throw workflowError("WORKFLOW_COMPLETION_INVALID", "Implemented Architecture Diagnosis requires accepted Final Acceptance evidence.");
    }
    return;
  }
  if (candidate.flow === "docs-only") {
    const docs = await artifactState(fs, input, "docs-update-report.md", "docs-update-report");
    const activeRole = state.activeDispatch?.flow === "docs-only"
      ? state.activeDispatch.targetRole
      : undefined;
    if (!activeRole
      || !evidenceProducedAfterActiveDispatch(state, candidate.flow, activeRole, "docs-update-report.md", docs.hash)
      || !docs.complete || (docs.value !== "synced" && docs.value !== "unchanged")) {
      throw workflowError("WORKFLOW_COMPLETION_INVALID", "Docs-only completion requires a fresh, complete Docs Update Report from the latest assigned role with Decision: synced or Decision: unchanged.");
    }
    return;
  }
  if (candidate.flow === "validation-only") {
    const test = await artifactState(fs, input, "test-report.md", "test-report");
    const gate = await gateState(fs, input, "validation-adequacy");
    if (!evidenceProducedAfterActiveDispatch(state, candidate.flow, "tester", "test-report.md", test.hash)
      || (test.value !== "pass" && test.value !== "fail")
      || !gatePassedForDispatch(state, candidate.flow, "tester", "validation-adequacy", gate)) {
      throw workflowError("WORKFLOW_COMPLETION_INVALID", "Validation-only completion requires a terminal Test Report and a passed Validation Adequacy Gate.");
    }
  }
}

function evidenceProducedAfterActiveDispatch(
  state: WorkflowControlState,
  flow: WorkflowFlow,
  targetRole: DispatchableRole,
  artifact: WorkflowEvidenceArtifact,
  currentHash: string
): boolean {
  const baseline = matchingEvidenceBaseline(state, flow, targetRole);
  return Boolean(baseline && baseline.artifactHashes[artifact] !== currentHash);
}

function validateCandidateAgainstCurrent(current: WorkflowProgressDocument, candidate: WorkflowProgressDocument): void {
  const errors: string[] = [];
  if (candidate.revision !== current.revision + 1) errors.push(`Revision must be ${current.revision + 1}.`);
  if (candidate.flow !== current.flow) errors.push(`Flow must preserve the confirmed value ${current.flow ?? "none"}; use Requested Flow for a start or switch.`);
  if (candidate.status !== current.status && candidate.status !== "completed") errors.push(`Status must remain ${current.status} unless completing the flow.`);
  if (JSON.stringify(candidate.history) !== JSON.stringify(current.history)) errors.push("Dispatch History is append-only and must be copied without changes.");
  if (errors.length > 0) throw progressValidationError(errors);
}

function createUserAuthorization(
  authorizationId: string,
  current: WorkflowProgressDocument,
  candidate: WorkflowProgressDocument,
  effectiveFlow: WorkflowFlow,
  baseHistoryHash: string,
  violation: string,
  authorizationText: string,
  timestamp: string
): WorkflowUserAuthorization {
  return {
    id: authorizationId,
    status: "accepted",
    role: "project-manager",
    operation: "workflow-dispatch",
    baseRevision: current.revision,
    baseHistoryHash,
    requestedFlow: candidate.proposal!.requestedFlow,
    effectiveFlow,
    targetRole: candidate.proposal!.targetRole,
    evidence: candidate.proposal!.evidence,
    violatedRule: violation,
    authorizationText,
    createdAt: timestamp
  };
}

async function readProgress(fs: FileSystemAdapter, input: WorkflowControlContext): Promise<WorkflowProgressDocument> {
  const target = progressPath(input);
  if (!(await fs.pathExists(target))) return parseWorkflowProgress(renderWorkflowProgressTemplate(input.taskSlug), input.taskSlug);
  return parseWorkflowProgress(await fs.readText(target), input.taskSlug);
}

async function ensureProgressFile(
  fs: FileSystemAdapter,
  input: WorkflowControlContext
): Promise<string | undefined> {
  const target = progressPath(input);
  if (!(await fs.pathExists(target))) {
    await writeAtomic(fs, target, renderWorkflowProgressTemplate(input.taskSlug));
    return undefined;
  }
  try {
    parseWorkflowProgress(await fs.readText(target), input.taskSlug);
    return undefined;
  } catch (error) {
    return `Workflow Progress is invalid and was preserved unchanged: ${errorMessage(error)}`;
  }
}

function parseHistory(value: string | undefined, errors: string[]): WorkflowDispatchHistoryEntry[] {
  if (!value || value.trim() === "none") return [];
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== HISTORY_HEADER || lines[1] !== HISTORY_SEPARATOR) {
    errors.push("Dispatch History must use the exact VCM table header.");
    return [];
  }
  const entries: WorkflowDispatchHistoryEntry[] = [];
  for (const line of lines.slice(2)) {
    const cells = line.startsWith("|") && line.endsWith("|")
      ? line.slice(1, -1).split("|").map((cell) => cell.trim())
      : [];
    if (cells.length !== 6) {
      errors.push("Every Dispatch History row must contain exactly six columns.");
      continue;
    }
    const sequence = Number(cells[0]);
    const flow = asFlow(cells[1]);
    const targetRole = asTargetRole(cells[2]);
    if (!Number.isInteger(sequence) || sequence !== entries.length + 1 || !flow || !targetRole || !cells[3]) {
      errors.push("Dispatch History rows require consecutive sequence, valid flow, target role, and evidence.");
      continue;
    }
    entries.push({
      sequence,
      flow,
      targetRole,
      evidence: cells[3],
      overrideAuthorizationId: cells[4] === "none" ? undefined : cells[4],
      confirmedAt: cells[5] === "none" ? undefined : cells[5]
    });
  }
  return entries;
}

function normalizeState(value: unknown, taskSlug: string, timestamp: string): WorkflowControlState {
  if (!isRecord(value) || value.version !== 1 || value.taskSlug !== taskSlug) {
    return { ...emptyState(taskSlug, timestamp), warnings: ["Workflow control state has an unsupported shape."] };
  }
  const pendingDispatch = value.pendingDispatch === null
    ? null
    : isPendingDispatch(value.pendingDispatch) ? value.pendingDispatch : undefined;
  const userAuthorizations = Array.isArray(value.userAuthorizations)
    && value.userAuthorizations.every(isUserAuthorization)
    ? value.userAuthorizations
    : value.userAuthorizations === undefined && Array.isArray(value.overrideRequests)
      ? []
    : undefined;
  const activeDispatch = value.activeDispatch === undefined || value.activeDispatch === null
    ? null
    : normalizeDispatchEvidenceBaseline(value.activeDispatch);
  const flowRun = value.flowRun === undefined || value.flowRun === null
    ? null
    : isFlowRun(value.flowRun) ? value.flowRun : undefined;
  const awaitingUser = value.awaitingUser === undefined || value.awaitingUser === null
    ? null
    : isAwaitingUser(value.awaitingUser) ? value.awaitingUser : undefined;
  if (
    pendingDispatch === undefined
    || activeDispatch === undefined
    || flowRun === undefined
    || userAuthorizations === undefined
    || awaitingUser === undefined
  ) {
    return { ...emptyState(taskSlug, timestamp), warnings: ["Workflow control state has an unsupported shape."] };
  }
  return {
    version: 1,
    taskSlug,
    awaitingUser,
    pendingDispatch,
    activeDispatch,
    flowRun,
    userAuthorizations,
    warnings: [],
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : timestamp
  };
}

function emptyState(taskSlug: string, timestamp: string): WorkflowControlState {
  return {
    version: 1,
    taskSlug,
    awaitingUser: null,
    pendingDispatch: null,
    activeDispatch: null,
    flowRun: null,
    userAuthorizations: [],
    warnings: [],
    updatedAt: timestamp
  };
}

function resolveEffectiveFlow(current: WorkflowFlow | undefined, requested: WorkflowFlow | undefined): WorkflowFlow {
  if (requested) return requested;
  if (current) return current;
  throw workflowError("WORKFLOW_FLOW_REQUIRED", "Requested Flow is required for the first role dispatch.");
}

function expectedRoutePath(handoffDir: string, role: DispatchableRole): string {
  return path.posix.join(handoffDir, "messages", `project-manager-${role}.md`);
}

function statePath(input: WorkflowControlContext): string {
  return path.join(input.taskRepoRoot, input.stateRoot, "workflow-control.json");
}

function relativeProgressPath(input: WorkflowControlContext): string {
  return path.posix.join(input.handoffDir, "workflow-progress.md");
}

function progressPath(input: WorkflowControlContext): string {
  return resolveRepoPath(input.taskRepoRoot, relativeProgressPath(input));
}

function historyHash(history: WorkflowDispatchHistoryEntry[]): string {
  return contentHash(JSON.stringify(history));
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function field(content: string, name: string): string | undefined {
  return rawField(content, name)?.toLowerCase();
}

function rawField(content: string, name: string): string | undefined {
  return new RegExp(`^${escapeRegExp(name)}:\\s*(.*?)\\s*$`, "mi").exec(content)?.[1]?.trim();
}

function integerField(content: string, name: string): number | undefined {
  const value = rawField(content, name);
  return value && /^\d+$/.test(value) ? Number(value) : undefined;
}

function asFlow(value: string | undefined): WorkflowFlow | undefined {
  return WORKFLOW_FLOWS.includes(value as WorkflowFlow) ? value as WorkflowFlow : undefined;
}

function asTargetRole(value: string | undefined): DispatchableRole | undefined {
  return TARGET_ROLES.has(value as DispatchableRole) ? value as DispatchableRole : undefined;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "&#124;").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function failOnStateWarnings(state: WorkflowControlState): void {
  if (state.warnings.length > 0) throw workflowError("WORKFLOW_STATE_INVALID", state.warnings.join(" "));
}

function failWhileAwaitingUser(state: WorkflowControlState): void {
  if (!state.awaitingUser) return;
  throw workflowError(
    "WORKFLOW_AWAITING_USER",
    "Project Manager is waiting for the user's answer and cannot advance the workflow.",
    "Wait for a new direct user message. The previous workflow approval was canceled; request a fresh approval after the answer arrives."
  );
}

function progressValidationError(errors: string[]): VcmError {
  return workflowError("WORKFLOW_PROGRESS_INVALID", `Workflow Progress validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}

function workflowError(code: string, message: string, hint?: string): VcmError {
  return new VcmError({
    code,
    message,
    hint,
    statusCode: code.includes("PENDING") || code.includes("AWAITING_USER") ? 409 : 422
  });
}

async function writeAtomic(fs: FileSystemAdapter, target: string, content: string): Promise<void> {
  if (fs.writeTextAtomic) await fs.writeTextAtomic(target, content);
  else await fs.writeText(target, content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isAwaitingUser(value: unknown): value is WorkflowControlState["awaitingUser"] {
  return isRecord(value)
    && typeof value.question === "string"
    && value.question.trim().length > 0
    && typeof value.requestedAt === "string";
}

function isPendingDispatch(value: unknown): value is WorkflowPendingDispatch {
  if (!isRecord(value)) return false;
  return Number.isInteger(value.revision)
    && typeof value.baseHistoryHash === "string"
    && Boolean(asFlow(typeof value.effectiveFlow === "string" ? value.effectiveFlow : undefined))
    && (value.requestedFlow === undefined || Boolean(asFlow(typeof value.requestedFlow === "string" ? value.requestedFlow : undefined)))
    && Boolean(asTargetRole(typeof value.targetRole === "string" ? value.targetRole : undefined))
    && typeof value.evidence === "string"
    && typeof value.expectedRoutePath === "string"
    && (value.overrideAuthorizationId === undefined || typeof value.overrideAuthorizationId === "string")
    && (value.status === "pending" || value.status === "dispatching")
    && (value.routeContentHash === undefined || typeof value.routeContentHash === "string")
    && (value.messageId === undefined || typeof value.messageId === "string")
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string";
}

function isUserAuthorization(value: unknown): value is WorkflowUserAuthorization {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && (value.status === "accepted" || value.status === "consumed")
    && value.role === "project-manager"
    && value.operation === "workflow-dispatch"
    && Number.isInteger(value.baseRevision)
    && typeof value.baseHistoryHash === "string"
    && (value.requestedFlow === undefined || Boolean(asFlow(typeof value.requestedFlow === "string" ? value.requestedFlow : undefined)))
    && Boolean(asFlow(typeof value.effectiveFlow === "string" ? value.effectiveFlow : undefined))
    && Boolean(asTargetRole(typeof value.targetRole === "string" ? value.targetRole : undefined))
    && typeof value.evidence === "string"
    && typeof value.violatedRule === "string"
    && typeof value.authorizationText === "string"
    && typeof value.createdAt === "string"
    && (value.consumedAt === undefined || typeof value.consumedAt === "string");
}

function normalizeDispatchEvidenceBaseline(value: unknown): WorkflowDispatchEvidenceBaseline | undefined {
  if (!isRecord(value) || !isRecord(value.artifactHashes) || !isRecord(value.gateFingerprints)) return undefined;
  const artifactHashes = value.artifactHashes;
  const gateFingerprints = value.gateFingerprints;
  if (!(Number.isInteger(value.sequence)
    && Boolean(asFlow(typeof value.flow === "string" ? value.flow : undefined))
    && Boolean(asTargetRole(typeof value.targetRole === "string" ? value.targetRole : undefined))
    && WORKFLOW_EVIDENCE_GATES.every((gate) => typeof gateFingerprints[gate] === "string")
    && typeof value.confirmedAt === "string")) return undefined;
  return {
    sequence: Number(value.sequence),
    flow: value.flow as WorkflowFlow,
    targetRole: value.targetRole as DispatchableRole,
    artifactHashes: Object.fromEntries(WORKFLOW_EVIDENCE_ARTIFACTS.map((artifact) => [
      artifact,
      typeof artifactHashes[artifact] === "string" ? artifactHashes[artifact] : MISSING_EVIDENCE_HASH
    ])) as Record<WorkflowEvidenceArtifact, string>,
    gateFingerprints: Object.fromEntries(WORKFLOW_EVIDENCE_GATES.map((gate) => [
      gate,
      gateFingerprints[gate] as string
    ])) as Record<WorkflowEvidenceGate, string>,
    confirmedAt: value.confirmedAt as string
  };
}

function isFlowRun(value: unknown): value is WorkflowFlowRun {
  if (!isRecord(value)) return false;
  const rootFlow = asFlow(typeof value.rootFlow === "string" ? value.rootFlow : undefined);
  const activeBranch = value.activeBranch;
  const resumedFromBranch = value.resumedFromBranch;
  return Boolean(rootFlow)
    && (activeBranch === undefined || activeBranch === "architect-debug" || activeBranch === "architecture-diagnosis")
    && (resumedFromBranch === undefined
      || resumedFromBranch === "architect-debug"
      || resumedFromBranch === "architecture-diagnosis")
    && Number.isInteger(value.startedAtSequence)
    && Number(value.startedAtSequence) >= 1;
}

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index]!)) return index;
  }
  return -1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
