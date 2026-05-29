import fs from "node:fs/promises";
import path from "node:path";

const prebuildsDir = path.resolve("node_modules", "node-pty", "prebuilds");

if (process.platform !== "darwin") {
  process.exit(0);
}

try {
  const entries = await fs.readdir(prebuildsDir, { withFileTypes: true });
  const darwinDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("darwin-"))
    .map((entry) => path.join(prebuildsDir, entry.name));

  for (const dir of darwinDirs) {
    const helperPath = path.join(dir, "spawn-helper");
    try {
      await fs.chmod(helperPath, 0o755);
      console.log(`Fixed node-pty spawn-helper permissions: ${helperPath}`);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}
