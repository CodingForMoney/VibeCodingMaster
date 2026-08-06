import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  CodeIntelligenceQueryRequest,
  CodeIntelligenceQueryResult
} from "../../shared/types/code-intelligence.js";
import type {
  HarnessCodeIntelligenceLanguage,
  HarnessCodeIntelligenceLanguageState,
  HarnessCodeIntelligenceLanguageStatus,
  HarnessCodeIntelligenceStatus
} from "../../shared/types/harness.js";
import type { CommandRunner, CommandResult } from "../adapters/command-runner.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import { VCM_CODE_INTELLIGENCE_PLUGIN_NAME } from "./lsp-plugin.js";

interface LanguageDefinition {
  language: HarnessCodeIntelligenceLanguage;
  label: string;
  extensions: string[];
  manifests: string[];
  serverCommand: string;
  serverArgs: string[];
  probeArgs: string[];
}

const LANGUAGE_DEFINITIONS: LanguageDefinition[] = [
  language("rust", "Rust", [".rs"], ["Cargo.toml"], "rust-analyzer"),
  language(
    "typescript",
    "TypeScript / JavaScript",
    [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
    ["package.json", "tsconfig.json", "jsconfig.json"],
    "typescript-language-server",
    ["--stdio"]
  ),
  language("python", "Python", [".py", ".pyi"], ["pyproject.toml", "requirements.txt", "setup.py"], "pyright-langserver", ["--stdio"]),
  language("go", "Go", [".go"], ["go.mod"], "gopls", [], ["version"]),
  language(
    "cpp",
    "C / C++",
    [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"],
    ["CMakeLists.txt", "compile_commands.json"],
    "clangd",
    ["--background-index"]
  ),
  language("java", "Java", [".java"], ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"], "jdtls")
];

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const SOURCE_SCAN_LIMIT = 5_000;
const SOURCE_SCAN_IGNORED_DIRS = new Set([
  ".git",
  ".claude",
  ".ai",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".venv",
  "vendor"
]);

export interface DetectCodeIntelligenceOptions {
  runner?: Pick<CommandRunner, "run">;
  pathEnv?: string;
  pathExt?: string;
  platform?: NodeJS.Platform;
  probeTimeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
}

export interface HarnessCodeIntelligenceDetector {
  detect(repoRoot: string): Promise<HarnessCodeIntelligenceStatus>;
}

export interface CodeIntelligenceManager {
  activateTask(taskRepoRoot: string): Promise<void>;
  stopTask(taskRepoRoot: string): Promise<void>;
  shutdown(): Promise<void>;
  getStatus(taskRepoRoot: string): Promise<HarnessCodeIntelligenceStatus>;
  query(taskRepoRoot: string, request: CodeIntelligenceQueryRequest): Promise<CodeIntelligenceQueryResult>;
}

export interface CreateCodeIntelligenceManagerOptions extends DetectCodeIntelligenceOptions {
  spawnProcess?: SpawnLspProcess;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
}

interface ProbeCacheEntry {
  expiresAt: number;
  result: CommandResult;
}

interface DetectedLanguage {
  definition: LanguageDefinition;
  detectedBy: string[];
  executablePath?: string;
  probeResult?: CommandResult;
}

interface ActiveTaskRuntime {
  taskRepoRoot: string;
  detected: DetectedLanguage[];
  languages: Map<HarnessCodeIntelligenceLanguage, SharedLanguageRuntime>;
}

type SpawnLspProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

export function createHarnessCodeIntelligenceDetector(
  fs: FileSystemAdapter,
  options: DetectCodeIntelligenceOptions = {}
): HarnessCodeIntelligenceDetector {
  const detect = createLanguageDetector(fs, options);
  return {
    async detect(repoRoot) {
      return renderDetectedStatus(repoRoot, await detect(repoRoot));
    }
  };
}

export async function detectHarnessCodeIntelligence(
  fs: FileSystemAdapter,
  repoRoot: string,
  options: DetectCodeIntelligenceOptions = {}
): Promise<HarnessCodeIntelligenceStatus> {
  return createHarnessCodeIntelligenceDetector(fs, options).detect(repoRoot);
}

export function createCodeIntelligenceManager(
  fs: FileSystemAdapter,
  options: CreateCodeIntelligenceManagerOptions = {}
): CodeIntelligenceManager {
  const detect = createLanguageDetector(fs, options);
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
    nodeSpawn(command, args, { ...spawnOptions, stdio: "pipe" }));
  let activeTask: ActiveTaskRuntime | undefined;
  let activationRevision = 0;

  async function activateTask(taskRepoRoot: string): Promise<void> {
    const resolvedRoot = path.resolve(taskRepoRoot);
    if (activeTask?.taskRepoRoot === resolvedRoot) {
      return;
    }
    const revision = ++activationRevision;
    if (activeTask) {
      await stopActiveTask(activeTask);
    }
    const detected = await detect(resolvedRoot);
    if (revision !== activationRevision) {
      return;
    }
    const taskRuntime: ActiveTaskRuntime = {
      taskRepoRoot: resolvedRoot,
      detected,
      languages: new Map()
    };
    activeTask = taskRuntime;
    for (const entry of detected) {
      if (!entry.executablePath || entry.probeResult?.exitCode !== 0) {
        continue;
      }
      const runtime = new SharedLanguageRuntime({
        fs,
        definition: entry.definition,
        executablePath: entry.executablePath,
        taskRepoRoot: resolvedRoot,
        spawnProcess,
        requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
        onUnexpectedExit() {
          if (activeTask !== taskRuntime || runtime.restartCount >= 1) {
            return;
          }
          runtime.restartCount += 1;
          setTimeout(() => {
            if (activeTask === taskRuntime) {
              void runtime.start();
            }
          }, 0);
        }
      });
      taskRuntime.languages.set(entry.definition.language, runtime);
      void runtime.start();
    }
  }

  async function stopActiveTask(taskRuntime: ActiveTaskRuntime): Promise<void> {
    await Promise.all([...taskRuntime.languages.values()].map((runtime) => runtime.stop()));
    if (activeTask === taskRuntime) {
      activeTask = undefined;
    }
  }

  return {
    activateTask,
    async stopTask(taskRepoRoot) {
      if (activeTask?.taskRepoRoot !== path.resolve(taskRepoRoot)) {
        return;
      }
      activationRevision += 1;
      await stopActiveTask(activeTask);
    },
    async shutdown() {
      activationRevision += 1;
      if (activeTask) {
        await stopActiveTask(activeTask);
      }
    },
    async getStatus(taskRepoRoot) {
      const resolvedRoot = path.resolve(taskRepoRoot);
      if (activeTask?.taskRepoRoot === resolvedRoot) {
        return renderRuntimeStatus(activeTask);
      }
      return renderDetectedStatus(resolvedRoot, await detect(resolvedRoot));
    },
    async query(taskRepoRoot, request) {
      const resolvedRoot = path.resolve(taskRepoRoot);
      const taskRuntime = activeTask;
      if (!taskRuntime || taskRuntime.taskRepoRoot !== resolvedRoot) {
        return unresolved(request.operation, resolvedRoot, undefined, "Shared LSP runtime is not active.", "LSP_NOT_ACTIVE");
      }
      if (request.operation === "status") {
        return {
          status: "resolved",
          operation: request.operation,
          workspaceRoot: resolvedRoot,
          result: renderRuntimeStatus(taskRuntime)
        };
      }
      const definition = resolveRequestLanguage(request);
      if (!definition) {
        return unresolved(request.operation, resolvedRoot, request.language, "The query language could not be determined.", "LSP_LANGUAGE_UNKNOWN");
      }
      const runtime = taskRuntime.languages.get(definition.language);
      if (!runtime) {
        const detected = taskRuntime.detected.find((entry) => entry.definition.language === definition.language);
        const reason = detected?.executablePath
          ? firstNonEmptyLine(detected.probeResult?.stderr, detected.probeResult?.stdout) ?? `${definition.serverCommand} failed its startup probe.`
          : `${definition.serverCommand} is not available in the VCM backend PATH.`;
        return unresolved(request.operation, resolvedRoot, definition.language, reason, "LSP_UNAVAILABLE");
      }
      if (runtime.state === "starting" || runtime.state === "indexing") {
        return unresolved(request.operation, resolvedRoot, definition.language, `${definition.label} shared LSP is ${runtime.state}.`, "LSP_INDEXING");
      }
      if (runtime.state !== "ready") {
        return unresolved(request.operation, resolvedRoot, definition.language, runtime.error ?? `${definition.label} shared LSP is unavailable.`, "LSP_UNAVAILABLE");
      }
      return runtime.query(request);
    }
  };
}

class SharedLanguageRuntime {
  state: HarnessCodeIntelligenceLanguageState = "stopped";
  error?: string;
  pid?: number;
  restartCount = 0;
  private process?: ChildProcessWithoutNullStreams;
  private client?: LspJsonRpcClient;
  private startPromise?: Promise<void>;
  private plannedStop = false;
  private warmupComplete = false;
  private activeProgress = new Set<string>();
  private openedDocuments = new Map<string, { version: number; content: string }>();

  constructor(private readonly options: {
    fs: FileSystemAdapter;
    definition: LanguageDefinition;
    executablePath: string;
    taskRepoRoot: string;
    spawnProcess: SpawnLspProcess;
    requestTimeoutMs: number;
    startupTimeoutMs: number;
    onUnexpectedExit(): void;
  }) {}

  start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    this.plannedStop = false;
    this.warmupComplete = false;
    this.activeProgress.clear();
    this.openedDocuments.clear();
    this.error = undefined;
    this.state = "starting";
    try {
      const child = this.options.spawnProcess(
        this.options.executablePath,
        this.options.definition.serverArgs,
        {
          cwd: this.options.taskRepoRoot,
          env: process.env
        }
      );
      this.process = child;
      this.pid = child.pid;
      const client = new LspJsonRpcClient(child, this.options.taskRepoRoot, {
        requestTimeoutMs: this.options.requestTimeoutMs,
        onProgress: (token, kind) => this.updateProgress(token, kind),
        onStderr: (line) => {
          if (line) {
            this.error = line;
          }
        }
      });
      this.client = client;
      child.once("error", (error) => this.handleExit(child, error));
      child.once("exit", (code, signal) => this.handleExit(child,
        new Error(`${this.options.definition.serverCommand} exited with ${signal ?? `code ${code ?? 1}`}.`)
      ));
      const rootUri = pathToFileURL(this.options.taskRepoRoot).href;
      await client.request("initialize", {
        processId: process.pid,
        clientInfo: { name: "VibeCodingMaster", version: "1" },
        rootUri,
        rootPath: this.options.taskRepoRoot,
        capabilities: lspClientCapabilities(),
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.options.taskRepoRoot) }]
      }, this.options.startupTimeoutMs);
      client.notify("initialized", {});
      this.state = "indexing";
      await this.warmup(client);
      this.warmupComplete = true;
      this.state = this.activeProgress.size > 0 ? "indexing" : "ready";
      this.error = undefined;
    } catch (error) {
      this.state = "server_failed";
      this.error = errorMessage(error);
      const child = this.process;
      if (child) {
        this.process = undefined;
        this.client?.close(error instanceof Error ? error : new Error(this.error));
        this.client = undefined;
        this.pid = undefined;
        child.kill();
        this.options.onUnexpectedExit();
      }
    }
  }

  private async warmup(client: LspJsonRpcClient): Promise<void> {
    const sourcePath = await findWarmupSourceFile(
      this.options.fs,
      this.options.taskRepoRoot,
      this.options.definition
    );
    if (!sourcePath) {
      return;
    }
    await this.syncDocument(sourcePath);
    const uri = pathToFileURL(sourcePath).href;
    const symbols = await client.request<unknown[]>("textDocument/documentSymbol", {
      textDocument: { uri }
    }, this.options.startupTimeoutMs);
    const query = firstSymbolName(symbols);
    if (query) {
      await client.request("workspace/symbol", { query }, this.options.startupTimeoutMs);
    }
  }

  private updateProgress(token: string, kind: string): void {
    if (kind === "begin") {
      this.activeProgress.add(token);
      if (this.state === "ready") {
        this.state = "indexing";
      }
      return;
    }
    if (kind === "end") {
      this.activeProgress.delete(token);
      if (this.warmupComplete && this.activeProgress.size === 0 && this.state === "indexing") {
        this.state = "ready";
        this.error = undefined;
      }
    }
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== child) {
      return;
    }
    this.process = undefined;
    this.client?.close(error);
    this.client = undefined;
    this.pid = undefined;
    if (this.plannedStop) {
      this.state = "stopped";
      return;
    }
    this.state = "server_failed";
    this.error = error.message;
    this.options.onUnexpectedExit();
  }

  async stop(): Promise<void> {
    this.plannedStop = true;
    const child = this.process;
    const client = this.client;
    this.process = undefined;
    this.client = undefined;
    this.pid = undefined;
    if (!child) {
      this.state = "stopped";
      return;
    }
    try {
      if (client) {
        await client.request("shutdown", null, 2_000).catch(() => undefined);
        client.notify("exit", null);
      }
    } finally {
      child.kill();
      this.state = "stopped";
    }
  }

  async query(request: CodeIntelligenceQueryRequest): Promise<CodeIntelligenceQueryResult> {
    const client = this.client;
    if (!client) {
      return unresolved(request.operation, this.options.taskRepoRoot, this.options.definition.language, "Shared LSP client is not connected.", "LSP_UNAVAILABLE");
    }
    try {
      let result: unknown;
      if (request.operation === "workspace_symbols") {
        result = await client.request("workspace/symbol", { query: requireText(request.query, "query") });
      } else {
        const absolutePath = resolveSourcePath(this.options.taskRepoRoot, requireText(request.path, "path"));
        await this.syncDocument(absolutePath);
        const textDocument = { uri: pathToFileURL(absolutePath).href };
        if (request.operation === "document_symbols") {
          result = await client.request("textDocument/documentSymbol", { textDocument });
        } else {
          const position = {
            line: requirePositiveInteger(request.line, "line") - 1,
            character: Math.max(0, (request.character ?? 1) - 1)
          };
          result = await runPositionQuery(client, request.operation, textDocument, position);
        }
      }
      const normalized = normalizeLspValue(result, this.options.taskRepoRoot);
      return {
        status: isEmptyLspResult(result) ? "not_found" : "resolved",
        operation: request.operation,
        workspaceRoot: this.options.taskRepoRoot,
        language: this.options.definition.language,
        result: normalized
      };
    } catch (error) {
      return unresolved(
        request.operation,
        this.options.taskRepoRoot,
        this.options.definition.language,
        errorMessage(error),
        "LSP_QUERY_FAILED"
      );
    }
  }

  private async syncDocument(absolutePath: string): Promise<void> {
    const client = this.client;
    if (!client) {
      throw new Error("Shared LSP client is not connected.");
    }
    const content = await this.options.fs.readText(absolutePath);
    const uri = pathToFileURL(absolutePath).href;
    const opened = this.openedDocuments.get(uri);
    if (!opened) {
      this.openedDocuments.set(uri, { version: 1, content });
      client.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: languageIdForPath(this.options.definition.language, absolutePath),
          version: 1,
          text: content
        }
      });
      return;
    }
    if (opened.content === content) {
      return;
    }
    const version = opened.version + 1;
    this.openedDocuments.set(uri, { version, content });
    client.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: content }]
    });
  }
}

