import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * `text` replaces the visible word ("Copy") when the button stands alone, for example in the side bar; it is then the
 * button's whole name (an aria-label that differs from the visible words fails WCAG 2.5.3, "label in name").
 */
export function CopyButton({ value, label = "Copy", what, text }: { value: string; label?: string; what: string; text?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1800);
  }
  return (
    <>
      <button type="button" className={state === "copied" ? "btn copy-done" : "btn"} onClick={copy} aria-label={text ? undefined : `${label} ${what}`}>
        {state === "copied" ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
        {state === "copied" ? "Copied" : (text ?? label)}
      </button>
      <span className="sr-only" role="status">
        {state === "copied" ? `${what} copied` : state === "failed" ? "Copy failed. Select the text and copy it manually." : ""}
      </span>
    </>
  );
}
