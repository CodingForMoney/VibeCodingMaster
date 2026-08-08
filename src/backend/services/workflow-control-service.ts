import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import { resolveRepoPath } from "../adapters/filesystem.js";
import { VcmError } from "../errors.js";
import type { DispatchableRole } from "../../shared/types/role.js";
import type { GateReviewGateRecord, GateReviewIndex } from "../../shared/types/gate-review.js";
import type {
  WorkflowControlState,
  WorkflowDispatchHistoryEntry,
  WorkflowFlow,
  WorkflowOverrideRequest,
  WorkflowPendingDispatch,
  WorkflowProgressDocument
} from "../../shared/types/workflow.js";
import { WORKFLOW_FLOWS } from "../../shared/types/workflow.js";
import { checkMarkdownArtifact, readArtifactSectionContent } from "../../shared/validation/artifact-check.js";
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
  submitProgress(input: WorkflowControlContext, content: string): Promise<WorkflowProgressSubmissionResult>;
  assertRouteAuthorized(input: WorkflowRouteAuthorizationInput): Promise<void>;
  claimDispatch(input: Required<WorkflowRouteAuthorizationInput>): Promise<void>;
  releaseDispatch(input: WorkflowControlContext, messageId: string): Promise<void>;
  confirmDispatch(input: WorkflowControlContext, messageId: string): Promise<void>;
  approveOverride(input: WorkflowControlContext, overrideId: string, authorizationText: string): Promise<WorkflowControlState>;
  rejectOverride(input: WorkflowControlContext, overrideId: string): Promise<WorkflowControlState>;
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