class LspJsonRpcClient {
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly workspaceRoot: string,
    private readonly options: {
      requestTimeoutMs: number;
      onProgress(token: string, kind: string): void;
      onStderr(line: string): void;
    }
  ) {
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const line = chunk.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
      if (line) {
        options.onStderr(line.slice(0, 500));
      }
    });
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("LSP connection is closed."));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) {
      this.send({ jsonrpc: "2.0", method, params });
    }
  }

  close(error = new Error("LSP connection closed.")): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        this.close(new Error("LSP response is missing Content-Length."));
        return;
      }
      const contentLength = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) {
        return;
      }
      const body = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + contentLength);
      try {
        this.handleMessage(JSON.parse(body) as JsonRpcMessage);
      } catch (error) {
        this.close(new Error(`Invalid LSP JSON response: ${errorMessage(error)}`));
        return;
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "LSP request failed."));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method === "$/progress") {
      const params = message.params as { token?: unknown; value?: { kind?: unknown } } | undefined;
      const token = String(params?.token ?? "");
      const kind = String(params?.value?.kind ?? "");
      if (token && (kind === "begin" || kind === "end")) {
        this.options.onProgress(token, kind);
      }
    }
    if (typeof message.id === "number" && message.method) {
      this.respondToServerRequest(message.id, message.method, message.params);
    }
  }

  private respondToServerRequest(id: number, method: string, params: unknown): void {
    let result: unknown = null;
    if (method === "workspace/configuration") {
      const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
      result = items.map(() => null);
    } else if (method === "workspace/workspaceFolders") {
      result = [{ uri: pathToFileURL(this.workspaceRoot).href, name: path.basename(this.workspaceRoot) }];
    } else if (method === "workspace/applyEdit") {
      result = { applied: false, failureReason: "VCM shared LSP is read-only." };
    }
    this.send({ jsonrpc: "2.0", id, result });
  }
}

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

