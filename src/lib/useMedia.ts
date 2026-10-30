import { useEffect, useState } from "react";

/** True while the media query matches (for example "(max-width: 640px)"). */
export function useMedia(query: string) {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** Phone-sized screens: touch targets, full-screen dialogs and card lists apply here. */
export const PHONE = "(max-width: 640px)";
