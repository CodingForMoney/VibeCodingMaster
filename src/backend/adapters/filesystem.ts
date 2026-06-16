import fs from "node:fs/promises";
import path from "node:path";
import { isOpenFileLimitError } from "../errors.js";

export interface FileSystemAdapter {
  pathExists(path: string): Promise<boolean>;
  ensureDir(path: string): Promise<void>;
  readDir(path: string): Promise<string[]>;
  readText(path: string): Promise<string>;
  readTextTail?(path: string, maxBytes: number): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  appendText(path: string, content: string): Promise<void>;
  readJson<T>(path: string): Promise<T>;
  writeJson<T>(path: string, value: T): Promise<void>;
  writeJsonAtomic<T>(path: string, value: T): Promise<void>;
  ensureFile(path: string, content: string, options?: EnsureFileOptions): Promise<boolean>;
  removePath?(targetPath: string, options?: RemovePathOptions): Promise<void>;
}

export interface EnsureFileOptions {
  overwrite?: boolean;
}

export interface RemovePathOptions {
  recursive?: boolean;
  force?: boolean;
}

export function createNodeFileSystemAdapter(): FileSystemAdapter {
  const runFileOperation = createFileOperationRunner();

  return {
    async pathExists(targetPath) {
      try {
        await runFileOperation(() => fs.access(targetPath));
        return true;
      } catch (error) {
        if (isMissingPathError(error)) {
          return false;
        }
        throw error;
      }
    },
    async ensureDir(targetPath) {
      await runFileOperation(() => fs.mkdir(targetPath, { recursive: true }));
    },
    async readDir(targetPath) {
      return runFileOperation(() => fs.readdir(targetPath));
    },
    async readText(targetPath) {
      return runFileOperation(() => fs.readFile(targetPath, "utf8"));
    },
    async readTextTail(targetPath, maxBytes) {
      return runFileOperation(async () => {
        const handle = await fs.open(targetPath, "r");
        try {
          const stat = await handle.stat();
          const length = Math.min(Math.max(0, Math.floor(maxBytes)), stat.size);
          const position = stat.size - length;
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, position);
          return buffer.toString("utf8");
        } finally {
          await handle.close();
        }
      });
    },
    async writeText(targetPath, content) {
      await runFileOperation(async () => {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, content, "utf8");
      });
    },
    async appendText(targetPath, content) {
      await runFileOperation(async () => {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.appendFile(targetPath, content, "utf8");
      });
    },
    async readJson<T>(targetPath: string) {
      return JSON.parse(await runFileOperation(() => fs.readFile(targetPath, "utf8"))) as T;
    },
    async writeJson<T>(targetPath: string, value: T) {
      await this.writeText(targetPath, `${JSON.stringify(value, null, 2)}\n`);
    },
    async writeJsonAtomic<T>(targetPath: string, value: T) {
      await runFileOperation(async () => {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
        await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        await fs.rename(tempPath, targetPath);
      });
    },
    async ensureFile(targetPath, content, options = {}) {
      if (!options.overwrite && await this.pathExists(targetPath)) {
        return false;
      }

      await this.writeText(targetPath, content);
      return true;
    },
    async removePath(targetPath, options = {}) {
      await runFileOperation(() => fs.rm(targetPath, {
        recursive: options.recursive ?? false,
        force: options.force ?? false
      }));
    }
  };
}

const DEFAULT_FILE_OPERATION_CONCURRENCY = 8;
const OPEN_FILE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800];

type FileOperationRunner = <T>(operation: () => Promise<T>) => Promise<T>;

function createFileOperationRunner(maxConcurrent = DEFAULT_FILE_OPERATION_CONCURRENCY): FileOperationRunner {
  let active = 0;
  const waiters: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (active < maxConcurrent) {
      active += 1;
      return;
    }

    await new Promise<void>((resolve) => waiters.push(resolve));
  }

  function release(): void {
    const next = waiters.shift();
    if (next) {
      next();
      return;
    }
    active = Math.max(0, active - 1);
  }

  return async (operation) => {
    await acquire();
    try {
      return await retryOpenFileLimit(operation);
    } finally {
      release();
    }
  };
}

async function retryOpenFileLimit<T>(operation: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      const delayMs = OPEN_FILE_RETRY_DELAYS_MS[attempt];
      if (!isOpenFileLimitError(error) || delayMs === undefined) {
        throw error;
      }
      attempt += 1;
      await delay(delayMs);
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveRepoPath(repoRoot: string, repoRelativePath: string): string {
  if (path.isAbsolute(repoRelativePath)) {
    return repoRelativePath;
  }

  return path.resolve(repoRoot, repoRelativePath);
}

export function toRepoRelativePath(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).split(path.sep).join(path.posix.sep);
}
