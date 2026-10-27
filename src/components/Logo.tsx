import { useId } from "react";

/** Tall rounded rectangle drawn with one continuous line, fading from solid to grey. Uses currentColor. */
export function LogoMark({ size = 22 }: { size?: number }) {
  const gradient = `fenvix-mark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gradient} x1="1" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" />
          <stop offset="0.45" stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.3" />
        </linearGradient>
      </defs>
      <rect x="5.2" y="2.8" width="13.6" height="18.4" rx="4.2" fill="none" stroke={`url(#${gradient})`} strokeWidth="2.6" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo">
      <LogoMark />
      <span className="logo-word">FENVIX</span>
    </span>
  );
}
