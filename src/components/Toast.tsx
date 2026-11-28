import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, X } from "lucide-react";

/**
 * "success" for something that was done, "error" for something that failed. Leave it out for a plain note.
 * The icon always comes with the colour, so the meaning does not depend on seeing green or red.
 */
export type ToastTone = "success" | "error";
type Toast = { id: number; message: string; tone?: ToastTone };
const ToastContext = createContext<(message: string, tone?: ToastTone) => void>(() => {});

/**
 * Short confirmation after a create, update or delete the person asked for (or its failure); never for something
 * that needs no answer (signing in or out, switching organization, a download). Top right, stays for a few seconds
 * and can be dismissed. The same text is shown once: a second call with it while it is on screen is ignored.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // The messages on screen, kept outside the state so two calls in the same tick see each other.
  const shown = useRef(new Map<string, number>());
  const dismiss = useCallback((id: number) => {
    for (const [k, v] of shown.current) if (v === id) shown.current.delete(k);
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);
  const push = useCallback(
    (message: string, tone?: ToastTone) => {
      const key = `${tone ?? "neutral"}:${message}`;
      if (shown.current.has(key)) return;
      const id = Date.now() + Math.random();
      shown.current.set(key, id);
      setToasts((t) => {
        const kept = t.slice(-2);
        for (const x of t) if (!kept.includes(x)) for (const [k, v] of shown.current) if (v === x.id) shown.current.delete(k);
        return [...kept, { id, message, tone }];
      });
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