function createLanguageDetector(fs: FileSystemAdapter, options: DetectCodeIntelligenceOptions) {
  const probeCache = new Map<string, ProbeCacheEntry>();
  const probesInFlight = new Map<string, Promise<CommandResult>>();
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  return async (repoRoot: string): Promise<DetectedLanguage[]> => {
    const indexPaths = await readModuleIndexPaths(fs, repoRoot);
    const detected = await Promise.all(LANGUAGE_DEFINITIONS.map(async (definition): Promise<DetectedLanguage | undefined> => {
      const detectedBy = await detectLanguage(fs, repoRoot, indexPaths, definition);
      if (detectedBy.length === 0) {
        return undefined;
      }
      const executablePath = await findExecutable(fs, repoRoot, definition.serverCommand, options);
      if (!executablePath || !options.runner) {
        return { definition, detectedBy, executablePath };
      }
      const cacheKey = `${executablePath}\u0000${definition.probeArgs.join("\u0000")}`;
      const currentTime = now();
      const cached = probeCache.get(cacheKey);
      if (cached && cached.expiresAt > currentTime) {
        return { definition, detectedBy, executablePath, probeResult: cached.result };
      }
      const existing = probesInFlight.get(cacheKey);
      const probe = existing ?? options.runner.run(executablePath, definition.probeArgs, {
        cwd: repoRoot,
        timeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
      });
      if (!existing) {
        probesInFlight.set(cacheKey, probe);
      }
      const probeResult = await probe.finally(() => probesInFlight.delete(cacheKey));
      probeCache.set(cacheKey, { expiresAt: currentTime + cacheTtlMs, result: probeResult });
      return { definition, detectedBy, executablePath, probeResult };
    }));
    return detected.filter((entry): entry is DetectedLanguage => entry !== undefined);
  };
}

