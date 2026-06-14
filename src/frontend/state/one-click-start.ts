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

const DEFAULT_CODEX_REVIEWER_LAUNCH: OneClickRoleLaunch = {
  role: "codex-reviewer",
  permissionMode: "default",
  model: "gpt-5.5",
  effort: "xhigh"
};

export function buildOneClickRoleLaunches(
  launchTemplate: LaunchTemplate,
  input: { codexReviewerEnabled: boolean }
): OneClickRoleLaunch[] {
  const launches: OneClickRoleLaunch[] = VCM_ROLE_DEFINITIONS.map((definition) => ({
    role: definition.name,
    permissionMode: launchTemplate.roles[definition.name].permissionMode,
    model: launchTemplate.roles[definition.name].model,
    effort: launchTemplate.roles[definition.name].effort
  }));

  if (input.codexReviewerEnabled) {
    launches.push(DEFAULT_CODEX_REVIEWER_LAUNCH);
  }

  return launches;
}
