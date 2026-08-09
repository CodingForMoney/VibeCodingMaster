import path from "node:path";
import { ROLE_NAMES, isRoleName } from "../../shared/constants.js";
import type { RoleName } from "../../shared/types/role.js";
import type {
  TaskUsageAnalyticsReport,
  UsageAnalyticsModelSummary,
  UsageAnalyticsRoleSummary,
  UsageAnalyticsTotals
} from "../../shared/types/usage-analytics.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";

export interface UsageAnalyticsService {
  ingest(taskRepoRoot: string, stateRoot: string, payload: unknown): Promise<void>;
  getReport(taskRepoRoot: string, stateRoot: string, taskSlug: string): Promise<TaskUsageAnalyticsReport>;
}

export interface UsageAnalyticsServiceDeps {
  fs: FileSystemAdapter;
  now?: () => string;
}

interface StoredUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsdMicros: number;
  requestCount: number;
}

interface StoredUsageAnalytics {
  version: 1;
  updatedAt: string;
  seenEvents: string[];
  sessionsByRole: Partial<Record<RoleName, string[]>>;
  sessionsByModel: Record<string, string[]>;
  totals: StoredUsageTotals;
  byRole: Partial<Record<RoleName, StoredUsageTotals>>;
  byModel: Record<string, StoredUsageTotals>;
}

interface NormalizedApiRequestEvent {
  eventKey: string;
  role: RoleName;
  model: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsdMicros: number;
}

const USAGE_FILE = path.join("telemetry", "usage.json");

export function createUsageAnalyticsService(deps: UsageAnalyticsServiceDeps): UsageAnalyticsService {
  const now = deps.now ?? (() => new Date().toISOString());
  const writeQueues = new Map<string, Promise<void>>();

  return {
    async ingest(taskRepoRoot, stateRoot, payload) {
      const events = extractApiRequestEvents(payload);
      if (events.length === 0) {
        return;
      }

      const usagePath = getUsagePath(taskRepoRoot, stateRoot);
      await enqueueWrite(writeQueues, usagePath, async () => {
        const state = await loadState(deps.fs, usagePath);
        const seen = new Set(state.seenEvents);
        let changed = false;

        for (const event of events) {
          if (seen.has(event.eventKey)) {
            continue;
          }
          seen.add(event.eventKey);
          state.seenEvents.push(event.eventKey);
          addEvent(state, event);
          changed = true;
        }

        if (!changed) {
          return;
        }
        state.updatedAt = now();
        await deps.fs.writeJsonAtomic(usagePath, state);
      });
    },

    async getReport(taskRepoRoot, stateRoot, taskSlug) {
      const usagePath = getUsagePath(taskRepoRoot, stateRoot);
      await writeQueues.get(usagePath);
      if (!(await deps.fs.pathExists(usagePath))) {
        return emptyReport(taskSlug);
      }
      const state = normalizeStoredState(await deps.fs.readJson<StoredUsageAnalytics>(usagePath));
      return toReport(taskSlug, state);
    }
  };
}

function extractApiRequestEvents(payload: unknown): NormalizedApiRequestEvent[] {
  if (!isObject(payload) || !Array.isArray(payload.resourceLogs)) {
    return [];
  }

  const events: NormalizedApiRequestEvent[] = [];
  for (const resourceLog of payload.resourceLogs) {
    if (!isObject(resourceLog)) {
      continue;
    }
    const resourceAttributes = readAttributes(isObject(resourceLog.resource) ? resourceLog.resource.attributes : undefined);
    if (!Array.isArray(resourceLog.scopeLogs)) {
      continue;
    }
    for (const scopeLog of resourceLog.scopeLogs) {
      if (!isObject(scopeLog) || !Array.isArray(scopeLog.logRecords)) {
        continue;
      }
      for (const logRecord of scopeLog.logRecords) {
        if (!isObject(logRecord)) {
          continue;
        }
        const attributes = {
          ...resourceAttributes,
          ...readAttributes(logRecord.attributes)
        };
        if (readString(attributes["event.name"]) !== "api_request") {
          continue;
        }
        const roleValue = readString(attributes["vcm.role"]);
        const launchId = readString(attributes["vcm.launch_id"]);
        if (!roleValue || !isRoleName(roleValue) || !launchId) {
          continue;
        }
        const model = normalizeModel(readString(attributes.model));
        if (isCodexBridgeModel(model)) {
          continue;
        }
        const sequence = readInteger(attributes["event.sequence"]);
        const sessionId = readString(attributes["session.id"]) || launchId;
        const requestId = readString(attributes.request_id);
        const timestamp = readString(logRecord.timeUnixNano) || readString(logRecord.observedTimeUnixNano);
        const fallbackIdentity = [sessionId, requestId, timestamp, model].join(":");
        const eventKey = `${launchId}:${sequence ?? fallbackIdentity}`;
        const costUsdMicros = readNonNegativeInteger(attributes.cost_usd_micros)
          ?? Math.round((readNonNegativeNumber(attributes.cost_usd) ?? 0) * 1_000_000);

        events.push({
          eventKey,
          role: roleValue,
          model,
          sessionId,
          inputTokens: readNonNegativeInteger(attributes.input_tokens) ?? 0,
          outputTokens: readNonNegativeInteger(attributes.output_tokens) ?? 0,
          cacheReadTokens: readNonNegativeInteger(attributes.cache_read_tokens) ?? 0,
          cacheCreationTokens: readNonNegativeInteger(attributes.cache_creation_tokens) ?? 0,
          costUsdMicros
        });
      }
    }
  }
  return events;
}

