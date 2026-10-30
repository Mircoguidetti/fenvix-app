import type { ReactNode } from "react";

/**
 * On/off setting: a real button with role="switch". The label (and the help under it) is read with it. The target
 * is the whole row on a phone, so the switch itself is never the only thing to hit.
 */
export function Switch({ id, checked, onChange, label, help, disabled }: { id: string; checked: boolean; onChange: (on: boolean) => void; label: ReactNode; help?: ReactNode; disabled?: boolean }) {
  return (
    <div className="switch-row">
      <span className="switch-text">
        <span id={`${id}-label`} className="switch-label">
          {label}
        </span>
        {help && (
          <span id={`${id}-help`} className="help">
            {help}
          </span>
        )}
      </span>
      <button type="button" id={id} role="switch" aria-checked={checked} aria-labelledby={`${id}-label`} aria-describedby={help ? `${id}-help` : undefined} disabled={disabled} className="switch" onClick={() => onChange(!checked)} />
    </div>
  );
}