export function createWorkflowControlService(deps: WorkflowControlServiceDeps): WorkflowControlService {
  const now = deps.now ?? (() => new Date().toISOString());
  const id = deps.id ?? (() => `wfovr_${randomUUID()}`);
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
        await validateCompletion(deps.fs, input, candidate);
        const normalized = renderWorkflowProgress(candidate);
        await writeAtomic(deps.fs, progressPath(input), normalized);
        return { path: relativeProgressPath(input), content: normalized };
      }

      const baseHistoryHash = historyHash(current.history);
      const effectiveFlow = resolveEffectiveFlow(current.flow, candidate.proposal.requestedFlow);
      const verdict = await evaluateTransition(deps.fs, input, current, effectiveFlow, candidate.proposal.targetRole);
      let overrideAuthorizationId: string | undefined;

      if (!verdict.allowed) {
        const authorizationId = candidate.proposal.authorizationId;
        if (authorizationId === "request") {
          const existingPending = state.overrideRequests.find((entry) => entry.status === "pending");
          if (existingPending) {
            throw workflowError(
              "WORKFLOW_OVERRIDE_PENDING",
              `Workflow override ${existingPending.id} is already waiting for the user's decision.`,
              "Wait for the current user decision before requesting another workflow override."
            );
          }
          const quote = candidate.proposal.authorizationQuote?.trim();
          const violatedRule = candidate.proposal.violatedRule?.trim();
          if (!quote || !violatedRule || violatedRule !== verdict.reason) {
            throw workflowError(
              "WORKFLOW_OVERRIDE_REQUEST_INVALID",
              `Override request must include the proposed user authorization and the exact violated rule: ${verdict.reason}`,
              "Copy the rejection reason exactly into Violated Rule and record the user's proposed authorization text."
            );
          }
          const pending = createOverrideRequest(
            id(), current, candidate, effectiveFlow, baseHistoryHash, verdict.reason, quote, now()
          );
          const next = {
            ...state,
            overrideRequests: [...state.overrideRequests, pending],
            updatedAt: now()
          };
          await saveState(input, next);
          throw workflowError(
            "WORKFLOW_OVERRIDE_PENDING",
            `Workflow override ${pending.id} requires direct user confirmation in VCM.`,
            "Wait for the user's decision. If approved, resubmit with the returned Authorization ID and exact authorization text."
          );
        }
        if (authorizationId && authorizationId !== "none") {
          const override = state.overrideRequests.find((entry) => entry.id === authorizationId);
          validateApprovedOverride(override, current, candidate, effectiveFlow, baseHistoryHash, verdict.reason);
          overrideAuthorizationId = override!.id;
        } else {
          throw workflowError(
            "WORKFLOW_TRANSITION_DENIED",
            verdict.reason,
            verdict.allowedTransitions.length > 0
              ? `Allowed next dispatches: ${verdict.allowedTransitions.join(", ")}. Recheck the flow, or request an exact one-time user override.`
              : "No role dispatch is legal at this checkpoint. Complete the required Gate, user decision, or PM-only step first."
          );
        }
      } else if (candidate.proposal.authorizationId && candidate.proposal.authorizationId !== "none") {
        throw workflowError(
          "WORKFLOW_OVERRIDE_NOT_REQUIRED",
          "This workflow transition is legal and must not consume a user override.",
          "Set every User Override field to none."
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
        proposal: {
          ...candidate.proposal,
          authorizationId: overrideAuthorizationId,
          authorizationQuote: overrideAuthorizationId
            ? state.overrideRequests.find((entry) => entry.id === overrideAuthorizationId)?.authorizationText
            : undefined,
          violatedRule: overrideAuthorizationId ? verdict.reason : undefined
        }
      };
      const normalized = renderWorkflowProgress(accepted);
      await writeAtomic(deps.fs, progressPath(input), normalized);
      await saveState(input, {
        ...state,
        pendingDispatch,
        updatedAt: timestamp
      });
      return { path: relativeProgressPath(input), content: normalized };
    });
  }

  async function assertRouteAuthorized(input: WorkflowRouteAuthorizationInput): Promise<void> {
    const state = await getState(input);
    failOnStateWarnings(state);
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
      const completed: WorkflowProgressDocument = {
        ...current,
        flow: pending.effectiveFlow,
        status: "active",
        history: [...current.history, entry],
        proposal: undefined
      };
      const overrideRequests = state.overrideRequests.map((entry) =>
        entry.id === pending.overrideAuthorizationId
          ? { ...entry, status: "consumed" as const, consumedAt: timestamp }
          : entry
      );
      await writeAtomic(deps.fs, progressPath(input), renderWorkflowProgress(completed));
      await saveState(input, {
        ...state,
        pendingDispatch: null,
        overrideRequests,
        updatedAt: timestamp
      });
    });
  }

  async function approveOverride(
    input: WorkflowControlContext,
    overrideId: string,
    authorizationText: string
  ): Promise<WorkflowControlState> {
    return decideOverride(input, overrideId, "approved", authorizationText);
  }

  async function rejectOverride(input: WorkflowControlContext, overrideId: string): Promise<WorkflowControlState> {
    return decideOverride(input, overrideId, "rejected");
  }

  async function decideOverride(
    input: WorkflowControlContext,
    overrideId: string,
    decision: "approved" | "rejected",
    authorizationText?: string
  ): Promise<WorkflowControlState> {
    return withLock(statePath(input), async () => {
      const state = await getState(input);
      failOnStateWarnings(state);
      const existing = state.overrideRequests.find((entry) => entry.id === overrideId);
      if (!existing || existing.status !== "pending") {
        throw workflowError(
          "WORKFLOW_OVERRIDE_NOT_PENDING",
          `Workflow override ${overrideId} is not pending.`,
          "Refresh the task state and act only on the current pending override."
        );
      }
      const normalizedAuthorization = authorizationText?.trim();
      if (decision === "approved" && !normalizedAuthorization) {
        throw workflowError(
          "WORKFLOW_OVERRIDE_AUTHORIZATION_REQUIRED",
          "Direct user authorization text is required.",
          "Describe the exact one-time workflow exception being authorized."
        );
      }
      const timestamp = now();
      const next: WorkflowControlState = {
        ...state,
        overrideRequests: state.overrideRequests.map((entry) => entry.id === overrideId
          ? {
              ...entry,
              status: decision,
              authorizationText: decision === "approved" ? normalizedAuthorization : undefined,
              decidedAt: timestamp
            }
          : entry),
        updatedAt: timestamp
      };
      await saveState(input, next);
      return next;
    });
  }

  return {
    getState,
    submitProgress,
    assertRouteAuthorized,
    claimDispatch,
    releaseDispatch,
    confirmDispatch,
    approveOverride,
    rejectOverride
  };

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

  const overrideSection = readArtifactSectionContent(content, "User Override") ?? "";
  const authorizationId = rawField(overrideSection, "Authorization ID");
  const authorizationQuote = rawField(overrideSection, "Authorization Quote");
  const violatedRule = rawField(overrideSection, "Violated Rule");
  if (!authorizationId || !authorizationQuote || !violatedRule) {
    errors.push("User Override requires Authorization ID, Authorization Quote, and Violated Rule fields.");
  } else if (proposal) {
    const allNone = authorizationId === "none" && authorizationQuote === "none" && violatedRule === "none";
    const allSet = authorizationId !== "none" && authorizationQuote !== "none" && violatedRule !== "none";
    if (!allNone && !allSet) errors.push("User Override fields must all be none or all contain the exact override data.");
    if (allSet) {
      proposal.authorizationId = authorizationId;
      proposal.authorizationQuote = authorizationQuote;
      proposal.violatedRule = violatedRule;
    }
  } else if (authorizationId !== "none" || authorizationQuote !== "none" || violatedRule !== "none") {
    errors.push("User Override fields must be none when no role dispatch is proposed.");
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

## User Override

Authorization ID: ${proposal?.authorizationId ?? "none"}
Authorization Quote: ${proposal?.authorizationQuote ?? "none"}
Violated Rule: ${proposal?.violatedRule ?? "none"}
`;
}

async function evaluateTransition(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  current: WorkflowProgressDocument,
  effectiveFlow: WorkflowFlow,
  targetRole: DispatchableRole
): Promise<{ allowed: boolean; reason: string; allowedTransitions: string[] }> {
  const allowedTransitions = await getAllowedTransitions(fs, input, current);
  const signature = `${effectiveFlow}/${targetRole}`;
  if (allowedTransitions.includes(signature)) return { allowed: true, reason: "allowed", allowedTransitions };
  return {
    allowed: false,
    reason: `Transition ${signature} is not legal after the confirmed Workflow Progress history.`,
    allowedTransitions
  };
}

async function getAllowedTransitions(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  current: WorkflowProgressDocument
): Promise<string[]> {
  if (current.status === "completed") return [];
  if (!current.flow || current.history.length === 0) {
    return [
      "code-change/architect",
      "architect-debug/architect",
      "architecture-diagnosis/architect",
      "docs-only/architect",
      "validation-only/tester"
    ];
  }
  const flow = current.flow;
  if (flow === "docs-only") {
    const docs = await artifactState(fs, input, "docs-sync-report.md", "docs-sync-report");
    return docs.complete && (docs.value === "synced" || docs.value === "unchanged")
      ? []
      : ["docs-only/architect", "code-change/architect", "validation-only/tester"];
  }
  if (flow === "validation-only") {
    const test = await artifactState(fs, input, "test-report.md", "test-report");
    if (test.infrastructure === "production-change-required") return ["code-change/architect"];
    if (test.value === "incomplete" || test.infrastructure === "repair-required") return ["validation-only/tester"];
    const validationGate = await gateState(fs, input, "validation-adequacy");
    if (validationGate?.decision === "request_changes") return ["validation-only/tester"];
    if (!gatePassed(validationGate)) return [];
    return [];
  }
  const segment = current.history.slice(findLastIndex(current.history, (entry) => entry.flow !== flow) + 1);
  if (flow === "code-change") return allowedCodeChange(fs, input, current.history);
  if (flow === "architect-debug") return allowedArchitectFix(fs, input, current, segment, "architect-debug");
  return allowedArchitectFix(fs, input, current, segment, "architecture-diagnosis");
}

async function allowedCodeChange(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  segment: WorkflowDispatchHistoryEntry[]
): Promise<string[]> {
  const coderIndex = findLastIndex(segment, (entry) => entry.targetRole === "coder");
  const testerIndex = findLastIndex(segment, (entry) => entry.targetRole === "tester");
  if (coderIndex < 0) {
    const plan = await artifactState(fs, input, "architecture-plan.md", "architecture-plan");
    const gate = await gateState(fs, input, "architecture-plan");
    if (plan.value !== "complete") return ["code-change/architect"];
    if (gate?.decision === "request_changes") return ["code-change/architect"];
    return gatePassed(gate) ? ["code-change/coder"] : [];
  }
  if (testerIndex < coderIndex) {
    const coder = await artifactState(fs, input, "coder-completion.md", "coder-completion");
    if (coder.value === "failed") return ["architect-debug/architect"];
    return coder.value === "ready_for_review" ? ["code-change/tester"] : ["code-change/coder"];
  }
  const architectsAfterTester = segment.filter((entry, index) => index > testerIndex && entry.targetRole === "architect");
  if (architectsAfterTester.length > 0) {
    const docs = await artifactState(fs, input, "docs-sync-report.md", "docs-sync-report");
    if (docs.value === "synced" || docs.value === "unchanged") {
      const acceptance = await artifactState(fs, input, "final-acceptance.md", "final-acceptance");
      if (acceptance.value === "needs-coder-follow-up") return ["code-change/coder"];
      if (acceptance.value === "needs-docs-sync") return ["code-change/architect"];
      if (acceptance.value === "needs-architect-follow-up") {
        if (architectsAfterTester.length === 1) return ["code-change/architect"];
        return allowedArchitectureFollowup(fs, input, architectsAfterTester[1]?.confirmedAt);
      }
      return [];
    }
    return ["code-change/architect"];
  }
  return allowedAfterTester(fs, input, "coder", {
    testerFailureFlow: "architect-debug",
    implementationFailureFlow: "architect-debug",
    successTarget: "code-change/architect"
  });
}

async function allowedArchitectureFollowup(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  followupDispatchedAt: string | undefined
): Promise<string[]> {
  const plan = await artifactState(fs, input, "architecture-plan.md", "architecture-plan");
  if (plan.value !== "complete") return ["code-change/architect"];
  const gate = await gateState(fs, input, "architecture-plan");
  if (!gate || !followupDispatchedAt || gate.updatedAt <= followupDispatchedAt) return [];
  if (gate.decision === "request_changes") return ["code-change/architect"];
  return gatePassed(gate) ? ["code-change/coder"] : [];
}

async function allowedArchitectFix(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  current: WorkflowProgressDocument,
  segment: WorkflowDispatchHistoryEntry[],
  source: "architect-debug" | "architecture-diagnosis"
): Promise<string[]> {
  const architectIndex = findLastIndex(segment, (entry) => entry.targetRole === "architect");
  const testerIndex = findLastIndex(segment, (entry) => entry.targetRole === "tester");
  if (architectIndex < 0) return [`${source}/architect`];
  if (testerIndex < 0) {
    const artifact = source === "architect-debug"
      ? await artifactState(fs, input, "architect-debug.md", "architect-debug")
      : await artifactState(fs, input, "architecture-diagnosis.md", "architecture-diagnosis");
    if (source === "architect-debug" && artifact.disposition === "normal architecture plan required") {
      return ["code-change/architect"];
    }
    return artifact.complete ? [`${source}/tester`] : [`${source}/architect`];
  }
  if (architectIndex > testerIndex) {
    const codeDiff = await gateState(fs, input, "code-diff");
    if (codeDiff?.decision === "request_changes") return [`${source}/tester`];
    const docs = await artifactState(fs, input, "docs-sync-report.md", "docs-sync-report");
    return docs.value === "synced" || docs.value === "unchanged" ? [] : [`${source}/architect`];
  }
  const parentCodeChange = current.history.slice(0, -segment.length).some((entry) => entry.flow === "code-change");
  return allowedAfterTester(fs, input, source, {
    testerFailureFlow: source === "architect-debug" ? "architecture-diagnosis" : undefined,
    implementationFailureFlow: source,
    successTarget: parentCodeChange ? "code-change/architect" : `${source}/architect`
  });
}

async function allowedAfterTester(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  codeSource: "coder" | "architect-debug" | "architecture-diagnosis",
  options: {
    testerFailureFlow?: "architect-debug" | "architecture-diagnosis";
    implementationFailureFlow?: "architect-debug" | "architecture-diagnosis";
    successTarget: string;
  }
): Promise<string[]> {
  const test = await artifactState(fs, input, "test-report.md", "test-report");
  const currentFlow = codeSource === "coder" ? "code-change" : codeSource;
  if (test.value === "incomplete" || test.infrastructure === "repair-required") return [`${currentFlow}/tester`];
  if (test.value === "fail" && test.infrastructure !== "repair-required") {
    return options.testerFailureFlow ? [`${options.testerFailureFlow}/architect`] : [];
  }
  const validation = await gateState(fs, input, "validation-adequacy");
  if (validation?.decision === "request_changes") return [`${currentFlow}/tester`];
  if (!gatePassed(validation)) return [];
  const codeDiff = await gateState(fs, input, "code-diff");
  if (codeDiff?.decision === "request_changes") {
    const scopes = new Set(codeDiff.findings?.map((finding) => finding.scope).filter(Boolean));
    return scopes.size === 1 && scopes.has("test-only")
      ? [`${currentFlow}/tester`]
      : options.implementationFailureFlow ? [`${options.implementationFailureFlow}/architect`] : [];
  }
  if (!gatePassed(codeDiff)) return [];
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
): Promise<{ complete: boolean; value?: string; infrastructure?: string; disposition?: string }> {
  const relative = path.posix.join(input.handoffDir, fileName);
  const absolute = resolveRepoPath(input.taskRepoRoot, relative);
  if (!(await fs.pathExists(absolute))) return { complete: false };
  const content = await fs.readText(absolute);
  const check = checkMarkdownArtifact(kind, relative, content, { mode: "final" });
  const inline = (name: string) => new RegExp(`^${name}:\\s*(.+?)\\s*$`, "mi").exec(content)?.[1]?.trim().toLowerCase();
  let value: string | undefined;
  if (kind === "architecture-plan") value = inline("Planning Result");
  if (kind === "coder-completion") value = inline("Decision");
  if (kind === "architect-debug") value = inline("Status") ?? readArtifactSectionContent(content, "Final Disposition")?.trim().toLowerCase();
  if (kind === "architecture-diagnosis") value = readArtifactSectionContent(content, "Final Disposition")?.trim().toLowerCase();
  if (kind === "test-report") value = inline("Test Result");
  if (kind === "docs-sync-report" || kind === "final-acceptance") value = readArtifactSectionContent(content, "Decision")?.trim().toLowerCase();
  const infrastructure = kind === "test-report"
    ? /^Status:\s*(.+?)\s*$/mi.exec(readArtifactSectionContent(content, "Test Infrastructure") ?? "")?.[1]?.trim().toLowerCase()
    : undefined;
  const disposition = kind === "architect-debug" || kind === "architecture-diagnosis"
    ? readArtifactSectionContent(content, "Final Disposition")?.trim().toLowerCase()
    : undefined;
  return { complete: check.status === "ok", value, infrastructure, disposition };
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

function gatePassed(record: GateReviewGateRecord | undefined): boolean {
  return Boolean(record && (
    FINAL_GATE_STATUSES.has(record.status)
    || (record.status === "completed" && record.decision === "approve")
  ));
}

async function validateCompletion(
  fs: FileSystemAdapter,
  input: WorkflowControlContext,
  candidate: WorkflowProgressDocument
): Promise<void> {
  if (!candidate.flow || candidate.history.length === 0) {
    throw workflowError("WORKFLOW_COMPLETION_INVALID", "An unstarted workflow cannot be completed.");
  }
  if (candidate.flow === "code-change" || candidate.flow === "architect-debug") {
    const acceptance = await artifactState(fs, input, "final-acceptance.md", "final-acceptance");
    if (acceptance.value !== "accepted" && acceptance.value !== "accepted-with-known-risks") {
      throw workflowError("WORKFLOW_COMPLETION_INVALID", "Final Acceptance is not accepted for this complete delivery flow.");
    }
    return;
  }
  if (candidate.flow === "architecture-diagnosis") {
    const diagnosis = await artifactState(fs, input, "architecture-diagnosis.md", "architecture-diagnosis");
    if (diagnosis.disposition === "analysis completed") return;
    const acceptance = await artifactState(fs, input, "final-acceptance.md", "final-acceptance");
    if (acceptance.value !== "accepted" && acceptance.value !== "accepted-with-known-risks") {
      throw workflowError("WORKFLOW_COMPLETION_INVALID", "Implemented Architecture Diagnosis requires accepted Final Acceptance evidence.");
    }
    return;
  }
  if (candidate.flow === "docs-only") {
    const docs = await artifactState(fs, input, "docs-sync-report.md", "docs-sync-report");
    if (!docs.complete || (docs.value !== "synced" && docs.value !== "unchanged")) {
      throw workflowError("WORKFLOW_COMPLETION_INVALID", "Docs-only completion requires a complete Docs Sync Report with Decision: synced or Decision: unchanged.");
    }
    return;
  }
  if (candidate.flow === "validation-only") {
    const test = await artifactState(fs, input, "test-report.md", "test-report");
    const gate = await gateState(fs, input, "validation-adequacy");
    if ((test.value !== "pass" && test.value !== "fail") || !gatePassed(gate)) {
      throw workflowError("WORKFLOW_COMPLETION_INVALID", "Validation-only completion requires a terminal Test Report and a passed Validation Adequacy Gate.");
    }
  }
}

function validateCandidateAgainstCurrent(current: WorkflowProgressDocument, candidate: WorkflowProgressDocument): void {
  const errors: string[] = [];
  if (candidate.revision !== current.revision + 1) errors.push(`Revision must be ${current.revision + 1}.`);
  if (candidate.flow !== current.flow) errors.push(`Flow must preserve the confirmed value ${current.flow ?? "none"}; use Requested Flow for a start or switch.`);
  if (candidate.status !== current.status && candidate.status !== "completed") errors.push(`Status must remain ${current.status} unless completing the flow.`);
  if (JSON.stringify(candidate.history) !== JSON.stringify(current.history)) errors.push("Dispatch History is append-only and must be copied without changes.");
  if (errors.length > 0) throw progressValidationError(errors);
}

function validateApprovedOverride(
  override: WorkflowOverrideRequest | undefined,
  current: WorkflowProgressDocument,
  candidate: WorkflowProgressDocument,
  effectiveFlow: WorkflowFlow,
  baseHistoryHash: string,
  violation: string
): void {
  const proposal = candidate.proposal!;
  if (!override || override.status !== "approved") throw workflowError("WORKFLOW_OVERRIDE_INVALID", "The supplied workflow override is not approved.");
  if (
    override.baseRevision !== current.revision
    || override.baseHistoryHash !== baseHistoryHash
    || override.effectiveFlow !== effectiveFlow
    || override.requestedFlow !== proposal.requestedFlow
    || override.targetRole !== proposal.targetRole
    || override.evidence !== proposal.evidence
    || override.violatedRule !== violation
    || override.authorizationText !== proposal.authorizationQuote
    || proposal.violatedRule !== violation
  ) {
    throw workflowError("WORKFLOW_OVERRIDE_MISMATCH", "The approved override does not match this exact workflow transition.");
  }
}

function createOverrideRequest(
  overrideId: string,
  current: WorkflowProgressDocument,
  candidate: WorkflowProgressDocument,
  effectiveFlow: WorkflowFlow,
  baseHistoryHash: string,
  violation: string,
  quote: string,
  timestamp: string
): WorkflowOverrideRequest {
  return {
    id: overrideId,
    status: "pending",
    baseRevision: current.revision,
    baseHistoryHash,
    requestedFlow: candidate.proposal!.requestedFlow,
    effectiveFlow,
    targetRole: candidate.proposal!.targetRole,
    evidence: candidate.proposal!.evidence,
    violatedRule: violation,
    proposedAuthorizationQuote: quote,
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
  const overrideRequests = Array.isArray(value.overrideRequests)
    && value.overrideRequests.every(isOverrideRequest)
    ? value.overrideRequests
    : undefined;
  if (pendingDispatch === undefined || overrideRequests === undefined) {
    return { ...emptyState(taskSlug, timestamp), warnings: ["Workflow control state has an unsupported shape."] };
  }
  return {
    version: 1,
    taskSlug,
    pendingDispatch,
    overrideRequests,
    warnings: [],
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : timestamp
  };
}

function emptyState(taskSlug: string, timestamp: string): WorkflowControlState {
  return { version: 1, taskSlug, pendingDispatch: null, overrideRequests: [], warnings: [], updatedAt: timestamp };
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
  return createHash("sha256").update(JSON.stringify(history)).digest("hex");
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

function progressValidationError(errors: string[]): VcmError {
  return workflowError("WORKFLOW_PROGRESS_INVALID", `Workflow Progress validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}

