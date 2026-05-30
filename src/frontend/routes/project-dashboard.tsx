import { FormEvent, type ReactNode, useEffect, useState } from "react";
import type { TaskWorkflowReport } from "../../shared/types/api.js";
import type { HarnessApplyResult, HarnessStatusReport } from "../../shared/types/harness.js";
import type { VcmOrchestrationState, VcmRoleMessage } from "../../shared/types/message.js";
import type { ProjectSummary } from "../../shared/types/project.js";
import type { RoleName } from "../../shared/types/role.js";
import type { TaskRecord } from "../../shared/types/task.js";
import { EventLog } from "../components/event-log.js";
import { HarnessPanel } from "../components/harness-panel.js";
import { MessageTimeline, getMessageCounts } from "../components/message-timeline.js";
import { RepoConnectForm } from "../components/repo-connect-form.js";
import { TaskNav } from "../components/task-nav.js";
import { WorkflowPanel } from "../components/workflow-panel.js";

export interface ProjectDashboardProps {
  project: ProjectSummary | null;
  recentRepositoryPaths: string[];
  tasks: TaskRecord[];
  activeTaskSlug: string | null;
  workflow: TaskWorkflowReport | null;
  messages: VcmRoleMessage[];
  orchestration: VcmOrchestrationState | null;
  events: string[];
  harnessStatus: HarnessStatusReport | null;
  harnessApplyResult?: HarnessApplyResult | null;
  busy?: boolean;
  onConnect(repoPath: string): Promise<void>;
  onRefreshHarness(): Promise<void>;
  onApplyHarness(): Promise<void>;
  onCreateTask(input: { taskSlug: string; title?: string }): Promise<void>;
  onSelectTask(taskSlug: string): void;
  onOrchestrationModeChange(mode: VcmOrchestrationState["mode"]): void;
  onStageMessage(message: VcmRoleMessage): void;
  onRejectMessage(message: VcmRoleMessage): void;
  onOpenMessageRole(role: RoleName): void;
}