function renderDetectedStatus(repoRoot: string, detected: DetectedLanguage[]): HarnessCodeIntelligenceStatus {
  const languages = detected.map((entry): HarnessCodeIntelligenceLanguageStatus => {
    const serverFound = Boolean(entry.executablePath);
    const probeCompleted = Boolean(entry.probeResult);
    const serverRunnable = entry.probeResult?.exitCode === 0;
    const state: HarnessCodeIntelligenceLanguageState = !serverFound
      ? "server_missing"
      : !probeCompleted
        ? "server_unverified"
        : serverRunnable
          ? "stopped"
          : "server_failed";
    return {
      language: entry.definition.language,
      label: entry.definition.label,
      serverCommand: entry.definition.serverCommand,
      bridgeName: VCM_CODE_INTELLIGENCE_PLUGIN_NAME,
      detected: true,
      serverFound,
      serverRunnable,
      state,
      workspaceRoot: repoRoot,
      error: staticLanguageError(state, entry.definition.serverCommand, entry.probeResult),
      detectedBy: entry.detectedBy
    };
  });
  return { state: overallState(languages), languages };
}

function renderRuntimeStatus(taskRuntime: ActiveTaskRuntime): HarnessCodeIntelligenceStatus {
  const languages = taskRuntime.detected.map((entry): HarnessCodeIntelligenceLanguageStatus => {
    const runtime = taskRuntime.languages.get(entry.definition.language);
    const serverFound = Boolean(entry.executablePath);
    const serverRunnable = entry.probeResult?.exitCode === 0;
    const state = runtime?.state ?? (!serverFound ? "server_missing" : "server_failed");
    return {
      language: entry.definition.language,
      label: entry.definition.label,
      serverCommand: entry.definition.serverCommand,
      bridgeName: VCM_CODE_INTELLIGENCE_PLUGIN_NAME,
      detected: true,
      serverFound,
      serverRunnable,
      state,
      workspaceRoot: taskRuntime.taskRepoRoot,
      pid: runtime?.pid,
      error: runtime?.error ?? staticLanguageError(state, entry.definition.serverCommand, entry.probeResult),
      detectedBy: entry.detectedBy
    };
  });
  return { state: overallState(languages), languages };
}

