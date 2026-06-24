import { resolveRepoPath, type FileSystemAdapter } from "../adapters/filesystem.js";

export interface HarnessRevisionState {
  version: 1;
  revision: number;
  updatedAt?: string;
}

const HARNESS_REVISION_PATH = ".ai/vcm/harness/revision.json";

export async function readHarnessRevisionState(
  fs: FileSystemAdapter,
  repoRoot: string
): Promise<HarnessRevisionState> {
  const revisionPath = resolveRepoPath(repoRoot, HARNESS_REVISION_PATH);
  if (!await fs.pathExists(revisionPath)) {
    return {
      version: 1,
      revision: 0
    };
  }

  const payload = await fs.readJson<Partial<HarnessRevisionState>>(revisionPath);
  return {
    version: 1,
    revision: normalizeRevision(payload.revision),
    updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : undefined
  };
}

export async function bumpHarnessRevision(
  fs: FileSystemAdapter,
  repoRoot: string,
  updatedAt: string
): Promise<HarnessRevisionState> {
  const current = await readHarnessRevisionState(fs, repoRoot);
  const next: HarnessRevisionState = {
    version: 1,
    revision: current.revision + 1,
    updatedAt
  };
  await fs.writeJsonAtomic(resolveRepoPath(repoRoot, HARNESS_REVISION_PATH), next);
  return next;
}

function normalizeRevision(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}
