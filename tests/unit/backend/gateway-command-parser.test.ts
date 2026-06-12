import { describe, expect, it } from "vitest";
import { parseGatewayCommand } from "../../../src/backend/gateway/gateway-command-parser.js";

describe("parseGatewayCommand", () => {
  it("parses task lifecycle commands", () => {
    expect(parseGatewayCommand("/create-task gateway-demo Ship gateway flow")).toEqual({
      kind: "create-task",
      taskSlug: "gateway-demo",
      title: "Ship gateway flow"
    });
    expect(parseGatewayCommand("/close-task")).toEqual({ kind: "close-task" });
    expect(parseGatewayCommand("/close-task confirm gateway-demo")).toEqual({
      kind: "close-task-confirm",
      taskSlug: "gateway-demo"
    });
  });

  it("parses project, task, pull, and translation commands", () => {
    expect(parseGatewayCommand("/start")).toEqual({ kind: "start" });
    expect(parseGatewayCommand("/retry")).toEqual({ kind: "retry" });
    expect(parseGatewayCommand("/use-project \"/repo with spaces\"")).toEqual({
      kind: "use-project",
      selector: "/repo with spaces"
    });
    expect(parseGatewayCommand("/pull-current")).toEqual({ kind: "pull-current" });
    expect(parseGatewayCommand("/use-task 2")).toEqual({ kind: "use-task", selector: "2" });
    expect(parseGatewayCommand("/translate off")).toEqual({ kind: "translate", enabled: false });
  });

  it("keeps non-command text as a PM prompt", () => {
    expect(parseGatewayCommand("继续处理这个任务")).toEqual({
      kind: "plain",
      text: "继续处理这个任务"
    });
  });
});