function overallState(languages: HarnessCodeIntelligenceLanguageStatus[]): HarnessCodeIntelligenceStatus["state"] {
  if (languages.length === 0) {
    return "not_detected";
  }
  if (languages.every((languageStatus) => languageStatus.state === "ready")) {
    return "available";
  }
  if (languages.every((languageStatus) => languageStatus.state === "server_missing" || languageStatus.state === "server_failed")) {
    return "missing";
  }
  return "partial";
}

function staticLanguageError(
  state: HarnessCodeIntelligenceLanguageState,
  command: string,
  probeResult: CommandResult | undefined
): string | undefined {
  if (state === "server_missing") {
    return `${command} was not found in the VCM backend PATH.`;
  }
  if (state === "server_unverified") {
    return `${command} was found but has not been probed by this runtime.`;
  }
  if (state !== "server_failed") {
    return undefined;
  }
  const detail = firstNonEmptyLine(probeResult?.stderr, probeResult?.stdout);
  return detail
    ? `${command} failed its startup probe. ${detail}`
    : `${command} failed its startup probe with exit code ${probeResult?.exitCode ?? 1}.`;
}

async function runPositionQuery(
  client: LspJsonRpcClient,
  operation: CodeIntelligenceQueryRequest["operation"],
  textDocument: { uri: string },
  position: { line: number; character: number }
): Promise<unknown> {
  const params = { textDocument, position };
  if (operation === "definition") {
    return client.request("textDocument/definition", params);
  }
  if (operation === "implementations") {
    return client.request("textDocument/implementation", params);
  }
  if (operation === "references") {
    return client.request("textDocument/references", { ...params, context: { includeDeclaration: true } });
  }
  if (operation === "hover") {
    return client.request("textDocument/hover", params);
  }
  if (operation === "incoming_calls" || operation === "outgoing_calls") {
    const items = await client.request<unknown[]>("textDocument/prepareCallHierarchy", params);
    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }
    const method = operation === "incoming_calls" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls";
    const results = await Promise.all(items.map((item) => client.request<unknown[]>(method, { item })));
    return results.flat();
  }
  throw new Error(`Unsupported position query: ${operation}`);
}

