import type { RoleName } from "../../shared/types/role.js";
import type {
  PollTranslationTaskFeedResult,
  TranslationEntry,
  TranslationFailureItem,
  TranslationSessionStatus
} from "../../shared/types/translation.js";
import { TRANSLATION_ENTRY_RETENTION_LIMIT } from "../../shared/types/translation.js";

export interface TranslationPanelSessionState {
  role?: RoleName;
  status: TranslationSessionStatus;
  entries: TranslationEntry[];
  failures: TranslationFailureItem[];
}

export interface TranslationPanelFeedStore {
  taskSlug: string;
  cursor: number;
  sessions: Record<string, TranslationPanelSessionState>;
}

export function createTranslationPanelFeedStore(taskSlug: string): TranslationPanelFeedStore {
  return {
    taskSlug,
    cursor: 1,
    sessions: {}
  };
}

export function selectTranslationPanelSessionState(
  store: TranslationPanelFeedStore,
  sessionId: string,
  role?: RoleName
): TranslationPanelSessionState {
  return store.sessions[sessionId] ?? createEmptySessionState(role);
}

// Returns the same store, and the same session objects, when a poll brings
// nothing new: every role's translation panel re-renders from this store each
// second, so a fresh object per poll would re-render every retained entry.
export function applyTranslationTaskFeed(
  store: TranslationPanelFeedStore,
  result: PollTranslationTaskFeedResult
): TranslationPanelFeedStore {
  const base = ensureTaskStore(store, result.taskSlug);
  let sessions = base.sessions;
  const setSession = (sessionId: string, next: TranslationPanelSessionState) => {
    if (sessions === base.sessions) {
      sessions = { ...base.sessions };
    }
    sessions[sessionId] = next;
  };

  for (const session of result.sessions) {
    const current = sessions[session.sessionId];
    if (current && current.role === session.role && current.status === session.status) {
      continue;
    }
    setSession(session.sessionId, {
      ...createEmptySessionState(session.role),
      ...current,
      role: session.role,
      status: session.status
    });
  }

  for (const taskEvent of result.events) {
    const current = sessions[taskEvent.sessionId] ?? createEmptySessionState(taskEvent.role);
    if (taskEvent.event.type === "status") {
      setSession(taskEvent.sessionId, {
        ...current,
        role: taskEvent.role,
        status: taskEvent.event.status
      });
    } else if (taskEvent.event.type === "failures") {
      setSession(taskEvent.sessionId, {
        ...current,
        role: taskEvent.role,
        failures: taskEvent.event.failures
      });
    } else if (taskEvent.event.type === "entry") {
      const trimmed = trimTranslationEntries(upsertEntry(current.entries, taskEvent.event.entry));
      setSession(taskEvent.sessionId, {
        ...current,
        role: taskEvent.role,
        entries: trimmed.entries,
        failures: trimmed.removedIds.size > 0
          ? current.failures.filter((failure) => !trimmed.removedIds.has(failure.translationId))
          : current.failures
      });
    }
  }

  if (base === store && sessions === base.sessions && base.cursor === result.nextCursor) {
    return store;
  }
  return {
    taskSlug: result.taskSlug,
    cursor: result.nextCursor,
    sessions
  };
}

export function clearTranslationPanelSession(
  store: TranslationPanelFeedStore,
  sessionId: string,
  role?: RoleName
): TranslationPanelFeedStore {
  return {
    ...store,
    sessions: {
      ...store.sessions,
      [sessionId]: createEmptySessionState(role)
    }
  };
}

export function applyTranslationPanelEntry(
  store: TranslationPanelFeedStore,
  sessionId: string,
  role: RoleName,
  entry: TranslationEntry
): TranslationPanelFeedStore {
  const current = store.sessions[sessionId] ?? createEmptySessionState(role);
  const trimmed = trimTranslationEntries(upsertEntry(current.entries, entry));
  return {
    ...store,
    sessions: {
      ...store.sessions,
      [sessionId]: {
        ...current,
        role,
        entries: trimmed.entries,
        failures: trimmed.removedIds.size > 0
          ? current.failures.filter((failure) => !trimmed.removedIds.has(failure.translationId))
          : current.failures
      }
    }
  };
}

export function setTranslationPanelFailures(
  store: TranslationPanelFeedStore,
  sessionId: string,
  role: RoleName,
  failures: TranslationFailureItem[]
): TranslationPanelFeedStore {
  const current = store.sessions[sessionId] ?? createEmptySessionState(role);
  return {
    ...store,
    sessions: {
      ...store.sessions,
      [sessionId]: {
        ...current,
        role,
        failures
      }
    }
  };
}

function ensureTaskStore(store: TranslationPanelFeedStore, taskSlug: string): TranslationPanelFeedStore {
  return store.taskSlug === taskSlug ? store : createTranslationPanelFeedStore(taskSlug);
}

function createEmptySessionState(role?: RoleName): TranslationPanelSessionState {
  return {
    role,
    status: "ready",
    entries: [],
    failures: []
  };
}

function upsertEntry(entries: TranslationEntry[], entry: TranslationEntry): TranslationEntry[] {
  const index = entries.findIndex((current) => current.id === entry.id);
  if (index === -1) {
    return [...entries, entry];
  }
  return entries.map((current) => current.id === entry.id ? entry : current);
}

function trimTranslationEntries(entries: TranslationEntry[]): { entries: TranslationEntry[]; removedIds: Set<string> } {
  if (entries.length <= TRANSLATION_ENTRY_RETENTION_LIMIT) {
    return { entries, removedIds: new Set() };
  }
  const removed = entries.slice(0, entries.length - TRANSLATION_ENTRY_RETENTION_LIMIT);
  return {
    entries: entries.slice(-TRANSLATION_ENTRY_RETENTION_LIMIT),
    removedIds: new Set(removed.map((entry) => entry.id))
  };
}
