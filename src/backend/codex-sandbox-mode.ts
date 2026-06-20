import { existsSync } from "node:fs";

export type PathExists = (path: string) => boolean;

export function resolveCodexSandboxMode(
  env: NodeJS.ProcessEnv = process.env,
  pathExists: PathExists = existsSync
): string | undefined {
  const explicit = env.VCM_SANDBOX?.trim();
  if (explicit) {
    return explicit;
  }

  if (
    isTruthy(env.VCM_CODEX_DISABLE_SANDBOX) ||
    isTruthy(env.VCM_CODEX_BYPASS_SANDBOX) ||
    isTruthy(env.CODESPACES) ||
    isTruthy(env.REMOTE_CONTAINERS) ||
    isTruthy(env.DEVCONTAINER)
  ) {
    return "devcontainer";
  }

  const containerName = (env.container ?? env.CONTAINER ?? "").toLowerCase();
  if (containerName === "devcontainer" || containerName === "docker" || containerName === "podman") {
    return "devcontainer";
  }

  if (env.KUBERNETES_SERVICE_HOST || pathExists("/.dockerenv") || pathExists("/run/.containerenv")) {
    return "devcontainer";
  }

  return undefined;
}

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}
