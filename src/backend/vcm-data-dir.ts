import path from "node:path";
import { homedir } from "node:os";

export const VCM_DATA_DIR_ENV = "VCM_DATA_DIR";

export function resolveVcmDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[VCM_DATA_DIR_ENV]?.trim();
  return configured ? path.resolve(configured) : path.join(homedir(), ".vcm");
}
