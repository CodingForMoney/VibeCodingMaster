import { randomUUID } from "node:crypto";
import type { CommandRunner } from "../adapters/command-runner.js";
import type { GitAdapter } from "../adapters/git-adapter.js";
import { renderVcmHookProbeCommand } from "./harness-service.js";
import { buildVcmNoProxyEnvironment } from "./no-proxy-environment.js";

// Oldest Git that supports every command VCM runs (`git branch --show-current`).
export const MIN_GIT_VERSION: Version = [2, 22, 0];
// Matches package.json engines; harness tools run with the `node` on PATH.
export const MIN_NODE_MAJOR = 20;

const CHECK_CACHE_TTL_MS = 10 * 60 * 1000;
// A failed check is retried sooner so a fixed environment clears the warning.
const FAILED_CHECK_TTL_MS = 30 * 1000;
const COMMAND_TIMEOUT_MS = 10 * 1000;
// The hook pipeline retries curl twice with a 2 s limit per attempt.
const HOOK_PROBE_TIMEOUT_MS = 15 * 1000;
const HOOK_PROBE_SCOPE = "__vcm_hook_probe__";
const HOOK_PROBE_ROLE = "hook-probe";

type Version = [number, number, number];

export interface EnvironmentCheck {
  // Warnings for host programs VCM and its role sessions run: git, sh, node,
  // curl, and the role hook pipeline that reports Claude Code events to VCM.
  // A cached result is returned immediately and refreshed in the background
  // once stale; refresh waits for new checks.
  getWarnings(options?: { refresh?: boolean }): Promise<string[]>;
  // Warnings for one repository: whether Git can reach the current branch's
  // upstream remote without prompting. Cached per repository like getWarnings.
  getRepositoryWarnings(repoRoot: string, options?: { refresh?: boolean }): Promise<string[]>;
  // Runs only the hook self-test, without the cache, for a dispatch whose
  // UserPromptSubmit hook never arrived.
  probeHookDelivery(): Promise<string | undefined>;
  // Called by the probe endpoint when a probe request reaches VCM.
  receiveHookProbe(probeToken: unknown): boolean;
}

export interface EnvironmentCheckDeps {
  runner: CommandRunner;
  git?: Pick<GitAdapter, "checkRemoteAccess">;
  // The URL role sessions receive as VCM_API_URL; without it the hook
  // self-test is skipped.
  apiUrl?: string;
  baseEnv?: NodeJS.ProcessEnv;
  now?: () => number;
  hookProbeTimeoutMs?: number;
}

interface CachedChecks {
  warnings: string[];
  checkedAt: number;
}

