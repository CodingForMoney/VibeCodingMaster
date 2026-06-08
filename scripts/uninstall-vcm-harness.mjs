#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const MANIFEST_PATH = ".ai/vcm-harness-manifest.json";
const HTML_BLOCK_PATTERN = /<!-- VCM:BEGIN(?:\s+version=\d+)? -->[\s\S]*?<!-- VCM:END -->/m;
const HASH_BLOCK_PATTERN = /# VCM:BEGIN(?:\s+version=\d+)?\n[\s\S]*?# VCM:END/m;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  if (!args.projectRoot) {
    fail("Missing project root.");
  }

  const projectRoot = path.resolve(args.projectRoot);
  const manifestPath = args.manifest
    ? resolveInside(projectRoot, args.manifest)
    : path.join(projectRoot, MANIFEST_PATH);
  const manifest = await readManifest(manifestPath);
  const dryRun = args.dryRun;
  const operations = [];
  const warnings = [];
  const plannedDeletes = new Set();

  validateManifest(manifest, manifestPath);

  for (const entry of manifest.entries) {
    await processEntry({ projectRoot, entry, dryRun, operations, warnings, plannedDeletes });
  }

  for (const runtimeRoot of manifest.runtimeRoots ?? []) {
    await deleteRuntimeRoot({ projectRoot, runtimeRoot, dryRun, operations, warnings, plannedDeletes });
  }

  await removeManifestDirectories({ projectRoot, manifest, dryRun, operations, warnings, plannedDeletes });

  printReport({ projectRoot, manifestPath, dryRun, operations, warnings });
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    help: false,
    manifest: undefined,
    projectRoot: undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--manifest") {
      const value = argv[index + 1];
      if (!value) {
        fail("--manifest requires a relative path inside the project root.");
      }
      args.manifest = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      fail(`Unknown option: ${arg}`);
    }
    if (args.projectRoot) {
      fail(`Unexpected argument: ${arg}`);
    }
    args.projectRoot = arg;
  }

  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/uninstall-vcm-harness.mjs <project-root>
  node scripts/uninstall-vcm-harness.mjs <project-root> --manifest <relative-path>
  node scripts/uninstall-vcm-harness.mjs <project-root> --dry-run