function addEvent(state: StoredUsageAnalytics, event: NormalizedApiRequestEvent): void {
  addTotals(state.totals, event);
  state.byRole[event.role] ??= emptyStoredTotals();
  addTotals(state.byRole[event.role]!, event);
  state.byModel[event.model] ??= emptyStoredTotals();
  addTotals(state.byModel[event.model]!, event);
  addUnique(state.sessionsByRole, event.role, event.sessionId);
  addUnique(state.sessionsByModel, event.model, event.sessionId);
}

function addTotals(target: StoredUsageTotals, event: NormalizedApiRequestEvent): void {
  target.inputTokens += event.inputTokens;
  target.outputTokens += event.outputTokens;
  target.cacheReadTokens += event.cacheReadTokens;
  target.cacheCreationTokens += event.cacheCreationTokens;
  target.costUsdMicros += event.costUsdMicros;
  target.requestCount += 1;
}

function addUnique<TKey extends string>(
  target: Partial<Record<TKey, string[]>>,
  key: TKey,
  value: string
): void {
  const values = target[key] ?? [];
  if (!values.includes(value)) {
    values.push(value);
  }
  target[key] = values;
}

async function loadState(fs: FileSystemAdapter, usagePath: string): Promise<StoredUsageAnalytics> {
  if (!(await fs.pathExists(usagePath))) {
    return emptyStoredState();
  }
  return normalizeStoredState(await fs.readJson<StoredUsageAnalytics>(usagePath));
}

function normalizeStoredState(input: StoredUsageAnalytics): StoredUsageAnalytics {
  return {
    version: 1,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : new Date(0).toISOString(),
    seenEvents: Array.isArray(input.seenEvents) ? input.seenEvents.filter((value): value is string => typeof value === "string") : [],
    sessionsByRole: normalizeRoleStringLists(input.sessionsByRole),
    sessionsByModel: normalizeStringLists(input.sessionsByModel),
    totals: normalizeStoredTotals(input.totals),
    byRole: normalizeRoleTotals(input.byRole),
    byModel: normalizeModelTotals(input.byModel)
  };
}

function normalizeRoleStringLists(input: unknown): Partial<Record<RoleName, string[]>> {
  if (!isObject(input)) {
    return {};
  }
  const result: Partial<Record<RoleName, string[]>> = {};
  for (const role of ROLE_NAMES) {
    const values = input[role];
    if (Array.isArray(values)) {
      result[role] = values.filter((value): value is string => typeof value === "string");
    }
  }
  return result;
}

function normalizeStringLists(input: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!isObject(input)) {
    return result;
  }
  for (const [key, values] of Object.entries(input)) {
    if (isSafeGroupKey(key) && Array.isArray(values)) {
      result[key] = values.filter((value): value is string => typeof value === "string");
    }
  }
  return result;
}

function normalizeRoleTotals(input: unknown): Partial<Record<RoleName, StoredUsageTotals>> {
  if (!isObject(input)) {
    return {};
  }
  const result: Partial<Record<RoleName, StoredUsageTotals>> = {};
  for (const role of ROLE_NAMES) {
    if (isObject(input[role])) {
      result[role] = normalizeStoredTotals(input[role]);
    }
  }
  return result;
}

function normalizeModelTotals(input: unknown): Record<string, StoredUsageTotals> {
  const result: Record<string, StoredUsageTotals> = {};
  if (!isObject(input)) {
    return result;
  }
  for (const [key, totals] of Object.entries(input)) {
    if (isSafeGroupKey(key) && isObject(totals)) {
      result[key] = normalizeStoredTotals(totals);
    }
  }
  return result;
}

