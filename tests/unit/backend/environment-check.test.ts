import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerClaudeHookRoutes } from "../../../src/backend/api/claude-hook-routes.js";
import { createCommandRunner, type CommandResult, type CommandRunner, type CommandRunnerOptions } from "../../../src/backend/adapters/command-runner.js";
import type { ClaudeHookService } from "../../../src/backend/services/claude-hook-service.js";
import { createEnvironmentCheck, type EnvironmentCheck } from "../../../src/backend/services/environment-check.js";
import { renderVcmHookProbeCommand } from "../../../src/backend/services/harness-service.js";
import { buildVcmNoProxyEnvironment } from "../../../src/backend/services/no-proxy-environment.js";

const OK: CommandResult = { stdout: "", stderr: "", exitCode: 0 };
const MISSING = (command: string): CommandResult => ({
  stdout: "",
  stderr: `Command failed with ENOENT: ${command}\nspawn ${command} ENOENT`,
  exitCode: 1
});

describe("createEnvironmentCheck", () => {
  it("reports nothing when every host program is present and the hook probe arrives", async () => {
    let check: EnvironmentCheck;
    const runner = fakeRunner({
      sh: (args, options) => {
        if (args[0] === "-c" && args[1] !== "exit 0") {
          check.receiveHookProbe(options?.env?.VCM_RUNTIME_SESSION_TOKEN);
        }
        return OK;
      }
    });
    check = createEnvironmentCheck({ runner, apiUrl: "http://127.0.0.1:4173", baseEnv: {} });

    await expect(check.getWarnings()).resolves.toEqual([]);
  });

  it("reports missing programs and skips the hook probe they would break", async () => {
    const runner = fakeRunner({
      git: () => MISSING("git --version"),
      curl: () => MISSING("curl --version")
    });
    const check = createEnvironmentCheck({ runner, apiUrl: "http://127.0.0.1:4173", baseEnv: {} });

    const warnings = await check.getWarnings();

    expect(warnings).toEqual([
      "Git is not available: Command failed with ENOENT: git --version. VCM needs Git 2.22.0 or newer on PATH to read repositories and create task worktrees.",
      expect.stringContaining("curl is not available: Command failed with ENOENT: curl --version. VCM role hooks use curl")
    ]);
    expect(runner.calls.filter((call) => call.command === "sh" && call.args[1] !== "exit 0")).toEqual([]);
  });

  it("reports Git and Node.js versions older than VCM supports", async () => {
    let check: EnvironmentCheck;
    const runner = fakeRunner({
      git: () => ({ ...OK, stdout: "git version 2.20.1" }),
      node: () => ({ ...OK, stdout: "v18.19.0" }),
      sh: (args, options) => {
        if (args[1] !== "exit 0") check.receiveHookProbe(options?.env?.VCM_RUNTIME_SESSION_TOKEN);
        return OK;
      }
    });
    check = createEnvironmentCheck({ runner, apiUrl: "http://127.0.0.1:4173", baseEnv: {} });

    await expect(check.getWarnings()).resolves.toEqual([
      "Git 2.20.1 is older than 2.22.0, the oldest version VCM supports. Upgrade Git.",
      expect.stringContaining("The node on PATH is 18.19.0, but VCM role hooks and .ai/tools scripts need Node.js 20 or newer.")
    ]);
  });

  it("reports a hook probe that never reaches VCM with the pipeline's error", async () => {
    const runner = fakeRunner({
      sh: (args) => args[1] === "exit 0"
        ? OK
        : { ...OK, stderr: "curl: (56) Received HTTP code 502 from proxy after CONNECT\n" }
    });
    const check = createEnvironmentCheck({ runner, apiUrl: "http://127.0.0.1:4173", baseEnv: {} });

    await expect(check.probeHookDelivery()).resolves.toBe(
      "VCM role hooks cannot reach VCM at http://127.0.0.1:4173: curl: (56) Received HTTP code 502 from proxy after CONNECT. Role sessions will not report turns to VCM, so dispatches stay unconfirmed. Check that sh, node, and curl are on PATH and that any HTTP proxy excludes 127.0.0.1 through NO_PROXY."
    );
  });

  it("caches results until refresh is requested", async () => {
    const runner = fakeRunner({ curl: () => MISSING("curl --version") });
    const check = createEnvironmentCheck({ runner, apiUrl: undefined, baseEnv: {} });

    await check.getWarnings();
    await check.getWarnings();
    expect(runner.calls.filter((call) => call.command === "curl")).toHaveLength(1);

    await check.getWarnings({ refresh: true });
    expect(runner.calls.filter((call) => call.command === "curl")).toHaveLength(2);
  });

  it("reports an installed gh that is not logged in", async () => {
    const runner = fakeRunner({
      gh: (args) => args[0] === "--version"
        ? { ...OK, stdout: "gh version 2.103.2" }
        : { stdout: "", stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login\n", exitCode: 1 }
    });
    const check = createEnvironmentCheck({ runner, baseEnv: {} });

    await expect(check.getWarnings()).resolves.toEqual([
      "GitHub CLI (gh) is installed but not logged in: You are not logged into any GitHub hosts. To log in, run: gh auth login. VCM does not run gh itself, but roles that use gh for pull requests or issues will fail. Run gh auth login in the environment that runs VCM."
    ]);
  });

  it("does not require gh when it is not installed", async () => {
    const runner = fakeRunner({ gh: () => MISSING("gh --version") });
    const check = createEnvironmentCheck({ runner, baseEnv: {} });

    await expect(check.getWarnings()).resolves.toEqual([]);
    expect(runner.calls.filter((call) => call.command === "gh")).toEqual([{ command: "gh", args: ["--version"] }]);
  });

  it("reports a Git remote that cannot be reached without prompting and caches it per repository", async () => {
    const checked: string[] = [];
    const check = createEnvironmentCheck({
      runner: fakeRunner({}),
      baseEnv: {},
      git: {
        async checkRemoteAccess(repoRoot) {
          checked.push(repoRoot);
          return repoRoot === "/broken"
            ? { status: "failed", remote: "origin", detail: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" }
            : { status: "ok", remote: "origin" };
        }
      }
    });

    await expect(check.getRepositoryWarnings("/broken")).resolves.toEqual([
      "Git cannot reach remote \"origin\": fatal: could not read Username for 'https://github.com': terminal prompts disabled. Creating a task and Pull fetch the upstream branch first, so both will fail. VCM runs Git without credential prompts; check the remote URL and set up credentials for it in the environment that runs VCM, such as an SSH key loaded in ssh-agent or a Git credential helper."
    ]);
    await expect(check.getRepositoryWarnings("/ok")).resolves.toEqual([]);
    await check.getRepositoryWarnings("/broken");
    expect(checked).toEqual(["/broken", "/ok"]);
  });

  it("ignores probe tokens it did not issue", () => {
    const check = createEnvironmentCheck({ runner: fakeRunner({}), baseEnv: {} });

    expect(check.receiveHookProbe("unknown")).toBe(false);
    expect(check.receiveHookProbe(undefined)).toBe(false);
  });
});

describe("hook self-test through the installed hook pipeline", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function listen(check: () => EnvironmentCheck): Promise<string> {
    app = Fastify({ logger: false });
    registerClaudeHookRoutes(app, {
      claudeHookService: {} as ClaudeHookService,
      environmentCheck: { receiveHookProbe: (token) => check().receiveHookProbe(token) }
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind a port");
    return `http://127.0.0.1:${address.port}`;
  }

  it("delivers the probe even when an HTTP proxy is configured", async () => {
    let check: EnvironmentCheck | undefined;
    const apiUrl = await listen(() => check!);
    check = createEnvironmentCheck({
      runner: createCommandRunner(),
      apiUrl,
      // An unreachable proxy: without the NO_PROXY merge curl would send the
      // loopback hook through it and fail.
      baseEnv: { ...process.env, http_proxy: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "", no_proxy: "" }
    });

    await expect(check.probeHookDelivery()).resolves.toBeUndefined();
  });

  it("reports a VCM API URL the hook pipeline cannot reach", async () => {
    let check: EnvironmentCheck | undefined;
    const apiUrl = await listen(() => check!);
    await app!.close();
    app = undefined;
    check = createEnvironmentCheck({ runner: createCommandRunner(), apiUrl, baseEnv: process.env, hookProbeTimeoutMs: 10_000 });

    await expect(check.probeHookDelivery()).resolves.toMatch(
      new RegExp(`^VCM role hooks cannot reach VCM at ${apiUrl.replaceAll(".", "\\.")}: curl: \\(7\\)`)
    );
  });
});

describe("renderVcmHookProbeCommand", () => {
  it("runs the installed hook command against the probe endpoint", () => {
    const probe = renderVcmHookProbeCommand();

    expect(probe).toContain('"${VCM_API_URL}/api/hooks/probe"');
    expect(probe).not.toContain("/api/hooks/claude-code");
    expect(probe).toContain("| curl -fsS");
  });
});

describe("buildVcmNoProxyEnvironment", () => {
  it("appends the VCM host to the inherited NO_PROXY list", () => {
    expect(buildVcmNoProxyEnvironment("http://127.0.0.1:4173", {}, { no_proxy: "corp.internal, localhost" })).toEqual({
      NO_PROXY: "corp.internal,localhost,127.0.0.1",
      no_proxy: "corp.internal,localhost,127.0.0.1"
    });
  });

  it("keeps a model environment's NO_PROXY entries", () => {
    expect(buildVcmNoProxyEnvironment("http://127.0.0.1:4173", { NO_PROXY: "127.0.0.1" }, { NO_PROXY: "corp.internal" })).toEqual({
      NO_PROXY: "127.0.0.1",
      no_proxy: "127.0.0.1"
    });
  });

  it("lists IPv6 hosts without brackets and skips missing URLs", () => {
    expect(buildVcmNoProxyEnvironment("http://[::1]:4173", {}, {}).NO_PROXY).toBe("::1");
    expect(buildVcmNoProxyEnvironment(undefined, {}, {})).toEqual({});
  });
});

type Handler = (args: string[], options?: CommandRunnerOptions) => CommandResult;

function fakeRunner(handlers: Partial<Record<"git" | "sh" | "node" | "curl" | "gh", Handler>>): CommandRunner & {
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const defaults: Record<string, CommandResult> = {
    git: { ...OK, stdout: "git version 2.50.1 (Apple Git-155)" },
    node: { ...OK, stdout: "v22.12.0" },
    curl: { ...OK, stdout: "curl 8.7.1" },
    gh: { ...OK, stdout: "gh version 2.103.2" },
    sh: OK
  };
  return {
    calls,
    async run(command, args = [], options) {
      calls.push({ command, args });
      const handler = handlers[command as keyof typeof handlers];
      return handler ? handler(args, options) : defaults[command] ?? MISSING(command);
    }
  };
}