Deletes VCM-owned harness changes by default. Pass --dry-run to preview.
The script reads .ai/vcm-harness-manifest.json from the target project and removes
only VCM-owned managed blocks, VCM-owned whole files, generated artifacts,
VCM Claude settings hooks, runtime roots, and empty VCM-created directories.`);
}

async function readManifest(manifestPath) {
  const content = await fs.readFile(manifestPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      fail(`Manifest not found: ${manifestPath}`);
    }
    throw error;
  });
  try {
    return JSON.parse(content);
  } catch (error) {
    fail(`Manifest is not valid JSON: ${manifestPath}\n${error.message}`);
  }
}

function validateManifest(manifest, manifestPath) {
  if (!isPlainObject(manifest)) {
    fail(`Manifest must be a JSON object: ${manifestPath}`);
  }
  if (manifest.manager !== "vcm") {
    fail(`Manifest manager must be "vcm": ${manifestPath}`);
  }
  if (!Array.isArray(manifest.entries)) {
    fail(`Manifest entries must be an array: ${manifestPath}`);
  }
  if (manifest.runtimeRoots !== undefined && !Array.isArray(manifest.runtimeRoots)) {
    fail(`Manifest runtimeRoots must be an array when present: ${manifestPath}`);
  }
}

async function processEntry(context) {
  const { entry } = context;
  if (!isPlainObject(entry) || typeof entry.path !== "string") {
    context.warnings.push("Skipped malformed manifest entry.");
    return;
  }

  const uninstallAction = entry.uninstall?.action;

  if (entry.entryType === "directory") {
    return;
  }

  if (entry.ownership === "managed-block" || uninstallAction === "remove-managed-block") {
    await removeManagedBlock(context);
    return;
  }

  if (entry.ownership === "json-merge" || uninstallAction === "remove-owned-json-keys") {
    await removeOwnedJson(context);
    return;
  }

  if (
    entry.ownership === "whole-file" ||
    entry.ownership === "derived-artifact" ||
    uninstallAction === "delete-file-if-unchanged" ||
    uninstallAction === "delete-derived-artifact"
  ) {
    await deleteFile(context);
    return;
  }

  context.warnings.push(`No uninstall handler for ${entry.path}.`);
}

async function removeManagedBlock({ projectRoot, entry, dryRun, operations, warnings, plannedDeletes }) {
  const absolutePath = resolveInside(projectRoot, entry.path);
  const content = await readOptionalText(absolutePath);
  if (content === undefined) {
    operations.push(skip(entry.path, "missing"));
    return;
  }

  const pattern = entry.marker?.type === "hash-comment" ? HASH_BLOCK_PATTERN : HTML_BLOCK_PATTERN;
  if (!pattern.test(content)) {
    warnings.push(`Managed block not found: ${entry.path}`);
    return;
  }

  const nextContent = normalizeAfterBlockRemoval(content.replace(pattern, ""));
  if (shouldDeleteManagedBlockStub(entry, nextContent)) {
    await removeFileAndEmptyParents({ projectRoot, absolutePath, relativePath: entry.path, dryRun, operations, plannedDeletes });
    return;
  }

  if (dryRun) {
    operations.push(plan(entry.path, "remove managed block"));
    return;
  }

  await fs.writeFile(absolutePath, nextContent, "utf8");
  operations.push(done(entry.path, "removed managed block"));
}

function normalizeAfterBlockRemoval(content) {
  const trimmed = content.trim();
  return trimmed ? `${trimmed}\n` : "";
}

function shouldDeleteManagedBlockStub(entry, content) {
  const trimmed = content.trim();
  if (!trimmed) {
    return true;
  }

  if (entry.category === "core-agent") {
    return /^---\n[\s\S]*?\n---\n\n# .+ Agent$/.test(trimmed);
  }

  if (entry.category === "pull-request-template") {
    return trimmed === "# Pull Request Template";
  }

  return false;
}

async function removeOwnedJson({ projectRoot, entry, dryRun, operations, warnings, plannedDeletes }) {
  const absolutePath = resolveInside(projectRoot, entry.path);
  const content = await readOptionalText(absolutePath);
  if (content === undefined) {
    operations.push(skip(entry.path, "missing"));
    return;
  }

  let value;
  try {
    value = JSON.parse(content);
  } catch (error) {
    warnings.push(`Skipped invalid JSON ${entry.path}: ${error.message}`);
    return;
  }

  if (!isPlainObject(value)) {
    warnings.push(`Skipped non-object JSON file: ${entry.path}`);
    return;
  }

  const nextValue = removeVcmHookMatchers(value, entry.jsonOwnership?.hookMatchers ?? ["VCM"]);
  if (deepEqual(value, nextValue)) {
    operations.push(skip(entry.path, "no VCM-owned JSON values found"));
    return;
  }

  if (dryRun) {
    operations.push(plan(entry.path, "remove VCM-owned JSON values"));
    return;
  }

  await fs.writeFile(absolutePath, `${JSON.stringify(nextValue, null, 2)}\n`, "utf8");
  operations.push(done(entry.path, "removed VCM-owned JSON values"));
}

function removeVcmHookMatchers(settings, hookMatchers) {
  const nextSettings = structuredClone(settings);
  if (!isPlainObject(nextSettings.hooks)) {
    return nextSettings;
  }

  const hooks = { ...nextSettings.hooks };
  for (const [eventName, eventMatchers] of Object.entries(hooks)) {
    if (!Array.isArray(eventMatchers)) {
      continue;
    }
    const remaining = eventMatchers.filter((matcher) => !isOwnedHookMatcher(matcher, hookMatchers));
    if (remaining.length > 0) {
      hooks[eventName] = remaining;
    } else {
      delete hooks[eventName];
    }
  }

  if (Object.keys(hooks).length > 0) {
    nextSettings.hooks = hooks;
  } else {
    delete nextSettings.hooks;
  }

  return nextSettings;
}

function isOwnedHookMatcher(matcher, hookMatchers) {
  if (!isPlainObject(matcher) || !Array.isArray(matcher.hooks)) {
    return false;
  }
  return matcher.hooks.some((hook) => {
    if (!isPlainObject(hook)) {
      return false;
    }
    const command = typeof hook.command === "string" ? hook.command : "";
    return hookMatchers.some((marker) => command.includes(marker)) ||
      command.includes("/api/hooks/claude-code") ||
      command.includes("hook-event");
  });
}

async function deleteFile({ projectRoot, entry, dryRun, operations, plannedDeletes }) {
  const absolutePath = resolveInside(projectRoot, entry.path);
  await removeFileAndEmptyParents({ projectRoot, absolutePath, relativePath: entry.path, dryRun, operations, plannedDeletes });
}

async function deleteRuntimeRoot({ projectRoot, runtimeRoot, dryRun, operations, warnings, plannedDeletes }) {
  if (typeof runtimeRoot !== "string") {
    warnings.push("Skipped malformed runtime root.");
    return;
  }
  const absolutePath = resolveInside(projectRoot, runtimeRoot);
  const exists = await pathExists(absolutePath);
  if (!exists) {
    operations.push(skip(runtimeRoot, "missing"));
    return;
  }

  if (dryRun) {
    operations.push(plan(runtimeRoot, "delete runtime root"));
    plannedDeletes.add(toRelative(projectRoot, absolutePath));
    return;
  }

  await fs.rm(absolutePath, { recursive: true, force: true });
  operations.push(done(runtimeRoot, "deleted runtime root"));
}

async function removeManifestDirectories({ projectRoot, manifest, dryRun, operations, warnings, plannedDeletes }) {
  const directories = manifest.entries
    .filter((entry) => entry.entryType === "directory" && entry.ownership === "vcm-created")
    .map((entry) => entry.path)
    .sort((left, right) => right.length - left.length);

  for (const directory of directories) {
    const absolutePath = resolveInside(projectRoot, directory);
    const stat = await fs.stat(absolutePath).catch((error) => {
      if (error.code === "ENOENT") {
        operations.push(skip(directory, "missing"));
        return null;
      }
      throw error;
    });
    if (!stat) {
      continue;
    }
    if (!stat.isDirectory()) {
      warnings.push(`Manifest directory is not a directory: ${directory}`);
      continue;
    }
    const children = await fs.readdir(absolutePath);
    if (dryRun && children.every((child) => child === ".gitkeep" || plannedDeletes.has(toRelative(projectRoot, path.join(absolutePath, child))))) {
      if (children.includes(".gitkeep")) {
        operations.push(plan(path.posix.join(directory.replace(/\/$/, ""), ".gitkeep"), "delete VCM directory placeholder"));
      }
      operations.push(plan(directory, "delete empty VCM-created directory"));
      continue;
    }
    if (children.length === 1 && children[0] === ".gitkeep") {
      const keepPath = path.join(absolutePath, ".gitkeep");
      if (dryRun) {
        operations.push(plan(path.posix.join(directory.replace(/\/$/, ""), ".gitkeep"), "delete VCM directory placeholder"));
        operations.push(plan(directory, "delete empty VCM-created directory"));
        continue;
      }
      await fs.rm(keepPath, { force: true });
      operations.push(done(path.posix.join(directory.replace(/\/$/, ""), ".gitkeep"), "deleted VCM directory placeholder"));
      await fs.rmdir(absolutePath);
      operations.push(done(directory, "deleted empty VCM-created directory"));
      continue;
    }
    if (children.length > 0) {
      operations.push(skip(directory, "not empty"));
      continue;
    }
    if (dryRun) {
      operations.push(plan(directory, "delete empty VCM-created directory"));
      continue;
    }
    await fs.rmdir(absolutePath);
    operations.push(done(directory, "deleted empty VCM-created directory"));
  }
}

async function removeFileAndEmptyParents({ projectRoot, absolutePath, relativePath, dryRun, operations, plannedDeletes }) {
  const stat = await fs.stat(absolutePath).catch((error) => {
    if (error.code === "ENOENT") {
      operations.push(skip(relativePath, "missing"));
      return null;
    }
    throw error;
  });
  if (!stat) {
    return;
  }
  if (!stat.isFile()) {
    operations.push(skip(relativePath, "not a file"));
    return;
  }

  if (dryRun) {
    operations.push(plan(relativePath, "delete file"));
    plannedDeletes?.add(toRelative(projectRoot, absolutePath));
    return;
  }

  await fs.rm(absolutePath, { force: true });
  operations.push(done(relativePath, "deleted file"));
}

function resolveInside(root, relativePath) {
  if (path.isAbsolute(relativePath)) {
    fail(`Manifest path must be relative: ${relativePath}`);
  }
  const normalized = path.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    fail(`Manifest path escapes the project root: ${relativePath}`);
  }
  const resolved = path.resolve(root, normalized);
  if (!isInside(root, resolved) && resolved !== root) {
    fail(`Manifest path escapes the project root: ${relativePath}`);
  }
  return resolved;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function toRelative(root, candidate) {
  return path.relative(root, candidate).split(path.sep).join("/");
}

async function readOptionalText(absolutePath) {
  return fs.readFile(absolutePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
}

async function pathExists(absolutePath) {
  return fs.stat(absolutePath).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  );
}

function plan(pathName, action) {
  return { status: "plan", path: pathName, action };
}

function done(pathName, action) {
  return { status: "done", path: pathName, action };
}

function skip(pathName, reason) {
  return { status: "skip", path: pathName, action: reason };
}

function printReport({ projectRoot, manifestPath, dryRun, operations, warnings }) {
  console.log(`${dryRun ? "Dry-run" : "Applied"} VCM harness uninstall`);
  console.log(`Project: ${projectRoot}`);
  console.log(`Manifest: ${manifestPath}`);

  for (const operation of operations) {
    console.log(`${operation.status.toUpperCase()} ${operation.path} - ${operation.action}`);
  }

  for (const warning of warnings) {
    console.warn(`WARN ${warning}`);
  }

  if (dryRun) {
    console.log("No files changed. Re-run without --dry-run to apply.");
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fail(message) {
  console.error(`VCM harness uninstall failed: ${message}`);
  process.exit(1);
}

await main();
