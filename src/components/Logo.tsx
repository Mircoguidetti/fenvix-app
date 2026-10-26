/** Rounded square outline with a small filled square inside, then the lowercase wordmark. */
export function LogoMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="20" height="20" rx="6" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1.5" fill="currentColor" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo">
      <LogoMark />
      <span className="logo-word">olvix</span>
    </span>
  );
}
