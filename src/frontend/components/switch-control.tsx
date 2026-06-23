export interface SwitchControlProps {
  checked: boolean;
  label: string;
  className?: string;
  disabled?: boolean;
  stateLabel?: string;
  title?: string;
  onChange(checked: boolean): void;
}

export function SwitchControl({
  checked,
  className,
  disabled,
  label,
  stateLabel,
  title,
  onChange
}: SwitchControlProps) {
  const classes = [
    "switch-control",
    checked ? "is-on" : "is-off",
    className
  ].filter(Boolean).join(" ");
  const status = stateLabel ?? (checked ? "on" : "off");

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${label}: ${status}`}
      className={classes}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-control-label">{label}</span>
      <span className="switch-control-state">{status}</span>
      <span className="switch-control-track" aria-hidden="true">
        <span className="switch-control-thumb" />
      </span>
    </button>
  );
}
