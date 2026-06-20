import { describe, expect, it } from "vitest";
import { resolveCodexSandboxMode } from "../../../src/backend/codex-sandbox-mode.js";

describe("resolveCodexSandboxMode", () => {
  it("preserves explicit VCM_SANDBOX settings", () => {
    expect(resolveCodexSandboxMode({ VCM_SANDBOX: "workspace-write" }, () => true)).toBe("workspace-write");
    expect(resolveCodexSandboxMode({ VCM_SANDBOX: "devcontainer" }, () => false)).toBe("devcontainer");
  });

  it("auto-detects container runtimes that cannot reliably run nested bwrap", () => {
    expect(resolveCodexSandboxMode({ DEVCONTAINER: "true" }, () => false)).toBe("devcontainer");
    expect(resolveCodexSandboxMode({ CODESPACES: "true" }, () => false)).toBe("devcontainer");
    expect(resolveCodexSandboxMode({ container: "docker" }, () => false)).toBe("devcontainer");
    expect(resolveCodexSandboxMode({}, (path) => path === "/.dockerenv")).toBe("devcontainer");
  });

  it("allows an explicit Codex sandbox bypass flag", () => {
    expect(resolveCodexSandboxMode({ VCM_CODEX_DISABLE_SANDBOX: "1" }, () => false)).toBe("devcontainer");
    expect(resolveCodexSandboxMode({ VCM_CODEX_BYPASS_SANDBOX: "true" }, () => false)).toBe("devcontainer");
    expect(resolveCodexSandboxMode({ VCM_CODEX_DISABLE_SANDBOX: "false" }, () => false)).toBeUndefined();
  });
});
