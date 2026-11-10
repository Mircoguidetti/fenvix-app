import { useId } from "react";

/** Tall rounded band with a twist: thick on the right, thin on the left. Fades from solid to grey. Uses currentColor. */
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
      <path fillRule="evenodd" fill={`url(#${gradient})`} d="M9.4 1.5h5.2a5.5 5.5 0 0 1 5.5 5.5v10a5.5 5.5 0 0 1-5.5 5.5H9.4a5.5 5.5 0 0 1-5.5-5.5V7a5.5 5.5 0 0 1 5.5-5.5zM8.6 2.3h4.2a3.6 3.6 0 0 1 3.6 3.6v12.2a3.6 3.6 0 0 1-3.6 3.6H8.6a3.6 3.6 0 0 1-3.6-3.6V5.9a3.6 3.6 0 0 1 3.6-3.6z" />
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
