import { useEffect, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * While `active`: moves focus into `ref`, keeps Tab inside it, closes on Escape, and puts focus back where it was
 * when it turns inactive. Used by the navigation drawer (the native <dialog> traps focus for the others).
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, onClose: () => void) {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const before = document.activeElement as HTMLElement | null;
    const items = () => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => !e.hasAttribute("hidden") && e.offsetParent !== null);
    items()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Tab") {
        const list = items();
        if (!list.length) return;
        const [first, last] = [list[0], list[list.length - 1]];
        if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
        else if (!root.contains(document.activeElement)) (e.preventDefault(), first.focus());
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ref]);
}
