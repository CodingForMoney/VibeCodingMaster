import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const buildDirs = ["dist", "dist-frontend"];

await Promise.all(buildDirs.map((dir) => {
  return fs.rm(path.join(root, dir), {
    recursive: true,
    force: true
  });
}));