function lspClientCapabilities(): Record<string, unknown> {
  return {
    workspace: {
      workspaceFolders: true,
      symbol: { dynamicRegistration: false }
    },
    textDocument: {
      synchronization: { dynamicRegistration: false, didSave: false },
      documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      definition: { linkSupport: true },
      implementation: { linkSupport: true },
      references: { dynamicRegistration: false },
      hover: { contentFormat: ["markdown", "plaintext"] },
      callHierarchy: { dynamicRegistration: false }
    },
    window: { workDoneProgress: true }
  };
}

async function findWarmupSourceFile(
  fs: FileSystemAdapter,
  repoRoot: string,
  definition: LanguageDefinition
): Promise<string | undefined> {
  const indexed = await readModuleIndexPaths(fs, repoRoot);
  for (const candidate of indexed) {
    if (!definition.extensions.includes(path.extname(candidate).toLowerCase())) {
      continue;
    }
    const absolutePath = path.resolve(repoRoot, candidate);
    if (isInside(repoRoot, absolutePath) && await fs.pathExists(absolutePath)) {
      return absolutePath;
    }
  }
  let visited = 0;
  const queue = [repoRoot];
  while (queue.length > 0 && visited < SOURCE_SCAN_LIMIT) {
    const directory = queue.shift()!;
    let entries: string[];
    try {
      entries = await fs.readDir(directory);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      visited += 1;
      if (visited >= SOURCE_SCAN_LIMIT) {
        break;
      }
      if (SOURCE_SCAN_IGNORED_DIRS.has(entry)) {
        continue;
      }
      const candidate = path.join(directory, entry);
      if (definition.extensions.includes(path.extname(entry).toLowerCase())) {
        return candidate;
      }
      if (!path.extname(entry)) {
        queue.push(candidate);
      }
    }
  }
  return undefined;
}

async function readModuleIndexPaths(fs: FileSystemAdapter, repoRoot: string): Promise<string[]> {
  const indexPath = path.join(repoRoot, ".ai/generated/module-index.json");
  if (!await fs.pathExists(indexPath)) {
    return [];
  }
  try {
    return collectPathLikeStrings(await fs.readJson<unknown>(indexPath));
  } catch {
    return [];
  }
}

