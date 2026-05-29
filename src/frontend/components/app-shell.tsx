import { useState } from "react";
import type { ReactNode } from "react";

export interface AppShellProps {
  sidebar: ReactNode;
  children: ReactNode;
}

export function AppShell({ sidebar, children }: AppShellProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return (
    <div className={sidebarCollapsed ? "app-shell is-sidebar-collapsed" : "app-shell"}>
      <aside className="app-sidebar">
        <button
          className="sidebar-toggle"
          type="button"
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setSidebarCollapsed((current) => !current)}
        />
        <div className="sidebar-content">{sidebar}</div>
      </aside>
      <main className="app-main">{children}</main>
    </div>
  );
}
