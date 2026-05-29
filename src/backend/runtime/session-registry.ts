import type { RoleName, RoleStatus } from "../../shared/types/role.js";
import type { RoleSessionRecord } from "../../shared/types/session.js";

export interface SessionRegistry {
  upsert(session: RoleSessionRecord): void;
  get(sessionId: string): RoleSessionRecord | undefined;
  getByRole(taskSlug: string, role: RoleName): RoleSessionRecord | undefined;
  list(taskSlug?: string): RoleSessionRecord[];
  updateStatus(sessionId: string, status: RoleStatus, patch?: Partial<RoleSessionRecord>): void;
  remove(sessionId: string): void;
}

export function createSessionRegistry(): SessionRegistry {
  const sessions = new Map<string, RoleSessionRecord>();

  return {
    upsert(session) {
      sessions.set(session.id, session);
    },
    get(sessionId) {
      const session = sessions.get(sessionId);
      return session ? { ...session } : undefined;
    },
    getByRole(taskSlug, role) {
      const session = [...sessions.values()].find((candidate) => (
        candidate.taskSlug === taskSlug && candidate.role === role
      ));
      return session ? { ...session } : undefined;
    },
    list(taskSlug) {
      return [...sessions.values()]
        .filter((session) => !taskSlug || session.taskSlug === taskSlug)
        .map((session) => ({ ...session }));
    },
    updateStatus(sessionId, status, patch = {}) {
      const current = sessions.get(sessionId);
      if (!current) {
        return;
      }

      sessions.set(sessionId, {
        ...current,
        ...patch,
        status,
        updatedAt: patch.updatedAt ?? new Date().toISOString()
      });
    },
    remove(sessionId) {
      sessions.delete(sessionId);
    }
  };
}
