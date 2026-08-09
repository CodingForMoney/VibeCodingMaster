#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const dataDir = process.env.VCM_DATA_DIR?.trim()
  ? path.resolve(process.env.VCM_DATA_DIR)
  : path.join(homedir(), ".vcm");

try {
  const settings = JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8"));
  const apiKey = settings?.codexBridge?.apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    process.exitCode = 1;
  } else {
    process.stdout.write(`${apiKey.trim()}\n`);
  }
} catch {
  process.exitCode = 1;
}
