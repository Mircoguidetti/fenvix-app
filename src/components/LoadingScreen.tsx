import { useEffect, useState } from "react";
import { LogoMark } from "./Logo";

/** After this long from the page load, the screen adds that the service is waking up (a cold API or database). */
export const SLOW_MS = 8000;

/**
 * The loading screen, never a blank page: the logo and one quiet progress line, in both themes, still when the person
 * asks for reduced motion. index.html shows the same markup (and holds its CSS) before any script runs; this
 * component takes over while the session, the organization or the first project load. The 8 s count runs from the
 * page load, so it does not start again when this replaces the static copy. `inline` keeps it inside the console's
 * frame (the first screen, while the projects load) instead of over the whole window.
 */
export function LoadingScreen({ inline = false }: { inline?: boolean }) {
  const [slow, setSlow] = useState(() => performance.now() >= SLOW_MS);
  useEffect(() => {
    if (slow) return;
    const t = window.setTimeout(() => setSlow(true), Math.max(0, SLOW_MS - performance.now()));
    return () => window.clearTimeout(t);
  }, [slow]);
  return (
    <div className={inline ? "boot boot-inline" : "boot"} role="status" aria-live="polite" aria-label="Loading FENVIX" data-slow={slow ? "" : undefined}>
      <span className="boot-logo" aria-hidden="true">
        <LogoMark />
        FENVIX
      </span>
      <span className="boot-bar" aria-hidden="true" />
      <p className="boot-note">Waking up the service...</p>
    </div>
  );
}
