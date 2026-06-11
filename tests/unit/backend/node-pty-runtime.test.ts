import { describe, expect, it } from "vitest";
import { buildPtyEnvironment, tailTerminalReplay } from "../../../src/backend/runtime/node-pty-runtime.js";

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
});