export function createEnvironmentCheck(deps: EnvironmentCheckDeps): EnvironmentCheck {
  const now = deps.now ?? Date.now;
  const baseEnv = deps.baseEnv ?? process.env;
  const hookProbeTimeoutMs = deps.hookProbeTimeoutMs ?? HOOK_PROBE_TIMEOUT_MS;
  const pendingProbes = new Map<string, () => void>();
  let cached: CachedChecks | undefined;
  let inFlight: Promise<string[]> | undefined;
  const repositoryCache = new Map<string, CachedChecks>();
  const repositoryInFlight = new Map<string, Promise<string[]>>();

  return {
    async getWarnings(options = {}) {
      if (!cached || options.refresh) {
        return runOnce();
      }
      const ttl = cached.warnings.length > 0 ? FAILED_CHECK_TTL_MS : CHECK_CACHE_TTL_MS;
      if (now() - cached.checkedAt >= ttl) {
        void runOnce();
      }
      return cached.warnings;
    },
    async getRepositoryWarnings(repoRoot, options = {}) {
      const current = repositoryCache.get(repoRoot);
      if (!current || options.refresh) {
        return runRepositoryOnce(repoRoot);
      }
      const ttl = current.warnings.length > 0 ? FAILED_CHECK_TTL_MS : CHECK_CACHE_TTL_MS;
      if (now() - current.checkedAt >= ttl) {
        void runRepositoryOnce(repoRoot);
      }
      return current.warnings;
    },
    probeHookDelivery,
    receiveHookProbe(probeToken) {
      if (typeof probeToken !== "string") {
        return false;
      }
      const resolve = pendingProbes.get(probeToken);
      if (!resolve) {
        return false;
      }
      pendingProbes.delete(probeToken);
      resolve();
      return true;
    }
  };

  function runOnce(): Promise<string[]> {
    if (inFlight) {
      return inFlight;
    }
    inFlight = (async () => {
      try {
        const warnings = await runChecks();
        cached = { warnings, checkedAt: now() };
        return warnings;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  }

  function runRepositoryOnce(repoRoot: string): Promise<string[]> {
    const running = repositoryInFlight.get(repoRoot);
    if (running) {
      return running;
    }
    const check = (async () => {
      try {
        const warnings = await runRepositoryChecks(repoRoot);
        repositoryCache.set(repoRoot, { warnings, checkedAt: now() });
        return warnings;
      } finally {
        repositoryInFlight.delete(repoRoot);
      }
    })();
    repositoryInFlight.set(repoRoot, check);
    return check;
  }

  async function runRepositoryChecks(repoRoot: string): Promise<string[]> {
    if (!deps.git) {
      return [];
    }
    const access = await deps.git.checkRemoteAccess(repoRoot);
    if (access.status !== "failed") {
      return [];
    }
    return [
      `Git cannot reach remote "${access.remote}": ${trimPeriod(access.detail)}. Creating a task and Pull fetch the upstream branch first, so both will fail. VCM runs Git without credential prompts; check the remote URL and set up credentials for it in the environment that runs VCM, such as an SSH key loaded in ssh-agent or a Git credential helper.`
    ];
  }

  async function runChecks(): Promise<string[]> {
    const [git, sh, node, curl, gh] = await Promise.all([checkGit(), checkSh(), checkNode(), checkCurl(), checkGh()]);
    const warnings = [git, sh, node, curl, gh].filter((warning): warning is string => Boolean(warning));
    // A missing program already explains a failed probe; only probe when the
    // pipeline's programs are present, to catch PATH, proxy, or network faults.
    if (!sh && !node && !curl) {
      const hookWarning = await probeHookDelivery();
      if (hookWarning) {
        warnings.push(hookWarning);
      }
    }
    return warnings;
  }

  async function checkGit(): Promise<string | undefined> {
    const result = await runCommand("git", ["--version"]);
    if (result.exitCode !== 0) {
      return `Git is not available: ${firstLine(result.stderr)}. VCM needs Git ${formatVersion(MIN_GIT_VERSION)} or newer on PATH to read repositories and create task worktrees.`;
    }
    const version = parseVersion(result.stdout);
    if (!version) {
      return `Git version could not be parsed from "${firstLine(result.stdout)}". VCM needs Git ${formatVersion(MIN_GIT_VERSION)} or newer.`;
    }
    if (compareVersions(version, MIN_GIT_VERSION) < 0) {
      return `Git ${formatVersion(version)} is older than ${formatVersion(MIN_GIT_VERSION)}, the oldest version VCM supports. Upgrade Git.`;
    }
    return undefined;
  }

  async function checkSh(): Promise<string | undefined> {
    const result = await runCommand("sh", ["-c", "exit 0"]);
    return result.exitCode === 0
      ? undefined
      : `sh is not available: ${firstLine(result.stderr)}. Claude Code runs every VCM role hook through sh.`;
  }

  async function checkNode(): Promise<string | undefined> {
    const result = await runCommand("node", ["--version"]);
    if (result.exitCode !== 0) {
      return `node is not available on the PATH role sessions inherit: ${firstLine(result.stderr)}. VCM role hooks, Bash and subagent guards, and .ai/tools scripts run with node; add the Node.js bin directory to PATH before starting VCM.`;
    }
    const version = parseVersion(result.stdout);
    if (version && version[0] < MIN_NODE_MAJOR) {
      return `The node on PATH is ${formatVersion(version)}, but VCM role hooks and .ai/tools scripts need Node.js ${MIN_NODE_MAJOR} or newer. Put a newer Node.js first on PATH before starting VCM.`;
    }
    return undefined;
  }

  async function checkCurl(): Promise<string | undefined> {
    const result = await runCommand("curl", ["--version"]);
    return result.exitCode === 0
      ? undefined
      : `curl is not available: ${firstLine(result.stderr)}. VCM role hooks use curl to report Claude Code events; without it VCM cannot see role turns start or finish. Install curl.`;
  }

  // VCM never runs gh, so a missing gh is not a problem; an installed but
  // logged-out gh breaks roles that use it for pull requests or issues.
  async function checkGh(): Promise<string | undefined> {
    const version = await runCommand("gh", ["--version"]);
    if (version.exitCode !== 0) {
      return undefined;
    }
    const status = await deps.runner.run("gh", ["auth", "status"], {
      env: { ...baseEnv, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      timeoutMs: COMMAND_TIMEOUT_MS
    });
    if (status.exitCode === 0) {
      return undefined;
    }
    const detail = firstLine(status.stderr) || firstLine(status.stdout) || `gh auth status exited with ${status.exitCode}`;
    return `GitHub CLI (gh) is installed but not logged in: ${detail}. VCM does not run gh itself, but roles that use gh for pull requests or issues will fail. Run gh auth login in the environment that runs VCM.`;
  }

  async function probeHookDelivery(): Promise<string | undefined> {
    if (!deps.apiUrl) {
      return undefined;
    }
    const probeToken = randomUUID();
    let received = false;
    const arrived = new Promise<void>((resolve) => {
      pendingProbes.set(probeToken, () => {
        received = true;
        resolve();
      });
    });
    try {
      const run = deps.runner.run("sh", ["-c", renderVcmHookProbeCommand()], {
        env: {
          ...baseEnv,
          ...buildVcmNoProxyEnvironment(deps.apiUrl, {}, baseEnv),
          VCM_API_URL: deps.apiUrl,
          VCM_TASK_SLUG: HOOK_PROBE_SCOPE,
          VCM_ROLE: HOOK_PROBE_ROLE,
          VCM_RUNTIME_SESSION_TOKEN: probeToken
        },
        input: "{}",
        timeoutMs: hookProbeTimeoutMs
      });
      // The endpoint records the probe before curl exits, so the command's
      // completion bounds the wait.
      const result = await Promise.race([run, arrived.then(() => undefined)]);
      if (received) {
        return undefined;
      }
      const detail = firstLine(result?.stderr ?? "") || "the request did not arrive";
      return `VCM role hooks cannot reach VCM at ${deps.apiUrl}: ${detail}. Role sessions will not report turns to VCM, so dispatches stay unconfirmed. Check that sh, node, and curl are on PATH and that any HTTP proxy excludes ${readHostname(deps.apiUrl)} through NO_PROXY.`;
    } finally {
      pendingProbes.delete(probeToken);
    }
  }

  function runCommand(command: string, args: string[]) {
    return deps.runner.run(command, args, { env: baseEnv, timeoutMs: COMMAND_TIMEOUT_MS });
  }
}

function parseVersion(output: string): Version | undefined {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
}

function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

function formatVersion(version: Version): string {
  return version.join(".");
}

// Error details end the sentence they are quoted in.
function firstLine(value: string): string {
  return trimPeriod(value.trim().split(/\r?\n/)[0]?.trim() ?? "");
}

function trimPeriod(value: string): string {
  return value.replace(/\.+$/, "");
}

function readHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
