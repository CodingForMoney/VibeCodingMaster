import type { ClaudeAdapter } from "../adapters/claude-adapter.js";

// The oldest Claude Code release VCM has been verified against. Raise it after
// verifying a newer release; older releases may lack hooks or flags VCM uses.
export const MIN_CLAUDE_CODE_VERSION = "2.1.310";

const VERSION_CACHE_TTL_MS = 10 * 60 * 1000;

export interface ClaudeVersionCheck {
  // Returns a warning when the installed Claude Code is older than the minimum
  // or cannot be probed. Results are cached per command unless refresh is set.
  getWarning(command: string, options?: { refresh?: boolean }): Promise<string | undefined>;
}

export function createClaudeVersionCheck(
  claude: Pick<ClaudeAdapter, "getVersion">,
  now: () => number = Date.now
): ClaudeVersionCheck {
  const cache = new Map<string, { warning: string | undefined; checkedAt: number }>();

  return {
    async getWarning(command, options = {}) {
      const cached = cache.get(command);
      if (cached && !options.refresh && now() - cached.checkedAt < VERSION_CACHE_TTL_MS) {
        return cached.warning;
      }
      const warning = await probe(command);
      cache.set(command, { warning, checkedAt: now() });
      return warning;
    }
  };

  async function probe(command: string): Promise<string | undefined> {
    let output: string;
    try {
      output = await claude.getVersion(command);
    } catch (error) {
      return `Claude Code version could not be checked: ${error instanceof Error ? error.message : String(error)}`;
    }
    const version = parseClaudeCodeVersion(output);
    if (!version) {
      return `Claude Code version could not be parsed from "${output}". VCM is verified with ${MIN_CLAUDE_CODE_VERSION} or newer.`;
    }
    return compareVersions(version, parseClaudeCodeVersion(MIN_CLAUDE_CODE_VERSION)!) < 0
      ? `Claude Code ${version.join(".")} is older than the minimum verified version ${MIN_CLAUDE_CODE_VERSION}. Upgrade Claude Code; older releases may lack hooks or flags VCM relies on.`
      : undefined;
  }
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
