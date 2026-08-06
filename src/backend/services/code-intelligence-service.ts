import path from "node:path";
import type {
  HarnessCodeIntelligenceLanguage,
  HarnessCodeIntelligenceLanguageStatus,
  HarnessCodeIntelligenceStatus
} from "../../shared/types/harness.js";
import type { FileSystemAdapter } from "../adapters/filesystem.js";

interface LanguageDefinition {
  language: HarnessCodeIntelligenceLanguage;
  label: string;
  extensions: string[];
  manifests: string[];
  serverCommand: string;
  pluginName: string;
}

const LANGUAGE_DEFINITIONS: LanguageDefinition[] = [
  {
    language: "rust",
    label: "Rust",
    extensions: [".rs"],
    manifests: ["Cargo.toml"],
    serverCommand: "rust-analyzer",
    pluginName: "rust-analyzer-lsp"
  },
  {
    language: "typescript",
    label: "TypeScript / JavaScript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
    manifests: ["package.json", "tsconfig.json", "jsconfig.json"],
    serverCommand: "typescript-language-server",
    pluginName: "typescript-lsp"
  },
  {
    language: "python",
    label: "Python",
    extensions: [".py", ".pyi"],
    manifests: ["pyproject.toml", "requirements.txt", "setup.py"],
    serverCommand: "pyright-langserver",
    pluginName: "pyright-lsp"
  },
  {
    language: "go",
    label: "Go",
    extensions: [".go"],
    manifests: ["go.mod"],
    serverCommand: "gopls",
    pluginName: "gopls-lsp"
  },
  {
    language: "cpp",
    label: "C / C++",
    extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"],
    manifests: ["CMakeLists.txt", "compile_commands.json"],
    serverCommand: "clangd",
    pluginName: "clangd-lsp"
  },
  {
    language: "java",
    label: "Java",
    extensions: [".java"],
    manifests: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
    serverCommand: "jdtls",
    pluginName: "jdtls-lsp"
  }
];

export interface DetectCodeIntelligenceOptions {
  pathEnv?: string;
  pathExt?: string;
  platform?: NodeJS.Platform;
}

export async function detectHarnessCodeIntelligence(
  fs: FileSystemAdapter,
  repoRoot: string,
  options: DetectCodeIntelligenceOptions = {}
): Promise<HarnessCodeIntelligenceStatus> {
  const indexPaths = await readModuleIndexPaths(fs, repoRoot);
  const languages: HarnessCodeIntelligenceLanguageStatus[] = [];

  for (const definition of LANGUAGE_DEFINITIONS) {
    const detectedBy = await detectLanguage(fs, repoRoot, indexPaths, definition);
    if (detectedBy.length === 0) {
      continue;
    }
    languages.push({
      language: definition.language,
      label: definition.label,
      serverCommand: definition.serverCommand,
      pluginName: definition.pluginName,
      serverAvailable: await executableExists(fs, repoRoot, definition.serverCommand, options),
      detectedBy
    });
  }

  const availableCount = languages.filter((language) => language.serverAvailable).length;
  return {
    state: languages.length === 0
      ? "not_detected"
      : availableCount === languages.length
        ? "available"
        : availableCount === 0
          ? "missing"
          : "partial",
    languages
  };
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

async function executableExists(
  fs: FileSystemAdapter,
  repoRoot: string,
  command: string,
  options: DetectCodeIntelligenceOptions
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const extensions = platform === "win32"
    ? (options.pathExt ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];

  for (const directory of pathEnv.split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory || repoRoot, `${command}${extension.toLowerCase()}`);
      if (await fs.pathExists(candidate)) {
        return true;
      }
    }
  }
  return false;
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
