import { describe, expect, it } from "vitest";
import { renderCoderHarnessRules } from "../../../src/backend/templates/harness/coder-agent.js";
import { renderCoderWorkerHarnessRules } from "../../../src/backend/templates/harness/coder-worker-agent.js";
import { renderVcmFinalAcceptanceSkillRules } from "../../../src/backend/templates/harness/vcm-final-acceptance-skill.js";
import { renderVcmRouteMessageSkillRules } from "../../../src/backend/templates/harness/vcm-route-message-skill.js";

describe("machine-consumed harness contracts", () => {
  it("uses the route frontmatter format parsed by the backend", () => {
    const rules = renderVcmRouteMessageSkillRules();

    expect(rules).toContain(
      "artifact_refs: .ai/vcm/handoffs/architecture-plan.md, docs/plans/example.md"
    );
    expect(rules).toContain("artifact_refs: .ai/vcm/handoffs/example.md");
    expect(rules).not.toContain("artifact_refs:\n  -");
  });

  it("gives Coder the exact initial worker state shape", () => {
    const rules = renderCoderHarnessRules();

    expect(rules).toContain('"workerId": "<worker-id>"');
    expect(rules).toContain('"status": "running"');
    expect(rules).toContain('"reportPath": ".ai/vcm/coder-workers/reports/<worker-id>.md"');
    expect(rules).toContain('"handled": false');
    expect(rules).toContain("add the exact `commitHash`");
  });

  it("gives workers the exact running and completed state contract", () => {
    const rules = renderCoderWorkerHarnessRules();

    expect(rules).toContain('"workerId": "<worker-id>"');
    expect(rules).toContain('"status": "running"');
    expect(rules).toContain('"handled": false');
    expect(rules).toContain('add `"commitHash": "<exact-report-commit-hash>"`');
  });

  it("uses the exact final-acceptance decision options in the skill template", () => {
    expect(renderVcmFinalAcceptanceSkillRules()).toContain(
      "accepted|accepted-with-known-risks|needs-coder-follow-up|needs-architect-follow-up|needs-docs-sync|blocked-by-user-decision"
    );
  });
});
