/**
 * The keyboard rules of the dashboard's select (components/Select.tsx), kept free of React so they can be tested on
 * their own. They follow the WAI-ARIA "select-only combobox" pattern.
 */
export interface ListOption {
  value: string;
  label: string;
  /** Shown, but cannot be picked. */
  disabled?: boolean;
  /** A short example shown at the right of the option (for example the form of a value). */
  hint?: string;
}

/** Where the highlight moves for a key, or null when the key does not move it. */
export function moveIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : Math.min(current + 1, count - 1);
    case "ArrowUp":
      return current < 0 ? count - 1 : Math.max(current - 1, 0);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "PageDown":
      return Math.min(Math.max(current, 0) + 10, count - 1);
    case "PageUp":
      return Math.max(current - 10, 0);
    default:
      return null;
  }
}

/**
 * Type to jump: the first option after `from` whose label starts with `typed` (case-insensitive), wrapping around.
 * Typing the same letter again cycles through the options that start with it. -1 when nothing matches.
 */
export function typeahead(options: readonly ListOption[], typed: string, from: number): number {
  const q = typed.toLowerCase();
  if (!q || options.length === 0) return -1;
  const same = [...q].every((c) => c === q[0]);
  const needle = same ? q[0] : q;
  // A new search starts at the current option (it may match more letters); a repeated letter moves past it.
  const start = same ? from + 1 : from;
  for (let i = 0; i < options.length; i++) {
    const at = (((start + i) % options.length) + options.length) % options.length;
    if (options[at].label.toLowerCase().startsWith(needle)) return at;
  }
  return -1;
}

/** The label shown in the closed select for a value. */
export const labelOf = (options: readonly ListOption[], value: string): string => options.find((o) => o.value === value)?.label ?? "";
