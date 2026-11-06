import { mergeNoProxy } from "./codex-bridge-integration-service.js";

// Role hooks, harness tools, and usage telemetry post to VCM_API_URL. curl and
// other HTTP clients send even loopback requests through http_proxy, so a proxy
// without a NO_PROXY entry for the VCM host would drop every hook silently.
export function buildVcmNoProxyEnvironment(
  apiUrl: string | undefined,
  modelEnvironment: NodeJS.ProcessEnv = {},
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const host = readUrlHostname(apiUrl);
  if (!host) {
    return {};
  }
  const current = modelEnvironment.NO_PROXY
    ?? modelEnvironment.no_proxy
    ?? baseEnv.NO_PROXY
    ?? baseEnv.no_proxy;
  const noProxy = mergeNoProxy(current, host);
  return { NO_PROXY: noProxy, no_proxy: noProxy };
}

function readUrlHostname(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const hostname = new URL(value).hostname;
    // URL keeps IPv6 brackets; NO_PROXY lists the bare address.
    return hostname.replace(/^\[(.*)\]$/, "$1") || undefined;
  } catch {
    return undefined;
  }
}
