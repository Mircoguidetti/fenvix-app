import { useEffect, useId, useRef, type ReactNode } from "react";

/** Native <dialog>: focus trap, Escape and backdrop come from the browser. Enter submits the form inside. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  busy,
  confirmDisabled,
  onConfirm,
  onCancel,
  hideCancel,
  danger,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** For a dialog that only informs: one button, which closes it. */
  hideCancel?: boolean;
  /** The action cannot be undone (erase, delete, revoke, restore): a red line on top and a red confirm button. */
  danger?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className={danger ? "dialog dialog-danger" : "dialog"} aria-labelledby={titleId} onCancel={(e) => (e.preventDefault(), onCancel())} onClose={() => open && onCancel()}>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && !confirmDisabled) onConfirm();
          }}
          noValidate
        >
          <h2 id={titleId}>{title}</h2>
          <div className="dialog-body">{children}</div>
          <div className="dialog-actions">
            {!hideCancel && (
              <button type="button" className="btn" onClick={onCancel} autoFocus>
                Cancel
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={busy || confirmDisabled} autoFocus={hideCancel}>
              {confirmLabel}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
