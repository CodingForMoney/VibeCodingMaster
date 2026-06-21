import { VCM_ROLE_DEFINITIONS } from "../../shared/constants.js";
import type { LaunchTemplate } from "../../shared/types/app-settings.js";
import type { RoleName } from "../../shared/types/role.js";
import type { ClaudePermissionMode, SessionEffort, SessionModel } from "../../shared/types/session.js";

export interface OneClickRoleLaunch {
  role: RoleName;
  permissionMode: ClaudePermissionMode;
  model: SessionModel;
  effort: SessionEffort;
}

const DEFAULT_GATE_REVIEWER_LAUNCH: OneClickRoleLaunch = {
  role: "gate-reviewer",
  permissionMode: "default",
  model: "default",
  effort: "default"
};

export function buildOneClickRoleLaunches(
  launchTemplate: LaunchTemplate,
  input: { gateReviewerEnabled: boolean }
): OneClickRoleLaunch[] {
  const launches: OneClickRoleLaunch[] = VCM_ROLE_DEFINITIONS.map((definition) => ({
    role: definition.name,
    permissionMode: launchTemplate.roles[definition.name].permissionMode,
    model: launchTemplate.roles[definition.name].model,
    effort: launchTemplate.roles[definition.name].effort
  }));

  if (input.gateReviewerEnabled) {
    launches.push(DEFAULT_GATE_REVIEWER_LAUNCH);
  }

  return launches;
}