export function ProjectDashboard({
  project,
  recentRepositoryPaths,
  tasks,
  activeTaskSlug,
  workflow,
  messages,
  orchestration,
  events,
  harnessStatus,
  harnessApplyResult,
  busy,
  onConnect,
  onRefreshHarness,
  onApplyHarness,
  onCreateTask,
  onSelectTask,
  onOrchestrationModeChange,
  onStageMessage,
  onRejectMessage,
  onOpenMessageRole
}: ProjectDashboardProps) {
  const [taskSlug, setTaskSlug] = useState("");
  const [showMessages, setShowMessages] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const messageCounts = getMessageCounts(messages);
  const orchestrationMode = orchestration?.mode ?? "manual";

  async function handleCreateTask(event: FormEvent) {
    event.preventDefault();
    await onCreateTask({ taskSlug });
    setTaskSlug("");
  }

  return (
    <div className="project-dashboard">
      <header className="brand-header">
        <strong>VibeCodingMaster</strong>
      </header>

      <SidebarSection title="Repository Path" defaultOpen={!activeTaskSlug}>
        <RepoConnectForm
          defaultPath={project?.repoRoot ?? ""}
          recentPaths={recentRepositoryPaths}
          busy={busy}
          onConnect={onConnect}
        />
      </SidebarSection>

      {project ? (
        <SidebarSection title="Repository">
          <div className="project-summary">
            <dl>
              <div>
                <dt>Path</dt>
                <dd>{project.repoRoot}</dd>
              </div>
              <div>
                <dt>Branch</dt>
                <dd>{project.branch}</dd>
              </div>
              <div>
                <dt>Working tree</dt>
                <dd>{project.isDirty ? "uncommitted changes" : "clean"}</dd>
              </div>
            </dl>
            {project.warnings.length > 0 ? (
              <ul className="warnings">
                {project.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </SidebarSection>
      ) : null}

      {activeTaskSlug ? (
        <SidebarSection title="Workflow">
          {workflow ? <WorkflowPanel workflow={workflow} /> : <p className="muted">Loading workflow...</p>}
        </SidebarSection>
      ) : null}

      {activeTaskSlug ? (
        <SidebarSection title="Settings">
          <div className="sidebar-settings">
            <button type="button" onClick={() => setShowMessages(true)}>
              <span>Messages</span>
              <span className="muted">
                {messageCounts.pending} pending / {messageCounts.queued} queued
              </span>
            </button>
            <button type="button" onClick={() => setShowEvents(true)}>
              <span>Events</span>
              <span className="muted">{events.length} total</span>
            </button>
            <button
              aria-pressed={orchestrationMode === "auto"}
              className={orchestrationMode === "auto" ? "settings-toggle is-active" : "settings-toggle"}
              disabled={busy}
              type="button"
              onClick={() => onOrchestrationModeChange(orchestrationMode === "auto" ? "manual" : "auto")}
            >
              <span>Auto orchestration</span>
              <span>{orchestrationMode === "auto" ? "on" : "off"}</span>
            </button>
          </div>
        </SidebarSection>
      ) : null}

      {project ? (
        <SidebarSection title="VCM Harness">
          <HarnessPanel
            status={harnessStatus}
            applyResult={harnessApplyResult}
            busy={busy}
            onRefresh={onRefreshHarness}
            onApply={onApplyHarness}
          />
        </SidebarSection>
      ) : null}

      {project ? (
        <SidebarSection title="New Task">
          <div className="task-create">
            <form onSubmit={handleCreateTask}>
              <input
                value={taskSlug}
                onChange={(event) => setTaskSlug(event.target.value)}
                placeholder="task name"
              />
              <button type="submit" disabled={busy || !taskSlug.trim()}>
                Create
              </button>
            </form>
          </div>
        </SidebarSection>
      ) : null}

      {tasks.length > 0 ? (
        <SidebarSection title="Tasks">
          <TaskNav tasks={tasks} activeTaskSlug={activeTaskSlug} onSelect={onSelectTask} />
        </SidebarSection>
      ) : null}

      {showMessages ? (
        <MessageDialog
          busy={busy}
          messages={messages}
          orchestration={orchestration}
          onClose={() => setShowMessages(false)}
          onOpenRole={onOpenMessageRole}
          onReject={onRejectMessage}
          onStage={onStageMessage}
        />
      ) : null}

      {showEvents ? (
        <EventDialog
          events={events}
          onClose={() => setShowEvents(false)}
        />
      ) : null}
    </div>
  );
}

function EventDialog({ events, onClose }: { events: string[]; onClose(): void }) {
  return (
    <div className="modal-backdrop">
      <section className="event-modal" role="dialog" aria-modal="true" aria-label="Events">
        <header>
          <div>
            <h2>Events</h2>
            <p className="muted">{events.length} total</p>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </header>
        <EventLog events={events} maxEvents={null} showHeader={false} />
      </section>
    </div>
  );
}

function MessageDialog({
  busy,
  messages,
  orchestration,
  onClose,
  onOpenRole,
  onReject,
  onStage
}: {
  busy?: boolean;
  messages: VcmRoleMessage[];
  orchestration: VcmOrchestrationState | null;
  onClose(): void;
  onOpenRole(role: RoleName): void;
  onReject(message: VcmRoleMessage): void;
  onStage(message: VcmRoleMessage): void;
}) {
  const counts = getMessageCounts(messages);

  return (
    <div className="modal-backdrop">
      <section className="message-modal" role="dialog" aria-modal="true" aria-label="Messages">
        <header>
          <div>
            <h2>Messages</h2>
            <p className="muted">
              {counts.pending} pending / {counts.queued} queued / {counts.delivered} delivered
              {orchestration ? ` · ${orchestration.mode}${orchestration.paused ? " paused" : ""}` : ""}
            </p>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </header>
        <MessageTimeline
          busy={busy}
          maxMessages={null}
          messages={messages}
          orchestration={orchestration}
          showControls={false}
          showHeader={false}
          onOpenRole={onOpenRole}
          onReject={onReject}
          onStage={onStage}
        />
      </section>
    </div>
  );
}

function SidebarSection({
  children,
  defaultOpen = false,
  title
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  title: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);

  return (
    <section className="sidebar-section">
      <button
        aria-expanded={open}
        className="sidebar-section-toggle"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span>{title}</span>
        <span aria-hidden="true" className="sidebar-section-chevron" />
      </button>
      {open ? <div className="sidebar-section-content">{children}</div> : null}
    </section>
  );
}
