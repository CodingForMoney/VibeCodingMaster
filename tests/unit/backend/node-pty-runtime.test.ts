import { describe, expect, it } from "vitest";
import {
  buildPtyEnvironment,
  createTerminalLogWriter,
  tailTerminalReplay
} from "../../../src/backend/runtime/node-pty-runtime.js";

describe("node-pty-runtime", () => {
  it("announces truecolor terminal support and removes NO_COLOR", () => {
    const env = buildPtyEnvironment(
      {
        NO_COLOR: "1",
        TERM: "dumb"
      },
      {
        VCM_ROLE: "coder"
      }
    );

    expect(env).toMatchObject({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: "3",
      CLICOLOR: "1",
      TERM_PROGRAM: "VibeCodingMaster",
      VCM_ROLE: "coder"
    });
    expect(env.NO_COLOR).toBeUndefined();
  });

  it("lets explicit input terminal color settings win except NO_COLOR", () => {
    const env = buildPtyEnvironment(
      {
        COLORTERM: "truecolor",
        FORCE_COLOR: "3"
      },
      {
        TERM: "xterm-256color",
        COLORTERM: "24bit",
        FORCE_COLOR: "2",
        NO_COLOR: "1"
      }
    );

    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("24bit");
    expect(env.FORCE_COLOR).toBe("2");
    expect(env.NO_COLOR).toBeUndefined();
  });

  it("limits replayed terminal logs to a tail window", () => {
    const replay = tailTerminalReplay([
      "old line 1",
      "old line 2",
      "recent line 1",
      "recent line 2"
    ].join("\n"), 28);

    expect(replay).toBe([
      "recent line 1",
      "recent line 2"
    ].join("\n"));
  });

  it("serializes terminal log appends for one log path", async () => {
    const writes: string[] = [];
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const writer = createTerminalLogWriter(
      {
        async appendText(_path, content) {
          activeWrites += 1;
          maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
          await delay(5);
          writes.push(content);
          activeWrites -= 1;
        }
      },
      "/repo/.tmp/terminal/project-manager.log",
      () => undefined
    );

    writer.append("one");
    writer.append("two");
    writer.append("three");

    await writer.close();

    expect(writes).toEqual(["one", "two", "three"]);
    expect(maxActiveWrites).toBe(1);
  });

  it("keeps terminal log appends alive after a write failure", async () => {
    const writes: string[] = [];
    const errors: unknown[] = [];
    const writer = createTerminalLogWriter(
      {
        async appendText(_path, content) {
          if (content === "bad") {
            throw new Error("disk is grumpy");
          }
          writes.push(content);
        }
      },
      "/repo/.tmp/terminal/project-manager.log",
      (error) => errors.push(error)
    );

    writer.append("first");
    writer.append("bad");
    writer.append("after");

    await writer.close();

    expect(writes).toEqual(["first", "after"]);
    expect(errors).toHaveLength(1);
  });

  it("ignores terminal log appends after close", async () => {
    const writes: string[] = [];
    const writer = createTerminalLogWriter(
      {
        async appendText(_path, content) {
          writes.push(content);
        }
      },
      "/repo/.tmp/terminal/project-manager.log",
      () => undefined
    );

    writer.append("before");
    await writer.close();
    writer.append("after");
    await delay(1);

    expect(writes).toEqual(["before"]);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
