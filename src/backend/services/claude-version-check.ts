import type { ClaudeAdapter } from "../adapters/claude-adapter.js";

// The oldest Claude Code release VCM has been verified against. Raise it after
// verifying a newer release; older releases may lack hooks or flags VCM uses.
export const MIN_CLAUDE_CODE_VERSION = "2.1.310";

const VERSION_CACHE_TTL_MS = 10 * 60 * 1000;
// A failed probe is retried sooner so a fixed installation clears the warning.
const FAILED_PROBE_TTL_MS = 30 * 1000;
export const VERSION_PROBE_TIMEOUT_MS = 10 * 1000;

export interface ClaudeVersionCheck {
  // Returns a warning when the installed Claude Code is older than the minimum
  // or cannot be probed. A cached result is returned immediately and refreshed
  // in the background once stale; refresh waits for a new probe.
  getWarning(command: string, options?: { refresh?: boolean }): Promise<string | undefined>;
}

interface CachedProbe {
  warning: string | undefined;
  failed: boolean;
  checkedAt: number;
}

interface ProbeResult {
  warning: string | undefined;
  failed: boolean;
}

export function createClaudeVersionCheck(
  claude: Pick<ClaudeAdapter, "getVersion">,
  now: () => number = Date.now,
  timeoutMs = VERSION_PROBE_TIMEOUT_MS
): ClaudeVersionCheck {
  const cache = new Map<string, CachedProbe>();
  const inFlight = new Map<string, Promise<string | undefined>>();

  return {
    async getWarning(command, options = {}) {
      const cached = cache.get(command);
      if (!cached || options.refresh) {
        return probeOnce(command);
      }
      const ttl = cached.failed ? FAILED_PROBE_TTL_MS : VERSION_CACHE_TTL_MS;
      if (now() - cached.checkedAt >= ttl) {
        void probeOnce(command);
      }
      return cached.warning;
    }
  };

  // Concurrent callers share one probe per command.
  function probeOnce(command: string): Promise<string | undefined> {
    const running = inFlight.get(command);
    if (running) {
      return running;
    }
    const probe = (async () => {
      try {
        const result = await probeVersion(command);
        cache.set(command, { ...result, checkedAt: now() });
        return result.warning;
      } finally {
        inFlight.delete(command);
      }
    })();
    inFlight.set(command, probe);
    return probe;
  }

  async function probeVersion(command: string): Promise<ProbeResult> {
    let output: string;
    try {
      output = await withTimeout(claude.getVersion(command), timeoutMs);
    } catch (error) {
      return {
        warning: `Claude Code version could not be checked: ${error instanceof Error ? error.message : String(error)}`,
        failed: true
      };
    }
    const version = parseClaudeCodeVersion(output);
    if (!version) {
      return {
        warning: `Claude Code version could not be parsed from "${output}". VCM is verified with ${MIN_CLAUDE_CODE_VERSION} or newer.`,
        failed: true
      };
    }
    return {
      warning: compareVersions(version, parseClaudeCodeVersion(MIN_CLAUDE_CODE_VERSION)!) < 0
        ? `Claude Code ${version.join(".")} is older than the minimum verified version ${MIN_CLAUDE_CODE_VERSION}. Upgrade Claude Code; older releases may lack hooks or flags VCM relies on.`
        : undefined,
      failed: false
    };
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`claude --version did not respond within ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function parseClaudeCodeVersion(output: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}
