import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The dashboard module imports the xterm-backed terminal view, which touches
// browser globals at module load.
vi.mock("../../../src/frontend/terminal/xterm-view.js", () => ({
  XtermView: () => null
}));

const { SidebarSection } = await import("../../../src/frontend/routes/project-dashboard.js");

function render(props: { open?: boolean; warningCount?: number }): string {
  return renderToStaticMarkup(
    createElement(SidebarSection, { title: "Repository", open: props.open ?? false, warningCount: props.warningCount }, "content")
  );
}

describe("SidebarSection", () => {
  it("shows the warning count on a collapsed section header", () => {
    const markup = render({ warningCount: 2 });

    expect(markup).toContain('aria-label="Repository, 2 warnings"');
    expect(markup).toContain('<span aria-hidden="true" class="sidebar-section-badge" title="2 warnings">2</span>');
    expect(markup).not.toContain("content");
  });

  it("uses the singular label for one warning and keeps the badge when open", () => {
    const markup = render({ open: true, warningCount: 1 });

    expect(markup).toContain('aria-label="Repository, 1 warning"');
    expect(markup).toContain("sidebar-section-badge");
    expect(markup).toContain("content");
  });

  it("shows no badge without warnings", () => {
    for (const warningCount of [undefined, 0]) {
      const markup = render({ warningCount });
      expect(markup).not.toContain("sidebar-section-badge");
      expect(markup).not.toContain("aria-label");
    }
  });
});
