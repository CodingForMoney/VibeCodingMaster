import fs from "node:fs/promises";
import path from "node:path";

const appRoot = process.cwd();
const requiredFiles = [
  "README.md",
  "package.json",
  "scripts/fix-node-pty-spawn-helper.mjs",
  "dist/main.js",
  "dist/cli/vcmctl.js",
  "dist/backend/server.js",
  "dist/backend/api/harness-routes.js",
  "dist/backend/runtime/node-pty-runtime.js",
  "dist/backend/ws/terminal-ws.js",
  "dist/backend/services/harness-service.js",
  "dist/backend/services/session-service.js",
  "dist/backend/services/project-service.js",
  "dist/backend/services/message-service.js",
  "dist/backend/templates/harness/claude-root.js",
  "dist/backend/templates/harness/project-manager-agent.js",
  "dist/backend/templates/harness/architect-agent.js",
  "dist/backend/templates/harness/coder-agent.js",
  "dist/backend/templates/harness/reviewer-agent.js",
  "dist/shared/constants.js",
  "dist/shared/types/harness.js",
  "dist/shared/validation/slug-check.js",
  "dist/shared/validation/artifact-check.js",
  "dist-frontend/index.html"
];

const requiredFileEntries = [
  "dist",
  "dist-frontend",
  "docs",
  "scripts",
  "README.md"
];

async function main() {
  const pkg = JSON.parse(await readText("package.json"));
  assertArrayIncludes(pkg.files, requiredFileEntries, "package.json files");
  assertEqual(pkg.bin?.vcm, "dist/main.js", "package.json bin.vcm");
  assertEqual(pkg.bin?.vcmctl, "dist/cli/vcmctl.js", "package.json bin.vcmctl");

  for (const file of requiredFiles) {
    await assertFile(file);
  }

  await assertStartsWith("dist/main.js", "#!/usr/bin/env node", "vcm bin shebang");
  await assertStartsWith("dist/cli/vcmctl.js", "#!/usr/bin/env node", "vcmctl bin shebang");

  const server = await readText("dist/backend/server.js");
  assertIncludes(server, 'path.join(getAppRoot(), "dist-frontend")', "packaged static dir must resolve from app root");
  assertNotIncludes(server, 'path.resolve("dist-frontend")', "packaged static dir must not resolve from caller cwd");

  const indexHtml = await readText("dist-frontend/index.html");
  const assetPaths = [...indexHtml.matchAll(/(?:src|href)="\/([^"]+)"/g)].map((match) => match[1]);
  if (assetPaths.length === 0) {
    fail("dist-frontend/index.html does not reference any built assets");
  }
  for (const assetPath of assetPaths) {
    await assertFile(path.join("dist-frontend", assetPath));
  }

  console.log(`Package verification passed: ${requiredFiles.length + assetPaths.length} required files checked.`);
}

async function readText(relativePath) {
  return fs.readFile(path.join(appRoot, relativePath), "utf8");
}

async function assertFile(relativePath) {
  const absolutePath = path.join(appRoot, relativePath);
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat?.isFile()) {
    fail(`Missing required package file: ${relativePath}`);
  }
}

async function assertStartsWith(relativePath, expected, label) {
  const content = await readText(relativePath);
  if (!content.startsWith(expected)) {
    fail(`${label} failed for ${relativePath}`);
  }
}

function assertArrayIncludes(actual, expectedEntries, label) {
  if (!Array.isArray(actual)) {
    fail(`${label} must be an array`);
  }
  for (const entry of expectedEntries) {
    if (!actual.includes(entry)) {
      fail(`${label} missing ${entry}`);
    }
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} expected ${expected}, got ${actual}`);
  }
}

function assertIncludes(content, expected, label) {
  if (!content.includes(expected)) {
    fail(`${label}: missing ${expected}`);
  }
}

function assertNotIncludes(content, unexpected, label) {
  if (content.includes(unexpected)) {
    fail(`${label}: found ${unexpected}`);
  }
}

function fail(message) {
  console.error(`Package verification failed: ${message}`);
  process.exit(1);
}

await main();
