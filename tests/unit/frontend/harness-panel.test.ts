import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessPlannedChange, HarnessStatusReport } from "../../../src/shared/types/harness.js";

// HarnessPanel transitively imports the xterm-backed terminal view, which touches
// browser globals (`self`) at module load and cannot evaluate in the node test
// environment. Stub it so we can render the panel markup for the Fixed-install
// three-state contract (F1-F4 in the architecture plan). The Bootstrap stage that
// owns XtermView is out of scope for this task.
vi.mock("../../../src/frontend/terminal/xterm-view.js", () => ({
  XtermView: () => null
}));

const { HarnessPanel } = await import("../../../src/frontend/components/harness-panel.js");

const baseProps = {
  bootstrapStatus: null,
  applyResult: null,
  taskSyncResult: null,
  onRefresh: async () => {},
  onApply: async () => {},
  onCommitAndRebaseTask: async () => {},
  onStartBootstrap: async () => {}
};

function makeStatus(overrides: Partial<HarnessStatusReport>): HarnessStatusReport {
  return {
    version: 1,
    initialized: false,
    files: [],
    needsApply: false,
    plannedChanges: [],
    warnings: [],
    ...overrides
  };
}

function change(path: string, action: HarnessPlannedChange["action"]): HarnessPlannedChange {
  return { path, action };
}

function render(status: HarnessStatusReport, busy = false): string {
  return renderToStaticMarkup(
    createElement(HarnessPanel, { ...baseProps, status, busy } as never)
  );
}

// `>Label</button>` matches a rendered button regardless of its attributes, so it
// will not collide with the Bootstrap stage's static "Refresh harness status..." text.
const initializeButton = ">Initialize</button>";
const refreshButton = ">Refresh</button>";
const updateButton = ">Update</button>";

describe("HarnessPanel fixed-install three-state UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // F1: State A — not initialized.
  it("State A (not initialized): shows only Initialize, no Refresh, no Update, no file list", () => {
    const html = render(
      makeStatus({
        initialized: false,
        needsApply: true,
        plannedChanges: [change("CLAUDE.md", "create")]
      })
    );

    expect(html).toContain("Not initialized");
    expect(html).toContain(initializeButton);
    expect(html).not.toContain(refreshButton);
    expect(html).not.toContain(updateButton);
    expect(html).not.toContain("Files to update");
  });

  // F2: State B — initialized with pending updates.
  it("State B (initialized + needsApply): shows Files to update list + Update + Refresh", () => {
    const html = render(
      makeStatus({
        initialized: true,
        needsApply: true,
        plannedChanges: [change("CLAUDE.md", "update"), change(".gitignore", "insert")]
      })
    );

    expect(html).toContain("2 pending updates");
    expect(html).toContain("Files to update");
    expect(html).toContain("CLAUDE.md");
    expect(html).toContain(".gitignore");
    expect(html).toContain(refreshButton);
    expect(html).toContain(updateButton);
    expect(html).not.toContain(initializeButton);
  });

  // F3: State C — initialized and up to date.
  it("State C (initialized + up to date): shows Up to date + Refresh only, no list, no Update", () => {
    const html = render(
      makeStatus({
        initialized: true,
        needsApply: false,
        plannedChanges: []
      })
    );

    expect(html).toContain("Up to date");
    expect(html).toContain(refreshButton);
    expect(html).not.toContain(updateButton);
    expect(html).not.toContain(initializeButton);
    expect(html).not.toContain("Files to update");
  });

  // F4: busy disables every fixed-install action button.
  it("disables action buttons while busy", () => {
    const stateAHtml = render(
      makeStatus({ initialized: false, needsApply: true, plannedChanges: [change("CLAUDE.md", "create")] }),
      true
    );
    expect(stateAHtml).toContain('disabled="">Initialize</button>');

    const stateBHtml = render(
      makeStatus({ initialized: true, needsApply: true, plannedChanges: [change("CLAUDE.md", "update")] }),
      true
    );
    expect(stateBHtml).toContain('disabled="">Refresh</button>');
    expect(stateBHtml).toContain('disabled="">Update</button>');

    const stateCHtml = render(makeStatus({ initialized: true, needsApply: false }), true);
    expect(stateCHtml).toContain('disabled="">Refresh</button>');
  });

  it("shows Commit & rebase task without verbose harness apply output", () => {
    const html = renderToStaticMarkup(
      createElement(HarnessPanel, {
        ...baseProps,
        status: makeStatus({ initialized: true, needsApply: false }),
        applyResult: {
          version: 1,
          changedFiles: [change("CLAUDE.md", "update")],
          message: "Applied VCM fixed harness install Project: /workspace DONE CLAUDE.md"
        },
        canCommitAndRebaseTask: true
      } as never)
    );

    expect(html).not.toContain("Applied VCM fixed harness install");
    expect(html).not.toContain("CLAUDE.md");
    expect(html).toContain("Commit &amp; rebase task</button>");
  });

  it("does not show bootstrap check details in the sidebar", () => {
    const html = renderToStaticMarkup(
      createElement(HarnessPanel, {
        ...baseProps,
        status: makeStatus({ initialized: true, needsApply: false }),
        bootstrapStatus: {
          version: 1,
          status: "incomplete",
          canStart: true,
          checks: [
            {
              key: "project-context",
              label: "Project context",
              path: "CLAUDE.md",
              status: "ok"
            },
            {
              key: "module-index",
              label: "Module index",
              path: ".ai/generated/module-index.json",
              status: "ok"
            }
          ],
          warnings: []
        }
      } as never)
    );

    expect(html).toContain("Bootstrap");
    expect(html).toContain("incomplete");
    expect(html).not.toContain("Project context");
    expect(html).not.toContain("Module index");
    expect(html).not.toContain(".ai/generated/module-index.json");
  });
});
