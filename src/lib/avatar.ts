/** Initial and colour of a workspace avatar. Pure functions: no React, so the unit tests can run them. */

/**
 * Backgrounds for an avatar with white text. Each one gives white text a contrast of at least 4.5:1
 * (WCAG AA); tests/unit/avatar.test.ts checks it.
 */
export const AVATAR_COLORS = ["#3b5bdb", "#0b7285", "#237032", "#c2255c", "#6741d9", "#c92a2a", "#1864ab", "#862e9c"] as const;

/** The first visible character of the name, upper-cased: a whole emoji or accented letter, never half of one. "W" for an empty name. */
export function workspaceInitial(name: string): string {
  const text = name.trim();
  if (!text) return "W";
  const first = firstGrapheme(text);
  return first.toLocaleUpperCase();
}

function firstGrapheme(text: string): string {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const { segment } of seg.segment(text)) return segment;
  }
  return Array.from(text)[0] ?? "";
}

/** Same name, same colour: a small FNV-1a hash of the trimmed name picks one of AVATAR_COLORS. */
export function workspaceColor(name: string): string {
  let h = 0x811c9dc5;
  for (const ch of name.trim()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** Contrast ratio between two #rrggbb colours (WCAG 2.x). */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
