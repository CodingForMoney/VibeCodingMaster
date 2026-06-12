#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_DIR, "..");
const DIST_CLI = path.join(APP_ROOT, "dist/backend/cli/install-vcm-harness.js");
const SOURCE_CLI = path.join(APP_ROOT, "src/backend/cli/install-vcm-harness.ts");
const SOURCE_TEMPLATE_DIR = path.join(APP_ROOT, "src/backend/templates/harness");
const TSX_BIN = path.join(APP_ROOT, "node_modules/.bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

const argv = process.argv.slice(2);
let command = process.execPath;
let args = [DIST_CLI, ...argv];

const canRunSource = fs.existsSync(SOURCE_CLI) && fs.existsSync(TSX_BIN);
const hasDist = fs.existsSync(DIST_CLI);
const sourceIsNewer = canRunSource && hasDist && latestSourceMtime() > fs.statSync(DIST_CLI).mtimeMs;

if (canRunSource && (!hasDist || sourceIsNewer)) {
  command = TSX_BIN;
  args = [SOURCE_CLI, ...argv];
} else if (!hasDist) {
  console.error("VCM fixed harness install failed: compiled CLI not found. Run npm run build first.");
  process.exit(1);
}

const result = spawnSync(command, args, {
  stdio: "inherit",
  env: process.env
});

if (result.error) {
  console.error(`VCM fixed harness install failed: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);

function latestSourceMtime() {
  const sourceFiles = [SOURCE_CLI];
  if (fs.existsSync(SOURCE_TEMPLATE_DIR)) {
    for (const entry of fs.readdirSync(SOURCE_TEMPLATE_DIR)) {
      if (entry.endsWith(".ts")) {
        sourceFiles.push(path.join(SOURCE_TEMPLATE_DIR, entry));
      }
    }
  }
  return Math.max(...sourceFiles.map((file) => fs.statSync(file).mtimeMs));
}
