import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const guardPath = path.join(appRoot, "scripts/harness-tools/vcm-bash-guard");

interface GuardPayload {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

async function runGuard(payload: GuardPayload, role?: string): Promise<string | undefined> {
  const reason = await new Promise<string>((resolve, reject) => {
    const child = execFile("python3", [guardPath], {
      env: role ? { ...process.env, VCM_ROLE: role } : process.env
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin?.write(JSON.stringify(payload));
    child.stdin?.end();
  });
  if (!reason) {
    return undefined;
  }
  const parsed = JSON.parse(reason) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
  };
  expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
  return parsed.hookSpecificOutput.permissionDecisionReason;
}

function bash(command: string, extra: Record<string, unknown> = {}): GuardPayload {
  return { tool_name: "Bash", tool_input: { command, ...extra } };
}

describe("vcm-bash-guard", () => {
  const denied: Array<[string, GuardPayload]> = [
    ["run_in_background", bash("cargo test", { run_in_background: true })],
    ["trailing &", bash("sleep 100 &")],
    ["mid-command &", bash("server --port 80 & curl localhost")],
    ["nohup", bash("nohup make build > out.log")],
    ["setsid", bash("setsid ./daemon")],
    ["disown", bash("./serve; disown")],
    ["& inside sh -c payload", bash("sh -c 'sleep 100 &'")],
    ["nohup inside bash -lc payload", bash("bash -lc 'nohup ./serve &'")],
    ["nested shell payload", bash("sh -c \"sh -c 'sleep 100 &'\"")],
    ["backgrounded watch-job", bash(".ai/tools/watch-job job-1 &")],
    ["nohup watch-job", bash("nohup .ai/tools/watch-job job-1")],
    ["backgrounded run-long-check wrapper", bash(".ai/tools/run-long-check --timeout 5m -- cargo test &")],
    ["nohup run-long-check wrapper", bash("nohup .ai/tools/run-long-check --timeout 5m -- cargo test")],
    ["setsid in run-long-check payload", bash(".ai/tools/run-long-check --timeout 5m -- setsid ./daemon")],
    ["background shell payload in run-long-check", bash('.ai/tools/run-long-check --timeout 5m -- sh -c "x & y"')],
    ["piped watch-job", bash(".ai/tools/watch-job job-1 | tail -10")],
    ["pipe into watch-job", bash("printf ready | .ai/tools/watch-job job-1")],
    ["watch-job followed by command", bash(".ai/tools/watch-job job-1 ; grep failed stdout.log")],
    ["watch-job success chain", bash(".ai/tools/watch-job job-1 && echo passed")],
    ["watch-job failure chain", bash(".ai/tools/watch-job job-1 || echo failed")],
    ["watch-job newline chain", bash(".ai/tools/watch-job job-1\ngrep failed stdout.log")],
    ["watch-job subshell", bash("(.ai/tools/watch-job job-1)")],
    ["watch-job command substitution", bash("result=$(.ai/tools/watch-job job-1)")],
    ["watch-job double-quoted command substitution", bash('echo "$(.ai/tools/watch-job job-1)"')],
    ["watch-job double-quoted backtick substitution", bash('echo "`.ai/tools/watch-job job-1`"')],
    ["watch-job shell command string", bash("bash -lc '.ai/tools/watch-job job-1'")],
    ["piped run-long-check", bash(".ai/tools/run-long-check --timeout 5m -- cargo test | tail -5")],
    ["run-long-check followed by command", bash(".ai/tools/run-long-check --timeout 5m -- cargo test ; echo started")],
    ["run-long-check shell command string", bash('.ai/tools/run-long-check --timeout 5m -- bash -c "cargo test"')],
    ["run-long-check env shell command string", bash('.ai/tools/run-long-check --timeout 5m -- env DEMO=1 sh -c "cargo test"')],
    ["run-long-check in executable heredoc", bash([
      "bash <<'EOF'",
      ".ai/tools/run-long-check --timeout 5m -- cargo test | tail -5",
      "EOF"
    ].join("\n"))],
    ["Python os.system backgrounding", bash([
      "python3 - <<'PY'",
      "import os",
      'os.system("sleep 300 &")',
      "PY"
    ].join("\n"))],
    ["Python subprocess.Popen", bash([
      "python3 - <<'PY'",
      "import subprocess",
      'subprocess.Popen(["sleep", "300"])',
      "PY"
    ].join("\n"))],
    ["Python imported Popen alias", bash([
      "python3 - <<'PY'",
      "from subprocess import Popen as start_process",
      'start_process(["sleep", "300"])',
      "PY"
    ].join("\n"))],
    ["Python os.spawn", bash([
      "python3 - <<'PY'",
      "import os",
      'os.spawnlp(os.P_NOWAIT, "sleep", "sleep", "300")',
      "PY"
    ].join("\n"))],
    ["Node child_process.spawn", bash([
      "node <<'JS'",
      'const childProcess = require("node:child_process");',
      'childProcess.spawn("sleep", ["300"]);',
      "JS"
    ].join("\n"))],
    ["Node destructured spawn", bash([
      "node <<'JS'",
      'const { spawn: startProcess } = require("child_process");',
      'startProcess("sleep", ["300"]);',
      "JS"
    ].join("\n"))]
  ];

  const allowed: Array<[string, GuardPayload]> = [
    ["&& chain", bash("npm test && echo done")],
    ["quoted ampersand", bash('echo "R&D dept & friends"')],
    ["fd redirect", bash("make 2>&1 | tail")],
    ["quoted ampersand inside sh -c", bash("sh -c 'echo \"a & b\"'")],
    ["plain watch-job", bash(".ai/tools/watch-job job-1 --window 8m")],
    ["redirected watch-job", bash(".ai/tools/watch-job job-1 > watch.log 2>&1")],
    ["plain run-long-check", bash(".ai/tools/run-long-check --timeout 5m -- cargo test")],
    ["run-long-check direct script", bash('.ai/tools/run-long-check --timeout 5m -- bash /tmp/check.sh "a|b;c"')],
    ["run-long-check escaped operator argument", bash(".ai/tools/run-long-check --timeout 5m -- node check.js a\\|b")],
    ["quoted tool mention", bash("printf '%s' '.ai/tools/watch-job job-1 | tail -1'")],
    ["heredoc tool documentation", bash([
      "cat > /tmp/probe-prose.md <<'EOF'",
      "Use `.ai/tools/run-long-check --timeout 30m -- cargo test`.",
      "Then use `.ai/tools/watch-job <job-id>` until it completes.",
      "EOF"
    ].join("\n"))],
    ["plain heredoc tool documentation", bash([
      "cat > /tmp/probe-prose.md <<EOF",
      ".ai/tools/run-long-check --timeout 30m -- cargo test",
      ".ai/tools/watch-job job-id",
      "EOF"
    ].join("\n"))],
    ["Python bitwise and", bash([
      "python3 - <<'PY'",
      "flags = 3",
      "mask = 1",
      "print(flags & mask)",
      "PY"
    ].join("\n"))],
    ["Python ampersand comment", bash([
      "python3 - <<'PY'",
      "# subprocess.Popen(['sleep', '300']) & take reference here",
      'print("subprocess.Popen and R&D are documentation")',
      "PY"
    ].join("\n"))],
    ["Python foreground subprocess.run", bash([
      "python3 - <<'PY'",
      "import subprocess",
      'subprocess.run(["printf", "ok"], check=True)',
      "PY"
    ].join("\n"))],
    ["Node bitwise and", bash([
      "node <<'JS'",
      "const flags = 3;",
      "const mask = 1;",
      "console.log(flags & mask);",
      "JS"
    ].join("\n"))],
    ["Node ampersand comment", bash([
      "node <<'JS'",
      '// child_process.spawn("sleep", ["300"]) & take reference here',
      'console.log("child_process.spawn and R&D are documentation");',
      "JS"
    ].join("\n"))],
    ["process API names in data heredoc", bash([
      "cat > /tmp/process-api-notes.md <<'EOF'",
      "subprocess.Popen(['sleep', '300'])",
      'child_process.spawn("sleep", ["300"])',
      "EOF"
    ].join("\n"))],
    ["non-Bash tool", { tool_name: "Read", tool_input: { file_path: "a&b.txt" } }]
  ];

  for (const [label, payload] of denied) {
    it(`denies ${label}`, async () => {
      const reason = await runGuard(payload);
      expect(reason, `${label} should be denied`).toBeDefined();
      expect(reason).toContain("vcm-long-running-validation");
    });
  }

  for (const [label, payload] of allowed) {
    it(`allows ${label}`, async () => {
      await expect(runGuard(payload)).resolves.toBeUndefined();
    });
  }

  describe("text search", () => {
    const commands = [
      "rg symbol src",
      "grep -R symbol src",
      "git grep symbol",
      "egrep symbol src/file.ts",
      "fgrep symbol src/file.ts",
      "ripgrep symbol src",
      "/usr/bin/grep symbol src/file.ts",
      "printf x | rg x",
      "sh -c 'rg symbol src'",
      'printf "%s" "$(rg symbol src)"',
      "find src -type f -exec grep symbol {} ;",
      "find src -type f -print0 | xargs -0 rg symbol"
    ];

    for (const role of ["project-manager", "architect", "coder", "tester", "reviewer", "translator", "harness-engineer"]) {
      it(`allows Grep and shell text search for ${role}`, async () => {
        for (const command of commands) {
          await expect(runGuard(bash(command), role)).resolves.toBeUndefined();
        }
        await expect(runGuard(bash("rg symbol src"), role)).resolves.toBeUndefined();
        await expect(runGuard({
          tool_name: "Grep",
          tool_input: { pattern: "symbol", path: "src" }
        }, role)).resolves.toBeUndefined();
      });
    }
  });

  describe("managed artifacts", () => {
    it("denies direct Write and Edit calls", async () => {
      await expect(runGuard({
        tool_name: "Write",
        tool_input: { file_path: ".ai/vcm/handoffs/test-report.md", content: "bad" }
      }, "tester")).resolves.toContain("vcm-artifact");
      await expect(runGuard({
        tool_name: "Edit",
        tool_input: { file_path: ".ai/vcm/gate-reviews/requests/request.report.md" }
      }, "reviewer")).resolves.toContain("vcm-artifact");
    });

    it("allows Harness Engineer to write the assigned retrospective report directly", async () => {
      const reportPath = ".ai/vcm/harness-feedback/task-retrospectives/demo-task.md";
      await expect(runGuard({
        tool_name: "Write",
        tool_input: { file_path: reportPath, content: "# Task Harness Retrospective: demo-task" }
      }, "harness-engineer")).resolves.toBeUndefined();
      await expect(runGuard(
        bash(`printf report > ${reportPath}`),
        "harness-engineer"
      )).resolves.toBeUndefined();
    });

    it("denies shell writes but allows vcm-artifact submission", async () => {
      await expect(runGuard(
        bash("printf bad > .ai/vcm/handoffs/architecture-plan.md"),
        "architect"
      )).resolves.toContain("vcm-artifact");
      await expect(runGuard(
        bash("printf bad > \".ai/vcm/handoffs/architecture-plan.md\""),
        "architect"
      )).resolves.toContain("vcm-artifact");
      await expect(runGuard(
        bash(".ai/tools/vcm-artifact architecture-plan --file /tmp/plan.md --mode final"),
        "architect"
      )).resolves.toBeUndefined();
      await expect(runGuard(
        bash(".ai/tools/vcm-artifact memory-proposal --file /tmp/memory.md --path .ai/vcm/memory-review/candidates/architect/planning.md --mode final"),
        "architect"
      )).resolves.toBeUndefined();
    });

    it("allows managed artifacts as read-only inputs", async () => {
      await expect(runGuard(
        bash("cat .ai/vcm/handoffs/architecture-plan.md"),
        "architect"
      )).resolves.toBeUndefined();
      await expect(runGuard(
        bash("cp .ai/vcm/handoffs/architecture-plan.md /tmp/probe-plan.md"),
        "architect"
      )).resolves.toBeUndefined();
      await expect(runGuard(
        bash("python3 -c 'from pathlib import Path; print(Path(\".ai/vcm/handoffs/architecture-plan.md\").read_text())'"),
        "architect"
      )).resolves.toBeUndefined();
    });

    it("denies commands that mutate a managed artifact target", async () => {
      const commands = [
        "cp /tmp/plan.md .ai/vcm/handoffs/architecture-plan.md",
        "mv .ai/vcm/handoffs/architecture-plan.md /tmp/plan.md",
        "rm .ai/vcm/handoffs/architecture-plan.md",
        "printf bad | tee .ai/vcm/handoffs/architecture-plan.md",
        "sed -i s/old/new/ .ai/vcm/handoffs/architecture-plan.md",
        "python3 -c 'from pathlib import Path; Path(\".ai/vcm/handoffs/architecture-plan.md\").write_text(\"bad\")'",
        [
          "python3 - <<'PY'",
          "from pathlib import Path",
          "Path(\".ai/vcm/handoffs/architecture-plan.md\").write_text(\"bad\")",
          "PY"
        ].join("\n"),
        [
          "node <<'JS'",
          'const fs = require("node:fs");',
          'fs.writeFileSync(".ai/vcm/handoffs/architecture-plan.md", "bad");',
          "JS"
        ].join("\n"),
        "node -e 'require(\"fs\").writeFileSync(\".ai/vcm/handoffs/architecture-plan.md\", \"bad\")'",
        "echo vcm-artifact; printf bad > .ai/vcm/handoffs/architecture-plan.md"
      ];
      for (const command of commands) {
        await expect(runGuard(bash(command), "architect"), command).resolves.toContain("vcm-artifact");
      }
    });

    it("does not let Harness Engineer delete pending feedback directly", async () => {
      await expect(runGuard(
        bash("rm .ai/vcm/harness-feedback/pending/confirmed.md"),
        "harness-engineer"
      )).resolves.toContain("vcm-artifact");
    });
  });
});