function normalizeStoredTotals(input: unknown): StoredUsageTotals {
  const value = isObject(input) ? input : {};
  return {
    inputTokens: readNonNegativeInteger(value.inputTokens) ?? 0,
    outputTokens: readNonNegativeInteger(value.outputTokens) ?? 0,
    cacheReadTokens: readNonNegativeInteger(value.cacheReadTokens) ?? 0,
    cacheCreationTokens: readNonNegativeInteger(value.cacheCreationTokens) ?? 0,
    costUsdMicros: readNonNegativeInteger(value.costUsdMicros) ?? 0,
    requestCount: readNonNegativeInteger(value.requestCount) ?? 0
  };
}

function toReport(taskSlug: string, state: StoredUsageAnalytics): TaskUsageAnalyticsReport {
  const allSessions = new Set(Object.values(state.sessionsByRole).flatMap((values) => values ?? []));
  const byRole: UsageAnalyticsRoleSummary[] = ROLE_NAMES.map((role) => ({
    role,
    ...toPublicTotals(state.byRole[role] ?? emptyStoredTotals(), state.sessionsByRole[role]?.length ?? 0)
  }));
  const byModel: UsageAnalyticsModelSummary[] = Object.keys(state.byModel)
    .sort((left, right) => left.localeCompare(right))
    .map((model) => ({
      model,
      ...toPublicTotals(state.byModel[model]!, state.sessionsByModel[model]?.length ?? 0)
    }));
  return {
    version: 1,
    taskSlug,
    updatedAt: state.updatedAt,
    totals: toPublicTotals(state.totals, allSessions.size),
    byRole,
    byModel
  };
}

function emptyReport(taskSlug: string): TaskUsageAnalyticsReport {
  return {
    version: 1,
    taskSlug,
    updatedAt: null,
    totals: toPublicTotals(emptyStoredTotals(), 0),
    byRole: ROLE_NAMES.map((role) => ({ role, ...toPublicTotals(emptyStoredTotals(), 0) })),
    byModel: []
  };
}

function toPublicTotals(totals: StoredUsageTotals, sessionCount: number): UsageAnalyticsTotals {
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheCreationTokens: totals.cacheCreationTokens,
    costUsd: totals.costUsdMicros / 1_000_000,
    requestCount: totals.requestCount,
    sessionCount
  };
}

function emptyStoredState(): StoredUsageAnalytics {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    seenEvents: [],
    sessionsByRole: {},
    sessionsByModel: {},
    totals: emptyStoredTotals(),
    byRole: {},
    byModel: {}
  };
}

function emptyStoredTotals(): StoredUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsdMicros: 0,
    requestCount: 0
  };
}

function getUsagePath(taskRepoRoot: string, stateRoot: string): string {
  return path.join(taskRepoRoot, stateRoot, USAGE_FILE);
}

async function enqueueWrite(
  queues: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<void>
): Promise<void> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(key, current);
  try {
    await current;
  } finally {
    if (queues.get(key) === current) {
      queues.delete(key);
    }
  }
}

function readAttributes(input: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!Array.isArray(input)) {
    return result;
  }
  for (const entry of input) {
    if (!isObject(entry) || typeof entry.key !== "string") {
      continue;
    }
    result[entry.key] = readAnyValue(entry.value);
  }
  return result;
}

function readAnyValue(input: unknown): unknown {
  if (!isObject(input)) {
    return input;
  }
  for (const key of ["stringValue", "intValue", "doubleValue", "boolValue"] as const) {
    if (key in input) {
      return input[key];
    }
  }
  return undefined;
}

function readString(input: unknown): string | undefined {
  if (typeof input === "string") {
    return input.trim() || undefined;
  }
  if (typeof input === "number" || typeof input === "bigint") {
    return String(input);
  }
  return undefined;
}

function readInteger(input: unknown): number | undefined {
  const value = typeof input === "number" ? input : typeof input === "string" ? Number(input) : Number.NaN;
  return Number.isSafeInteger(value) ? value : undefined;
}

function readNonNegativeInteger(input: unknown): number | undefined {
  const value = readInteger(input);
  return value !== undefined && value >= 0 ? value : undefined;
}

function readNonNegativeNumber(input: unknown): number | undefined {
  const value = typeof input === "number" ? input : typeof input === "string" ? Number(input) : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeModel(input: string | undefined): string {
  const model = input?.slice(0, 200).trim();
  return model && isSafeGroupKey(model) ? model : "unknown";
}

function isCodexBridgeModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized.startsWith("gpt-") || normalized.startsWith("codex-bridge:");
}

function isSafeGroupKey(value: string): boolean {
  return value !== "__proto__" && value !== "prototype" && value !== "constructor";
}

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
