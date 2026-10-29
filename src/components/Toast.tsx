import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, X } from "lucide-react";

/**
 * "success" for something that was done, "error" for something that failed. Leave it out for a plain note.
 * The icon always comes with the colour, so the meaning does not depend on seeing green or red.
 */
export type ToastTone = "success" | "error";
type Toast = { id: number; message: string; tone?: ToastTone };
const ToastContext = createContext<(message: string, tone?: ToastTone) => void>(() => {});

/** Short confirmation after an action. Stays for a few seconds and can be dismissed. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (message: string, tone?: ToastTone) => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t.slice(-2), { id, message, tone }]);
      setTimeout(() => dismiss(id), 6000);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.tone ? ` toast-${t.tone}` : ""}`} data-tone={t.tone ?? "neutral"}>
            {t.tone === "success" && <CircleCheck size={18} className="toast-icon" aria-hidden="true" />}
            {t.tone === "error" && <CircleAlert size={18} className="toast-icon" aria-hidden="true" />}
            <span>{t.message}</span>
            <button type="button" className="icon-btn toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss message">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
