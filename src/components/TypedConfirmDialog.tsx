import { useEffect, useId, useState, type ReactNode } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * A ConfirmDialog for an action that deletes data: the confirm button stays disabled until the person types `expected`
 * exactly (case and spaces included). The typed text is cleared every time the dialog opens.
 */
export function TypedConfirmDialog({
  open,
  title,
  children,
  expected,
  what,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  /** The text that must be typed: a repository's full name, the organization's name. */
  expected: string;
  /** What `expected` is, for the label: "the repository name". */
  what: string;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);
  const matches = typed === expected;

  return (
    <ConfirmDialog open={open} title={title} confirmLabel={confirmLabel} busy={busy} confirmDisabled={!matches} onConfirm={onConfirm} onCancel={onCancel} danger wide>
      {children}
      <div className="field">
        <label htmlFor={inputId}>
          Type {what} <strong className="mono break-anywhere">{expected}</strong> to confirm
        </label>
        <input
          id={inputId}
          className="mono"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          data-testid="typed-confirm"
        />
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}
