import { CORE_VCM_ROLE_DEFINITIONS } from "../../shared/constants.js";
import type { LaunchTemplate } from "../../shared/types/app-settings.js";
import type { RoleName } from "../../shared/types/role.js";
import type { ClaudePermissionMode, SessionEffort, SessionModel } from "../../shared/types/session.js";

export interface OneClickRoleLaunch {
  role: RoleName;
  permissionMode: ClaudePermissionMode;
  model: SessionModel;
  effort: SessionEffort;
}

export function buildOneClickRoleLaunches(
  launchTemplate: LaunchTemplate,
  input: { gateReviewerEnabled: boolean }
): OneClickRoleLaunch[] {
  const launches: OneClickRoleLaunch[] = CORE_VCM_ROLE_DEFINITIONS.map((definition) => ({
    role: definition.name,
    permissionMode: launchTemplate.roles[definition.name].permissionMode,
    model: launchTemplate.roles[definition.name].model,
    effort: launchTemplate.roles[definition.name].effort
  }));

  if (input.gateReviewerEnabled) {
    const gateReviewerTemplate = launchTemplate.roles["gate-reviewer"];
    launches.push({
      role: "gate-reviewer",
      permissionMode: gateReviewerTemplate.permissionMode,
      model: gateReviewerTemplate.model,
      effort: gateReviewerTemplate.effort
    });
  }

  return launches;
}
