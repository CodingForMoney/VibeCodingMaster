import { VCM_ROLE_DEFINITIONS } from "../../shared/constants.js";
import type { RoleStallWarning } from "../../shared/types/role-stall.js";

export interface RoleStallWarningModalProps {
  warning: RoleStallWarning;
  busy: boolean;
  onIgnore(): void;
  onRecover(): void;
}

export function RoleStallWarningModal({
  warning,
  busy,
  onIgnore,
  onRecover
}: RoleStallWarningModalProps) {
  const roleLabel = VCM_ROLE_DEFINITIONS.find((definition) => definition.name === warning.role)?.label
    ?? warning.role;

  return (
    <div className="modal-backdrop role-stall-warning-backdrop">
      <section className="role-stall-warning-modal" role="dialog" aria-modal="true" aria-label="Role stall warning">
        <header>
          <p className="role-stall-warning-kicker">Possible stalled response</p>
          <h2>{roleLabel} may be stalled</h2>
        </header>
        <p>
          VCM has not received the expected Claude Code progress hook since {formatTimestamp(warning.phaseStartedAt)}.
          The task flow has not been changed or interrupted.
        </p>
        <dl>
          <div><dt>Phase</dt><dd>{formatPhase(warning.phase)}</dd></div>
          {warning.toolName ? <div><dt>Tool</dt><dd>{warning.toolName}</dd></div> : null}
          <div><dt>Detected</dt><dd>{formatTimestamp(warning.detectedAt)}</dd></div>
        </dl>
        <footer>
          <button type="button" className="secondary" disabled={busy} onClick={onIgnore}>Ignore</button>
          <button type="button" disabled={busy} onClick={onRecover}>{busy ? "Recovering..." : "Recover"}</button>
        </footer>
      </section>
    </div>
  );
}

function formatPhase(phase: RoleStallWarning["phase"]): string {
  return phase.split("-").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleTimeString();
}