async function detectLanguage(
  fs: FileSystemAdapter,
  repoRoot: string,
  indexPaths: string[],
  definition: LanguageDefinition
): Promise<string[]> {
  const evidence = new Set<string>();
  for (const manifest of definition.manifests) {
    if (await fs.pathExists(path.join(repoRoot, manifest))) {
      evidence.add(manifest);
    }
  }
  for (const filePath of indexPaths) {
    if (definition.extensions.includes(path.extname(filePath).toLowerCase())) {
      evidence.add(".ai/generated/module-index.json");
      break;
    }
  }
  return [...evidence];
}

async function findExecutable(
  fs: FileSystemAdapter,
  repoRoot: string,
  command: string,
  options: DetectCodeIntelligenceOptions
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const extensions = platform === "win32"
    ? (options.pathExt ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of pathEnv.split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory || repoRoot, `${command}${extension.toLowerCase()}`);
      if (await fs.pathExists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function resolveRequestLanguage(request: CodeIntelligenceQueryRequest): LanguageDefinition | undefined {
  const requestedLanguage = request.language?.toLowerCase();
  if (requestedLanguage) {
    return LANGUAGE_DEFINITIONS.find((definition) => definition.language === requestedLanguage);
  }
  const extension = path.extname(request.path ?? "").toLowerCase();
  return LANGUAGE_DEFINITIONS.find((definition) => definition.extensions.includes(extension));
}

function resolveSourcePath(repoRoot: string, relativePath: string): string {
  const absolutePath = path.resolve(repoRoot, relativePath);
  if (!isInside(repoRoot, absolutePath)) {
    throw new Error(`Source path escapes the active task worktree: ${relativePath}`);
  }
  return absolutePath;
}

function isInside(repoRoot: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(repoRoot), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function languageIdForPath(languageName: HarnessCodeIntelligenceLanguage, filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (languageName === "typescript") {
    if (extension === ".tsx") return "typescriptreact";
    if (extension === ".jsx") return "javascriptreact";
    if ([".js", ".mjs", ".cjs"].includes(extension)) return "javascript";
    return "typescript";
  }
  if (languageName === "cpp") {
    return [".c", ".h"].includes(extension) ? "c" : "cpp";
  }
  return languageName;
}

function normalizeLspValue(value: unknown, repoRoot: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeLspValue(item, repoRoot));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "uri" || key === "targetUri") && typeof child === "string" && child.startsWith("file:")) {
      const absolutePath = fileURLToPath(child);
      output[key === "targetUri" ? "targetPath" : "path"] = isInside(repoRoot, absolutePath)
        ? path.relative(repoRoot, absolutePath).split(path.sep).join("/")
        : absolutePath;
      continue;
    }
    if ((key === "line" || key === "character") && typeof child === "number") {
      output[key] = child + 1;
      continue;
    }
    output[key] = normalizeLspValue(child, repoRoot);
  }
  return output;
}

function isEmptyLspResult(value: unknown): boolean {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

function firstSymbolName(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const item of value) {
    if (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") {
      return (item as { name: string }).name;
    }
  }
  return undefined;
}

function unresolved(
  operation: CodeIntelligenceQueryRequest["operation"],
  workspaceRoot: string,
  languageName: string | undefined,
  reason: string,
  errorCode: string
): CodeIntelligenceQueryResult {
  return {
    status: "unresolved",
    operation,
    workspaceRoot,
    language: languageName,
    reason,
    errorCode
  };
}

function requireText(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function requirePositiveInteger(value: number | undefined, label: string): number {
  if (!Number.isInteger(value) || (value ?? 0) < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value!;
}

function language(
  languageName: HarnessCodeIntelligenceLanguage,
  label: string,
  extensions: string[],
  manifests: string[],
  serverCommand: string,
  serverArgs: string[] = [],
  probeArgs: string[] = ["--version"]
): LanguageDefinition {
  return { language: languageName, label, extensions, manifests, serverCommand, serverArgs, probeArgs };
}

function firstNonEmptyLine(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const line = value?.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
    if (line) {
      return line.length > 300 ? `${line.slice(0, 297)}...` : line;
    }
  }
  return undefined;
}

function collectPathLikeStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return value.includes("/") || path.extname(value) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectPathLikeStrings);
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(collectPathLikeStrings);
  }
  return [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
