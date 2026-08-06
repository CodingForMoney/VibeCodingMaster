import path from "node:path";
import type {
  HarnessCodeIntelligenceLanguage,
  HarnessCodeIntelligenceLanguageState,
  HarnessCodeIntelligenceLanguageStatus,
  HarnessCodeIntelligenceStatus
} from "../../shared/types/harness.js";
import type { CommandRunner, CommandResult } from "../adapters/command-runner.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";
import {
  VCM_LSP_PLUGIN_DIR,
  VCM_LSP_PLUGIN_MANIFEST,
  VCM_LSP_PLUGIN_NAME
} from "./lsp-plugin.js";

interface LanguageDefinition {
  language: HarnessCodeIntelligenceLanguage;
  label: string;
  extensions: string[];
  manifests: string[];
  serverCommand: string;
  pluginServerName: string;
  probeArgs: string[];
}

const LANGUAGE_DEFINITIONS: LanguageDefinition[] = [
  {
    language: "rust",
    label: "Rust",
    extensions: [".rs"],
    manifests: ["Cargo.toml"],
    serverCommand: "rust-analyzer",
    pluginServerName: "rust-analyzer",
    probeArgs: ["--version"]
  },
  {
    language: "typescript",
    label: "TypeScript / JavaScript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
    manifests: ["package.json", "tsconfig.json", "jsconfig.json"],
    serverCommand: "typescript-language-server",
    pluginServerName: "typescript",
    probeArgs: ["--version"]
  },
  {
    language: "python",
    label: "Python",
    extensions: [".py", ".pyi"],
    manifests: ["pyproject.toml", "requirements.txt", "setup.py"],
    serverCommand: "pyright-langserver",
    pluginServerName: "pyright",
    probeArgs: ["--version"]
  },
  {
    language: "go",
    label: "Go",
    extensions: [".go"],
    manifests: ["go.mod"],
    serverCommand: "gopls",
    pluginServerName: "gopls",
    probeArgs: ["version"]
  },
  {
    language: "cpp",
    label: "C / C++",
    extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"],
    manifests: ["CMakeLists.txt", "compile_commands.json"],
    serverCommand: "clangd",
    pluginServerName: "clangd",
    probeArgs: ["--version"]
  },
  {
    language: "java",
    label: "Java",
    extensions: [".java"],
    manifests: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
    serverCommand: "jdtls",
    pluginServerName: "jdtls",
    probeArgs: ["--version"]
  }
];

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_CACHE_TTL_MS = 60_000;