function workflowError(code: string, message: string, hint?: string): VcmError {
  return new VcmError({ code, message, hint, statusCode: code.includes("PENDING") ? 409 : 422 });
}

async function writeAtomic(fs: FileSystemAdapter, target: string, content: string): Promise<void> {
  if (fs.writeTextAtomic) await fs.writeTextAtomic(target, content);
  else await fs.writeText(target, content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

function isOverrideRequest(value: unknown): value is WorkflowOverrideRequest {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && ["pending", "approved", "rejected", "consumed"].includes(String(value.status))
    && Number.isInteger(value.baseRevision)
    && typeof value.baseHistoryHash === "string"
    && (value.requestedFlow === undefined || Boolean(asFlow(typeof value.requestedFlow === "string" ? value.requestedFlow : undefined)))
    && Boolean(asFlow(typeof value.effectiveFlow === "string" ? value.effectiveFlow : undefined))
    && Boolean(asTargetRole(typeof value.targetRole === "string" ? value.targetRole : undefined))
    && typeof value.evidence === "string"
    && typeof value.violatedRule === "string"
    && typeof value.proposedAuthorizationQuote === "string"
    && (value.authorizationText === undefined || typeof value.authorizationText === "string")
    && typeof value.createdAt === "string"
    && (value.decidedAt === undefined || typeof value.decidedAt === "string")
    && (value.consumedAt === undefined || typeof value.consumedAt === "string");
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
