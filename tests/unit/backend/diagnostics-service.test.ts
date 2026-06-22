import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDiagnosticsService } from "../../../src/backend/services/diagnostics-service.js";

describe("createDiagnosticsService", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("reports backend version and runtime counts", async () => {
    const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vcm-diagnostics-"));
    tempDirs.push(appRoot);
    await fs.writeFile(path.join(appRoot, "package.json"), JSON.stringify({ version: "9.9.9" }));
    const service = createDiagnosticsService({
      appRoot,
      runtime: {
        listSessions() {
          return [
            {
              id: "running",
              taskSlug: "demo",
              role: "coder",
              status: "running",
              startedAt: "2026-06-17T00:00:00.000Z"
            },
            {
              id: "exited",
              taskSlug: "demo",
              role: "reviewer",
              status: "exited",
              startedAt: "2026-06-17T00:00:00.000Z"
            }
          ];
        }
      },
      gatewayService: {
        getDiagnostics() {
          return { polling: true };
        }
      },
      translationService: {
        getDiagnostics() {
          return { sessions: 2, transcriptWatchers: 1, listeners: 3 };
        }
      }
    });

    const diagnostics = await service.getRuntimeDiagnostics();

    expect(diagnostics.version).toBe("9.9.9");
    expect(diagnostics.pid).toBe(process.pid);
    expect(diagnostics.runtimeSessions).toEqual({ total: 2, running: 1 });
    expect(diagnostics.gateway.polling).toBe(true);
    expect(diagnostics.translation.transcriptWatchers).toBe(1);
  });
});
