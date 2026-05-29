import fs from "node:fs/promises";
import path from "node:path";

export interface FileSystemAdapter {
  pathExists(path: string): Promise<boolean>;
  ensureDir(path: string): Promise<void>;
  readDir(path: string): Promise<string[]>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  appendText(path: string, content: string): Promise<void>;
  readJson<T>(path: string): Promise<T>;
  writeJson<T>(path: string, value: T): Promise<void>;
  writeJsonAtomic<T>(path: string, value: T): Promise<void>;
  ensureFile(path: string, content: string, options?: EnsureFileOptions): Promise<boolean>;
}

export interface EnsureFileOptions {
  overwrite?: boolean;
}

export function createNodeFileSystemAdapter(): FileSystemAdapter {
  return {
    async pathExists(targetPath) {
      try {
        await fs.access(targetPath);
        return true;
      } catch {
        return false;
      }
    },
    async ensureDir(targetPath) {
      await fs.mkdir(targetPath, { recursive: true });
    },
    async readDir(targetPath) {
      return fs.readdir(targetPath);
    },
    async readText(targetPath) {
      return fs.readFile(targetPath, "utf8");
    },
    async writeText(targetPath, content) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content, "utf8");
    },
    async appendText(targetPath, content) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.appendFile(targetPath, content, "utf8");
    },
    async readJson<T>(targetPath: string) {
      return JSON.parse(await fs.readFile(targetPath, "utf8")) as T;
    },
    async writeJson<T>(targetPath: string, value: T) {
      await this.writeText(targetPath, `${JSON.stringify(value, null, 2)}\n`);
    },
    async writeJsonAtomic<T>(targetPath: string, value: T) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const tempPath = `${targetPath}.${process.pid}.tmp`;
      await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      await fs.rename(tempPath, targetPath);
    },
    async ensureFile(targetPath, content, options = {}) {
      if (!options.overwrite && await this.pathExists(targetPath)) {
        return false;
      }

      await this.writeText(targetPath, content);
      return true;
    }
  };
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
