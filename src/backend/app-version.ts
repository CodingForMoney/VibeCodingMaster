import { readFileSync } from "node:fs";
import path from "node:path";

export function readVcmPackageVersion(appRoot: string): string {
  const packageJsonPath = path.join(appRoot, "package.json");
  try {
    const raw = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    return typeof raw.version === "string" && raw.version.trim() ? raw.version : "unknown";
  } catch {
    return process.env.npm_package_version || "unknown";
  }
}