export interface DetectCodeIntelligenceOptions {
  runner?: Pick<CommandRunner, "run">;
  pluginDir?: string;
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

interface ProbeCacheEntry {
  expiresAt: number;
  result: CommandResult;
}

interface LspPluginManifest {
  lspServers?: Record<string, { command?: unknown }>;
}

export function createHarnessCodeIntelligenceDetector(
  fs: FileSystemAdapter,
  options: DetectCodeIntelligenceOptions = {}
): HarnessCodeIntelligenceDetector {
  const probeCache = new Map<string, ProbeCacheEntry>();
  const probesInFlight = new Map<string, Promise<CommandResult>>();
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  return {
    async detect(repoRoot) {
      return detectCodeIntelligence(fs, repoRoot, options, async (definition, executablePath) => {
        const cacheKey = `${executablePath}\u0000${definition.probeArgs.join("\u0000")}`;
        const cached = probeCache.get(cacheKey);
        const currentTime = now();
        if (cached && cached.expiresAt > currentTime) {
          return cached.result;
        }
        if (!options.runner) {
          return undefined;
        }
        const existingProbe = probesInFlight.get(cacheKey);
        if (existingProbe) {
          return existingProbe;
        }
        const probePromise = options.runner.run(executablePath, definition.probeArgs, {
          cwd: repoRoot,
          timeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
        });
        probesInFlight.set(cacheKey, probePromise);
        const result = await probePromise.finally(() => probesInFlight.delete(cacheKey));
        probeCache.set(cacheKey, {
          expiresAt: currentTime + cacheTtlMs,
          result
        });
        return result;
      });
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

async function detectCodeIntelligence(
  fs: FileSystemAdapter,
  repoRoot: string,
  options: DetectCodeIntelligenceOptions,
  probe: (definition: LanguageDefinition, executablePath: string) => Promise<CommandResult | undefined>
): Promise<HarnessCodeIntelligenceStatus> {
  const indexPaths = await readModuleIndexPaths(fs, repoRoot);
  const pluginServers = await readPluginServers(fs, options.pluginDir ?? VCM_LSP_PLUGIN_DIR);
  const detectedLanguages = await Promise.all(LANGUAGE_DEFINITIONS.map(async (definition) => {
    const detectedBy = await detectLanguage(fs, repoRoot, indexPaths, definition);
    if (detectedBy.length === 0) {
      return undefined;
    }
    const pluginReady = pluginServers.get(definition.pluginServerName) === definition.serverCommand;
    const executablePath = await findExecutable(fs, repoRoot, definition.serverCommand, options);
    const probeResult = executablePath ? await probe(definition, executablePath) : undefined;
    const serverFound = Boolean(executablePath);
    const serverRunnable = probeResult?.exitCode === 0;
    const state = languageState(pluginReady, serverFound, serverRunnable, Boolean(probeResult));
    const status: HarnessCodeIntelligenceLanguageStatus = {
      language: definition.language,
      label: definition.label,
      serverCommand: definition.serverCommand,
      pluginName: VCM_LSP_PLUGIN_NAME,
      detected: true,
      pluginReady,
      serverFound,
      serverRunnable,
      state,
      error: languageError(state, definition.serverCommand, probeResult),
      detectedBy
    };
    return status;
  }));
  const languages = detectedLanguages.filter(
    (language): language is HarnessCodeIntelligenceLanguageStatus => language !== undefined
  );

  const runnableCount = languages.filter((language) => language.state === "server_runnable").length;
  return {
    state: languages.length === 0
      ? "not_detected"
      : runnableCount === languages.length
        ? "available"
        : runnableCount === 0
          ? "missing"
          : "partial",
    languages
  };
}

function languageState(
  pluginReady: boolean,
  serverFound: boolean,
  serverRunnable: boolean,
  probeCompleted: boolean
): HarnessCodeIntelligenceLanguageState {
  if (!pluginReady) {
    return "plugin_missing";
  }
  if (!serverFound) {
    return "server_missing";
  }
  if (!probeCompleted) {
    return "server_unverified";
  }
  return serverRunnable ? "server_runnable" : "server_failed";
}

function languageError(
  state: HarnessCodeIntelligenceLanguageState,
  command: string,
  probeResult: CommandResult | undefined
): string | undefined {
  if (state === "plugin_missing") {
    return `VCM LSP plugin manifest is missing or does not declare ${command}.`;
  }
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

async function readPluginServers(fs: FileSystemAdapter, pluginDir: string): Promise<Map<string, string>> {
  const manifestPath = pluginDir === VCM_LSP_PLUGIN_DIR
    ? VCM_LSP_PLUGIN_MANIFEST
    : path.join(pluginDir, ".claude-plugin", "plugin.json");
  if (!await fs.pathExists(manifestPath)) {
    return new Map();
  }
  try {
    const manifest = await fs.readJson<LspPluginManifest>(manifestPath);
    return new Map(
      Object.entries(manifest.lspServers ?? {})
        .filter((entry): entry is [string, { command: string }] => typeof entry[1]?.command === "string")
        .map(([name, server]) => [name, server.command])
    );
  } catch {
    return new Map();
  }
}

async function readModuleIndexPaths(fs: FileSystemAdapter, repoRoot: string): Promise<string[]> {
  const indexPath = path.join(repoRoot, ".ai/generated/module-index.json");
  if (!await fs.pathExists(indexPath)) {
    return [];
  }
  try {
    const value = await fs.readJson<unknown>(indexPath);
    return collectPathLikeStrings(value);
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
  return Array.from(evidence);
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
    return Object.values(value).flatMap(collectPathLikeStrings);
  }
  return [];
}
